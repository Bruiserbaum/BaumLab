"""
Recovery kits: everything needed to rebuild one Docker service from nothing, collected through
Portainer from any host it manages — no agent on the host.

Kit archive layout (kit_<name>_<ts>.tar.gz → kit_<name>_<ts>/):
    RESTORE.md               step-by-step rebuild instructions for this service
    manifest.json            what's in the kit and where it came from
    stack/docker-compose.yml Portainer's stack file, or one reconstructed from the containers
    secrets.enc              environment + settings, encrypted with the recovery passphrase
    decrypt-secrets.py       opens secrets.enc without BaumLab
    data/*.tar               every volume and bind mount (Docker archive format)
    databases/*              live dumps of detected Postgres / MySQL / MariaDB / Mongo containers

Restore recreates the volumes and bind paths on a chosen Portainer environment, copies the data
in, deploys the stack with its environment, and can import the database dumps.
"""
import json
import os
import re
import shutil
import tarfile
import time
from datetime import datetime
from typing import Optional

import yaml
from sqlmodel import Session, select

from ..database import engine
from ..models.backup import BackupDestination, RecoveryKit
from . import backup_docker as dk
from . import backup_storage as st
from . import recovery_crypto as rc
from .backup_engine import _Run, _alert_result, _claim, _extract, _record_result, _release, _stamp
from .portainer_docker import HELPER_IMAGE, PortainerDocker

# Mounts that are host plumbing, not service data
_SKIP_PREFIXES = ("/var/run", "/run", "/dev", "/proc", "/sys")
_SKIP_EXACT = {"/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/resolv.conf", "/etc/hostname"}
_DROP_LABELS = ("com.docker.compose.", "org.opencontainers.", "desktop.docker.io")


def kit_dir(kit: RecoveryKit) -> str:
    return f"kits/{dk.safe_name(kit.name)}"


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_") or "root"


def mount_key(container: str, destination: str) -> str:
    return f"{container}:{destination}"


def skip_mount(m: dict) -> bool:
    dest = m.get("Destination", "")
    return (m.get("Type") not in ("volume", "bind") or dest in _SKIP_EXACT
            or any(dest == p or dest.startswith(p + "/") for p in _SKIP_PREFIXES)
            or m.get("Source", "").endswith("docker.sock"))


# ── Databases ──────────────────────────────────────────────────────────────────

def db_kind(image: str) -> Optional[str]:
    repo = image.split("@")[0]
    if ":" in repo.rsplit("/", 1)[-1]:
        repo = repo.rsplit(":", 1)[0]
    name = repo.rsplit("/", 1)[-1].lower()
    if any(k in name for k in ("postgres", "postgis", "timescale", "pgvecto", "pgvector")):
        return "postgres"
    if any(k in name for k in ("mariadb", "mysql", "percona")):
        return "mysql"
    if name.startswith("mongo"):
        return "mongo"
    return None


# Run inside the database container with its own environment, so BaumLab never handles the passwords
_DUMP = {
    "postgres": ("sql", 'exec pg_dumpall -U "${POSTGRES_USER:-postgres}" --clean --if-exists'),
    "mysql": ("sql", 'P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; U=root; '
                     'if [ -z "$P" ]; then U="${MYSQL_USER:-$MARIADB_USER}"; P="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; fi; '
                     'D=$(command -v mariadb-dump || command -v mysqldump); '
                     'if [ "$U" = root ]; then exec "$D" -uroot -p"$P" --all-databases --single-transaction --routines --events; '
                     'else exec "$D" -u"$U" -p"$P" --single-transaction --routines '
                     '--databases "${MYSQL_DATABASE:-$MARIADB_DATABASE}"; fi'),
    "mongo": ("archive", 'exec mongodump --archive ${MONGO_INITDB_ROOT_USERNAME:+--username "$MONGO_INITDB_ROOT_USERNAME" '
                         '--password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}'),
}
_IMPORT = {
    "postgres": 'psql -v ON_ERROR_STOP=0 -U "${POSTGRES_USER:-postgres}" -d postgres -f "$F"',
    "mysql": 'P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; U=root; '
             'if [ -z "$P" ]; then U="${MYSQL_USER:-$MARIADB_USER}"; P="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; fi; '
             'C=$(command -v mariadb || command -v mysql); "$C" -u"$U" -p"$P" < "$F"',
    "mongo": 'mongorestore --drop --archive="$F" ${MONGO_INITDB_ROOT_USERNAME:+--username "$MONGO_INITDB_ROOT_USERNAME" '
             '--password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}',
}
_READY = {
    "postgres": 'pg_isready -U "${POSTGRES_USER:-postgres}"',
    "mysql": 'C=$(command -v mariadb-admin || command -v mysqladmin); "$C" ping --silent',
    "mongo": 'mongosh --quiet --eval "db.runCommand({ping:1})" || mongo --quiet --eval "db.runCommand({ping:1})"',
}


# ── Discovery (for the kit form) ───────────────────────────────────────────────

def describe(connection: str, endpoint_id: int) -> list[dict]:
    """Compose projects and standalone containers on an environment, with their mounts and databases."""
    with PortainerDocker(connection, endpoint_id) as d:
        try:
            portainer_stacks = {s.get("Name"): s for s in d.stacks()}
        except Exception:
            portainer_stacks = {}            # API key without stack access — still list containers
        groups: dict[str, dict] = {}
        for c in d.containers():
            name = (c.get("Names") or ["/?"])[0].lstrip("/")
            labels = c.get("Labels") or {}
            project = labels.get("com.docker.compose.project")
            key = project or f"container:{name}"
            g = groups.setdefault(key, {"project": project, "name": project or name, "containers": [], "mounts": [],
                                        "databases": [], "portainer_stack": project in portainer_stacks})
            g["containers"].append(name)
            for m in c.get("Mounts") or []:
                if not skip_mount(m):
                    g["mounts"].append({"key": mount_key(name, m["Destination"]), "container": name,
                                        "type": m["Type"], "source": m.get("Name") or m.get("Source"),
                                        "destination": m["Destination"]})
            kind = db_kind(c.get("Image", ""))
            if kind:
                g["databases"].append({"container": name, "type": kind})
    return sorted(groups.values(), key=lambda g: (g["project"] is None, g["name"].lower()))


# ── Compose reconstruction (containers not deployed as a Portainer stack) ──────

def _image_defaults(d: PortainerDocker, image: str) -> dict:
    cfg = (d.image(image) or {}).get("Config") or {}
    return {"env": set(cfg.get("Env") or []), "cmd": cfg.get("Cmd"), "entrypoint": cfg.get("Entrypoint"),
            "user": cfg.get("User") or ""}


def reconstruct(d: PortainerDocker, inspects: list[dict], stack_env: dict) -> str:
    """docker-compose.yml rebuilt from container settings. Env values go to stack_env as ${VARS}."""
    services, volumes, networks = {}, {}, {}
    for ins in inspects:
        cfg, host = ins.get("Config") or {}, ins.get("HostConfig") or {}
        cname = ins["Name"].lstrip("/")
        svc_name = (cfg.get("Labels") or {}).get("com.docker.compose.service") or cname
        defaults = _image_defaults(d, cfg.get("Image", ""))
        svc = {"image": cfg.get("Image"), "container_name": cname}
        if (host.get("RestartPolicy") or {}).get("Name") not in (None, "", "no"):
            svc["restart"] = host["RestartPolicy"]["Name"]

        env = {}
        for entry in cfg.get("Env") or []:
            if entry in defaults["env"]:
                continue
            k, _, v = entry.partition("=")
            var = k if stack_env.get(k, v) == v else f"{_safe(svc_name).upper()}_{k}"
            stack_env[var] = v
            env[k] = "${" + var + "}"
        if env:
            svc["environment"] = env

        ports = []
        for cport, binds in (host.get("PortBindings") or {}).items():
            for b in binds or []:
                ip = b.get("HostIp") or ""
                ports.append(f"{ip + ':' if ip and ip not in ('0.0.0.0', '::') else ''}{b.get('HostPort')}:{cport}")
        if ports:
            svc["ports"] = sorted(set(ports))

        mounts = []
        for m in ins.get("Mounts") or []:
            ro = "" if m.get("RW", True) else ":ro"
            if m["Type"] == "volume":
                key = _safe(m["Name"])
                volumes[key] = {"external": True, "name": m["Name"]}
                mounts.append(f"{key}:{m['Destination']}{ro}")
            elif m["Type"] == "bind":
                mounts.append(f"{m['Source']}:{m['Destination']}{ro}")
        if mounts:
            svc["volumes"] = mounts

        mode = host.get("NetworkMode") or ""
        if mode in ("host", "none") or mode.startswith("container:"):
            svc["network_mode"] = mode
        else:
            nets = [n for n in ((ins.get("NetworkSettings") or {}).get("Networks") or {}) if n != "bridge"]
            if nets:
                svc["networks"] = nets
                for n in nets:
                    networks[n] = {"name": n}
        for key, compose_key in (("CapAdd", "cap_add"), ("ExtraHosts", "extra_hosts"), ("SecurityOpt", "security_opt")):
            if host.get(key):
                svc[compose_key] = host[key]
        if host.get("Privileged"):
            svc["privileged"] = True
        if host.get("Devices"):
            svc["devices"] = [f"{x['PathOnHost']}:{x['PathInContainer']}" for x in host["Devices"]]
        if cfg.get("Cmd") and cfg["Cmd"] != defaults["cmd"]:
            svc["command"] = cfg["Cmd"]
        if cfg.get("Entrypoint") and cfg["Entrypoint"] != defaults["entrypoint"]:
            svc["entrypoint"] = cfg["Entrypoint"]
        if cfg.get("User") and cfg["User"] != defaults["user"]:
            svc["user"] = cfg["User"]
        labels = {k: v for k, v in (cfg.get("Labels") or {}).items() if not k.startswith(_DROP_LABELS)}
        if labels:
            svc["labels"] = labels
        services[svc_name] = svc

    doc = {"services": services}
    if volumes:
        doc["volumes"] = volumes
    if networks:
        doc["networks"] = networks
    header = ("# Reconstructed by BaumLab from the running containers' settings (this service was not\n"
              "# deployed as a Portainer stack). Values for ${VARS} are in secrets.enc → stack_env.\n")
    return header + yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)


# ── Hardening helpers ──────────────────────────────────────────────────────────

MIN_FREE = 1 << 30              # never start or continue a kit with less than 1 GiB of scratch space
RETRY_DELAY = 10                # seconds before retrying a failed copy / dump / upload
START_TIMEOUT = 180             # how long containers get to come back (and turn healthy) after a cold copy

# pg_dumpall and mysqldump end with a marker; a dump without it was cut off part-way
_DUMP_END = {"postgres": b"PostgreSQL database cluster dump complete", "mysql": b"-- Dump completed"}


def _gib(n: int) -> str:
    return f"{n / (1 << 30):.1f} GiB"


def _ensure_space(need: int, what: str):
    free = shutil.disk_usage(dk.BACKUP_TMP_DIR).free
    if free < need:
        raise RuntimeError(f"Not enough scratch space in {dk.BACKUP_TMP_DIR} for {what}: {_gib(free)} free, "
                           f"about {_gib(need)} needed — free up space or exclude large mounts")


def _retry(run: _Run, what: str, fn, attempts: int = 2):
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == attempts:
                raise
            run.log(f"  {what} failed ({e}) — retrying in {RETRY_DELAY}s")
            time.sleep(RETRY_DELAY)


def dump_problem(kind: str, path: str) -> Optional[str]:
    """Why a database dump can't be trusted, or None if it looks complete."""
    size = os.path.getsize(path) if os.path.exists(path) else 0
    if size == 0:
        return "the dump is empty"
    if kind not in _DUMP_END:
        return None                              # mongodump archives have no text end marker
    with open(path, "rb") as fh:
        fh.seek(max(0, size - 4096))
        tail = fh.read()
    return None if _DUMP_END[kind] in tail else "the dump is incomplete (no end marker — it was cut off)"


def tar_problem(path: str) -> Optional[str]:
    """Read a tar (or tar.gz) all the way through — catches truncated copies and corrupt archives."""
    try:
        count = 0
        with tarfile.open(path) as t:
            for member in t:
                count += 1
                if member.isreg():
                    fh = t.extractfile(member)
                    while fh.read(1 << 20):
                        pass
        return None if count else "the copy is empty"
    except (tarfile.TarError, OSError, EOFError, ValueError) as e:
        return f"the copy is unreadable ({e})"


def _start_verified(d: PortainerDocker, run: _Run, ids: list[str]) -> list[str]:
    """Start containers (databases first) and wait until each is running and not unhealthy.
    Returns the names of any that didn't come back."""
    for cid in ids:
        try:
            _retry(run, "Start", lambda: d.start(cid), attempts=3)
        except Exception as e:
            run.log(f"  Couldn't start {cid[:12]}: {e}", warning=True)
    deadline = time.monotonic() + START_TIMEOUT
    pending = list(ids)
    while pending and time.monotonic() < deadline:
        time.sleep(5)
        still = []
        for cid in pending:
            try:
                state = d.inspect(cid).get("State") or {}
            except Exception:
                still.append(cid)
                continue
            health = (state.get("Health") or {}).get("Status")
            if not state.get("Running"):
                try:
                    d.start(cid)                 # exited straight away — give it another push
                except Exception:
                    pass
                still.append(cid)
            elif health in ("starting", "unhealthy"):
                still.append(cid)
        pending = still
    failed = []
    for cid in pending:
        try:
            ins = d.inspect(cid)
            failed.append(f"{ins['Name'].lstrip('/')} ({(ins.get('State') or {}).get('Status')}"
                          f"{', ' + ins['State']['Health']['Status'] if (ins.get('State') or {}).get('Health') else ''})")
        except Exception:
            failed.append(cid[:12])
    return failed


def _service_down_alert(kit: RecoveryKit, failed: list[str]):
    from . import alerts
    try:
        alerts.notify("backup_failed", severity="critical", title=f"🛑 {kit.name} didn't come back after its backup",
                      message=f"BaumLab stopped {kit.name} to copy its files and these containers aren't running/healthy "
                              f"again: {', '.join(failed)}. Check them in Portainer.", url=alerts.link("/portainer"))
    except Exception as e:
        print(f"Recovery kit alert failed: {e}")


def _verified_upload(run: _Run, dest: BackupDestination, archive: str, sub_dir: str):
    """Upload, then confirm the destination holds a file of exactly the same size (re-uploading once if not)."""
    size, name = os.path.getsize(archive), os.path.basename(archive)
    for attempt in (1, 2):
        ok, msg = st.upload(dest, archive, sub_dir)
        if ok:
            remote = next((a for a in st.list_archives(dest, sub_dir) if a["name"] == name), None)
            if remote and int(remote["size"]) == size:
                run.log(f"  Upload verified: {size:,} bytes at the destination")
                return
            msg = f"destination has {remote['size'] if remote else 'no'} bytes, expected {size:,}"
        if attempt == 1:
            run.log(f"  Upload problem ({msg}) — retrying in {RETRY_DELAY}s")
            time.sleep(RETRY_DELAY)
    raise RuntimeError(f"Upload failed: {msg}")


# ── Backup ─────────────────────────────────────────────────────────────────────

def _load(kit_id: int) -> tuple[Optional[RecoveryKit], Optional[BackupDestination]]:
    with Session(engine) as s:
        kit = s.get(RecoveryKit, kit_id)
        dest = s.get(BackupDestination, kit.destination_id) if kit else None
        s.expunge_all()
    return kit, dest


def _targets(d: PortainerDocker, kit: RecoveryKit) -> list[dict]:
    if kit.project:
        found = d.containers(kit.project)
    else:
        wanted = set(json.loads(kit.containers or "[]"))
        found = [c for c in d.containers() if (c.get("Names") or ["/"])[0].lstrip("/") in wanted]
    return found


def _image_of(ins: dict) -> str:
    return (ins.get("Config") or {}).get("Image", "")


def run_kit_backup(kit_id: int):
    if not _claim("kit", kit_id):
        return
    run: Optional[_Run] = None
    kit = None
    tmp_dir = archive = None
    stopped: list[str] = []
    d: Optional[PortainerDocker] = None
    try:
        kit, dest = _load(kit_id)
        if not kit:
            return
        run = _Run("kit", kit.id, kit.name, "backup")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        passphrase = rc.passphrase()
        if not passphrase:
            raise RuntimeError("Set a recovery passphrase first (Backups → Recovery kits)")
        os.makedirs(dk.BACKUP_TMP_DIR, exist_ok=True)
        _ensure_space(MIN_FREE, "a recovery kit")

        name, stamp = dk.safe_name(kit.name), _stamp()
        root = f"kit_{name}_{stamp}"
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, root)
        for sub in ("stack", "data", "databases"):
            os.makedirs(os.path.join(tmp_dir, sub))

        d = PortainerDocker(kit.connection, kit.endpoint_id)
        summaries = _retry(run, "Listing containers", lambda: _targets(d, kit))
        if not summaries:
            raise RuntimeError(f"No containers found for {kit.project or kit.name} on {kit.endpoint_name or kit.endpoint_id}")
        inspects = [d.inspect(c["Id"]) for c in summaries]
        names = [i["Name"].lstrip("/") for i in inspects]
        run.log(f"Recovery kit for {kit.project or kit.name} on {kit.endpoint_name}: {', '.join(names)}")
        excluded = set(json.loads(kit.exclude_mounts or "[]"))
        problems: list[str] = []                 # anything that makes this kit incomplete → run fails

        # 0. Will the copies fit? Named volume sizes are known up front (bind mounts aren't)
        try:
            sizes = d.volume_sizes()
        except Exception as e:
            sizes = None
            run.log(f"  Couldn't size the volumes in advance ({e}) — checking space as it goes")
        if sizes is not None:
            wanted = {m["Name"] for i in inspects for m in i.get("Mounts") or []
                      if m.get("Type") == "volume" and not skip_mount(m)
                      and mount_key(i["Name"].lstrip("/"), m["Destination"]) not in excluded}
            estimate = sum(sizes.get(v, 0) for v in wanted)
            run.log(f"  Named volumes total about {_gib(estimate)}; "
                    f"{_gib(shutil.disk_usage(dk.BACKUP_TMP_DIR).free)} scratch space free")
            _ensure_space(estimate * 2 + MIN_FREE, "this kit's volumes (copied, then packed)")

        # 1. Definition: Portainer's own stack file when there is one, otherwise rebuilt from the containers
        stack_env: dict = {}
        try:
            pstack = next((s for s in d.stacks() if kit.project and s.get("Name") == kit.project), None)
        except Exception as e:
            pstack = None
            run.log(f"  Couldn't read Portainer stacks ({e}) — reconstructing the compose file instead", warning=True)
        git = None
        if pstack:
            compose = d.stack_file(pstack["Id"])
            stack_env = {e["name"]: e.get("value", "") for e in pstack.get("Env") or []}
            if pstack.get("GitConfig"):
                g = pstack["GitConfig"]
                git = {"url": g.get("URL"), "ref": g.get("ReferenceName"), "path": g.get("ConfigFilePath")}
            run.log(f"  Stack file from Portainer ({len(stack_env)} stack variables)" + (f", git {git['url']}" if git else ""))
        else:
            compose = reconstruct(d, inspects, stack_env)
            run.log(f"  Not a Portainer stack — reconstructed docker-compose.yml from {len(inspects)} container(s)")
        yaml.safe_load(compose)                  # a definition that doesn't parse can't be deployed — fail now
        with open(os.path.join(tmp_dir, "stack", "docker-compose.yml"), "w") as fh:
            fh.write(compose)

        images = []
        for ins in inspects:
            info = d.image(ins.get("Image", "")) or {}
            images.append({"container": ins["Name"].lstrip("/"), "image": _image_of(ins),
                           "digest": (info.get("RepoDigests") or [None])[0]})

        # 2. Databases — dumped live (retried once) and checked for completeness, before anything is stopped
        databases, failed_dumps = [], []
        if kit.dump_databases:
            for ins in inspects:
                kind = db_kind(_image_of(ins))
                cname = ins["Name"].lstrip("/")
                if not kind:
                    continue
                if not (ins.get("State") or {}).get("Running"):
                    run.log(f"  {cname} isn't running — no dump, but its files are copied while it's stopped", warning=True)
                    continue
                ext, script = _DUMP[kind]
                fname = f"databases/{_safe(cname)}.{kind}.{ext}"
                path = os.path.join(tmp_dir, fname)
                why = None
                for attempt in (1, 2):
                    try:
                        code, err = d.exec_to_file(ins["Id"], ["sh", "-c", script], path)
                        why = f"exit {code}: {err[:200]}" if code != 0 else dump_problem(kind, path)
                    except Exception as e:
                        why = str(e)
                    if not why:
                        break
                    if attempt == 1:
                        run.log(f"  Dump of {cname} failed ({why}) — retrying in {RETRY_DELAY}s")
                        time.sleep(RETRY_DELAY)
                if why:
                    failed_dumps.append(cname)
                    if os.path.exists(path):
                        os.remove(path)
                    run.log(f"  Dump of {cname} ({kind}) failed twice: {why}", warning=not kit.cold_copy_fallback)
                    continue
                size = os.path.getsize(path)
                databases.append({"container": cname, "type": kind, "file": fname, "size": size,
                                  "service": ((ins.get("Config") or {}).get("Labels") or {}).get("com.docker.compose.service")})
                run.log(f"  Dumped {kind} in {cname}: {size:,} bytes (complete)")

        # 3. Data — stop first if asked to, or if a dump failed (a cold copy of a stopped database is consistent)
        cold_reason = "requested" if kit.stop_during_backup else \
            (f"dump failed for {', '.join(failed_dumps)}" if failed_dumps and kit.cold_copy_fallback else None)
        if cold_reason:
            running = [i for i in inspects if (i.get("State") or {}).get("Running")]
            # Apps before their databases, so nothing writes to a database that's going away
            for ins in sorted(running, key=lambda i: db_kind(_image_of(i)) is not None):
                _retry(run, f"Stopping {ins['Name'].lstrip('/')}", lambda: d.stop(ins["Id"]))
                stopped.append(ins["Id"])
            run.log(f"  Stopped {len(stopped)} container(s) for a consistent cold copy ({cold_reason})")
        data, seen = [], {}
        for ins in inspects:
            cname = ins["Name"].lstrip("/")
            for m in ins.get("Mounts") or []:
                if skip_mount(m):
                    continue
                key = mount_key(cname, m["Destination"])
                ident = (m["Type"], m.get("Name") or m.get("Source"))
                entry = {"container": cname, "destination": m["Destination"], "type": m["Type"],
                         "rw": m.get("RW", True), "service": ((ins.get("Config") or {}).get("Labels") or {}).get("com.docker.compose.service")}
                if m["Type"] == "volume":
                    vol = d.volume(m["Name"]) or {}
                    entry.update(name=m["Name"], driver=vol.get("Driver", "local"), labels=vol.get("Labels") or {})
                else:
                    entry["source"] = m["Source"]
                if key in excluded:
                    entry["excluded"] = True
                    data.append(entry)
                    run.log(f"  Skipped {key} (excluded)")
                    continue
                if ident in seen:
                    entry["archive"] = seen[ident]
                    data.append(entry)
                    continue
                fname = f"data/{_safe(cname)}__{_safe(m['Destination'])}.tar"
                path = os.path.join(tmp_dir, fname)
                why = None
                for attempt in (1, 2):
                    _ensure_space(MIN_FREE // 2, f"copying {key}")
                    try:
                        size = d.archive_to_file(ins["Id"], m["Destination"], path)
                        why = tar_problem(path)
                    except Exception as e:
                        why = str(e)
                    if not why:
                        break
                    if attempt == 1:
                        run.log(f"  Copy of {key} failed ({why}) — retrying in {RETRY_DELAY}s")
                        time.sleep(RETRY_DELAY)
                if why:
                    problems.append(f"{key}: {why}")
                    entry["failed"] = why
                    data.append(entry)
                    if os.path.exists(path):
                        os.remove(path)
                    run.log(f"  Copy of {key} failed twice: {why}", warning=True)
                    continue
                entry.update(archive=fname, size=size)
                seen[ident] = fname
                data.append(entry)
                run.log(f"  Copied {key} ({m.get('Name') or m.get('Source')}): {size:,} bytes (verified)")

        if stopped:
            # Databases first on the way back up
            order = sorted(stopped, key=lambda cid: db_kind(_image_of(next(i for i in inspects if i["Id"] == cid))) is None)
            failed = _start_verified(d, run, order)
            stopped = []
            if failed:
                run.log(f"  NOT back up after the cold copy: {', '.join(failed)}", warning=True)
                _service_down_alert(kit, failed)
            else:
                run.log("  All containers running (and healthy, where they have a health check) again")

        # 4. Secrets (passphrase-encrypted) — stack variables plus each container's full settings
        secrets = {"stack_env": stack_env,
                   "containers": {i["Name"].lstrip("/"): {"env": (i.get("Config") or {}).get("Env") or []} for i in inspects}}
        sealed = rc.seal(secrets, passphrase)
        rc.unseal(sealed, passphrase)            # prove it opens before relying on it
        with open(os.path.join(tmp_dir, "secrets.enc"), "w") as fh:
            fh.write(sealed)
        with open(os.path.join(tmp_dir, "decrypt-secrets.py"), "w") as fh:
            fh.write(rc.DECRYPT_SCRIPT)

        manifest = {"version": 1, "kind": "recovery-kit", "name": kit.name, "project": kit.project,
                    "source": {"connection": kit.connection, "endpoint_id": kit.endpoint_id, "endpoint": kit.endpoint_name},
                    "backed_up_at": datetime.utcnow().isoformat(), "portainer_stack": bool(pstack), "git": git,
                    "consistency": "cold" if cold_reason else "live", "cold_reason": cold_reason,
                    "containers": names, "images": images, "data": data, "databases": databases,
                    "failed_dumps": failed_dumps, "problems": problems,
                    "networks": sorted({n for i in inspects for n in ((i.get("NetworkSettings") or {}).get("Networks") or {})})}
        with open(os.path.join(tmp_dir, "manifest.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)
        with open(os.path.join(tmp_dir, "RESTORE.md"), "w") as fh:
            fh.write(restore_doc(manifest))

        # 5. Pack, check the archive reads back cleanly, upload and confirm what landed
        _ensure_space(MIN_FREE // 2, "packing the kit")
        archive = os.path.join(dk.BACKUP_TMP_DIR, f"{root}.tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(tmp_dir, arcname=root)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        tmp_dir = None
        why = tar_problem(archive)
        if why:
            raise RuntimeError(f"The packed kit doesn't read back cleanly: {why}")
        size = os.path.getsize(archive)
        run.log(f"Uploading {size:,} bytes…")
        _verified_upload(run, dest, archive, kit_dir(kit))
        if kit.retention_days > 0 and not problems:
            # Old kits are only pruned after a complete, verified one is safely stored
            err = st.apply_retention(dest, kit_dir(kit), kit.retention_days, [f"kit_{name}"])
            if err:
                run.log(f"Retention failed — {err}", warning=True)
        where = f"{st.remote_name(dest)}:{kit_dir(kit)}/{os.path.basename(archive)}"
        if problems:
            status = run.finish(error=f"Kit uploaded but incomplete — {'; '.join(problems)}", size=size, archive=where)
        else:
            status = run.finish(size=size, archive=where)
        _record_result(RecoveryKit, kit_id, status)
        _alert_result(run, "recovery kit", kit.name, status, "; ".join(problems) or None)
    except Exception as e:
        if run:
            _record_result(RecoveryKit, kit_id, run.finish(error=str(e)))
            _alert_result(run, "recovery kit", kit.name if kit else f"kit {kit_id}", "failed", str(e))
        print(f"Recovery kit {kit_id} failed: {e}")
    finally:
        if stopped and d:                        # never leave a service stopped because something failed
            failed = _start_verified(d, run, stopped) if run else []
            if failed and kit:
                _service_down_alert(kit, failed)
        if d:
            d.http.close()
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if archive and os.path.exists(archive):
            os.remove(archive)
        _release("kit", kit_id)


def run_name(kit_id: int) -> str:
    kit, _ = _load(kit_id)
    return kit.name if kit else f"kit {kit_id}"


# ── Verification: download the newest kit and check it end to end ──────────────

def _record_verify(kit_id: int, status: str, message: str):
    with Session(engine) as s:
        kit = s.get(RecoveryKit, kit_id)
        if kit:
            kit.last_verified_at = datetime.utcnow()
            kit.last_verify_status = status
            kit.last_verify_message = message[:1000]
            s.add(kit)
            s.commit()


def run_kit_verify(kit_id: int):
    """Prove the newest kit is restorable without touching any host: it downloads, unpacks, every copy and
    dump reads back complete, the compose file parses, and the current passphrase opens its secrets."""
    if not _claim("kit", kit_id):
        return
    run: Optional[_Run] = None
    kit = None
    tmp_dir = None
    try:
        kit, dest = _load(kit_id)
        if not kit:
            return
        run = _Run("kit", kit.id, kit.name, "verify")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        archives = list_kit_archives(kit, dest)
        if not archives:
            raise RuntimeError("No kits uploaded yet")
        newest = archives[0]
        _ensure_space(int(newest["size"]) * 3 + MIN_FREE // 2, "downloading and unpacking the kit")
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"kit_verify_{kit_id}_{_stamp()}")
        os.makedirs(os.path.join(tmp_dir, "dl"))
        local = os.path.join(tmp_dir, "dl", newest["name"])
        run.log(f"Checking {newest['name']} ({int(newest['size']):,} bytes)")
        ok, msg = st.download(dest, f"{kit_dir(kit)}/{newest['name']}", local)
        if not ok:
            raise RuntimeError(f"Download failed: {msg}")
        why = tar_problem(local)
        if why:
            raise RuntimeError(f"Archive damaged: {why}")
        root = _extract(local, os.path.join(tmp_dir, "kit"))
        os.remove(local)
        manifest = json.load(open(os.path.join(root, "manifest.json")))
        issues = list(manifest.get("problems") or [])

        try:
            yaml.safe_load(open(os.path.join(root, "stack", "docker-compose.yml")))
        except Exception as e:
            issues.append(f"docker-compose.yml doesn't parse: {e}")
        try:
            rc.unseal(open(os.path.join(root, "secrets.enc")).read(), rc.passphrase() or "")
            run.log("  Secrets open with the current recovery passphrase")
        except Exception as e:
            issues.append(f"secrets: {e} (kits made before a passphrase change need the old one)")
        for e in manifest.get("data") or []:
            if e.get("excluded") or not e.get("archive"):
                continue
            path = os.path.join(root, e["archive"])
            why = "missing" if not os.path.exists(path) else tar_problem(path)
            if not why and e.get("size") is not None and os.path.getsize(path) != e["size"]:
                why = f"size {os.path.getsize(path):,} ≠ {e['size']:,} recorded"
            if why:
                issues.append(f"{e['container']}:{e['destination']}: {why}")
        for db in manifest.get("databases") or []:
            why = dump_problem(db["type"], os.path.join(root, db["file"]))
            if why:
                issues.append(f"dump of {db['container']}: {why}")
        copies = sum(1 for e in manifest.get("data") or [] if e.get("size") is not None)
        run.log(f"  Checked {copies} data cop{'y' if copies == 1 else 'ies'} and {len(manifest.get('databases') or [])} dump(s)"
                f" — {manifest.get('consistency', 'live')} copy from {manifest.get('backed_up_at', '?')[:16]}")
        if issues:
            raise RuntimeError("; ".join(issues))
        run.finish()
        _record_verify(kit_id, "success", f"{newest['name']} checked end to end")
    except Exception as e:
        if run:
            run.finish(error=str(e))
            _alert_result(run, "recovery kit verification", kit.name if kit else f"kit {kit_id}", "failed", str(e))
        _record_verify(kit_id, "failed", str(e))
        print(f"Recovery kit verify {kit_id} failed: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        _release("kit", kit_id)


def verify_all():
    """Weekly: verify every enabled kit's newest archive, one after another."""
    with Session(engine) as s:
        ids = [k.id for k in s.exec(select(RecoveryKit).where(RecoveryKit.enabled == True)).all()]  # noqa: E712
    for kit_id in ids:
        run_kit_verify(kit_id)


# ── RESTORE.md ─────────────────────────────────────────────────────────────────

def restore_doc(m: dict) -> str:
    project = m.get("project") or m["name"]
    lines = [
        f"# Restore {m['name']}",
        "",
        f"Recovery kit made by BaumLab on {m['backed_up_at'][:16].replace('T', ' ')} UTC from "
        f"**{m['source'].get('endpoint') or m['source']['endpoint_id']}** (Portainer connection *{m['source']['connection']}*).",
        "",
        ("Files were copied **cold** (service stopped: " + m["cold_reason"] + "), so they are consistent on their own."
         if m.get("consistency") == "cold" else
         "Files were copied **live**; databases are covered by the dumps in `databases/`."),
        "",
        "## Easiest: restore with BaumLab",
        "",
        "Backups → Recovery kits → this kit → **Archives** → **Restore**. Pick the Portainer environment and a stack name;",
        "BaumLab recreates the volumes and folders, copies the data back, deploys the stack with its environment and can",
        "import the database dumps. A fresh BaumLab works too — add this destination and enter the recovery passphrase.",
        "",
        "## By hand",
        "",
        "### 1. Secrets",
        "",
        "```sh",
        "pip install cryptography",
        "python3 decrypt-secrets.py secrets.enc --env     # asks for the recovery passphrase, writes stack.env",
        "```",
        "",
        "`stack_env` holds the stack's environment variables; `containers` holds every container's full environment.",
        "",
        "### 2. Data",
        "",
        "Each archive is a Docker copy of one mount: its top folder is named after the mount's last path element.",
        "Recreate the volume (or host folder), then unpack into it:",
        "",
    ]
    for e in m["data"]:
        where = e.get("name") or e.get("source")
        if e.get("excluded"):
            lines.append(f"- `{e['container']}:{e['destination']}` ← **not backed up** (excluded) — `{where}`")
            continue
        if not e.get("archive"):
            lines.append(f"- `{e['container']}:{e['destination']}` ← **copy failed**: {e.get('failed', 'unknown error')} — `{where}`")
            continue
        top = os.path.basename(e["destination"].rstrip("/")) or "root"
        if e["type"] == "volume":
            lines.append(f"- volume `{where}` (mounted at `{e['destination']}` in {e['container']}):")
            lines.append(f"  `docker volume create {where} && docker run --rm -v {where}:/v -v \"$PWD\":/k {HELPER_IMAGE} "
                         f"sh -c 'tar -xf /k/{e['archive']} -C /tmp && cp -a /tmp/{top}/. /v/'`")
        else:
            lines.append(f"- host path `{where}` (mounted at `{e['destination']}` in {e['container']}):")
            lines.append(f"  `mkdir -p /tmp/r && tar -xf {e['archive']} -C /tmp/r && sudo cp -a /tmp/r/{top}/. {where}/`"
                         f"  (for a single file: copy `/tmp/r/{top}` to `{where}`)")
    if m.get("problems"):
        lines += ["", "> **This kit is incomplete:** " + "; ".join(m["problems"])]
    lines += ["", "### 3. Deploy", "",
              f"Portainer → Stacks → Add stack named **{project}** on the target host, paste `stack/docker-compose.yml`, "
              "and load `stack.env` under *Environment variables → Advanced mode*. Start it."]
    if m.get("git"):
        g = m["git"]
        lines.append(f"It was originally deployed from git: `{g['url']}` @ `{g['ref']}` (`{g['path']}`).")
    lines += ["", "Images in use when this kit was made (pin with `image@digest` to get exactly these):", ""]
    lines += [f"- {i['container']}: `{i['image']}`" + (f" — `{i['digest']}`" if i.get("digest") else "") for i in m["images"]]
    if m["databases"]:
        lines += ["", "### 4. Databases (only if the copied data volume won't start)", "",
                  "The data volumes above already contain the databases. These dumps are a safety net — e.g. for a",
                  "newer database version. Load one into the freshly started, empty database container:", ""]
        for db in m["databases"]:
            cmd = {"postgres": f"docker exec -i {db['container']} psql -U postgres -d postgres < {db['file']}",
                   "mysql": f"docker exec -i {db['container']} sh -c 'mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\"' < {db['file']}",
                   "mongo": f"docker exec -i {db['container']} mongorestore --drop --archive < {db['file']}"}[db["type"]]
            lines.append(f"- {db['container']} ({db['type']}): `{cmd}`")
    if [n for n in m.get("networks", []) if n not in ("bridge", "host", "none") and not n.startswith(f"{project}_")]:
        lines += ["", "### Networks", "", "These networks were attached and may need to exist first "
                  "(`docker network create <name>`): " + ", ".join(f"`{n}`" for n in m["networks"]
                  if n not in ("bridge", "host", "none") and not n.startswith(f"{project}_"))]
    return "\n".join(lines) + "\n"


# ── Restore ────────────────────────────────────────────────────────────────────

def _retarget(src: str, dst: str, new_top: str):
    """Copy a Docker archive tar, renaming its top-level folder (or single file) to new_top."""
    with tarfile.open(src) as tin, tarfile.open(dst, "w") as tout:
        for member in tin:
            parts = member.name.split("/", 1)
            member.name = new_top + ("/" + parts[1] if len(parts) > 1 and parts[1] else "")
            if member.islnk() and member.linkname:
                lparts = member.linkname.split("/", 1)
                member.linkname = new_top + ("/" + lparts[1] if len(lparts) > 1 else "")
            tout.addfile(member, tin.extractfile(member) if member.isreg() else None)


def _single_file(tar_path: str) -> bool:
    with tarfile.open(tar_path) as t:
        members = t.getmembers()
    return len(members) == 1 and members[0].isreg()


def _volume_name(e: dict, old_project: Optional[str], new_project: str) -> str:
    labels = e.get("labels") or {}
    if old_project and labels.get("com.docker.compose.project") == old_project and labels.get("com.docker.compose.volume"):
        return f"{new_project}_{labels['com.docker.compose.volume']}"
    return e["name"]


def list_kit_archives(kit: RecoveryKit, dest: BackupDestination) -> list[dict]:
    return [a for a in st.list_archives(dest, kit_dir(kit)) if a["name"].startswith(f"kit_{dk.safe_name(kit.name)}_")]


def run_kit_restore(kit_id: int, filename: str, connection: str, endpoint_id: int, stack_name: str,
                    restore_data: bool, deploy: bool, import_databases: bool, replace_existing: bool,
                    passphrase: Optional[str] = None):
    if not _claim("kit", kit_id):
        return
    run: Optional[_Run] = None
    tmp_dir = None
    try:
        kit, dest = _load(kit_id)
        if not kit:
            return
        run = _Run("kit", kit.id, kit.name, "restore")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"kit_restore_{kit_id}_{_stamp()}")
        os.makedirs(os.path.join(tmp_dir, "dl"))
        local = os.path.join(tmp_dir, "dl", filename)
        run.log(f"Downloading {filename}…")
        ok, msg = st.download(dest, f"{kit_dir(kit)}/{filename}", local)
        if not ok:
            raise RuntimeError(f"Download failed: {msg}")
        root = _extract(local, os.path.join(tmp_dir, "kit"))   # its own folder: _extract returns the single entry
        os.remove(local)
        manifest = json.load(open(os.path.join(root, "manifest.json")))
        secrets = rc.unseal(open(os.path.join(root, "secrets.enc")).read(), passphrase or rc.passphrase() or "")
        old_project = manifest.get("project")
        project = stack_name or old_project or dk.safe_name(kit.name)

        with PortainerDocker(connection, endpoint_id) as d:
            # Refuse to collide with what's already there
            if deploy and any(s.get("Name") == project for s in d.stacks()):
                raise RuntimeError(f"A stack named {project} already exists on that environment — remove it or restore under another name")

            volume_names = {}
            if restore_data:
                d.pull(HELPER_IMAGE)
                for e in manifest["data"]:
                    if e.get("excluded") or not e.get("archive"):
                        continue
                    if e["type"] == "volume":
                        target = volume_names.get(e["name"]) or _volume_name(e, old_project, project)
                        if target in volume_names.values():
                            continue                     # shared volume already restored
                        volume_names[e["name"]] = target
                        existing = d.volume(target)
                        if existing and not replace_existing:
                            raise RuntimeError(f"Volume {target} already exists on that environment — tick "
                                               "'replace existing data' to overwrite it")
                        if not existing:
                            labels = dict(e.get("labels") or {})
                            if labels.get("com.docker.compose.project") == old_project:
                                labels["com.docker.compose.project"] = project
                            d.create_volume(target, labels, e.get("driver", "local"))
                        bind, put_at, top = f"{target}:/restore/v", "/restore", "v"
                    else:
                        source = e["source"]
                        if _single_file(os.path.join(root, e["archive"])):
                            bind, put_at, top = f"{os.path.dirname(source)}:/restore/p", "/restore/p", os.path.basename(source)
                        else:
                            bind, put_at, top = f"{source}:/restore/v", "/restore", "v"
                    retargeted = os.path.join(tmp_dir, "upload.tar")
                    _retarget(os.path.join(root, e["archive"]), retargeted, top)
                    clear = ["sh", "-c", "find /restore/v -mindepth 1 -delete"] if replace_existing and top == "v" else None
                    helper = d.create_helper([bind], clear)
                    try:
                        if clear:
                            d.run_helper(helper)
                        d.put_archive(helper, put_at, retargeted)
                    finally:
                        d.remove(helper)
                        os.remove(retargeted)
                    run.log(f"  Restored {e['container']}:{e['destination']} → "
                            f"{('volume ' + volume_names[e['name']]) if e['type'] == 'volume' else e['source']}")

            if deploy:
                compose = open(os.path.join(root, "stack", "docker-compose.yml")).read()
                if not manifest.get("portainer_stack") and volume_names:
                    doc = yaml.safe_load(compose)
                    for v in (doc.get("volumes") or {}).values():
                        if isinstance(v, dict) and v.get("name") in volume_names:
                            v["name"] = volume_names[v["name"]]
                    compose = yaml.safe_dump(doc, sort_keys=False)
                env = [{"name": k, "value": v} for k, v in (secrets.get("stack_env") or {}).items()]
                run.log(f"Deploying stack {project} ({len(env)} variables)…")
                d.create_stack(project, compose, env)
                run.log(f"  Deployed {project}")

            if deploy and import_databases and manifest.get("databases"):
                for db in manifest["databases"]:
                    _import_db(d, run, root, db, project)

        status = run.finish()            # restores don't change the kit's backup freshness
        _alert_result(run, "recovery kit restore", kit.name, status)
    except Exception as e:
        if run:
            run.finish(error=str(e))
            _alert_result(run, "recovery kit restore", run_name(kit_id), "failed", str(e))
        print(f"Recovery kit restore {kit_id} failed: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        _release("kit", kit_id)


def _import_db(d: PortainerDocker, run: _Run, root: str, db: dict, project: str):
    """Load a dump into the new database container once it accepts connections."""
    candidates = d.containers(project)
    target = next((c for c in candidates if db.get("service") and
                   (c.get("Labels") or {}).get("com.docker.compose.service") == db["service"]), None) \
        or next((c for c in candidates if (c.get("Names") or ["/"])[0].lstrip("/") == db["container"]), None)
    if not target:
        run.log(f"  No container for {db['container']} in the new stack — dump not imported", warning=True)
        return
    devnull = os.devnull
    for _ in range(40):                        # up to ~2 minutes for a first start
        code, _ = d.exec_to_file(target["Id"], ["sh", "-c", _READY[db["type"]]], devnull)
        if code == 0:
            break
        time.sleep(3)
    else:
        run.log(f"  {db['container']} never became ready — dump not imported", warning=True)
        return
    staged = os.path.join(root, "dump.tar")
    with tarfile.open(staged, "w") as t:
        t.add(os.path.join(root, db["file"]), arcname="baumlab-restore.dump")
    d.put_archive(target["Id"], "/tmp", staged)
    os.remove(staged)
    code, err = d.exec_to_file(target["Id"], ["sh", "-c", f'F=/tmp/baumlab-restore.dump; {_IMPORT[db["type"]]}; '
                                                          'S=$?; rm -f "$F"; exit $S'], devnull)
    if code != 0:
        run.log(f"  Import into {db['container']} exited {code}: {err[:300]}", warning=True)
    else:
        run.log(f"  Imported the {db['type']} dump into {db['container']}")

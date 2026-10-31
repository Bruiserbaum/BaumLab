"""
Docker operations for backups, via the Docker socket.

Volumes and bind mounts are archived by a throwaway Alpine container that mounts the
source read-only next to BACKUP_TMP_DIR. That directory must be bind-mounted at the
SAME path on the host and in this container, because the Docker daemon resolves the
helper's mount paths on the host.
"""
import io
import os
import re
import tarfile
from typing import Any, Optional

import docker
from docker.errors import ContainerError, DockerException, NotFound

HELPER_IMAGE = "alpine:3.20"
BACKUP_TMP_DIR = os.getenv("BACKUP_TMP_DIR", "/tmp/baumlab-backup")

# Mounts that are plumbing, not data: Docker's control socket, devices, runtime dirs, host time / DNS files
_SYSTEM_PREFIXES = ("/var/run", "/run", "/dev", "/proc", "/sys")
_SYSTEM_EXACT = {"/etc/localtime", "/etc/timezone", "/etc/hosts", "/etc/resolv.conf", "/etc/hostname"}


class SkippedMount(Exception):
    """The mount turned out to be a socket — nothing to back up."""


def system_mount(source: str, destination: str = "") -> bool:
    return (source.endswith(".sock") or destination in _SYSTEM_EXACT
            or any(destination == p or destination.startswith(p + "/") for p in _SYSTEM_PREFIXES))


def _client() -> docker.DockerClient:
    return docker.from_env(timeout=60)


def status() -> dict:
    """Whether backups can run here: Docker socket reachable and temp dir mirrored on the host."""
    try:
        version = _client().version().get("Version")
    except DockerException as e:
        return {"docker": False, "error": f"Docker socket not available: {e}"}
    return {"docker": True, "docker_version": version, "tmp_dir": BACKUP_TMP_DIR,
            "tmp_dir_ok": os.path.isdir(BACKUP_TMP_DIR)}


def safe_name(name: str) -> str:
    """File-system safe version of a job / volume name (used in archive names)."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "backup"


# ── Inventory ──────────────────────────────────────────────────────────────────

def _mounts(attrs: dict) -> list[dict]:
    out = []
    for m in attrs.get("Mounts", []) or []:
        if m.get("Type") not in ("volume", "bind") or not m.get("Source"):
            continue
        if system_mount(m["Source"], m.get("Destination", "")):
            continue
        out.append({
            "type": m["Type"],
            "source": m.get("Name") if m["Type"] == "volume" else m["Source"],
            "name": m.get("Name") or os.path.basename(m["Source"].rstrip("/")) or "root",
            "destination": m.get("Destination", ""),
        })
    return out


def list_containers() -> list[dict[str, Any]]:
    result = []
    for c in _client().containers.list(all=True):
        labels = c.labels or {}
        result.append({
            "id": c.short_id,
            "name": c.name,
            "status": c.status,
            "image": c.image.tags[0] if c.image.tags else c.attrs.get("Config", {}).get("Image", ""),
            "project": labels.get("com.docker.compose.project", ""),
            "mounts": _mounts(c.attrs),
        })
    return sorted(result, key=lambda c: c["name"])


def list_volumes() -> list[dict]:
    return sorted(({"name": v.name, "driver": v.attrs.get("Driver", "")} for v in _client().volumes.list()),
                  key=lambda v: v["name"])


def detect_compose_stacks() -> list[dict]:
    """Group containers by compose project label (works for Portainer and CLI deployments)."""
    projects: dict[str, dict] = {}
    for c in _client().containers.list(all=True):
        labels = c.labels or {}
        project = labels.get("com.docker.compose.project")
        if not project:
            continue
        p = projects.setdefault(project, {
            "compose_project": project,
            "working_dir": labels.get("com.docker.compose.project.working_dir", ""),
            "containers": [], "volumes": set(),
        })
        p["containers"].append(c.name)
        for m in c.attrs.get("Mounts", []) or []:
            if m.get("Type") == "volume" and m.get("Name"):
                p["volumes"].add(m["Name"])
    return sorted(
        ({**p, "containers": sorted(p["containers"]), "volumes": sorted(p["volumes"])} for p in projects.values()),
        key=lambda p: p["compose_project"],
    )


def stop_container(name: str) -> bool:
    try:
        _client().containers.get(name).stop(timeout=30)
        return True
    except DockerException:
        return False


def start_container(name: str) -> bool:
    try:
        _client().containers.get(name).start()
        return True
    except DockerException:
        return False


def project_env(compose_project: str) -> Optional[str]:
    """Env vars of a compose project's containers, in .env format (fallback when no .env file)."""
    skip = ("PATH=", "HOSTNAME=", "HOME=", "TERM=", "SHLVL=", "PWD=")
    seen: dict[str, str] = {}
    for c in _client().containers.list(filters={"label": f"com.docker.compose.project={compose_project}"}):
        for entry in c.attrs.get("Config", {}).get("Env") or []:
            if not entry.startswith(skip):
                seen.setdefault(entry.split("=", 1)[0], entry)
    return "\n".join(seen.values()) if seen else None


# ── Archive / restore mounts ───────────────────────────────────────────────────

def archive_mount(source: str, archive_name: str, out_dir: str) -> int:
    """tar.gz a named volume or host path (folder or single file) into out_dir/archive_name. Returns size in bytes.
    Raises SkippedMount for a socket."""
    out = f"/backup/{archive_name}"
    try:
        _client().containers.run(
            HELPER_IMAGE,
            # exit 3 = a socket; a single file is stored as one entry named "data"
            ["sh", "-c", f"[ -S /data ] && exit 3; if [ -d /data ]; then tar czf '{out}' -C /data .; "
                         f"else tar czf '{out}' -C / data; fi"],
            volumes={source: {"bind": "/data", "mode": "ro"}, out_dir: {"bind": "/backup", "mode": "rw"}},
            remove=True,
        )
    except ContainerError as e:
        if e.exit_status == 3:
            raise SkippedMount(f"{source} is a socket, not data")
        raise
    return os.path.getsize(os.path.join(out_dir, archive_name))


def restore_mount(target: str, kind: str, archive_path: str) -> None:
    """Replace the contents of a named volume (created if missing) or host path with an archive."""
    client = _client()
    if kind == "volume":
        try:
            client.volumes.get(target)
        except NotFound:
            client.volumes.create(target)
    folder, name = os.path.split(archive_path)
    client.containers.run(
        HELPER_IMAGE,
        # A single-file bind is written back in place (same file, so the container's mount still sees it)
        ["sh", "-c", f"if [ -d /data ]; then find /data -mindepth 1 -delete; tar xzf '/backup/{name}' -C /data; "
                     f"else tar xzf '/backup/{name}' -O > /data; fi"],
        volumes={target: {"bind": "/data", "mode": "rw"}, folder: {"bind": "/backup", "mode": "ro"}},
        remove=True,
    )


# ── Database dump / restore ────────────────────────────────────────────────────

def _db_env(db_type: str, password: str) -> dict:
    # Passwords go in the environment, not on the command line where `ps` shows them
    return {"MYSQL_PWD": password} if db_type == "mysql" else {"PGPASSWORD": password}


def db_dump(container: str, db_type: str, db_name: str, db_user: str, password: str, out_path: str) -> None:
    if db_type == "mysql":
        cmd = ["mysqldump", "--single-transaction", f"-u{db_user}", db_name]
    elif db_type == "postgres":
        cmd = ["pg_dump", "-U", db_user, db_name]
    else:
        raise RuntimeError(f"Unsupported database type {db_type!r}")
    api = _client().api
    exec_id = api.exec_create(container, cmd, environment=_db_env(db_type, password), stdout=True, stderr=False)["Id"]
    with open(out_path, "wb") as fh:
        for chunk in api.exec_start(exec_id, stream=True):
            fh.write(chunk)
    code = api.exec_inspect(exec_id).get("ExitCode")
    if code != 0:
        raise RuntimeError(f"{cmd[0]} exited with code {code}")


def db_restore(container: str, db_type: str, db_name: str, db_user: str, password: str, sql_path: str) -> None:
    if db_type == "mysql":
        client_cmd = f"mysql -u'{db_user}' '{db_name}'"
    elif db_type == "postgres":
        client_cmd = f"psql -v ON_ERROR_STOP=1 -U '{db_user}' -d '{db_name}'"
    else:
        raise RuntimeError(f"Unsupported database type {db_type!r}")
    c = _client().containers.get(container)
    # Copy the dump into the container, feed it to the client, then remove it
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(sql_path, arcname="baumlab-restore.sql")
    buf.seek(0)
    c.put_archive("/tmp", buf.read())
    result = c.exec_run(["sh", "-c", f"{client_cmd} < /tmp/baumlab-restore.sql; rc=$?; rm -f /tmp/baumlab-restore.sql; exit $rc"],
                        environment=_db_env(db_type, password))
    if result.exit_code != 0:
        raise RuntimeError(f"restore exited {result.exit_code}: {result.output.decode(errors='replace')[-300:]}")

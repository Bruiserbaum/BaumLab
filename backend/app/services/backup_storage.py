"""
rclone wrapper for backup destinations.

Unlike BaumLabBackup there is no rclone.conf on disk: each command gets its remote
defined through RCLONE_CONFIG_DEST_<id>_* environment variables built from the
encrypted destination record, so credentials only exist in memory while rclone runs.
"""
import json
import os
import subprocess
import time
from typing import Optional

from ..models.backup import BackupDestination
from .config_service import decrypt

DEST_TYPES = ("b2", "smb", "sftp", "local")
SECRET_FIELDS = {"password", "application_key"}
# Which config field holds the secret / the login name, per type — filled from a vault entry when one is linked
SECRET_BY_TYPE = {"b2": "application_key", "smb": "password", "sftp": "password"}
USER_BY_TYPE = {"b2": "account_id", "smb": "user", "sftp": "user"}
AUDIT_EVERY = 3600                 # log vault use at most hourly per destination (a run makes many rclone calls)
_last_audit: dict[tuple[int, int], float] = {}


def remote_name(dest: BackupDestination) -> str:
    return f"dest_{dest.id}"


def dest_config(dest: BackupDestination) -> dict:
    return json.loads(decrypt(dest.config_enc))


def vault_credential(cred_id: int, actor: str, throttle: Optional[tuple] = None) -> tuple[Optional[str], str]:
    """(username, secret) of a vault entry, logged in the vault audit (at most hourly per `throttle` key)."""
    from sqlmodel import Session
    from ..database import engine
    from ..models.vault import VaultAudit, VaultEntry
    from . import vault
    reason = vault.lock_reason()
    if reason:
        raise RuntimeError(f"Vault locked: {reason}")
    with Session(engine) as s:
        entry = s.get(VaultEntry, int(cred_id))
        if not entry:
            raise RuntimeError(f"The vault entry this destination uses (#{cred_id}) no longer exists — edit the destination")
        secret = vault.decrypt(entry.secret_enc) if entry.secret_enc else ""
        if throttle is None or time.monotonic() - _last_audit.get(throttle, -AUDIT_EVERY) >= AUDIT_EVERY:
            if throttle is not None:
                _last_audit[throttle] = time.monotonic()
            s.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=actor, action="backup"))
            s.commit()
        return entry.username, secret


def resolved_config(dest: BackupDestination) -> dict:
    """Destination config with its linked vault credential filled in — only ever held in memory."""
    cfg = dest_config(dest)
    cred = cfg.get("credential_id")
    if not cred:
        return cfg
    username, secret = vault_credential(int(cred), f"backup:{dest.name}", throttle=(dest.id, int(cred)))
    if dest.type in SECRET_BY_TYPE:
        cfg[SECRET_BY_TYPE[dest.type]] = secret
    if dest.type in USER_BY_TYPE and not cfg.get(USER_BY_TYPE[dest.type]) and username:
        cfg[USER_BY_TYPE[dest.type]] = username
    return cfg


def base_path(dest: BackupDestination) -> str:
    """Folder on the remote that holds this destination's archives."""
    cfg = dest_config(dest)
    path = (cfg.get("path") or "").strip("/")
    if dest.type == "b2" and cfg.get("bucket"):
        # Bucket picked separately; "path" is the folder inside it (older destinations hold "bucket/folder" in path)
        path = "/".join(x for x in (cfg["bucket"].strip("/"), path) if x)
    if dest.type == "smb":
        # rclone's smb backend takes the share as the first path element
        share = (cfg.get("share") or "").strip("/")
        if share and not (path == share or path.startswith(share + "/")):
            path = f"{share}/{path}" if path else share
    return path


def _obscure(password: str) -> str:
    r = subprocess.run(["rclone", "obscure", "-"], input=password, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"rclone obscure failed: {r.stderr.strip()}")
    return r.stdout.strip()


def _env(dest: BackupDestination) -> dict:
    cfg = resolved_config(dest)
    p = f"RCLONE_CONFIG_DEST_{dest.id}_"
    if dest.type == "b2":
        return {p + "TYPE": "b2", p + "ACCOUNT": cfg.get("account_id", "").strip(), p + "KEY": cfg.get("application_key", "").strip()}
    if dest.type == "smb":
        env = {p + "TYPE": "smb", p + "HOST": cfg.get("host", ""), p + "USER": cfg.get("user", ""),
               p + "DOMAIN": cfg.get("domain", "") or "WORKGROUP"}
        if cfg.get("password"):
            env[p + "PASS"] = _obscure(cfg["password"])
        return env
    if dest.type == "sftp":
        env = {p + "TYPE": "sftp", p + "HOST": cfg.get("host", ""), p + "PORT": str(cfg.get("port") or 22),
               p + "USER": cfg.get("user", "")}
        if cfg.get("password", "").lstrip().startswith("-----BEGIN"):
            # A private key kept in the vault — rclone takes it inline, one line with \n separators
            env[p + "KEY_PEM"] = cfg["password"].strip().replace("\n", "\\n")
        elif cfg.get("password"):
            env[p + "PASS"] = _obscure(cfg["password"])
        if cfg.get("key_file"):
            env[p + "KEY_FILE"] = cfg["key_file"]
        return env
    if dest.type == "local":
        # "path" is the folder itself for local destinations — remote root is "/"
        return {p + "TYPE": "local"}
    raise RuntimeError(f"Unknown destination type {dest.type!r}")


def _run(dest: BackupDestination, *args: str, timeout: int = 3600) -> tuple[int, str, str]:
    env = {**os.environ, **_env(dest), "RCLONE_CONFIG": "/dev/null"}
    try:
        r = subprocess.run(["rclone", *args], capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 1, "", f"rclone timed out after {timeout}s"
    except FileNotFoundError:
        return 1, "", "rclone is not installed in this container"


def _target(dest: BackupDestination, sub: str = "") -> str:
    path = "/".join(x for x in (base_path(dest), sub.strip("/")) if x)
    if dest.type == "local":
        path = "/" + path
    return f"{remote_name(dest)}:{path}"


def upload(dest: BackupDestination, local_file: str, sub_dir: str = "") -> tuple[bool, str]:
    rc, out, err = _run(dest, "copy", local_file, _target(dest, sub_dir))
    return rc == 0, (out if rc == 0 else err).strip()


def download(dest: BackupDestination, remote_file: str, local_file: str) -> tuple[bool, str]:
    rc, out, err = _run(dest, "copyto", _target(dest, remote_file), local_file)
    return rc == 0, (out if rc == 0 else err).strip()


def list_archives(dest: BackupDestination, sub_dir: str = "") -> list[dict]:
    """[{name, size, modified}] of .tar.gz files, newest first."""
    rc, out, err = _run(dest, "lsjson", _target(dest, sub_dir), "--files-only", timeout=120)
    if rc != 0:
        raise RuntimeError(err.strip()[:300] or "listing failed")
    items = [
        {"name": i.get("Name", ""), "size": i.get("Size", 0), "modified": i.get("ModTime", "")}
        for i in json.loads(out or "[]") if i.get("Name", "").endswith(".tar.gz")
    ]
    return sorted(items, key=lambda i: i["modified"], reverse=True)


def apply_retention(dest: BackupDestination, sub_dir: str, days: int, name_prefixes: list[str]) -> Optional[str]:
    """Delete this target's archives older than `days`. Scoped by filename so jobs sharing a
    destination folder never delete each other's backups (BaumLabBackup deleted everything)."""
    includes = []
    for prefix in dict.fromkeys(name_prefixes):
        includes += ["--include", f"{prefix}_*.tar.gz"]
    rc, out, err = _run(dest, "delete", _target(dest, sub_dir), f"--min-age={days}d", "--max-depth=1", *includes)
    return None if rc == 0 else err.strip()[:300]


# ── Backblaze B2 key check / bucket list (straight to the B2 API, for clear answers) ──

B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account"
B2_NEEDS = {"listFiles": "list archives", "readFiles": "restore", "writeFiles": "upload backups",
            "deleteFiles": "remove old archives (retention)"}
B2_REJECTED = ("Backblaze rejected this Key ID / Application key. Copy both again from Backblaze → Application Keys "
               "(the application key is only shown once, when the key is created — if it's lost, create a new key). "
               "The Key ID is the 25-character keyID, not the key's name.")


def _b2_message(r) -> str:
    try:
        body = r.json()
        return body.get("message") or body.get("code") or r.text[:200]
    except ValueError:
        return r.text[:200]


def _b2_restricted(allowed: dict) -> list[dict]:
    """Buckets a key is restricted to, as [{id, name}] — v2 names one bucket, v3 lists them."""
    found = [{"id": b.get("id") or b.get("bucketId"), "name": b.get("name") or b.get("bucketName")}
             for b in allowed.get("buckets") or [] if isinstance(b, dict)]
    if allowed.get("bucketId") or allowed.get("bucketName"):
        found.append({"id": allowed.get("bucketId"), "name": allowed.get("bucketName")})
    return [b for b in found if b["id"] or b["name"]]


def b2_check(key_id: str, app_key: str, bucket_hint: str = "") -> dict:
    """{buckets, missing: [(capability, what it's for)], prefix} for a B2 application key.
    Raises ValueError when Backblaze rejects the key, RuntimeError when it can't be checked."""
    import httpx
    key_id, app_key = (key_id or "").strip(), (app_key or "").strip()
    if not key_id or not app_key:
        raise ValueError("Enter the Key ID and the Application key first")
    try:
        r = httpx.get(B2_AUTH_URL, auth=(key_id, app_key), timeout=20)
    except httpx.HTTPError as e:
        raise RuntimeError(f"Couldn't reach Backblaze: {e}")
    if r.status_code in (400, 401):
        raise ValueError(B2_REJECTED)
    if r.status_code != 200:
        raise RuntimeError(f"Backblaze answered {r.status_code}: {_b2_message(r)}")
    auth = r.json()
    # v2 puts these at the top level, v3 under apiInfo.storageApi — accept either
    storage = (auth.get("apiInfo") or {}).get("storageApi") or {}
    api_url = auth.get("apiUrl") or storage.get("apiUrl")
    allowed = auth.get("allowed") or storage.get("allowed") or {}
    caps = allowed.get("capabilities") or []
    if not api_url or not auth.get("accountId"):
        raise RuntimeError("Backblaze answered in an unexpected format")
    if not caps:
        print(f"B2 key check: no capability list in the answer (allowed keys: {sorted(allowed)})")

    def list_buckets(**only) -> Optional[list[str]]:
        try:
            r = httpx.post(f"{api_url}/b2api/v2/b2_list_buckets", json={"accountId": auth["accountId"], **only},
                           headers={"Authorization": auth["authorizationToken"]}, timeout=20)
        except httpx.HTTPError as e:
            raise RuntimeError(f"Couldn't list buckets: {e}")
        if r.status_code != 200:
            list_buckets.error = _b2_message(r)
            return None
        return [b["bucketName"] for b in r.json().get("buckets", []) if b.get("bucketName")]
    list_buckets.error = ""

    restricted = _b2_restricted(allowed)
    if restricted:
        # A key limited to certain buckets may only ask about those, by id
        buckets = [b["name"] for b in restricted if b["name"]]
        for b in restricted:
            if not b["name"] and b["id"]:
                buckets += list_buckets(bucketId=b["id"]) or []
    else:
        buckets = list_buckets()
        if buckets is None and bucket_hint:
            # Can't see every bucket (often a single-bucket key) — ask about the one typed in
            buckets = list_buckets(bucketName=bucket_hint.strip())
            if buckets == []:
                raise ValueError(f"This key can't reach a bucket called “{bucket_hint.strip()}” — check the name (it's case-sensitive)")
        if buckets is None:
            raise RuntimeError(f"Couldn't list buckets ({list_buckets.error}). If this key is limited to one bucket, "
                               "type the bucket name and click List buckets again")
    # No capability list at all means an answer shaped differently than expected — don't cry wolf
    missing = [[c, why] for c, why in B2_NEEDS.items() if c not in caps] if caps else []
    return {"buckets": buckets, "missing": missing,
            "prefix": allowed.get("namePrefix")}


def _b2_problem(dest: BackupDestination) -> Optional[str]:
    """Plain-language reason a B2 destination can't work, or None. Warnings come back prefixed '!'."""
    cfg = resolved_config(dest)
    bucket = (cfg.get("bucket") or (cfg.get("path") or "").strip("/").split("/")[0]).strip()
    try:
        info = b2_check(cfg.get("account_id", ""), cfg.get("application_key", ""), bucket)
    except ValueError as e:
        return str(e)
    except RuntimeError:
        return None                       # couldn't check — let rclone have a go and report its own error
    if bucket and info["buckets"] and bucket not in info["buckets"]:
        return f"This key can't see a bucket called “{bucket}” (it can see: {', '.join(info['buckets'])})"
    if info["missing"]:
        return "!" + "; ".join(f"the key lacks {c}, so it can't {why}" for c, why in info["missing"])
    return None


def test(dest: BackupDestination) -> tuple[bool, str]:
    warning = ""
    if dest.type == "b2":
        problem = _b2_problem(dest)
        if problem and not problem.startswith("!"):
            return False, problem
        warning = f" — but {problem[1:]}" if problem else ""
    rc, out, err = _run(dest, "lsd", _target(dest), "--max-depth=1", "--contimeout=10s", "--timeout=20s", timeout=60)
    if rc == 0:
        return not warning, "Connection successful" + warning
    # An empty / not-yet-created folder is fine — it's created on first upload
    if "directory not found" in err.lower():
        return not warning, "Connected — folder will be created on first backup" + warning
    return False, (err.strip() or "Connection failed")[:400]


def redact(cfg: dict) -> dict:
    return {k: ("••••••••" if k in SECRET_FIELDS and v else v) for k, v in cfg.items()}

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


def resolved_config(dest: BackupDestination) -> dict:
    """Destination config with its linked vault credential filled in — only ever held in memory."""
    cfg = dest_config(dest)
    cred = cfg.get("credential_id")
    if not cred:
        return cfg
    from sqlmodel import Session
    from ..database import engine
    from ..models.vault import VaultAudit, VaultEntry
    from . import vault
    reason = vault.lock_reason()
    if reason:
        raise RuntimeError(f"Vault locked: {reason}")
    with Session(engine) as s:
        entry = s.get(VaultEntry, int(cred))
        if not entry:
            raise RuntimeError(f"The vault entry this destination uses (#{cred}) no longer exists — edit the destination")
        secret = vault.decrypt(entry.secret_enc) if entry.secret_enc else ""
        key = (dest.id, entry.id)
        if time.monotonic() - _last_audit.get(key, -AUDIT_EVERY) >= AUDIT_EVERY:
            _last_audit[key] = time.monotonic()
            s.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=f"backup:{dest.name}", action="backup"))
            s.commit()
        username = entry.username
    if dest.type in SECRET_BY_TYPE:
        cfg[SECRET_BY_TYPE[dest.type]] = secret
    if dest.type in USER_BY_TYPE and not cfg.get(USER_BY_TYPE[dest.type]) and username:
        cfg[USER_BY_TYPE[dest.type]] = username
    return cfg


def base_path(dest: BackupDestination) -> str:
    """Folder on the remote that holds this destination's archives."""
    cfg = dest_config(dest)
    path = (cfg.get("path") or "").strip("/")
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
        return {p + "TYPE": "b2", p + "ACCOUNT": cfg.get("account_id", ""), p + "KEY": cfg.get("application_key", "")}
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


def test(dest: BackupDestination) -> tuple[bool, str]:
    rc, out, err = _run(dest, "lsd", _target(dest), "--max-depth=1", "--contimeout=10s", "--timeout=20s", timeout=60)
    if rc == 0:
        return True, "Connection successful"
    # An empty / not-yet-created folder is fine — it's created on first upload
    if "directory not found" in err.lower():
        return True, "Connected — folder will be created on first backup"
    return False, (err.strip() or "Connection failed")[:400]


def redact(cfg: dict) -> dict:
    return {k: ("••••••••" if k in SECRET_FIELDS and v else v) for k, v in cfg.items()}

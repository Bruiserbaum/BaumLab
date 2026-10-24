"""
One-time import of a BaumLabBackup database (destinations, jobs, stacks).

Secrets in the old database are encrypted with a key derived from BaumLabBackup's
SECRET_KEY, so that key is needed. It is kept (encrypted) afterwards so .env files
inside old stack archives can still be decrypted on restore. Jobs and stacks are
imported DISABLED so they don't run twice while BaumLabBackup is still up.
"""
import base64
import json
import os
import sqlite3
import tempfile

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlmodel import Session

from ..database import engine
from ..models.backup import BackupDestination, BackupJob, BackupStack
from .config_service import encrypt, read_config, write_config


def _legacy_fernet(secret: str) -> Fernet:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b"baumlabbackup-salt", iterations=100_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(secret.strip().encode())))


def import_legacy(db_bytes: bytes, legacy_secret: str) -> dict:
    fernet = _legacy_fernet(legacy_secret)
    fd, path = tempfile.mkstemp(suffix=".db")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(db_bytes)
        con = sqlite3.connect(path)
        con.row_factory = sqlite3.Row
        try:
            destinations = con.execute("SELECT * FROM destinations").fetchall()
            jobs = con.execute("SELECT * FROM backup_jobs").fetchall()
            try:
                stacks = con.execute("SELECT * FROM stacks").fetchall()
            except sqlite3.OperationalError:
                stacks = []   # older BaumLabBackup without stack support
        except sqlite3.DatabaseError as e:
            raise ValueError(f"Not a BaumLabBackup database: {e}")
        finally:
            con.close()
    finally:
        os.remove(path)

    def dec(value):
        if not value:
            return None
        try:
            return fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            raise ValueError("That SECRET_KEY doesn't decrypt this database — use BaumLabBackup's SECRET_KEY")

    dest_map = {}
    with Session(engine) as s:
        for d in destinations:
            config = dec(d["config_encrypted"]) or "{}"
            new = BackupDestination(name=d["name"], type=d["type"], config_enc=encrypt(config))
            s.add(new)
            s.flush()
            dest_map[d["id"]] = new.id

        for j in jobs:
            volumes = json.loads(j["volumes"] or "[]")
            for v in volumes:
                # BaumLabBackup stored host paths even for named volumes; BaumLab archives volumes by name
                kind = v.get("type") or ("volume" if "/docker/volumes/" in (v.get("source") or "") else "bind")
                v["type"] = kind
                if kind == "volume" and v.get("name"):
                    v["source"] = v["name"]
            pw = dec(j["db_password_encrypted"])
            s.add(BackupJob(
                name=j["name"], containers=j["containers"] or "[]", volumes=json.dumps(volumes),
                db_type=j["db_type"] or None, db_container=j["db_container"], db_name=j["db_name"],
                db_user=j["db_user"], db_password_enc=encrypt(pw) if pw else None,
                destination_id=dest_map.get(j["destination_id"]), schedule_cron=j["schedule_cron"],
                pre_stop=bool(j["pre_stop"]), retention_days=j["retention_days"] or 30, enabled=False,
            ))

        for st in stacks:
            s.add(BackupStack(
                name=st["name"], repo_url=st["repo_url"] or "", repo_branch=st["repo_branch"] or "main",
                env_path=st["env_path"] or "", compose_project=st["compose_project"], volumes=st["volumes"] or "[]",
                destination_id=dest_map.get(st["destination_id"]), schedule_cron=st["schedule_cron"],
                retention_days=st["retention_days"] or 30, enabled=False,
            ))
        s.commit()

    cfg = read_config()
    cfg.setdefault("backups", {})["legacy_secret"] = encrypt(legacy_secret.strip())
    write_config(cfg)
    return {"destinations": len(destinations), "jobs": len(jobs), "stacks": len(stacks)}

"""
Vault backup: every vault entry, decrypted and re-sealed with the recovery passphrase — the same
format as a recovery kit's secrets.enc — so the vault can be read without BaumLab (decrypt-secrets.py)
and restored into a fresh BaumLab.

Archive: vault_<ts>.tar.gz → vault_<ts>/vault.enc, decrypt-secrets.py, README.txt
"""
import json
import os
import shutil
import tarfile
from datetime import datetime
from types import SimpleNamespace
from typing import Optional

from sqlmodel import Session, select

from ..database import engine
from ..models.backup import BackupDestination, BackupRun
from ..models.service import Service
from ..models.vault import VaultAudit, VaultEntry
from . import backup_docker as dk
from . import backup_storage as st
from . import recovery_crypto as rc
from . import vault
from .backup_engine import _Run, _alert_result, _claim, _extract, _release, _stamp
from .config_service import read_config, write_config

SUB_DIR = "vault"
FORMAT = "baumlab-vault-1"
DEFAULTS = {"destination_id": None, "schedule_cron": "15 3 * * *", "retention_days": 90, "enabled": False}

README = """BaumLab vault backup
====================

vault.enc holds every vault entry (title, username, password/secret, URL, notes, linked service),
encrypted with your recovery passphrase.

Restore into BaumLab: Backups -> Recovery kits -> Vault backup -> Restore (entries that already
exist with the same title and username are left alone).

Read it without BaumLab:
    pip install cryptography
    python3 decrypt-secrets.py vault.enc
"""


def settings() -> dict:
    return {**DEFAULTS, **read_config().get("backup", {}).get("vault_backup", {})}


def save_settings(data: dict):
    cfg = read_config()
    cfg.setdefault("backup", {})["vault_backup"] = {k: data.get(k, v) for k, v in DEFAULTS.items()}
    write_config(cfg)


def _last_runs() -> tuple[Optional[BackupRun], Optional[BackupRun]]:
    with Session(engine) as s:
        q = select(BackupRun).where(BackupRun.kind == "vault", BackupRun.run_type == "backup", BackupRun.status != "running")
        last = s.exec(q.order_by(BackupRun.started_at.desc())).first()
        ok = s.exec(q.where(BackupRun.status.in_(["success", "warning"])).order_by(BackupRun.started_at.desc())).first()
    return last, ok


def target() -> SimpleNamespace:
    """The vault backup in the same shape as a job/stack/kit, for freshness and stale alerts."""
    cfg = settings()
    last, ok = _last_runs()
    return SimpleNamespace(id=0, name="Vault", enabled=bool(cfg["enabled"] and cfg["destination_id"]),
                           schedule_cron=cfg["schedule_cron"], last_run_status=last.status if last else None,
                           last_run_at=last.completed_at if last else None,
                           last_success_at=ok.completed_at if ok else None)


# ── Export / import ────────────────────────────────────────────────────────────

def payload(session: Session) -> dict:
    services = {s.id: s.name for s in session.exec(select(Service)).all()}
    entries = []
    for e in session.exec(select(VaultEntry).order_by(VaultEntry.title)).all():
        entries.append({"title": e.title, "username": e.username,
                        "secret": vault.decrypt(e.secret_enc) if e.secret_enc else "",
                        "url": e.url, "notes": vault.decrypt(e.notes_enc) if e.notes_enc else None,
                        "service": services.get(e.service_id), "updated_at": e.updated_at.isoformat() if e.updated_at else None})
    return {"format": FORMAT, "exported_at": datetime.utcnow().isoformat(), "entries": entries}


def sealed_export(actor: str) -> tuple[str, int]:
    """The whole vault sealed with the recovery passphrase. Returns (file text, entry count)."""
    vault.require_unlocked()
    passphrase = rc.passphrase()
    if not passphrase:
        raise ValueError("Set a recovery passphrase first (Backups → Recovery kits)")
    with Session(engine) as s:
        data = payload(s)
        s.add(VaultAudit(entry_title=f"Vault backup ({len(data['entries'])} entries)", actor=actor, action="export"))
        s.commit()
    text = rc.seal(data, passphrase)
    rc.unseal(text, passphrase)                  # prove it opens before relying on it
    return text, len(data["entries"])


def import_entries(data: dict, actor: str) -> dict:
    """Add entries from a vault backup. Ones that already exist (same title + username) are skipped."""
    if data.get("format") != FORMAT:
        raise ValueError("That file isn't a BaumLab vault backup")
    vault.require_unlocked()
    added, skipped = 0, 0
    with Session(engine) as s:
        existing = {(e.title, e.username or "") for e in s.exec(select(VaultEntry)).all()}
        services = {sv.name: sv.id for sv in s.exec(select(Service)).all()}
        for item in data.get("entries") or []:
            key = (item.get("title") or "", item.get("username") or "")
            if not key[0] or key in existing:
                skipped += 1
                continue
            entry = VaultEntry(title=key[0], username=item.get("username") or None,
                               secret_enc=vault.encrypt(item["secret"]) if item.get("secret") else "",
                               url=item.get("url"), notes_enc=vault.encrypt(item["notes"]) if item.get("notes") else None,
                               service_id=services.get(item.get("service")), updated_by=actor)
            s.add(entry)
            s.flush()
            s.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=actor, action="create"))
            existing.add(key)
            added += 1
        s.commit()
    return {"added": added, "skipped": skipped}


def restore_text(text: str, passphrase: Optional[str], actor: str) -> dict:
    return import_entries(rc.unseal(text, passphrase or rc.passphrase() or ""), actor)


# ── Scheduled backup to a destination ──────────────────────────────────────────

def _destination() -> BackupDestination:
    dest_id = settings()["destination_id"]
    with Session(engine) as s:
        dest = s.get(BackupDestination, dest_id) if dest_id else None
        s.expunge_all()
    if not dest:
        raise RuntimeError("Choose a destination for the vault backup")
    return dest


def run_vault_backup():
    from .recovery_kits import _verified_upload, tar_problem
    if not _claim("vault", 0):
        return
    run: Optional[_Run] = None
    tmp_dir = archive = None
    try:
        run = _Run("vault", 0, "Vault", "backup")
        dest = _destination()
        text, count = sealed_export("backup:scheduled")
        root = f"vault_{_stamp()}"
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, root)
        os.makedirs(tmp_dir)
        for name, content in (("vault.enc", text), ("decrypt-secrets.py", rc.DECRYPT_SCRIPT), ("README.txt", README)):
            with open(os.path.join(tmp_dir, name), "w") as fh:
                fh.write(content)
        archive = os.path.join(dk.BACKUP_TMP_DIR, f"{root}.tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(tmp_dir, arcname=root)
        why = tar_problem(archive)
        if why:
            raise RuntimeError(f"The packed backup doesn't read back cleanly: {why}")
        run.log(f"Sealed {count} vault entries with the recovery passphrase")
        _verified_upload(run, dest, archive, SUB_DIR)
        days = int(settings()["retention_days"] or 0)
        if days > 0:
            err = st.apply_retention(dest, SUB_DIR, days, ["vault"])
            if err:
                run.log(f"Retention failed — {err}", warning=True)
        status = run.finish(size=os.path.getsize(archive), archive=f"{st.remote_name(dest)}:{SUB_DIR}/{os.path.basename(archive)}")
        _alert_result(run, "vault", "Vault", status)
    except Exception as e:
        if run:
            run.finish(error=str(e))
            _alert_result(run, "vault", "Vault", "failed", str(e))
        print(f"Vault backup failed: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if archive and os.path.exists(archive):
            os.remove(archive)
        _release("vault", 0)


def list_archives() -> list[dict]:
    return [a for a in st.list_archives(_destination(), SUB_DIR) if a["name"].startswith("vault_")]


def restore_archive(filename: str, passphrase: Optional[str], actor: str) -> dict:
    dest = _destination()
    tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"vault_restore_{_stamp()}")
    try:
        os.makedirs(os.path.join(tmp_dir, "dl"))
        local = os.path.join(tmp_dir, "dl", filename)
        ok, msg = st.download(dest, f"{SUB_DIR}/{filename}", local)
        if not ok:
            raise RuntimeError(f"Download failed: {msg}")
        root = _extract(local, os.path.join(tmp_dir, "x"))
        return restore_text(open(os.path.join(root, "vault.enc")).read(), passphrase, actor)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

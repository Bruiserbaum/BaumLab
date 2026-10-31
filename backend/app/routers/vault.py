from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from ..database import get_session
from ..models.user import User
from ..models.vault import VaultEntry, VaultAudit, VaultEntryIn, VaultEntryPublic
from ..services.auth import require_admin
from ..services import vault

# Admin-only; everything except /status also requires the vault's safety checks to pass
router = APIRouter(prefix="/api/vault", tags=["vault"], dependencies=[Depends(require_admin)])
unlocked = [Depends(vault.require_unlocked)]


def _public(e: VaultEntry) -> VaultEntryPublic:
    return VaultEntryPublic(
        id=e.id, service_id=e.service_id, title=e.title, username=e.username, url=e.url,
        has_secret=bool(e.secret_enc), has_notes=bool(e.notes_enc),
        updated_at=e.updated_at, updated_by=e.updated_by,
    )


def _audit(session: Session, entry: VaultEntry, user: User, action: str):
    session.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=user.username, action=action))


def _get(session: Session, entry_id: int) -> VaultEntry:
    entry = session.get(VaultEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Vault entry not found")
    return entry


@router.get("/status")
def vault_status():
    reason = vault.lock_reason()
    return {"locked": reason is not None, "reason": reason, "key_source": vault.key_source()}


@router.get("/", response_model=list[VaultEntryPublic], dependencies=unlocked)
def list_entries(session: Session = Depends(get_session)):
    return [_public(e) for e in session.exec(select(VaultEntry).order_by(VaultEntry.title)).all()]


@router.post("/", response_model=VaultEntryPublic, dependencies=unlocked)
def create_entry(data: VaultEntryIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    entry = VaultEntry(
        service_id=data.service_id, title=data.title, username=data.username, url=data.url,
        secret_enc=vault.encrypt(data.secret) if data.secret else "",
        notes_enc=vault.encrypt(data.notes) if data.notes else None,
        updated_by=user.username,
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    _audit(session, entry, user, "create")
    session.commit()
    return _public(entry)


@router.patch("/{entry_id}", response_model=VaultEntryPublic, dependencies=unlocked)
def update_entry(entry_id: int, data: VaultEntryIn, user: User = Depends(require_admin),
                 session: Session = Depends(get_session)):
    entry = _get(session, entry_id)
    entry.service_id = data.service_id
    entry.title = data.title
    entry.username = data.username
    entry.url = data.url
    if data.secret is not None:
        entry.secret_enc = vault.encrypt(data.secret) if data.secret else ""
    if data.notes is not None:
        entry.notes_enc = vault.encrypt(data.notes) if data.notes else None
    entry.updated_at = datetime.utcnow()
    entry.updated_by = user.username
    session.add(entry)
    _audit(session, entry, user, "update")
    session.commit()
    session.refresh(entry)
    return _public(entry)


@router.delete("/{entry_id}", dependencies=unlocked)
def delete_entry(entry_id: int, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    entry = _get(session, entry_id)
    from ..models.backup import BackupDestination
    from ..services import backup_storage
    users = [d.name for d in session.exec(select(BackupDestination)).all()
             if backup_storage.dest_config(d).get("credential_id") == entry_id]
    if users:
        raise HTTPException(status_code=409, detail=f"Backup destination {', '.join(users)} uses this entry — "
                                                    "point it at another credential first")
    _audit(session, entry, user, "delete")
    session.delete(entry)
    session.commit()
    return {"ok": True}


@router.post("/{entry_id}/reveal", dependencies=unlocked)
def reveal_entry(entry_id: int, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    """POST (not GET) so secrets never land in proxy logs, caches or browser history."""
    entry = _get(session, entry_id)
    result = {"secret": vault.decrypt(entry.secret_enc), "notes": vault.decrypt(entry.notes_enc or "")}
    _audit(session, entry, user, "reveal")
    session.commit()
    return result


@router.get("/audit", response_model=list[VaultAudit], dependencies=unlocked)
def audit_log(limit: int = 100, session: Session = Depends(get_session)):
    return session.exec(select(VaultAudit).order_by(VaultAudit.at.desc()).limit(min(limit, 1000))).all()

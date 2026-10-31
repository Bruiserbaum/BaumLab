"""Recovery kits (Backups → Recovery kits) and the recovery passphrase that encrypts their secrets."""
import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.backup import BackupDestination, RecoveryKit
from ..models.portainer import ContainerSnapshot
from ..models.user import User
from ..models.vault import VaultAudit
from ..services import backup_engine, backup_schedule, recovery_crypto, recovery_kits
from ..services.auth import require_admin
from ..services.config_service import read_config

router = APIRouter(prefix="/api/backups", tags=["recovery-kits"], dependencies=[Depends(require_admin)])

_ARCHIVE = re.compile(r"^kit_[^/\\]+\.tar\.gz$")
_STACK_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")     # what compose accepts as a project name


def _get(session: Session, model, item_id: int, what: str):
    item = session.get(model, item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return item


def _check_connection(name: str):
    if not any(c.get("name") == name for c in read_config().get("portainer", {}).get("connections", [])):
        raise HTTPException(status_code=422, detail=f"Portainer connection '{name}' not found")


# ── Recovery passphrase ────────────────────────────────────────────────────────

class PassphraseIn(BaseModel):
    passphrase: str


@router.get("/passphrase")
def passphrase_status():
    return recovery_crypto.status()


@router.put("/passphrase")
def set_passphrase(data: PassphraseIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    try:
        recovery_crypto.set_passphrase(data.passphrase)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    session.add(VaultAudit(entry_title="Recovery kit passphrase", actor=user.username, action="update"))
    session.commit()
    return recovery_crypto.status()


# ── Where kits can come from ───────────────────────────────────────────────────

@router.get("/kits/sources")
def sources(session: Session = Depends(get_session)):
    """Portainer connections and their environments (as seen by the Docker page's polling)."""
    envs: dict[str, dict] = {}
    for snap in session.exec(select(ContainerSnapshot)).all():
        envs.setdefault(snap.connection_name, {})[snap.endpoint_id] = snap.endpoint_name or f"Environment {snap.endpoint_id}"
    return [{"connection": c["name"],
             "endpoints": [{"id": i, "name": n} for i, n in sorted(envs.get(c["name"], {}).items())]}
            for c in read_config().get("portainer", {}).get("connections", [])]


@router.get("/kits/discover")
def discover(connection: str, endpoint_id: int):
    _check_connection(connection)
    try:
        return recovery_kits.describe(connection, endpoint_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Portainer: {e}")


# ── Kits ───────────────────────────────────────────────────────────────────────

class KitIn(BaseModel):
    name: str
    connection: str
    endpoint_id: int
    endpoint_name: str = ""
    project: Optional[str] = None
    containers: list[str] = []
    exclude_mounts: list[str] = []
    dump_databases: bool = True
    stop_during_backup: bool = False
    cold_copy_fallback: bool = True
    destination_id: int
    schedule_cron: Optional[str] = "30 3 * * *"
    retention_days: int = 30
    enabled: bool = True
    service_ids: list[int] = []


def _kit_dict(k: RecoveryKit) -> dict:
    return {
        "id": k.id, "name": k.name, "connection": k.connection, "endpoint_id": k.endpoint_id,
        "endpoint_name": k.endpoint_name, "project": k.project, "containers": json.loads(k.containers or "[]"),
        "exclude_mounts": json.loads(k.exclude_mounts or "[]"), "dump_databases": k.dump_databases,
        "stop_during_backup": k.stop_during_backup, "cold_copy_fallback": k.cold_copy_fallback,
        "last_verified_at": k.last_verified_at, "last_verify_status": k.last_verify_status,
        "last_verify_message": k.last_verify_message, "destination_id": k.destination_id,
        "schedule_cron": k.schedule_cron, "retention_days": k.retention_days, "enabled": k.enabled,
        "service_ids": json.loads(k.service_ids or "[]"), "last_run_at": k.last_run_at,
        "last_run_status": k.last_run_status, "last_success_at": k.last_success_at,
        "next_run": backup_schedule.next_run("kit", k.id), "running": backup_engine.is_running("kit", k.id),
        "freshness": backup_schedule.freshness(k.enabled, k.schedule_cron, k.last_run_status, k.last_success_at),
    }


def _apply(k: RecoveryKit, data: KitIn, session: Session):
    _check_connection(data.connection)
    _get(session, BackupDestination, data.destination_id, "Destination")
    if data.schedule_cron:
        try:
            backup_schedule.parse_cron(data.schedule_cron)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
    if not data.project and not data.containers:
        raise HTTPException(status_code=422, detail="Pick a stack or at least one container")
    k.name, k.connection, k.endpoint_id, k.endpoint_name = data.name.strip(), data.connection, data.endpoint_id, data.endpoint_name
    k.project = data.project or None
    k.containers = json.dumps([] if data.project else data.containers)
    k.exclude_mounts, k.dump_databases = json.dumps(data.exclude_mounts), data.dump_databases
    k.stop_during_backup, k.destination_id = data.stop_during_backup, data.destination_id
    k.cold_copy_fallback = data.cold_copy_fallback
    k.schedule_cron, k.retention_days, k.enabled = data.schedule_cron or None, data.retention_days, data.enabled
    k.service_ids = json.dumps(data.service_ids)


@router.get("/kits")
def list_kits(session: Session = Depends(get_session)):
    return [_kit_dict(k) for k in session.exec(select(RecoveryKit).order_by(RecoveryKit.name)).all()]


@router.post("/kits")
def create_kit(data: KitIn, session: Session = Depends(get_session)):
    k = RecoveryKit(name=data.name, connection=data.connection, endpoint_id=data.endpoint_id,
                    destination_id=data.destination_id)
    _apply(k, data, session)
    session.add(k)
    session.commit()
    session.refresh(k)
    backup_schedule.schedule_kit(k)
    return _kit_dict(k)


@router.put("/kits/{kit_id}")
def update_kit(kit_id: int, data: KitIn, session: Session = Depends(get_session)):
    k = _get(session, RecoveryKit, kit_id, "Recovery kit")
    _apply(k, data, session)
    session.add(k)
    session.commit()
    session.refresh(k)
    backup_schedule.schedule_kit(k)
    return _kit_dict(k)


@router.delete("/kits/{kit_id}")
def delete_kit(kit_id: int, session: Session = Depends(get_session)):
    k = _get(session, RecoveryKit, kit_id, "Recovery kit")
    backup_schedule.unschedule("kit", kit_id)
    session.delete(k)
    session.commit()
    return {"ok": True}


@router.post("/kits/{kit_id}/run")
def run_kit(kit_id: int, session: Session = Depends(get_session)):
    _get(session, RecoveryKit, kit_id, "Recovery kit")
    if backup_engine.is_running("kit", kit_id):
        raise HTTPException(status_code=409, detail="This kit is already running")
    if not recovery_crypto.status()["set"]:
        raise HTTPException(status_code=422, detail="Set a recovery passphrase first")
    backup_schedule.run_now(recovery_kits.run_kit_backup, kit_id)
    return {"status": "started"}


@router.post("/kits/{kit_id}/verify")
def verify_kit(kit_id: int, session: Session = Depends(get_session)):
    """Download the newest kit and check it end to end (nothing on any host is touched)."""
    _get(session, RecoveryKit, kit_id, "Recovery kit")
    if backup_engine.is_running("kit", kit_id):
        raise HTTPException(status_code=409, detail="This kit is busy")
    backup_schedule.run_now(recovery_kits.run_kit_verify, kit_id)
    return {"status": "started"}


@router.get("/kits/{kit_id}/archives")
def kit_archives(kit_id: int, session: Session = Depends(get_session)):
    k = _get(session, RecoveryKit, kit_id, "Recovery kit")
    try:
        return recovery_kits.list_kit_archives(k, _get(session, BackupDestination, k.destination_id, "Destination"))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


class KitRestoreIn(BaseModel):
    filename: str
    connection: str
    endpoint_id: int
    stack_name: str
    restore_data: bool = True
    deploy: bool = True
    import_databases: bool = False
    replace_existing: bool = False
    passphrase: Optional[str] = None           # only needed if the kit was sealed with an older passphrase


@router.post("/kits/{kit_id}/restore")
def restore_kit(kit_id: int, data: KitRestoreIn, session: Session = Depends(get_session)):
    _get(session, RecoveryKit, kit_id, "Recovery kit")
    if not _ARCHIVE.match(data.filename):
        raise HTTPException(status_code=422, detail="Invalid archive name")
    if not _STACK_NAME.match(data.stack_name):
        raise HTTPException(status_code=422, detail="Stack name: lowercase letters, digits, - and _ only")
    _check_connection(data.connection)
    if backup_engine.is_running("kit", kit_id):
        raise HTTPException(status_code=409, detail="This kit is busy")
    backup_schedule.run_now(recovery_kits.run_kit_restore, kit_id, data.filename, data.connection, data.endpoint_id,
                            data.stack_name, data.restore_data, data.deploy, data.import_databases,
                            data.replace_existing, data.passphrase)
    return {"status": "started"}

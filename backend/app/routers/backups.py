import json
import re
import subprocess
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from ..database import get_session
from ..models.backup import BackupDestination, BackupJob, BackupRecord, BackupRun, BackupStack, RecoveryKit
from ..models.service import Service
from ..models.user import User
from ..models.vault import VaultAudit
from ..services import backup_docker as dk
from ..services import backup_engine, backup_import, backup_schedule
from ..services import backup_storage as st
from ..services.auth import get_current_user, require_admin
from ..services.config_service import encrypt

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(get_current_user)])
admin = [Depends(require_admin)]

_IDENT = re.compile(r"^[A-Za-z0-9_.@-]+$")      # db / user / container names
_ARCHIVE = re.compile(r"^[^/\\]+\.tar\.gz$")      # archive file names — no paths


def _ident(v: Optional[str]) -> Optional[str]:
    if v and not _IDENT.match(v):
        raise ValueError("only letters, digits and . _ @ - are allowed")
    return v or None


def _docker_call(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Docker: {e}")


def _get(session: Session, model, item_id: int, what: str):
    item = session.get(model, item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return item


def _check_cron(cron: Optional[str]):
    if cron:
        try:
            backup_schedule.parse_cron(cron)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))


# ── Status / overview ──────────────────────────────────────────────────────────

@router.get("/status", dependencies=admin)
def status():
    try:
        rclone = subprocess.run(["rclone", "version"], capture_output=True, text=True, timeout=10).stdout.split("\n")[0]
    except Exception:
        rclone = None
    return {**dk.status(), "rclone": rclone}


@router.get("/coverage")
def coverage():
    """Per-service backup status — readable by any user (shown on the Services page)."""
    return backup_schedule.coverage()


@router.get("/overview", dependencies=admin)
def overview(session: Session = Depends(get_session)):
    cov = backup_schedule.coverage()
    services = session.exec(select(Service).where(Service.status != "decommissioned").order_by(Service.name)).all()
    runs = session.exec(select(BackupRun).order_by(BackupRun.started_at.desc()).limit(15)).all()
    return {
        "services": [{"id": s.id, "name": s.name, "host": s.host, "category": s.category,
                      **cov.get(s.id, {"status": "none", "sources": []})} for s in services],
        "recent_runs": [_run_dict(r) for r in runs],
    }


# ── Destinations ───────────────────────────────────────────────────────────────

class DestinationIn(BaseModel):
    name: str
    type: Literal["b2", "smb", "sftp", "local"]
    config: dict


def _dest_dict(d: BackupDestination, session: Session) -> dict:
    used = len(session.exec(select(BackupJob).where(BackupJob.destination_id == d.id)).all()) + \
           len(session.exec(select(BackupStack).where(BackupStack.destination_id == d.id)).all()) + \
           len(session.exec(select(RecoveryKit).where(RecoveryKit.destination_id == d.id)).all())
    return {"id": d.id, "name": d.name, "type": d.type, "config": st.redact(st.dest_config(d)), "used_by": used}


@router.get("/destinations", dependencies=admin)
def list_destinations(session: Session = Depends(get_session)):
    return [_dest_dict(d, session) for d in session.exec(select(BackupDestination).order_by(BackupDestination.name)).all()]


@router.post("/destinations", dependencies=admin)
def create_destination(data: DestinationIn, session: Session = Depends(get_session)):
    d = BackupDestination(name=data.name, type=data.type, config_enc=encrypt(json.dumps(data.config)))
    session.add(d)
    session.commit()
    session.refresh(d)
    return _dest_dict(d, session)


@router.put("/destinations/{dest_id}", dependencies=admin)
def update_destination(dest_id: int, data: DestinationIn, session: Session = Depends(get_session)):
    d = _get(session, BackupDestination, dest_id, "Destination")
    old = st.dest_config(d)
    merged = dict(data.config)
    for field in st.SECRET_FIELDS:                       # masked / blank secret = keep the stored one
        if merged.get(field) in (None, "", "••••••••"):
            merged[field] = old.get(field, "")
    d.name, d.type, d.config_enc = data.name, data.type, encrypt(json.dumps(merged))
    session.add(d)
    session.commit()
    return _dest_dict(d, session)


@router.delete("/destinations/{dest_id}", dependencies=admin)
def delete_destination(dest_id: int, session: Session = Depends(get_session)):
    d = _get(session, BackupDestination, dest_id, "Destination")
    if _dest_dict(d, session)["used_by"]:
        raise HTTPException(status_code=409, detail="Destination is used by backup jobs, stacks or recovery kits")
    session.delete(d)
    session.commit()
    return {"ok": True}


@router.post("/destinations/{dest_id}/test", dependencies=admin)
def test_destination(dest_id: int, session: Session = Depends(get_session)):
    ok, message = st.test(_get(session, BackupDestination, dest_id, "Destination"))
    return {"ok": ok, "message": message}


# ── Docker inventory ───────────────────────────────────────────────────────────

@router.get("/docker/containers", dependencies=admin)
def docker_containers():
    return _docker_call(dk.list_containers)


@router.get("/docker/stacks", dependencies=admin)
def docker_stacks():
    return _docker_call(dk.detect_compose_stacks)


# ── Jobs ───────────────────────────────────────────────────────────────────────

class MountIn(BaseModel):
    type: Literal["volume", "bind"] = "volume"
    source: str
    name: Optional[str] = None


class JobIn(BaseModel):
    name: str
    containers: list[str] = []
    volumes: list[MountIn] = []
    db_type: Optional[Literal["mysql", "postgres"]] = None
    db_container: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    db_password: Optional[str] = None       # update: None / "" = keep existing
    destination_id: int
    schedule_cron: str = "0 3 * * *"
    pre_stop: bool = False
    retention_days: int = 30
    enabled: bool = True
    service_ids: list[int] = []

    @field_validator("db_container", "db_name", "db_user")
    @classmethod
    def check_identifier(cls, v):
        return _ident(v)


def _job_dict(j: BackupJob) -> dict:
    return {
        "id": j.id, "name": j.name, "containers": json.loads(j.containers or "[]"),
        "volumes": json.loads(j.volumes or "[]"), "db_type": j.db_type, "db_container": j.db_container,
        "db_name": j.db_name, "db_user": j.db_user, "has_db_password": bool(j.db_password_enc),
        "destination_id": j.destination_id, "schedule_cron": j.schedule_cron, "pre_stop": j.pre_stop,
        "retention_days": j.retention_days, "enabled": j.enabled, "service_ids": json.loads(j.service_ids or "[]"),
        "last_run_at": j.last_run_at, "last_run_status": j.last_run_status, "last_success_at": j.last_success_at,
        "next_run": backup_schedule.next_run("job", j.id), "running": backup_engine.is_running("job", j.id),
        "freshness": backup_schedule.freshness(j.enabled, j.schedule_cron, j.last_run_status, j.last_success_at),
    }


def _apply_job(j: BackupJob, data: JobIn, session: Session):
    _get(session, BackupDestination, data.destination_id, "Destination")
    _check_cron(data.schedule_cron)
    j.name, j.containers = data.name, json.dumps(data.containers)
    j.volumes = json.dumps([m.model_dump() for m in data.volumes])
    j.db_type, j.db_container, j.db_name, j.db_user = data.db_type, data.db_container, data.db_name, data.db_user
    if data.db_password:
        j.db_password_enc = encrypt(data.db_password)
    if not data.db_type:
        j.db_password_enc = None
    j.destination_id, j.schedule_cron, j.pre_stop = data.destination_id, data.schedule_cron, data.pre_stop
    j.retention_days, j.enabled, j.service_ids = data.retention_days, data.enabled, json.dumps(data.service_ids)


@router.get("/jobs", dependencies=admin)
def list_jobs(session: Session = Depends(get_session)):
    return [_job_dict(j) for j in session.exec(select(BackupJob).order_by(BackupJob.name)).all()]


@router.post("/jobs", dependencies=admin)
def create_job(data: JobIn, session: Session = Depends(get_session)):
    j = BackupJob(name=data.name, destination_id=data.destination_id)
    _apply_job(j, data, session)
    session.add(j)
    session.commit()
    session.refresh(j)
    backup_schedule.schedule_job(j)
    return _job_dict(j)


@router.put("/jobs/{job_id}", dependencies=admin)
def update_job(job_id: int, data: JobIn, session: Session = Depends(get_session)):
    j = _get(session, BackupJob, job_id, "Job")
    _apply_job(j, data, session)
    session.add(j)
    session.commit()
    session.refresh(j)
    backup_schedule.schedule_job(j)
    return _job_dict(j)


@router.delete("/jobs/{job_id}", dependencies=admin)
def delete_job(job_id: int, session: Session = Depends(get_session)):
    j = _get(session, BackupJob, job_id, "Job")
    backup_schedule.unschedule("job", job_id)
    session.delete(j)
    session.commit()
    return {"ok": True}


@router.post("/jobs/{job_id}/run", dependencies=admin)
def run_job(job_id: int, session: Session = Depends(get_session)):
    _get(session, BackupJob, job_id, "Job")
    if backup_engine.is_running("job", job_id):
        raise HTTPException(status_code=409, detail="This job is already running")
    backup_schedule.run_now(backup_engine.run_job_backup, job_id)
    return {"status": "started"}


def _job_archives(j: BackupJob, dest: BackupDestination) -> list[dict]:
    prefix = dk.safe_name(j.name) + "_"
    stamp = re.compile(r"^\d{8}_\d{6}\.tar\.gz$")
    try:
        items = st.list_archives(dest)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Listing {dest.name} failed: {e}")
    # Match old space-named BaumLabBackup archives too, but not other jobs sharing a prefix
    return [i for i in items if dk.safe_name(i["name"]).startswith(prefix)
            and stamp.match(dk.safe_name(i["name"])[len(prefix):])]


@router.get("/jobs/{job_id}/archives", dependencies=admin)
def job_archives(job_id: int, session: Session = Depends(get_session)):
    j = _get(session, BackupJob, job_id, "Job")
    return _job_archives(j, _get(session, BackupDestination, j.destination_id, "Destination"))


class JobRestoreIn(BaseModel):
    filename: str
    restore_mounts: bool = True
    restore_db: bool = True
    start_after: Optional[list[str]] = None    # default: the job's containers


@router.post("/jobs/{job_id}/restore", dependencies=admin)
def restore_job(job_id: int, data: JobRestoreIn, session: Session = Depends(get_session)):
    j = _get(session, BackupJob, job_id, "Job")
    if not _ARCHIVE.match(data.filename):
        raise HTTPException(status_code=422, detail="Invalid archive name")
    if backup_engine.is_running("job", job_id):
        raise HTTPException(status_code=409, detail="This job is busy")
    start = data.start_after if data.start_after is not None else json.loads(j.containers or "[]")
    backup_schedule.run_now(backup_engine.run_job_restore, job_id, data.filename, data.restore_mounts,
                            data.restore_db, start)
    return {"status": "started"}


# ── Stacks ─────────────────────────────────────────────────────────────────────

class StackIn(BaseModel):
    name: str
    repo_url: str = ""
    repo_branch: str = "main"
    env_path: str = ""
    compose_project: str
    volumes: list[str] = []
    destination_id: int
    schedule_cron: Optional[str] = None
    retention_days: int = 30
    enabled: bool = True
    service_ids: list[int] = []


def _stack_dict(s: BackupStack) -> dict:
    return {
        "id": s.id, "name": s.name, "repo_url": s.repo_url, "repo_branch": s.repo_branch, "env_path": s.env_path,
        "compose_project": s.compose_project, "volumes": json.loads(s.volumes or "[]"),
        "destination_id": s.destination_id, "schedule_cron": s.schedule_cron, "retention_days": s.retention_days,
        "enabled": s.enabled, "service_ids": json.loads(s.service_ids or "[]"),
        "last_run_at": s.last_run_at, "last_run_status": s.last_run_status, "last_success_at": s.last_success_at,
        "next_run": backup_schedule.next_run("stack", s.id), "running": backup_engine.is_running("stack", s.id),
        "freshness": backup_schedule.freshness(s.enabled, s.schedule_cron, s.last_run_status, s.last_success_at),
    }


def _apply_stack(s: BackupStack, data: StackIn, session: Session):
    _get(session, BackupDestination, data.destination_id, "Destination")
    _check_cron(data.schedule_cron)
    s.name, s.repo_url, s.repo_branch, s.env_path = data.name, data.repo_url, data.repo_branch, data.env_path
    s.compose_project, s.volumes, s.destination_id = data.compose_project, json.dumps(data.volumes), data.destination_id
    s.schedule_cron, s.retention_days, s.enabled = data.schedule_cron or None, data.retention_days, data.enabled
    s.service_ids = json.dumps(data.service_ids)


@router.get("/stacks", dependencies=admin)
def list_stacks(session: Session = Depends(get_session)):
    return [_stack_dict(s) for s in session.exec(select(BackupStack).order_by(BackupStack.name)).all()]


@router.post("/stacks", dependencies=admin)
def create_stack(data: StackIn, session: Session = Depends(get_session)):
    s = BackupStack(name=data.name, compose_project=data.compose_project, destination_id=data.destination_id)
    _apply_stack(s, data, session)
    session.add(s)
    session.commit()
    session.refresh(s)
    backup_schedule.schedule_stack(s)
    return _stack_dict(s)


@router.put("/stacks/{stack_id}", dependencies=admin)
def update_stack(stack_id: int, data: StackIn, session: Session = Depends(get_session)):
    s = _get(session, BackupStack, stack_id, "Stack")
    _apply_stack(s, data, session)
    session.add(s)
    session.commit()
    session.refresh(s)
    backup_schedule.schedule_stack(s)
    return _stack_dict(s)


@router.delete("/stacks/{stack_id}", dependencies=admin)
def delete_stack(stack_id: int, session: Session = Depends(get_session)):
    s = _get(session, BackupStack, stack_id, "Stack")
    backup_schedule.unschedule("stack", stack_id)
    session.delete(s)
    session.commit()
    return {"ok": True}


@router.post("/stacks/{stack_id}/run", dependencies=admin)
def run_stack(stack_id: int, session: Session = Depends(get_session)):
    _get(session, BackupStack, stack_id, "Stack")
    if backup_engine.is_running("stack", stack_id):
        raise HTTPException(status_code=409, detail="This stack is already being backed up")
    backup_schedule.run_now(backup_engine.run_stack_backup, stack_id)
    return {"status": "started"}


@router.get("/stacks/{stack_id}/archives", dependencies=admin)
def stack_archives(stack_id: int, session: Session = Depends(get_session)):
    s = _get(session, BackupStack, stack_id, "Stack")
    dest = _get(session, BackupDestination, s.destination_id, "Destination")
    try:
        return st.list_archives(dest, backup_engine.stack_dir(s))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"Listing {dest.name} failed: {e}")


class ArchiveIn(BaseModel):
    filename: str


@router.post("/stacks/{stack_id}/restore", dependencies=admin)
def restore_stack(stack_id: int, data: ArchiveIn, session: Session = Depends(get_session)):
    _get(session, BackupStack, stack_id, "Stack")
    if not _ARCHIVE.match(data.filename):
        raise HTTPException(status_code=422, detail="Invalid archive name")
    backup_schedule.run_now(backup_engine.run_stack_restore, stack_id, data.filename)
    return {"status": "started"}


@router.post("/stacks/{stack_id}/env")
def stack_env(stack_id: int, data: ArchiveIn, user: User = Depends(require_admin),
              session: Session = Depends(get_session)):
    """Decrypted .env from a stack archive, for redeploying in Portainer. Logged in the vault audit."""
    s = _get(session, BackupStack, stack_id, "Stack")
    if not _ARCHIVE.match(data.filename):
        raise HTTPException(status_code=422, detail="Invalid archive name")
    try:
        result = backup_engine.read_stack_env(s, _get(session, BackupDestination, s.destination_id, "Destination"),
                                              data.filename)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    session.add(VaultAudit(entry_title=f"Stack .env: {s.name} ({data.filename})", actor=user.username, action="reveal"))
    session.commit()
    return result


# ── Runs ───────────────────────────────────────────────────────────────────────

def _run_dict(r: BackupRun) -> dict:
    return {"id": r.id, "kind": r.kind, "target_id": r.target_id, "name": r.target_name, "run_type": r.run_type,
            "status": r.status, "started_at": r.started_at, "completed_at": r.completed_at,
            "size_bytes": r.size_bytes, "archive_path": r.archive_path, "error": r.error}


@router.get("/runs", dependencies=admin)
def list_runs(limit: int = 50, kind: Optional[str] = None, target_id: Optional[int] = None,
              session: Session = Depends(get_session)):
    q = select(BackupRun).order_by(BackupRun.started_at.desc()).limit(min(limit, 500))
    if kind:
        q = q.where(BackupRun.kind == kind)
    if target_id is not None:
        q = q.where(BackupRun.target_id == target_id)
    return [_run_dict(r) for r in session.exec(q).all()]


@router.get("/runs/{run_id}", dependencies=admin)
def get_run(run_id: int, session: Session = Depends(get_session)):
    r = _get(session, BackupRun, run_id, "Run")
    return {**_run_dict(r), "log_lines": json.loads(r.log_lines or "[]")}


# ── Manual backup records ──────────────────────────────────────────────────────

class RecordIn(BaseModel):
    service_id: int
    method: str
    location: Optional[str] = None
    frequency_days: int = 7
    notes: Optional[str] = None


@router.get("/records", dependencies=admin)
def list_records(session: Session = Depends(get_session)):
    return session.exec(select(BackupRecord).order_by(BackupRecord.service_id)).all()


@router.post("/records", dependencies=admin)
def create_record(data: RecordIn, session: Session = Depends(get_session)):
    _get(session, Service, data.service_id, "Service")
    rec = BackupRecord(**data.model_dump())
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


@router.put("/records/{record_id}", dependencies=admin)
def update_record(record_id: int, data: RecordIn, session: Session = Depends(get_session)):
    rec = _get(session, BackupRecord, record_id, "Record")
    for k, v in data.model_dump().items():
        setattr(rec, k, v)
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


@router.post("/records/{record_id}/verify", dependencies=admin)
def verify_record(record_id: int, session: Session = Depends(get_session)):
    """Mark a manual backup as checked just now."""
    rec = _get(session, BackupRecord, record_id, "Record")
    rec.last_verified_at = datetime.utcnow()
    session.add(rec)
    session.commit()
    session.refresh(rec)
    return rec


@router.delete("/records/{record_id}", dependencies=admin)
def delete_record(record_id: int, session: Session = Depends(get_session)):
    session.delete(_get(session, BackupRecord, record_id, "Record"))
    session.commit()
    return {"ok": True}


# ── Import from BaumLabBackup ──────────────────────────────────────────────────

@router.post("/import", dependencies=admin)
async def import_baumlabbackup(file: UploadFile = File(...), secret_key: str = Form(...)):
    data = await file.read()
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Database file too large")
    try:
        result = backup_import.import_legacy(data, secret_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result

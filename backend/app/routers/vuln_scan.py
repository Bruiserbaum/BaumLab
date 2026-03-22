from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select
from typing import Optional

from ..database import get_session
from ..models.vuln_schedule import ScheduledVulnScan
from ..services.auth import get_current_user, require_admin
from ..services.openvas import OpenVasService
from ..services.config_service import read_config, decrypt

router = APIRouter(
    prefix="/api/vuln-scan",
    tags=["vuln-scan"],
    dependencies=[Depends(get_current_user)],
)


def _get_service() -> OpenVasService:
    cfg = read_config().get("openvas", {})
    if not cfg.get("username"):
        raise HTTPException(status_code=503, detail="OpenVAS not configured")
    return OpenVasService(
        username=cfg.get("username", "admin"),
        password=decrypt(cfg.get("password", "")),
        socket_path=cfg.get("socket_path", "/var/run/gvmd/gvmd.sock"),
        host=cfg.get("host") or None,
        port=int(cfg.get("port", 9390)),
    )


@router.get("/health")
def health():
    try:
        svc = _get_service()
    except HTTPException:
        return {"connected": False, "error": "OpenVAS not configured"}
    return svc.check_connection()


@router.get("/configs")
def get_configs():
    return _get_service().get_scan_configs()


@router.get("/tasks")
def get_tasks():
    return _get_service().get_tasks()


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    task = _get_service().get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/tasks/{task_id}/results")
def get_results(task_id: str):
    svc  = _get_service()
    task = svc.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not task.get("report_id"):
        return []
    return svc.get_results(task["report_id"])


class StartRequest(BaseModel):
    target: str
    scan_config_id: str
    name: Optional[str] = None


@router.post("/start")
def start_scan(req: StartRequest):
    return _get_service().create_and_start(
        host_target=req.target.strip(),
        scan_config_id=req.scan_config_id,
        task_name=req.name,
    )


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str):
    _get_service().delete_task(task_id)
    return {"status": "deleted"}


# ── Scheduled scans ───────────────────────────────────────────────────────────

class ScheduleRequest(BaseModel):
    name: str
    target: str
    scan_config_id: str
    frequency: str  # "weekly" or "monthly"
    enabled: bool = True


@router.get("/schedules")
def list_schedules(session: Session = Depends(get_session)):
    return session.exec(select(ScheduledVulnScan).order_by(ScheduledVulnScan.name)).all()


@router.post("/schedules", dependencies=[Depends(require_admin)])
def create_schedule(req: ScheduleRequest, session: Session = Depends(get_session)):
    if req.frequency not in ("weekly", "monthly"):
        raise HTTPException(status_code=400, detail="frequency must be 'weekly' or 'monthly'")
    sched = ScheduledVulnScan(**req.dict())
    session.add(sched)
    session.commit()
    session.refresh(sched)
    return sched


@router.patch("/schedules/{sched_id}/toggle", dependencies=[Depends(require_admin)])
def toggle_schedule(sched_id: int, session: Session = Depends(get_session)):
    sched = session.get(ScheduledVulnScan, sched_id)
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    sched.enabled = not sched.enabled
    session.add(sched)
    session.commit()
    session.refresh(sched)
    return sched


@router.delete("/schedules/{sched_id}", dependencies=[Depends(require_admin)])
def delete_schedule(sched_id: int, session: Session = Depends(get_session)):
    sched = session.get(ScheduledVulnScan, sched_id)
    if not sched:
        raise HTTPException(status_code=404, detail="Schedule not found")
    session.delete(sched)
    session.commit()
    return {"status": "deleted"}

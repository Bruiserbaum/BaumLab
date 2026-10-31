import os
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


def _diagnose_container(host: str) -> Optional[str]:
    """When the OpenVAS host name doesn't resolve, use the Docker socket to say why."""
    import socket as pysocket
    try:
        import docker
        client = docker.from_env(timeout=10)
        me = client.containers.get(pysocket.gethostname())   # container hostname = its short id
    except Exception:
        return None
    my_nets = set((me.attrs.get("NetworkSettings", {}).get("Networks") or {}).keys())
    candidates = [c for c in client.containers.list(all=True)
                  if "openvas" in c.name.lower() or "openvas" in (c.attrs.get("Config", {}).get("Image") or "").lower()]
    if not candidates:
        return "No OpenVAS container exists on this Docker host — redeploy the stack, or set Host to where OpenVAS runs."
    c = candidates[0]
    if c.status != "running":
        return (f"Container {c.name} is {c.status}. Start it (docker start {c.name}) and check "
                f"docker logs {c.name} if it keeps stopping.")
    nets = c.attrs.get("NetworkSettings", {}).get("Networks") or {}
    shared = my_nets & set(nets)
    if not shared:
        return (f"{c.name} is running but on network(s) {', '.join(nets) or 'none'}, while BaumLab is on "
                f"{', '.join(sorted(my_nets))}. Fix: docker network connect {sorted(my_nets)[0]} {c.name}")
    names = set(nets[next(iter(shared))].get("Aliases") or []) | set(nets[next(iter(shared))].get("DNSNames") or [])
    if host not in names and c.name != host:
        return f"{c.name} is reachable but not as '{host}' — set Host to {c.name}."
    return None


@router.get("/health")
def health():
    try:
        svc = _get_service()
    except HTTPException:
        return {"connected": False, "error": "OpenVAS not configured"}
    result = svc.check_connection()
    if result.get("connected"):
        return result
    err = str(result.get("error", "")).lower()
    if svc.host and "name resolution" in err:
        hint = _diagnose_container(svc.host)
        if hint:
            result["error"] = f"Can't find '{svc.host}' — {hint}"
    elif svc.host and "refused" in err and os.path.exists(svc.socket_path):
        # The bundled immauss container only serves GMP on its Unix socket
        result["error"] = (f"Nothing is listening on {svc.host}:{svc.port}. The bundled OpenVAS container only "
                           f"accepts the Unix socket — clear the Host field and keep Socket Path {svc.socket_path}.")
    elif not svc.host and ("no such file" in err or "refused" in err):
        result["error"] = (f"gvmd hasn't opened {svc.socket_path} yet. It appears once the first feed import "
                           f"finishes — watch for 'ready to accept GMP connections' in docker logs baumlab-openvas.")
    return result


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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..services.auth import get_current_user
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

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel
from datetime import datetime, timezone
from ..services.auth import get_current_user
from ..services.scanner import advanced_scan as _run_advanced_scan

router = APIRouter(
    prefix="/api/advanced-scan",
    tags=["advanced-scan"],
    dependencies=[Depends(get_current_user)],
)

# Common port presets
PRESETS = {
    "common":   "21,22,23,25,53,80,110,111,135,139,143,389,443,445,587,636,993,995,1433,1521,2049,3306,3389,5432,5900,6379,8080,8443,8888,9200,27017",
    "top-100":  "1-100,110,135,139,143,389,443,445,587,636,993,995,1433,1521,3306,3389,5432,5900,6379,8080,8443,9200",
    "top-1000": "1-1024,1433,1521,2049,3306,3389,5432,5900,6379,8080,8443,8888,9200,27017",
}

_state: dict = {
    "running":     False,
    "target":      "",
    "ports":       "",
    "result":      None,
    "started_at":  None,
    "finished_at": None,
    "error":       None,
}


class ScanRequest(BaseModel):
    target: str
    ports:  str = PRESETS["common"]


def _do_scan(target: str, ports: str):
    _state.update({
        "running":     True,
        "target":      target,
        "ports":       ports,
        "result":      None,
        "started_at":  datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "error":       None,
    })
    try:
        result = _run_advanced_scan(target, ports)
        _state["result"] = result
        _state["error"]  = result.get("error")
    except Exception as exc:
        _state["error"]  = str(exc)
    finally:
        _state["running"]     = False
        _state["finished_at"] = datetime.now(timezone.utc).isoformat()


@router.get("/presets")
def get_presets():
    return PRESETS


@router.post("/start")
def start_scan(req: ScanRequest, background_tasks: BackgroundTasks):
    if _state["running"]:
        return {"status": "already_running", "target": _state["target"]}
    background_tasks.add_task(_do_scan, req.target.strip(), req.ports.strip())
    return {"status": "scan_started", "target": req.target}


@router.get("/status")
def scan_status():
    return _state

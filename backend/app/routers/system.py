import asyncio

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..services import integrity, log_collector
from ..services.auth import require_admin
from ..services.config_service import read_config, write_config
from ..services.syslog_listener import DEFAULT_LIMITS, DEFAULT_RETENTION_DAYS, limits, retention_days

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_admin)])


@router.get("/integrity")
async def get_integrity():
    results = integrity.last_results()
    if results["ran_at"] is None:
        await asyncio.to_thread(integrity.run_checks)
    return integrity.last_results()


@router.post("/integrity/run")
async def run_integrity():
    await asyncio.to_thread(integrity.run_checks)
    return integrity.last_results()


class LogSettingsIn(BaseModel):
    collect: bool = True
    containers: list[str] = []          # empty = BaumLab's own stack
    keep_access_logs: bool = False
    max_network: int = DEFAULT_LIMITS["network"]
    max_container: int = DEFAULT_LIMITS["container"]
    max_audit: int = DEFAULT_LIMITS["audit"]
    retention_days: int = DEFAULT_RETENTION_DAYS


@router.get("/logs")
def get_log_settings():
    return {**log_collector.settings(), **{f"max_{k}": v for k, v in limits().items()},
            "retention_days": retention_days(),
            "status": log_collector.status()}


@router.put("/logs")
def save_log_settings(data: LogSettingsIn):
    cfg = read_config()
    cfg["logs"] = {
        "collect": data.collect,
        "containers": sorted(set(c.strip() for c in data.containers if c.strip())),
        "keep_access_logs": data.keep_access_logs,
        "max_network": max(1000, data.max_network),
        "max_container": max(1000, data.max_container),
        "max_audit": max(1000, data.max_audit),
        "retention_days": min(365, max(1, data.retention_days)),
    }
    write_config(cfg)
    return get_log_settings()


@router.get("/containers")
def containers():
    """Running container names, for picking which logs to collect."""
    try:
        import docker
        return sorted(c.name for c in docker.from_env(timeout=10).containers.list())
    except Exception:
        return []

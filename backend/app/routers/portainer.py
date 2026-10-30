from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from pydantic import BaseModel
from typing import Optional
import asyncio

from ..database import get_session, engine
from ..models.portainer import ContainerSnapshot
from ..services.auth import get_current_user, require_admin
from ..services.config_service import read_config, write_config, encrypt, decrypt
from ..services.portainer_client import fetch_containers, upsert_containers, container_action, container_logs

router = APIRouter(prefix="/api/portainer", tags=["portainer"],
                   dependencies=[Depends(get_current_user)])

MASK = "••••••••"


class ConnectionIn(BaseModel):
    name: str
    url: str
    api_key: Optional[str] = None   # None or MASK = keep existing
    enabled: bool = True


# ── Connections (stored in config.yaml) ─────────────────────────────────────

@router.get("/connections", dependencies=[Depends(require_admin)])
def list_connections():
    connections = read_config().get("portainer", {}).get("connections", [])
    return [
        {
            "name": c.get("name", ""),
            "url": c.get("url", ""),
            "api_key": MASK if c.get("api_key") else "",
            "enabled": c.get("enabled", True),
        }
        for c in connections
    ]


@router.post("/connections", dependencies=[Depends(require_admin)])
def save_connection(payload: ConnectionIn):
    cfg = read_config()
    portainer = cfg.setdefault("portainer", {})
    connections: list = portainer.setdefault("connections", [])

    # Find existing entry with same name or append new
    existing = next((c for c in connections if c.get("name") == payload.name), None)
    if existing is None:
        existing = {}
        connections.append(existing)

    existing["name"] = payload.name
    existing["url"] = payload.url.rstrip("/")
    existing["enabled"] = payload.enabled
    if payload.api_key and payload.api_key != MASK:
        existing["api_key"] = encrypt(payload.api_key)

    write_config(cfg)
    return {"status": "saved"}


@router.delete("/connections/{name}", dependencies=[Depends(require_admin)])
def delete_connection(name: str):
    cfg = read_config()
    portainer = cfg.get("portainer", {})
    connections = portainer.get("connections", [])
    portainer["connections"] = [c for c in connections if c.get("name") != name]
    cfg["portainer"] = portainer
    write_config(cfg)
    return {"status": "deleted"}


# ── Container snapshots ──────────────────────────────────────────────────────

@router.get("/containers")
def list_containers(
    connection: Optional[str] = None,
    state: Optional[str] = None,
    search: Optional[str] = None,
    session: Session = Depends(get_session),
):
    q = select(ContainerSnapshot).order_by(
        ContainerSnapshot.connection_name,
        ContainerSnapshot.endpoint_name,
        ContainerSnapshot.name,
    )
    if connection:
        q = q.where(ContainerSnapshot.connection_name == connection)
    if state:
        q = q.where(ContainerSnapshot.state == state)
    if search:
        q = q.where(
            ContainerSnapshot.name.contains(search) |
            ContainerSnapshot.image.contains(search)
        )
    return session.exec(q).all()


@router.get("/status")
def connection_status(session: Session = Depends(get_session)):
    """Summary per connection: total, running, unhealthy counts."""
    connections = read_config().get("portainer", {}).get("connections", [])
    result = []
    for conn in connections:
        name = conn.get("name", "")
        all_c = session.exec(
            select(ContainerSnapshot).where(ContainerSnapshot.connection_name == name)
        ).all()
        running   = sum(1 for c in all_c if c.state == "running")
        unhealthy = sum(1 for c in all_c if c.state in ("exited", "dead", "restarting"))
        checked_at = max((c.checked_at for c in all_c), default=None)
        result.append({
            "name": name,
            "url": conn.get("url", ""),
            "enabled": conn.get("enabled", True),
            "total": len(all_c),
            "running": running,
            "unhealthy": unhealthy,
            "checked_at": checked_at.isoformat() if checked_at else None,
        })
    return result


@router.post("/poll", dependencies=[Depends(require_admin)])
async def trigger_poll():
    """Manually trigger an immediate poll of all connections."""
    await _poll_all()
    return {"status": "polled"}


async def _poll_all():
    """Poll all enabled Portainer connections and update snapshots."""
    connections = read_config().get("portainer", {}).get("connections", [])
    for conn in connections:
        if not conn.get("enabled", True):
            continue
        name = conn.get("name", "unknown")
        url = conn.get("url", "")
        api_key = decrypt(conn.get("api_key", ""))
        try:
            containers = await fetch_containers(url, api_key)
            upsert_containers(engine, name, containers)
            print(f"Portainer '{name}': {len(containers)} containers updated")
        except Exception as e:
            print(f"Portainer poll failed for '{name}': {e}")


# ── Container actions ──────────────────────────────────────────────────────────

class ContainerActionIn(BaseModel):
    connection: str
    endpoint_id: int
    container: str           # container id or name
    action: str              # start | stop | restart


@router.post("/containers/action", dependencies=[Depends(require_admin)])
async def run_container_action(data: ContainerActionIn):
    try:
        await container_action(data.connection, data.endpoint_id, data.container, data.action)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    await _poll_all()          # refresh states so the UI shows the result straight away
    return {"ok": True}


@router.get("/containers/logs", dependencies=[Depends(require_admin)])
async def get_container_logs(connection: str, endpoint_id: int, container: str, tail: int = 200):
    try:
        return {"logs": await container_logs(connection, endpoint_id, container, min(max(tail, 10), 2000))}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

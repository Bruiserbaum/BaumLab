import json
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from ..models.service import Service, ServiceCreate, ServiceNew, STATUSES
from ..models.monitor import MonitorTarget
from ..models.vault import VaultEntry
from ..models.backup import BackupJob, BackupRecord, BackupStack
from ..database import get_session
from ..services.auth import get_current_user
from ..services import git_sync, discovery

router = APIRouter(prefix="/api/services", tags=["services"], dependencies=[Depends(get_current_user)])


def _where(s: Service) -> str:
    """' (Unraid, VLAN 20)' — context for git commit messages."""
    parts = [p for p in (s.host, f"VLAN {s.vlan}" if s.vlan is not None else None) if p]
    return f" ({', '.join(parts)})" if parts else ""


def _check_status(status: str):
    if status not in STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of: {', '.join(STATUSES)}")


@router.get("/", response_model=list[Service])
def list_services(session: Session = Depends(get_session)):
    return session.exec(select(Service).order_by(Service.name)).all()


def _attach_monitor(session: Session, service: Service):
    """Create a monitor matching the service's address and link it."""
    if not service.ip:
        return
    if service.port and service.protocol in ("http", "https", "tcp"):
        protocol, port = service.protocol, service.port
    else:
        protocol, port = "icmp", None   # UDP or no port — ping the host instead
    monitor = MonitorTarget(name=service.name, host=service.ip, port=port, protocol=protocol)
    session.add(monitor)
    session.flush()
    service.monitor_id = monitor.id


def _create(session: Session, data: ServiceNew) -> Service:
    _check_status(data.status)
    service = Service(**data.model_dump(exclude={"create_monitor"}))
    if service.status == "decommissioned":
        service.decommissioned_at = datetime.utcnow()
    if data.create_monitor and service.monitor_id is None:
        _attach_monitor(session, service)
    session.add(service)
    return service


@router.post("/", response_model=Service)
def create_service(data: ServiceNew, session: Session = Depends(get_session)):
    service = _create(session, data)
    session.commit()
    session.refresh(service)
    git_sync.queue_change(f"Add {service.name}{_where(service)}")
    return service


@router.get("/discover")
def discover_services(session: Session = Depends(get_session)):
    """Suggestions from Portainer containers and device port scans, minus existing services."""
    return discovery.discover(session)


@router.post("/bulk", response_model=list[Service])
def create_services_bulk(items: list[ServiceNew], session: Session = Depends(get_session)):
    services = [_create(session, data) for data in items]
    session.commit()
    for service in services:
        session.refresh(service)
        git_sync.queue_change(f"Add {service.name}{_where(service)}")
    return services


@router.patch("/{service_id}", response_model=Service)
def update_service(service_id: int, data: ServiceCreate, session: Session = Depends(get_session)):
    service = session.get(Service, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    _check_status(data.status)
    before = service.model_dump()
    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(service, field, value)
    changed = [f for f in updates if before.get(f) != getattr(service, f)]
    if not changed:
        return service

    if "status" in changed:
        service.decommissioned_at = datetime.utcnow() if service.status == "decommissioned" else None
        if service.status == "decommissioned":
            message = f"Decommission {service.name}{_where(service)}"
        elif before["status"] == "decommissioned":
            message = f"Restore {service.name}{_where(service)} as {service.status}"
        else:
            message = f"Mark {service.name} as {service.status}"
    else:
        message = f"Update {service.name} ({', '.join(changed)})"

    service.updated_at = datetime.utcnow()
    session.add(service)
    session.commit()
    session.refresh(service)
    git_sync.queue_change(message)
    return service


@router.delete("/{service_id}")
def delete_service(service_id: int, session: Session = Depends(get_session)):
    service = session.get(Service, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    message = f"Remove {service.name}{_where(service)}"
    # Keep the credentials, just unlink them — losing a password with its service would be worse
    for entry in session.exec(select(VaultEntry).where(VaultEntry.service_id == service_id)).all():
        entry.service_id = None
        session.add(entry)
    for rec in session.exec(select(BackupRecord).where(BackupRecord.service_id == service_id)).all():
        session.delete(rec)
    for target in [*session.exec(select(BackupJob)).all(), *session.exec(select(BackupStack)).all()]:
        ids = json.loads(target.service_ids or "[]")
        if service_id in ids:
            target.service_ids = json.dumps([i for i in ids if i != service_id])
            session.add(target)
    session.delete(service)
    session.commit()
    git_sync.queue_change(message)
    return {"ok": True}

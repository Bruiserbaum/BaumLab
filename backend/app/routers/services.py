import json
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select
from ..models.service import LoginIn, Service, ServiceCreate, ServiceNew, STATUSES
from ..models.monitor import MonitorTarget
from ..models.portainer import ContainerSnapshot
from ..models.terminal import SshHost
from ..models.user import User
from ..models.vault import VaultAudit, VaultEntry
from ..models.backup import BackupJob, BackupRecord, BackupStack
from ..database import get_session
from ..services.auth import get_current_user
from ..services import git_sync, discovery, vault

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
    if service.port and service.protocol in ("http", "https", "tcp", "ssh"):
        protocol = "tcp" if service.protocol == "ssh" else service.protocol
        port = service.port
    else:
        protocol, port = "icmp", None   # UDP or no port — ping the host instead
    monitor = MonitorTarget(name=service.name, host=service.ip, port=port, protocol=protocol)
    session.add(monitor)
    session.flush()
    service.monitor_id = monitor.id


def _store_login(session: Session, service: Service, login: LoginIn, user: User) -> int:
    """Save a service's login in the vault (admins, vault unlocked). Returns the entry id."""
    vault.require_unlocked()
    entry = VaultEntry(service_id=service.id, title=f"{service.name} login", username=login.username or None,
                       secret_enc=vault.encrypt(login.password), url=service.url, updated_by=user.username)
    session.add(entry)
    session.flush()
    session.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=user.username, action="create"))
    return entry.id


def _ensure_terminal_host(session: Session, service: Service, username: str = "",
                          credential_id: Optional[int] = None) -> Optional[SshHost]:
    """Add an SSH service to the Terminal page, or link it to a matching existing host."""
    if not service.ip:
        return None
    port = service.port or 22
    host = session.exec(select(SshHost).where(SshHost.address == service.ip, SshHost.port == port)).first()
    if host:
        host.service_id = host.service_id or service.id
        host.credential_id = host.credential_id or credential_id
        host.username = host.username or username
    else:
        host = SshHost(name=service.name, address=service.ip, port=port, username=username or "",
                       credential_id=credential_id, service_id=service.id)
    session.add(host)
    return host


def _create(session: Session, data: ServiceNew, user: User) -> Service:
    _check_status(data.status)
    service = Service(**data.model_dump(exclude={"create_monitor", "login", "create_terminal_host"}))
    if service.status == "decommissioned":
        service.decommissioned_at = datetime.utcnow()
    if data.create_monitor and service.monitor_id is None:
        _attach_monitor(session, service)
    session.add(service)
    session.flush()   # ids for the vault entry / terminal host links

    credential_id = None
    if data.login and data.login.password:
        if not user.is_admin:
            raise HTTPException(status_code=403, detail="Only admins can store logins in the vault")
        credential_id = _store_login(session, service, data.login, user)
    if data.create_terminal_host and user.is_admin:
        _ensure_terminal_host(session, service, data.login.username if data.login else "", credential_id)
    return service


@router.post("/", response_model=Service)
def create_service(data: ServiceNew, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    service = _create(session, data, user)
    session.commit()
    session.refresh(service)
    git_sync.queue_change(f"Add {service.name}{_where(service)}")
    return service


class ContainerRef(BaseModel):
    connection: str
    endpoint_id: int
    name: str


@router.post("/from-container", response_model=Service)
def create_from_container(ref: ContainerRef, user: User = Depends(get_current_user),
                          session: Session = Depends(get_session)):
    """Docker page → '+ Service': inventory a running container, linked to it."""
    c = session.exec(select(ContainerSnapshot).where(
        ContainerSnapshot.connection_name == ref.connection, ContainerSnapshot.endpoint_id == ref.endpoint_id,
        ContainerSnapshot.name == ref.name)).first()
    if not c:
        raise HTTPException(status_code=404, detail="Container not found — refresh the Docker page")
    item = discovery.container_suggestion(c)
    data = ServiceNew(**{k: v for k, v in item.items() if k in ServiceNew.model_fields}, create_monitor=True)
    existing = {s.name.lower() for s in session.exec(select(Service)).all()}
    if data.name.lower() in existing:
        data.name = c.name
    service = _create(session, data, user)
    session.commit()
    session.refresh(service)
    git_sync.queue_change(f"Add {service.name}{_where(service)}")
    return service


@router.get("/discover")
def discover_services(session: Session = Depends(get_session)):
    """Suggestions from Portainer containers and device port scans, minus existing services."""
    return discovery.discover(session)


@router.post("/bulk", response_model=list[Service])
def create_services_bulk(items: list[ServiceNew], user: User = Depends(get_current_user),
                         session: Session = Depends(get_session)):
    services = [_create(session, data, user) for data in items]
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

    if (service.protocol == "ssh" and service.status != "decommissioned"
            and not session.exec(select(SshHost).where(SshHost.service_id == service.id)).first()):
        # Became an SSH service — put it on the Terminal page, with its vault login if it has one
        login = session.exec(select(VaultEntry).where(VaultEntry.service_id == service.id)).first()
        _ensure_terminal_host(session, service, username=(login.username or "") if login else "",
                              credential_id=login.id if login else None)

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
    for host in session.exec(select(SshHost).where(SshHost.service_id == service_id)).all():
        host.service_id = None
        session.add(host)
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

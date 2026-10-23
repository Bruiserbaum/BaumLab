from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from ..models.service import Service, ServiceCreate, STATUSES
from ..models.vault import VaultEntry
from ..database import get_session
from ..services.auth import get_current_user
from ..services import git_sync

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


@router.post("/", response_model=Service)
def create_service(data: ServiceCreate, session: Session = Depends(get_session)):
    _check_status(data.status)
    service = Service(**data.model_dump())
    if service.status == "decommissioned":
        service.decommissioned_at = datetime.utcnow()
    session.add(service)
    session.commit()
    session.refresh(service)
    git_sync.queue_change(f"Add {service.name}{_where(service)}")
    return service


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
    session.delete(service)
    session.commit()
    git_sync.queue_change(message)
    return {"ok": True}

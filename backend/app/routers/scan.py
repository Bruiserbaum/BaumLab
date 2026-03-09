from fastapi import APIRouter, Depends, BackgroundTasks
from sqlmodel import Session, select
from datetime import datetime
from ..models.device import Device
from ..services.scanner import scan_network, scan_ports, guess_device_type
from ..database import get_session
from ..services.auth import get_current_user

router = APIRouter(prefix="/api/scan", tags=["scan"], dependencies=[Depends(get_current_user)])


def _upsert_devices(cidr: str, session: Session):
    """Run nmap scan and upsert results into DB."""
    found = scan_network(cidr)
    for info in found:
        existing = session.exec(
            select(Device).where(Device.ip == info["ip"])
        ).first()
        if existing:
            existing.last_seen = datetime.utcnow()
            existing.is_online = True
            if info.get("mac"):
                existing.mac = info["mac"]
            if info.get("hostname"):
                existing.hostname = info["hostname"]
            if info.get("vendor"):
                existing.vendor = info["vendor"]
            if info.get("os_guess"):
                existing.os_guess = info["os_guess"]
            if not existing.device_type and (info.get("vendor") or info.get("os_guess")):
                existing.device_type = guess_device_type(
                    info.get("vendor", ""), [], info.get("os_guess", "")
                )
            session.add(existing)
        else:
            device = Device(
                ip=info["ip"],
                mac=info.get("mac"),
                hostname=info.get("hostname"),
                vendor=info.get("vendor"),
                os_guess=info.get("os_guess"),
                is_online=True,
                device_type=guess_device_type(
                    info.get("vendor", ""), [], info.get("os_guess", "")
                ),
            )
            session.add(device)
    session.commit()


@router.post("/network")
def trigger_scan(cidr: str, background_tasks: BackgroundTasks, session: Session = Depends(get_session)):
    """Kick off a background network scan for the given CIDR (e.g. 192.168.1.0/24)."""
    background_tasks.add_task(_upsert_devices, cidr, session)
    return {"status": "scan_started", "cidr": cidr}


@router.post("/ports/{device_id}")
def trigger_port_scan(device_id: int, port_range: str = "22-443", session: Session = Depends(get_session)):
    """Synchronously port-scan a single device and update its open_ports."""
    import json
    device = session.get(Device, device_id)
    if not device:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Device not found")
    ports = scan_ports(device.ip, port_range)
    device.open_ports = json.dumps(ports)
    device.device_type = guess_device_type(
        device.vendor or "", ports, device.os_guess or ""
    )
    session.add(device)
    session.commit()
    session.refresh(device)
    return device

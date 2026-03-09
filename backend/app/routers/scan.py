from fastapi import APIRouter, Depends, BackgroundTasks
from sqlmodel import Session, select
from datetime import datetime, timezone
from ..models.device import Device
from ..services.scanner import scan_network, scan_ports, guess_device_type
from ..database import get_session, engine
from ..services.auth import get_current_user

router = APIRouter(prefix="/api/scan", tags=["scan"], dependencies=[Depends(get_current_user)])

# In-memory scan state — single scan at a time is fine for a homelab
_scan_state: dict = {"running": False, "cidr": "", "log": [], "found": 0, "started_at": None, "finished_at": None}


def _log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    _scan_state["log"].append(f"[{ts}] {msg}")


def _upsert_devices(cidr: str):
    """Run nmap scan and upsert results into DB."""
    _scan_state.update({"running": True, "cidr": cidr, "log": [], "found": 0,
                         "started_at": datetime.now(timezone.utc).isoformat(), "finished_at": None})
    _log(f"Starting network scan on {cidr}")
    try:
        _log("Running nmap host discovery (this may take 30–90 s)…")
        found = scan_network(cidr)
        _log(f"nmap complete — {len(found)} host(s) responded")
        _scan_state["found"] = len(found)

        with Session(engine) as session:
            new_count = 0
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
                    _log(f"Updated {info['ip']} ({info.get('hostname') or info.get('vendor') or 'unknown'})")
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
                    new_count += 1
                    _log(f"New device: {info['ip']} ({info.get('hostname') or info.get('vendor') or 'unknown'})")
            session.commit()
        _log(f"Done — {new_count} new device(s) added, {len(found) - new_count} updated")
    except Exception as exc:
        _log(f"ERROR: {exc}")
    finally:
        _scan_state["running"] = False
        _scan_state["finished_at"] = datetime.now(timezone.utc).isoformat()


@router.get("/status")
def scan_status():
    """Return current scan state + log."""
    return _scan_state


@router.post("/network")
def trigger_scan(cidr: str, background_tasks: BackgroundTasks):
    """Kick off a background network scan for the given CIDR (e.g. 192.168.1.0/24)."""
    if _scan_state["running"]:
        return {"status": "already_running", "cidr": _scan_state["cidr"]}
    background_tasks.add_task(_upsert_devices, cidr)
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

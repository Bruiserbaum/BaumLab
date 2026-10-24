"""Home dashboard: one call that summarises health across every BaumLab section."""
import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..models.alert import AlertLog
from ..models.cert import CertStatus
from ..models.device import Device
from ..models.portainer import ContainerSnapshot
from ..models.service import Service
from ..models.user import User
from ..services import backup_schedule, certs, updater
from ..services.auth import get_current_user
from .status import public_status

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/")
def dashboard(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    attention: list[dict] = []   # {severity, text, link}

    # Monitors
    mon = public_status(session)
    for m in mon["monitors"]:
        if m["is_up"] is False:
            attention.append({"severity": "critical", "text": f"{m['name']} is down", "link": "/monitors"})

    # Services + backups
    services = [s for s in session.exec(select(Service)).all() if s.status != "decommissioned"]
    coverage = backup_schedule.coverage()
    backup_counts = {"ok": 0, "stale": 0, "failing": 0, "none": 0}
    for s in services:
        status = coverage.get(s.id, {}).get("status", "none")
        bucket = status if status in ("ok", "stale", "none") else "failing"
        backup_counts[bucket] += 1
        if bucket == "failing":
            attention.append({"severity": "critical", "text": f"Backup for {s.name} is {status}", "link": "/backups"})
        elif bucket == "stale":
            attention.append({"severity": "warning", "text": f"Backup for {s.name} is stale", "link": "/backups"})
    exposed = [s for s in services if s.external and not s.sso]
    for s in exposed:
        attention.append({"severity": "warning", "text": f"{s.name} is internet-facing without SSO", "link": "/services"})

    # Certificates
    cert_rows = session.exec(select(CertStatus)).all()
    cert_counts = {"ok": 0, "expiring": 0, "expired": 0, "error": 0}
    for c in cert_rows:
        lvl = certs.level(c)
        if lvl == "ok":
            cert_counts["ok"] += 1
        elif lvl in ("warn", "critical"):
            cert_counts["expiring"] += 1
            attention.append({"severity": "warning" if lvl == "warn" else "critical",
                              "text": f"Certificate for {c.host} expires in {certs.days_left(c.not_after)} days",
                              "link": "/certificates"})
        elif lvl == "expired":
            cert_counts["expired"] += 1
            attention.append({"severity": "critical", "text": f"Certificate for {c.host} has expired", "link": "/certificates"})
        elif c.checked_at:
            cert_counts["error"] += 1

    # Devices
    devices = session.exec(select(Device)).all()
    week_ago = datetime.utcnow() - timedelta(days=7)
    new_devices = sorted((d for d in devices if d.first_seen and d.first_seen > week_ago),
                         key=lambda d: d.first_seen, reverse=True)

    # Docker (from Portainer polling)
    containers = session.exec(select(ContainerSnapshot)).all()
    unhealthy = [c for c in containers if c.state in ("dead", "restarting")]
    for c in unhealthy:
        attention.append({"severity": "warning", "text": f"Container {c.name} is {c.state} ({c.endpoint_name})", "link": "/portainer"})

    # Updates
    upd = updater.status()
    if upd.get("update_available"):
        attention.append({"severity": "info", "text": f"BaumLab {upd['latest_tag']} is available", "link": "/settings"})

    order = {"critical": 0, "warning": 1, "info": 2}
    result = {
        "attention": sorted(attention, key=lambda a: order[a["severity"]]),
        "monitors": {"overall": mon["overall"], "up": mon["up"], "down": mon["down"], "total": mon["total"]},
        "services": {"total": len(services), "proxied": sum(1 for s in services if s.proxied),
                     "sso": sum(1 for s in services if s.sso), "external": sum(1 for s in services if s.external),
                     "exposed_without_sso": len(exposed)},
        "backups": backup_counts,
        "certs": cert_counts,
        "devices": {"total": len(devices), "online": sum(1 for d in devices if d.is_online),
                    "new_this_week": [{"ip": d.ip, "name": d.label or d.hostname or d.vendor or d.ip,
                                       "first_seen": d.first_seen} for d in new_devices[:6]],
                    "new_count": len(new_devices)},
        "containers": {"total": len(containers), "running": sum(1 for c in containers if c.state == "running"),
                       "unhealthy": len(unhealthy)},
        "version": {"current": upd["current"], "latest": upd.get("latest"), "update_available": upd.get("update_available")},
        "recent_alerts": [],
    }
    if user.is_admin:
        rows = session.exec(select(AlertLog).order_by(AlertLog.at.desc()).limit(8)).all()
        result["recent_alerts"] = [{"at": a.at, "severity": a.severity, "title": a.title} for a in rows]
    return result

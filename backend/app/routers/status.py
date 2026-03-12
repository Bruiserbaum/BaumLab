from fastapi import APIRouter, Depends
from sqlmodel import Session, select
from datetime import datetime
from ..models.monitor import MonitorTarget, MonitorResult
from ..database import get_session

# No auth dependency — this route is intentionally public
router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("/public")
def public_status(session: Session = Depends(get_session)):
    """
    Public endpoint — no authentication required.
    Returns all enabled monitor targets with their latest check result.
    """
    targets = session.exec(
        select(MonitorTarget)
        .where(MonitorTarget.enabled == True)
        .order_by(MonitorTarget.name)
    ).all()

    items = []
    for t in targets:
        latest = session.exec(
            select(MonitorResult)
            .where(MonitorResult.target_id == t.id)
            .order_by(MonitorResult.checked_at.desc())
            .limit(1)
        ).first()

        items.append({
            "id":         t.id,
            "name":       t.name,
            "protocol":   t.protocol,
            "is_up":      latest.is_up      if latest else None,
            "latency_ms": latest.latency_ms if latest else None,
            "checked_at": latest.checked_at.isoformat() if latest else None,
            "error":      latest.error      if latest else None,
        })

    total   = len(items)
    up      = sum(1 for i in items if i["is_up"] is True)
    down    = sum(1 for i in items if i["is_up"] is False)
    unknown = total - up - down

    if total == 0 or unknown == total:
        overall = "unknown"
    elif down == 0:
        overall = "operational"
    elif down == total:
        overall = "outage"
    else:
        overall = "degraded"

    return {
        "overall":      overall,
        "total":        total,
        "up":           up,
        "down":         down,
        "unknown":      unknown,
        "generated_at": datetime.utcnow().isoformat(),
        "monitors":     items,
    }

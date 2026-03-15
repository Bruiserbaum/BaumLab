from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select, func, delete as sql_delete
from typing import Optional
from datetime import datetime

from ..database import get_session
from ..models.syslog import SyslogMessage, SEVERITY_NAMES, FACILITY_NAMES
from ..services.auth import get_current_user, require_admin

router = APIRouter(prefix="/api/syslog", tags=["syslog"],
                   dependencies=[Depends(get_current_user)])


@router.get("/")
def list_messages(
    severity_max: int = Query(7, ge=0, le=7, description="Max severity (0=Emerg, 7=Debug)"),
    host: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    q = select(SyslogMessage).where(SyslogMessage.severity <= severity_max)
    if host:
        q = q.where(SyslogMessage.host.contains(host))
    if search:
        q = q.where(
            SyslogMessage.message.contains(search) |
            SyslogMessage.tag.contains(search)
        )
    q = q.order_by(SyslogMessage.received_at.desc()).offset(offset).limit(limit)
    rows = session.exec(q).all()

    return [
        {
            **r.model_dump(),
            "severity_name": SEVERITY_NAMES.get(r.severity, str(r.severity)),
            "facility_name": FACILITY_NAMES.get(r.facility, str(r.facility)),
        }
        for r in rows
    ]


@router.get("/stats")
def stats(session: Session = Depends(get_session)):
    total = session.exec(select(func.count()).select_from(SyslogMessage)).one()
    by_severity = {}
    for sev in range(8):
        n = session.exec(
            select(func.count()).select_from(SyslogMessage)
            .where(SyslogMessage.severity == sev)
        ).one()
        if n:
            by_severity[SEVERITY_NAMES[sev]] = n
    hosts = session.exec(
        select(SyslogMessage.host, func.count())
        .group_by(SyslogMessage.host)
        .order_by(func.count().desc())
        .limit(10)
    ).all()
    return {
        "total": total,
        "by_severity": by_severity,
        "top_hosts": [{"host": h, "count": c} for h, c in hosts],
    }


@router.delete("/", dependencies=[Depends(require_admin)])
def clear_all(session: Session = Depends(get_session)):
    session.exec(sql_delete(SyslogMessage))
    session.commit()
    return {"deleted": True}

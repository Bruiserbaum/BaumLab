from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from sqlmodel import Session, select, func, delete as sql_delete
from typing import Optional
from datetime import datetime, timedelta

from ..database import get_session
from ..models.syslog import SyslogMessage, SEVERITY_NAMES, FACILITY_NAMES
from ..services.auth import get_current_user, require_admin

router = APIRouter(prefix="/api/syslog", tags=["syslog"],
                   dependencies=[Depends(get_current_user)])


def _filtered(q, severity_max: int, host: Optional[str], search: Optional[str], source: Optional[str]):
    q = q.where(SyslogMessage.severity <= severity_max)
    if source:
        q = q.where(SyslogMessage.source == source)
    if host:
        q = q.where(SyslogMessage.host.contains(host))
    if search:
        q = q.where(
            SyslogMessage.message.contains(search) |
            SyslogMessage.tag.contains(search)
        )
    return q


@router.get("/")
def list_messages(
    severity_max: int = Query(7, ge=0, le=7, description="Max severity (0=Emerg, 7=Debug)"),
    host: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    source: Optional[str] = Query(None, description="network (UDP syslog), container (BaumLab-collected Docker logs) or audit (changes made in BaumLab)"),
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    q = _filtered(select(SyslogMessage), severity_max, host, search, source)
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


@router.get("/download")
def download(
    minutes: int = Query(60, ge=1, le=60 * 24 * 31, description="How far back to export"),
    severity_max: int = Query(7, ge=0, le=7),
    host: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    session: Session = Depends(get_session),
):
    """The last N minutes as a plain-text log file (oldest first) — for troubleshooting or handing to someone."""
    now = datetime.utcnow()
    since = now - timedelta(minutes=minutes)
    q = _filtered(select(SyslogMessage).where(SyslogMessage.received_at >= since), severity_max, host, search, source)
    rows = session.exec(q.order_by(SyslogMessage.received_at, SyslogMessage.id)).all()

    filters = ", ".join(f"{k}={v}" for k, v in
                        (("source", source), ("host", host), ("search", search)) if v)
    if severity_max < 7:
        filters = ", ".join(x for x in (filters, f"severity<={SEVERITY_NAMES[severity_max]}") if x)
    lines = [
        f"# BaumLab syslog export: {since:%Y-%m-%d %H:%M:%S} to {now:%Y-%m-%d %H:%M:%S} UTC, {len(rows)} lines"
        + (f" ({filters})" if filters else ""),
        "# time (UTC)          severity   source     host                 message",
    ]
    for r in rows:
        # Docker timestamps are UTC; a device's own syslog clock may not be, so use arrival time for those
        when = r.timestamp if r.source == "container" and r.timestamp else r.received_at
        sev = SEVERITY_NAMES.get(r.severity, str(r.severity)).upper()
        lines.append(f"{when:%Y-%m-%d %H:%M:%S}  {sev:<9}  {r.source:<9}  {(r.host or r.source_ip)[:20]:<20} "
                     f"{r.message.replace(chr(10), ' ')}")
    label = f"{minutes}m" if minutes < 60 else f"{minutes // 60}h" if minutes < 1440 else f"{minutes // 1440}d"
    filename = f"baumlab-syslog-{now:%Y%m%d-%H%M}-last-{label}.log"
    return PlainTextResponse("\n".join(lines) + "\n",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


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
    by_source = dict(session.exec(
        select(SyslogMessage.source, func.count()).group_by(SyslogMessage.source)
    ).all())
    return {
        "total": total,
        "by_severity": by_severity,
        "by_source": by_source,
        "top_hosts": [{"host": h, "count": c} for h, c in hosts],
    }


@router.delete("/", dependencies=[Depends(require_admin)])
def clear_all(session: Session = Depends(get_session)):
    session.exec(sql_delete(SyslogMessage))
    session.commit()
    return {"deleted": True}

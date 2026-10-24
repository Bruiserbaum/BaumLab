import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.cert import CertStatus
from ..models.service import Service
from ..services import certs
from ..services.auth import get_current_user, require_admin

router = APIRouter(prefix="/api/certs", tags=["certs"], dependencies=[Depends(get_current_user)])


def _dict(c: CertStatus, names: dict[int, str]) -> dict:
    ids = json.loads(c.service_ids or "[]")
    return {**c.model_dump(), "service_ids": ids, "services": [names[i] for i in ids if i in names],
            "days_left": certs.days_left(c.not_after), "level": certs.level(c)}


@router.get("/")
def list_certs(session: Session = Depends(get_session)):
    certs.sync_targets(session)   # pick up new / changed services without waiting for the daily check
    names = {s.id: s.name for s in session.exec(select(Service)).all()}
    rows = session.exec(select(CertStatus)).all()
    return sorted((_dict(c, names) for c in rows),
                  key=lambda c: (c["days_left"] is None, c["days_left"] if c["days_left"] is not None else 0))


@router.post("/check")
async def check_all():
    await asyncio.to_thread(certs.check_all)
    return {"ok": True}


@router.post("/{cert_id}/check")
async def check_one(cert_id: int, session: Session = Depends(get_session)):
    if not session.get(CertStatus, cert_id):
        raise HTTPException(status_code=404, detail="Not found")
    row = await asyncio.to_thread(certs.check_one, cert_id)
    return _dict(row, {s.id: s.name for s in session.exec(select(Service)).all()})


class HostIn(BaseModel):
    host: str
    port: int = 443


@router.post("/", dependencies=[Depends(require_admin)])
async def add_host(data: HostIn, session: Session = Depends(get_session)):
    host = data.host.strip().lower().removeprefix("https://").split("/")[0]
    if ":" in host:
        host, _, port = host.partition(":")
        data.port = int(port) if port.isdigit() else data.port
    existing = session.exec(select(CertStatus).where(CertStatus.host == host, CertStatus.port == data.port)).first()
    row = existing or CertStatus(host=host, port=data.port)
    row.manual = True
    session.add(row)
    session.commit()
    session.refresh(row)
    row = await asyncio.to_thread(certs.check_one, row.id)
    return _dict(row, {s.id: s.name for s in session.exec(select(Service)).all()})


@router.delete("/{cert_id}", dependencies=[Depends(require_admin)])
def remove_host(cert_id: int, session: Session = Depends(get_session)):
    row = session.get(CertStatus, cert_id)
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    if json.loads(row.service_ids or "[]"):
        # Still used by a service — just stop treating it as hand-added
        row.manual = False
        session.add(row)
    else:
        session.delete(row)
    session.commit()
    return {"ok": True}

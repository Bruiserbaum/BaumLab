import json
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.alert import AlertLog
from ..services import alerts
from ..services.auth import require_admin

router = APIRouter(prefix="/api/alerts", tags=["alerts"], dependencies=[Depends(require_admin)])


class AlertConfigIn(BaseModel):
    public_url: str = ""
    monitor_failures: int = 2
    events: dict[str, bool] = {}
    channels: list[dict[str, Any]] = []


@router.get("/config")
def get_config():
    return {**alerts.get_config(masked=True), "event_types": alerts.EVENTS}


@router.put("/config")
def save_config(data: AlertConfigIn):
    alerts.save_config(data.model_dump())
    return get_config()


@router.post("/test/{channel_id}")
def test_channel(channel_id: str):
    ok, message = alerts.test_channel(channel_id)
    return {"ok": ok, "message": message}


@router.get("/history")
def history(limit: int = 100, session: Session = Depends(get_session)):
    rows = session.exec(select(AlertLog).order_by(AlertLog.at.desc()).limit(min(limit, 500))).all()
    return [{**r.model_dump(), "delivery": json.loads(r.delivery or "[]")} for r in rows]

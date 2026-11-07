from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..models.user import User
from ..services import mail_relay
from ..services.auth import require_admin

router = APIRouter(prefix="/api/mail-relay", tags=["mail-relay"], dependencies=[Depends(require_admin)])


class RelayConfigIn(BaseModel):
    enabled: bool = False
    hostname: str = ""
    allowed_networks: list[str] = []
    require_auth: bool = False
    logins: list[dict[str, Any]] = []
    upstream: dict[str, Any] = {}
    from_mode: str = "rewrite"
    from_address: str = ""
    from_name: str = "{name}"
    keep_domains: list[str] = []
    reply_to_original: bool = True
    deliver_to: str = ""
    max_size_mb: int = 25
    retention_days: int = 7


class TestSendIn(BaseModel):
    to: str


@router.get("/status")
def status():
    return mail_relay.status()


@router.get("/config")
def get_config():
    return mail_relay.settings(masked=True)


@router.put("/config")
def save_config(data: RelayConfigIn):
    try:
        mail_relay.save_settings(data.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return mail_relay.settings(masked=True)


@router.post("/test-upstream")
def test_upstream():
    ok, message = mail_relay.test_upstream()
    return {"ok": ok, "message": message}


@router.post("/test-send")
def test_send(data: TestSendIn, user: User = Depends(require_admin)):
    if "@" not in data.to:
        raise HTTPException(status_code=422, detail="Enter an email address to send the test to")
    return {"id": mail_relay.send_test(data.to.strip(), user.username)}


@router.get("/messages")
def messages(status: Optional[str] = None, limit: int = 200):
    return mail_relay.messages(status, min(limit, 1000))


@router.post("/messages/{msg_id}/retry")
def retry(msg_id: int):
    if not mail_relay.retry(msg_id):
        raise HTTPException(status_code=404, detail="Nothing to retry — the message or its stored copy is gone")
    return {"ok": True}


@router.delete("/messages/{msg_id}")
def delete(msg_id: int):
    mail_relay.delete(msg_id)
    return {"ok": True}


@router.get("/messages/{msg_id}/eml")
def download(msg_id: int):
    raw = mail_relay.raw_message(msg_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="The stored copy of this message is gone")
    return Response(raw, media_type="message/rfc822",
                    headers={"Content-Disposition": f'attachment; filename="relay-message-{msg_id}.eml"'})

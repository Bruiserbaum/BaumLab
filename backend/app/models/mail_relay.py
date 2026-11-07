from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class RelayMessage(SQLModel, table=True):
    """One message a device handed to the mail relay — or a refused attempt, so you can see why a device can't send."""
    id: Optional[int] = Field(default=None, primary_key=True)
    received_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    client_ip: str = ""
    login: Optional[str] = None                 # relay login the device used, if any
    helo: Optional[str] = None                  # name the device greeted with
    mail_from: str = ""                         # sender as the device gave it
    rcpt_to: str = "[]"                         # JSON list of recipients as the device gave them
    subject: str = ""
    size: int = 0
    status: str = Field(default="queued", index=True)   # queued | deferred | sent | failed | rejected
    attempts: int = 0
    next_attempt_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    sent_from: Optional[str] = None             # address it actually went out as (after rewriting)
    sent_to: Optional[str] = None               # JSON list it was actually delivered to
    last_error: Optional[str] = None
    file: Optional[str] = None                  # stored .eml under data/mail-relay (kept for retries / download)

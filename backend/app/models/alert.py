from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class AlertLog(SQLModel, table=True):
    """Every alert raised, whether or not any channel delivered it."""
    id: Optional[int] = Field(default=None, primary_key=True)
    at: datetime = Field(default_factory=datetime.utcnow, index=True)
    event: str                                 # monitor_down | backup_failed | new_device | ...
    severity: str = "warning"                  # info | warning | critical
    title: str
    message: str = ""
    url: Optional[str] = None
    delivery: str = "[]"                       # JSON list of {channel, ok, error}


class AlertState(SQLModel, table=True):
    """Last known state per watched thing, so alerts fire on changes rather than every check."""
    key: str = Field(primary_key=True)         # e.g. monitor:12, backup:job:3, update
    state: str = ""
    count: int = 0                             # consecutive failures (monitors)
    changed_at: datetime = Field(default_factory=datetime.utcnow)

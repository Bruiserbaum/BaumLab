from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class MonitorTarget(SQLModel, table=True):
    """A service/host the user wants to keep an eye on."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str                              # "Plex", "Home Assistant", etc.
    host: str                              # IP or hostname
    port: Optional[int] = None            # None = ICMP ping only
    protocol: str = "icmp"               # icmp | tcp | http | https
    interval_seconds: int = 60            # How often to check
    enabled: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)


class MonitorResult(SQLModel, table=True):
    """One data point from a monitor check."""
    id: Optional[int] = Field(default=None, primary_key=True)
    target_id: int = Field(foreign_key="monitortarget.id", index=True)
    checked_at: datetime = Field(default_factory=datetime.utcnow)
    is_up: bool
    latency_ms: Optional[float] = None
    status_code: Optional[int] = None    # HTTP checks only
    error: Optional[str] = None


class MonitorTargetCreate(SQLModel):
    name: str
    host: str
    port: Optional[int] = None
    protocol: str = "icmp"
    interval_seconds: int = 60

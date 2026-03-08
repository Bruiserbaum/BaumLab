from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class Device(SQLModel, table=True):
    """A network device discovered by scanning."""
    id: Optional[int] = Field(default=None, primary_key=True)
    ip: str = Field(index=True)
    mac: Optional[str] = None
    hostname: Optional[str] = None
    vendor: Optional[str] = None          # MAC OUI lookup
    device_type: Optional[str] = None    # "router", "camera", "nas", "pc", etc.
    vlan: Optional[int] = None           # VLAN tag if detectable
    open_ports: Optional[str] = None     # JSON list e.g. "[22, 80, 443]"
    os_guess: Optional[str] = None       # nmap OS fingerprint
    label: Optional[str] = None          # User-assigned friendly name
    notes: Optional[str] = None
    first_seen: datetime = Field(default_factory=datetime.utcnow)
    last_seen: datetime = Field(default_factory=datetime.utcnow)
    is_online: bool = False


class DeviceUpdate(SQLModel):
    """Fields the user can manually edit."""
    label: Optional[str] = None
    device_type: Optional[str] = None
    vlan: Optional[int] = None
    notes: Optional[str] = None

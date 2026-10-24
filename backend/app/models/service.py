from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel

STATUSES = ("active", "planned", "decommissioned")


class Service(SQLModel, table=True):
    """A self-hosted service/app the user wants to keep an inventory of."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str                                  # "Plex", "Home Assistant", etc.
    status: str = "active"                     # active | planned | decommissioned
    decommissioned_at: Optional[datetime] = None
    category: Optional[str] = None             # "Media", "Home Automation", "Infrastructure", ...
    host: Optional[str] = None                 # Where it runs: "Unraid", "Proxmox-01", "Pi 4", ...
    platform: Optional[str] = None             # docker | vm | lxc | bare-metal | appliance
    ip: Optional[str] = Field(default=None, index=True)
    port: Optional[int] = None
    protocol: str = "http"                     # http | https | tcp | udp
    vlan: Optional[int] = None
    url: Optional[str] = None                  # Primary access URL (usually the proxied one)
    proxied: bool = False                      # Routed through the reverse proxy
    sso: bool = False                          # Behind Authentik / SSO
    external: bool = False                     # Reachable from the internet
    monitor_id: Optional[int] = Field(default=None, foreign_key="monitortarget.id")
    credential_ref: Optional[str] = None       # Vaultwarden item link or name — never the secret itself
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ServiceCreate(SQLModel):
    name: str
    status: str = "active"
    category: Optional[str] = None
    host: Optional[str] = None
    platform: Optional[str] = None
    ip: Optional[str] = None
    port: Optional[int] = None
    protocol: str = "http"
    vlan: Optional[int] = None
    url: Optional[str] = None
    proxied: bool = False
    sso: bool = False
    external: bool = False
    monitor_id: Optional[int] = None
    credential_ref: Optional[str] = None
    notes: Optional[str] = None

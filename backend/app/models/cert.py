from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class CertStatus(SQLModel, table=True):
    """Latest TLS certificate seen on host:port. Rows come from services or are added by hand."""
    id: Optional[int] = Field(default=None, primary_key=True)
    host: str = Field(index=True)              # name sent as SNI
    port: int = 443
    manual: bool = False                       # added by hand (kept) vs derived from services (rebuilt)
    service_ids: str = "[]"                    # JSON list of services using this endpoint
    subject: Optional[str] = None
    issuer: Optional[str] = None
    sans: Optional[str] = None                 # comma-separated DNS names
    not_after: Optional[datetime] = None
    trusted: Optional[bool] = None             # chain + hostname verify against system CAs
    verify_error: Optional[str] = None
    error: Optional[str] = None                # couldn't connect / no TLS
    checked_at: Optional[datetime] = None

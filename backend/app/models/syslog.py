from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class SyslogMessage(SQLModel, table=True):
    """A received syslog UDP datagram, parsed and stored."""
    id: Optional[int] = Field(default=None, primary_key=True)
    received_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    timestamp: Optional[datetime] = None   # from the syslog payload, if parseable
    source_ip: str = ""
    host: str = ""
    severity: int = 6   # 0=Emergency … 7=Debug
    facility: int = 1   # 0=Kernel, 1=User, …
    tag: str = ""
    message: str = ""
    raw: str = ""


SEVERITY_NAMES = {
    0: "Emergency", 1: "Alert", 2: "Critical", 3: "Error",
    4: "Warning", 5: "Notice", 6: "Info", 7: "Debug",
}
FACILITY_NAMES = {
    0: "Kernel", 1: "User", 2: "Mail", 3: "System", 4: "Auth",
    5: "Syslog", 6: "Lpr", 7: "News", 8: "Uucp", 9: "Cron",
    16: "Local0", 17: "Local1", 18: "Local2", 19: "Local3",
    20: "Local4", 21: "Local5", 22: "Local6", 23: "Local7",
}

from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


class ScheduledVulnScan(SQLModel, table=True):
    __tablename__ = "scheduled_vuln_scan"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    target: str
    scan_config_id: str
    frequency: str  # "weekly" or "monthly"
    enabled: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_run_at: Optional[datetime] = None
    last_task_id: Optional[str] = None
    last_task_name: Optional[str] = None

from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class ContainerSnapshot(SQLModel, table=True):
    """Latest known state of a Docker container, as reported by Portainer."""
    id: Optional[int] = Field(default=None, primary_key=True)
    checked_at: datetime = Field(default_factory=datetime.utcnow)
    connection_name: str = Field(index=True)
    endpoint_id: int = 0
    endpoint_name: str = ""
    container_id: str = ""   # first 12 chars of Docker ID
    name: str = ""
    image: str = ""
    state: str = ""          # running / exited / dead / restarting / paused / created
    status_text: str = ""    # human-readable e.g. "Exited (1) 2 hours ago"

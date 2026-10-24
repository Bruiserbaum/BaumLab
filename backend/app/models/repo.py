from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class RepoSnapshot(SQLModel, table=True):
    """Latest known state of a repository on a configured Git host."""
    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(index=True)            # name of the repo source in settings
    full_name: str                             # owner/name
    owner: str = ""
    name: str = ""
    description: Optional[str] = None
    html_url: str = ""
    private: bool = False
    fork: bool = False
    archived: bool = False
    language: Optional[str] = None
    stars: int = 0
    default_branch: Optional[str] = None
    last_activity: Optional[str] = None        # ISO timestamp of last push (or update)
    release_tag: Optional[str] = None
    release_name: Optional[str] = None
    release_published_at: Optional[str] = None
    release_url: Optional[str] = None
    checked_at: datetime = Field(default_factory=datetime.utcnow)

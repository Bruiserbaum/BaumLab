from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class Bookmark(SQLModel, table=True):
    """A Launchpad link that isn't a self-hosted service (router UI, cloud consoles, docs...)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    url: str
    group: str = "Bookmarks"
    icon: Optional[str] = None                 # file name in the icon library
    description: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class BookmarkIn(SQLModel):
    name: str
    url: str
    group: str = "Bookmarks"
    icon: Optional[str] = None
    description: Optional[str] = None

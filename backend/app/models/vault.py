from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class VaultEntry(SQLModel, table=True):
    """A stored credential. Secret and notes are Fernet-encrypted at rest."""
    id: Optional[int] = Field(default=None, primary_key=True)
    service_id: Optional[int] = Field(default=None, foreign_key="service.id", index=True)
    title: str                                # "Plex admin", "Unraid root", ...
    username: Optional[str] = None
    secret_enc: str = ""                      # encrypted password / token
    url: Optional[str] = None                 # login page
    notes_enc: Optional[str] = None           # encrypted — notes often hold recovery codes
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    updated_by: Optional[str] = None


class VaultAudit(SQLModel, table=True):
    """Who did what to which credential, and when."""
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: Optional[int] = Field(default=None, index=True)
    entry_title: str = ""                     # kept so deleted entries stay readable in the log
    actor: str
    action: str                               # create | update | delete | reveal
    at: datetime = Field(default_factory=datetime.utcnow)


class VaultEntryIn(SQLModel):
    service_id: Optional[int] = None
    title: str
    username: Optional[str] = None
    secret: Optional[str] = None              # PATCH: None = keep existing
    url: Optional[str] = None
    notes: Optional[str] = None               # PATCH: None = keep existing


class VaultEntryPublic(SQLModel):
    """List view — never includes the secret or notes."""
    id: int
    service_id: Optional[int]
    title: str
    username: Optional[str]
    url: Optional[str]
    has_secret: bool
    has_notes: bool
    updated_at: datetime
    updated_by: Optional[str]

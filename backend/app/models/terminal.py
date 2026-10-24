from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class SshHost(SQLModel, table=True):
    """A machine BaumLab can open an SSH session to. The login lives in the vault."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    address: str                               # IP or hostname
    port: int = 22
    username: str
    auth_type: str = "password"                # password | key
    credential_id: Optional[int] = Field(default=None, foreign_key="vaultentry.id")  # secret = password or private key
    passphrase_enc: Optional[str] = None       # private key passphrase (vault-encrypted)
    host_key: Optional[str] = None             # pinned on first connect (OpenSSH public key format)
    device_id: Optional[int] = Field(default=None, foreign_key="device.id")
    service_id: Optional[int] = Field(default=None, foreign_key="service.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_connected_at: Optional[datetime] = None


class TerminalSession(SQLModel, table=True):
    """Audit trail: who opened a shell where, and when."""
    id: Optional[int] = Field(default=None, primary_key=True)
    host_id: Optional[int] = Field(default=None, index=True)
    host_name: str = ""
    actor: str
    client_ip: Optional[str] = None
    started_at: datetime = Field(default_factory=datetime.utcnow)
    ended_at: Optional[datetime] = None
    end_reason: Optional[str] = None

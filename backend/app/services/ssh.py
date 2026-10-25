"""
SSH connections to managed hosts — used by the web terminal (and later metrics / commands).

Credentials are decrypted from the vault only at connect time (each use is audited).
Host keys are pinned on first connect; afterwards asyncssh verifies the key BEFORE
authenticating, so a spoofed host never receives the password.
"""
import secrets
import time
from datetime import datetime
from typing import Optional

import asyncssh
from sqlmodel import Session

from ..database import engine
from ..models.terminal import SshHost
from ..models.vault import VaultAudit, VaultEntry
from . import vault

TICKET_TTL = 30            # seconds a terminal ticket stays valid
_tickets: dict[str, tuple[str, int, float]] = {}   # token → (username, host_id, expires)


class SshError(Exception):
    pass


class HostKeyChanged(SshError):
    pass


# ── Terminal tickets (a WebSocket can't carry the Authorization header) ────────

def issue_ticket(username: str, host_id: int) -> str:
    now = time.time()
    for t, (_, _, exp) in list(_tickets.items()):   # drop expired
        if exp < now:
            _tickets.pop(t, None)
    token = secrets.token_urlsafe(32)
    _tickets[token] = (username, host_id, now + TICKET_TTL)
    return token


def redeem_ticket(token: str, host_id: int) -> Optional[str]:
    """Single use: returns the username the ticket was issued to, or None."""
    entry = _tickets.pop(token or "", None)
    if not entry or entry[2] < time.time() or entry[1] != host_id:
        return None
    return entry[0]


# ── Connecting ─────────────────────────────────────────────────────────────────

def known_hosts_pattern(host: SshHost) -> str:
    return host.address if host.port == 22 else f"[{host.address}]:{host.port}"


def _auth(session: Session, host: SshHost, actor: str) -> dict:
    entry = session.get(VaultEntry, host.credential_id) if host.credential_id else None
    if not entry or not entry.secret_enc:
        raise SshError("No login stored for this host — edit it and add a password or key")
    secret = vault.decrypt(entry.secret_enc)
    session.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=actor, action="ssh"))
    # Never fall back to keys / agents found inside the BaumLab container
    if host.auth_type == "key":
        passphrase = vault.decrypt(host.passphrase_enc) if host.passphrase_enc else None
        try:
            key = asyncssh.import_private_key(secret, passphrase)
        except (asyncssh.KeyImportError, ValueError) as e:
            raise SshError(f"Can't read the private key: {e}")
        return {"client_keys": [key], "password": None, "agent_path": None}
    return {"password": secret, "client_keys": None, "agent_path": None}


async def connect(host_id: int, actor: str) -> tuple[asyncssh.SSHClientConnection, SshHost]:
    vault.require_unlocked()
    with Session(engine) as s:
        host = s.get(SshHost, host_id)
        if not host:
            raise SshError("Host not found")
        auth = _auth(s, host, actor)
        s.commit()
        s.refresh(host)
        s.expunge(host)

    known = asyncssh.import_known_hosts(f"{known_hosts_pattern(host)} {host.host_key}\n") if host.host_key else None
    try:
        conn = await asyncssh.connect(
            host.address, port=host.port, username=host.username, known_hosts=known,
            connect_timeout=15, keepalive_interval=30, **auth,
        )
    except asyncssh.HostKeyNotVerifiable:
        raise HostKeyChanged(
            f"The host key for {host.address} has CHANGED since it was first trusted. This happens after a "
            f"reinstall — or if something is impersonating the host. If you expected it, clear the trusted key.")
    except asyncssh.PermissionDenied:
        raise SshError("Login rejected — check the username and password / key")
    except (OSError, asyncssh.Error) as e:
        raise SshError(f"Couldn't connect to {host.address}:{host.port} — {e}")

    with Session(engine) as s:
        row = s.get(SshHost, host_id)
        if not row.host_key:   # trust on first use
            row.host_key = conn.get_server_host_key().export_public_key("openssh").decode().strip()
            host.host_key = row.host_key
        row.last_connected_at = datetime.utcnow()
        s.add(row)
        s.commit()
    return conn, host


def fingerprint(public_key: Optional[str]) -> Optional[str]:
    if not public_key:
        return None
    try:
        return asyncssh.import_public_key(public_key).get_fingerprint("sha256")
    except (asyncssh.KeyImportError, ValueError):
        return None

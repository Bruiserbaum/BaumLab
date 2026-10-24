"""
Web SSH terminal: managed hosts (logins kept in the vault), one-time tickets, and the
WebSocket that relays an interactive PTY between xterm.js and the remote shell.
"""
import asyncio
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import engine, get_session
from ..models.device import Device
from ..models.service import Service
from ..models.terminal import SshHost, TerminalSession
from ..models.user import User
from ..models.vault import VaultAudit, VaultEntry
from ..services import ssh, vault
from ..services.auth import require_admin

# Admin-only, and only while the vault's safety checks pass (logins live in the vault)
router = APIRouter(prefix="/api/terminal", tags=["terminal"],
                   dependencies=[Depends(require_admin), Depends(vault.require_unlocked)])
ws_router = APIRouter()   # authenticated by single-use ticket instead of the bearer header

IDLE_TIMEOUT = 60 * 60    # close a session after an hour without keystrokes


def _host_dict(h: SshHost, session: Session) -> dict:
    cred = session.get(VaultEntry, h.credential_id) if h.credential_id else None
    device = session.get(Device, h.device_id) if h.device_id else None
    service = session.get(Service, h.service_id) if h.service_id else None
    return {
        "id": h.id, "name": h.name, "address": h.address, "port": h.port, "username": h.username,
        "auth_type": h.auth_type, "credential_id": h.credential_id,
        "credential_title": cred.title if cred else None, "has_secret": bool(cred and cred.secret_enc),
        "has_passphrase": bool(h.passphrase_enc), "fingerprint": ssh.fingerprint(h.host_key),
        "device_id": h.device_id, "device_name": (device.label or device.hostname or device.ip) if device else None,
        "service_id": h.service_id, "service_name": service.name if service else None,
        "last_connected_at": h.last_connected_at,
    }


def _get(session: Session, host_id: int) -> SshHost:
    h = session.get(SshHost, host_id)
    if not h:
        raise HTTPException(status_code=404, detail="Host not found")
    return h


# ── Hosts ──────────────────────────────────────────────────────────────────────

class HostIn(BaseModel):
    name: str
    address: str
    port: int = 22
    username: str
    auth_type: str = "password"             # password | key
    credential_id: Optional[int] = None     # use an existing vault entry
    secret: Optional[str] = None            # new password / private key → stored in the vault
    passphrase: Optional[str] = None        # None = keep, "" = clear
    device_id: Optional[int] = None
    service_id: Optional[int] = None


def _apply(h: SshHost, data: HostIn, session: Session, user: User):
    if data.auth_type not in ("password", "key"):
        raise HTTPException(status_code=422, detail="auth_type must be password or key")
    moved = (h.address, h.port) != (data.address.strip(), data.port)
    h.name, h.address, h.port = data.name.strip(), data.address.strip(), data.port
    h.username, h.auth_type = data.username.strip(), data.auth_type
    h.device_id, h.service_id = data.device_id, data.service_id
    if moved:
        h.host_key = None    # a different machine — trust its key on the next connect
    if data.secret:
        entry = session.get(VaultEntry, h.credential_id) if h.credential_id else None
        action = "update" if entry else "create"
        if not entry:
            entry = VaultEntry(title=f"SSH: {h.name}", service_id=h.service_id)
        entry.username = h.username
        entry.secret_enc = vault.encrypt(data.secret.strip() + ("\n" if data.auth_type == "key" else ""))
        entry.notes_enc = vault.encrypt("SSH private key" if data.auth_type == "key" else f"SSH login for {h.address}")
        entry.updated_at, entry.updated_by = datetime.utcnow(), user.username
        session.add(entry)
        session.flush()
        session.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor=user.username, action=action))
        h.credential_id = entry.id
    elif data.credential_id is not None:
        if not session.get(VaultEntry, data.credential_id):
            raise HTTPException(status_code=404, detail="Vault entry not found")
        h.credential_id = data.credential_id
    if data.passphrase is not None:
        h.passphrase_enc = vault.encrypt(data.passphrase) if data.passphrase else None


@router.get("/hosts")
def list_hosts(session: Session = Depends(get_session)):
    return [_host_dict(h, session) for h in session.exec(select(SshHost).order_by(SshHost.name)).all()]


@router.post("/hosts")
def create_host(data: HostIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    h = SshHost(name=data.name, address=data.address, username=data.username)
    _apply(h, data, session, user)
    session.add(h)
    session.commit()
    session.refresh(h)
    return _host_dict(h, session)


@router.put("/hosts/{host_id}")
def update_host(host_id: int, data: HostIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    h = _get(session, host_id)
    _apply(h, data, session, user)
    session.add(h)
    session.commit()
    session.refresh(h)
    return _host_dict(h, session)


@router.delete("/hosts/{host_id}")
def delete_host(host_id: int, session: Session = Depends(get_session)):
    """Removes the host; its vault entry is kept (delete it on the Vault page if unwanted)."""
    session.delete(_get(session, host_id))
    session.commit()
    return {"ok": True}


@router.post("/hosts/{host_id}/trust-reset")
def reset_host_key(host_id: int, session: Session = Depends(get_session)):
    h = _get(session, host_id)
    h.host_key = None
    session.add(h)
    session.commit()
    return {"ok": True}


@router.post("/hosts/{host_id}/test")
async def test_host(host_id: int, user: User = Depends(require_admin)):
    try:
        conn, host = await ssh.connect(host_id, user.username)
    except ssh.SshError as e:
        raise HTTPException(status_code=502, detail=str(e))
    async with conn:
        result = await conn.run("uname -srm; uptime", check=False, timeout=15)
    return {"ok": True, "output": (result.stdout or "").strip(), "fingerprint": ssh.fingerprint(host.host_key)}


class TicketIn(BaseModel):
    host_id: int


@router.post("/ticket")
def ticket(data: TicketIn, user: User = Depends(require_admin), session: Session = Depends(get_session)):
    _get(session, data.host_id)
    return {"ticket": ssh.issue_ticket(user.username, data.host_id)}


@router.get("/sessions")
def sessions(limit: int = 100, session: Session = Depends(get_session)):
    return session.exec(select(TerminalSession).order_by(TerminalSession.started_at.desc()).limit(min(limit, 500))).all()


# ── Interactive session ────────────────────────────────────────────────────────

def _end_session(session_id: int, reason: str):
    with Session(engine) as s:
        row = s.get(TerminalSession, session_id)
        if row:
            row.ended_at, row.end_reason = datetime.utcnow(), reason[:200]
            s.add(row)
            s.commit()


@ws_router.websocket("/api/terminal/ws/{host_id}")
async def terminal_ws(websocket: WebSocket, host_id: int, ticket: str = "", cols: int = 120, rows: int = 32):
    username = ssh.redeem_ticket(ticket, host_id)
    await websocket.accept()

    async def send_json(payload: dict):
        try:
            await websocket.send_text(json.dumps(payload))
        except Exception:
            pass

    if not username:
        await send_json({"type": "error", "message": "Session ticket expired — reconnect"})
        await websocket.close(code=4401)
        return

    with Session(engine) as s:
        host = s.get(SshHost, host_id)
        audit = TerminalSession(host_id=host_id, host_name=host.name if host else "?", actor=username,
                                client_ip=websocket.headers.get("x-real-ip") or (websocket.client.host if websocket.client else None))
        s.add(audit)
        s.commit()
        audit_id = audit.id

    conn = process = None
    reason = "closed"
    try:
        conn, host = await ssh.connect(host_id, username)
        process = await conn.create_process(term_type="xterm-256color", term_size=(max(cols, 20), max(rows, 5)),
                                            encoding=None)
        await send_json({"type": "connected", "host": host.name, "fingerprint": ssh.fingerprint(host.host_key)})

        async def pump_out():
            while True:
                data = await process.stdout.read(65536)
                if not data:
                    return "remote shell exited"
                await websocket.send_bytes(data)

        async def pump_in():
            while True:
                try:
                    msg = await asyncio.wait_for(websocket.receive(), timeout=IDLE_TIMEOUT)
                except asyncio.TimeoutError:
                    return "idle timeout"
                if msg["type"] == "websocket.disconnect":
                    return "browser closed"
                if msg.get("bytes"):
                    process.stdin.write(msg["bytes"])
                elif msg.get("text"):
                    m = json.loads(msg["text"])
                    if m.get("type") == "input":
                        process.stdin.write(m.get("data", "").encode())
                    elif m.get("type") == "resize":
                        process.change_terminal_size(max(int(m["cols"]), 20), max(int(m["rows"]), 5))

        tasks = [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        finished = done.pop()
        reason = finished.result() if not finished.exception() else f"error: {finished.exception()}"
        await send_json({"type": "closed", "reason": reason})
    except ssh.HostKeyChanged as e:
        reason = "host key changed"
        await send_json({"type": "error", "kind": "hostkey", "message": str(e)})
    except ssh.SshError as e:
        reason = f"connect failed: {e}"
        await send_json({"type": "error", "message": str(e)})
    except HTTPException as e:       # vault locked
        reason = str(e.detail)
        await send_json({"type": "error", "message": str(e.detail)})
    except Exception as e:
        reason = f"error: {e}"
        await send_json({"type": "error", "message": f"Unexpected error: {e}"})
    finally:
        if process:
            process.close()
        if conn:
            conn.close()
        _end_session(audit_id, reason)
        try:
            await websocket.close()
        except Exception:
            pass

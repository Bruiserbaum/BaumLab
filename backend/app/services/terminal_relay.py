"""
HTTP fallback for the web terminal, for when a reverse proxy won't pass WebSocket upgrades.

Output streams back on one long-lived HTTP response (newline-delimited JSON, unbuffered through
nginx via X-Accel-Buffering); keystrokes and resizes arrive as small POSTs. Sessions live here
between requests and are closed when the browser goes away, the shell exits, or nobody types
for IDLE_TIMEOUT.
"""
import asyncio
import base64
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Optional

from . import ssh

READER_GRACE = 60          # close a session this long after its last stream reader disconnected
HEARTBEAT = 15             # keep proxies from timing out a quiet stream
QUEUE_MAX = 2000           # output chunks buffered; a full queue pauses reading from SSH (backpressure)
IDLE_TIMEOUT = 60 * 60      # same as the WebSocket terminal: an hour without keystrokes


@dataclass
class Relay:
    id: str
    actor: str
    host_name: str
    audit_id: int
    conn: object
    process: object
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=QUEUE_MAX))
    readers: int = 0
    last_seen: float = field(default_factory=time.monotonic)
    last_input: float = field(default_factory=time.monotonic)
    closed: bool = False
    task: Optional[asyncio.Task] = None


_relays: dict[str, Relay] = {}
_reaper: Optional[asyncio.Task] = None


async def open_relay(host_id: int, actor: str, cols: int, rows: int, audit_id: int, end_session) -> Relay:
    """Connect over SSH and start pumping output. Raises ssh.SshError / ssh.HostKeyChanged."""
    global _reaper
    conn, host = await ssh.connect(host_id, actor)
    try:
        process = await conn.create_process(term_type="xterm-256color", term_size=(max(cols, 20), max(rows, 5)),
                                            encoding=None)
    except Exception:
        conn.close()
        raise
    relay = Relay(id=secrets.token_urlsafe(18), actor=actor, host_name=host.name, audit_id=audit_id,
                  conn=conn, process=process)
    _relays[relay.id] = relay
    relay.task = asyncio.create_task(_pump(relay, end_session))
    if _reaper is None or _reaper.done():
        _reaper = asyncio.create_task(_reap(end_session))
    return relay


def get(relay_id: str, actor: str) -> Optional[Relay]:
    relay = _relays.get(relay_id)
    return relay if relay and relay.actor == actor else None


async def _pump(relay: Relay, end_session):
    reason = "remote shell exited"
    try:
        while True:
            data = await relay.process.stdout.read(65536)
            if not data:
                break
            await relay.queue.put({"t": "o", "d": base64.b64encode(data).decode()})
    except asyncio.CancelledError:
        return
    except Exception as e:
        reason = f"error: {e}"
    close(relay, reason, end_session)


def close(relay: Relay, reason: str, end_session):
    if relay.closed:
        return
    relay.closed = True
    _relays.pop(relay.id, None)
    for thing in (relay.process, relay.conn):
        try:
            thing.close()
        except Exception:
            pass
    if relay.task and relay.task is not asyncio.current_task():
        relay.task.cancel()
    try:
        relay.queue.put_nowait({"t": "closed", "reason": reason})
    except asyncio.QueueFull:
        pass
    end_session(relay.audit_id, reason)


async def stream(relay: Relay):
    """Newline-delimited JSON for the browser: output chunks, heartbeats, then a final 'closed'."""
    relay.readers += 1
    try:
        while True:
            try:
                item = await asyncio.wait_for(relay.queue.get(), timeout=HEARTBEAT)
            except asyncio.TimeoutError:
                if relay.closed:
                    return
                yield '{"t":"hb"}\n'
                continue
            yield json.dumps(item) + "\n"
            if item["t"] == "closed":
                return
    finally:
        relay.readers -= 1
        relay.last_seen = time.monotonic()


def send_input(relay: Relay, data: str):
    relay.last_input = time.monotonic()
    relay.process.stdin.write(data.encode())


def resize(relay: Relay, cols: int, rows: int):
    relay.process.change_terminal_size(max(cols, 20), max(rows, 5))


async def _reap(end_session):
    while _relays:
        await asyncio.sleep(20)
        now = time.monotonic()
        for relay in list(_relays.values()):
            if relay.readers == 0 and now - relay.last_seen > READER_GRACE:
                close(relay, "browser closed", end_session)
            elif now - relay.last_input > IDLE_TIMEOUT:
                close(relay, "idle timeout", end_session)

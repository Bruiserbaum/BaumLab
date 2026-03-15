"""
Asyncio UDP syslog listener.

Handles RFC 3164 (<PRI>TIMESTAMP HOST TAG: MSG) and
RFC 5424 (<PRI>1 ISO8601 HOST APPNAME PROCID MSGID ... MSG).

Usage (in lifespan):
    transport, _proto = await start_syslog_listener(engine, port=514)
    yield
    transport.close()
"""
import asyncio
import re
from datetime import datetime
from sqlmodel import Session, select, func

from ..models.syslog import SyslogMessage

# Keep only this many rows; trim oldest on insert
MAX_SYSLOG_ROWS = 10_000

_RFC5424_RE = re.compile(
    r'^<(?P<pri>\d+)>1 (?P<ts>\S+) (?P<host>\S+) (?P<app>\S+) \S+ \S+ (?:\S+|-) (?P<msg>.*)$',
    re.DOTALL,
)
_RFC3164_RE = re.compile(
    r'^<(?P<pri>\d+)>(?P<ts>\w{3}\s+\d+ \d+:\d+:\d+) (?P<host>\S+) (?P<tag>[^:]+): ?(?P<msg>.*)$',
    re.DOTALL,
)


def _parse(raw: str, source_ip: str) -> SyslogMessage:
    text = raw.strip()
    severity, facility = 6, 1
    host, tag, message = source_ip, "", text
    timestamp = None

    # Extract <PRI>
    if text.startswith("<"):
        m5 = _RFC5424_RE.match(text)
        if m5:
            pri = int(m5.group("pri"))
            facility, severity = pri >> 3, pri & 7
            try:
                timestamp = datetime.fromisoformat(m5.group("ts").rstrip("Z"))
            except Exception:
                pass
            host = m5.group("host") if m5.group("host") != "-" else source_ip
            tag = m5.group("app") if m5.group("app") != "-" else ""
            message = m5.group("msg").strip()
        else:
            m3 = _RFC3164_RE.match(text)
            if m3:
                pri = int(m3.group("pri"))
                facility, severity = pri >> 3, pri & 7
                try:
                    ts_str = m3.group("ts")
                    now = datetime.utcnow()
                    timestamp = datetime.strptime(f"{now.year} {ts_str}", "%Y %b %d %H:%M:%S")
                except Exception:
                    pass
                host = m3.group("host")
                tag = m3.group("tag").strip()
                message = m3.group("msg").strip()
            else:
                # Bare <PRI> prefix
                end = text.index(">")
                pri = int(text[1:end])
                facility, severity = pri >> 3, pri & 7
                message = text[end + 1:].strip()

    return SyslogMessage(
        source_ip=source_ip,
        host=host,
        severity=max(0, min(7, severity)),
        facility=max(0, min(23, facility)),
        tag=tag[:255] if tag else "",
        message=message[:4096] if message else "",
        raw=raw[:4096],
        timestamp=timestamp,
    )


def _store(engine, msg: SyslogMessage):
    with Session(engine) as session:
        session.add(msg)
        # Trim to MAX_SYSLOG_ROWS
        count = session.exec(
            select(func.count()).select_from(SyslogMessage)
        ).one()
        if count > MAX_SYSLOG_ROWS:
            oldest = session.exec(
                select(SyslogMessage).order_by(SyslogMessage.received_at).limit(count - MAX_SYSLOG_ROWS)
            ).all()
            for row in oldest:
                session.delete(row)
        session.commit()


class _SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, engine, loop: asyncio.AbstractEventLoop):
        self._engine = engine
        self._loop = loop

    def datagram_received(self, data: bytes, addr):
        try:
            raw = data.decode("utf-8", errors="replace")
            msg = _parse(raw, addr[0])
            # Store in a thread executor to avoid blocking the event loop
            self._loop.run_in_executor(None, _store, self._engine, msg)
        except Exception:
            pass

    def error_received(self, exc):
        pass


async def start_syslog_listener(engine, port: int = 514):
    """Start the UDP syslog listener. Returns (transport, protocol)."""
    loop = asyncio.get_event_loop()
    transport, protocol = await loop.create_datagram_endpoint(
        lambda: _SyslogProtocol(engine, loop),
        local_addr=("0.0.0.0", port),
        family=10 if False else 2,  # AF_INET
    )
    print(f"Syslog listener running on UDP :{port}")
    return transport, protocol

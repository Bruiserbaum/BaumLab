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
from datetime import datetime, timedelta
from sqlalchemy import text
from sqlmodel import Session

from ..models.syslog import SyslogMessage
from .config_service import read_config

# Rows kept per source; trimmed by a scheduled job (see trim) instead of on every insert.
# Separate limits stop chatty container logs from pushing out network device syslog.
DEFAULT_LIMITS = {"network": 20_000, "container": 30_000, "audit": 10_000}
DEFAULT_RETENTION_DAYS = 7      # nothing older than this is kept, whatever the row limits allow


def limits() -> dict:
    cfg = read_config().get("logs", {})
    return {"network": int(cfg.get("max_network", DEFAULT_LIMITS["network"])),
            "container": int(cfg.get("max_container", DEFAULT_LIMITS["container"])),
            "audit": int(cfg.get("max_audit", DEFAULT_LIMITS["audit"]))}


def retention_days() -> int:
    return max(1, int(read_config().get("logs", {}).get("retention_days", DEFAULT_RETENTION_DAYS)))


def trim(engine) -> int:
    """Delete rows older than the retention period, then the oldest beyond each source's limit. Returns rows deleted."""
    deleted = 0
    cutoff = datetime.utcnow() - timedelta(days=retention_days())
    with engine.begin() as conn:
        deleted += conn.execute(text("DELETE FROM syslogmessage WHERE received_at < :cutoff"),
                                {"cutoff": cutoff.strftime("%Y-%m-%d %H:%M:%S.%f")}).rowcount or 0
        for source, cap in limits().items():
            result = conn.execute(text(
                "DELETE FROM syslogmessage WHERE source = :s AND id < "
                "(SELECT id FROM syslogmessage WHERE source = :s ORDER BY id DESC LIMIT 1 OFFSET :cap)"
            ), {"s": source, "cap": max(cap, 100)})
            deleted += result.rowcount or 0
    return deleted

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

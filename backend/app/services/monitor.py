"""
Monitor service — checks if hosts/services are reachable.
Called by APScheduler on each target's configured interval.
"""
import asyncio
import socket
import time
from datetime import datetime
from typing import Optional

import httpx


async def check_icmp(host: str) -> tuple[bool, Optional[float]]:
    """Ping via subprocess (icmplib requires root; this works unprivileged)."""
    loop = asyncio.get_event_loop()
    t0 = time.monotonic()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: __import__("subprocess").run(
                ["ping", "-c", "1", "-W", "2", host],
                capture_output=True, timeout=5
            )
        )
        elapsed = (time.monotonic() - t0) * 1000
        return result.returncode == 0, round(elapsed, 2)
    except Exception:
        return False, None


async def check_tcp(host: str, port: int) -> tuple[bool, Optional[float]]:
    t0 = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5
        )
        writer.close()
        await writer.wait_closed()
        return True, round((time.monotonic() - t0) * 1000, 2)
    except Exception:
        return False, None


async def check_http(host: str, port: int, https: bool = False) -> tuple[bool, Optional[float], Optional[int]]:
    scheme = "https" if https else "http"
    url = f"{scheme}://{host}:{port}/"
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=8, verify=False) as client:
            resp = await client.get(url)
            return True, round((time.monotonic() - t0) * 1000, 2), resp.status_code
    except Exception:
        return False, None, None


async def run_check(protocol: str, host: str, port: Optional[int]) -> dict:
    """Unified check dispatcher. Returns a dict ready to insert as MonitorResult."""
    is_up, latency_ms, status_code = False, None, None

    if protocol == "icmp":
        is_up, latency_ms = await check_icmp(host)
    elif protocol == "tcp" and port:
        is_up, latency_ms = await check_tcp(host, port)
    elif protocol == "http" and port:
        is_up, latency_ms, status_code = await check_http(host, port, https=False)
    elif protocol == "https" and port:
        is_up, latency_ms, status_code = await check_http(host, port, https=True)

    return {
        "checked_at": datetime.utcnow(),
        "is_up": is_up,
        "latency_ms": latency_ms,
        "status_code": status_code,
    }

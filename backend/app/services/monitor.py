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


def _reason(e: Exception, host: str, port: Optional[int]) -> str:
    """A short, human explanation of why a check failed (shown as the status tooltip)."""
    text = str(e) or type(e).__name__
    where = f"{host}:{port}" if port else host
    if isinstance(e, (asyncio.TimeoutError, httpx.TimeoutException)) or "timed out" in text.lower():
        return f"Timed out reaching {where} — host down, wrong address, or a firewall in the way"
    if isinstance(e, ConnectionRefusedError) or "refused" in text.lower():
        return f"Connection refused — nothing is listening on {where} (wrong port, or the service is stopped)"
    if "all connection attempts failed" in text.lower():
        return f"Couldn't connect to {where} — refused or unreachable (wrong port, or the service is stopped)"
    if isinstance(e, socket.gaierror) or "name or service not known" in text.lower():
        return f"Can't resolve {host}"
    return text[:300]


async def check_tcp(host: str, port: int) -> tuple[bool, Optional[float], Optional[str]]:
    t0 = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5
        )
        writer.close()
        await writer.wait_closed()
        return True, round((time.monotonic() - t0) * 1000, 2), None
    except Exception as e:
        return False, None, _reason(e, host, port)


async def _get(url: str, timeout: float):
    async with httpx.AsyncClient(timeout=timeout, verify=False) as client:
        return await client.get(url)


async def check_http(host: str, port: int, https: bool = False) -> tuple[bool, Optional[float], Optional[int], Optional[str]]:
    scheme = "https" if https else "http"
    t0 = time.monotonic()
    try:
        resp = await _get(f"{scheme}://{host}:{port}/", timeout=8)
        return True, round((time.monotonic() - t0) * 1000, 2), resp.status_code, None
    except Exception as e:
        reason = _reason(e, host, port)
        if reason.startswith(("Timed out", "Connection refused", "Couldn't connect", "Can't resolve")):
            return False, None, None, reason
    # Something answered but didn't speak the expected protocol — often a TLS port saved as http (or the reverse)
    other = "http" if https else "https"
    t0 = time.monotonic()
    try:
        resp = await _get(f"{other}://{host}:{port}/", timeout=5)
    except Exception:
        return False, None, None, f"{reason} (port {port} is open but didn't answer {scheme.upper()} or {other.upper()})"
    return (True, round((time.monotonic() - t0) * 1000, 2), resp.status_code,
            f"Answers over {other.upper()}, not {scheme.upper()} — change the protocol to {other} to clear this note")


async def run_check(protocol: str, host: str, port: Optional[int]) -> dict:
    """Unified check dispatcher. Returns a dict ready to insert as MonitorResult."""
    is_up, latency_ms, status_code, error = False, None, None, None

    if protocol == "icmp":
        is_up, latency_ms = await check_icmp(host)
        error = None if is_up else f"No ping reply from {host}"
    elif protocol == "tcp" and port:
        is_up, latency_ms, error = await check_tcp(host, port)
    elif protocol == "http" and port:
        is_up, latency_ms, status_code, error = await check_http(host, port, https=False)
    elif protocol == "https" and port:
        is_up, latency_ms, status_code, error = await check_http(host, port, https=True)

    return {
        "checked_at": datetime.utcnow(),
        "is_up": is_up,
        "latency_ms": latency_ms,
        "status_code": status_code,
        "error": error,
    }

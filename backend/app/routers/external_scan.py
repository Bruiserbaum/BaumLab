import asyncio
import socket
import urllib.request
from datetime import datetime, timezone
from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel
from ..services.auth import get_current_user

router = APIRouter(
    prefix="/api/external-scan",
    tags=["external-scan"],
    dependencies=[Depends(get_current_user)],
)

# Common ports to check with friendly service names
COMMON_PORTS = [
    (21,   "FTP"),
    (22,   "SSH"),
    (23,   "Telnet"),
    (25,   "SMTP"),
    (53,   "DNS"),
    (80,   "HTTP"),
    (110,  "POP3"),
    (143,  "IMAP"),
    (443,  "HTTPS"),
    (445,  "SMB"),
    (587,  "SMTP/TLS"),
    (993,  "IMAPS"),
    (995,  "POP3S"),
    (1194, "OpenVPN"),
    (1723, "PPTP VPN"),
    (3306, "MySQL"),
    (3389, "RDP"),
    (5900, "VNC"),
    (8080, "HTTP-Alt"),
    (8443, "HTTPS-Alt"),
]

# In-memory scan state
_port_scan_state: dict = {
    "running": False,
    "ip": "",
    "results": [],
    "started_at": None,
    "finished_at": None,
    "error": None,
}


class DnsRequest(BaseModel):
    domain: str


class PortScanRequest(BaseModel):
    ip: str


# ── External IP ───────────────────────────────────────────────────────────────

@router.get("/ip")
def get_external_ip():
    """Fetch the server's external (public) IP from ipify.org."""
    sources = [
        "https://api.ipify.org",
        "https://api4.my-ip.io/ip",
    ]
    for url in sources:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                ip = r.read().decode().strip()
                if ip:
                    return {"ip": ip, "source": url}
        except Exception:
            continue
    return {"ip": None, "error": "Could not determine external IP — check internet connectivity"}


# ── Port scan ─────────────────────────────────────────────────────────────────

def _run_port_scan(ip: str):
    """Socket-connect to each common port and record open/closed."""
    _port_scan_state.update({
        "running": True,
        "ip": ip,
        "results": [],
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "error": None,
    })
    results = []
    for port, service in COMMON_PORTS:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1.5)
            open_ = sock.connect_ex((ip, port)) == 0
            sock.close()
        except Exception:
            open_ = False
        results.append({"port": port, "service": service, "open": open_})

    _port_scan_state.update({
        "running": False,
        "results": results,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    })


@router.get("/ports/status")
def port_scan_status():
    """Return current port scan state."""
    return _port_scan_state


@router.post("/ports")
def start_port_scan(req: PortScanRequest, background_tasks: BackgroundTasks):
    """Start a background port scan against the given IP."""
    if _port_scan_state["running"]:
        return {"status": "already_running", "ip": _port_scan_state["ip"]}
    background_tasks.add_task(_run_port_scan, req.ip)
    return {"status": "scan_started", "ip": req.ip}


# ── DNS lookup ────────────────────────────────────────────────────────────────

@router.post("/dns")
def dns_lookup(req: DnsRequest):
    """Resolve a domain name and return the resolved IP(s)."""
    domain = req.domain.strip().lower()
    if not domain:
        return {"domain": domain, "resolved_ips": [], "error": "Domain is required"}
    try:
        # getaddrinfo returns all addresses (IPv4 + IPv6)
        infos = socket.getaddrinfo(domain, None)
        ips = list(dict.fromkeys(i[4][0] for i in infos))  # deduplicate, preserve order
        return {"domain": domain, "resolved_ips": ips, "error": None}
    except socket.gaierror as exc:
        return {"domain": domain, "resolved_ips": [], "error": str(exc)}

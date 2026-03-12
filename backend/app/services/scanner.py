"""
Network scanner — discovers devices on the LAN using nmap + ARP.
Requires NET_RAW capability (or host networking) in Docker.
"""
import json
import subprocess
from datetime import datetime
from typing import Optional

import nmap


def scan_network(cidr: str) -> list[dict]:
    """
    Run an nmap ARP scan + light OS/port probe on the given CIDR.
    Returns a list of device dicts ready to upsert into the DB.
    Example cidr: "192.168.1.0/24"
    """
    nm = nmap.PortScanner()
    # -sn = ping scan (host discovery only, no port scan)
    # -O requires an active port scan type and cannot be combined with -sn
    nm.scan(hosts=cidr, arguments="-sn")

    devices = []
    for host in nm.all_hosts():
        info = nm[host]
        mac = info["addresses"].get("mac", None)
        hostname = info["hostnames"][0]["name"] if info["hostnames"] else None
        vendor = info["vendor"].get(mac, None) if mac else None

        os_guess = None
        if "osmatch" in info and info["osmatch"]:
            os_guess = info["osmatch"][0]["name"]

        devices.append({
            "ip": host,
            "mac": mac,
            "hostname": hostname,
            "vendor": vendor,
            "os_guess": os_guess,
            "last_seen": datetime.utcnow(),
            "is_online": True,
        })

    return devices


def scan_ports(ip: str, port_range: str = "22,80,443,8080,8443,5000,9000") -> list[int]:
    """Quick TCP connect scan on common ports."""
    nm = nmap.PortScanner()
    nm.scan(hosts=ip, ports=port_range, arguments="-T4")
    open_ports = []
    if ip in nm.all_hosts():
        tcp = nm[ip].get("tcp", {})
        open_ports = [p for p, info in tcp.items() if info["state"] == "open"]
    return open_ports


def advanced_scan(ip: str, ports: str) -> dict:
    """
    Deep scan a single host: service/version detection + NSE scripts for
    SSL/TLS ciphers, certificate info, SMB negotiation, HTTP headers, and
    service banners.  Returns a structured dict ready for the API response.
    """
    nm = nmap.PortScanner()
    scripts = ",".join([
        "banner",
        "ssl-cert",
        "ssl-enum-ciphers",
        "http-title",
        "http-server-header",
        "smb-security-mode",
        "smb2-security-mode",
    ])
    nm.scan(hosts=ip, ports=ports, arguments=f"-sV -T4 --script={scripts}")

    if ip not in nm.all_hosts():
        return {"target": ip, "hostname": "", "os_guess": None, "ports": [], "error": "Host did not respond"}

    host    = nm[ip]
    hostname = host.hostname() or ""
    os_guess = None
    if host.get("osmatch"):
        os_guess = host["osmatch"][0]["name"]

    open_ports = []
    for proto in ("tcp", "udp"):
        if proto not in host:
            continue
        for port, info in sorted(host[proto].items()):
            if info["state"] != "open":
                continue
            scripts_out = info.get("script", {})
            open_ports.append({
                "port":         port,
                "protocol":     proto,
                "state":        info["state"],
                "service":      info.get("name", ""),
                "product":      info.get("product", ""),
                "version":      info.get("version", ""),
                "extra":        info.get("extrainfo", ""),
                "banner":       scripts_out.get("banner", ""),
                "ssl_cert":     scripts_out.get("ssl-cert", ""),
                "tls_ciphers":  scripts_out.get("ssl-enum-ciphers", ""),
                "http_title":   scripts_out.get("http-title", ""),
                "http_server":  scripts_out.get("http-server-header", ""),
                "smb_security": scripts_out.get("smb-security-mode", ""),
                "smb2_security":scripts_out.get("smb2-security-mode", ""),
            })

    return {
        "target":   ip,
        "hostname": hostname,
        "os_guess": os_guess,
        "ports":    open_ports,
        "error":    None,
    }


def guess_device_type(vendor: Optional[str], open_ports: list[int], os_guess: Optional[str]) -> Optional[str]:
    """Heuristic device classification."""
    v = (vendor or "").lower()
    o = (os_guess or "").lower()

    if any(kw in v for kw in ["ubiquiti", "ruckus", "cisco", "mikrotik", "netgear", "tp-link", "asus"]):
        if 22 in open_ports or 443 in open_ports:
            return "network-device"
    if any(kw in v for kw in ["apple"]):
        return "apple-device"
    if any(kw in v for kw in ["raspberry"]):
        return "raspberry-pi"
    if any(kw in v for kw in ["synology", "qnap", "western digital"]):
        return "nas"
    if "linux" in o and 9200 in open_ports:
        return "server"
    if 80 in open_ports or 443 in open_ports:
        return "server"
    return None

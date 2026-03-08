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
    # -O  = OS detection (needs root)
    # --osscan-guess = best-guess even with weak fingerprint
    nm.scan(hosts=cidr, arguments="-sn -O --osscan-guess")

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

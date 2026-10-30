"""
Suggest services from what BaumLab has already seen: Docker containers reported by
Portainer (best names) and open ports from device port scans (well-known port map).
Suggestions are only proposals — the user reviews and edits them before anything
is created.
"""
import json
from typing import Optional

from sqlmodel import Session, select

from ..models.device import Device
from ..models.portainer import ContainerSnapshot
from ..models.service import Service

# port → (name, category, protocol)
KNOWN_PORTS: dict[int, tuple[str, Optional[str], str]] = {
    22:    ("SSH", "Infrastructure", "ssh"),
    53:    ("DNS", "Networking", "tcp"),
    80:    ("Web (HTTP)", None, "http"),
    81:    ("Nginx Proxy Manager", "Networking", "http"),
    443:   ("Web (HTTPS)", None, "https"),
    445:   ("SMB file share", "Storage", "tcp"),
    1883:  ("MQTT broker", "Home Automation", "tcp"),
    2283:  ("Immich", "Media", "http"),
    2342:  ("PhotoPrism", "Media", "http"),
    3000:  ("Web app :3000", None, "http"),
    3001:  ("Uptime Kuma", "Monitoring", "http"),
    3100:  ("BaumLab", "Monitoring", "http"),
    3306:  ("MySQL / MariaDB", "Database", "tcp"),
    3389:  ("Remote Desktop", "Infrastructure", "tcp"),
    5000:  ("Synology DSM", "Storage", "http"),
    5001:  ("Synology DSM", "Storage", "https"),
    5432:  ("PostgreSQL", "Database", "tcp"),
    5900:  ("VNC", "Infrastructure", "tcp"),
    6379:  ("Redis", "Database", "tcp"),
    8006:  ("Proxmox VE", "Infrastructure", "https"),
    8080:  ("Web app :8080", None, "http"),
    8096:  ("Jellyfin", "Media", "http"),
    8123:  ("Home Assistant", "Home Automation", "http"),
    8384:  ("Syncthing", "Storage", "http"),
    8443:  ("UniFi Network", "Networking", "https"),
    8765:  ("BaumLabBackup", "Storage", "http"),
    8920:  ("Jellyfin (HTTPS)", "Media", "https"),
    9000:  ("Portainer", "Infrastructure", "http"),
    9001:  ("Portainer Agent", "Infrastructure", "tcp"),
    9090:  ("Cockpit / Prometheus", "Monitoring", "http"),
    9100:  ("Node exporter", "Monitoring", "http"),
    9392:  ("Greenbone (OpenVAS)", "Security", "https"),
    9443:  ("Portainer", "Infrastructure", "https"),
    11434: ("Ollama", "AI", "http"),
    32400: ("Plex", "Media", "http"),
}

# Ports passed to nmap when port-scanning devices for discovery
DISCOVERY_PORTS = ",".join(str(p) for p in sorted(KNOWN_PORTS))

# Plumbing that rarely deserves its own inventory entry — suggested but unticked
_LOW_PRIORITY_PORTS = {22, 53, 445, 3306, 3389, 5432, 5900, 6379, 9001, 9100}

# keyword in image or container name → (display name, category)
IMAGE_HINTS: list[tuple[str, str, str]] = [
    ("plex", "Plex", "Media"),
    ("jellyfin", "Jellyfin", "Media"),
    ("immich-server", "Immich", "Media"),
    ("photoprism", "PhotoPrism", "Media"),
    ("calibre-web", "Calibre-Web", "Media"),
    ("automatic-ripping-machine", "Automatic Ripping Machine", "Media"),
    ("nextcloud", "Nextcloud", "Productivity"),
    ("karakeep", "Karakeep", "Productivity"),
    ("wordpress", "WordPress", "Productivity"),
    ("heimdall", "Heimdall", "Productivity"),
    ("mailcow", "Mailcow", "Productivity"),
    ("vaultwarden", "Vaultwarden", "Security"),
    ("goauthentik", "Authentik", "Security"),
    ("authentik", "Authentik", "Security"),
    ("openvas", "OpenVAS", "Security"),
    ("greenbone", "OpenVAS", "Security"),
    ("nginx-proxy-manager", "Nginx Proxy Manager", "Networking"),
    ("jc21/", "Nginx Proxy Manager", "Networking"),
    ("portainer", "Portainer", "Infrastructure"),
    ("rustdesk", "RustDesk", "Infrastructure"),
    ("meshcentral", "MeshCentral", "Infrastructure"),
    ("uptime-kuma", "Uptime Kuma", "Monitoring"),
    ("baumlab", "BaumLab", "Monitoring"),
    ("home-assistant", "Home Assistant", "Home Automation"),
    ("homeassistant", "Home Assistant", "Home Automation"),
    ("forgejo", "Forgejo", "Development"),
    ("gitea", "Gitea", "Development"),
    ("code-server", "code-server", "Development"),
    ("ollama", "Ollama", "AI"),
    ("open-webui", "Open WebUI", "AI"),
    ("mumble", "Mumble", "Gaming"),
    ("crafty", "Crafty Controller", "Gaming"),
    ("postgres", None, "Database"),
    ("mariadb", None, "Database"),
    ("mysql", None, "Database"),
    ("redis", None, "Database"),
]


def _hint(image: str, name: str) -> tuple[Optional[str], Optional[str]]:
    haystack = f"{image} {name}".lower()
    for keyword, display, category in IMAGE_HINTS:
        if keyword in haystack:
            return display, category
    return None, None


def _primary_port(ports: list[dict]) -> Optional[dict]:
    """Pick the port a person would open: a known web port first, then the lowest TCP port."""
    tcp = [p for p in ports if p.get("proto", "tcp") == "tcp"]
    known_web = [p for p in tcp if KNOWN_PORTS.get(p["public"], ("", "", ""))[2] in ("http", "https")]
    pool = known_web or tcp or ports
    return min(pool, key=lambda p: p["public"]) if pool else None


def _protocol_for(port: Optional[int], private: Optional[int] = None) -> str:
    for p in (port, private):
        if p in KNOWN_PORTS:
            return KNOWN_PORTS[p][2]
    if port in (443, 8443, 9443) or (private in (443, 8443)):
        return "https"
    return "http"


def container_suggestion(c: ContainerSnapshot) -> dict:
    """A service proposal for one Portainer container, linked to that container."""
    try:
        ports = json.loads(c.ports) if c.ports else []
    except ValueError:
        ports = []
    display, category = _hint(c.image, c.name)
    primary = _primary_port(ports)
    port = primary["public"] if primary else None
    others = [f"{p['public']}/{p['proto']}" for p in ports if p is not primary]
    notes = f"Container {c.name} ({c.image})" + (f" · other ports: {', '.join(others)}" if others else "")
    return {
        "key": f"c:{c.connection_name}:{c.endpoint_id}:{c.container_id}",
        "source": "docker",
        "name": display or c.name,
        "_fallback_name": c.name,
        "category": category,
        "host": c.endpoint_name,
        "platform": "docker",
        "ip": c.host or None,
        "port": port,
        "protocol": _protocol_for(port, primary.get("private") if primary else None) if port else "http",
        "vlan": None,
        "notes": notes,
        "container_connection": c.connection_name,
        "container_endpoint_id": c.endpoint_id,
        "container_name": c.name,
        # Unticked by default: databases and containers nobody reaches directly
        "selected": category != "Database" and (port is not None or display is not None),
    }


def discover(session: Session) -> dict:
    existing = session.exec(select(Service)).all()
    taken_addr = {(s.ip, s.port) for s in existing if s.ip and s.port}
    taken_names = {s.name.lower() for s in existing}
    suggestions: list[dict] = []
    used_names: set[str] = set()

    def add(item: dict):
        if item["ip"] and item["port"] and (item["ip"], item["port"]) in taken_addr:
            return
        # Second Portainer / second SSH host etc. falls back to a more specific name
        fallback = item.pop("_fallback_name", item["name"])
        for candidate in (item["name"], fallback):
            if candidate.lower() not in taken_names and candidate.lower() not in used_names:
                item["name"] = candidate
                break
        else:
            return
        used_names.add(item["name"].lower())
        if item["ip"] and item["port"]:
            taken_addr.add((item["ip"], item["port"]))
        suggestions.append(item)

    # Containers first — their names beat port guesses for the same host:port
    containers = session.exec(
        select(ContainerSnapshot).where(ContainerSnapshot.state == "running")
        .order_by(ContainerSnapshot.endpoint_name, ContainerSnapshot.name)
    ).all()
    linked = {(s.container_connection, s.container_endpoint_id, s.container_name) for s in existing if s.container_name}
    for c in containers:
        if (c.connection_name, c.endpoint_id, c.name) not in linked:
            add(container_suggestion(c))

    # Device port scans — named by the well-known port map
    devices = session.exec(select(Device).order_by(Device.ip)).all()
    without_ports = 0
    for d in devices:
        try:
            open_ports = json.loads(d.open_ports) if d.open_ports else []
        except ValueError:
            open_ports = []
        if not open_ports:
            without_ports += 1
            continue
        host = d.label or d.hostname or d.ip
        for port in open_ports:
            if port not in KNOWN_PORTS:
                continue
            name, category, protocol = KNOWN_PORTS[port]
            add({
                "key": f"d:{d.id}:{port}",
                "source": "scan",
                "name": f"{name} ({host})" if port in _LOW_PRIORITY_PORTS or category is None else name,
                "_fallback_name": f"{name} ({host})",
                "category": category,
                "host": host,
                "platform": None,
                "ip": d.ip,
                "port": port,
                "protocol": protocol,
                "vlan": d.vlan,
                "notes": f"Found by port scan of {d.ip}",
                "selected": port not in _LOW_PRIORITY_PORTS,
            })

    return {
        "suggestions": suggestions,
        "containers_seen": len(containers),
        "devices_seen": len(devices),
        "devices_without_ports": without_ports,
        "scan_ports": DISCOVERY_PORTS,
    }

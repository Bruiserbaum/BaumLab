"""
Portainer REST API client.

Polls all endpoints (environments) in each configured Portainer instance
and upserts ContainerSnapshot rows into the database.
"""
import httpx
import json
from datetime import datetime
from urllib.parse import urlparse
from sqlmodel import Session, delete

from ..models.portainer import ContainerSnapshot


def _endpoint_host(endpoint_url: str, portainer_url: str) -> str:
    """Docker host address for an endpoint: tcp://10.0.0.5:9001 → 10.0.0.5. Local socket
    endpoints run on the Portainer host itself."""
    host = urlparse(endpoint_url or "").hostname if (endpoint_url or "").startswith("tcp://") else None
    return host or urlparse(portainer_url).hostname or ""


def _published_ports(ports: list[dict]) -> str:
    """JSON list of host-published ports, de-duplicated across IPv4/IPv6 bindings."""
    seen = {(p["PublicPort"], p.get("PrivatePort"), p.get("Type", "tcp")) for p in ports or [] if p.get("PublicPort")}
    return json.dumps([{"public": pub, "private": priv, "proto": proto} for pub, priv, proto in sorted(seen)])


async def fetch_containers(url: str, api_key: str) -> list[dict]:
    """
    Fetch all containers from all endpoints in a Portainer instance.
    Returns a list of dicts with keys:
      endpoint_id, endpoint_name, container_id, name, image, state, status_text, host, ports
    """
    base = url.rstrip("/")
    headers = {}
    if api_key:
        headers["X-API-Key"] = api_key

    async with httpx.AsyncClient(timeout=10.0, verify=False, headers=headers) as client:
        ep_resp = await client.get(f"{base}/api/endpoints")
        ep_resp.raise_for_status()
        endpoints = ep_resp.json()

        results = []
        for ep in endpoints:
            ep_id = ep.get("Id") or ep.get("id")
            ep_name = ep.get("Name") or ep.get("name") or f"Env {ep_id}"
            ep_host = _endpoint_host(ep.get("URL", ""), base)
            try:
                c_resp = await client.get(
                    f"{base}/api/endpoints/{ep_id}/docker/containers/json",
                    params={"all": 1}
                )
                c_resp.raise_for_status()
                for c in c_resp.json():
                    # Names come as ["/mycontainer"]
                    names = c.get("Names", [])
                    name = names[0].lstrip("/") if names else c.get("Id", "")[:12]
                    raw_id = c.get("Id", "")
                    results.append({
                        "endpoint_id": ep_id,
                        "endpoint_name": ep_name,
                        "container_id": raw_id[:12],
                        "name": name,
                        "image": c.get("Image", ""),
                        "state": c.get("State", "unknown").lower(),
                        "status_text": c.get("Status", ""),
                        "host": ep_host,
                        "ports": _published_ports(c.get("Ports", [])),
                    })
            except Exception as e:
                # Endpoint unreachable — skip it silently
                print(f"Portainer endpoint {ep_id} error: {e}")

        return results


def upsert_containers(engine, connection_name: str, containers: list[dict]):
    """Replace all snapshots for a connection with fresh data."""
    now = datetime.utcnow()
    with Session(engine) as session:
        # Delete existing snapshots for this connection
        session.exec(
            delete(ContainerSnapshot).where(ContainerSnapshot.connection_name == connection_name)
        )
        for c in containers:
            session.add(ContainerSnapshot(
                checked_at=now,
                connection_name=connection_name,
                endpoint_id=c["endpoint_id"],
                endpoint_name=c["endpoint_name"],
                container_id=c["container_id"],
                name=c["name"],
                image=c["image"],
                state=c["state"],
                status_text=c["status_text"],
                host=c.get("host", ""),
                ports=c.get("ports", ""),
            ))
        session.commit()


# ── Container actions (through Portainer's Docker API proxy) ───────────────────

ACTIONS = ("start", "stop", "restart")


def _connection(name: str) -> tuple[str, dict]:
    from .config_service import read_config, decrypt
    conn = next((c for c in read_config().get("portainer", {}).get("connections", []) if c.get("name") == name), None)
    if not conn:
        raise ValueError(f"Portainer connection '{name}' not found")
    api_key = decrypt(conn.get("api_key", ""))
    return conn["url"].rstrip("/"), ({"X-API-Key": api_key} if api_key else {})


async def container_action(connection: str, endpoint_id: int, container: str, action: str):
    if action not in ACTIONS:
        raise ValueError(f"Unsupported action {action!r}")
    base, headers = _connection(connection)
    async with httpx.AsyncClient(timeout=60.0, verify=False, headers=headers) as client:
        r = await client.post(f"{base}/api/endpoints/{endpoint_id}/docker/containers/{container}/{action}")
    # 304 = already in that state
    if r.status_code not in (204, 304):
        raise RuntimeError(f"Portainer returned HTTP {r.status_code}: {r.text[:200]}")


def _demux(raw: bytes) -> str:
    """Docker log stream without a TTY is framed: [stream, 0, 0, 0, size (4 bytes BE)] + payload."""
    if len(raw) < 8 or raw[0] not in (0, 1, 2) or raw[1:4] != b"\x00\x00\x00":
        return raw.decode(errors="replace")      # TTY container: plain text
    out, i = [], 0
    while i + 8 <= len(raw):
        size = int.from_bytes(raw[i + 4:i + 8], "big")
        out.append(raw[i + 8:i + 8 + size])
        i += 8 + size
    return b"".join(out).decode(errors="replace")


async def container_logs(connection: str, endpoint_id: int, container: str, tail: int = 200) -> str:
    base, headers = _connection(connection)
    async with httpx.AsyncClient(timeout=30.0, verify=False, headers=headers) as client:
        r = await client.get(f"{base}/api/endpoints/{endpoint_id}/docker/containers/{container}/logs",
                             params={"stdout": 1, "stderr": 1, "tail": tail, "timestamps": 1})
    if r.status_code != 200:
        raise RuntimeError(f"Portainer returned HTTP {r.status_code}: {r.text[:200]}")
    return _demux(r.content)

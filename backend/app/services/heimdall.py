"""
One-time import of Heimdall links into the Launchpad.

Reads Heimdall's SQLite database (and uploaded icons) straight out of its container via
the Docker socket — or from an uploaded app.sqlite — and proposes, per item, to attach it
to an existing service, create a service, add a bookmark, or skip.
"""
import io
import ipaddress
import os
import sqlite3
import tarfile
import tempfile
from typing import Optional
from urllib.parse import urlparse

import docker
from docker.errors import DockerException, NotFound

from ..models.service import Service
from . import icons

DB_PATHS = ["/config/www/app.sqlite", "/config/app.sqlite"]
ICON_ROOTS = ["/config/www/", "/config/www/storage/", "/var/www/localhost/heimdall/storage/app/public/",
              "/app/www/storage/app/public/"]


def _container():
    try:
        for c in docker.from_env().containers.list(all=True):
            image = (c.image.tags[0] if c.image.tags else c.attrs.get("Config", {}).get("Image", "")).lower()
            if "heimdall" in image or "heimdall" in c.name.lower():
                return c
    except DockerException as e:
        raise RuntimeError(f"Docker socket not available: {e}")
    raise RuntimeError("No Heimdall container found on this Docker host — upload its app.sqlite instead")


def _read_file(container, path: str) -> Optional[bytes]:
    try:
        stream, _ = container.get_archive(path)
    except (NotFound, DockerException):
        return None
    with tarfile.open(fileobj=io.BytesIO(b"".join(stream))) as tar:
        member = tar.next()
        if member is None or not member.isfile():
            return None
        return tar.extractfile(member).read()


def _items(db_bytes: bytes) -> list[dict]:
    fd, path = tempfile.mkstemp(suffix=".sqlite")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(db_bytes)
        con = sqlite3.connect(path)
        con.row_factory = sqlite3.Row
        try:
            cols = {r["name"] for r in con.execute("PRAGMA table_info(items)")}
            if not cols:
                raise ValueError("Not a Heimdall database (no items table)")
            deleted = "AND deleted_at IS NULL" if "deleted_at" in cols else ""
            rows = con.execute(f"SELECT * FROM items WHERE 1=1 {deleted}").fetchall()
            tags = {r["id"]: r["title"] for r in rows if "type" in cols and r["type"] == 1}
            links: dict[int, list[str]] = {}
            try:
                for r in con.execute("SELECT item_id, tag_id FROM item_tag"):
                    if r["tag_id"] in tags:
                        links.setdefault(r["item_id"], []).append(tags[r["tag_id"]])
            except sqlite3.OperationalError:
                pass
        finally:
            con.close()
    finally:
        os.remove(path)

    out = []
    for r in rows:
        if "type" in cols and r["type"] == 1:
            continue          # tags become groups, not tiles
        url = (r["url"] or "").strip()
        if not url or url.startswith("#"):
            continue
        out.append({
            "key": f"h{r['id']}",
            "title": r["title"] or url,
            "url": url,
            "icon_path": r["icon"] if "icon" in cols else None,
            "description": (r["description"] if "description" in cols else None) or None,
            "groups": links.get(r["id"], []),
        })
    return out


def _is_internal(host: str) -> bool:
    if not host:
        return False
    try:
        return ipaddress.ip_address(host).is_private
    except ValueError:
        return "." not in host or host.endswith((".local", ".lan", ".home", ".internal", ".home.arpa"))


def _host_port(url: str) -> tuple[str, Optional[int]]:
    u = urlparse(url if "://" in url else f"http://{url}")
    return (u.hostname or "").lower(), u.port


def _match(item: dict, services: list[Service]) -> Optional[Service]:
    host, port = _host_port(item["url"])
    for s in services:
        if s.url:
            sh, sp = _host_port(s.url)
            if sh == host and (sp == port or not port or not sp):
                return s
        if s.ip and s.ip == host and (not port or s.port == port):
            return s
    title = icons.slug(item["title"])
    return next((s for s in services if icons.slug(s.name) == title), None)


def preview(services: list[Service], db_bytes: Optional[bytes] = None) -> dict:
    container = None
    if db_bytes is None:
        container = _container()
        db_bytes = next((b for p in DB_PATHS if (b := _read_file(container, p))), None)
        if not db_bytes:
            raise RuntimeError(f"Couldn't find Heimdall's database in container {container.name}")
    items = _items(db_bytes)

    proposals = []
    for it in items:
        icon = None
        # Heimdall's own icon file, copied into the library (deduplicated by content)
        if container and it["icon_path"]:
            rel = it["icon_path"].lstrip("/")
            data = next((b for root in ICON_ROOTS if (b := _read_file(container, root + rel))), None)
            if data:
                try:
                    icon = icons.save_upload(data, rel)
                except ValueError:
                    icon = None
        suggested = None if icon else icons.suggest(it["title"])
        match = _match(it, services)
        host, _ = _host_port(it["url"])
        proposals.append({
            "key": it["key"],
            "title": it["title"],
            "url": it["url"],
            "description": it["description"],
            "group": (it["groups"] or ["Heimdall"])[0],
            "icon": icon,
            "suggested_icon": suggested,
            "match_id": match.id if match else None,
            "match_name": match.name if match else None,
            "action": "link" if match else ("service" if _is_internal(host) else "bookmark"),
        })
    return {"source": container.name if container else "uploaded database", "items": proposals}

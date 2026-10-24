"""
Launchpad: link tiles built from the Services inventory plus free-standing bookmarks,
with export / import and a one-time import from Heimdall.
"""
import base64
import binascii
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.bookmark import Bookmark, BookmarkIn
from ..models.service import Service
from ..models.user import User
from ..services import git_sync, heimdall, icons
from ..services.auth import get_current_user, require_admin
from ..services.config_service import read_config, write_config
from .status import public_status

router = APIRouter(prefix="/api/launchpad", tags=["launchpad"], dependencies=[Depends(get_current_user)])
# The home page's anonymous view — only tiles explicitly marked public, and only if enabled
public_router = APIRouter(prefix="/api/launchpad", tags=["launchpad"])
admin = [Depends(require_admin)]


def launch_url(s: Service) -> Optional[str]:
    if s.url:
        return s.url
    if s.ip and s.protocol in ("http", "https"):
        return f"{s.protocol}://{s.ip}{f':{s.port}' if s.port else ''}"
    return None


def _settings() -> dict:
    lp = read_config().get("launchpad", {})
    return {"public_enabled": bool(lp.get("public_enabled", False)),
            "title": lp.get("title") or "Home",
            "group_order": lp.get("group_order", [])}


def _service_tile(s: Service, status: dict) -> dict:
    return {"id": s.id, "name": s.name, "url": launch_url(s), "icon": s.icon,
            "group": s.launchpad_group or s.category or "Other", "order": s.launchpad_order, "host": s.host,
            "launchpad": s.launchpad, "public": s.launchpad_public,
            "status": status.get(s.monitor_id) if s.monitor_id else None}


@router.get("/")
def launchpad(session: Session = Depends(get_session)):
    status = {m["id"]: m["is_up"] for m in public_status(session)["monitors"]}
    services = session.exec(select(Service).where(Service.status != "decommissioned").order_by(Service.name)).all()
    return {
        "settings": _settings(),
        "services": [_service_tile(s, status) for s in services],
        "bookmarks": session.exec(select(Bookmark).order_by(Bookmark.group, Bookmark.name)).all(),
    }


@public_router.get("/public")
def public_launchpad(session: Session = Depends(get_session)):
    settings = _settings()
    if not settings["public_enabled"]:
        return {"enabled": False}
    services = session.exec(select(Service).where(
        Service.status != "decommissioned", Service.launchpad == True, Service.launchpad_public == True)).all()  # noqa: E712
    bookmarks = session.exec(select(Bookmark).where(Bookmark.public == True)).all()  # noqa: E712
    # Status dots and host names are left out for anonymous visitors
    return {
        "enabled": True, "title": settings["title"], "group_order": settings["group_order"],
        "services": [{k: v for k, v in _service_tile(s, {}).items() if k not in ("host", "status")}
                     for s in services if launch_url(s)],
        "bookmarks": [{"id": b.id, "name": b.name, "url": b.url, "icon": b.icon, "group": b.group,
                       "order": b.order, "description": b.description} for b in bookmarks],
    }


class SettingsIn(BaseModel):
    public_enabled: bool = False
    title: str = "Home"


@router.put("/settings", dependencies=admin)
def save_settings(data: SettingsIn):
    cfg = read_config()
    lp = cfg.setdefault("launchpad", {})
    lp["public_enabled"] = data.public_enabled
    lp["title"] = data.title.strip() or "Home"
    write_config(cfg)
    return _settings()


class TilePosition(BaseModel):
    kind: str                       # service | bookmark
    id: int
    group: str
    order: int


class LayoutIn(BaseModel):
    group_order: Optional[list[str]] = None
    tiles: list[TilePosition] = []


@router.put("/layout")
def save_layout(data: LayoutIn, session: Session = Depends(get_session)):
    """Persist drag-and-drop: tile groups / positions and the order of groups."""
    for t in data.tiles:
        if t.kind == "service":
            s = session.get(Service, t.id)
            if s:
                # Keep following the category unless the tile was moved to a different group
                s.launchpad_group = None if t.group == (s.category or "Other") else t.group
                s.launchpad_order = t.order
                session.add(s)
        elif t.kind == "bookmark":
            b = session.get(Bookmark, t.id)
            if b:
                b.group, b.order = t.group, t.order
                session.add(b)
    session.commit()
    if data.group_order is not None:
        cfg = read_config()
        cfg.setdefault("launchpad", {})["group_order"] = data.group_order
        write_config(cfg)
    return {"ok": True}


# ── Bookmarks ──────────────────────────────────────────────────────────────────

@router.post("/bookmarks")
def create_bookmark(data: BookmarkIn, session: Session = Depends(get_session)):
    b = Bookmark(**data.model_dump())
    session.add(b)
    session.commit()
    session.refresh(b)
    return b


@router.put("/bookmarks/{bookmark_id}")
def update_bookmark(bookmark_id: int, data: BookmarkIn, session: Session = Depends(get_session)):
    b = session.get(Bookmark, bookmark_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    for k, v in data.model_dump().items():
        setattr(b, k, v)
    session.add(b)
    session.commit()
    session.refresh(b)
    return b


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int, session: Session = Depends(get_session)):
    b = session.get(Bookmark, bookmark_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    session.delete(b)
    session.commit()
    return {"ok": True}


class TileUpdate(BaseModel):
    icon: Optional[str] = None
    launchpad: Optional[bool] = None
    public: Optional[bool] = None


def _check_public(data: TileUpdate, user: User):
    if data.public is not None and not user.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can change what's public")


@router.patch("/services/{service_id}")
def update_service_tile(service_id: int, data: TileUpdate, user: User = Depends(get_current_user),
                        session: Session = Depends(get_session)):
    """Change a service's icon / visibility from the Launchpad without the full service form."""
    _check_public(data, user)
    s = session.get(Service, service_id)
    if not s:
        raise HTTPException(status_code=404, detail="Service not found")
    if data.icon is not None:
        s.icon = data.icon or None
    if data.launchpad is not None:
        s.launchpad = data.launchpad
    if data.public is not None:
        s.launchpad_public = data.public
    session.add(s)
    session.commit()
    return {"ok": True}


@router.patch("/bookmarks/{bookmark_id}")
def update_bookmark_tile(bookmark_id: int, data: TileUpdate, user: User = Depends(get_current_user),
                         session: Session = Depends(get_session)):
    _check_public(data, user)
    b = session.get(Bookmark, bookmark_id)
    if not b:
        raise HTTPException(status_code=404, detail="Bookmark not found")
    if data.icon is not None:
        b.icon = data.icon or None
    if data.public is not None:
        b.public = data.public
    session.add(b)
    session.commit()
    return {"ok": True}


# ── Export / import ────────────────────────────────────────────────────────────

@router.get("/export", dependencies=admin)
def export(session: Session = Depends(get_session)):
    """Portable Launchpad: tiles, bookmarks and the icon files themselves (base64)."""
    services = session.exec(select(Service).where(Service.status != "decommissioned")).all()
    bookmarks = session.exec(select(Bookmark)).all()
    used = {x.icon for x in [*services, *bookmarks] if x.icon}
    return {
        "format": "baumlab-launchpad", "version": 2, "exported_at": datetime.utcnow().isoformat() + "Z",
        "settings": _settings(),
        "services": [{"name": s.name, "url": launch_url(s), "category": s.category, "icon": s.icon,
                      "launchpad": s.launchpad, "group": s.launchpad_group, "order": s.launchpad_order,
                      "public": s.launchpad_public} for s in services],
        "bookmarks": [{"name": b.name, "url": b.url, "group": b.group, "icon": b.icon, "description": b.description,
                       "order": b.order, "public": b.public} for b in bookmarks],
        "icons": {name: base64.b64encode(data).decode() for name in sorted(used) if (data := icons.read(name))},
    }


class ImportIn(BaseModel):
    format: str
    services: list[dict] = []
    bookmarks: list[dict] = []
    icons: dict[str, str] = {}
    settings: Optional[dict] = None
    create_services: bool = True


@router.post("/import", dependencies=admin)
def import_launchpad(data: ImportIn, session: Session = Depends(get_session)):
    if data.format != "baumlab-launchpad":
        raise HTTPException(status_code=400, detail="Not a BaumLab Launchpad export")
    # Icons are re-stored under content hashes; map old names → new
    renamed = {}
    for name, b64 in data.icons.items():
        try:
            renamed[name] = icons.save_upload(base64.b64decode(b64), name)
        except (ValueError, binascii.Error):
            pass
    counts = {"services_updated": 0, "services_created": 0, "bookmarks": 0}
    existing = {icons.slug(s.name): s for s in session.exec(select(Service)).all()}
    for item in data.services:
        icon = renamed.get(item.get("icon"))
        s = existing.get(icons.slug(item.get("name", "")))
        if s:
            s.icon = s.icon or icon
            s.url = s.url or item.get("url")
            counts["services_updated"] += 1
        elif data.create_services and item.get("name"):
            s = Service(name=item["name"], url=item.get("url"), category=item.get("category"), icon=icon,
                        launchpad=item.get("launchpad", True), notes="Imported from a Launchpad export")
            counts["services_created"] += 1
            git_sync.queue_change(f"Add {s.name} (Launchpad import)")
        else:
            continue
        # Layout and public visibility travel with the export (version 2+)
        s.launchpad_group = item.get("group") or s.launchpad_group
        s.launchpad_order = item.get("order", s.launchpad_order)
        s.launchpad_public = item.get("public", s.launchpad_public)
        session.add(s)
    have = {(b.name, b.url) for b in session.exec(select(Bookmark)).all()}
    for item in data.bookmarks:
        if not item.get("name") or not item.get("url") or (item["name"], item["url"]) in have:
            continue
        session.add(Bookmark(name=item["name"], url=item["url"], group=item.get("group") or "Bookmarks",
                             icon=renamed.get(item.get("icon")), description=item.get("description"),
                             order=item.get("order", 0), public=item.get("public", False)))
        counts["bookmarks"] += 1
    session.commit()
    if data.settings and data.settings.get("group_order"):
        cfg = read_config()
        cfg.setdefault("launchpad", {})["group_order"] = data.settings["group_order"]
        write_config(cfg)
    return counts


# ── Heimdall ───────────────────────────────────────────────────────────────────

@router.post("/heimdall/preview", dependencies=admin)
async def heimdall_preview(file: Optional[UploadFile] = File(None), session: Session = Depends(get_session)):
    services = session.exec(select(Service).where(Service.status != "decommissioned")).all()
    db = await file.read() if file else None
    try:
        return heimdall.preview(services, db)
    except (RuntimeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))


class HeimdallItem(BaseModel):
    action: str                     # link | service | bookmark | skip
    title: str
    url: str
    group: str = "Heimdall"
    description: Optional[str] = None
    icon: Optional[str] = None
    suggested_icon: Optional[str] = None
    match_id: Optional[int] = None


@router.post("/heimdall/apply", dependencies=admin)
def heimdall_apply(items: list[HeimdallItem], session: Session = Depends(get_session)):
    counts = {"linked": 0, "services": 0, "bookmarks": 0}
    for it in items:
        if it.action == "skip":
            continue
        icon = it.icon if it.icon and icons.file_path(it.icon) else None
        if not icon and it.suggested_icon:
            try:
                icon = icons.fetch(it.suggested_icon)
            except Exception:
                icon = None
        if it.action == "link" and it.match_id:
            s = session.get(Service, it.match_id)
            if not s:
                continue
            s.icon = s.icon or icon
            s.url = s.url or it.url
            s.launchpad = True
            session.add(s)
            counts["linked"] += 1
        elif it.action == "service":
            s = Service(name=it.title, url=it.url, category=it.group if it.group != "Heimdall" else None,
                        icon=icon, notes=it.description or "Imported from Heimdall")
            session.add(s)
            git_sync.queue_change(f"Add {s.name} (Heimdall import)")
            counts["services"] += 1
        elif it.action == "bookmark":
            session.add(Bookmark(name=it.title, url=it.url, group=it.group, icon=icon, description=it.description))
            counts["bookmarks"] += 1
    session.commit()
    return counts

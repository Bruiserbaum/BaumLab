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
from ..services import git_sync, heimdall, icons
from ..services.auth import get_current_user, require_admin
from .status import public_status

router = APIRouter(prefix="/api/launchpad", tags=["launchpad"], dependencies=[Depends(get_current_user)])
admin = [Depends(require_admin)]


def launch_url(s: Service) -> Optional[str]:
    if s.url:
        return s.url
    if s.ip and s.protocol in ("http", "https"):
        return f"{s.protocol}://{s.ip}{f':{s.port}' if s.port else ''}"
    return None


@router.get("/")
def launchpad(session: Session = Depends(get_session)):
    status = {m["id"]: m["is_up"] for m in public_status(session)["monitors"]}
    services = session.exec(select(Service).where(Service.status != "decommissioned").order_by(Service.name)).all()
    return {
        "services": [
            {"id": s.id, "name": s.name, "url": launch_url(s), "icon": s.icon, "group": s.category or "Other",
             "host": s.host, "launchpad": s.launchpad, "status": status.get(s.monitor_id) if s.monitor_id else None}
            for s in services
        ],
        "bookmarks": session.exec(select(Bookmark).order_by(Bookmark.group, Bookmark.name)).all(),
    }


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


@router.patch("/services/{service_id}")
def update_service_tile(service_id: int, data: TileUpdate, session: Session = Depends(get_session)):
    """Change a service's icon / visibility from the Launchpad without the full service form."""
    s = session.get(Service, service_id)
    if not s:
        raise HTTPException(status_code=404, detail="Service not found")
    if data.icon is not None:
        s.icon = data.icon or None
    if data.launchpad is not None:
        s.launchpad = data.launchpad
    session.add(s)
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
        "format": "baumlab-launchpad", "version": 1, "exported_at": datetime.utcnow().isoformat() + "Z",
        "services": [{"name": s.name, "url": launch_url(s), "category": s.category, "icon": s.icon,
                      "launchpad": s.launchpad} for s in services],
        "bookmarks": [{"name": b.name, "url": b.url, "group": b.group, "icon": b.icon, "description": b.description}
                      for b in bookmarks],
        "icons": {name: base64.b64encode(data).decode() for name in sorted(used) if (data := icons.read(name))},
    }


class ImportIn(BaseModel):
    format: str
    services: list[dict] = []
    bookmarks: list[dict] = []
    icons: dict[str, str] = {}
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
        session.add(s)
    have = {(b.name, b.url) for b in session.exec(select(Bookmark)).all()}
    for item in data.bookmarks:
        if not item.get("name") or not item.get("url") or (item["name"], item["url"]) in have:
            continue
        session.add(Bookmark(name=item["name"], url=item["url"], group=item.get("group") or "Bookmarks",
                             icon=renamed.get(item.get("icon")), description=item.get("description")))
        counts["bookmarks"] += 1
    session.commit()
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

import os
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.bookmark import Bookmark
from ..models.service import Service
from ..services import icons
from ..services.auth import get_current_user, require_admin

# No router-level auth: <img> tags can't send the bearer token, so icon files are public
# (they're app logos). Everything else here requires login.
router = APIRouter(prefix="/api/icons", tags=["icons"])
auth = [Depends(get_current_user)]


@router.get("/file/{name}")
def icon_file(name: str):
    path = icons.file_path(name)
    if not path:
        raise HTTPException(status_code=404, detail="Icon not found")
    ext = os.path.splitext(name)[1].lower()
    return FileResponse(path, media_type=icons.ALLOWED[ext], headers={
        "Cache-Control": "public, max-age=604800",
        # An uploaded SVG opened directly must not be able to run script on this origin
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        "X-Content-Type-Options": "nosniff",
    })


@router.get("/search", dependencies=auth)
def search(q: str):
    try:
        return icons.search(q)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/suggest", dependencies=auth)
def suggest(name: str):
    return {"name": icons.suggest(name)}


class FetchIn(BaseModel):
    name: str
    format: Optional[str] = None


@router.post("/fetch", dependencies=auth)
def fetch(data: FetchIn):
    try:
        return {"file": icons.fetch(data.name, data.format)}
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Download failed: {e}")


@router.post("/upload", dependencies=auth)
async def upload(file: UploadFile = File(...)):
    try:
        return {"file": icons.save_upload(await file.read(), file.filename or "")}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/auto-assign", dependencies=[Depends(require_admin)])
def auto_assign(session: Session = Depends(get_session)):
    """Give every service and bookmark without an icon the best dashboard-icons match."""
    assigned, missing = [], []
    targets = [*session.exec(select(Service).where(Service.icon == None)).all(),   # noqa: E711
               *session.exec(select(Bookmark).where(Bookmark.icon == None)).all()]  # noqa: E711
    for t in targets:
        name = icons.suggest(t.name)
        if not name:
            missing.append(t.name)
            continue
        try:
            t.icon = icons.fetch(name)
        except Exception:
            missing.append(t.name)
            continue
        session.add(t)
        assigned.append(t.name)
    session.commit()
    return {"assigned": assigned, "missing": missing}

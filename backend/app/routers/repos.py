from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..models.repo import RepoSnapshot
from ..services.auth import get_current_user
from ..services import repo_tracker

router = APIRouter(prefix="/api/repos", tags=["repos"], dependencies=[Depends(get_current_user)])


@router.get("/")
def list_repos(session: Session = Depends(get_session)):
    repos = session.exec(select(RepoSnapshot).order_by(RepoSnapshot.source, RepoSnapshot.full_name)).all()
    errors = repo_tracker.errors()
    sources = []
    for s in repo_tracker.get_sources():
        mine = [r for r in repos if r.source == s["name"]]
        sources.append({
            "name": s["name"],
            "type": s["type"],
            "count": len(mine),
            "checked_at": max((r.checked_at for r in mine), default=None),
            "error": errors.get(s["name"]),
        })
    return {"sources": sources, "repos": repos, "refreshing": repo_tracker.is_refreshing()}


@router.post("/refresh")
async def refresh():
    await repo_tracker.refresh_all()
    return {"ok": True}

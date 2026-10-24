from fastapi import APIRouter, Depends, HTTPException

from ..services.auth import get_current_user, require_admin
from ..services import git_sync

router = APIRouter(prefix="/api/git-sync", tags=["git-sync"], dependencies=[Depends(get_current_user)])


@router.get("/status")
def get_status():
    return git_sync.status()


@router.post("/sync")
async def sync_now():
    try:
        return await git_sync.sync()
    except git_sync.GitSyncError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/test", dependencies=[Depends(require_admin)])
async def test_connection():
    try:
        return await git_sync.test_connection()
    except git_sync.GitSyncError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Forgejo: {e}")

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..services.auth import require_admin
from ..services import updater

router = APIRouter(prefix="/api/updates", tags=["updates"], dependencies=[Depends(require_admin)])


class ApplyIn(BaseModel):
    tag: Optional[str] = None   # default: latest tag from the last check


@router.get("/status")
def get_status():
    return updater.status()


@router.post("/check")
async def check_now():
    try:
        return await updater.check()
    except updater.UpdateError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/stacks")
async def list_stacks(connection: str):
    try:
        return await updater.list_stacks(connection)
    except updater.UpdateError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/apply")
async def apply_update(body: ApplyIn):
    tag = body.tag or updater.status()["latest_tag"]
    if not tag:
        raise HTTPException(status_code=400, detail="No release found yet — run a check first")
    try:
        await updater.apply(tag)
    except updater.UpdateError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "started", "tag": tag}

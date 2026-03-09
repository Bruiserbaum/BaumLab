from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from ..models.monitor import MonitorTarget, MonitorTargetCreate, MonitorResult
from ..database import get_session
from ..services.auth import get_current_user

router = APIRouter(prefix="/api/monitors", tags=["monitors"], dependencies=[Depends(get_current_user)])


@router.get("/", response_model=list[MonitorTarget])
def list_targets(session: Session = Depends(get_session)):
    return session.exec(select(MonitorTarget).order_by(MonitorTarget.name)).all()


@router.post("/", response_model=MonitorTarget)
def create_target(data: MonitorTargetCreate, session: Session = Depends(get_session)):
    target = MonitorTarget(**data.model_dump())
    session.add(target)
    session.commit()
    session.refresh(target)
    return target


@router.patch("/{target_id}", response_model=MonitorTarget)
def update_target(target_id: int, data: MonitorTargetCreate, session: Session = Depends(get_session)):
    target = session.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Monitor target not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(target, field, value)
    session.add(target)
    session.commit()
    session.refresh(target)
    return target


@router.delete("/{target_id}")
def delete_target(target_id: int, session: Session = Depends(get_session)):
    target = session.get(MonitorTarget, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Monitor target not found")
    session.delete(target)
    session.commit()
    return {"ok": True}


@router.get("/{target_id}/results", response_model=list[MonitorResult])
def get_results(target_id: int, limit: int = 100, session: Session = Depends(get_session)):
    results = session.exec(
        select(MonitorResult)
        .where(MonitorResult.target_id == target_id)
        .order_by(MonitorResult.checked_at.desc())
        .limit(limit)
    ).all()
    return results

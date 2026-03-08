from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from ..models.device import Device, DeviceUpdate
from ..database import get_session

router = APIRouter(prefix="/api/devices", tags=["devices"])


@router.get("/", response_model=list[Device])
def list_devices(session: Session = Depends(get_session)):
    return session.exec(select(Device).order_by(Device.ip)).all()


@router.get("/{device_id}", response_model=Device)
def get_device(device_id: int, session: Session = Depends(get_session)):
    device = session.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=Device)
def update_device(device_id: int, update: DeviceUpdate, session: Session = Depends(get_session)):
    device = session.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    for field, value in update.model_dump(exclude_unset=True).items():
        setattr(device, field, value)
    session.add(device)
    session.commit()
    session.refresh(device)
    return device


@router.delete("/{device_id}")
def delete_device(device_id: int, session: Session = Depends(get_session)):
    device = session.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    session.delete(device)
    session.commit()
    return {"ok": True}

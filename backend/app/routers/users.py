from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from ..database import get_session
from ..models.user import User, UserPublic, UserCreate, UserUpdateSelf, UserUpdateAdmin
from ..services.auth import hash_password, get_current_user, require_admin

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/", response_model=list[UserPublic])
def list_users(_: User = Depends(require_admin), session: Session = Depends(get_session)):
    return session.exec(select(User).order_by(User.username)).all()


@router.post("/", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
def create_user(
    data: UserCreate,
    _: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    if session.exec(select(User).where(User.username == data.username)).first():
        raise HTTPException(status_code=400, detail="Username already taken")
    user = User(
        username=data.username,
        hashed_password=hash_password(data.password),
        is_admin=data.is_admin,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserPublic)
def update_user(
    user_id: int,
    data: UserUpdateAdmin,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    # Non-admins can only edit themselves, and cannot change is_admin
    if not current_user.is_admin:
        if current_user.id != user_id:
            raise HTTPException(status_code=403, detail="Cannot edit another user's account")
        if data.is_admin is not None:
            raise HTTPException(status_code=403, detail="Cannot change admin status")

    if data.username is not None:
        existing = session.exec(select(User).where(User.username == data.username)).first()
        if existing and existing.id != user_id:
            raise HTTPException(status_code=400, detail="Username already taken")
        target.username = data.username

    if data.password is not None:
        target.hashed_password = hash_password(data.password)

    if current_user.is_admin and data.is_admin is not None:
        # Prevent an admin from removing their own admin status
        if target.id == current_user.id and not data.is_admin:
            raise HTTPException(status_code=400, detail="Cannot remove your own admin status")
        target.is_admin = data.is_admin

    session.add(target)
    session.commit()
    session.refresh(target)
    return target


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    session: Session = Depends(get_session),
):
    if current_user.id == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    session.delete(target)
    session.commit()

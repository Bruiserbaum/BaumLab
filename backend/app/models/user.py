from typing import Optional
from datetime import datetime
from sqlmodel import SQLModel, Field
from pydantic import BaseModel


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    hashed_password: str
    is_admin: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    totp_secret: Optional[str] = Field(default=None)
    totp_enabled: bool = Field(default=False)


class UserPublic(BaseModel):
    """Safe user representation — never exposes hashed_password or totp_secret."""
    id: int
    username: str
    is_admin: bool
    totp_enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    username: str
    password: str
    is_admin: bool = False


class UserUpdateSelf(BaseModel):
    """Fields a user can change about themselves."""
    username: Optional[str] = None
    password: Optional[str] = None


class UserUpdateAdmin(UserUpdateSelf):
    """Fields an admin can additionally change."""
    is_admin: Optional[bool] = None

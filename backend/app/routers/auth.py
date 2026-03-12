import base64
import io

import pyotp
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..database import get_session
from ..models.user import User, UserPublic
from ..services.auth import (
    verify_password,
    create_access_token,
    create_mfa_token,
    verify_mfa_token,
    get_current_user,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Login ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, session: Session = Depends(get_session)):
    # Strip whitespace so copy-paste from Portainer / password managers can't break auth
    username = body.username.strip()
    password = body.password.strip()

    user = session.exec(select(User).where(User.username == username)).first()
    if not user or not verify_password(password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
        )

    if user.totp_enabled:
        return {"mfa_required": True, "mfa_token": create_mfa_token(user.id)}

    return {"access_token": create_access_token(user.id), "token_type": "bearer"}


class MfaLoginRequest(BaseModel):
    mfa_token: str
    code: str


@router.post("/login/mfa")
def login_mfa(body: MfaLoginRequest, session: Session = Depends(get_session)):
    user_id = verify_mfa_token(body.mfa_token)
    user = session.get(User, user_id)
    if not user or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid MFA state")

    totp = pyotp.TOTP(user.totp_secret)
    if not totp.verify(body.code.strip(), valid_window=1):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication code")

    return {"access_token": create_access_token(user.id), "token_type": "bearer"}


# ── Current user ──────────────────────────────────────────────────────────────

@router.get("/me", response_model=UserPublic)
def me(current_user: User = Depends(get_current_user)):
    return current_user


# ── MFA setup / management ────────────────────────────────────────────────────

@router.get("/mfa/setup")
def mfa_setup(current_user: User = Depends(get_current_user)):
    """Generate a fresh TOTP secret + QR code. User must confirm with /mfa/enable."""
    secret = pyotp.random_base32()
    uri = pyotp.TOTP(secret).provisioning_uri(
        name=current_user.username, issuer_name="BaumLab"
    )
    img = qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    qr_b64 = base64.b64encode(buf.getvalue()).decode()
    return {
        "secret": secret,
        "uri": uri,
        "qr": f"data:image/svg+xml;base64,{qr_b64}",
    }


class MfaEnableRequest(BaseModel):
    secret: str
    code: str


@router.post("/mfa/enable")
def mfa_enable(
    body: MfaEnableRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Verify the TOTP code against the provided secret, then persist and enable MFA."""
    totp = pyotp.TOTP(body.secret)
    if not totp.verify(body.code.strip(), valid_window=1):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid code — check your authenticator app and try again",
        )
    current_user.totp_secret  = body.secret
    current_user.totp_enabled = True
    session.add(current_user)
    session.commit()
    return {"status": "mfa_enabled"}


class MfaDisableRequest(BaseModel):
    password: str


@router.post("/mfa/disable")
def mfa_disable(
    body: MfaDisableRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Require password confirmation before disabling MFA."""
    if not verify_password(body.password.strip(), current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect password")
    current_user.totp_secret  = None
    current_user.totp_enabled = False
    session.add(current_user)
    session.commit()
    return {"status": "mfa_disabled"}

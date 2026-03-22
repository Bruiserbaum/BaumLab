import base64
import io
import os
import secrets
from datetime import datetime, timedelta
from urllib.parse import urlencode

import httpx
import pyotp
import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from jose import jwt as jose_jwt, JWTError
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
    SECRET_KEY,
    ALGORITHM,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/version")
def version():
    from ..main import APP_VERSION
    return {"version": APP_VERSION}

# ── OIDC config ───────────────────────────────────────────────────────────────
_OIDC_ENABLED           = os.getenv("OIDC_ENABLED", "false").lower() == "true"
_HEADER_AUTH_ENABLED    = os.getenv("AUTHENTIK_HEADER_AUTH", "false").lower() == "true"
_OIDC_ISSUER        = os.getenv("OIDC_ISSUER", "").rstrip("/") + "/"
_OIDC_CLIENT_ID     = os.getenv("OIDC_CLIENT_ID", "")
_OIDC_CLIENT_SECRET = os.getenv("OIDC_CLIENT_SECRET", "")
_OIDC_REDIRECT_URI  = os.getenv("OIDC_REDIRECT_URI", "")
_OIDC_FRONTEND_URL  = os.getenv("OIDC_FRONTEND_URL", "").rstrip("/")

_oidc_discovery: dict = {}


def _get_oidc_discovery() -> dict:
    global _oidc_discovery
    if _oidc_discovery:
        return _oidc_discovery
    url = _OIDC_ISSUER + ".well-known/openid-configuration"
    resp = httpx.get(url, timeout=10)
    resp.raise_for_status()
    _oidc_discovery = resp.json()
    return _oidc_discovery


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


# ── OIDC / Authentik SSO ──────────────────────────────────────────────────────

@router.get("/config")
def auth_config():
    """Public endpoint — returns which auth methods are available."""
    return {"oidc_enabled": _OIDC_ENABLED, "header_auth_enabled": _HEADER_AUTH_ENABLED}


@router.get("/header-login")
def header_login(request: Request, session: Session = Depends(get_session)):
    """Called by the frontend on page load when Authentik forward auth is active.
    Reads the X-authentik-username header injected by NPM and issues a local JWT,
    creating a user account on first visit. Requires AUTHENTIK_HEADER_AUTH=true."""
    if not _HEADER_AUTH_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Header auth is not enabled")
    username = request.headers.get("X-authentik-username", "").strip()
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No Authentik header present")
    user = session.exec(select(User).where(User.username == username)).first()
    if not user:
        user = User(username=username, hashed_password="", is_admin=True)
        session.add(user)
        session.commit()
        session.refresh(user)
    return {"access_token": create_access_token(user.id), "token_type": "bearer"}


@router.get("/oidc/login")
def oidc_login():
    """Redirect the browser to Authentik's authorization endpoint."""
    if not _OIDC_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OIDC is not enabled")
    # Short-lived state JWT for CSRF protection
    expire = datetime.utcnow() + timedelta(minutes=10)
    state = jose_jwt.encode(
        {"nonce": secrets.token_urlsafe(16), "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM,
    )
    discovery = _get_oidc_discovery()
    params = urlencode({
        "response_type": "code",
        "client_id": _OIDC_CLIENT_ID,
        "redirect_uri": _OIDC_REDIRECT_URI,
        "scope": "openid profile email",
        "state": state,
    })
    return RedirectResponse(f"{discovery['authorization_endpoint']}?{params}", status_code=302)


@router.get("/oidc/callback")
def oidc_callback(
    code: str = None,
    state: str = None,
    error: str = None,
    session: Session = Depends(get_session),
):
    """Authentik redirects here after login. Exchange code, find/create user, issue JWT."""
    base = _OIDC_FRONTEND_URL  # e.g. "" (same origin) or "http://server:3100"

    if error:
        return RedirectResponse(f"{base}/?oidc_error={error}")
    if not code or not state:
        return RedirectResponse(f"{base}/?oidc_error=missing_params")

    # Verify CSRF state
    try:
        jose_jwt.decode(state, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return RedirectResponse(f"{base}/?oidc_error=invalid_state")

    # Exchange code for tokens + fetch userinfo
    try:
        discovery = _get_oidc_discovery()
        with httpx.Client(timeout=10) as client:
            token_resp = client.post(
                discovery["token_endpoint"],
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _OIDC_REDIRECT_URI,
                    "client_id": _OIDC_CLIENT_ID,
                    "client_secret": _OIDC_CLIENT_SECRET,
                },
            )
            token_resp.raise_for_status()
            access_token = token_resp.json()["access_token"]

            userinfo_resp = client.get(
                discovery["userinfo_endpoint"],
                headers={"Authorization": f"Bearer {access_token}"},
            )
            userinfo_resp.raise_for_status()
            userinfo = userinfo_resp.json()
    except Exception:
        return RedirectResponse(f"{base}/?oidc_error=token_exchange_failed")

    sub = userinfo.get("sub")
    if not sub:
        return RedirectResponse(f"{base}/?oidc_error=no_sub")

    # Find or create local user
    user = session.exec(select(User).where(User.oidc_sub == sub)).first()
    if not user:
        preferred = userinfo.get("preferred_username") or userinfo.get("email") or sub
        username = preferred
        counter = 1
        while session.exec(select(User).where(User.username == username)).first():
            username = f"{preferred}_{counter}"
            counter += 1
        user = User(username=username, hashed_password="", oidc_sub=sub, is_admin=True)
        session.add(user)
        session.commit()
        session.refresh(user)

    local_token = create_access_token(user.id)
    return RedirectResponse(f"{base}/?token={local_token}", status_code=302)

"""
Credential vault encryption and safety checks.

Secrets are encrypted with a key derived from VAULT_KEY (or SECRET_KEY when unset).
The key lives only in the container environment, so a copy of the database or
config folder alone reveals nothing. Changing the key makes existing entries
unreadable — back it up.
"""
import base64
import hashlib
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, status

from .auth import SECRET_KEY, DEFAULT_SECRET_KEY, HEADER_AUTH_ENABLED, PROXY_SECRET

VAULT_KEY = os.getenv("VAULT_KEY", "").strip()


def _fernet() -> Fernet:
    # Domain-separated from config_service's key so the two never share ciphertext keys
    raw = hashlib.sha256(b"baumlab-vault:" + (VAULT_KEY or SECRET_KEY).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Cannot decrypt this entry — VAULT_KEY / SECRET_KEY has changed since it was saved",
        )


def key_source() -> str:
    return "VAULT_KEY" if VAULT_KEY else "SECRET_KEY"


def lock_reason() -> Optional[str]:
    """Why the vault refuses to operate, or None if it is safe to use."""
    if DEFAULT_SECRET_KEY:
        return "SECRET_KEY is still the default value, so login tokens can be forged. Set a real SECRET_KEY."
    if HEADER_AUTH_ENABLED and not PROXY_SECRET:
        return ("Authentik header login is on without AUTHENTIK_PROXY_SECRET, so the login header can be "
                "forged by anyone who reaches BaumLab's ports directly. Set AUTHENTIK_PROXY_SECRET.")
    return None


def require_unlocked():
    reason = lock_reason()
    if reason:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"Vault locked: {reason}")

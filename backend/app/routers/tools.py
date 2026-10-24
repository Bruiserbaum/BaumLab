"""
Home lab helper tools that need server-side crypto. Simple random keys are generated
in the browser; these cover hashing and key formats the browser can't do reliably.
Nothing generated here is stored or logged.
"""
import base64
import secrets
import string
from typing import Optional

from argon2 import PasswordHasher
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization
from fastapi import APIRouter, Depends
from passlib.hash import bcrypt
from pydantic import BaseModel

from ..services.auth import get_current_user

router = APIRouter(prefix="/api/tools", tags=["tools"], dependencies=[Depends(get_current_user)])

# Matches `argon2 ... -e -id -k 65540 -t 3 -p 4` (Vaultwarden's documented OWASP preset)
_vaultwarden_hasher = PasswordHasher(time_cost=3, memory_cost=65540, parallelism=4, hash_len=32, salt_len=16)
_ALNUM = string.ascii_letters + string.digits


class PasswordIn(BaseModel):
    password: Optional[str] = None   # blank = generate one


class HtpasswdIn(BaseModel):
    username: str
    password: Optional[str] = None


def _random_password(length: int = 32) -> str:
    return "".join(secrets.choice(_ALNUM) for _ in range(length))


@router.post("/vaultwarden-token")
def vaultwarden_token(body: PasswordIn):
    """Argon2id PHC string for Vaultwarden's ADMIN_TOKEN plus the password to log in with."""
    password = body.password or _random_password()
    phc = _vaultwarden_hasher.hash(password)
    return {
        "password": password,
        "phc": phc,
        # $ must be doubled when the value goes straight into docker-compose.yml
        "phc_compose": phc.replace("$", "$$"),
    }


@router.post("/htpasswd")
def htpasswd(body: HtpasswdIn):
    """bcrypt htpasswd line for NPM access lists, Traefik basicauth, nginx auth_basic."""
    password = body.password or _random_password(24)
    line = f"{body.username}:{bcrypt.using(ident='2y', rounds=12).hash(password)}"
    return {"password": password, "line": line, "line_compose": line.replace("$", "$$")}


@router.post("/wireguard")
def wireguard_keypair():
    key = X25519PrivateKey.generate()
    private = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {
        "private_key": base64.b64encode(private).decode(),
        "public_key": base64.b64encode(public).decode(),
        "preshared_key": base64.b64encode(secrets.token_bytes(32)).decode(),
    }

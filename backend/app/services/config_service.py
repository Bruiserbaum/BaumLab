"""
Config read/write with Fernet encryption for sensitive fields.
Uses the same SECRET_KEY as JWT — already required at deployment.
"""
import base64
import hashlib
import os
from pathlib import Path

import yaml
from cryptography.fernet import Fernet

CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config/config.yaml")
_SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production")

_ENC_PREFIX = "enc:"


def _fernet() -> Fernet:
    # Derive a 32-byte URL-safe base64 key from SECRET_KEY via SHA-256
    raw = hashlib.sha256(_SECRET_KEY.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(raw))


def encrypt(value: str) -> str:
    """Encrypt a string and return a prefixed ciphertext."""
    return _ENC_PREFIX + _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a prefixed ciphertext; returns plaintext or original if unencrypted."""
    if isinstance(value, str) and value.startswith(_ENC_PREFIX):
        return _fernet().decrypt(value[len(_ENC_PREFIX):].encode()).decode()
    return value or ""


def read_config() -> dict:
    path = Path(CONFIG_PATH)
    if not path.exists():
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


def write_config(data: dict):
    path = Path(CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True)

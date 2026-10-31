"""
Recovery passphrase encryption for recovery kits.

Secrets inside a kit (environment variables, container settings) are encrypted with a key
derived from the user's recovery passphrase — not from BaumLab's SECRET_KEY / VAULT_KEY —
so a kit can be opened after BaumLab itself is gone: on a fresh BaumLab, or by hand with the
small standalone script written into every kit (DECRYPT_SCRIPT).
"""
import base64
import json
import os
from datetime import datetime
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .config_service import decrypt, encrypt, read_config, write_config

FORMAT = "baumlab-secrets-1"
ITERATIONS = 600_000
MIN_LENGTH = 12


def _key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode()))


def seal(data: dict, passphrase: str) -> str:
    """Encrypt a JSON-able dict → the text of a secrets.enc file."""
    salt = os.urandom(16)
    token = Fernet(_key(passphrase, salt, ITERATIONS)).encrypt(json.dumps(data, indent=2).encode())
    return json.dumps({"format": FORMAT, "kdf": "pbkdf2-sha256", "iterations": ITERATIONS,
                       "salt": base64.b64encode(salt).decode(), "token": token.decode()}, indent=2)


def unseal(text: str, passphrase: str) -> dict:
    blob = json.loads(text)
    if blob.get("format") != FORMAT:
        raise ValueError("Not a BaumLab recovery kit secrets file")
    try:
        key = _key(passphrase, base64.b64decode(blob["salt"]), int(blob["iterations"]))
        return json.loads(Fernet(key).decrypt(blob["token"].encode()))
    except InvalidToken:
        raise ValueError("Wrong recovery passphrase for this kit") from None


# ── The passphrase BaumLab encrypts new kits with ──────────────────────────────

def passphrase() -> Optional[str]:
    enc = read_config().get("backup", {}).get("recovery_passphrase")
    return decrypt(enc) if enc else None


def status() -> dict:
    cfg = read_config().get("backup", {})
    return {"set": bool(cfg.get("recovery_passphrase")), "set_at": cfg.get("recovery_passphrase_set_at")}


def set_passphrase(new: str):
    if len(new) < MIN_LENGTH:
        raise ValueError(f"Use at least {MIN_LENGTH} characters — a few random words works well")
    cfg = read_config()
    b = cfg.setdefault("backup", {})
    b["recovery_passphrase"] = encrypt(new)
    b["recovery_passphrase_set_at"] = datetime.utcnow().isoformat()
    write_config(cfg)


DECRYPT_SCRIPT = '''#!/usr/bin/env python3
"""
Decrypt a BaumLab recovery kit's secrets.enc without BaumLab.

    pip install cryptography
    python3 decrypt-secrets.py secrets.enc            # prints the secrets as JSON
    python3 decrypt-secrets.py secrets.enc --env      # also writes stack.env (KEY=value lines)

You'll be asked for the recovery passphrase that was set in BaumLab (Backups -> Recovery kits).
"""
import base64, getpass, json, sys
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

path = next((a for a in sys.argv[1:] if not a.startswith("--")), "secrets.enc")
blob = json.load(open(path))
kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32,
                 salt=base64.b64decode(blob["salt"]), iterations=int(blob["iterations"]))
key = base64.urlsafe_b64encode(kdf.derive(getpass.getpass("Recovery passphrase: ").encode()))
secrets = json.loads(Fernet(key).decrypt(blob["token"].encode()))
print(json.dumps(secrets, indent=2))
if "--env" in sys.argv:
    with open("stack.env", "w") as fh:
        fh.writelines(f"{k}={v}\\n" for k, v in secrets.get("stack_env", {}).items())
    print("Wrote stack.env", file=sys.stderr)
'''

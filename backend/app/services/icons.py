"""
Icon library for the Launchpad.

Icons come from the community dashboard-icons set (homarr-labs/dashboard-icons) or are
uploaded. Each icon used is downloaded once into ICON_DIR, so tiles work offline and
exports carry the actual files. The set's file index + alias metadata are cached for a week.
"""
import hashlib
import json
import os
import re
import time
from typing import Optional

import httpx

ICON_DIR = os.getenv("ICON_DIR", "/app/data/icons")
CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons"
INDEX_MAX_AGE = 7 * 86400
ALLOWED = {".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
           ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".gif": "image/gif"}
MAX_UPLOAD = 1024 * 1024
_FILE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,120}\.(svg|png|webp|jpg|jpeg|ico|gif)$")

_index: Optional[dict] = None   # {"names": {slug: [formats]}, "aliases": {alias: slug}}


def _path(name: str) -> str:
    return os.path.join(ICON_DIR, name)


def valid_file(name: str) -> bool:
    return bool(_FILE_RE.match(name or ""))


def file_path(name: str) -> Optional[str]:
    """Absolute path of a stored icon, or None if the name is invalid / missing."""
    if not valid_file(name):
        return None
    p = _path(name)
    return p if os.path.isfile(p) else None


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


# ── Index ──────────────────────────────────────────────────────────────────────

def _load_index() -> dict:
    """Build {names, aliases} from the cached tree.json / metadata.json, refreshing weekly."""
    global _index
    os.makedirs(ICON_DIR, exist_ok=True)
    cache = _path("_index.json")
    if _index and time.time() - _index.get("fetched", 0) < INDEX_MAX_AGE:
        return _index
    if os.path.exists(cache) and time.time() - os.path.getmtime(cache) < INDEX_MAX_AGE:
        _index = json.load(open(cache))
        return _index
    try:
        tree = httpx.get(f"{CDN}/tree.json", timeout=30).json()
        try:
            meta = httpx.get(f"{CDN}/metadata.json", timeout=60).json()
        except Exception:
            meta = {}
        names: dict[str, list[str]] = {}
        for fmt in ("svg", "png", "webp"):
            for f in tree.get(fmt, []):
                names.setdefault(f.rsplit(".", 1)[0], []).append(fmt)
        aliases = {}
        for name, info in meta.items():
            for a in (info or {}).get("aliases", []) or []:
                aliases.setdefault(slug(a), name)
        _index = {"names": names, "aliases": aliases, "fetched": time.time()}
        with open(cache, "w") as fh:
            json.dump(_index, fh)
    except Exception as e:
        if os.path.exists(cache):          # offline — keep using the stale copy
            _index = json.load(open(cache))
        else:
            raise RuntimeError(f"Could not download the icon index: {e}")
    return _index


def search(q: str, limit: int = 60) -> list[dict]:
    idx = _load_index()
    names, aliases = idx["names"], idx["aliases"]
    s = slug(q)
    if not s:
        return []
    hits: list[str] = []
    for candidate in [s, aliases.get(s)]:
        if candidate and candidate in names and candidate not in hits:
            hits.append(candidate)
    hits += sorted((n for n in names if n.startswith(s) and n not in hits), key=len)
    hits += sorted((n for n in names if s in n and n not in hits), key=len)
    hits += [n for a, n in aliases.items() if s in a and n in names and n not in hits]
    out = []
    for n in hits[:limit]:
        fmt = "svg" if "svg" in names[n] else names[n][0]
        out.append({"name": n, "format": fmt, "preview": f"{CDN}/{fmt}/{n}.{fmt}"})
    return out


def suggest(name: str) -> Optional[str]:
    """Best icon name for a service / app name, e.g. 'Home Assistant' → 'home-assistant'."""
    try:
        idx = _load_index()
    except RuntimeError:
        return None
    names, aliases = idx["names"], idx["aliases"]
    s = slug(name)
    for candidate in (s, aliases.get(s), s.replace("-", ""), s.split("-")[0] if s else None):
        if candidate and candidate in names:
            return candidate
        if candidate and candidate in aliases and aliases[candidate] in names:
            return aliases[candidate]
    return None


# ── Storing icons ──────────────────────────────────────────────────────────────

def fetch(name: str, fmt: Optional[str] = None) -> str:
    """Download a dashboard-icons icon into the library (once). Returns the stored file name."""
    idx = _load_index()
    if name not in idx["names"]:
        raise ValueError(f"No icon named {name!r}")
    fmt = fmt if fmt in idx["names"][name] else ("svg" if "svg" in idx["names"][name] else idx["names"][name][0])
    filename = f"{name}.{fmt}"
    if not os.path.exists(_path(filename)):
        r = httpx.get(f"{CDN}/{fmt}/{filename}", timeout=30)
        r.raise_for_status()
        with open(_path(filename), "wb") as fh:
            fh.write(r.content)
    return filename


def save_upload(data: bytes, original_name: str) -> str:
    """Store an uploaded / imported icon under a content hash. Returns the file name."""
    ext = os.path.splitext(original_name or "")[1].lower()
    if ext not in ALLOWED:
        raise ValueError(f"Unsupported icon type {ext or '(none)'} — use svg, png, webp, jpg, ico or gif")
    if len(data) > MAX_UPLOAD:
        raise ValueError("Icon is larger than 1 MB")
    os.makedirs(ICON_DIR, exist_ok=True)
    filename = f"custom-{hashlib.sha256(data).hexdigest()[:16]}{'.jpg' if ext == '.jpeg' else ext}"
    if not os.path.exists(_path(filename)):
        with open(_path(filename), "wb") as fh:
            fh.write(data)
    return filename


def read(name: str) -> Optional[bytes]:
    p = file_path(name)
    return open(p, "rb").read() if p else None

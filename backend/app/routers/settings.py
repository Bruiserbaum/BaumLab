from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from ..services.auth import require_admin
from ..services.config_service import read_config, write_config, encrypt, decrypt

router = APIRouter(prefix="/api/settings", tags=["settings"])

MASK = "••••••••"


class UniFiIn(BaseModel):
    url: str = ""
    username: str = ""
    password: Optional[str] = None   # None or MASK = keep existing
    api_key: Optional[str] = None    # None or MASK = keep existing
    site: str = "default"
    verify_ssl: bool = False
    controller_type: str = "classic"  # "classic" | "udm"


class ScanIn(BaseModel):
    default_cidr: str = "192.168.1.0/24"
    auto_scan: bool = False
    auto_scan_interval_minutes: int = 60


class OpenVasIn(BaseModel):
    socket_path: str = "/var/run/gvmd/gvmd.sock"
    host: str = ""           # leave blank to use socket
    port: int = 9390
    username: str = "admin"
    password: Optional[str] = None  # None or MASK = keep existing


class SettingsIn(BaseModel):
    unifi: Optional[UniFiIn] = None
    scan: Optional[ScanIn] = None
    openvas: Optional[OpenVasIn] = None


@router.get("/", dependencies=[Depends(require_admin)])
def get_settings():
    cfg = read_config()
    uf  = cfg.get("unifi", {})
    sc  = cfg.get("scan", {})
    ov  = cfg.get("openvas", {})
    return {
        "unifi": {
            "url": uf.get("url", ""),
            "username": uf.get("username", ""),
            "password": MASK if uf.get("password") else "",
            "api_key": MASK if uf.get("api_key") else "",
            "site": uf.get("site", "default"),
            "verify_ssl": uf.get("verify_ssl", False),
            "controller_type": uf.get("controller_type", "classic"),
            "configured": bool(uf.get("url")),
        },
        "scan": {
            "default_cidr": sc.get("default_cidr", "192.168.1.0/24"),
            "auto_scan": sc.get("auto_scan", False),
            "auto_scan_interval_minutes": sc.get("auto_scan_interval_minutes", 60),
        },
        "openvas": {
            "socket_path": ov.get("socket_path", "/var/run/gvmd/gvmd.sock"),
            "host": ov.get("host", ""),
            "port": ov.get("port", 9390),
            "username": ov.get("username", "admin"),
            "password": MASK if ov.get("password") else "",
        },
    }


@router.post("/", dependencies=[Depends(require_admin)])
def save_settings(payload: SettingsIn):
    cfg = read_config()

    if payload.unifi is not None:
        uf = cfg.get("unifi", {})
        u = payload.unifi
        uf["url"] = u.url.rstrip("/")
        uf["username"] = u.username
        uf["site"] = u.site
        uf["verify_ssl"] = u.verify_ssl
        uf["controller_type"] = u.controller_type
        # Only re-encrypt if a real new value was submitted
        if u.password and u.password != MASK:
            uf["password"] = encrypt(u.password)
        if u.api_key and u.api_key != MASK:
            uf["api_key"] = encrypt(u.api_key)
        cfg["unifi"] = uf

    if payload.scan is not None:
        s = payload.scan
        cfg["scan"] = {
            "default_cidr": s.default_cidr,
            "auto_scan": s.auto_scan,
            "auto_scan_interval_minutes": s.auto_scan_interval_minutes,
        }

    if payload.openvas is not None:
        ov = cfg.get("openvas", {})
        o = payload.openvas
        ov["socket_path"] = o.socket_path
        ov["host"]        = o.host
        ov["port"]        = o.port
        ov["username"]    = o.username
        if o.password and o.password != MASK:
            ov["password"] = encrypt(o.password)
        cfg["openvas"] = ov

    write_config(cfg)
    return {"status": "saved"}

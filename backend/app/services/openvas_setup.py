"""
Automatic setup for the OpenVAS container bundled with the stack.

In "auto" mode (the default whenever no remote Host is configured) BaumLab owns the
container's admin account: it generates a strong password, sets it inside the container
with `gvmd --new-password` over the Docker socket, stores it encrypted, and re-applies it
if the container ever resets it. It also reports how far the container has got —
starting → loading feeds → ready — for Settings and the Vuln Scan page.

Remote GVM setups ("manual" mode) are only probed, never changed.
"""
import os
import re
import secrets
import socket
import threading
import time
from typing import Optional

from .config_service import read_config, write_config, encrypt, decrypt
from .openvas import OpenVasService

DEFAULT_SOCKET = "/var/run/gvmd/gvmd.sock"
GVMD_LOG = "/usr/local/var/log/gvm/gvmd.log"
CACHE_SECONDS = 15

_lock = threading.Lock()
_last: dict = {"state": "unknown", "message": "Not checked yet", "checked": 0}

# state → whether GMP is usable for scans
USABLE = {"ready", "updating"}


def mode(cfg: dict) -> str:
    return cfg.get("mode") or ("manual" if cfg.get("host") else "auto")


def service(cfg: Optional[dict] = None) -> Optional[OpenVasService]:
    """A GMP client from the saved settings, or None if there are no credentials yet."""
    cfg = read_config().get("openvas", {}) if cfg is None else cfg
    if not cfg.get("password"):
        return None
    manual = mode(cfg) == "manual"
    return OpenVasService(
        username=cfg.get("username", "admin"),
        password=decrypt(cfg["password"]),
        socket_path=cfg.get("socket_path") or DEFAULT_SOCKET,
        # The bundled container is only reachable over its socket, whatever Host was left at
        host=(cfg.get("host") or None) if manual else None,
        port=int(cfg.get("port", 9390)),
    )


def _container():
    """The OpenVAS container in BaumLab's own compose project (or any OpenVAS container as a fallback)."""
    import docker
    client = docker.from_env(timeout=60)
    try:
        project = client.containers.get(socket.gethostname()).labels.get("com.docker.compose.project")
    except Exception:
        project = None
    found = [c for c in client.containers.list(all=True)
             if "openvas" in c.name.lower() or "openvas" in (c.attrs.get("Config", {}).get("Image") or "").lower()]
    own = [c for c in found if project and c.labels.get("com.docker.compose.project") == project]
    return (own or found or [None])[0]


def _env(container, key: str) -> Optional[str]:
    for item in container.attrs.get("Config", {}).get("Env") or []:
        k, _, v = item.partition("=")
        if k == key:
            return v
    return None


def _activity(container) -> str:
    """The latest thing gvmd logged, e.g. 'Updating VTs in database' — shown while it starts."""
    try:
        rc, out = container.exec_run(["tail", "-n", "1", GVMD_LOG])
        line = out.decode(errors="replace").strip() if rc == 0 else ""
    except Exception:
        line = ""
    if not line:
        try:
            line = container.logs(tail=1).decode(errors="replace").strip()
        except Exception:
            return ""
    m = re.search(r"utc:\d+:\s*(.*)$", line)
    return (m.group(1) if m else line)[:200]


def _set_password(container, username: str, password: str) -> Optional[str]:
    """Set the admin password inside the container. Returns an error message, or None on success."""
    rc, out = container.exec_run(["gvmd", f"--user={username}", f"--new-password={password}"], user="gvm")
    text = out.decode(errors="replace").strip()
    if rc != 0 or "fail" in text.lower():
        return text or f"gvmd exited with {rc}"
    return None


def _result(state: str, message: str, **extra) -> dict:
    return {"state": state, "message": message, "checked": time.time(), **extra}


def _check_manual(cfg: dict) -> dict:
    svc = service(cfg)
    if svc is None:
        return _result("unconfigured", "Enter the username and password for your GVM server.", managed=False)
    probe = svc.check_connection()
    if not probe.get("connected"):
        return _result("unreachable", probe.get("error", "Could not connect"), managed=False)
    return _finish(svc, probe.get("version"), managed=False)


def _finish(svc: OpenVasService, version: Optional[str], **extra) -> dict:
    """Authenticated checks: are feeds still loading, are scan configs there yet?"""
    try:
        feeds = svc.get_feeds()
        configs = svc.get_scan_configs()
    except RuntimeError as e:
        state = "auth_failed" if "auth failed" in str(e).lower() else "error"
        return _result(state, str(e), version=version, **extra)
    syncing = [f["name"] or f["type"] for f in feeds if f["syncing"]]
    if not configs:
        return _result("loading", "Connected, but the vulnerability tests and scan configs are still being "
                       "imported — scans become available when this finishes.", version=version, feeds=feeds, **extra)
    if syncing:
        return _result("updating", f"Ready to scan — still updating {', '.join(syncing)} in the background.",
                       version=version, feeds=feeds, **extra)
    return _result("ready", "Ready to scan.", version=version, feeds=feeds, **extra)


def _check_auto(cfg: dict) -> dict:
    try:
        c = _container()
    except Exception as e:
        return _result("error", f"Docker socket not available: {e}", managed=True)
    if c is None:
        return _result("missing", "No OpenVAS container found — redeploy the stack.", managed=True)
    if c.status != "running":
        return _result("stopped", f"Container {c.name} is {c.status}.", managed=True, container=c.name)

    base = {"managed": True, "container": c.name}
    sock_path = cfg.get("socket_path") or DEFAULT_SOCKET
    if not os.path.exists(sock_path):
        return _result("starting", "gvmd hasn't opened its socket yet.", activity=_activity(c), **base)

    username = _env(c, "USERNAME") or cfg.get("username") or "admin"
    try:
        password = decrypt(cfg.get("password", ""))
    except Exception:
        password = ""                        # SECRET_KEY changed — just generate a new one below
    svc = OpenVasService(username=username, password=password, socket_path=sock_path)
    probe = svc.check_connection()
    if not probe.get("connected"):
        return _result("starting", "gvmd is starting up and not accepting connections yet.",
                       activity=_activity(c), **base)

    result = _finish(svc, probe.get("version"), **base) if password else None
    if result and result["state"] != "auth_failed":
        return result

    # No password yet, or the container reset it: generate one and set it inside the container
    new = secrets.token_urlsafe(24)
    err = _set_password(c, username, new)
    if err:
        # The image creates the admin account late in its first start
        return _result("starting", f"Waiting for the '{username}' account to be created ({err[:120]}).",
                       activity=_activity(c), **base)
    full = read_config()
    ov = full.get("openvas", {})
    ov.update(mode="auto", username=username, password=encrypt(new), host="", socket_path=sock_path)
    full["openvas"] = ov
    write_config(full)
    print(f"OpenVAS: generated and set a new password for '{username}' in {c.name}")
    svc.password = new
    return _finish(svc, probe.get("version"), **base)


def check(force: bool = False) -> dict:
    """Current OpenVAS status, re-checked at most every CACHE_SECONDS (or now with force)."""
    global _last
    if not force and time.time() - _last.get("checked", 0) < CACHE_SECONDS:
        return _last
    if not _lock.acquire(blocking=False):
        return _last                         # a check is already running; don't pile up
    try:
        cfg = read_config().get("openvas", {})
        try:
            _last = _check_auto(cfg) if mode(cfg) == "auto" else _check_manual(cfg)
        except Exception as e:
            _last = _result("error", str(e), managed=mode(cfg) == "auto")
        return _last
    finally:
        _lock.release()


def refresh():
    """Scheduler entry point — keeps the bundled container provisioned even when nobody has Settings open."""
    check(force=True)

"""
Alerts: deliver events to notification channels (ntfy, Discord, email, generic webhook).

notify() is synchronous (network I/O) — call it from worker threads directly and from
async code via asyncio.to_thread. Every alert is logged, even with no channels set up.
Channel secrets live encrypted in config.yaml.
"""
import json
import smtplib
import ssl
import uuid
from datetime import datetime
from email.message import EmailMessage
from typing import Optional

import httpx
from sqlmodel import Session

from ..database import engine
from ..models.alert import AlertLog, AlertState
from .config_service import decrypt, encrypt, read_config, write_config

EVENTS = {
    "monitor_down":     "Monitor goes down / recovers",
    "backup_failed":    "Backup fails or finishes with warnings",
    "backup_stale":     "Backup becomes stale (missed its schedule)",
    "new_device":       "New device appears on the network",
    "update_available": "BaumLab update available",
}
CHANNEL_TYPES = ("ntfy", "discord", "email", "webhook")
SECRET_FIELDS = {"token", "webhook_url", "password", "url"}
SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
MASK = "••••••••"


# ── Config ─────────────────────────────────────────────────────────────────────

def _raw() -> dict:
    return read_config().get("alerts", {})


def get_config(masked: bool = True) -> dict:
    raw = _raw()
    channels = []
    for ch in raw.get("channels", []):
        settings = {}
        for k, v in (ch.get("settings") or {}).items():
            if k in SECRET_FIELDS:
                settings[k] = (MASK if v else "") if masked else decrypt(v)
            else:
                settings[k] = v
        channels.append({**ch, "settings": settings})
    return {
        "public_url": raw.get("public_url", ""),
        "monitor_failures": raw.get("monitor_failures", 2),
        "events": {k: raw.get("events", {}).get(k, True) for k in EVENTS},
        "channels": channels,
    }


def save_config(data: dict):
    old = {ch.get("id"): ch for ch in _raw().get("channels", [])}
    channels = []
    for ch in data.get("channels", []):
        if ch.get("type") not in CHANNEL_TYPES:
            continue
        cid = ch.get("id") or uuid.uuid4().hex[:12]
        prev = (old.get(cid) or {}).get("settings", {})
        settings = {}
        for k, v in (ch.get("settings") or {}).items():
            if k in SECRET_FIELDS:
                settings[k] = prev.get(k, "") if v == MASK else (encrypt(v.strip()) if v else "")
            else:
                settings[k] = v
        channels.append({
            "id": cid, "name": (ch.get("name") or ch["type"]).strip(), "type": ch["type"],
            "enabled": bool(ch.get("enabled", True)), "min_severity": ch.get("min_severity", "warning"),
            "settings": settings,
        })
    cfg = read_config()
    cfg["alerts"] = {
        "public_url": (data.get("public_url") or "").strip().rstrip("/"),
        "monitor_failures": max(1, int(data.get("monitor_failures") or 2)),
        "events": {k: bool(data.get("events", {}).get(k, True)) for k in EVENTS},
        "channels": channels,
    }
    write_config(cfg)


def link(path: str) -> Optional[str]:
    base = _raw().get("public_url", "")
    return f"{base}{path}" if base else None


def monitor_failures() -> int:
    return max(1, int(_raw().get("monitor_failures", 2)))


# ── State tracking (alert on change, not on every check) ───────────────────────

def get_state(session: Session, key: str) -> AlertState:
    return session.get(AlertState, key) or AlertState(key=key)


def transition(key: str, new_state: str) -> Optional[str]:
    """Record new_state for key; returns the previous state if it changed, else None."""
    with Session(engine) as s:
        st = get_state(s, key)
        if st.state == new_state:
            return None
        prev = st.state
        st.state, st.changed_at = new_state, datetime.utcnow()
        s.add(st)
        s.commit()
        return prev


# ── Delivery ───────────────────────────────────────────────────────────────────

_NTFY_PRIORITY = {"info": 3, "warning": 4, "critical": 5}
_NTFY_TAGS = {"info": "information_source", "warning": "warning", "critical": "rotating_light"}
_DISCORD_COLOR = {"info": 0x1F6FEB, "warning": 0xD29922, "critical": 0xDA3633}


def _deliver(ch: dict, alert: dict):
    s = ch["settings"]
    t = ch["type"]
    if t == "ntfy":
        headers = {"Authorization": f"Bearer {s['token']}"} if s.get("token") else {}
        body = {"topic": s.get("topic", ""), "title": alert["title"], "message": alert["message"] or alert["title"],
                "priority": _NTFY_PRIORITY[alert["severity"]], "tags": [_NTFY_TAGS[alert["severity"]]]}
        if alert.get("url"):
            body["click"] = alert["url"]
        # JSON publishing to the server root keeps titles UTF-8 safe
        r = httpx.post((s.get("server") or "https://ntfy.sh").rstrip("/"), json=body, headers=headers, timeout=15)
        r.raise_for_status()
    elif t == "discord":
        embed = {"title": alert["title"][:256], "description": (alert["message"] or "")[:4000],
                 "color": _DISCORD_COLOR[alert["severity"]], "timestamp": datetime.utcnow().isoformat()}
        if alert.get("url"):
            embed["url"] = alert["url"]
        r = httpx.post(s["webhook_url"], json={"username": "BaumLab", "embeds": [embed]}, timeout=15)
        r.raise_for_status()
    elif t == "webhook":
        r = httpx.post(s["url"], json={**alert, "time": datetime.utcnow().isoformat() + "Z"}, timeout=15)
        r.raise_for_status()
    elif t == "email":
        msg = EmailMessage()
        msg["Subject"] = f"[BaumLab] {alert['title']}"
        msg["From"] = s.get("from_addr") or s.get("username")
        msg["To"] = s.get("to_addrs", "")
        msg.set_content(alert["message"] + (f"\n\n{alert['url']}" if alert.get("url") else ""))
        port = int(s.get("port") or 587)
        security = s.get("security", "starttls")
        if security == "ssl":
            server = smtplib.SMTP_SSL(s["host"], port, timeout=20, context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(s["host"], port, timeout=20)
            if security == "starttls":
                server.starttls(context=ssl.create_default_context())
        with server:
            if s.get("username"):
                server.login(s["username"], s.get("password", ""))
            server.send_message(msg)


def notify(event: str, title: str, message: str = "", severity: str = "warning", url: Optional[str] = None):
    """Log an alert and send it to every enabled channel at or above its minimum severity."""
    cfg = get_config(masked=False)
    alert = {"event": event, "severity": severity, "title": title, "message": message, "url": url}
    delivery = []
    if cfg["events"].get(event, True):
        for ch in cfg["channels"]:
            if not ch["enabled"] or SEVERITY_RANK[severity] < SEVERITY_RANK.get(ch["min_severity"], 1):
                continue
            try:
                _deliver(ch, alert)
                delivery.append({"channel": ch["name"], "ok": True})
            except Exception as e:
                delivery.append({"channel": ch["name"], "ok": False, "error": str(e)[:200]})
                print(f"Alert via {ch['name']} failed: {e}")
    else:
        delivery.append({"channel": "-", "ok": False, "error": "event type turned off"})
    with Session(engine) as s:
        s.add(AlertLog(event=event, severity=severity, title=title, message=message, url=url,
                       delivery=json.dumps(delivery)))
        s.commit()


def test_channel(channel_id: str) -> tuple[bool, str]:
    ch = next((c for c in get_config(masked=False)["channels"] if c["id"] == channel_id), None)
    if not ch:
        return False, "Save the channel first"
    try:
        _deliver(ch, {"event": "test", "severity": "info", "title": "BaumLab test alert",
                      "message": f"If you can read this, the '{ch['name']}' channel works.", "url": link("/alerts")})
        return True, "Sent"
    except Exception as e:
        return False, str(e)[:300]

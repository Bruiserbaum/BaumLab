"""
Built-in mail relay: devices on the LAN send mail to BaumLab over SMTP (port 2525 in the container,
published as SMTP_RELAY_PORT) and BaumLab passes it on through one upstream account — Gmail,
Microsoft 365, SendGrid, your own mail server, …

Store-and-forward: a message is written to data/mail-relay and logged before the device gets
"250 OK", then a worker delivers it, retrying with backoff — an upstream outage loses nothing.
Who may send: clients in the allowed networks, optionally only with a relay login.
Most providers only send as the account's own address, so the sender can be rewritten to an
address you choose (the device's own address is kept as Reply-To).
"""
import email
import ipaddress
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
import threading
import time
import uuid
from datetime import datetime, timedelta
from email import policy
from email.message import EmailMessage
from email.parser import BytesHeaderParser
from email.utils import formataddr, formatdate, getaddresses, make_msgid, parseaddr
from typing import Optional

from sqlalchemy import func, or_
from sqlmodel import Session, select

from ..database import engine
from ..models.mail_relay import RelayMessage
from . import alerts
from .config_service import decrypt, encrypt, read_config, write_config

LISTEN_PORT = 2525                    # inside the container
DATA_DIR = os.path.abspath("data/mail-relay")
RETRY_MINUTES = (1, 5, 15, 30, 60, 120, 240, 480)   # then every 8 h …
GIVE_UP = timedelta(days=2)                         # … until the message is this old
REFUSED_LOG_EVERY = 300               # log a refused client at most every 5 min per (ip, reason)
AUDIT_EVERY = 3600
MASK = "••••••••"
PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fc00::/7", "::1/128"]

DEFAULTS = {
    "enabled": False,
    "hostname": "baumlab-relay",      # the name the relay greets with — point a DNS name at BaumLab to match
    "allowed_networks": PRIVATE_NETS,
    "require_auth": False,
    "logins": [],                     # [{id, name, username, password}]
    "upstream": {"preset": "custom", "host": "", "port": 587, "security": "starttls",
                 "username": "", "password": "", "credential_id": None},
    "from_mode": "rewrite",           # rewrite | keep_domains | keep
    "from_address": "",               # e.g. alerts@example.com or {local}@example.com
    "from_name": "{name}",
    "keep_domains": [],
    "reply_to_original": True,
    "deliver_to": "",                 # send everything here instead of the device's recipients
    "max_size_mb": 25,
    "retention_days": 7,
}

_controller = None
_listen_error: Optional[str] = None
_deliver_lock = threading.Lock()
_upstream_last: dict = {}             # {ok, error, at} from the last delivery attempt
_refused_logged: dict[tuple, float] = {}
_last_audit = 0.0


# ── Settings ───────────────────────────────────────────────────────────────────

def host_port() -> int:
    return int(os.getenv("SMTP_RELAY_PORT", str(LISTEN_PORT)) or LISTEN_PORT)


def settings(masked: bool = True) -> dict:
    raw = read_config().get("mail_relay", {})
    cfg = {**DEFAULTS, **raw, "upstream": {**DEFAULTS["upstream"], **(raw.get("upstream") or {})}}
    show = (lambda v: MASK if v else "") if masked else (lambda v: decrypt(v) if v else "")
    cfg["upstream"]["password"] = show(cfg["upstream"].get("password"))
    cfg["logins"] = [{**l, "password": show(l.get("password"))} for l in cfg.get("logins") or []]
    return cfg


def save_settings(data: dict):
    """Validate and store. Masked / blank secrets keep their stored values."""
    old = read_config().get("mail_relay", {})
    cfg = {k: data.get(k, v) for k, v in DEFAULTS.items()}

    nets = []
    for n in cfg["allowed_networks"] or []:
        n = str(n).strip()
        if not n:
            continue
        try:
            nets.append(str(ipaddress.ip_network(n, strict=False)))
        except ValueError:
            raise ValueError(f"“{n}” isn't a network — use a form like 192.168.1.0/24 or a single address")
    cfg["allowed_networks"] = nets
    cfg["keep_domains"] = [d.strip().lstrip("@").lower() for d in cfg["keep_domains"] or [] if d.strip()]
    cfg["hostname"] = (cfg["hostname"] or "").strip() or DEFAULTS["hostname"]
    cfg["from_address"] = (cfg["from_address"] or "").strip()
    if cfg["from_mode"] != "keep" and cfg["from_address"] and "@" not in cfg["from_address"]:
        raise ValueError("The send-as address needs an @ — e.g. alerts@example.com or {local}@example.com")
    for field in ("from_address", "from_name"):
        try:
            (cfg[field] or "").format_map(_Vars(name="x", local="x", login="x", ip="x", helo="x"))
        except (ValueError, IndexError, AttributeError):
            raise ValueError(f"“{cfg[field]}” has a stray {{ or }} — placeholders look like {{name}}, {{local}}, {{login}}, {{ip}}")
    cfg["max_size_mb"] = max(1, min(int(cfg["max_size_mb"] or 25), 100))
    cfg["retention_days"] = max(1, int(cfg["retention_days"] or 7))

    up = {k: (data.get("upstream") or {}).get(k, v) for k, v in DEFAULTS["upstream"].items()}
    up["host"] = (up["host"] or "").strip()
    up["username"] = (up["username"] or "").strip()
    if up["credential_id"] in ("", None):
        up["credential_id"] = None
        pw = up["password"]
        up["password"] = (old.get("upstream") or {}).get("password", "") if pw in ("", MASK) else encrypt(pw)
    else:
        up["credential_id"], up["password"] = int(up["credential_id"]), ""
    cfg["upstream"] = up

    old_logins = {l.get("id"): l for l in old.get("logins") or []}
    logins, names = [], set()
    for l in cfg["logins"] or []:
        username = (l.get("username") or "").strip()
        if not username:
            raise ValueError("Every relay login needs a username")
        if username in names:
            raise ValueError(f"Two relay logins use the username “{username}”")
        names.add(username)
        lid = l.get("id") or uuid.uuid4().hex[:8]
        pw = l.get("password")
        if pw in ("", MASK, None):
            stored = (old_logins.get(lid) or {}).get("password")
            if not stored:
                raise ValueError(f"Give the relay login “{username}” a password")
        else:
            stored = encrypt(pw)
        logins.append({"id": lid, "name": (l.get("name") or "").strip() or username, "username": username, "password": stored})
    cfg["logins"] = logins

    full = read_config()
    full["mail_relay"] = cfg
    write_config(full)
    start()                           # pick up a new name / size limit


# ── Listener ───────────────────────────────────────────────────────────────────

def _client_ip(session) -> str:
    return (session.peer[0] if session.peer else "") or ""


def _ip_allowed(ip: str, networks: list[str]) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if getattr(addr, "ipv4_mapped", None):
        addr = addr.ipv4_mapped
    for n in networks:
        try:
            if addr in ipaddress.ip_network(n, strict=False):
                return True
        except (ValueError, TypeError):
            continue
    return False


def _refusal(session, cfg: dict) -> Optional[str]:
    if not cfg["enabled"]:
        return "The BaumLab mail relay is turned off"
    ip = _client_ip(session)
    if not _ip_allowed(ip, cfg["allowed_networks"]):
        return f"{ip} isn't in the relay's allowed networks"
    if cfg["require_auth"] and not getattr(session, "relay_login", None):
        return "This relay needs a username and password"
    return None


def _record_refused(session, mail_from: str, why: str):
    key = (_client_ip(session), why)
    if time.monotonic() - _refused_logged.get(key, -REFUSED_LOG_EVERY) < REFUSED_LOG_EVERY:
        return
    _refused_logged[key] = time.monotonic()
    with Session(engine) as s:
        s.add(RelayMessage(client_ip=key[0], login=getattr(session, "relay_login", None), helo=session.host_name,
                           mail_from=mail_from or "", status="rejected", last_error=why))
        s.commit()


def _authenticate(server, session, envelope, mechanism, auth_data):
    from aiosmtpd.smtp import AuthResult, LoginPassword
    if isinstance(auth_data, LoginPassword):
        user = auth_data.login.decode(errors="replace")
        password = auth_data.password.decode(errors="replace")
        for l in settings(masked=False)["logins"]:
            if l["username"] == user and l["password"] and secrets.compare_digest(l["password"], password):
                session.relay_login = l["name"]
                return AuthResult(success=True)
        _record_refused(session, "", f"Wrong relay username or password (tried “{user}”)")
    return AuthResult(success=False, handled=False)


class _Handler:
    async def handle_MAIL(self, server, session, envelope, address, mail_options):
        why = _refusal(session, settings(masked=False))
        if why:
            _record_refused(session, address, why)
            return f"550 5.7.1 {why}"
        envelope.mail_from = address
        envelope.mail_options.extend(mail_options)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        why = _refusal(session, settings(masked=False))
        if why:
            _record_refused(session, envelope.mail_from, why)
            return f"550 5.7.1 {why}"
        try:
            msg_id = _store(envelope.original_content or envelope.content, envelope.mail_from or "", envelope.rcpt_tos,
                            _client_ip(session), getattr(session, "relay_login", None), session.host_name)
        except Exception as e:
            print(f"Mail relay: couldn't store a message: {e}")
            return "451 4.3.0 Couldn't store the message — try again later"
        kick()
        return f"250 2.0.0 Queued as {msg_id}"


def start():
    """(Re)start the SMTP listener with the current settings. Runs in its own thread."""
    global _controller, _listen_error
    from aiosmtpd.controller import Controller
    stop()
    cfg = settings(masked=False)
    try:
        # hostname "" = every address, IPv4 and IPv6
        c = Controller(_Handler(), hostname="", port=LISTEN_PORT, server_hostname=cfg["hostname"],
                       ident="BaumLab mail relay", authenticator=_authenticate, auth_require_tls=False,
                       data_size_limit=int(cfg["max_size_mb"]) * 1024 * 1024)
        c.start()
        _controller, _listen_error = c, None
        print(f"Mail relay listening on :{LISTEN_PORT} (published as {host_port()})")
    except Exception as e:
        _listen_error = str(e)
        print(f"WARNING: Mail relay couldn't listen on :{LISTEN_PORT} — {e}")


def stop():
    global _controller
    if _controller:
        try:
            _controller.stop()
        except Exception:
            pass
        _controller = None


# ── Queue ──────────────────────────────────────────────────────────────────────

def _path(name: str) -> str:
    return os.path.join(DATA_DIR, os.path.basename(name))


def _store(content: bytes, mail_from: str, rcpts: list[str], ip: str, login: Optional[str], helo: Optional[str]) -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    if isinstance(content, str):
        content = content.encode("utf-8", errors="surrogateescape")
    name = f"{datetime.utcnow():%Y%m%d%H%M%S}_{uuid.uuid4().hex[:10]}.eml"
    with open(_path(name), "wb") as fh:
        fh.write(content)
    headers = BytesHeaderParser(policy=policy.default).parsebytes(content)
    with Session(engine) as s:
        row = RelayMessage(client_ip=ip, login=login, helo=helo, mail_from=mail_from, rcpt_to=json.dumps(list(rcpts)),
                           subject=str(headers.get("Subject", "") or "")[:300], size=len(content), file=name)
        s.add(row)
        s.commit()
        return row.id


def kick():
    """Deliver now in the background (the scheduler also runs deliver_due every 30 s)."""
    threading.Thread(target=deliver_due, daemon=True).start()


def _update(msg_id: int, **fields):
    with Session(engine) as s:
        row = s.get(RelayMessage, msg_id)
        if row:
            for k, v in fields.items():
                setattr(row, k, v)
            s.add(row)
            s.commit()


def _defer(m: RelayMessage, error: str):
    attempts = m.attempts + 1
    if datetime.utcnow() - m.received_at > GIVE_UP:
        _fail(m, f"Gave up after {attempts} attempts: {error}", attempts)
        return
    wait = RETRY_MINUTES[min(attempts - 1, len(RETRY_MINUTES) - 1)]
    _update(m.id, status="deferred", attempts=attempts, last_error=error,
            next_attempt_at=datetime.utcnow() + timedelta(minutes=wait))


def _fail(m: RelayMessage, error: str, attempts: Optional[int] = None):
    _update(m.id, status="failed", attempts=attempts or m.attempts + 1, last_error=error, next_attempt_at=None)
    # One alert an hour at most — a broken device can fail a lot of messages
    with Session(engine) as s:
        st = alerts.get_state(s, "mailrelay:failed")
        if st.state == "alerted" and datetime.utcnow() - st.changed_at < timedelta(hours=1):
            return
        st.state, st.changed_at = "alerted", datetime.utcnow()
        s.add(st)
        s.commit()
    to = ", ".join(json.loads(m.rcpt_to or "[]"))
    alerts.notify("mail_relay", "📧 Mail relay couldn't deliver a message",
                  f"“{m.subject or '(no subject)'}” from {m.mail_from or m.client_ip} to {to}: {error}",
                  severity="warning", url=alerts.link("/mail-relay"))


def _upstream_state(ok: bool, error: str = ""):
    _upstream_last.update(ok=ok, error=error, at=datetime.utcnow().isoformat())
    prev = alerts.transition("mailrelay:upstream", "up" if ok else "down")
    if not ok and prev is not None:
        alerts.notify("mail_relay", "📧 Mail relay can't reach its upstream mail server",
                      f"Messages are queued and will be retried. {error}", severity="critical",
                      url=alerts.link("/mail-relay"))
    elif ok and prev == "down":
        alerts.notify("mail_relay", "✅ Mail relay is delivering again", "Queued messages are going out.",
                      severity="info", url=alerts.link("/mail-relay"))


# ── Delivery ───────────────────────────────────────────────────────────────────

def _upstream(cfg: dict) -> dict:
    """Upstream settings with the password filled in (from the vault when linked)."""
    global _last_audit
    up = dict(cfg["upstream"])
    if up.get("credential_id"):
        from ..models.vault import VaultAudit, VaultEntry
        from . import vault
        reason = vault.lock_reason()
        if reason:
            raise RuntimeError(f"Vault locked: {reason}")
        with Session(engine) as s:
            entry = s.get(VaultEntry, int(up["credential_id"]))
            if not entry:
                raise RuntimeError("The vault entry the relay logs in with no longer exists — pick another on the Mail relay page")
            up["password"] = vault.decrypt(entry.secret_enc) if entry.secret_enc else ""
            up["username"] = up["username"] or entry.username or ""
            if time.monotonic() - _last_audit >= AUDIT_EVERY:
                _last_audit = time.monotonic()
                s.add(VaultAudit(entry_id=entry.id, entry_title=entry.title, actor="mail-relay", action="use"))
                s.commit()
    return up


def explain(e: Exception, up: Optional[dict] = None) -> str:
    where = f"{up['host']}:{up['port']}" if up else "the mail server"
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return (f"{where} rejected the login ({e.smtp_code} {e.smtp_error.decode(errors='replace') if isinstance(e.smtp_error, bytes) else e.smtp_error}). "
                "Gmail, Microsoft and iCloud need an app password, not your normal one")
    if isinstance(e, socket.gaierror):
        return f"Can't find a server called {up['host'] if up else '?'} — check the host name"
    if isinstance(e, ConnectionRefusedError):
        return f"{where} refused the connection — check the port"
    if isinstance(e, (socket.timeout, TimeoutError)):
        return f"Timed out reaching {where} — check the host, port and that outgoing mail ports aren't blocked"
    if isinstance(e, ssl.SSLError):
        return f"TLS problem with {where}: {e.reason or e} — 587 normally means STARTTLS, 465 means SSL/TLS"
    if isinstance(e, smtplib.SMTPNotSupportedError):
        return f"{where} doesn't offer STARTTLS — try SSL/TLS (port 465) or None"
    if isinstance(e, smtplib.SMTPResponseException):
        text = e.smtp_error.decode(errors="replace") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        return f"{e.smtp_code} {text}"
    return str(e) or e.__class__.__name__


def connect(cfg: dict) -> tuple[smtplib.SMTP, dict]:
    up = _upstream(cfg)
    if not up["host"]:
        raise RuntimeError("No upstream mail server yet — fill in “Send through” on the Mail relay page")
    up["port"] = int(up.get("port") or 587)
    ctx = ssl.create_default_context()
    try:
        if up["security"] == "ssl":
            conn = smtplib.SMTP_SSL(up["host"], up["port"], local_hostname=cfg["hostname"], timeout=30, context=ctx)
        else:
            conn = smtplib.SMTP(up["host"], up["port"], local_hostname=cfg["hostname"], timeout=30)
            if up["security"] == "starttls":
                conn.starttls(context=ctx)
        if up["username"]:
            conn.login(up["username"], up["password"])
    except Exception as e:
        raise RuntimeError(explain(e, up)) from e
    return conn, up


class _Vars(dict):
    def __missing__(self, key):
        return ""


def prepare(raw: bytes, m: RelayMessage, cfg: dict) -> tuple[str, list[str], bytes]:
    """(envelope sender, recipients, message bytes) as they go upstream — sender rewritten if set up."""
    msg = email.message_from_bytes(raw, policy=policy.SMTP)
    name, addr = parseaddr(str(msg.get("From", "") or ""))
    addr = addr or m.mail_from or ""
    local = addr.split("@")[0] if "@" in addr else addr
    safe_local = re.sub(r"[^A-Za-z0-9._+-]+", "-", local).strip(".-").lower() or "device"
    values = _Vars(name=name or local or m.login or "device", local=safe_local, login=m.login or "",
                   ip=m.client_ip, helo=m.helo or "")

    rcpts = json.loads(m.rcpt_to or "[]")
    if cfg["deliver_to"].strip():
        rcpts = [a for _, a in getaddresses([cfg["deliver_to"]]) if a]
    original_to = json.loads(m.rcpt_to or "[]")

    domain = addr.rsplit("@", 1)[-1].lower() if "@" in addr else ""
    rewrite = bool(cfg["from_address"]) and (cfg["from_mode"] == "rewrite" or
                                             (cfg["from_mode"] == "keep_domains" and domain not in cfg["keep_domains"]))
    sender = m.mail_from or addr
    changed = False
    if rewrite:
        new_addr = cfg["from_address"].format_map(values).strip()
        display = (cfg["from_name"] or "").format_map(values).strip()
        if cfg["reply_to_original"] and "@" in addr and "Reply-To" not in msg:
            msg["Reply-To"] = formataddr((name, addr))
        del msg["From"]
        del msg["Sender"]
        msg["From"] = formataddr((display, new_addr))
        sender, changed = new_addr, True
    # Some devices leave out headers that providers insist on
    if "Date" not in msg:
        msg["Date"], changed = formatdate(usegmt=True), True
    if "Message-ID" not in msg:
        msg["Message-ID"], changed = make_msgid(domain=cfg["hostname"] if "." in cfg["hostname"] else None), True
    if "To" not in msg and original_to:
        msg["To"], changed = ", ".join(original_to), True

    body = msg.as_bytes(policy=policy.SMTP) if changed else raw
    who = f"{m.helo or 'unknown'} ({m.client_ip}{', login ' + m.login if m.login else ''})"
    received = f"Received: from {who}\r\n\tby {cfg['hostname']} (BaumLab mail relay); {formatdate(usegmt=True)}\r\n"
    return sender, rcpts, received.encode() + body


def _send_one(conn: smtplib.SMTP, cfg: dict, m: RelayMessage):
    try:
        raw = open(_path(m.file or ""), "rb").read()
    except OSError:
        _fail(m, "The stored copy of this message is missing")
        return
    try:
        sender, rcpts, data = prepare(raw, m, cfg)
    except Exception as e:
        _fail(m, f"Couldn't read the message the device sent: {e}")
        return
    if not rcpts:
        _fail(m, "No recipients")
        return
    try:
        refused = conn.sendmail(sender, rcpts, data)
    except smtplib.SMTPRecipientsRefused as e:
        codes = [c for c, _ in e.recipients.values()]
        text = "; ".join(f"{r}: {c} {t.decode(errors='replace') if isinstance(t, bytes) else t}" for r, (c, t) in e.recipients.items())
        (_fail if all(c >= 500 for c in codes) else _defer)(m, f"Recipients refused — {text}")
        return
    except smtplib.SMTPResponseException as e:
        why = explain(e)
        if e.smtp_code >= 500:
            hint = " — the provider may not let you send as this address; set “Send as” to your account's address" \
                if isinstance(e, smtplib.SMTPSenderRefused) else ""
            _fail(m, why + hint)
        else:
            _defer(m, why)
        return
    except (smtplib.SMTPException, OSError) as e:
        _defer(m, explain(e))
        return
    note = "; ".join(f"{r}: {c}" for r, (c, _) in refused.items()) if refused else None
    _update(m.id, status="sent", attempts=m.attempts + 1, sent_at=datetime.utcnow(), sent_from=sender,
            sent_to=json.dumps(rcpts), next_attempt_at=None,
            last_error=f"Some recipients refused — {note}" if note else None)


def deliver_due():
    """Send everything that's due. One delivery run at a time; extra kicks just return."""
    if not _deliver_lock.acquire(blocking=False):
        return
    try:
        cfg = settings(masked=False)
        while True:
            now = datetime.utcnow()
            with Session(engine) as s:
                due = s.exec(select(RelayMessage)
                             .where(RelayMessage.status.in_(["queued", "deferred"]),
                                    or_(RelayMessage.next_attempt_at == None, RelayMessage.next_attempt_at <= now))  # noqa: E711
                             .order_by(RelayMessage.id).limit(50)).all()
                s.expunge_all()
            if not due:
                return
            try:
                conn, _ = connect(cfg)
            except Exception as e:
                for m in due:
                    _defer(m, str(e))
                _upstream_state(False, str(e))
                return
            _upstream_state(True)
            try:
                for m in due:
                    _send_one(conn, cfg, m)
            finally:
                try:
                    conn.quit()
                except Exception:
                    pass
    except Exception as e:
        print(f"Mail relay delivery run failed: {e}")
    finally:
        _deliver_lock.release()


# ── Page actions ───────────────────────────────────────────────────────────────

def status() -> dict:
    cfg = settings()
    since = datetime.utcnow() - timedelta(hours=24)
    with Session(engine) as s:
        counts = dict(s.exec(select(RelayMessage.status, func.count()).where(RelayMessage.received_at >= since)
                             .group_by(RelayMessage.status)).all())
        queued = s.exec(select(func.count()).select_from(RelayMessage)
                        .where(RelayMessage.status.in_(["queued", "deferred"]))).one()
    return {"enabled": cfg["enabled"], "listening": _controller is not None, "error": _listen_error,
            "port": host_port(), "hostname": cfg["hostname"], "configured": bool(cfg["upstream"]["host"]),
            "upstream": _upstream_last or None, "last_24h": counts, "queued": queued}


def test_upstream() -> tuple[bool, str]:
    try:
        conn, up = connect(settings(masked=False))
    except Exception as e:
        return False, str(e)
    try:
        conn.quit()
    except Exception:
        pass
    return True, f"Connected to {up['host']}:{up['port']}" + (f" and logged in as {up['username']}" if up["username"] else "")


def send_test(to: str, actor: str) -> int:
    """A test message through the whole relay (queue, rewriting, upstream), as if a device sent it."""
    cfg = settings(masked=False)
    msg = EmailMessage()
    msg["From"] = formataddr(("BaumLab test", f"test@{cfg['hostname']}"))
    msg["To"] = to
    msg["Subject"] = "BaumLab mail relay test"
    msg["Date"] = formatdate(usegmt=True)
    msg.set_content(f"This came through the BaumLab mail relay ({cfg['hostname']}:{host_port()}), "
                    f"sent from the Mail relay page by {actor}.\n\nIf you can read it, devices pointed at the relay can send mail too.")
    msg_id = _store(msg.as_bytes(policy=policy.SMTP), f"test@{cfg['hostname']}", [to], "BaumLab", actor, "mail-relay-page")
    kick()
    return msg_id


def messages(status_filter: Optional[str] = None, limit: int = 200) -> list[dict]:
    with Session(engine) as s:
        q = select(RelayMessage)
        if status_filter:
            q = q.where(RelayMessage.status == status_filter)
        rows = s.exec(q.order_by(RelayMessage.id.desc()).limit(limit)).all()
    return [{**r.model_dump(exclude={"file"}), "rcpt_to": json.loads(r.rcpt_to or "[]"),
             "sent_to": json.loads(r.sent_to) if r.sent_to else None, "stored": bool(r.file)} for r in rows]


def retry(msg_id: int) -> bool:
    with Session(engine) as s:
        row = s.get(RelayMessage, msg_id)
        if not row or not row.file or row.status == "rejected":
            return False
        row.status, row.next_attempt_at, row.last_error = "queued", None, None
        s.add(row)
        s.commit()
    kick()
    return True


def delete(msg_id: int):
    with Session(engine) as s:
        row = s.get(RelayMessage, msg_id)
        if row:
            if row.file:
                try:
                    os.remove(_path(row.file))
                except OSError:
                    pass
            s.delete(row)
            s.commit()


def raw_message(msg_id: int) -> Optional[bytes]:
    with Session(engine) as s:
        row = s.get(RelayMessage, msg_id)
    if not row or not row.file:
        return None
    try:
        return open(_path(row.file), "rb").read()
    except OSError:
        return None


def trim():
    """Forget finished messages (and their stored copies) after the retention period."""
    cutoff = datetime.utcnow() - timedelta(days=settings()["retention_days"])
    with Session(engine) as s:
        old = s.exec(select(RelayMessage).where(RelayMessage.received_at < cutoff,
                                                RelayMessage.status.in_(["sent", "failed", "rejected"]))).all()
        for row in old:
            if row.file:
                try:
                    os.remove(_path(row.file))
                except OSError:
                    pass
            s.delete(row)
        s.commit()

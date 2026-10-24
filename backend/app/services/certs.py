"""
TLS certificate expiry tracking for service endpoints (and hand-added hosts).

Each endpoint is read twice: once without verification to always get the certificate
(self-signed included), once with the system CA store to report whether it's trusted.
"""
import json
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from cryptography import x509
from cryptography.x509.oid import ExtensionOID, NameOID
from sqlmodel import Session, select

from ..database import engine
from ..models.cert import CertStatus
from ..models.service import Service
from . import alerts

WARN_DAYS = 21
CRITICAL_DAYS = 7
TIMEOUT = 8


def _name(n: x509.Name) -> str:
    for oid in (NameOID.COMMON_NAME, NameOID.ORGANIZATION_NAME):
        attrs = n.get_attributes_for_oid(oid)
        if attrs:
            return attrs[0].value
    return n.rfc4514_string()


def fetch(host: str, port: int) -> dict:
    """Certificate details for host:port. Never raises — errors are returned in the dict."""
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=TIMEOUT) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
    except (OSError, ssl.SSLError) as e:
        return {"error": str(e)[:300]}
    if not der:
        return {"error": "No certificate presented"}

    cert = x509.load_der_x509_certificate(der)
    try:
        sans = cert.extensions.get_extension_for_oid(ExtensionOID.SUBJECT_ALTERNATIVE_NAME).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        sans = []

    trusted, verify_error = True, None
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as raw:
            with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
                pass
    except ssl.SSLCertVerificationError as e:
        trusted, verify_error = False, (e.verify_message or str(e))[:200]
    except (OSError, ssl.SSLError):
        trusted = None      # second connection failed for another reason — unknown, not "untrusted"

    return {
        "subject": _name(cert.subject),
        "issuer": _name(cert.issuer),
        "sans": ", ".join(sans[:20]),
        # not_valid_after_utc is cryptography ≥ 42; older versions return a naive UTC datetime
        "not_after": (getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after).replace(tzinfo=None),
        "trusted": trusted,
        "verify_error": verify_error,
        "error": None,
    }


def days_left(not_after: Optional[datetime]) -> Optional[int]:
    return None if not_after is None else (not_after - datetime.utcnow()).days


def level(c: CertStatus) -> str:
    """ok | warn | critical | expired | error"""
    if c.error or not c.not_after:
        return "error"
    d = days_left(c.not_after)
    return "expired" if d < 0 else "critical" if d <= CRITICAL_DAYS else "warn" if d <= WARN_DAYS else "ok"


def _service_endpoints(services: list[Service]) -> dict[tuple[str, int], list[int]]:
    """(host, port) → service ids, from https URLs and https protocol services."""
    out: dict[tuple[str, int], list[int]] = {}
    for s in services:
        if s.status == "decommissioned":
            continue
        url = urlparse(s.url or "")
        if url.scheme == "https" and url.hostname:
            out.setdefault((url.hostname.lower(), url.port or 443), []).append(s.id)
        if s.protocol == "https" and s.ip:
            out.setdefault((s.ip, s.port or 443), []).append(s.id)
    return out


def sync_targets(session: Session):
    """Rebuild service-derived rows; keep hand-added ones (just refresh their service links)."""
    endpoints = _service_endpoints(session.exec(select(Service)).all())
    rows = {(r.host, r.port): r for r in session.exec(select(CertStatus)).all()}
    for key, ids in endpoints.items():
        row = rows.get(key) or CertStatus(host=key[0], port=key[1])
        row.service_ids = json.dumps(sorted(set(ids)))
        session.add(row)
    for key, row in rows.items():
        if key not in endpoints:
            if row.manual:
                row.service_ids = "[]"
                session.add(row)
            else:
                session.delete(row)
    session.commit()


_ALERT_RANK = {"ok": 0, "error": 0, "warn": 1, "critical": 2, "expired": 3}


def check_all():
    """Check every endpoint (in parallel) and alert when a certificate gets closer to expiry."""
    with Session(engine) as session:
        sync_targets(session)
        targets = [(r.id, r.host, r.port) for r in session.exec(select(CertStatus)).all()]

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda t: (t[0], fetch(t[1], t[2])), targets))

    pending = []
    with Session(engine) as session:
        for row_id, result in results:
            row = session.get(CertStatus, row_id)
            if not row:
                continue
            for k, v in result.items():
                setattr(row, k, v)
            row.checked_at = datetime.utcnow()
            session.add(row)
            lvl = level(row)
            prev = alerts.transition(f"cert:{row.host}:{row.port}", lvl)
            # Alert only when it gets worse (ok → warn → critical → expired); renewals reset silently
            if prev is not None and _ALERT_RANK[lvl] > _ALERT_RANK.get(prev, 0):
                pending.append(row)
        session.commit()
        for row in pending:
            d = days_left(row.not_after)
            lvl = level(row)
            when = f"expired {-d} day(s) ago" if d < 0 else f"expires in {d} day(s)"
            alerts.notify(
                "cert_expiring", severity="warning" if lvl == "warn" else "critical",
                title=f"🔒 Certificate for {row.host} {when}",
                message=f"{row.host}:{row.port} — issued by {row.issuer}, valid until {row.not_after:%Y-%m-%d}.",
                url=alerts.link("/certificates"),
            )


def check_one(row_id: int) -> CertStatus:
    with Session(engine) as session:
        row = session.get(CertStatus, row_id)
        result = fetch(row.host, row.port)
        for k, v in result.items():
            setattr(row, k, v)
        row.checked_at = datetime.utcnow()
        session.add(row)
        session.commit()
        session.refresh(row)
        alerts.transition(f"cert:{row.host}:{row.port}", level(row))
        return row

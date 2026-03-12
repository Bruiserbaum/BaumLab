"""
OpenVAS / Greenbone Vulnerability Management (GVM) integration.

Communicates directly with gvmd via GMP (Greenbone Management Protocol)
over TLS (TCP) or Unix domain socket — no python-gvm dependency, so there
are no GMP-version-mismatch errors regardless of which gvmd version is running.

Powered by Greenbone Community Edition — https://www.greenbone.net/
OpenVAS is an open-source full-featured vulnerability scanner licensed under GPLv2.
"""
import html
import socket
import ssl
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from typing import Optional

# Standard port list and scanner IDs present in every OpenVAS installation
PORT_LIST_ALL_TCP_NMAP_UDP = "730ef368-57e2-11e1-a90f-406186ea4fc5"
OPENVAS_SCANNER_ID         = "08b69003-5fc2-4037-a479-93b440211c73"


# ── Low-level GMP transport ───────────────────────────────────────────────────

def _connect(host: Optional[str], port: int, socket_path: str) -> socket.socket:
    if host:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        # gvmd uses GnuTLS with self-signed certs; lower security level for compatibility
        try:
            ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        except ssl.SSLError:
            pass
        raw = socket.create_connection((host, port), timeout=30)
        sock = ctx.wrap_socket(raw)   # no SNI — gvmd doesn't need it
        sock.settimeout(30)
        return sock
    else:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(30)
        sock.connect(socket_path)
        return sock


def _recv_xml(sock: socket.socket) -> ET.Element:
    """Read one complete GMP XML response from the socket."""
    data = b""
    while True:
        try:
            chunk = sock.recv(65536)
        except ssl.SSLError as e:
            if data:
                break
            raise ConnectionError(f"TLS read error: {e}") from e
        except (socket.timeout, OSError):
            break
        if not chunk:
            break
        data += chunk
        try:
            return ET.fromstring(data.decode("utf-8"))
        except ET.ParseError:
            pass
    if not data:
        raise ConnectionError("gvmd closed connection without sending data")
    return ET.fromstring(data.decode("utf-8"))


def _cmd(sock: socket.socket, xml: str) -> ET.Element:
    sock.sendall(xml.encode("utf-8"))
    return _recv_xml(sock)


def _x(s: str) -> str:
    """Escape a string for embedding in XML text or attribute values."""
    return html.escape(str(s))


# ── Service class ─────────────────────────────────────────────────────────────

class OpenVasService:
    def __init__(
        self,
        username: str,
        password: str,
        socket_path: str = "/var/run/gvmd/gvmd.sock",
        host: Optional[str] = None,
        port: int = 9390,
    ):
        self.username    = username
        self.password    = password
        self.socket_path = socket_path
        self.host        = host
        self.port        = port

    @contextmanager
    def _session(self):
        sock = _connect(self.host, self.port, self.socket_path)
        try:
            _cmd(sock, "<get_version/>")   # request version (required handshake)
            resp = _cmd(
                sock,
                f"<authenticate><credentials>"
                f"<username>{_x(self.username)}</username>"
                f"<password>{_x(self.password)}</password>"
                f"</credentials></authenticate>",
            )
            if resp.get("status") != "200":
                raise RuntimeError(f"GMP auth failed: {resp.get('status_text', resp.get('status'))}")
            yield sock
        finally:
            try:
                sock.close()
            except Exception:
                pass

    # ── Health ────────────────────────────────────────────────────────────────

    def check_connection(self) -> dict:
        try:
            sock = _connect(self.host, self.port, self.socket_path)
            try:
                ver = _cmd(sock, "<get_version/>")
                return {"connected": True, "version": ver.findtext("version", "unknown")}
            finally:
                sock.close()
        except Exception as e:
            return {"connected": False, "error": str(e)}

    # ── Scan configurations ───────────────────────────────────────────────────

    def get_scan_configs(self) -> list[dict]:
        with self._session() as sock:
            resp = _cmd(sock, "<get_scan_configs/>")
            return [
                {"id": c.get("id"), "name": c.findtext("name", "")}
                for c in resp.findall("config")
                if c.findtext("name") and c.get("type") != "1"
            ]

    # ── Tasks ─────────────────────────────────────────────────────────────────

    def get_tasks(self) -> list[dict]:
        with self._session() as sock:
            resp = _cmd(sock, "<get_tasks/>")
            tasks = []
            for t in resp.findall("task"):
                lr = t.find("last_report/report")
                report_id = lr.get("id") if lr is not None else None
                counts = {}
                if lr is not None:
                    for level in ("high", "medium", "low", "log"):
                        val = lr.findtext(f"result_count/{level}")
                        if val:
                            counts[level] = int(val)
                try:
                    progress = int(t.findtext("progress", "-1"))
                except (ValueError, TypeError):
                    progress = -1
                tasks.append({
                    "id":        t.get("id"),
                    "name":      t.findtext("name", ""),
                    "status":    t.findtext("status", ""),
                    "progress":  progress,
                    "report_id": report_id,
                    "target":    t.findtext("target/name", ""),
                    "counts":    counts,
                    "created":   t.findtext("creation_time", ""),
                })
            return tasks

    def get_task(self, task_id: str) -> Optional[dict]:
        with self._session() as sock:
            resp = _cmd(sock, f'<get_tasks task_id="{_x(task_id)}"/>')
            t = resp.find("task")
            if t is None:
                return None
            lr = t.find("last_report/report")
            try:
                progress = int(t.findtext("progress", "-1"))
            except (ValueError, TypeError):
                progress = -1
            return {
                "id":        t.get("id"),
                "name":      t.findtext("name", ""),
                "status":    t.findtext("status", ""),
                "progress":  progress,
                "report_id": lr.get("id") if lr is not None else None,
                "target":    t.findtext("target/name", ""),
            }

    def create_and_start(
        self, host_target: str, scan_config_id: str, task_name: Optional[str] = None
    ) -> dict:
        name = task_name or f"BaumLab — {host_target}"
        with self._session() as sock:
            t_resp = _cmd(
                sock,
                f"<create_target>"
                f"<name>{_x(name)}</name>"
                f"<hosts>{_x(host_target)}</hosts>"
                f'<port_list id="{PORT_LIST_ALL_TCP_NMAP_UDP}"/>'
                f"</create_target>",
            )
            target_id = t_resp.get("id")

            tk_resp = _cmd(
                sock,
                f"<create_task>"
                f"<name>{_x(name)}</name>"
                f'<config id="{_x(scan_config_id)}"/>'
                f'<target id="{_x(target_id)}"/>'
                f'<scanner id="{OPENVAS_SCANNER_ID}"/>'
                f"</create_task>",
            )
            task_id = tk_resp.get("id")

            _cmd(sock, f'<start_task task_id="{_x(task_id)}"/>')

        return {"task_id": task_id, "target_id": target_id, "name": name}

    def delete_task(self, task_id: str, ultimate: bool = False):
        with self._session() as sock:
            _cmd(sock, f'<delete_task task_id="{_x(task_id)}" ultimate="{"1" if ultimate else "0"}"/>')

    # ── Results ───────────────────────────────────────────────────────────────

    def get_results(self, report_id: str) -> list[dict]:
        with self._session() as sock:
            resp = _cmd(
                sock,
                f'<get_reports report_id="{_x(report_id)}" details="1"'
                f' ignore_pagination="1"'
                f' filter="levels=hmlgd rows=500 min_qod=30 sort-reverse=severity"/>',
            )
            findings = []
            for r in resp.findall(".//result"):
                host_el  = r.find("host")
                host_ip  = (host_el.text or "").strip() if host_el is not None else ""
                hostname = (host_el.findtext("hostname") or "").strip() if host_el is not None else ""
                try:
                    severity = float(r.findtext("severity", "0"))
                except (ValueError, TypeError):
                    severity = 0.0
                cves = [
                    ref.get("id", "") for ref in r.findall(".//ref[@type='cve']")
                    if ref.get("id")
                ]
                findings.append({
                    "id":          r.get("id", ""),
                    "name":        r.findtext("name", "Unknown"),
                    "host":        host_ip,
                    "hostname":    hostname,
                    "port":        r.findtext("port", ""),
                    "severity":    severity,
                    "threat":      r.findtext("threat", "Log"),
                    "description": (r.findtext("description") or "").strip()[:2000],
                    "solution":    (r.findtext("solution") or "").strip()[:500],
                    "cves":        cves,
                })
            findings.sort(key=lambda x: x["severity"], reverse=True)
            return findings

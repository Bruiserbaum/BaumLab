"""
OpenVAS / Greenbone Vulnerability Management (GVM) integration.

Uses python-gvm to communicate with gvmd via Unix socket (recommended for Docker)
or TLS (for remote/networked GVM instances).

Powered by Greenbone Community Edition — https://www.greenbone.net/
OpenVAS is an open-source full-featured vulnerability scanner licensed under GPLv2.
"""
from contextlib import contextmanager
from typing import Optional

from gvm.connections import TLSConnection, UnixSocketConnection
from gvm.errors import GvmError
from gvm.protocols.gmp import Gmp
from gvm.transforms import EtreeCheckCommandTransform

# Standard port list IDs (built into every OpenVAS installation)
PORT_LIST_ALL_TCP_NMAP_UDP = "730ef368-57e2-11e1-a90f-406186ea4fc5"
PORT_LIST_ALL_TCP          = "33d0cd82-57c6-11e1-8ed1-406186ea4fc5"

# Standard scanner ID (OpenVAS Default Scanner)
OPENVAS_SCANNER_ID = "08b69003-5fc2-4037-a479-93b440211c73"


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
        if self.host:
            conn = TLSConnection(hostname=self.host, port=self.port)
        else:
            conn = UnixSocketConnection(path=self.socket_path)
        with Gmp(conn, transform=EtreeCheckCommandTransform()) as gmp:
            gmp.authenticate(self.username, self.password)
            yield gmp

    # ── Health ────────────────────────────────────────────────────────────────

    def check_connection(self) -> dict:
        try:
            with self._session() as gmp:
                ver = gmp.get_version()
                return {
                    "connected": True,
                    "version": ver.findtext("version") or "unknown",
                }
        except Exception as e:
            return {"connected": False, "error": str(e)}

    # ── Scan configurations ───────────────────────────────────────────────────

    def get_scan_configs(self) -> list[dict]:
        with self._session() as gmp:
            resp = gmp.get_scan_configs()
            return [
                {
                    "id":   c.get("id"),
                    "name": c.findtext("name", ""),
                }
                for c in resp.findall("config")
                if c.findtext("name") and c.get("type") != "1"  # skip policy type
            ]

    # ── Tasks ─────────────────────────────────────────────────────────────────

    def get_tasks(self) -> list[dict]:
        with self._session() as gmp:
            resp  = gmp.get_tasks()
            tasks = []
            for t in resp.findall("task"):
                last_report = t.find("last_report/report")
                report_id   = last_report.get("id") if last_report is not None else None
                result_count = last_report.findtext("result_count/full") if last_report is not None else None
                # severity counts from last report
                high   = last_report.findtext("severity/full") if last_report is not None else None
                counts = {}
                if last_report is not None:
                    for level in ("high", "medium", "low", "log"):
                        val = last_report.findtext(f"result_count/{level}")
                        if val:
                            counts[level] = int(val)
                progress_txt = t.findtext("progress", "-1")
                try:
                    progress = int(progress_txt)
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
        with self._session() as gmp:
            resp = gmp.get_task(task_id=task_id)
            t    = resp.find("task")
            if t is None:
                return None
            last_report = t.find("last_report/report")
            report_id   = last_report.get("id") if last_report is not None else None
            progress_txt = t.findtext("progress", "-1")
            try:
                progress = int(progress_txt)
            except (ValueError, TypeError):
                progress = -1
            return {
                "id":        t.get("id"),
                "name":      t.findtext("name", ""),
                "status":    t.findtext("status", ""),
                "progress":  progress,
                "report_id": report_id,
                "target":    t.findtext("target/name", ""),
            }

    def create_and_start(
        self, host_target: str, scan_config_id: str, task_name: Optional[str] = None
    ) -> dict:
        name = task_name or f"BaumLab — {host_target}"
        with self._session() as gmp:
            # Create target
            t_resp = gmp.create_target(
                name=name,
                hosts=[host_target],
                port_list_id=PORT_LIST_ALL_TCP_NMAP_UDP,
            )
            target_id = t_resp.get("id")

            # Create task
            tk_resp = gmp.create_task(
                name=name,
                config_id=scan_config_id,
                target_id=target_id,
                scanner_id=OPENVAS_SCANNER_ID,
            )
            task_id = tk_resp.get("id")

            # Start it
            gmp.start_task(task_id)
        return {"task_id": task_id, "target_id": target_id, "name": name}

    def delete_task(self, task_id: str, ultimate: bool = False):
        with self._session() as gmp:
            gmp.delete_task(task_id=task_id, ultimate=ultimate)

    # ── Results ───────────────────────────────────────────────────────────────

    def get_results(self, report_id: str) -> list[dict]:
        with self._session() as gmp:
            resp = gmp.get_report(
                report_id=report_id,
                filter_string="levels=hmlgd rows=500 min_qod=30 sort-reverse=severity",
                details=True,
                ignore_pagination=True,
            )
            findings = []
            for r in resp.findall(".//result"):
                host_el  = r.find("host")
                host_ip  = ""
                hostname = ""
                if host_el is not None:
                    host_ip  = (host_el.text or "").strip()
                    hostname = (host_el.findtext("hostname") or "").strip()

                severity_txt = r.findtext("severity", "0")
                try:
                    severity = float(severity_txt)
                except (ValueError, TypeError):
                    severity = 0.0

                cves = [ref.get("id", "") for ref in r.findall(".//ref[@type='cve']") if ref.get("id")]

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

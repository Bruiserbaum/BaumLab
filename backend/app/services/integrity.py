"""
Background consistency checks — keep BaumLab's linked pieces in sync behind the scenes.

Every 15 minutes (and on demand) this walks the links between services, Terminal hosts,
the vault, monitors, Docker containers, backups and icons. Safe repairs are applied
automatically and recorded; anything that needs a decision is reported, alerted once,
and re-armed when it's resolved. startup_cleanup() closes out work a restart interrupted.
"""
import json
import re
from datetime import datetime, timedelta
from typing import Optional

from sqlmodel import Session, select

from ..database import engine
from ..models.backup import BackupDestination, BackupJob, BackupRecord, BackupRun, BackupStack
from ..models.bookmark import Bookmark
from ..models.monitor import MonitorTarget
from ..models.portainer import ContainerSnapshot
from ..models.service import Service
from ..models.terminal import SshHost, TerminalSession
from ..models.vault import VaultEntry
from . import alerts, icons
from .config_service import read_config

_last: dict = {"ran_at": None, "findings": [], "startup": None}


def last_results() -> dict:
    return _last


def _slug(text: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def startup_cleanup() -> dict:
    """Close out work interrupted by a restart: backup runs and terminal sessions left 'open'."""
    now = datetime.utcnow()
    with Session(engine) as s:
        runs = s.exec(select(BackupRun).where(BackupRun.status == "running")).all()
        for r in runs:
            r.status, r.completed_at = "failed", now
            r.error = "Interrupted — BaumLab restarted while this was running"
            s.add(r)
        sessions = s.exec(select(TerminalSession).where(TerminalSession.ended_at == None)).all()  # noqa: E711
        for t in sessions:
            t.ended_at, t.end_reason = now, "BaumLab restarted"
            s.add(t)
        s.commit()
    _last["startup"] = {"at": now.isoformat(), "interrupted_runs": len(runs), "closed_sessions": len(sessions)}
    return _last["startup"]


def run_checks() -> list[dict]:
    findings: list[dict] = []

    def fixed(check: str, text: str, link: str):
        findings.append({"key": None, "check": check, "severity": "fixed", "text": text, "link": link})

    def issue(key: str, check: str, severity: str, text: str, link: str):
        findings.append({"key": key, "check": check, "severity": severity, "text": text, "link": link})

    with Session(engine) as s:
        services = {x.id: x for x in s.exec(select(Service)).all()}
        live = {i: x for i, x in services.items() if x.status != "decommissioned"}

        # ── SSH services ↔ Terminal hosts ──────────────────────────────────────
        for svc in live.values():
            if svc.protocol == "tcp" and svc.port == 22:
                svc.protocol = "ssh"
                s.add(svc)
                fixed("Services", f"Marked {svc.name} as SSH (port 22) so it appears in the Terminal", "/services")
        hosts = s.exec(select(SshHost)).all()
        linked_services = {h.service_id for h in hosts if h.service_id}
        for svc in live.values():
            if svc.protocol != "ssh" or not svc.ip or svc.id in linked_services:
                continue
            match = next((h for h in hosts if h.address == svc.ip and h.port == (svc.port or 22) and not h.service_id), None)
            if match:
                match.service_id = svc.id
                s.add(match)
                fixed("Terminal", f"Linked Terminal host {match.name} to SSH service {svc.name}", "/terminal")
            else:
                login = s.exec(select(VaultEntry).where(VaultEntry.service_id == svc.id)).first()
                host = SshHost(name=svc.name, address=svc.ip, port=svc.port or 22, service_id=svc.id,
                               username=(login.username or "") if login else "", credential_id=login.id if login else None)
                s.add(host)
                hosts.append(host)
                fixed("Terminal", f"Added SSH service {svc.name} to the Terminal", "/terminal")
            linked_services.add(svc.id)
        for h in hosts:
            if h.service_id and h.service_id not in services:
                h.service_id = None
                s.add(h)
                fixed("Terminal", f"Unlinked Terminal host {h.name} from a deleted service", "/terminal")
            if h.credential_id and not s.get(VaultEntry, h.credential_id):
                h.credential_id = None
                s.add(h)
                fixed("Terminal", f"Cleared {h.name}'s link to a deleted vault entry", "/terminal")
            if not h.credential_id or not h.username:
                issue(f"terminal-login:{h.id}", "Terminal", "info",
                      f"Terminal host {h.name} has no {'login' if not h.credential_id else 'username'} — it can't connect yet",
                      "/terminal")

        # ── Vault ↔ services ───────────────────────────────────────────────────
        for e in s.exec(select(VaultEntry).where(VaultEntry.service_id != None)).all():  # noqa: E711
            if e.service_id not in services:
                e.service_id = None
                s.add(e)
                fixed("Vault", f"Unlinked vault entry {e.title} from a deleted service", "/vault")

        # ── Monitors ↔ services ────────────────────────────────────────────────
        monitors = {m.id: m for m in s.exec(select(MonitorTarget)).all()}
        for svc in services.values():
            if svc.monitor_id and svc.monitor_id not in monitors:
                svc.monitor_id = None
                s.add(svc)
                fixed("Monitors", f"Cleared {svc.name}'s link to a deleted monitor", "/services")
            elif svc.monitor_id and svc.status == "decommissioned" and monitors[svc.monitor_id].enabled:
                issue(f"monitor-retired:{svc.monitor_id}", "Monitors", "info",
                      f"Monitor {monitors[svc.monitor_id].name} still runs for decommissioned service {svc.name} — pause it?",
                      "/monitors")

        # ── Docker containers ↔ services ───────────────────────────────────────
        snapshots = s.exec(select(ContainerSnapshot)).all()
        polled = {c.connection_name for c in snapshots}
        by_key = {(c.connection_name, c.endpoint_id, c.name): c for c in snapshots}
        linked_keys = {(x.container_connection, x.container_endpoint_id, x.container_name)
                       for x in services.values() if x.container_name}
        for svc in live.values():
            if svc.container_name:
                key = (svc.container_connection, svc.container_endpoint_id, svc.container_name)
                if svc.container_connection in polled and key not in by_key:
                    issue(f"container-gone:{svc.id}", "Docker", "warning",
                          f"{svc.name}'s container {svc.container_name} no longer exists in Portainer", "/services")
            elif svc.platform == "docker" and snapshots:
                candidates = [c for c in snapshots if _slug(c.name) == _slug(svc.name)
                              and (c.connection_name, c.endpoint_id, c.name) not in linked_keys]
                if len(candidates) == 1:
                    c = candidates[0]
                    svc.container_connection, svc.container_endpoint_id, svc.container_name = c.connection_name, c.endpoint_id, c.name
                    s.add(svc)
                    linked_keys.add((c.connection_name, c.endpoint_id, c.name))
                    fixed("Docker", f"Linked {svc.name} to container {c.name} ({c.endpoint_name})", "/services")
        if snapshots:
            newest = max(c.checked_at for c in snapshots)
            if datetime.utcnow() - newest > timedelta(minutes=15):
                issue("portainer-stale", "Docker", "warning",
                      f"Portainer data hasn't refreshed since {newest:%Y-%m-%d %H:%M} UTC — check the connection on the Docker page",
                      "/portainer")

        # ── Backups ────────────────────────────────────────────────────────────
        destinations = {d.id for d in s.exec(select(BackupDestination)).all()}
        targets = [("job", j) for j in s.exec(select(BackupJob)).all()] + \
                  [("stack", x) for x in s.exec(select(BackupStack)).all()]
        for kind, t in targets:
            ids = json.loads(t.service_ids or "[]")
            kept = [i for i in ids if i in services]
            if kept != ids:
                t.service_ids = json.dumps(kept)
                s.add(t)
                fixed("Backups", f"Removed deleted services from backup {kind} {t.name}", "/backups")
            if t.destination_id not in destinations:
                issue(f"backup-dest:{kind}:{t.id}", "Backups", "error",
                      f"Backup {kind} {t.name} points at a destination that no longer exists", "/backups?tab=jobs")
        for rec in s.exec(select(BackupRecord)).all():
            if rec.service_id not in services:
                s.delete(rec)
                fixed("Backups", f"Removed external backup record '{rec.method}' for a deleted service", "/backups")

        # ── Icons ──────────────────────────────────────────────────────────────
        for item in [*services.values(), *s.exec(select(Bookmark)).all()]:
            if item.icon and not icons.file_path(item.icon):
                item.icon = None
                s.add(item)
                fixed("Launchpad", f"Cleared missing icon file for {item.name}", "/launchpad")

        s.commit()

    findings += _check_runtime(bool(targets))
    _alert(findings)
    _last.update(ran_at=datetime.utcnow().isoformat(), findings=findings)
    return findings


def _check_runtime(has_backups: bool) -> list[dict]:
    """Things that live outside the database: scheduler, Docker socket, OpenVAS, Git sync, vault."""
    from . import backup_docker, backup_schedule, git_sync, vault
    out = []

    # Backup schedules that dropped out of the scheduler (e.g. after an error) — re-register
    try:
        with Session(engine) as s:
            for job in s.exec(select(BackupJob).where(BackupJob.enabled == True)).all():  # noqa: E712
                if job.schedule_cron and not backup_schedule.next_run("job", job.id):
                    backup_schedule.schedule_job(job)
                    out.append({"key": None, "check": "Backups", "severity": "fixed",
                                "text": f"Re-registered the schedule for backup job {job.name}", "link": "/backups?tab=jobs"})
            for stack in s.exec(select(BackupStack).where(BackupStack.enabled == True)).all():  # noqa: E712
                if stack.schedule_cron and not backup_schedule.next_run("stack", stack.id):
                    backup_schedule.schedule_stack(stack)
                    out.append({"key": None, "check": "Backups", "severity": "fixed",
                                "text": f"Re-registered the schedule for stack backup {stack.name}", "link": "/backups?tab=stacks"})
    except Exception as e:
        out.append({"key": "scheduler", "check": "Backups", "severity": "error",
                    "text": f"Couldn't verify backup schedules: {e}", "link": "/backups"})

    if has_backups and not backup_docker.status().get("docker"):
        out.append({"key": "docker-socket", "check": "Backups", "severity": "error",
                    "text": "Backups are configured but the Docker socket isn't available to BaumLab", "link": "/backups"})

    from . import openvas_setup
    ov = read_config().get("openvas", {})
    if openvas_setup.mode(ov) == "auto" or ov.get("password"):
        try:
            st = openvas_setup.check()
            # Starting up / importing feeds is expected after a deploy, not a problem
            if st["state"] not in openvas_setup.USABLE | {"starting", "loading", "unknown"}:
                out.append({"key": "openvas", "check": "OpenVAS", "severity": "warning",
                            "text": f"OpenVAS: {st['message']}", "link": "/settings"})
        except Exception as e:
            out.append({"key": "openvas", "check": "OpenVAS", "severity": "warning",
                        "text": f"OpenVAS check failed: {e}", "link": "/settings"})

    gs = git_sync.status()
    if gs.get("configured") and gs.get("last_error"):
        out.append({"key": "git-sync", "check": "Git sync", "severity": "warning",
                    "text": f"Git sync is failing: {gs['last_error']}", "link": "/services"})

    reason = vault.lock_reason()
    if reason:
        out.append({"key": "vault-locked", "check": "Vault", "severity": "warning",
                    "text": f"Vault locked: {reason}", "link": "/vault"})
    return out


def _alert(findings: list[dict]):
    """One alert per new problem; re-arms once it clears."""
    open_keys = {f["key"] for f in findings if f["key"] and f["severity"] in ("warning", "error")}
    for f in findings:
        if f["key"] in open_keys and alerts.transition(f"integrity:{f['key']}", "open") is not None:
            try:
                alerts.notify("integrity", severity="critical" if f["severity"] == "error" else "warning",
                              title=f"🩺 {f['check']}: needs attention", message=f["text"], url=alerts.link(f["link"]))
            except Exception as e:
                print(f"Integrity alert failed: {e}")
    with Session(engine) as s:
        from ..models.alert import AlertState
        for st in s.exec(select(AlertState).where(AlertState.key.startswith("integrity:"))).all():
            if st.key.split(":", 1)[1] not in open_keys and st.state != "ok":
                st.state, st.changed_at = "ok", datetime.utcnow()
                s.add(st)
        s.commit()

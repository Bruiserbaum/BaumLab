"""
Cron scheduling for backup jobs / stacks on BaumLab's scheduler, and per-service
backup coverage (is each service protected, and is the latest backup fresh?).
"""
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from apscheduler.triggers.cron import CronTrigger
from sqlmodel import Session, select

from ..database import engine
from ..models.backup import BackupJob, BackupRecord, BackupStack, RecoveryKit
from . import alerts, backup_engine, recovery_kits, vault_backup

_scheduler = None
MANUAL_STACK_STALE_DAYS = 30


def init(scheduler):
    """Called at startup: keep a scheduler reference and register every enabled schedule."""
    global _scheduler
    _scheduler = scheduler
    with Session(engine) as s:
        for job in s.exec(select(BackupJob)).all():
            schedule_job(job)
        for stack in s.exec(select(BackupStack)).all():
            schedule_stack(stack)
        for kit in s.exec(select(RecoveryKit)).all():
            schedule_kit(kit)
    schedule_vault()
    # Every Sunday morning, download each kit's newest archive and check it end to end
    scheduler.add_job(recovery_kits.verify_all, CronTrigger.from_crontab("0 5 * * 0"), id="verify_kits",
                      replace_existing=True, misfire_grace_time=6 * 3600, coalesce=True, max_instances=1)


def parse_cron(expr: str) -> CronTrigger:
    if len((expr or "").split()) != 5:
        raise ValueError("Cron needs 5 fields: minute hour day month weekday (e.g. 0 3 * * *)")
    return CronTrigger.from_crontab(expr)


def _set(job_id: str, func, cron: Optional[str], enabled: bool, args: list):
    if not _scheduler:
        return
    if _scheduler.get_job(job_id):
        _scheduler.remove_job(job_id)
    if enabled and cron:
        try:
            # Sync functions run in the scheduler's thread pool, off the event loop
            _scheduler.add_job(func, parse_cron(cron), id=job_id, args=args, replace_existing=True,
                               misfire_grace_time=3600, coalesce=True, max_instances=1)
        except ValueError as e:
            print(f"Backup schedule {job_id} not registered: {e}")


def schedule_job(job: BackupJob):
    _set(f"backup_job_{job.id}", backup_engine.run_job_backup, job.schedule_cron, job.enabled, [job.id])


def schedule_stack(stack: BackupStack):
    _set(f"backup_stack_{stack.id}", backup_engine.run_stack_backup, stack.schedule_cron, stack.enabled, [stack.id])


def schedule_kit(kit: RecoveryKit):
    _set(f"backup_kit_{kit.id}", recovery_kits.run_kit_backup, kit.schedule_cron, kit.enabled, [kit.id])


def schedule_vault():
    t = vault_backup.target()
    _set("backup_vault_0", vault_backup.run_vault_backup, t.schedule_cron, t.enabled, [])


def unschedule(kind: str, target_id: int):
    if _scheduler and _scheduler.get_job(f"backup_{kind}_{target_id}"):
        _scheduler.remove_job(f"backup_{kind}_{target_id}")


def next_run(kind: str, target_id: int) -> Optional[str]:
    job = _scheduler.get_job(f"backup_{kind}_{target_id}") if _scheduler else None
    return job.next_run_time.isoformat() if job and job.next_run_time else None


def run_now(func, *args):
    """Run a backup/restore once, immediately, in the scheduler's thread pool."""
    _scheduler.add_job(func, args=list(args), misfire_grace_time=None)


# ── Coverage ───────────────────────────────────────────────────────────────────

def _interval(cron: Optional[str]) -> Optional[timedelta]:
    """Gap between two consecutive scheduled runs."""
    if not cron:
        return None
    try:
        trigger = parse_cron(cron)
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    first = trigger.get_next_fire_time(None, now)
    second = trigger.get_next_fire_time(first, first + timedelta(seconds=1)) if first else None
    return (second - first) if first and second else None


def freshness(enabled: bool, cron: Optional[str], last_status: Optional[str],
              last_success: Optional[datetime], fallback_days: int = MANUAL_STACK_STALE_DAYS) -> str:
    """ok | stale | failed | never | disabled"""
    if not enabled:
        return "disabled"
    if last_status == "failed":
        return "failed"
    if not last_success:
        return "never"
    interval = _interval(cron)
    # Allow one missed run plus an hour before calling it stale
    limit = (interval * 2 + timedelta(hours=1)) if interval else timedelta(days=fallback_days)
    return "stale" if datetime.utcnow() - last_success > limit else "ok"


def check_stale_alerts():
    """Alert once when a job / stack misses its schedule; re-arms when it's fresh again."""
    with Session(engine) as s:
        targets = [("job", j) for j in s.exec(select(BackupJob)).all()] + \
                  [("stack", x) for x in s.exec(select(BackupStack)).all()] + \
                  [("recovery kit", k) for k in s.exec(select(RecoveryKit)).all()] + \
                  [("vault backup", vault_backup.target())]
    for kind, t in targets:
        status = freshness(t.enabled, t.schedule_cron, t.last_run_status, t.last_success_at)
        prev = alerts.transition(f"backup:{kind.split()[-1]}:{t.id}", status)
        if status == "stale" and prev is not None:
            last = f"{t.last_success_at:%Y-%m-%d %H:%M} UTC" if t.last_success_at else "never"
            alerts.notify("backup_stale", severity="warning", title=f"⚠️ Backup stale: {t.name}",
                          message=f"The {kind} backup '{t.name}' last succeeded {last} and has missed its schedule"
                                  f" ({t.schedule_cron or 'manual'}).", url=alerts.link("/backups"))


_RANK = {"ok": 0, "stale": 1, "failed": 2, "never": 3, "disabled": 4}


def coverage() -> dict[int, dict]:
    """{service_id: {status, sources: [...]}} — status is the best of its sources."""
    result: dict[int, dict] = {}

    def add(service_id: int, source: dict):
        entry = result.setdefault(service_id, {"status": None, "sources": []})
        entry["sources"].append(source)
        if entry["status"] is None or _RANK[source["status"]] < _RANK[entry["status"]]:
            entry["status"] = source["status"]

    with Session(engine) as s:
        for job in s.exec(select(BackupJob)).all():
            status = freshness(job.enabled, job.schedule_cron, job.last_run_status, job.last_success_at)
            for sid in json.loads(job.service_ids or "[]"):
                add(sid, {"kind": "job", "id": job.id, "name": job.name, "status": status,
                          "last_success_at": job.last_success_at})
        for stack in s.exec(select(BackupStack)).all():
            status = freshness(stack.enabled, stack.schedule_cron, stack.last_run_status, stack.last_success_at)
            for sid in json.loads(stack.service_ids or "[]"):
                add(sid, {"kind": "stack", "id": stack.id, "name": stack.name, "status": status,
                          "last_success_at": stack.last_success_at})
        for kit in s.exec(select(RecoveryKit)).all():
            status = freshness(kit.enabled, kit.schedule_cron, kit.last_run_status, kit.last_success_at)
            for sid in json.loads(kit.service_ids or "[]"):
                add(sid, {"kind": "kit", "id": kit.id, "name": kit.name, "status": status,
                          "last_success_at": kit.last_success_at})
        for rec in s.exec(select(BackupRecord)).all():
            if not rec.last_verified_at:
                status = "never"
            else:
                age = datetime.utcnow() - rec.last_verified_at
                status = "stale" if age > timedelta(days=rec.frequency_days, hours=12) else "ok"
            add(rec.service_id, {"kind": "record", "id": rec.id, "name": rec.method, "status": status,
                                 "last_success_at": rec.last_verified_at})
    return result

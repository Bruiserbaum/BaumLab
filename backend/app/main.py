import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlmodel import Session, select
from datetime import datetime

from .database import create_db_and_tables, migrate_db, engine
from .models.monitor import MonitorTarget, MonitorResult
from .models.user import User
from .models.vuln_schedule import ScheduledVulnScan
from .services.monitor import run_check
from .services.auth import hash_password
from .routers import devices, monitors, scan, unifi, auth, users, settings, external_scan, status, advanced_scan, vuln_scan
from .routers import syslog as syslog_router, portainer as portainer_router
from .services.config_service import read_config, decrypt
from .services.syslog_listener import start_syslog_listener
from .routers.portainer import _poll_all
from .routers.scan import _upsert_devices

APP_VERSION = "1.0.0"  # bump this on every release

scheduler = AsyncIOScheduler()


async def _run_monitor_checks():
    """Called by APScheduler every 30 s; runs only targets whose interval is due."""
    now = datetime.utcnow()
    with Session(engine) as session:
        targets = session.exec(
            select(MonitorTarget).where(MonitorTarget.enabled == True)
        ).all()
        for target in targets:
            # Check last result to see if interval has elapsed
            last = session.exec(
                select(MonitorResult)
                .where(MonitorResult.target_id == target.id)
                .order_by(MonitorResult.checked_at.desc())
                .limit(1)
            ).first()
            if last:
                elapsed = (now - last.checked_at).total_seconds()
                if elapsed < target.interval_seconds:
                    continue
            result = await run_check(target.protocol, target.host, target.port)
            row = MonitorResult(
                target_id=target.id,
                checked_at=now,
                is_up=result["is_up"],
                latency_ms=result.get("latency_ms"),
                status_code=result.get("status_code"),
                error=result.get("error"),
            )
            session.add(row)
        session.commit()


async def _run_scheduled_vuln_scans():
    """Run any vuln scans that are due based on their weekly/monthly frequency."""
    from .services.openvas import OpenVasService
    cfg = read_config().get("openvas", {})
    if not cfg.get("username"):
        return  # OpenVAS not configured
    svc = OpenVasService(
        username=cfg.get("username", "admin"),
        password=decrypt(cfg.get("password", "")),
        socket_path=cfg.get("socket_path", "/var/run/gvmd/gvmd.sock"),
        host=cfg.get("host") or None,
        port=int(cfg.get("port", 9390)),
    )
    now = datetime.utcnow()
    with Session(engine) as session:
        schedules = session.exec(
            select(ScheduledVulnScan).where(ScheduledVulnScan.enabled == True)
        ).all()
        for s in schedules:
            if s.last_run_at is not None:
                elapsed_days = (now - s.last_run_at).total_seconds() / 86400
                threshold = 7 if s.frequency == "weekly" else 30
                if elapsed_days < threshold:
                    continue
            try:
                result = svc.create_and_start(
                    host_target=s.target,
                    scan_config_id=s.scan_config_id,
                    task_name=f"{s.name} (scheduled {now.strftime('%Y-%m-%d')})",
                )
                s.last_run_at = now
                s.last_task_id = result["task_id"]
                s.last_task_name = result["name"]
                session.add(s)
                print(f"Scheduled vuln scan '{s.name}' started: task {result['task_id']}")
            except Exception as e:
                print(f"Scheduled vuln scan '{s.name}' failed: {e}")
        session.commit()


def _seed_admin():
    """Create the initial admin user from env vars if no users exist yet."""
    # .strip() guards against invisible trailing whitespace from Portainer / .env files
    username = os.getenv("ADMIN_USERNAME", "admin").strip()
    password = os.getenv("ADMIN_PASSWORD", "").strip()
    if not password:
        print("WARNING: ADMIN_PASSWORD not set — skipping admin seed")
        return
    with Session(engine) as session:
        if session.exec(select(User)).first():
            return  # Users already exist, don't overwrite
        admin = User(
            username=username,
            hashed_password=hash_password(password),
            is_admin=True,
        )
        session.add(admin)
        session.commit()
        print(f"Admin user '{username}' created")


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    migrate_db()
    _seed_admin()
    scheduler.add_job(_run_monitor_checks, "interval", seconds=30, id="monitor_checks")
    # Check scheduled vuln scans every 6 hours
    scheduler.add_job(_run_scheduled_vuln_scans, "interval", hours=6, id="vuln_scan_scheduler")

    # Auto-scan if configured
    sc = read_config().get("scan", {})
    if sc.get("auto_scan") and sc.get("default_cidr"):
        interval_min = int(sc.get("auto_scan_interval_minutes", 60))
        scheduler.add_job(
            _upsert_devices, "interval", minutes=interval_min,
            args=[sc["default_cidr"]], id="auto_scan",
        )
        print(f"Auto-scan enabled: {sc['default_cidr']} every {interval_min} min")

    # Syslog UDP listener
    syslog_transport = None
    cfg = read_config()
    syslog_cfg = cfg.get("syslog", {})
    if syslog_cfg.get("enabled", True):
        syslog_port = int(syslog_cfg.get("port", 514))
        try:
            syslog_transport, _ = await start_syslog_listener(engine, port=syslog_port)
        except Exception as e:
            print(f"WARNING: Could not start syslog listener on UDP :{syslog_port} — {e}")

    # Portainer polling (every 60 s by default, configurable)
    # Always register the job so new connections added after startup are picked up automatically
    poll_interval = int(cfg.get("portainer", {}).get("poll_interval_seconds", 60))
    scheduler.add_job(_poll_all, "interval", seconds=poll_interval, id="portainer_poll")
    print(f"Portainer polling enabled every {poll_interval}s")

    scheduler.start()
    yield
    scheduler.shutdown()
    if syslog_transport:
        syslog_transport.close()


app = FastAPI(title="BaumLab API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(devices.router)
app.include_router(monitors.router)
app.include_router(scan.router)
app.include_router(unifi.router)
app.include_router(settings.router)
app.include_router(external_scan.router)
app.include_router(status.router)
app.include_router(advanced_scan.router)
app.include_router(vuln_scan.router)
app.include_router(syslog_router.router)
app.include_router(portainer_router.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}

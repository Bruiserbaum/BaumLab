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
from .services.monitor import run_check
from .services.auth import hash_password
from .routers import devices, monitors, scan, unifi, auth, users, settings, external_scan, status, advanced_scan
from .services.config_service import read_config
from .routers.scan import _upsert_devices

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
    # Auto-scan if configured
    sc = read_config().get("scan", {})
    if sc.get("auto_scan") and sc.get("default_cidr"):
        interval_min = int(sc.get("auto_scan_interval_minutes", 60))
        scheduler.add_job(
            _upsert_devices, "interval", minutes=interval_min,
            args=[sc["default_cidr"]], id="auto_scan",
        )
        print(f"Auto-scan enabled: {sc['default_cidr']} every {interval_min} min")
    scheduler.start()
    yield
    scheduler.shutdown()


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


@app.get("/api/health")
def health():
    return {"status": "ok"}

from sqlmodel import SQLModel, create_engine, Session
import os

# Ensure all models are registered with SQLModel.metadata before create_all()
from .models import syslog as _syslog_models   # noqa: F401
from .models import portainer as _portainer_models  # noqa: F401
from .models import vuln_schedule as _vuln_schedule_models  # noqa: F401
from .models import service as _service_models  # noqa: F401
from .models import vault as _vault_models  # noqa: F401

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/baumlab.db")

# connect_args only needed for SQLite
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=connect_args)


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)


def migrate_db():
    """Add new columns to existing tables (SQLite ALTER TABLE, idempotent)."""
    from sqlalchemy import text
    migrations = [
        "ALTER TABLE user ADD COLUMN totp_secret TEXT",
        "ALTER TABLE user ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT 0",
        "ALTER TABLE user ADD COLUMN oidc_sub TEXT",
        "CREATE INDEX IF NOT EXISTS ix_user_oidc_sub ON user (oidc_sub)",
        "ALTER TABLE service ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
        "ALTER TABLE service ADD COLUMN decommissioned_at DATETIME",
        "ALTER TABLE service ADD COLUMN credential_ref TEXT",
        "ALTER TABLE containersnapshot ADD COLUMN host TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE containersnapshot ADD COLUMN ports TEXT NOT NULL DEFAULT ''",
    ]
    with engine.connect() as conn:
        for stmt in migrations:
            try:
                conn.execute(text(stmt))
                conn.commit()
            except Exception:
                pass  # Column already exists


def get_session():
    with Session(engine) as session:
        yield session

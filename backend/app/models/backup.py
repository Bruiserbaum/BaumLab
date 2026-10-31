"""
Backups (merged from BaumLabBackup): destinations, container backup jobs, compose
stack backups, run history, and manual records for backups made outside BaumLab.
"""
from datetime import datetime
from typing import Optional
from sqlmodel import Field, SQLModel


class BackupDestination(SQLModel, table=True):
    """Where archives go. Config (incl. credentials) is encrypted; rclone remote is dest_<id>."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    type: str                                   # b2 | smb | sftp | local
    config_enc: str                             # encrypted JSON
    created_at: datetime = Field(default_factory=datetime.utcnow)


class BackupJob(SQLModel, table=True):
    """Archive container volumes / bind mounts (+ optional DB dump) on a cron schedule."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    containers: str = "[]"                      # JSON list of container names (stopped if pre_stop)
    volumes: str = "[]"                         # JSON list of {type: volume|bind, source, name}
    db_type: Optional[str] = None               # mysql | postgres | None
    db_container: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    db_password_enc: Optional[str] = None
    destination_id: int = Field(foreign_key="backupdestination.id")
    schedule_cron: str = "0 3 * * *"
    pre_stop: bool = False
    retention_days: int = 30
    enabled: bool = True
    service_ids: str = "[]"                     # JSON list of Service ids this job protects
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None       # success | failed
    last_success_at: Optional[datetime] = None


class BackupStack(SQLModel, table=True):
    """Disaster-recovery backup of a compose stack: named volumes + encrypted env + repo info."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    repo_url: str = ""
    repo_branch: str = "main"
    env_path: str = ""                          # optional path readable inside the container
    compose_project: str
    volumes: str = "[]"                         # JSON list of volume names
    destination_id: int = Field(foreign_key="backupdestination.id")
    schedule_cron: Optional[str] = None         # None = manual only
    retention_days: int = 30
    enabled: bool = True
    service_ids: str = "[]"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    last_success_at: Optional[datetime] = None


class BackupRun(SQLModel, table=True):
    """One backup or restore execution of a job or stack."""
    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = "job"                           # job | stack
    target_id: Optional[int] = Field(default=None, index=True)
    target_name: str = ""
    run_type: str = "backup"                    # backup | restore
    status: str = "running"                     # running | success | failed
    started_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: Optional[datetime] = None
    size_bytes: Optional[int] = None
    archive_path: Optional[str] = None          # remote:path/file.tar.gz
    log_lines: str = "[]"                       # JSON list of strings
    error: Optional[str] = None


class BackupRecord(SQLModel, table=True):
    """A backup that happens outside BaumLab (Unraid, Proxmox, NAS snapshot...), tracked by hand."""
    id: Optional[int] = Field(default=None, primary_key=True)
    service_id: int = Field(foreign_key="service.id", index=True)
    method: str                                 # "Unraid appdata backup", "Proxmox vzdump", ...
    location: Optional[str] = None              # where the copies live
    frequency_days: int = 7                     # expected interval — stale after this
    last_verified_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RecoveryKit(SQLModel, table=True):
    """Everything needed to rebuild one Docker service from nothing, collected through Portainer on any host:
    compose definition, environment (passphrase-encrypted), every mount's data, database dumps, RESTORE.md."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    connection: str                             # Portainer connection name
    endpoint_id: int
    endpoint_name: str = ""
    project: Optional[str] = None               # compose project / Portainer stack name (None = containers below)
    containers: str = "[]"                      # JSON list — standalone containers when project is None
    exclude_mounts: str = "[]"                  # JSON list of "container:/path" mounts to skip (media libraries…)
    dump_databases: bool = True                 # auto-detected Postgres / MySQL / MariaDB / Mongo containers
    stop_during_backup: bool = False            # stop the containers while their files are copied
    cold_copy_fallback: bool = True             # a database dump fails → stop the service and copy its files cold
    destination_id: int = Field(foreign_key="backupdestination.id")
    schedule_cron: Optional[str] = "30 3 * * *"
    retention_days: int = 30
    enabled: bool = True
    service_ids: str = "[]"
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    last_success_at: Optional[datetime] = None
    last_verified_at: Optional[datetime] = None  # newest kit downloaded and checked end to end
    last_verify_status: Optional[str] = None     # success | failed
    last_verify_message: Optional[str] = None

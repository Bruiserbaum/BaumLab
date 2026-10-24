"""
Backup / restore execution (ported from BaumLabBackup). Runs in scheduler worker threads.

Job archive layout:   <name>_<ts>/manifest.json, db_*.sql, mounts/<archive>.tar.gz
Stack archive layout: stack_<name>_<ts>/manifest.json, env/dot-env.enc, volumes/<volume>.tar.gz
Older BaumLabBackup job archives (volumes/*.tar.gz, no manifest) restore as named volumes.
"""
import base64
import json
import os
import shutil
import tarfile
import threading
from datetime import datetime
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlmodel import Session

from ..database import engine
from ..models.backup import BackupDestination, BackupJob, BackupRun, BackupStack
from . import backup_docker as dk
from . import backup_storage as st
from . import vault
from .config_service import decrypt, read_config

_running: set[tuple[str, int]] = set()
_running_lock = threading.Lock()


class _Run:
    """Run record + log, written through short-lived sessions (safe from worker threads)."""

    def __init__(self, kind: str, target_id: int, target_name: str, run_type: str):
        with Session(engine) as s:
            run = BackupRun(kind=kind, target_id=target_id, target_name=target_name, run_type=run_type)
            s.add(run)
            s.commit()
            self.id = run.id
        self.warnings: list[str] = []

    def log(self, text: str, warning: bool = False):
        if warning:
            self.warnings.append(text)
        with Session(engine) as s:
            run = s.get(BackupRun, self.id)
            lines = json.loads(run.log_lines or "[]")
            lines.append(f"[{datetime.utcnow():%Y-%m-%d %H:%M:%S}] {'WARNING: ' if warning else ''}{text}")
            run.log_lines = json.dumps(lines)
            s.add(run)
            s.commit()

    def finish(self, error: Optional[str] = None, size: Optional[int] = None, archive: Optional[str] = None) -> str:
        status = "failed" if error else ("warning" if self.warnings else "success")
        with Session(engine) as s:
            run = s.get(BackupRun, self.id)
            run.status = status
            run.completed_at = datetime.utcnow()
            run.size_bytes = size
            run.archive_path = archive
            run.error = error or ("; ".join(self.warnings)[:1000] if self.warnings else None)
            s.add(run)
            s.commit()
        self.log(f"Finished: {status}" + (f" — {error}" if error else ""))
        return status


def _claim(kind: str, target_id: int) -> bool:
    with _running_lock:
        if (kind, target_id) in _running:
            return False
        _running.add((kind, target_id))
        return True


def _release(kind: str, target_id: int):
    with _running_lock:
        _running.discard((kind, target_id))


def is_running(kind: str, target_id: int) -> bool:
    return (kind, target_id) in _running


def _stamp() -> str:
    return datetime.utcnow().strftime("%Y%m%d_%H%M%S")


def _extract(archive: str, into: str) -> str:
    """Extract safely (no absolute paths / traversal / devices) and return the top-level folder."""
    os.makedirs(into, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(into, filter="data")
    entries = os.listdir(into)
    if not entries:
        raise RuntimeError("Archive is empty")
    return os.path.join(into, entries[0])


def _record_result(model, target_id: int, status: str):
    with Session(engine) as s:
        target = s.get(model, target_id)
        if target:
            target.last_run_at = datetime.utcnow()
            target.last_run_status = status
            if status in ("success", "warning"):
                target.last_success_at = target.last_run_at
            s.add(target)
            s.commit()


# ── Stack .env encryption ──────────────────────────────────────────────────────

def _legacy_fernet() -> Optional[Fernet]:
    """Key BaumLabBackup used, so imported stack archives can still be decrypted."""
    secret = decrypt(read_config().get("backups", {}).get("legacy_secret", ""))
    if not secret:
        return None
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b"baumlabbackup-salt", iterations=100_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(secret.encode())))


def _decrypt_env(ciphertext: str) -> str:
    try:
        return vault.decrypt(ciphertext)
    except Exception:
        legacy = _legacy_fernet()
        if legacy:
            try:
                return legacy.decrypt(ciphertext.encode()).decode()
            except InvalidToken:
                pass
    raise RuntimeError("Cannot decrypt the .env in this archive — it was encrypted with a different key")


# ── Container backup jobs ──────────────────────────────────────────────────────

def run_job_backup(job_id: int):
    if not _claim("job", job_id):
        print(f"Backup job {job_id} is already running — skipped")
        return
    run: Optional[_Run] = None
    tmp_dir = archive = None
    stopped: list[str] = []
    try:
        with Session(engine) as s:
            job = s.get(BackupJob, job_id)
            if not job:
                return
            dest = s.get(BackupDestination, job.destination_id)
            s.expunge_all()
        run = _Run("job", job.id, job.name, "backup")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        name = dk.safe_name(job.name)
        stamp = _stamp()
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"{name}_{stamp}")
        mount_dir = os.path.join(tmp_dir, "mounts")
        os.makedirs(mount_dir)
        run.log(f"Backing up {job.name} to {dest.name} ({dest.type})")

        # 1. Database dump while the database is still running
        if job.db_type:
            dump = os.path.join(tmp_dir, f"db_{dk.safe_name(job.db_name or 'database')}_{stamp}.sql")
            run.log(f"Dumping {job.db_type} database {job.db_name} from {job.db_container}…")
            try:
                dk.db_dump(job.db_container or "", job.db_type, job.db_name or "", job.db_user or "",
                           decrypt(job.db_password_enc or ""), dump)
                run.log(f"  Dump written: {os.path.getsize(dump):,} bytes")
            except Exception as e:
                run.log(f"Database dump failed: {e}", warning=True)

        # 2. Stop containers for a consistent copy
        containers = json.loads(job.containers or "[]")
        if job.pre_stop:
            for c in containers:
                if dk.stop_container(c):
                    stopped.append(c)
                    run.log(f"  Stopped {c}")
                else:
                    run.log(f"Could not stop {c}", warning=True)

        # 3. Archive mounts
        manifest_mounts = []
        used = set()
        for m in json.loads(job.volumes or "[]"):
            kind = m.get("type", "volume")
            source = m.get("source") or m.get("name")
            archive_name = f"{dk.safe_name(m.get('name') or source)}.tar.gz"
            while archive_name in used:
                archive_name = archive_name.replace(".tar.gz", "_.tar.gz")
            used.add(archive_name)
            try:
                size = dk.archive_mount(source, archive_name, mount_dir)
                manifest_mounts.append({"type": kind, "source": source, "archive": f"mounts/{archive_name}"})
                run.log(f"  Archived {kind} {source}: {size:,} bytes")
            except Exception as e:
                run.log(f"Failed to archive {kind} {source}: {e}", warning=True)

        # 4. Restart right away — no need to keep services down during the upload
        for c in stopped:
            if dk.start_container(c):
                run.log(f"  Restarted {c}")
            else:
                run.log(f"Could not restart {c}", warning=True)
        stopped = []

        with open(os.path.join(tmp_dir, "manifest.json"), "w") as fh:
            json.dump({"version": 2, "kind": "job", "job": job.name, "backed_up_at": datetime.utcnow().isoformat(),
                       "containers": containers, "mounts": manifest_mounts,
                       "db": {"type": job.db_type, "container": job.db_container, "name": job.db_name}
                       if job.db_type else None}, fh, indent=2)

        # 5. Package and upload
        archive = os.path.join(dk.BACKUP_TMP_DIR, f"{name}_{stamp}.tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(tmp_dir, arcname=os.path.basename(tmp_dir))
        size = os.path.getsize(archive)
        run.log(f"Uploading {size:,} bytes…")
        ok, msg = st.upload(dest, archive)
        if not ok:
            raise RuntimeError(f"Upload failed: {msg}")

        if job.retention_days > 0:
            err = st.apply_retention(dest, "", job.retention_days, [name, job.name])
            run.log(f"Retention ({job.retention_days} days): " + ("applied" if not err else f"failed — {err}"),
                    warning=bool(err))

        status = run.finish(size=size, archive=f"{st.remote_name(dest)}:{st.base_path(dest)}/{os.path.basename(archive)}")
        _record_result(BackupJob, job_id, status)
    except Exception as e:
        if run:
            _record_result(BackupJob, job_id, run.finish(error=str(e)))
        print(f"Backup job {job_id} failed: {e}")
    finally:
        for c in stopped:     # only non-empty if we failed between stop and restart
            dk.start_container(c)
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if archive and os.path.exists(archive):
            os.remove(archive)
        _release("job", job_id)


def run_job_restore(job_id: int, filename: str, restore_mounts: bool, restore_db: bool, start_after: list[str]):
    if not _claim("job", job_id):
        return
    run: Optional[_Run] = None
    tmp_dir = None
    try:
        with Session(engine) as s:
            job = s.get(BackupJob, job_id)
            dest = s.get(BackupDestination, job.destination_id) if job else None
            s.expunge_all()
        if not job:
            return
        run = _Run("job", job.id, job.name, "restore")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"restore_{dk.safe_name(job.name)}_{_stamp()}")
        os.makedirs(tmp_dir)
        local = os.path.join(tmp_dir, os.path.basename(filename))
        run.log(f"Downloading {filename} from {dest.name}…")
        ok, msg = st.download(dest, filename, local)
        if not ok:
            raise RuntimeError(f"Download failed: {msg}")
        inner = _extract(local, os.path.join(tmp_dir, "x"))
        manifest_path = os.path.join(inner, "manifest.json")
        manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else None

        containers = json.loads(job.containers or "[]")
        for c in containers:
            if dk.stop_container(c):
                run.log(f"  Stopped {c}")

        if restore_mounts:
            if manifest:
                entries = [(m["source"], m["type"], os.path.join(inner, m["archive"])) for m in manifest.get("mounts", [])]
            else:   # BaumLabBackup archive: volumes/<volume name>.tar.gz
                vol_dir = os.path.join(inner, "volumes")
                entries = [(f[:-7], "volume", os.path.join(vol_dir, f))
                           for f in (os.listdir(vol_dir) if os.path.isdir(vol_dir) else []) if f.endswith(".tar.gz")]
            for source, kind, path in entries:
                try:
                    dk.restore_mount(source, kind, path)
                    run.log(f"  Restored {kind} {source}")
                except Exception as e:
                    run.log(f"Failed to restore {kind} {source}: {e}", warning=True)

        if restore_db and job.db_type:
            dumps = [f for f in os.listdir(inner) if f.endswith(".sql")]
            if not dumps:
                run.log("No database dump in this archive", warning=True)
            else:
                # The database container must be running to accept the dump
                if job.db_container:
                    dk.start_container(job.db_container)
                try:
                    dk.db_restore(job.db_container or "", job.db_type, job.db_name or "", job.db_user or "",
                                  decrypt(job.db_password_enc or ""), os.path.join(inner, dumps[0]))
                    run.log(f"  Restored database {job.db_name} from {dumps[0]}")
                except Exception as e:
                    run.log(f"Database restore failed: {e}", warning=True)

        for c in start_after:
            run.log(f"  Started {c}" if dk.start_container(c) else f"Could not start {c}")
        run.finish()
    except Exception as e:
        if run:
            run.finish(error=str(e))
        print(f"Restore of job {job_id} failed: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        _release("job", job_id)


# ── Compose stack backups ──────────────────────────────────────────────────────

def stack_dir(stack: BackupStack) -> str:
    return f"stacks/{dk.safe_name(stack.name)}"


def run_stack_backup(stack_id: int):
    if not _claim("stack", stack_id):
        return
    run: Optional[_Run] = None
    tmp_dir = archive = None
    try:
        with Session(engine) as s:
            stack = s.get(BackupStack, stack_id)
            dest = s.get(BackupDestination, stack.destination_id) if stack else None
            s.expunge_all()
        if not stack:
            return
        run = _Run("stack", stack.id, stack.name, "backup")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        name = dk.safe_name(stack.name)
        stamp = _stamp()
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"stack_{name}_{stamp}")
        vol_dir = os.path.join(tmp_dir, "volumes")
        os.makedirs(vol_dir)
        os.makedirs(os.path.join(tmp_dir, "env"))

        volumes = json.loads(stack.volumes or "[]")
        run.log(f"Backing up stack {stack.name}: {len(volumes)} volume(s)")
        for v in volumes:
            try:
                size = dk.archive_mount(v, f"{v}.tar.gz", vol_dir)
                run.log(f"  Archived {v}: {size:,} bytes")
            except Exception as e:
                run.log(f"Failed to archive {v}: {e}", warning=True)

        env_text = None
        if stack.env_path and os.path.isfile(stack.env_path):
            env_text = open(stack.env_path, encoding="utf-8").read()
            run.log(f"  Read .env from {stack.env_path}")
        else:
            env_text = dk.project_env(stack.compose_project)
            run.log(f"  Captured {len(env_text.splitlines())} env var(s) from running containers" if env_text
                    else "No .env file and no running containers — environment not saved", warning=not env_text)
        if env_text:
            with open(os.path.join(tmp_dir, "env", "dot-env.enc"), "w") as fh:
                fh.write(vault.encrypt(env_text))

        with open(os.path.join(tmp_dir, "manifest.json"), "w") as fh:
            json.dump({"version": 2, "kind": "stack", "stack_name": stack.name, "compose_project": stack.compose_project,
                       "repo_url": stack.repo_url, "repo_branch": stack.repo_branch,
                       "backed_up_at": datetime.utcnow().isoformat(),
                       "volumes": [{"name": v, "archive": f"volumes/{v}.tar.gz"} for v in volumes],
                       "env_file": "env/dot-env.enc" if env_text else None}, fh, indent=2)

        archive = os.path.join(dk.BACKUP_TMP_DIR, f"stack_{name}_{stamp}.tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(tmp_dir, arcname=os.path.basename(tmp_dir))
        size = os.path.getsize(archive)
        run.log(f"Uploading {size:,} bytes…")
        ok, msg = st.upload(dest, archive, stack_dir(stack))
        if not ok:
            raise RuntimeError(f"Upload failed: {msg}")
        if stack.retention_days > 0:
            err = st.apply_retention(dest, stack_dir(stack), stack.retention_days, [f"stack_{name}"])
            if err:
                run.log(f"Retention failed — {err}", warning=True)
        status = run.finish(size=size, archive=f"{st.remote_name(dest)}:{stack_dir(stack)}/{os.path.basename(archive)}")
        _record_result(BackupStack, stack_id, status)
    except Exception as e:
        if run:
            _record_result(BackupStack, stack_id, run.finish(error=str(e)))
        print(f"Stack backup {stack_id} failed: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        if archive and os.path.exists(archive):
            os.remove(archive)
        _release("stack", stack_id)


def _fetch_stack_archive(stack: BackupStack, dest: BackupDestination, filename: str, tmp_dir: str) -> tuple[str, dict]:
    local = os.path.join(tmp_dir, filename)
    ok, msg = st.download(dest, f"{stack_dir(stack)}/{filename}", local)
    if not ok:
        raise RuntimeError(f"Download failed: {msg}")
    inner = _extract(local, os.path.join(tmp_dir, "x"))
    manifest_path = os.path.join(inner, "manifest.json")
    if not os.path.exists(manifest_path):
        raise RuntimeError("manifest.json missing — not a stack archive")
    return inner, json.load(open(manifest_path))


def run_stack_restore(stack_id: int, filename: str):
    """Restore a stack's volumes. Redeploy happens in Portainer with the archive's .env."""
    if not _claim("stack", stack_id):
        return
    run: Optional[_Run] = None
    tmp_dir = None
    try:
        with Session(engine) as s:
            stack = s.get(BackupStack, stack_id)
            dest = s.get(BackupDestination, stack.destination_id) if stack else None
            s.expunge_all()
        if not stack:
            return
        run = _Run("stack", stack.id, stack.name, "restore")
        if not dest:
            raise RuntimeError("Destination no longer exists")
        tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"restore_stack_{dk.safe_name(stack.name)}_{_stamp()}")
        os.makedirs(tmp_dir)
        run.log(f"Downloading {filename}…")
        inner, manifest = _fetch_stack_archive(stack, dest, filename, tmp_dir)
        run.log(f"Archive from {manifest.get('backed_up_at')} — repo {manifest.get('repo_url')} @ {manifest.get('repo_branch')}")

        # Stop the stack's containers (if it still exists) so volumes aren't replaced underneath them
        running = [c["name"] for c in dk.list_containers()
                   if c["project"] == stack.compose_project and c["status"] == "running"]
        for c in running:
            dk.stop_container(c)
            run.log(f"  Stopped {c}")
        for v in manifest.get("volumes", []):
            try:
                dk.restore_mount(v["name"], "volume", os.path.join(inner, v["archive"]))
                run.log(f"  Restored volume {v['name']}")
            except Exception as e:
                run.log(f"Failed to restore {v['name']}: {e}", warning=True)
        for c in running:
            dk.start_container(c)
            run.log(f"  Started {c}")
        if not running:
            run.log("Stack isn't deployed — redeploy it in Portainer using the .env from this archive")
        run.finish()
    except Exception as e:
        if run:
            run.finish(error=str(e))
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        _release("stack", stack_id)


def read_stack_env(stack: BackupStack, dest: BackupDestination, filename: str) -> dict:
    """Decrypted .env + repo info from a stack archive (for redeploying in Portainer)."""
    tmp_dir = os.path.join(dk.BACKUP_TMP_DIR, f"env_{dk.safe_name(stack.name)}_{_stamp()}")
    os.makedirs(tmp_dir)
    try:
        inner, manifest = _fetch_stack_archive(stack, dest, filename, tmp_dir)
        env_rel = manifest.get("env_file")
        env_path = os.path.join(inner, env_rel) if env_rel else None
        env_text = _decrypt_env(open(env_path).read()) if env_path and os.path.exists(env_path) else None
        return {"env": env_text, "repo_url": manifest.get("repo_url"), "repo_branch": manifest.get("repo_branch"),
                "compose_project": manifest.get("compose_project"), "backed_up_at": manifest.get("backed_up_at")}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

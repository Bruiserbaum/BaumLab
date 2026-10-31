"""
Collect Docker container logs (BaumLab's own stack by default) into the Syslog view.

One follower thread per container streams its logs through the Docker socket into a
queue; a single writer thread saves them in batches. A supervisor re-checks every
minute, so containers that restart, appear, or are added in settings are picked up,
and followers stop when collection is turned off. After a restart each follower resumes
from the last saved line; a container seen for the first time contributes its recent history.
"""
import queue
import re
import socket
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import docker
from docker.errors import DockerException
from sqlmodel import Session, func, select

from ..database import engine
from ..models.syslog import SyslogMessage
from .config_service import read_config

SUPERVISE_SECONDS = 60
FLUSH_SECONDS = 1.0
MAX_BATCH = 500
FIRST_TAIL = 200                 # lines of history taken the first time a container is followed
BACKFILL_MAX = 6 * 3600          # never catch up further back than this after downtime

_queue: "queue.Queue[SyslogMessage]" = queue.Queue(maxsize=20_000)
_followers: dict[str, dict] = {}          # container id → {name, thread, stream, started}
_lock = threading.Lock()
_status = {"running": False, "error": None, "dropped": 0}

_SEVERITY = [
    (3, re.compile(r"\b(error|err|critical|crit|fatal|panic|traceback|exception)\b", re.I)),
    (4, re.compile(r"\b(warn|warning)\b", re.I)),
    (7, re.compile(r"\bdebug\b", re.I)),
]
# Successful HTTP access lines (uvicorn, nginx) — dropped unless keep_access_logs
_ACCESS_OK = re.compile(r'"[A-Z]+ \S+ HTTP/[\d.]+" [23]\d\d\b')
_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z?\s")


def settings() -> dict:
    cfg = read_config().get("logs", {})
    return {
        "collect": bool(cfg.get("collect", True)),
        "containers": list(cfg.get("containers", [])),      # empty = BaumLab's own compose project
        "keep_access_logs": bool(cfg.get("keep_access_logs", False)),
    }


def status() -> dict:
    with _lock:
        followed = sorted(f["name"] for f in _followers.values())
    return {**_status, "following": followed, "queued": _queue.qsize()}


def _severity(text: str) -> int:
    for sev, pattern in _SEVERITY:
        if pattern.search(text):
            return sev
    return 6


def _own_project(client) -> Optional[str]:
    try:
        return client.containers.get(socket.gethostname()).labels.get("com.docker.compose.project")
    except DockerException:
        return None


def _targets(client) -> list:
    cfg = settings()
    running = client.containers.list()
    if cfg["containers"]:
        wanted = set(cfg["containers"])
        return [c for c in running if c.name in wanted]
    project = _own_project(client)
    return [c for c in running if project and c.labels.get("com.docker.compose.project") == project]


def _resume_point(name: str) -> Optional[datetime]:
    """Timestamp of the last line already saved for this container, so a restart picks up where it left off."""
    try:
        with Session(engine) as s:
            return s.exec(select(func.max(SyslogMessage.timestamp))
                          .where(SyslogMessage.source == "container", SyslogMessage.host == name)).one()
    except Exception:
        return None


def _note(name: str, text: str):
    """A line from the collector itself, so Syslog shows what it's doing even when containers are quiet."""
    try:
        _queue.put_nowait(SyslogMessage(source="container", source_ip="docker", host=name, tag="baumlab-logs",
                                        facility=1, severity=6, message=text, raw=text))
    except queue.Full:
        _status["dropped"] += 1


def _parse_line(line: str, name: str, keep_access: bool) -> Optional[SyslogMessage]:
    ts, text = None, line
    m = _TS.match(line)
    if m:
        text = line[m.end():]
        try:
            ts = datetime.fromisoformat(m.group(1) + (f".{m.group(2)[:6]}" if m.group(2) else ""))
        except ValueError:
            ts = None
    if not text.strip() or (not keep_access and _ACCESS_OK.search(text)):
        return None
    return SyslogMessage(source="container", source_ip="docker", host=name, tag=name, facility=1,
                         severity=_severity(text), message=text[:4096], raw=line[:4096], timestamp=ts)


def _follow(container_id: str, name: str):
    """Stream one container's logs into the queue until the container stops or we're told to."""
    keep_access = settings()["keep_access_logs"]
    last = _resume_point(name)
    try:
        if last:
            # Catch up on what was logged while BaumLab was down (at most BACKFILL_MAX back)
            since = max(last.replace(tzinfo=timezone.utc).timestamp(), time.time() - BACKFILL_MAX)
            opts = {"since": since}
        else:
            opts = {"tail": FIRST_TAIL}      # first time we see this container: recent history only
        stream = docker.from_env(timeout=None).containers.get(container_id).logs(
            stream=True, follow=True, timestamps=True, **opts)
        with _lock:
            if container_id in _followers:
                _followers[container_id]["stream"] = stream
        _note(name, f"Collecting logs from {name}" + (" (catching up since the last saved line)" if last else ""))
        buf = ""
        for chunk in stream:
            # A chunk is one write from the container — it can hold several lines, or part of one
            buf += chunk.decode("utf-8", errors="replace")
            *lines, buf = buf.split("\n")
            for line in lines:
                msg = _parse_line(line.rstrip("\r"), name, keep_access)
                if msg is None or (last and msg.timestamp and msg.timestamp <= last):
                    continue
                try:
                    _queue.put_nowait(msg)
                except queue.Full:
                    _status["dropped"] += 1
    except Exception as e:
        print(f"Log collector: stopped following {name}: {e}")
    finally:
        with _lock:
            _followers.pop(container_id, None)


def _writer():
    """Save queued lines in batches (one transaction per batch)."""
    while True:
        batch = [_queue.get()]
        deadline = time.monotonic() + FLUSH_SECONDS
        while len(batch) < MAX_BATCH:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                batch.append(_queue.get(timeout=remaining))
            except queue.Empty:
                break
        try:
            with Session(engine) as s:
                s.add_all(batch)
                s.commit()
        except Exception as e:
            print(f"Log collector: failed to save {len(batch)} lines: {e}")


def _stop_all():
    with _lock:
        followers = list(_followers.values())
    for f in followers:
        try:
            if f.get("stream"):
                f["stream"].close()      # unblocks the follower thread
        except Exception:
            pass


def _supervise():
    while True:
        try:
            if not settings()["collect"]:
                _stop_all()
                _status.update(running=False, error=None)
            else:
                client = docker.from_env(timeout=20)
                targets = _targets(client)
                wanted = {c.id for c in targets}
                with _lock:
                    stale = [f for cid, f in _followers.items() if cid not in wanted]
                for f in stale:                  # removed from settings
                    if f.get("stream"):
                        f["stream"].close()
                for c in targets:
                    with _lock:
                        if c.id in _followers:
                            continue
                        t = threading.Thread(target=_follow, args=(c.id, c.name), daemon=True, name=f"logs-{c.name}")
                        _followers[c.id] = {"name": c.name, "thread": t, "stream": None, "started": time.time()}
                    t.start()
                _status.update(running=True, error=None if targets else "No containers matched — check Settings")
        except DockerException as e:
            _status.update(running=False, error=f"Docker socket not available: {e}")
        except Exception as e:
            _status.update(error=str(e))
        time.sleep(SUPERVISE_SECONDS)


def start():
    """Start the writer and supervisor threads (once, at app startup)."""
    threading.Thread(target=_writer, daemon=True, name="logs-writer").start()
    threading.Thread(target=_supervise, daemon=True, name="logs-supervisor").start()


def audit(user: str, method: str, path: str, status_code: int):
    """Record a change someone made in BaumLab (any non-GET API call) as an 'audit' syslog line."""
    severity = 3 if status_code >= 500 else 4 if status_code >= 400 else 5
    text = f"{user}: {method} {path} → {status_code}"
    try:
        _queue.put_nowait(SyslogMessage(source="audit", source_ip="baumlab", host="baumlab", tag=user,
                                        facility=1, severity=severity, message=text, raw=text))
    except queue.Full:
        _status["dropped"] += 1

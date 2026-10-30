"""
Collect Docker container logs (BaumLab's own stack by default) into the Syslog view.

One follower thread per container streams its logs through the Docker socket into a
queue; a single writer thread saves them in batches. A supervisor re-checks every
minute, so containers that restart, appear, or are added in settings are picked up,
and followers stop when collection is turned off. Only new lines are collected —
history from before a follower started is not back-filled.
"""
import queue
import re
import socket
import threading
import time
from datetime import datetime
from typing import Optional

import docker
from docker.errors import DockerException
from sqlmodel import Session

from ..database import engine
from ..models.syslog import SyslogMessage
from .config_service import read_config

SUPERVISE_SECONDS = 60
FLUSH_SECONDS = 1.0
MAX_BATCH = 500

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


def _follow(container_id: str, name: str):
    """Stream one container's logs into the queue until the container stops or we're told to."""
    keep_access = settings()["keep_access_logs"]
    try:
        stream = docker.from_env(timeout=None).containers.get(container_id).logs(
            stream=True, follow=True, timestamps=True, since=int(time.time()))
        with _lock:
            if container_id in _followers:
                _followers[container_id]["stream"] = stream
        for raw in stream:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if not line:
                continue
            ts, text = None, line
            m = _TS.match(line)
            if m:
                text = line[m.end():]
                try:
                    ts = datetime.fromisoformat(m.group(1) + (f".{m.group(2)[:6]}" if m.group(2) else ""))
                except ValueError:
                    ts = None
            if not keep_access and _ACCESS_OK.search(text):
                continue
            msg = SyslogMessage(source="container", source_ip="docker", host=name, tag=name, facility=1,
                                severity=_severity(text), message=text[:4096], raw=line[:4096], timestamp=ts)
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

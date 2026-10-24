"""
One-way sync of the service inventory to a Forgejo / Gitea repository.

BaumLab renders the inventory to YAML + Markdown and commits only the files whose
content changed, in a single commit via the /contents API — no git binary or SSH
key needed inside the container. Edits made close together are batched.
"""
import asyncio
import base64
import hashlib
import re
from datetime import datetime, timedelta

import httpx
import yaml
from sqlmodel import Session, select

from ..database import engine
from ..models.service import Service
from .config_service import read_config, decrypt

SYNC_DELAY_SECONDS = 30   # batch edits made within this window into one commit
HOSTS_DIR = "hosts"       # BaumLab owns this folder — stale host pages are deleted

_scheduler = None
_lock = asyncio.Lock()
_pending: list[str] = []  # change descriptions waiting for the next commit
_state = {
    "last_sync_at": None,
    "last_commit_sha": None,
    "last_commit_url": None,
    "last_error": None,
}


class GitSyncError(Exception):
    pass


def init(scheduler):
    """Called from app startup so queued changes can schedule a delayed sync."""
    global _scheduler
    _scheduler = scheduler


# ── Config ─────────────────────────────────────────────────────────────────────

def get_config() -> dict:
    gc = read_config().get("git_sync", {})
    cfg = {
        "repo_url":  gc.get("repo_url", ""),
        "branch":    gc.get("branch", ""),
        "path":      (gc.get("path") or "").strip("/"),
        "token":     decrypt(gc.get("token", "")),
        "auto_sync": gc.get("auto_sync", True),
        "api_base":  None,
    }
    # https://git.example.com/owner/repo(.git) → API base + owner/repo
    m = re.match(r"^(https?://.+?)/([^/]+)/([^/]+?)(?:\.git)?/?$", cfg["repo_url"].strip())
    if m:
        cfg["api_base"] = f"{m.group(1)}/api/v1/repos/{m.group(2)}/{m.group(3)}"
    return cfg


def is_configured(cfg: dict) -> bool:
    return bool(cfg["api_base"] and cfg["token"])


def status() -> dict:
    cfg = get_config()
    return {
        "configured": is_configured(cfg),
        "auto_sync":  cfg["auto_sync"],
        "repo_url":   cfg["repo_url"],
        "pending":    len(_pending),
        **_state,
    }


def queue_change(message: str):
    """Record a change for the next commit and (re)schedule an auto-sync."""
    _pending.append(message)
    cfg = get_config()
    if _scheduler and cfg["auto_sync"] and is_configured(cfg):
        _scheduler.add_job(
            _scheduled_sync, "date",
            run_date=datetime.now() + timedelta(seconds=SYNC_DELAY_SECONDS),
            id="git_sync", replace_existing=True,
        )


# ── Rendering ──────────────────────────────────────────────────────────────────

def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "host"


def _cell(v) -> str:
    return "" if v is None else str(v).replace("|", "\\|").replace("\n", " ")


def _addr(s: Service) -> str:
    if not s.ip and not s.port:
        return ""
    return f"`{s.ip or ''}{f':{s.port}' if s.port else ''}` {s.protocol}"


def _access(s: Service) -> str:
    parts = []
    if s.proxied:
        parts.append("Proxy")
    if s.sso:
        parts.append("SSO")
    if s.external:
        parts.append("Public" if s.sso else "Public ⚠️ no SSO")
    return ", ".join(parts) or "Direct"


def _service_dict(s: Service) -> dict:
    d = {
        "name": s.name,
        "status": s.status,
        "decommissioned": s.decommissioned_at.date().isoformat() if s.decommissioned_at else None,
        "category": s.category,
        "host": s.host,
        "platform": s.platform,
        "ip": s.ip,
        "port": s.port,
        "protocol": s.protocol,
        "vlan": s.vlan,
        "url": s.url,
        "proxied": s.proxied,
        "sso": s.sso,
        "external": s.external,
        "credentials": s.credential_ref,
        "notes": s.notes,
    }
    return {k: v for k, v in d.items() if v not in (None, "")}


def _table(services: list[Service], with_host: bool = True) -> list[str]:
    head = ["Service", "Category"] + (["Host"] if with_host else []) + ["Address", "VLAN", "Access", "URL"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for s in services:
        name = f"**{_cell(s.name)}**" + (" _(planned)_" if s.status == "planned" else "")
        row = [name, _cell(s.category)]
        if with_host:
            row.append(_cell(s.host))
        row += [_addr(s), _cell(s.vlan), _access(s), _cell(s.url)]
        lines.append("| " + " | ".join(row) + " |")
    return lines


def render_files(services: list[Service]) -> dict[str, str]:
    """Return {repo path (without prefix): file content}. Output is deterministic so
    unchanged inventories produce no commit."""
    services = sorted(services, key=lambda s: s.name.lower())
    live = [s for s in services if s.status != "decommissioned"]
    retired = [s for s in services if s.status == "decommissioned"]
    by_host: dict[str, list[Service]] = {}
    for s in services:
        by_host.setdefault(s.host or "Unassigned", []).append(s)

    files = {}
    files["services.yaml"] = (
        "# Generated by BaumLab — edit services in BaumLab, not here.\n"
        + yaml.safe_dump({"services": [_service_dict(s) for s in services]},
                         sort_keys=False, allow_unicode=True, default_flow_style=False)
    )

    md = [
        "# Infrastructure Map",
        "",
        "> Generated by BaumLab from its service inventory. Edit services in BaumLab, not here —",
        "> manual changes to this repo are overwritten on the next sync.",
        "",
        "## Summary",
        "",
        "| | Count |",
        "|---|---|",
        f"| Active services | {sum(1 for s in live if s.status == 'active')} |",
        f"| Planned | {sum(1 for s in live if s.status == 'planned')} |",
        f"| Decommissioned | {len(retired)} |",
        f"| Behind reverse proxy | {sum(1 for s in live if s.proxied)} |",
        f"| Behind SSO | {sum(1 for s in live if s.sso)} |",
        f"| Internet-facing | {sum(1 for s in live if s.external)} |",
        f"| Internet-facing without SSO | {sum(1 for s in live if s.external and not s.sso)} |",
        "",
        "## Hosts",
        "",
        "| Host | Platform | Services |",
        "|---|---|---|",
    ]
    for host in sorted(by_host, key=str.lower):
        host_live = [s for s in by_host[host] if s.status != "decommissioned"]
        platforms = ", ".join(sorted({s.platform for s in host_live if s.platform}))
        md.append(f"| [{_cell(host)}]({HOSTS_DIR}/{_slug(host)}.md) | {platforms} | {len(host_live)} |")
    md += ["", "## Services", ""]
    md += _table(sorted(live, key=lambda s: ((s.host or "~").lower(), s.name.lower()))) if live else ["_None._"]
    md += ["", "## Decommissioned", ""]
    if retired:
        md += ["| Service | Host | Address | VLAN | Decommissioned |", "|---|---|---|---|---|"]
        for s in retired:
            when = s.decommissioned_at.date().isoformat() if s.decommissioned_at else ""
            md.append(f"| {_cell(s.name)} | {_cell(s.host)} | {_addr(s)} | {_cell(s.vlan)} | {when} |")
    else:
        md.append("_None._")
    files["README.md"] = "\n".join(md) + "\n"

    for host, items in by_host.items():
        host_live = [s for s in items if s.status != "decommissioned"]
        host_retired = [s for s in items if s.status == "decommissioned"]
        page = [f"# {host}", "", "[← Infrastructure Map](../README.md)", "", "## Services", ""]
        page += _table(host_live, with_host=False) if host_live else ["_None._"]
        notes = [s for s in host_live if s.notes or s.credential_ref]
        if notes:
            page += ["", "## Notes", ""]
            for s in notes:
                bits = [b for b in (s.notes, f"credentials: {s.credential_ref}" if s.credential_ref else None) if b]
                page.append(f"- **{s.name}** — " + " · ".join(bits).replace("\n", " "))
        if host_retired:
            page += ["", "## Decommissioned", ""]
            for s in host_retired:
                when = s.decommissioned_at.date().isoformat() if s.decommissioned_at else "unknown date"
                page.append(f"- {s.name} ({when})")
        files[f"{HOSTS_DIR}/{_slug(host)}.md"] = "\n".join(page) + "\n"

    return files


# ── Forgejo API ────────────────────────────────────────────────────────────────

def _blob_sha(data: bytes) -> str:
    """Git blob SHA-1 — lets us skip unchanged files without downloading them."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _check(r: httpx.Response):
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.text
        except Exception:
            msg = r.text
        raise GitSyncError(f"Forgejo returned HTTP {r.status_code}: {msg[:300]}")


def _client(cfg: dict) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=20,
        headers={"Authorization": f"token {cfg['token']}", "Accept": "application/json"},
    )


async def _list_files(c: httpx.AsyncClient, base: str, folder: str, branch: str) -> dict[str, str]:
    """{path: blob sha} for files directly inside folder ('' = repo root)."""
    r = await c.get(f"{base}/contents/{folder}".rstrip("/"), params={"ref": branch})
    if r.status_code == 404:
        return {}
    _check(r)
    entries = r.json()
    if not isinstance(entries, list):
        return {}
    return {e["path"]: e["sha"] for e in entries if e.get("type") == "file"}


async def test_connection() -> dict:
    cfg = get_config()
    if not is_configured(cfg):
        raise GitSyncError("Repository URL and access token are required")
    async with _client(cfg) as c:
        r = await c.get(cfg["api_base"])
        _check(r)
        repo = r.json()
    if not repo.get("permissions", {}).get("push"):
        raise GitSyncError(f"Token can read {repo.get('full_name')} but cannot push to it")
    return {
        "repo": repo.get("full_name"),
        "branch": cfg["branch"] or repo.get("default_branch"),
        "empty": repo.get("empty", False),
    }


def _commit_message(pending: list[str]) -> str:
    if not pending:
        return "Sync service inventory from BaumLab"
    if len(pending) == 1:
        return pending[0]
    return f"Update service inventory ({len(pending)} changes)\n\n" + "\n".join(f"- {m}" for m in pending)


async def sync() -> dict:
    """Render the inventory and commit whatever changed. Raises GitSyncError on failure."""
    async with _lock:
        cfg = get_config()
        if not is_configured(cfg):
            raise GitSyncError("Git sync is not configured (Settings → Git Sync)")
        with Session(engine) as session:
            services = session.exec(select(Service)).all()
        prefix = cfg["path"]
        files = {f"{prefix}/{p}" if prefix else p: content for p, content in render_files(services).items()}
        hosts_dir = f"{prefix}/{HOSTS_DIR}" if prefix else HOSTS_DIR
        pending = list(_pending)

        try:
            async with _client(cfg) as c:
                base = cfg["api_base"]
                r = await c.get(base)
                _check(r)
                repo = r.json()
                branch = cfg["branch"] or repo.get("default_branch") or "main"

                existing = {}
                if not repo.get("empty"):
                    existing.update(await _list_files(c, base, prefix, branch))
                    existing.update(await _list_files(c, base, hosts_dir, branch))

                ops = []
                for path, content in files.items():
                    data = content.encode()
                    sha = existing.get(path)
                    if sha == _blob_sha(data):
                        continue
                    op = {"operation": "update" if sha else "create", "path": path,
                          "content": base64.b64encode(data).decode()}
                    if sha:
                        op["sha"] = sha
                    ops.append(op)
                for path, sha in existing.items():
                    if path.startswith(hosts_dir + "/") and path.endswith(".md") and path not in files:
                        ops.append({"operation": "delete", "path": path, "sha": sha})

                result = {"changed": False, "files": 0}
                if ops:
                    r = await c.post(f"{base}/contents", json={
                        "branch": branch, "message": _commit_message(pending), "files": ops,
                    })
                    _check(r)
                    commit = r.json().get("commit") or {}
                    result = {"changed": True, "files": len(ops),
                              "sha": commit.get("sha"), "url": commit.get("html_url")}
                    _state["last_commit_sha"] = commit.get("sha")
                    _state["last_commit_url"] = commit.get("html_url")
        except httpx.HTTPError as e:
            _state["last_error"] = f"Could not reach Forgejo: {e}"
            raise GitSyncError(_state["last_error"]) from e
        except GitSyncError as e:
            _state["last_error"] = str(e)
            raise

        del _pending[:len(pending)]
        _state["last_sync_at"] = datetime.utcnow().isoformat()
        _state["last_error"] = None
        return result


async def _scheduled_sync():
    try:
        result = await sync()
        if result["changed"]:
            print(f"Git sync: committed {result['files']} file(s) — {result.get('sha', '')[:8]}")
    except GitSyncError as e:
        print(f"Git sync failed: {e}")

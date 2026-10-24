"""
Read-only overview of repositories across Git hosts (GitHub, GitHub Enterprise,
Gitea / Forgejo). Each configured source is listed with its token, and the latest
release of every repo is looked up. Results are snapshotted in the database.
"""
import asyncio
from datetime import datetime
from typing import Optional

import httpx
from sqlmodel import Session, delete

from ..database import engine
from ..models.repo import RepoSnapshot
from .config_service import read_config, decrypt

SOURCE_TYPES = ("github", "github-enterprise", "gitea")   # gitea covers Forgejo
MAX_PAGES = 20
RELEASE_CONCURRENCY = 8

_errors: dict[str, Optional[str]] = {}   # source name → last error (None = ok)
_refreshing = False


def get_sources() -> list[dict]:
    sources = []
    for s in read_config().get("repo_sources", []):
        sources.append({
            "name": s.get("name", ""),
            "type": s.get("type", "github"),
            "url": (s.get("url") or "").rstrip("/"),
            "owner": (s.get("owner") or "").strip(),
            "token": decrypt(s.get("token", "")),
        })
    return sources


def errors() -> dict:
    return dict(_errors)


def is_refreshing() -> bool:
    return _refreshing


# ── Host adapters ──────────────────────────────────────────────────────────────

def _api_base(src: dict) -> str:
    if src["type"] == "github":
        return "https://api.github.com"
    if src["type"] == "github-enterprise":
        return f"{src['url']}/api/v3"
    return f"{src['url']}/api/v1"


def _headers(src: dict) -> dict:
    h = {"User-Agent": "BaumLab", "Accept": "application/json"}
    if src["type"] in ("github", "github-enterprise"):
        h["Accept"] = "application/vnd.github+json"
        if src["token"]:
            h["Authorization"] = f"Bearer {src['token']}"
    elif src["token"]:
        h["Authorization"] = f"token {src['token']}"
    return h


def _check(r: httpx.Response, what: str):
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.text
        except Exception:
            msg = r.text
        raise RuntimeError(f"{what}: HTTP {r.status_code} {str(msg)[:200]}")


async def _list_repos(c: httpx.AsyncClient, src: dict) -> list[dict]:
    base = _api_base(src)
    is_github = src["type"] != "gitea"
    per_page = 100 if is_github else 50
    if src["token"]:
        url = f"{base}/user/repos"            # everything the token can see, private included
    elif src["owner"]:
        url = f"{base}/users/{src['owner']}/repos"
    else:
        raise RuntimeError("needs a token or an owner to list repositories")

    repos = []
    for page in range(1, MAX_PAGES + 1):
        params = {"per_page": per_page, "page": page} if is_github else {"limit": per_page, "page": page}
        r = await c.get(url, params=params)
        _check(r, "listing repositories")
        batch = r.json()
        repos.extend(batch)
        if len(batch) < per_page:
            break

    if src["owner"] and src["token"]:
        repos = [x for x in repos if (x.get("owner") or {}).get("login", "").lower() == src["owner"].lower()]
    return repos


async def _latest_release(c: httpx.AsyncClient, src: dict, full_name: str, sem: asyncio.Semaphore) -> Optional[dict]:
    async with sem:
        try:
            r = await c.get(f"{_api_base(src)}/repos/{full_name}/releases/latest")
        except httpx.HTTPError:
            return None
    if r.status_code != 200:
        return None     # 404 = no releases
    rel = r.json()
    return {
        "tag": rel.get("tag_name"),
        "name": rel.get("name") or rel.get("tag_name"),
        "published_at": rel.get("published_at") or rel.get("created_at"),
        "url": rel.get("html_url"),
    }


def _snapshot(src: dict, repo: dict, release: Optional[dict], now: datetime) -> RepoSnapshot:
    owner = (repo.get("owner") or {}).get("login", "")
    return RepoSnapshot(
        source=src["name"],
        full_name=repo.get("full_name") or f"{owner}/{repo.get('name')}",
        owner=owner,
        name=repo.get("name", ""),
        description=repo.get("description") or None,
        html_url=repo.get("html_url", ""),
        private=bool(repo.get("private")),
        fork=bool(repo.get("fork")),
        archived=bool(repo.get("archived")),
        language=repo.get("language") or None,
        stars=repo.get("stargazers_count", repo.get("stars_count", 0)) or 0,
        default_branch=repo.get("default_branch"),
        last_activity=repo.get("pushed_at") or repo.get("updated_at"),
        release_tag=release["tag"] if release else None,
        release_name=release["name"] if release else None,
        release_published_at=release["published_at"] if release else None,
        release_url=release["url"] if release else None,
        checked_at=now,
    )


async def refresh_source(src: dict):
    try:
        async with httpx.AsyncClient(timeout=20, headers=_headers(src)) as c:
            repos = await _list_repos(c, src)
            sem = asyncio.Semaphore(RELEASE_CONCURRENCY)
            releases = await asyncio.gather(*[
                _latest_release(c, src, r.get("full_name", ""), sem) for r in repos
            ])
    except (httpx.HTTPError, RuntimeError) as e:
        _errors[src["name"]] = str(e)
        print(f"Repo source '{src['name']}' failed: {e}")
        return

    now = datetime.utcnow()
    with Session(engine) as session:
        session.exec(delete(RepoSnapshot).where(RepoSnapshot.source == src["name"]))
        for repo, release in zip(repos, releases):
            session.add(_snapshot(src, repo, release, now))
        session.commit()
    _errors[src["name"]] = None


async def refresh_all():
    global _refreshing
    if _refreshing:
        return
    _refreshing = True
    try:
        sources = get_sources()
        names = {s["name"] for s in sources}
        await asyncio.gather(*[refresh_source(s) for s in sources])
        # Drop snapshots for sources that were removed from settings
        with Session(engine) as session:
            stale = delete(RepoSnapshot).where(RepoSnapshot.source.not_in(names)) if names else delete(RepoSnapshot)
            session.exec(stale)
            session.commit()
        for name in list(_errors):
            if name not in names:
                del _errors[name]
    finally:
        _refreshing = False

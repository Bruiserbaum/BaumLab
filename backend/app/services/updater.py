"""
Self-update via Portainer.

Checks the GitHub repo's tags for a vX.Y.Z newer than the running APP_VERSION, and
applies it by asking Portainer to redeploy BaumLab's Git-based stack at that tag.
Portainer pulls the repo, rebuilds the images (pull_policy: build in compose) and
recreates the containers — including this one, so the redeploy request is fired
from a background task and expected to be cut off when the API restarts.
"""
import asyncio
import re
from datetime import datetime

import httpx

from .config_service import read_config, decrypt

DEFAULT_REPO = "Bruiserbaum/BaumLab"
_TAG_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")   # skips other tag series like suite-v1.1.0

_state = {
    "checked_at": None,
    "latest": None,
    "latest_tag": None,
    "check_error": None,
    "updating": False,
    "update_target": None,
    "update_started_at": None,
    "update_error": None,
}
_task = None  # keep a reference so the background redeploy isn't garbage-collected


class UpdateError(Exception):
    pass


def _parse(version: str):
    m = _TAG_RE.match((version or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def current_version() -> str:
    from ..main import APP_VERSION
    return APP_VERSION


def get_config() -> dict:
    u = read_config().get("updates", {})
    return {
        "repo": u.get("repo") or DEFAULT_REPO,
        "portainer_connection": u.get("portainer_connection", ""),
        "stack_id": u.get("stack_id"),
    }


def status() -> dict:
    cfg = get_config()
    current = current_version()
    latest = _parse(_state["latest"] or "")
    return {
        **_state,
        "current": current,
        "update_available": bool(latest and latest > (_parse(current) or (0, 0, 0))),
        "repo": cfg["repo"],
        "can_apply": bool(cfg["portainer_connection"] and cfg["stack_id"]),
    }


# ── Version check (GitHub) ─────────────────────────────────────────────────────

async def check() -> dict:
    repo = get_config()["repo"]
    try:
        async with httpx.AsyncClient(timeout=15, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "BaumLab-updater",
        }) as c:
            r = await c.get(f"https://api.github.com/repos/{repo}/tags", params={"per_page": 100})
    except httpx.HTTPError as e:
        _state["check_error"] = f"Could not reach GitHub: {e}"
        raise UpdateError(_state["check_error"]) from e
    if r.status_code >= 400:
        _state["check_error"] = f"GitHub returned HTTP {r.status_code} for {repo}"
        raise UpdateError(_state["check_error"])

    versions = [(v, t["name"]) for t in r.json() if (v := _parse(t.get("name", "")))]
    if not versions:
        _state["check_error"] = f"No vX.Y.Z tags found in {repo}"
        raise UpdateError(_state["check_error"])
    latest, tag = max(versions)
    _state.update(
        checked_at=datetime.utcnow().isoformat(),
        latest=".".join(map(str, latest)),
        latest_tag=tag,
        check_error=None,
    )
    return status()


async def check_quietly():
    """Scheduler entry point — failures are recorded in status, not raised."""
    try:
        await check()
    except UpdateError as e:
        print(f"Update check failed: {e}")


# ── Portainer ──────────────────────────────────────────────────────────────────

def _portainer(connection_name: str) -> tuple[str, dict]:
    connections = read_config().get("portainer", {}).get("connections", [])
    conn = next((c for c in connections if c.get("name") == connection_name), None)
    if not conn:
        raise UpdateError(f"Portainer connection '{connection_name}' not found (Docker page → connections)")
    headers = {"X-API-Key": decrypt(conn.get("api_key", ""))} if conn.get("api_key") else {}
    return conn["url"].rstrip("/"), headers


def _check(r: httpx.Response):
    if r.status_code >= 400:
        try:
            body = r.json()
            msg = body.get("message") or body.get("details") or r.text
        except Exception:
            msg = r.text
        raise UpdateError(f"Portainer returned HTTP {r.status_code}: {str(msg)[:300]}")


async def list_stacks(connection_name: str) -> list[dict]:
    base, headers = _portainer(connection_name)
    try:
        async with httpx.AsyncClient(timeout=15, verify=False, headers=headers) as c:
            r = await c.get(f"{base}/api/stacks")
    except httpx.HTTPError as e:
        raise UpdateError(f"Could not reach Portainer: {e}") from e
    _check(r)
    stacks = []
    for s in r.json():
        git = s.get("GitConfig") or {}
        stacks.append({
            "id": s.get("Id"),
            "name": s.get("Name"),
            "endpoint_id": s.get("EndpointId"),
            "git_url": git.get("URL"),
            "reference": git.get("ReferenceName"),
        })
    return sorted(stacks, key=lambda s: (s["git_url"] is None, (s["name"] or "").lower()))


async def apply(tag: str):
    """Start redeploying the configured stack at `tag`. Returns immediately."""
    global _task
    if _state["updating"]:
        raise UpdateError("An update is already in progress")
    if not _parse(tag):
        raise UpdateError(f"'{tag}' is not a vX.Y.Z release tag")
    cfg = get_config()
    if not (cfg["portainer_connection"] and cfg["stack_id"]):
        raise UpdateError("Choose a Portainer connection and stack in Settings → Updates first")
    base, headers = _portainer(cfg["portainer_connection"])

    try:
        async with httpx.AsyncClient(timeout=15, verify=False, headers=headers) as c:
            r = await c.get(f"{base}/api/stacks/{cfg['stack_id']}")
    except httpx.HTTPError as e:
        raise UpdateError(f"Could not reach Portainer: {e}") from e
    _check(r)
    stack = r.json()
    git = stack.get("GitConfig")
    if not git:
        raise UpdateError(f"Stack '{stack.get('Name')}' is not deployed from a Git repository")

    auth = git.get("Authentication") or {}
    payload = {
        "RepositoryReferenceName": f"refs/tags/{tag}",
        "RepositoryAuthentication": bool(auth),
        "RepositoryUsername": auth.get("Username", ""),
        "RepositoryPassword": "",            # blank = Portainer keeps the stored password
        "Env": stack.get("Env") or [],       # must be sent back — omitting it wipes the stack's env vars
        "Prune": False,
        "PullImage": False,                  # BaumLab images rebuild anyway; don't surprise-upgrade OpenVAS
    }
    _state.update(updating=True, update_target=tag, update_error=None,
                  update_started_at=datetime.utcnow().isoformat())
    _task = asyncio.create_task(_redeploy(base, headers, stack, payload))


async def _redeploy(base: str, headers: dict, stack: dict, payload: dict):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(900, connect=15), verify=False, headers=headers) as c:
            r = await c.put(f"{base}/api/stacks/{stack['Id']}/git/redeploy",
                            params={"endpointId": stack.get("EndpointId")}, json=payload)
        _check(r)
        # Still running means this container wasn't recreated — usually the tag had no changes
        _state.update(updating=False)
        print(f"Update: Portainer redeployed stack '{stack.get('Name')}' at {payload['RepositoryReferenceName']}")
    except UpdateError as e:
        _state.update(updating=False, update_error=str(e))
        print(f"Update failed: {e}")
    except httpx.HTTPError as e:
        # Expected: Portainer recreates this container mid-request. The new container starts fresh.
        print(f"Update: connection to Portainer closed ({e}) — restarting into the new version")

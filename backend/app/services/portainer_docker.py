"""
Synchronous Docker API access to any Portainer environment, through Portainer's Docker proxy
(/api/endpoints/<id>/docker/...). Used by recovery kits, which run in scheduler worker threads
and move large tar streams — so everything streams to and from files instead of memory.
"""
import json
from typing import Optional

import httpx

from .portainer_client import _connection

HELPER_IMAGE = "alpine:3.20"       # tiny image used to read/write volumes on the target host


class DockerAPIError(RuntimeError):
    pass


def _check(r: httpx.Response, what: str):
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.json().get("details") or r.text
        except Exception:
            msg = r.text
        raise DockerAPIError(f"{what}: HTTP {r.status_code} {str(msg)[:300]}")


class PortainerDocker:
    def __init__(self, connection: str, endpoint_id: int):
        base, headers = _connection(connection)
        self.endpoint_id = endpoint_id
        # Long read timeout: archive and dump streams can take a while on big volumes
        self.http = httpx.Client(base_url=base, headers=headers, verify=False,
                                 timeout=httpx.Timeout(60.0, read=3600.0))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.http.close()

    def _d(self, path: str) -> str:
        return f"/api/endpoints/{self.endpoint_id}/docker{path}"

    def _json(self, method: str, path: str, what: str, **kw):
        r = self.http.request(method, self._d(path), **kw)
        _check(r, what)
        return r.json() if r.content else None

    # ── Read ──────────────────────────────────────────────────────────────────

    def containers(self, project: Optional[str] = None) -> list[dict]:
        params = {"all": 1}
        if project:
            params["filters"] = json.dumps({"label": [f"com.docker.compose.project={project}"]})
        return self._json("GET", "/containers/json", "List containers", params=params)

    def inspect(self, container: str) -> dict:
        return self._json("GET", f"/containers/{container}/json", f"Inspect {container}")

    def image(self, ref: str) -> Optional[dict]:
        r = self.http.get(self._d(f"/images/{ref}/json"))
        return r.json() if r.status_code == 200 else None

    def volume(self, name: str) -> Optional[dict]:
        r = self.http.get(self._d(f"/volumes/{name}"))
        return r.json() if r.status_code == 200 else None

    def archive_to_file(self, container: str, path: str, out_path: str) -> int:
        """Tar of a path inside the container (works on stopped containers too). Returns bytes written."""
        size = 0
        with self.http.stream("GET", self._d(f"/containers/{container}/archive"), params={"path": path}) as r:
            if r.status_code >= 400:
                r.read()
                _check(r, f"Copy {container}:{path}")
            with open(out_path, "wb") as fh:
                for chunk in r.iter_bytes(1 << 20):
                    fh.write(chunk)
                    size += len(chunk)
        return size

    def exec_to_file(self, container: str, cmd: list[str], out_path: str, env: Optional[list[str]] = None) -> tuple[int, str]:
        """Run a command in the container, stdout → file. Returns (exit code, stderr text)."""
        created = self._json("POST", f"/containers/{container}/exec", f"Exec in {container}",
                             json={"Cmd": cmd, "AttachStdout": True, "AttachStderr": True, "Tty": False,
                                   "Env": env or []})
        exec_id = created["Id"]
        stderr = bytearray()
        with self.http.stream("POST", self._d(f"/exec/{exec_id}/start"), json={"Detach": False, "Tty": False}) as r:
            if r.status_code >= 400:
                r.read()
                _check(r, f"Exec in {container}")
            with open(out_path, "wb") as fh:
                buf = b""
                for chunk in r.iter_bytes(1 << 16):
                    buf += chunk
                    # Multiplexed stream: [stream id, 0, 0, 0, size (4 bytes BE)] + payload
                    while len(buf) >= 8:
                        size = int.from_bytes(buf[4:8], "big")
                        if len(buf) < 8 + size:
                            break
                        payload, stream = buf[8:8 + size], buf[0]
                        buf = buf[8 + size:]
                        if stream == 2:
                            if len(stderr) < 65536:
                                stderr += payload
                        else:
                            fh.write(payload)
        info = self._json("GET", f"/exec/{exec_id}/json", "Exec result")
        return int(info.get("ExitCode") or 0), stderr.decode(errors="replace").strip()

    def stop(self, container: str):
        r = self.http.post(self._d(f"/containers/{container}/stop"), params={"t": 30})
        if r.status_code not in (204, 304):
            _check(r, f"Stop {container}")

    def start(self, container: str):
        r = self.http.post(self._d(f"/containers/{container}/start"))
        if r.status_code not in (204, 304):
            _check(r, f"Start {container}")

    # ── Write (restore) ───────────────────────────────────────────────────────

    def pull(self, image: str):
        name, _, tag = image.partition(":")
        with self.http.stream("POST", self._d("/images/create"), params={"fromImage": name, "tag": tag or "latest"}) as r:
            body = r.read()
        _check(r, f"Pull {image}")
        for line in body.decode(errors="replace").splitlines():
            if '"error"' in line:
                raise DockerAPIError(f"Pull {image}: {json.loads(line).get('error')}")

    def create_volume(self, name: str, labels: dict, driver: str = "local"):
        self._json("POST", "/volumes/create", f"Create volume {name}",
                   json={"Name": name, "Driver": driver or "local", "Labels": labels or {}})

    def create_helper(self, binds: list[str], cmd: Optional[list[str]] = None) -> str:
        """A stopped helper container with the given mounts, for copying data in."""
        created = self._json("POST", "/containers/create", "Create helper container",
                             json={"Image": HELPER_IMAGE, "Cmd": cmd or ["true"], "Labels": {"baumlab.helper": "restore"},
                                   "HostConfig": {"Binds": binds}})
        return created["Id"]

    def run_helper(self, container: str) -> int:
        self.start(container)
        r = self.http.post(self._d(f"/containers/{container}/wait"), timeout=httpx.Timeout(60.0, read=3600.0))
        _check(r, "Wait for helper")
        return int(r.json().get("StatusCode", 0))

    def put_archive(self, container: str, path: str, tar_path: str):
        with open(tar_path, "rb") as fh:
            r = self.http.put(self._d(f"/containers/{container}/archive"), params={"path": path}, content=fh,
                              headers={"Content-Type": "application/x-tar"})
        _check(r, f"Copy into {container}:{path}")

    def remove(self, container: str):
        self.http.delete(self._d(f"/containers/{container}"), params={"force": 1, "v": 0})

    # ── Portainer stacks ──────────────────────────────────────────────────────

    def stacks(self) -> list[dict]:
        r = self.http.get("/api/stacks")
        _check(r, "List Portainer stacks")
        return [s for s in r.json() or [] if s.get("EndpointId") == self.endpoint_id]

    def stack_file(self, stack_id: int) -> str:
        r = self.http.get(f"/api/stacks/{stack_id}/file")
        _check(r, "Read stack file")
        return r.json().get("StackFileContent", "")

    def create_stack(self, name: str, compose: str, env: list[dict]) -> dict:
        body = {"name": name, "stackFileContent": compose, "env": env}
        r = self.http.post("/api/stacks/create/standalone/string", params={"endpointId": self.endpoint_id},
                           json=body, timeout=httpx.Timeout(60.0, read=1800.0))
        if r.status_code in (404, 405):        # Portainer before 2.19
            r = self.http.post("/api/stacks", params={"type": 2, "method": "string", "endpointId": self.endpoint_id},
                               json=body, timeout=httpx.Timeout(60.0, read=1800.0))
        _check(r, f"Deploy stack {name}")
        return r.json()

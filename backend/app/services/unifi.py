"""
UniFi Controller integration — Classic controller or UniFi Dream Machine (UDM).

Auth modes:
  1. API key   — set api_key; uses X-API-KEY header, bypasses MFA entirely
  2. Password  — username + password; UDM needs controller_type="udm" for correct paths

Controller types:
  classic — login: POST /api/login       data: /api/s/{site}/...
  udm     — login: POST /api/auth/login  data: /proxy/network/api/s/{site}/...
"""
import httpx
from typing import Optional


class UniFiClient:
    def __init__(self, url: str, username: str = "", password: str = "",
                 site: str = "default", verify_ssl: bool = False,
                 api_key: str = "", controller_type: str = "classic"):
        self.base = url.rstrip("/")
        self.site = site
        self._creds = {"username": username, "password": password}
        self._verify = verify_ssl
        self._api_key = api_key.strip()
        self._is_udm = controller_type == "udm"
        self._client: Optional[httpx.AsyncClient] = None
        self._logged_in = False

    async def _ensure_client(self):
        if self._client is None:
            headers = {}
            if self._api_key:
                headers["X-API-KEY"] = self._api_key
            self._client = httpx.AsyncClient(
                verify=self._verify, timeout=15, headers=headers
            )

    async def login(self):
        await self._ensure_client()
        # API key auth — no login request needed
        if self._api_key:
            self._logged_in = True
            return
        login_path = "/api/auth/login" if self._is_udm else "/api/login"
        r = await self._client.post(f"{self.base}{login_path}", json=self._creds)
        r.raise_for_status()
        self._logged_in = True

    async def _get(self, path: str) -> list[dict]:
        if not self._logged_in:
            await self.login()
        prefix = "/proxy/network" if self._is_udm else ""
        r = await self._client.get(f"{self.base}{prefix}/api/s/{self.site}/{path}")
        r.raise_for_status()
        return r.json().get("data", [])

    # ── Public methods ────────────────────────────────────────────────────────

    async def get_clients(self) -> list[dict]:
        """All currently connected clients with IP, MAC, VLAN, hostname, signal."""
        return await self._get("stat/sta")

    async def get_devices(self) -> list[dict]:
        """UniFi network devices (APs, switches, gateways)."""
        return await self._get("stat/device")

    async def get_networks(self) -> list[dict]:
        """Configured networks/VLANs."""
        return await self._get("rest/networkconf")

    async def get_port_stats(self, device_mac: str) -> list[dict]:
        """Per-port stats for a switch."""
        devices = await self.get_devices()
        for d in devices:
            if d.get("mac") == device_mac:
                return d.get("port_table", [])
        return []

    async def close(self):
        if self._client:
            await self._client.aclose()

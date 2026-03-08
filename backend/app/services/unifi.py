"""
UniFi Controller integration (self-hosted or Ubiquiti Cloud).
Uses the UniFi Network Application REST API.

Tested against UniFi Network Application 7.x.
Set credentials in config.yaml:
  unifi:
    url: https://192.168.1.1:8443   # or https://unifi.ui.com for cloud
    username: admin
    password: your_password
    site: default
    verify_ssl: false
"""
import httpx
from typing import Optional


class UniFiClient:
    def __init__(self, url: str, username: str, password: str,
                 site: str = "default", verify_ssl: bool = False):
        self.base = url.rstrip("/")
        self.site = site
        self._creds = {"username": username, "password": password}
        self._verify = verify_ssl
        self._client: Optional[httpx.AsyncClient] = None
        self._logged_in = False

    async def _ensure_client(self):
        if self._client is None:
            self._client = httpx.AsyncClient(verify=self._verify, timeout=15)

    async def login(self):
        await self._ensure_client()
        r = await self._client.post(f"{self.base}/api/login", json=self._creds)
        r.raise_for_status()
        self._logged_in = True

    async def _get(self, path: str) -> list[dict]:
        if not self._logged_in:
            await self.login()
        r = await self._client.get(f"{self.base}/api/s/{self.site}/{path}")
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

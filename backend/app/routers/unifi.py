from fastapi import APIRouter, Depends, HTTPException
from ..services.unifi import UniFiClient
from ..services.auth import get_current_user
import os, yaml

router = APIRouter(prefix="/api/unifi", tags=["unifi"], dependencies=[Depends(get_current_user)])

CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config/config.yaml")


def _get_client() -> UniFiClient:
    try:
        with open(CONFIG_PATH) as f:
            raw = yaml.safe_load(f)
        uf = raw.get("unifi", {})
        if not uf.get("url"):
            raise HTTPException(status_code=503, detail="UniFi not configured")
        return UniFiClient(
            url=uf["url"],
            username=uf.get("username", ""),
            password=uf.get("password", ""),
            site=uf.get("site", "default"),
            verify_ssl=uf.get("verify_ssl", False),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="config.yaml not found")


@router.get("/clients")
async def get_clients():
    client = _get_client()
    try:
        return await client.get_clients()
    finally:
        await client.close()


@router.get("/devices")
async def get_devices():
    client = _get_client()
    try:
        return await client.get_devices()
    finally:
        await client.close()


@router.get("/networks")
async def get_networks():
    client = _get_client()
    try:
        return await client.get_networks()
    finally:
        await client.close()


@router.get("/devices/{mac}/ports")
async def get_port_stats(mac: str):
    client = _get_client()
    try:
        return await client.get_port_stats(mac)
    finally:
        await client.close()

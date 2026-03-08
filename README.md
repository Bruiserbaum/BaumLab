# BaumLab

A self-hosted home lab monitoring, mapping, and troubleshooting dashboard.

## Features

- **Network discovery** — nmap-based scanning with automatic device classification (router, NAS, camera, PC, etc.)
- **Device map** — interactive network topology view (ReactFlow)
- **Service monitors** — ping/TCP/HTTP checks on configurable intervals via APScheduler
- **VLAN awareness** — tag and filter devices by VLAN
- **UniFi integration** — pull client lists, device stats, and port info from a UniFi controller
- **Docker deployment** — single `docker compose up` to run everything

## Quick Start

```bash
git clone https://github.com/Bruiserbaum/BaumLab.git
cd BaumLab

# Copy and edit config
cp config/config.yaml.example config/config.yaml
# (edit scan ranges, UniFi credentials, etc.)

docker compose up -d
```

- **UI**: http://localhost:3000
- **API docs**: http://localhost:8000/docs

## Network Scanning

For ARP-based discovery and raw ICMP ping to work, the API container needs host network access.
Edit `docker-compose.yml` and replace the `networks` block under `api` with:

```yaml
network_mode: host
```

Then restart: `docker compose up -d api`

> Note: `network_mode: host` is Linux-only. On Mac/Windows, scanning is limited to what
> the bridge network can reach.

## Configuration

`config/config.yaml` (excluded from git — never commit credentials):

```yaml
scan:
  default_ranges:
    - "192.168.1.0/24"
  auto_interval_minutes: 60

unifi:
  url: "https://192.168.1.1"   # or your controller IP
  username: "admin"
  password: "changeme"
  site: "default"
  verify_ssl: false
```

## Stack

| Layer | Tech |
|-------|------|
| API | FastAPI + SQLModel (SQLite) |
| Scheduler | APScheduler |
| Discovery | python-nmap + mac-vendor-lookup |
| Monitoring | icmplib + httpx |
| Frontend | React + Vite + ReactFlow |
| Deploy | Docker + Compose |

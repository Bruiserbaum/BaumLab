# BaumLab

A self-hosted home lab monitoring, mapping, and security dashboard. Discover everything on your network, watch service health in real time, scan for open ports and vulnerabilities, and pull live data from your UniFi controller â€” all in one dark-themed web UI.

![BaumLab screenshot](docs/screenshot.png)

---

## Features

### Network Discovery
- **nmap-based scanning** â€” ARP host discovery across one or more CIDR ranges
- **Automatic device classification** â€” heuristic typing by MAC vendor, open ports, and OS fingerprint (router, NAS, server, Raspberry Pi, Apple device, etc.)
- **Live scan log** â€” scrolling output streamed to the UI while a scan runs
- **Device management** â€” edit labels, device type, VLAN tag, and notes per device; delete stale entries

### Network Map
- **Interactive topology diagram** (ReactFlow) showing gateways â†’ switches/APs â†’ clients
- **VLAN colour coding** â€” up to 6 colours distinguish network segments at a glance
- **UniFi enrichment** â€” overlays UniFi client/device data (signal strength, model) onto discovered hosts

### Service Monitors
- **Continuous health checks** â€” ICMP ping, raw TCP connect, HTTP/HTTPS status checks
- **Per-target intervals** â€” configure each monitor independently (seconds granularity)
- **Live results** â€” latency, status code, up/down history
- **Overall status roll-up** â€” Operational / Degraded / Outage / Unknown
- **Public status page** â€” unauthenticated read-only view embeddable in dashboards (e.g. BaumDash Status tab)

### Port Scanning
- **Quick scan** â€” common, top-100, or top-1000 port presets
- **Deep scan** â€” nmap NSE scripts extract SSL certificates, TLS cipher suites, HTTP server headers and page titles, SMB security negotiation details
- **Per-device on-demand** â€” trigger a port scan from the Devices page for any host

### External Scanning
- **Public IP detection** â€” fetch the server's external IP
- **Port probe** â€” socket-based scan of 20 common ports (FTP, SSH, HTTP, HTTPS, RDP, VNC, MySQL, etc.) against any external host
- **DNS lookup** â€” resolve any domain to all IPv4 and IPv6 addresses

### Vulnerability Scanning (OpenVAS)
- **Greenbone Community Edition** bundled as a Docker service â€” no separate install
- **Scan task management** â€” create, launch, monitor progress, view results, delete tasks
- **CVSS-rated findings** â€” colour-coded severity badges (Critical / High / Medium / Low / Log)
- **Scan configuration picker** â€” choose from all configs available in your OpenVAS instance
- Connects via GMP Unix socket or TLS/TCP

### UniFi Integration
- **Clients** â€” connected WiFi and LAN clients with IP, MAC, VLAN, signal strength (dBm), TX/RX bytes
- **Devices** â€” APs, switches, gateways with model, uptime, CPU, memory
- **Networks** â€” configured VLANs and network segments
- **Switch port stats** â€” per-port traffic on managed switches
- Supports both **classic UniFi Controller** and **UniFi Dream Machine / UDM Pro** (API key or username/password auth)

### Authentication & Users
- **JWT login** with configurable token expiry
- **TOTP two-factor authentication** â€” QR code setup, per-user enable/disable
- **Role-based access** â€” admin and standard user roles
- **User management** â€” create, edit, delete users (admin only); each user manages their own MFA
- Auto-creates an initial admin account on first startup

### Settings
- **UniFi** â€” URL, credentials, site, controller type, SSL verification; test connection button
- **Scan** â€” default CIDR ranges, auto-scan toggle and interval
- **OpenVAS** â€” socket path or host/port, credentials; test connection button

---

## Stack

| Layer | Tech |
|-------|------|
| API | FastAPI + SQLModel (SQLite) |
| Scheduler | APScheduler |
| Discovery | python-nmap + mac-vendor-lookup |
| Monitoring | icmplib + httpx |
| Vuln scanning | Greenbone OpenVAS (GMP protocol) |
| Frontend | React 18 + Vite + ReactFlow + Zustand |
| Auth | JWT + pyotp (TOTP 2FA) |
| Deploy | Docker + Compose |

---

## Quick Start

```bash
git clone https://github.com/Bruiserbaum/BaumLab.git
cd BaumLab

# Set required environment variables
cp .env.example .env
# Edit .env â€” set SECRET_KEY, ADMIN_PASSWORD, and OPENVAS_ADMIN_PASSWORD

# Copy and edit config
cp config/config.yaml.example config/config.yaml
# Edit config.yaml â€” set your scan ranges and (optionally) UniFi credentials

docker compose up -d
```

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3100 |
| API docs | http://localhost:8100/docs |
| OpenVAS UI | http://localhost:9392 |

> **First run:** OpenVAS takes 15â€“60 minutes to sync its vulnerability feed before scans can run.

---

## Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | â€” | **Required.** JWT signing key â€” generate with `openssl rand -hex 32` |
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | â€” | **Required.** Initial admin password |
| `TOKEN_EXPIRE_HOURS` | `8` | JWT token lifetime |
| `API_PORT` | `8100` | API container port |
| `UI_PORT` | `3100` | Frontend container port |
| `OPENVAS_ADMIN_USERNAME` | `admin` | OpenVAS admin user |
| `OPENVAS_ADMIN_PASSWORD` | `changeme` | **Change this.** OpenVAS admin password |
| `OPENVAS_PORT` | `9392` | Greenbone Security Assistant port |

### `config/config.yaml`

```yaml
scan:
  default_ranges:
    - "192.168.1.0/24"
  auto_interval_minutes: 60

unifi:
  url: "https://192.168.1.1"   # Leave blank to disable
  username: "admin"
  password: "changeme"
  site: "default"
  verify_ssl: false
  controller_type: "udm"        # "classic" or "udm"

monitor:
  default_interval_seconds: 60
```

All UniFi and OpenVAS settings can also be changed at runtime from the Settings page without editing files.

---

## Network Scanning Notes

For ARP-based discovery and raw ICMP ping, the API container needs elevated network capabilities. These are already set in `docker-compose.yml`:

```yaml
cap_add:
  - NET_ADMIN
  - NET_RAW
```

For full ARP scanning on Linux hosts, switch the API to host networking:

```yaml
network_mode: host
```

Then restart: `docker compose up -d api`

> `network_mode: host` is Linux-only. On Windows/Mac, scanning is limited to what the bridge network can reach.

---

## API

Full interactive docs available at `http://localhost:8100/docs` when running.

| Endpoint group | Description |
|---------------|-------------|
| `POST /api/auth/login` | Authenticate (returns token or MFA challenge) |
| `GET /api/devices` | List all discovered devices |
| `POST /api/scan/network` | Start a background network discovery scan |
| `POST /api/scan/ports/{id}` | Deep port scan a specific device |
| `GET /api/monitors` | List service monitors |
| `GET /api/status/public` | Public monitor status (no auth) |
| `POST /api/advanced-scan/start` | Advanced NSE port scan |
| `GET /api/external-scan/ip` | Get server's public IP |
| `POST /api/external-scan/ports` | Probe external ports |
| `GET /api/unifi/clients` | UniFi connected clients |
| `GET /api/unifi/devices` | UniFi network devices |
| `GET /api/vuln-scan/tasks` | List OpenVAS scan tasks |
| `POST /api/vuln-scan/start` | Launch a vulnerability scan |
| `GET /api/settings` | Get current settings (admin) |
| `GET /api/users` | User management (admin) |

---

## Related Projects

- [BaumDash](https://github.com/Bruiserbaum/BaumDash) â€” Desktop dashboard with audio mixer, Discord, media controls, and a Status tab that can embed the BaumLab public status page
- [BaumLaunch](https://github.com/Bruiserbaum/BaumLaunch) â€” WinGet-based GUI package manager for Windows
- [BaumDocker](https://github.com/Bruiserbaum/BaumDocker) â€” Home lab Docker stack collection
- [BaumSecure](https://github.com/Bruiserbaum/BaumSecure) â€” Windows home lab security analyzer

---

## License and Project Status

This repository is a personal project shared publicly for learning, reference, portfolio, and experimentation purposes.

Development may include AI-assisted ideation, drafting, refactoring, or code generation. All code and content published here were reviewed, selected, and curated before release.

This project is licensed under the Apache License 2.0. See the LICENSE file for details.

Unless explicitly stated otherwise, this repository is provided as-is, without warranty, support obligation, or guarantee of suitability for production use.

Any third-party libraries, assets, icons, fonts, models, or dependencies used by this project remain subject to their own licenses and terms.
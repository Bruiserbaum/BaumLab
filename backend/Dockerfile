FROM rclone/rclone:1.68 AS rclone

FROM python:3.12-slim

# rclone uploads backups to B2 / SMB / SFTP / local destinations
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

# nmap + arp-scan for network discovery
RUN apt-get update && apt-get install -y --no-install-recommends \
    nmap \
    arp-scan \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Build stamp shown next to the version, so you can tell which deploy is running
RUN date -u +"%Y-%m-%dT%H:%M:%SZ" > /app/BUILD_TIME

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

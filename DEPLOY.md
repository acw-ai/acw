# Deploying ACW to a Cloud Server (Ubuntu 22.04 / 24.04)

This guide walks through setting up ACW in production with:
* Node.js >= 22
* MySQL / SQLite (with automated migrations)
* Caddy or Nginx for automatic HTTPS
* systemd service for automatic process restarts
* Scheduled database backups

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Ubuntu 22.04 or 24.04 LTS | 1 vCPU and 1 GB RAM is sufficient for up to 100 concurrent agents. |
| Root or sudo SSH access | Required for installing packages and system services. |
| Domain / Subdomain | E.g. `acw.yourcompany.com` (pointed via DNS A record to your server IP). |
| Ports 80 & 443 | Open in firewall / security group for HTTPS certificates. |
| 3CX API Credentials | `PBX_URL`, `PBX_CLIENT_ID`, and `PBX_CLIENT_SECRET`. |

---

## 2. Server Installation

### A. Clone and Install Dependencies
```bash
git clone https://github.com/acw-ai/acw.git /opt/acw
cd /opt/acw
npm install --omit=dev
```

### B. Configure Environment
```bash
cp .env.example .env
nano .env
```
Fill in your configuration:
```env
PORT=3100
HOST=127.0.0.1
PBX_URL=https://your-3cx-domain.3cx.ca
PBX_CLIENT_ID=your-client-id
PBX_CLIENT_SECRET=your-client-secret
SUPERVISOR_PASSWORD=choose-a-strong-password
SESSION_SECRET=generate-a-random-32-byte-hex-key
```

---

## 3. Configure systemd Service

Create `/etc/systemd/system/acw.service`:
```ini
[Unit]
Description=ACW (After-Call Work Service)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/acw
ExecStart=/usr/bin/node --use-system-ca --env-file=.env src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now acw
sudo systemctl status acw
```

---

## 4. Reverse Proxy with HTTPS (Caddy Example)

In `/etc/caddy/Caddyfile`:
```caddy
acw.yourcompany.com {
    reverse_proxy 127.0.0.1:3100
}
```
Reload Caddy:
```bash
sudo systemctl reload caddy
```

---

## 5. Verification

1. Open `https://acw.yourcompany.com/supervisor.html` and log in with your supervisor password.
2. Check the logs:
   ```bash
   sudo journalctl -u acw -f
   ```
   You should see:
   `[3cx] connected to wss://your-3cx-domain.3cx.ca/callcontrol/ws`

# Deploying GETUS dispositions to an Ubuntu cloud server

This sets up the app on Ubuntu 22.04 or 24.04 with:
- Node.js 24
- MySQL (a new `getus_dispositions` database, with migrations)
- Caddy for automatic HTTPS
- a systemd service that restarts itself
- nightly database backups

Allow about 20 minutes.

## 1. Before you start

| You need | Notes |
|---|---|
| An Ubuntu 22.04 / 24.04 server | 1 vCPU and 1 GB RAM is plenty. DigitalOcean, AWS Lightsail, Azure and Vultr all work. |
| SSH access with `sudo` | |
| A web address for the app, e.g. `dispo.getus.ca` | Create a DNS **A record** that points it at the server's public IP. Do this first, because HTTPS won't work until the name resolves. |
| Ports **80** and **443** open | Open them in the cloud provider's firewall or security group. Caddy needs both to get and renew the certificate. |
| Your 3CX API client ID and secret | The same ones as in your local `.env`. |

The server must be able to reach your 3CX system over HTTPS on the internet (`https://getus.3cx.ca`).

## 2. Upload the app

From this PC, in PowerShell, in the folder that contains `getus-dispositions-deploy.tar.gz`:

```bash
scp getus-dispositions-deploy.tar.gz youruser@SERVER_IP:~
```

The package leaves out `.env`, `node_modules` and the local test databases. Your 3CX secret stays on this PC.

## 3. Run the setup script

On the server:

```bash
mkdir -p ~/getus-dispositions && tar -xzf ~/getus-dispositions-deploy.tar.gz -C ~/getus-dispositions
```

```bash
cd ~/getus-dispositions && sudo bash deploy/setup-ubuntu.sh dispo.getus.ca
```

Replace `dispo.getus.ca` with your own address. The script:

1. Installs Node.js 24, MySQL and Caddy.
2. Copies the app to `/opt/getus-dispositions` and runs it as a locked-down `getus` user.
3. Creates the `getus_dispositions` database and its own MySQL user with a random password.
4. Writes `/opt/getus-dispositions/.env` (readable only by that user) and runs the migrations.
5. Sets up HTTPS for your address.
6. Sets up a nightly backup to `/var/backups/getus` (kept 14 days).

**Write down the supervisor password it prints.** It's shown once. It's also saved in `.env`.

## 4. Connect it to 3CX

```bash
sudo nano /opt/getus-dispositions/.env
```

Fill in `PBX_URL`, `PBX_CLIENT_ID` and `PBX_CLIENT_SECRET`, then save (Ctrl+O, Enter, Ctrl+X).

```bash
sudo systemctl restart getus-dispositions
```

```bash
sudo journalctl -u getus-dispositions -f
```

You should see `[3cx] connected to wss://getus.3cx.ca/callcontrol/ws`. Press Ctrl+C to stop watching.

**In the 3CX Admin Console:** under **Integrations → API**, make sure the API client can see every agent's extension. Right now it only sees 2005.

## 5. Set agent PINs

1. Open `https://dispo.getus.ca/supervisor.html` and sign in with the supervisor password.
2. Scroll to **Agent PINs**. Add each agent's extension with a PIN of 4–12 digits, and give each agent their own PIN.
3. Setting a new PIN signs that agent out everywhere. Use it if a PIN leaks.

## 6. Set up each agent's PC

1. Open `https://dispo.getus.ca/agent.html` in Edge or Chrome, and sign in with the extension and PIN.
2. **⋯ → Apps → Install this site as an app**, then pin it to the taskbar.
3. Click **Turn on desktop alerts** once.

## 7. Turn on queue logout (after a test)

The first run is popup-only (`ENFORCE_DISPOSITION=false`). Test it before you switch it on:

1. Set `MONITORED_EXTENSIONS=2005` and `ENFORCE_DISPOSITION=true` in `.env`, then restart the service.
2. Log 2005 in to a queue. Take a queue call, hang up, and check that 2005 shows as logged out of the queue in 3CX.
3. Save the outcome, and check that 2005 is logged back in.
4. Then clear `MONITORED_EXTENSIONS`, or list every agent, and restart.

Set each queue's **wrap-up time** to 5–10 seconds. That stops 3CX from offering the next call before the logout takes effect.

## Updating to a new version

Upload the new package and run the same two commands from step 3. Your `.env` and database are kept. New migrations run automatically when the service starts. You can also run them by hand:

```bash
cd /opt/getus-dispositions && sudo -u getus npm run migrate
```

## Backups

- Nightly at 02:15 to `/var/backups/getus/`, kept 14 days.
- Back up now: `sudo getus-backup`
- Restore: `gunzip -c /var/backups/getus/FILE.sql.gz | sudo mysql getus_dispositions`

Copy backups off the server from time to time, or turn on your provider's snapshot backups.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser shows a certificate error or "can't connect" | DNS must point at the server and ports 80/443 must be open. See `sudo journalctl -u caddy -n 50`. |
| `Can't reach 3CX at …` in the logs | The server can't reach the 3CX address. Check `PBX_URL`, and run `curl -I https://getus.3cx.ca` on the server. |
| `3CX token request failed (401)` | Wrong `PBX_CLIENT_ID` or secret, or the API client was deleted or regenerated in 3CX. |
| No popups for some agents | The 3CX API client can't see those extensions (Integrations → API). |
| `Could not open the mysql database` | Run `sudo systemctl status mysql`, and check the `MYSQL_*` lines in `.env`. |
| Agent says their PIN doesn't work | After 5 wrong tries the extension is locked for 10 minutes. A supervisor can set a new PIN. |
| Service status / restart | `sudo systemctl status getus-dispositions` · `sudo systemctl restart getus-dispositions` |

## Optional: server firewall

If your provider has no firewall, you can turn on Ubuntu's. Check your SSH port first: if SSH isn't on port 22, allow that port instead, or you'll lock yourself out.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

MySQL and the app itself listen only on `127.0.0.1`, so the internet can't reach them directly.

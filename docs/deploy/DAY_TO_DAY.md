# Day-to-day — deploy, push, logs (Hetzner)

Full setup/history: [HETZNER.md](./HETZNER.md).

| | |
| --- | --- |
| Site | https://communityhub.evolyx.in |
| SSH | `ssh -i ~/.ssh/id_ed25519_hetzner root@2.31.20.217` |
| App dir | `/opt/communityhub` |
| Secrets | `/etc/communityhub.env` |

Shortcut used below:

```bash
KEY=~/.ssh/id_ed25519_hetzner
HOST=root@2.31.20.217
```

---

## Push new code

From the repo root on your Mac:

```bash
npm run deploy:hetzner
```

Builds, rsyncs to `/opt/communityhub`, `npm ci` on the VM, restarts `communityhub`.

Config (gitignored): `scripts/deploy/hetzner.deploy.env`

```bash
# Reuse existing dist/
HETZNER_SKIP_BUILD=1 npm run deploy:hetzner
```

---

## SCP — copy files Mac ↔ VM

All from the **Mac** (repo root unless noted).

### Secrets & Firebase SA

```bash
# .env.local → production env file
scp -i "$KEY" .env.local "$HOST:/etc/communityhub.env"

# Firebase service account JSON
scp -i "$KEY" firebase-service-account.json \
  "$HOST:/opt/communityhub/firebase-service-account.json"

# Fix ownership + restart (required after env change)
ssh -i "$KEY" "$HOST" '
  chown root:communityhub /etc/communityhub.env
  chmod 640 /etc/communityhub.env
  chown communityhub:communityhub /opt/communityhub/firebase-service-account.json
  chmod 640 /opt/communityhub/firebase-service-account.json
  systemctl restart communityhub
'
```

### Bootstrap / Caddy templates

```bash
scp -i "$KEY" -r deploy/hetzner/. "$HOST:~/communityhub-deploy/"
```

### Single file into the app tree

```bash
# Example: one server file without full deploy
scp -i "$KEY" server/index.js "$HOST:/opt/communityhub/server/index.js"
ssh -i "$KEY" "$HOST" 'systemctl restart communityhub'
```

### Folder (prefer rsync)

```bash
rsync -az -e "ssh -i $KEY" dist/ "$HOST:/opt/communityhub/dist/"
rsync -az -e "ssh -i $KEY" packages/ "$HOST:/opt/communityhub/packages/"
ssh -i "$KEY" "$HOST" 'systemctl restart communityhub'
```

### Pull files **from** the VM (debug / backup)

```bash
# Download remote env (keep private)
scp -i "$KEY" "$HOST:/etc/communityhub.env" ./communityhub.env.from-vm

# Download Caddyfile
scp -i "$KEY" "$HOST:/etc/caddy/Caddyfile" ./Caddyfile.from-vm

# Download a slice of journal to a file
ssh -i "$KEY" "$HOST" 'journalctl -u communityhub -n 200 --no-pager' > ./communityhub.journal.txt
```

---

## After changing secrets only

```bash
# Option A — sync via deploy flags (HETZNER_SYNC_ENV=1 in hetzner.deploy.env)
npm run deploy:hetzner

# Option B — scp (see above) + systemctl restart communityhub
```

Env changes need **`systemctl restart communityhub`** (`reload` does not reload `EnvironmentFile`).

---

## Health checks

```bash
# Public HTTPS
curl -fsS https://communityhub.evolyx.in/healthz
curl -fsSI https://communityhub.evolyx.in/ | head -n 20

# On VM (bypasses Caddy)
curl -fsS http://127.0.0.1:3000/healthz

# Service status
ssh -i "$KEY" "$HOST" 'systemctl status communityhub caddy --no-pager'
```

---

## Logs

```bash
ssh -i "$KEY" "$HOST"

# App — follow
journalctl -u communityhub -f

# Last N lines
journalctl -u communityhub -n 100 --no-pager

# Since a time
journalctl -u communityhub --since "10 min ago" --no-pager

# Auth + workspace boot
journalctl -u communityhub -f | grep -E 'auth-session|workspace-boot'

# Errors only (heuristic)
journalctl -u communityhub --since today --no-pager | grep -iE 'error|fail|uncaught|ECONN'

# Caddy
journalctl -u caddy -n 50 --no-pager
tail -f /var/log/caddy/communityhub.log
```

From Mac in one shot:

```bash
ssh -i "$KEY" "$HOST" 'journalctl -u communityhub -n 80 --no-pager'
ssh -i "$KEY" "$HOST" 'journalctl -u communityhub -f'
```

---

## Restart services

```bash
ssh -i "$KEY" "$HOST" 'systemctl restart communityhub'
ssh -i "$KEY" "$HOST" 'systemctl reload caddy'    # Caddyfile change
ssh -i "$KEY" "$HOST" 'systemctl restart caddy'   # if reload fails
```

Re-apply HTTPS Caddyfile after editing templates:

```bash
ssh -i "$KEY" "$HOST" \
  'DOMAIN=communityhub.evolyx.in bash ~/communityhub-deploy/setup-remote.sh'
```

---

## Debugging (regular)

### Is the process up? Ports?

```bash
ssh -i "$KEY" "$HOST" '
  systemctl is-active communityhub caddy
  ss -tlnp | grep -E ":80|:443|:3000"
  ps aux | grep -E "[n]ode server/index|[c]addy" 
'
```

### Disk / memory / load

```bash
ssh -i "$KEY" "$HOST" '
  df -h /
  free -h
  uptime
  systemctl show communityhub -p MemoryCurrent -p MemoryMax --no-pager
'
```

### Env loaded by the running Node process (names only)

```bash
ssh -i "$KEY" "$HOST" '
  pid=$(pgrep -f "node server/index.js" | head -1)
  echo "pid=$pid"
  tr "\0" "\n" < /proc/$pid/environ | cut -d= -f1 | sort
'
```

Confirm a flag without printing secrets:

```bash
ssh -i "$KEY" "$HOST" '
  grep -E "^(SESSION_COOKIE_SECURE|FIREBASE_PROJECT_ID|MONGODB_DB_NAME|NODE_ENV)=" /etc/communityhub.env
'
```

### TLS certificate dates

```bash
echo | openssl s_client -servername communityhub.evolyx.in \
  -connect communityhub.evolyx.in:443 2>/dev/null \
  | openssl x509 -noout -dates -subject
```

### DNS

```bash
dig +short communityhub.evolyx.in A
dig +short communityhub.evolyx.in AAAA
```

### Hit an API from the VM (auth will 401 if logged out — still useful)

```bash
ssh -i "$KEY" "$HOST" '
  curl -sS -i http://127.0.0.1:3000/api/new/workspace-boot | head -n 25
  curl -sS -i https://communityhub.evolyx.in/api/new/workspace-boot | head -n 25
'
```

### List deployed app tree

```bash
ssh -i "$KEY" "$HOST" 'ls -la /opt/communityhub; ls /opt/communityhub/dist | head'
```

### Node / npm versions on VM

```bash
ssh -i "$KEY" "$HOST" 'node -v; npm -v; which node'
```

### Firewall (UFW + reminder)

```bash
ssh -i "$KEY" "$HOST" 'ufw status verbose'
# Also check Hetzner Cloud Console → Firewalls (22/80/443)
```

---

## Quick troubleshooting

| Symptom | What to do |
| --- | --- |
| Site down | `systemctl status communityhub caddy` + `journalctl -u communityhub -n 50` |
| 401 on workspace-boot | Normal if logged out; watch `auth-session` after login |
| Login never hits API | Firebase **Authorized domains** includes `communityhub.evolyx.in` |
| Deploy SSH fail | Key / host in `hetzner.deploy.env` |
| Secrets not applied | Confirm `/etc/communityhub.env` + `systemctl restart communityhub` |
| HTTPS broken | `journalctl -u caddy -n 80`; DNS A still `2.31.20.217`; ports 80/443 open |
| Disk full | `df -h /` — clear old logs if needed: `journalctl --vacuum-time=7d` |

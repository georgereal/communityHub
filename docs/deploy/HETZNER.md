# Hetzner VPS — CommunityHub production runbook

Production host for the long-running Node server (replaces Vercel serverless for this stack).

```
Internet → Caddy (:443 HTTPS, auto Let’s Encrypt)
         → Node 127.0.0.1:3000  (/api/* + dist/)
```

| Item | Value |
| --- | --- |
| Provider | Hetzner Cloud |
| Location | Falkenstein (`fsn1`) |
| Public IPv4 | `2.31.20.217` |
| Public IPv6 | `2a01:4f8:c016:2b9c::1` |
| Hostname | `ubuntu-4gb-fsn1-2` |
| OS | Ubuntu 26.04 LTS (x86_64) |
| Size | 4 GB RAM · ~40 GB disk · 20 TB traffic |
| Public URL | https://communityhub.evolyx.in |
| App dir | `/opt/communityhub` |
| Secrets | `/etc/communityhub.env` |
| Service user | `communityhub` (systemd) |

Update the table if the VM or DNS changes.

---

## 1. What we set up (chronological)

### 1.1 Create the server (Hetzner Console)

1. **Location:** Falkenstein (or nearest).
2. **Image:** Ubuntu 26.x (or 24.04).
3. **Type:** Cost-Optimized shared plan (~$7, 4 GB RAM) — not the expensive CPX “Regular Performance” tier unless you need it.
4. **Networking:** public **IPv4** (+ IPv6 optional).
5. **SSH key:** upload your Mac public key (see §2).
6. **Firewall** `communityhub-web`:
   - TCP **22** — your IP `/32` (or Any)
   - TCP **80** — Any (HTTP + ACME)
   - TCP **443** — Any (HTTPS)
   - Do **not** expose port **3000**

### 1.2 SSH from the Mac

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@2.31.20.217
```

### 1.3 Bootstrap (Node + Caddy + systemd)

From the **laptop** (repo root):

```bash
npm run bootstrap:hetzner
# or IP-first without DOMAIN, then later:
# DOMAIN=communityhub.evolyx.in SKIP_DEPLOY=1 npm run bootstrap:hetzner
```

This installs Node 22, Caddy, creates `/opt/communityhub`, systemd unit `communityhub.service`, and an initial Caddyfile.

**IP-first path we used:** bootstrap with **no** `DOMAIN` → HTTP on `:80` → smoke-test → then DNS + HTTPS.

### 1.4 Secrets

| Local | On VM |
| --- | --- |
| `.env.local` | `/etc/communityhub.env` (via deploy sync) |
| `firebase-service-account.json` | `/opt/communityhub/firebase-service-account.json` |

systemd loads env with `EnvironmentFile=/etc/communityhub.env` before `node server/index.js`.

Important flags:

- `SESSION_COOKIE_SECURE=0` — only while testing on plain HTTP IP  
- `SESSION_COOKIE_SECURE=1` — after HTTPS (current production)

### 1.5 Deploy app code

```bash
npm run deploy:hetzner
```

Builds locally, rsyncs `dist/`, `api/`, `apps/new/api/`, `classic/api/`, `packages/`, `server/`, runs `npm ci --omit=dev` on the VM, restarts `communityhub`.

### 1.6 DNS

At your DNS host for `evolyx.in`:

| Name | Type | Value |
| --- | --- | --- |
| `communityhub` | A | `2.31.20.217` |

→ hostname **`communityhub.evolyx.in`**

### 1.7 Enable HTTPS

```bash
ssh -i ~/.ssh/id_ed25519_hetzner root@2.31.20.217
DOMAIN=communityhub.evolyx.in bash ~/communityhub-deploy/setup-remote.sh
# ensure SESSION_COOKIE_SECURE=1 in /etc/communityhub.env
systemctl restart communityhub
```

Caddy obtains a **Let’s Encrypt** certificate automatically (HTTP-01 on port 80).

### 1.8 Firebase

Firebase Console → Authentication → Settings → **Authorized domains** → add:

- `communityhub.evolyx.in`
- (optional during IP tests) `2.31.20.217`

---

## 2. SSH keys (Mac)

| File | Role |
| --- | --- |
| `~/.ssh/id_ed25519_hetzner` | Private — never share |
| `~/.ssh/id_ed25519_hetzner.pub` | Public — Hetzner Console → Security → SSH Keys |

```bash
# Create (only if needed)
ssh-keygen -t ed25519 -C "communityhub-hetzner" -f ~/.ssh/id_ed25519_hetzner

# Show public key for Hetzner
cat ~/.ssh/id_ed25519_hetzner.pub

# Connect
ssh -i ~/.ssh/id_ed25519_hetzner root@2.31.20.217
```

Optional `~/.ssh/config`:

```sshconfig
Host communityhub-hetzner
  HostName 2.31.20.217
  User root
  IdentityFile ~/.ssh/id_ed25519_hetzner
```

---

## 3. TLS certificates (Let’s Encrypt) & auto-renewal

| Topic | Detail |
| --- | --- |
| Issuer | Let’s Encrypt via **Caddy** built-in ACME |
| Lifetime | ~**90 days** |
| Renewal | **Automatic** — Caddy renews well before expiry (typically ~30 days left) |
| Downtime | None expected; Caddy reloads the new cert in place |
| Storage | Under Caddy’s data dir (e.g. `/var/lib/caddy/…`) — do not manage manually |

**Requirements for renewal to keep working**

1. `caddy.service` enabled and running  
2. DNS for `communityhub.evolyx.in` still points at this VM  
3. Ports **80** and **443** open (Hetzner firewall + UFW)

**No cron job is required.**

### Check cert dates

```bash
echo | openssl s_client -servername communityhub.evolyx.in \
  -connect communityhub.evolyx.in:443 2>/dev/null \
  | openssl x509 -noout -dates -subject
```

### Caddy / renewal logs

```bash
journalctl -u caddy -n 50 --no-pager
journalctl -u caddy --no-pager | grep -iE 'renew|certificate obtained|tls.obtain' | tail -20
tail -f /var/log/caddy/communityhub.log
```

---

## 4. Day-to-day commands

**Cheatsheet (deploy / logs / restarts):** → **[DAY_TO_DAY.md](./DAY_TO_DAY.md)**

### Laptop

```bash
# Full bootstrap + deploy (first time / rebuild VM)
DOMAIN=communityhub.evolyx.in npm run bootstrap:hetzner

# Ship code only
npm run deploy:hetzner

# Config (gitignored)
# scripts/deploy/hetzner.deploy.env
```

### VM

```bash
systemctl status communityhub caddy
journalctl -u communityhub -f
curl -fsS http://127.0.0.1:3000/healthz
```

---

## 5. Layout on disk

### Repo

```
deploy/hetzner/                 # VM templates (Caddy, systemd, setup)
scripts/deploy/
  bootstrap-hetzner.sh          # one-shot bootstrap + deploy
  deploy-hetzner.sh             # build + rsync + restart
  hetzner.deploy.env.example
  hetzner.deploy.env            # gitignored
docs/deploy/HETZNER.md          # this runbook
server/                         # long-running Node entry (shared with Vite API adapter)
```

### VM

```
/opt/communityhub/              # app (dist, api, server, packages, …)
/etc/communityhub.env           # secrets (EnvironmentFile)
/etc/caddy/Caddyfile
/etc/systemd/system/communityhub.service
/var/log/caddy/communityhub.log
```

---

## 6. Troubleshooting

| Symptom | Check |
| --- | --- |
| `Permission denied (publickey)` | `-i ~/.ssh/id_ed25519_hetzner`, key in Hetzner |
| `workspace-boot` 401 only | Normal until signed in; then Firebase authorized domain + cookies |
| No `auth-session` logs | Login failed in browser (Firebase authorized domains) |
| HTTPS TLS errors right after DNS | Wait for Caddy ACME; `journalctl -u caddy -f` |
| Cert won’t renew | Port 80 blocked, DNS moved, or `caddy` stopped |
| Env changes ignored | `systemctl restart communityhub` after editing `/etc/communityhub.env` |

---

## 7. Architecture note

Same handlers as Vite/Vercel: `server/vercelStyleApi.js` mounts root `api/*`. Static SPA rewrites live in `server/staticRoutes.js`. See `docs/ARCHITECTURE_NEW.md` for Mongo REST domains.

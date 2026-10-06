#!/usr/bin/env bash
# One-time (or re-run) bootstrap on the Hetzner Ubuntu VPS.
#   DOMAIN=communityhub.evolyx.in bash deploy/hetzner/setup-remote.sh   # HTTPS
#   bash deploy/hetzner/setup-remote.sh                                   # HTTP-on-IP
set -euo pipefail

APP_USER="${APP_USER:-communityhub}"
APP_DIR="${APP_DIR:-/opt/communityhub}"
NODE_MAJOR="${NODE_MAJOR:-22}"
DOMAIN="${DOMAIN:-}"

if [[ "$(id -u)" -eq 0 ]]; then
  run() { "$@"; }
  run_bash() { bash "$@"; }
else
  run() { sudo "$@"; }
  run_bash() { sudo -E bash "$@"; }
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing packages (Node ${NODE_MAJOR}, Caddy, rsync)"
run apt-get update -y
run apt-get install -y curl ca-certificates gnupg rsync ufw

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/^v//;s/\..*//')" != "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | run_bash -
  run apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null 2>&1; then
  run apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | run gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | run tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  run apt-get update -y
  run apt-get install -y caddy
fi

echo "==> Creating ${APP_USER} and ${APP_DIR}"
if ! id "$APP_USER" >/dev/null 2>&1; then
  run useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
run mkdir -p "$APP_DIR" /var/log/caddy
run chown -R "$APP_USER:$APP_USER" "$APP_DIR"
run chown caddy:caddy /var/log/caddy || true

UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/communityhub.service"
CADDY_SRC="$(cd "$(dirname "$0")" && pwd)/Caddyfile"
CADDY_IP_SRC="$(cd "$(dirname "$0")" && pwd)/Caddyfile.ip-http"
ENV_SRC="$(cd "$(dirname "$0")" && pwd)/env.example"

if [[ -f "$UNIT_SRC" ]]; then
  run cp "$UNIT_SRC" /etc/systemd/system/communityhub.service
fi

if [[ ! -f /etc/communityhub.env ]]; then
  run cp "$ENV_SRC" /etc/communityhub.env
  run chown root:"$APP_USER" /etc/communityhub.env
  run chmod 640 /etc/communityhub.env
  echo "Created /etc/communityhub.env — fill in secrets before starting the service."
fi

if [[ -n "$DOMAIN" ]]; then
  tmp="$(mktemp)"
  sed "s/__DOMAIN__/${DOMAIN}/g" "$CADDY_SRC" > "$tmp"
  run cp "$tmp" /etc/caddy/Caddyfile
  rm -f "$tmp"
  echo "Wrote /etc/caddy/Caddyfile for HTTPS on ${DOMAIN}"
else
  run cp "$CADDY_IP_SRC" /etc/caddy/Caddyfile
  echo "Wrote /etc/caddy/Caddyfile for HTTP-on-IP (no DOMAIN)."
fi

run ufw allow OpenSSH
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable || true

run systemctl daemon-reload
run systemctl enable communityhub.service
run systemctl enable caddy
run systemctl reload caddy 2>/dev/null || run systemctl restart caddy

echo "==> Bootstrap done."
echo "Next: fill /etc/communityhub.env if needed, then from laptop: npm run deploy:hetzner"
echo "Health: curl -fsS http://127.0.0.1:3000/healthz"

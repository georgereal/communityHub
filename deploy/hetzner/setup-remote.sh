#!/usr/bin/env bash
# One-time (or re-run) bootstrap on the Hetzner Ubuntu VPS.
#   DOMAIN=communityhub.evolyx.in bash deploy/hetzner/setup-remote.sh      # HTTPS site on shared Caddy
#   CADDY_LAYOUT=standalone bash deploy/hetzner/setup-remote.sh             # HTTP-on-IP (single-app host)
#
# Caddy layouts:
#   shared (default)  — writes /etc/caddy/sites/communityhub.caddy and ensures the
#                       root Caddyfile imports /etc/caddy/sites/*.caddy. Other apps'
#                       site blocks are preserved.
#   standalone        — rewrites /etc/caddy/Caddyfile entirely (single-app host only).
set -euo pipefail

APP_USER="${APP_USER:-communityhub}"
APP_DIR="${APP_DIR:-/opt/communityhub}"
NODE_MAJOR="${NODE_MAJOR:-22}"
DOMAIN="${DOMAIN:-}"
CADDY_LAYOUT="${CADDY_LAYOUT:-shared}"
CADDY_ROOT="${CADDY_ROOT:-/etc/caddy/Caddyfile}"
CADDY_SITES_DIR="${CADDY_SITES_DIR:-/etc/caddy/sites}"
CADDY_SITE_NAME="${CADDY_SITE_NAME:-communityhub.caddy}"

if [[ "$(id -u)" -eq 0 ]]; then
  run() { "$@"; }
  run_bash() { bash "$@"; }
else
  run() { sudo "$@"; }
  run_bash() { sudo -E bash "$@"; }
fi

export DEBIAN_FRONTEND=noninteractive

if [[ "${SKIP_PACKAGES:-0}" == "1" ]]; then
  echo "==> Skipping package installs (SKIP_PACKAGES=1)"
else
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
fi

echo "==> Creating ${APP_USER} and ${APP_DIR}"
if ! id "$APP_USER" >/dev/null 2>&1; then
  run useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
run mkdir -p "$APP_DIR" /var/log/caddy
run chown -R "$APP_USER:$APP_USER" "$APP_DIR"
run chown caddy:caddy /var/log/caddy || true

UNIT_SRC="$(cd "$(dirname "$0")" && pwd)/communityhub.service"
CADDY_SHARED_ROOT_SRC="$(cd "$(dirname "$0")" && pwd)/Caddyfile.shared-root"
CADDY_SITE_SRC="$(cd "$(dirname "$0")" && pwd)/Caddyfile.site"
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

backup_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    run cp "$f" "${f}.bak.$(date +%Y%m%d%H%M%S)"
  fi
}

if [[ "$CADDY_LAYOUT" == "shared" ]]; then
  if [[ -z "$DOMAIN" ]]; then
    echo "ERROR: DOMAIN is required for CADDY_LAYOUT=shared." >&2
    echo "       Each site needs a hostname for HTTPS." >&2
    echo "       Use CADDY_LAYOUT=standalone for HTTP-on-IP bootstrap." >&2
    exit 1
  fi

  run mkdir -p "$CADDY_SITES_DIR"

  # Install only this app's site fragment — never clobber other sites.
  tmp="$(mktemp)"
  sed "s/__DOMAIN__/${DOMAIN}/g" "$CADDY_SITE_SRC" > "$tmp"
  backup_file "${CADDY_SITES_DIR}/${CADDY_SITE_NAME}"
  run cp "$tmp" "${CADDY_SITES_DIR}/${CADDY_SITE_NAME}"
  rm -f "$tmp"
  run chmod 644 "${CADDY_SITES_DIR}/${CADDY_SITE_NAME}"
  echo "Wrote ${CADDY_SITES_DIR}/${CADDY_SITE_NAME} for ${DOMAIN}"

  # Ensure the root Caddyfile imports per-app fragments.
  if [[ ! -f "$CADDY_ROOT" ]]; then
    run cp "$CADDY_SHARED_ROOT_SRC" "$CADDY_ROOT"
    echo "Created shared root ${CADDY_ROOT} (imports ${CADDY_SITES_DIR}/*.caddy)"
  elif grep -qF "import ${CADDY_SITES_DIR}/" "$CADDY_ROOT"; then
    echo "Root ${CADDY_ROOT} already imports ${CADDY_SITES_DIR}/*.caddy"
  else
    # Existing root has inline site blocks (e.g. another app installed first).
    # Keep them and add the fragment import so both coexist.
    backup_file "$CADDY_ROOT"
    printf '\n# Per-app site fragments (imported; do not remove)\nimport %s/*.caddy\n' \
      "$CADDY_SITES_DIR" | run tee -a "$CADDY_ROOT" >/dev/null
    echo "Appended sites import to existing ${CADDY_ROOT} (other site blocks preserved)"
  fi
else
  # Standalone layout: this app owns the whole Caddyfile (single-app host).
  if [[ -n "$DOMAIN" ]]; then
    tmp="$(mktemp)"
    sed "s/__DOMAIN__/${DOMAIN}/g" "$CADDY_SRC" > "$tmp"
    backup_file "$CADDY_ROOT"
    run cp "$tmp" "$CADDY_ROOT"
    rm -f "$tmp"
    run chmod 644 "$CADDY_ROOT"
    echo "Wrote ${CADDY_ROOT} for HTTPS on ${DOMAIN} (standalone layout)"
  else
    backup_file "$CADDY_ROOT"
    run cp "$CADDY_IP_SRC" "$CADDY_ROOT"
    echo "Wrote ${CADDY_ROOT} for HTTP-on-IP (standalone layout, no DOMAIN)."
  fi
fi

if ! run caddy validate --config "$CADDY_ROOT" --adapter caddyfile; then
  echo "ERROR: caddy config validation failed; NOT reloading caddy." >&2
  echo "       Check ${CADDY_ROOT} and ${CADDY_SITES_DIR}/ — backups saved next to modified files." >&2
  exit 1
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

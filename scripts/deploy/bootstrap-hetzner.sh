#!/usr/bin/env bash
# One-shot from your Mac: bootstrap Hetzner + deploy CommunityHub.
#
#   npm run bootstrap:hetzner
#
# Optional:
#   SKIP_BOOTSTRAP=1  — only deploy
#   SKIP_DEPLOY=1     — only bootstrap
#   DOMAIN=communityhub.evolyx.in  — write HTTPS Caddyfile during bootstrap
#   HETZNER_SYNC_ENV=0 — do not push .env.local
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${HETZNER_DEPLOY_ENV:-$ROOT/scripts/deploy/hetzner.deploy.env}"
EXAMPLE="$ROOT/scripts/deploy/hetzner.deploy.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE" "$ENV_FILE"
  echo "Created $ENV_FILE — edit HETZNER_HOST / HETZNER_SSH_KEY if needed, then re-run." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${HETZNER_HOST:?HETZNER_HOST required in hetzner.deploy.env}"
: "${HETZNER_USER:?HETZNER_USER required}"
HETZNER_PORT="${HETZNER_PORT:-22}"
HETZNER_APP_DIR="${HETZNER_APP_DIR:-/opt/communityhub}"
HETZNER_SSH_KEY="${HETZNER_SSH_KEY:-}"

SSH_OPTS=(-p "$HETZNER_PORT" -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-P "$HETZNER_PORT" -o StrictHostKeyChecking=accept-new)
if [[ -n "$HETZNER_SSH_KEY" ]]; then
  key="${HETZNER_SSH_KEY/#\~/$HOME}"
  SSH_OPTS+=(-i "$key")
  SCP_OPTS+=(-i "$key")
fi

REMOTE="${HETZNER_USER}@${HETZNER_HOST}"
DOMAIN="${DOMAIN:-}"

echo "========================================"
echo " Target:  ${REMOTE}"
echo " App dir: ${HETZNER_APP_DIR}"
if [[ -n "$DOMAIN" ]]; then
  echo " Mode:    HTTPS (${DOMAIN})"
  echo " Browse:  https://${DOMAIN}/"
else
  echo " Mode:    HTTP-on-IP (set DOMAIN=… for HTTPS)"
  echo " Browse:  http://${HETZNER_HOST}/"
fi
echo "========================================"

if [[ "${SKIP_BOOTSTRAP:-0}" != "1" ]]; then
  echo "==> [1/3] Upload deploy/hetzner + run setup-remote.sh"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p ~/communityhub-deploy"
  scp "${SCP_OPTS[@]}" -r \
    "$ROOT/deploy/hetzner/." \
    "$REMOTE:~/communityhub-deploy/"
  if [[ -n "$DOMAIN" ]]; then
    ssh "${SSH_OPTS[@]}" "$REMOTE" "DOMAIN='${DOMAIN}' bash ~/communityhub-deploy/setup-remote.sh"
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE" "bash ~/communityhub-deploy/setup-remote.sh"
  fi
else
  echo "==> Skipping bootstrap (SKIP_BOOTSTRAP=1)"
fi

if [[ "${SKIP_DEPLOY:-0}" != "1" ]]; then
  echo "==> [2/3] Deploy app (build + rsync + npm ci + restart)"
  export HETZNER_DEPLOY_ENV="$ENV_FILE"
  bash "$ROOT/scripts/deploy/deploy-hetzner.sh"
else
  echo "==> Skipping deploy (SKIP_DEPLOY=1)"
fi

echo "==> [3/3] Quick checks"
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "curl -fsS http://127.0.0.1:3000/healthz && echo"
if [[ -n "$DOMAIN" ]]; then
  curl -fsS "https://${DOMAIN}/healthz" && echo || true
fi

echo ""
echo "Done."
if [[ -n "$DOMAIN" ]]; then
  echo "  https://${DOMAIN}/"
else
  echo "  http://${HETZNER_HOST}/"
fi

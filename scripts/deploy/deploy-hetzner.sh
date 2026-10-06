#!/usr/bin/env bash
# Build locally and rsync CommunityHub to the Hetzner VPS, then restart systemd.
#
#   cp scripts/deploy/hetzner.deploy.env.example scripts/deploy/hetzner.deploy.env
#   npm run deploy:hetzner
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${HETZNER_DEPLOY_ENV:-$ROOT/scripts/deploy/hetzner.deploy.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Copy scripts/deploy/hetzner.deploy.env.example → scripts/deploy/hetzner.deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${HETZNER_HOST:?HETZNER_HOST is required}"
: "${HETZNER_USER:?HETZNER_USER is required}"
HETZNER_PORT="${HETZNER_PORT:-22}"
HETZNER_APP_DIR="${HETZNER_APP_DIR:-/opt/communityhub}"

SSH_OPTS=(-p "$HETZNER_PORT" -o StrictHostKeyChecking=accept-new)
RSYNC_RSH="ssh -p ${HETZNER_PORT} -o StrictHostKeyChecking=accept-new"
SCP_OPTS=(-P "$HETZNER_PORT" -o StrictHostKeyChecking=accept-new)
if [[ -n "${HETZNER_SSH_KEY:-}" ]]; then
  key="${HETZNER_SSH_KEY/#\~/$HOME}"
  SSH_OPTS+=(-i "$key")
  SCP_OPTS+=(-i "$key")
  RSYNC_RSH="ssh -p ${HETZNER_PORT} -i ${key} -o StrictHostKeyChecking=accept-new"
fi

REMOTE="${HETZNER_USER}@${HETZNER_HOST}"

echo "==> Target ${REMOTE}:${HETZNER_APP_DIR}"

if [[ "${HETZNER_SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building (npm run build)"
  npm run build
else
  echo "==> Skipping build (HETZNER_SKIP_BUILD=1)"
  if [[ ! -d "$ROOT/dist" ]]; then
    echo "dist/ missing — run npm run build first" >&2
    exit 1
  fi
fi

echo "==> Ensuring remote directory"
ssh "${SSH_OPTS[@]}" "$REMOTE" \
  "sudo mkdir -p '${HETZNER_APP_DIR}/apps/new' '${HETZNER_APP_DIR}/classic' && sudo chown -R \"\$(whoami):\" '${HETZNER_APP_DIR}'"

RSYNC_EXCLUDES=(
  --exclude '.git/'
  --exclude 'node_modules/'
  --exclude '.env'
  --exclude '.env.local'
  --exclude '.env.production'
  --exclude 'firebase-service-account.json'
)

echo "==> Rsync runtime files"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/dist/" "$REMOTE:$HETZNER_APP_DIR/dist/"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/api/" "$REMOTE:$HETZNER_APP_DIR/api/"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/server/" "$REMOTE:$HETZNER_APP_DIR/server/"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/packages/" "$REMOTE:$HETZNER_APP_DIR/packages/"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/apps/new/api/" "$REMOTE:$HETZNER_APP_DIR/apps/new/api/"
rsync -az --delete -e "$RSYNC_RSH" "${RSYNC_EXCLUDES[@]}" \
  "$ROOT/classic/api/" "$REMOTE:$HETZNER_APP_DIR/classic/api/"
rsync -az -e "$RSYNC_RSH" \
  "$ROOT/package.json" "$ROOT/package-lock.json" \
  "$REMOTE:$HETZNER_APP_DIR/"

# Keep VM bootstrap templates in sync for future DOMAIN switches
rsync -az -e "$RSYNC_RSH" \
  "$ROOT/deploy/hetzner/" "$REMOTE:~/communityhub-deploy/"

if [[ "${HETZNER_SYNC_ENV:-0}" == "1" ]]; then
  local_env="${HETZNER_ENV_LOCAL:-.env.local}"
  local_env="${local_env/#\~/$HOME}"
  if [[ ! -f "$local_env" ]]; then
    echo "HETZNER_SYNC_ENV=1 but $local_env not found" >&2
    exit 1
  fi
  echo "==> Syncing env → /etc/communityhub.env"
  scp "${SCP_OPTS[@]}" "$local_env" "$REMOTE:/tmp/communityhub.env.upload"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "sudo mv /tmp/communityhub.env.upload /etc/communityhub.env && sudo chown root:communityhub /etc/communityhub.env && sudo chmod 640 /etc/communityhub.env && sudo bash -c 'tail -c1 /etc/communityhub.env | read -r _ || echo >> /etc/communityhub.env'"
fi

if [[ "${HETZNER_SYNC_FIREBASE_SA:-0}" == "1" ]]; then
  sa="${HETZNER_FIREBASE_SA_LOCAL:-./firebase-service-account.json}"
  sa="${sa/#\~/$HOME}"
  if [[ ! -f "$sa" ]]; then
    echo "HETZNER_SYNC_FIREBASE_SA=1 but $sa not found" >&2
    exit 1
  fi
  echo "==> Syncing Firebase service account"
  scp "${SCP_OPTS[@]}" "$sa" "$REMOTE:$HETZNER_APP_DIR/firebase-service-account.json"
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "sudo chown communityhub:communityhub '$HETZNER_APP_DIR/firebase-service-account.json' && sudo chmod 640 '$HETZNER_APP_DIR/firebase-service-account.json'"
fi

echo "==> Remote npm ci + ownership + restart"
ssh "${SSH_OPTS[@]}" "$REMOTE" bash -s <<EOF
set -euo pipefail
APP_DIR='$HETZNER_APP_DIR'
cd "\$APP_DIR"
mkdir -p apps/new classic
npm ci --omit=dev
if id communityhub >/dev/null 2>&1; then
  sudo chown -R communityhub:communityhub "\$APP_DIR"
fi
sudo systemctl daemon-reload
sudo systemctl restart communityhub
sleep 1
if systemctl is-active --quiet caddy 2>/dev/null; then
  sudo systemctl reload caddy || sudo systemctl restart caddy
fi
curl -fsS http://127.0.0.1:3000/healthz
echo
sudo systemctl --no-pager --full status communityhub | head -n 20
EOF

echo "==> Deploy complete → ${REMOTE}:${HETZNER_APP_DIR}"

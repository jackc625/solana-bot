#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${HOME}/solana-bot"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.monitoring.yml"
PM2_NAME="solana-bot"

echo "==> Updating ${PROJECT_DIR}"
cd "${PROJECT_DIR}"

# Optional safety backups
cp -n .env .env.bak 2>/dev/null || true
mkdir -p backups 2>/dev/null || true
[ -d data ] && cp -a data "backups/data_$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true

echo "==> Syncing with GitHub (origin/main)"
git fetch origin
git reset --hard origin/main

echo "==> Installing dependencies"
npm ci

# Ensure Docker is running if installed
if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled docker >/dev/null 2>&1; then
  systemctl start docker || true
fi

echo "==> (Re)starting PM2 process: ${PM2_NAME}"
if pm2 describe "${PM2_NAME}" >/dev/null 2>&1; then
  pm2 restart "${PM2_NAME}"
else
  # Uses your package.json start script: node --loader ts-node/esm src/bot.ts
  pm2 start npm --name "${PM2_NAME}" -- run start
fi
pm2 save

# Bring up monitoring stack if docker compose file exists
if [ -f "${COMPOSE_FILE}" ]; then
  echo "==> Updating monitoring stack via Docker Compose"
  # Optionally pull latest images if available (comment out if you don’t want this)
  docker compose -f "${COMPOSE_FILE}" pull || true
  docker compose -f "${COMPOSE_FILE}" up -d
else
  echo "==> Skipping monitoring stack (no ${COMPOSE_FILE})"
fi

echo "==> Status"
pm2 ls || true
docker ps || true

echo "==> Tail recent bot logs"
pm2 logs "${PM2_NAME}" --lines 50 --timestamp || true

echo "✅ Done."
EOF
chmod +x update-all.sh

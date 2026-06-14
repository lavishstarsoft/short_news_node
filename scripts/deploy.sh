#!/usr/bin/env bash
# Production deploy helper for /var/www/yellowsingam
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest code..."
git pull origin main

echo "==> Installing dependencies (npm ci)..."
npm ci

echo "==> Restarting PM2 process..."
pm2 restart yellowsingam_server || pm2 start server.js --name yellowsingam_server

echo "==> Health check..."
sleep 2
curl -sf "http://127.0.0.1:${PORT:-3001}/api/public/languages?forUserApp=1" > /dev/null \
  && echo "OK: server responding on port ${PORT:-3001}" \
  || echo "WARN: health check failed — run: pm2 logs yellowsingam_server --lines 50"

pm2 save

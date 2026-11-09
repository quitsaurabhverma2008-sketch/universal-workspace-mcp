#!/data/data/com.termux/files/usr/bin/bash
# Watchdog: ping /health; restart the server through start.sh if it is down.
# Intended to run every ~60 s from cron/Termux:Boot, or manually.
set -uo pipefail
cd "$(dirname "$0")/.."

if curl -fsS -m 5 http://127.0.0.1:3333/health >/dev/null 2>&1; then
  echo "ok $(date -Iseconds)"
  exit 0
fi

echo "health check FAILED at $(date -Iseconds) — restarting"
bash scripts/start.sh
curl -fsS -m 5 http://127.0.0.1:3333/health && echo "recovered" || echo "STILL DOWN — check data/server.log"

#!/data/data/com.termux/files/usr/bin/bash
# Start Universal Workspace MCP inside tmux (survives terminal close).
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build

termux-wake-lock 2>/dev/null || true

if tmux has-session -t umcp 2>/dev/null; then
  echo "session 'umcp' already running (attach: tmux attach -t umcp)"
  exit 0
fi

tmux new-session -d -s umcp "node --env-file=.env dist/index.js 2>&1 | tee -a data/server.log"
echo "started: tmux attach -t umcp"
echo "health:  curl -s http://127.0.0.1:3333/health"

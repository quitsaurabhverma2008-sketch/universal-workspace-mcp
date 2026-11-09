#!/data/data/com.termux/files/usr/bin/bash
# Termux:Boot hook — copy to ~/.termux/boot/start-umcp.sh and chmod +x.
# Requires: Termux:Boot installed and "Run on boot" enabled for it.
set -uo pipefail

termux-wake-lock
cd "$HOME/UNIVERSAL-MCP"

# MCP server (rebuild to pick up updates, then run under tmux)
npm run build
tmux kill-session -t umcp 2>/dev/null
tmux new-session -d -s umcp "node --env-file=.env dist/index.js 2>&1 | tee -a data/server.log"

# Cloudflare tunnel (after `cloudflared tunnel login/create/route dns` once)
tmux kill-session -t umcp-tunnel 2>/dev/null
tmux new-session -d -s umcp-tunnel "cloudflared tunnel run umcp"

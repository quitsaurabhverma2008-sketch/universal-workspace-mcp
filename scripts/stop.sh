#!/data/data/com.termux/files/usr/bin/bash
# Stop the Universal Workspace MCP tmux session.
set -euo pipefail
tmux send-keys -t umcp C-c 2>/dev/null || true
sleep 1
tmux kill-session -t umcp 2>/dev/null || true
echo "stopped (if it was running)"

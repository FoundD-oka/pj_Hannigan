#!/bin/bash
# T11: start an interactive Claude Code session with Remote Control inside tmux "hn-t11",
# so the operator can check from a phone whether the Computer Use app approval reaches it.
# usage: scripts/t11-start.sh [work-dir]
set -euo pipefail
DIR="${1:-$HOME/hannigan-t11}"
mkdir -p "$DIR"
if tmux has-session -t hn-t11 2>/dev/null; then
  echo "tmux session hn-t11 already exists. attach: tmux attach -t hn-t11" >&2
  exit 1
fi
tmux new-session -d -s hn-t11 -x 160 -y 48 -c "$DIR" \
  claude --permission-mode manual --remote-control "hannigan-T11"
echo "started in $DIR"
echo "attach:  tmux attach -t hn-t11"
echo "record:  tmux capture-pane -p -t hn-t11 -S -200 > docs/verification/t11-remote-control-cu/pane-\$(date +%H%M%S).txt"

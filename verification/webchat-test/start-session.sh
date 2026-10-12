#!/bin/bash
# Start an interactive Claude Code session with the webchat-test development channel
# inside tmux session "chcu", so the WebChat "Esc" button (auxiliary path) can reach it.
#
# usage:
#   verification/webchat-test/start-session.sh                # localhost only (use SSH tunnel)
#   WEBCHAT_HOST=0.0.0.0 verification/webchat-test/start-session.sh   # same-LAN test
#   verification/webchat-test/start-session.sh --resume <session-id>  # T10
#
# After start, attach with:  tmux attach -t chcu
# The development-channel warning dialog must be answered in that terminal.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
EXTRA=("$@")
if tmux has-session -t chcu 2>/dev/null; then
  echo "tmux session chcu already exists; exit that Claude session first" >&2
  exit 1
fi
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
  PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TERM=xterm-256color TERM_PROGRAM="${TERM_PROGRAM:-Apple_Terminal}" LANG=ja_JP.UTF-8 \
  WEBCHAT_HOST="${WEBCHAT_HOST:-127.0.0.1}" WEBCHAT_PORT="${WEBCHAT_PORT:-8790}" \
  tmux new-session -d -s chcu -x 160 -y 48 -c "$REPO" \
  claude --permission-mode manual --dangerously-load-development-channels server:webchat-test "${EXTRA[@]}"
TOKEN="$(cat "$HOME/.claude/channels/webchat-test/token")"
echo "started. attach: tmux attach -t chcu"
echo "WebChat URL (keep private): http://<host>:${WEBCHAT_PORT:-8790}/#token=${TOKEN}"

#!/bin/bash
# Start the hub and the worker daemon of this Mac in tmux sessions (Phase 2; launchd comes in Phase 4).
# The first run creates the settings and keys (scripts/dev-setup.ts); projects are added in WebChat 設定.
# usage: scripts/start.sh [hub|worker|all]   (default: all)
# env:   HANNIGAN_HOME (default ~/.hannigan)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WHAT="${1:-all}"
HOME_DIR="${HANNIGAN_HOME:-$HOME/.hannigan}"
PREFIX="${HANNIGAN_TMUX_PREFIX:-hn}"
mkdir -p "$HOME_DIR/logs"
# first start: create hub.json / worker.json and the keys for this Mac (no projects; add them in WebChat 設定).
# dev-setup keeps every file that already exists.
if [ ! -f "$HOME_DIR/hub.json" ] || [ ! -f "$HOME_DIR/worker.json" ]; then
  echo "first start: creating settings in $HOME_DIR"
  HANNIGAN_HOME="$HOME_DIR" bun "$REPO/scripts/dev-setup.ts" --worker local --name "この Mac"
fi
start() { # name script
  local name="$PREFIX-$1"
  if tmux has-session -t "=$name" 2>/dev/null; then echo "$name already running"; return; fi
  tmux new-session -d -s "$name" -x 200 -y 50 -c "$REPO" \
    "HANNIGAN_HOME='$HOME_DIR' bun '$2' 2>&1 | tee -a '$HOME_DIR/logs/$1.log'"
  echo "started $name (log: $HOME_DIR/logs/$1.log)"
}
case "$WHAT" in
  hub) start hub "$REPO/hub/hub.ts" ;;
  worker) start worker "$REPO/worker/daemon.ts" ;;
  all) start hub "$REPO/hub/hub.ts"; sleep 1; start worker "$REPO/worker/daemon.ts" ;;
  *) echo "usage: $0 [hub|worker|all]" >&2; exit 1 ;;
esac
if [ -f "$HOME_DIR/hub.json" ] && [ -f "$HOME_DIR/secrets/webchat-token" ]; then
  PORT=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1])).get('listen',{}).get('port',8800))" "$HOME_DIR/hub.json")
  echo "WebChat (keep private): http://127.0.0.1:$PORT/#token=$(cat "$HOME_DIR/secrets/webchat-token")"
fi

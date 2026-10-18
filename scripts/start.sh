#!/bin/bash
# Start the hub and the worker daemon of this Mac in tmux sessions (Phase 2).
# When the worker is installed as a LaunchAgent (scripts/install-launchd.sh, Phase 4 WP3) launchd owns it: this script
# then only prints how to restart it, so the tmux worker and the launchd worker never run side by side.
# The first run creates the settings and keys (scripts/dev-setup.ts); projects are added in WebChat 設定.
# usage: scripts/start.sh [hub|worker|all]   (default: all; a second Mac set up with scripts/worker-setup.ts runs `worker`)
# env:   HANNIGAN_HOME (default ~/.hannigan)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WHAT="${1:-all}"
HOME_DIR="${HANNIGAN_HOME:-$HOME/.hannigan}"
PREFIX="${HANNIGAN_TMUX_PREFIX:-hn}"
LAUNCHD_LABEL=com.hannigan.worker
mkdir -p "$HOME_DIR/logs"
# first start: create hub.json / worker.json and the keys for this Mac (no projects; add them in WebChat 設定).
# dev-setup keeps every file that already exists. A worker-only Mac (scripts/worker-setup.ts; it has no hub.json)
# is complete with worker.json and secrets/worker-key, so `worker` never calls dev-setup then.
case "$WHAT" in
  worker) NEED_SETUP=$([ -f "$HOME_DIR/worker.json" ] && [ -f "$HOME_DIR/secrets/worker-key" ] && echo no || echo yes) ;;
  *) NEED_SETUP=$([ -f "$HOME_DIR/hub.json" ] && [ -f "$HOME_DIR/worker.json" ] && echo no || echo yes) ;;
esac
if [ "$NEED_SETUP" = yes ]; then
  echo "first start: creating settings in $HOME_DIR"
  HANNIGAN_HOME="$HOME_DIR" bun "$REPO/scripts/dev-setup.ts" --worker local --name "この Mac"
fi
start() { # name script
  local name="$PREFIX-$1"
  if [ "$1" = worker ] && [ -f "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" ]; then
    local domain="gui/$(id -u)"
    local state; state="$(launchctl print "$domain/$LAUNCHD_LABEL" 2>/dev/null | awk '/^\tstate =/ {print $3}')"
    echo "worker is managed by launchd ($LAUNCHD_LABEL, ${state:-not loaded}); not starting it in tmux."
    echo "  restart: launchctl kickstart -k $domain/$LAUNCHD_LABEL    back to tmux: scripts/uninstall-launchd.sh"
    return
  fi
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
# the WebChat address is only meaningful when the hub runs here
if [ "$WHAT" != worker ] && [ -f "$HOME_DIR/hub.json" ] && [ -f "$HOME_DIR/secrets/webchat-token" ]; then
  BASE=$(python3 -I -c "import json,sys;c=json.load(open(sys.argv[1]));print(c.get('public_url') or 'http://127.0.0.1:%s' % c.get('listen',{}).get('port',8800))" "$HOME_DIR/hub.json")
  echo "WebChat (keep private): $BASE/#token=$(cat "$HOME_DIR/secrets/webchat-token")"
elif [ "$WHAT" = worker ] && [ -f "$HOME_DIR/worker.json" ]; then
  HUB=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1])).get('hub_url',''))" "$HOME_DIR/worker.json")
  echo "worker only; hub: $HUB (WebChat is served by that hub)"
fi

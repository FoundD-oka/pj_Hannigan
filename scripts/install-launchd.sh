#!/bin/bash
# Phase 4 WP3 (docs/design/04-vps-deployment.md): run this Mac's worker daemon as a user LaunchAgent.
# Writes ~/Library/LaunchAgents/com.hannigan.worker.plist from deploy/launchd/com.hannigan.worker.plist and loads it:
# launchd starts `bun worker/daemon.ts` at login and restarts it when it exits (KeepAlive), so the worker comes back
# to the hub after a crash or a Mac restart. Claude Code sessions still live in tmux and survive the daemon.
# A worker started the tmux way (scripts/start.sh worker, tmux session hn-worker) is stopped first: both would bind
# the same local port and connect to the hub with the same worker id. Re-run after moving the repository or bun.
# usage: scripts/install-launchd.sh [--repo <dir>] [--home <HANNIGAN_HOME>]
#   --repo  repository the daemon runs from (default: the one this script is in). Use the main checkout, not a
#           worktree that will be removed.
#   --home  HANNIGAN_HOME for the daemon (default: $HANNIGAN_HOME or ~/.hannigan)
set -euo pipefail
LABEL=com.hannigan.worker
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # the template comes from here; the daemon runs from $REPO
REPO="$HERE"
HOME_DIR="${HANNIGAN_HOME:-$HOME/.hannigan}"
PREFIX="${HANNIGAN_TMUX_PREFIX:-hn}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$(cd "$2" && pwd)"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    *) echo "usage: $0 [--repo <dir>] [--home <HANNIGAN_HOME>]" >&2; exit 2 ;;
  esac
done
die() { echo "install-launchd: $*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || die "launchd is macOS only (the VPS hub uses deploy/systemd)"
[ -f "$REPO/worker/daemon.ts" ] || die "$REPO/worker/daemon.ts not found (pass --repo <repository>)"
[ -f "$HOME_DIR/worker.json" ] && [ -f "$HOME_DIR/secrets/worker-key" ] \
  || die "$HOME_DIR has no worker.json / secrets/worker-key yet: pair this Mac first (WebChat 設定 → ワーカーを追加)"

# programs: bun runs the daemon; claude and tmux are found through PATH by the daemon (worker.json may name them)
resolve() { # name-or-path -> absolute path, or empty
  case "$1" in */) echo "";; */*) [ -x "$1" ] && echo "$1" || echo "";; *) command -v "$1" 2>/dev/null || true;; esac
}
cfg() { python3 -I -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]) or sys.argv[3])" "$HOME_DIR/worker.json" "$1" "$2"; }
BUN="$(resolve "$(cfg bun_bin bun)")";       [ -n "$BUN" ] || die "bun not found (install bun, or set bun_bin in worker.json)"
CLAUDE="$(resolve "$(cfg claude_bin claude)")"; [ -n "$CLAUDE" ] || die "claude not found (install Claude Code, or set claude_bin in worker.json)"
TMUX="$(resolve tmux)";                      [ -n "$TMUX" ] || die "tmux not found (brew install tmux)"
PATH_VAL=""
add_dir() { local d; d="$(dirname "$1")"; case ":$PATH_VAL:" in *":$d:"*) ;; *) PATH_VAL="${PATH_VAL:+$PATH_VAL:}$d" ;; esac; }
add_dir "$BUN"; add_dir "$CLAUDE"; add_dir "$TMUX"
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_dir "$d/x"; done

mkdir -p "$HOME_DIR/logs" "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
python3 -I - "$HERE/deploy/launchd/$LABEL.plist" "$PLIST" "$BUN" "$REPO" "$HOME_DIR" "$PATH_VAL" <<'PY'
import sys
src, dst, bun, repo, home, path = sys.argv[1:7]
t = open(src, encoding='utf-8').read()
for k, v in (('__BUN__', bun), ('__REPO__', repo), ('__HANNIGAN_HOME__', home), ('__PATH__', path)):
    v = v.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    t = t.replace(k, v)
open(dst, 'w', encoding='utf-8').write(t)
PY
plutil -lint -s "$PLIST" || die "$PLIST is not a valid plist"
echo "wrote $PLIST (bun: $BUN, repo: $REPO, HANNIGAN_HOME: $HOME_DIR)"

# the tmux-style worker of scripts/start.sh must not run alongside (same local port, same worker id)
if tmux has-session -t "=$PREFIX-worker" 2>/dev/null; then
  tmux kill-session -t "=$PREFIX-worker"
  echo "stopped the tmux worker ($PREFIX-worker); from now on launchd runs it"
  sleep 1
fi

# (re)load: an older copy of the job is removed first; bootout is asynchronous, so wait until it is gone
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
  for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
sleep 2
STATE="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/^\tstate =/ {print $3} /^\tpid =/ {print "pid " $3}' | tr '\n' ' ')"
echo "loaded $LABEL: ${STATE:-not running yet}"
cat <<MSG
log:      tail -f $HOME_DIR/logs/worker.log
status:   launchctl print $DOMAIN/$LABEL | grep -E 'state|pid'
restart:  launchctl kickstart -k $DOMAIN/$LABEL
stop until next login: launchctl bootout $DOMAIN/$LABEL   (Claude Code sessions stay in tmux)
remove:   scripts/uninstall-launchd.sh
MSG

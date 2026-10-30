#!/bin/bash
# Run the Mac agent as a user LaunchAgent: it starts at login and comes back when it exits.
# Pair first: bun relay/mac-agent.ts pair https://host CODE --mac ID --cwd FOLDER
# Re-run after moving the repository or bun.
set -euo pipefail
LABEL=com.hannigan.mac-agent
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAC_HOME="${HANNIGAN_MAC_HOME:-$HOME/.hannigan-mac}"
die() { echo "install-mac-agent: $*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || die "launchd is macOS only"
[ -f "$MAC_HOME/config.json" ] && [ -f "$MAC_HOME/relay-key" ] || die "$MAC_HOME is not paired yet (bun relay/mac-agent.ts pair ...)"
BUN="$(command -v bun)" || die "bun not found"
TMUX_BIN="$(command -v tmux)" || die "tmux not found (brew install tmux)"
CLAUDE="$(command -v claude)" || die "claude not found"
PATH_VAL=""
add_dir() { case ":$PATH_VAL:" in *":$1:"*) ;; *) PATH_VAL="${PATH_VAL:+$PATH_VAL:}$1" ;; esac; }
add_dir "$(dirname "$BUN")"; add_dir "$(dirname "$CLAUDE")"; add_dir "$(dirname "$TMUX_BIN")"
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_dir "$d"; done

mkdir -p "$MAC_HOME/logs" "$HOME/Library/LaunchAgents"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
python3 -I - "$REPO/deploy/launchd/$LABEL.plist" "$PLIST" "$BUN" "$REPO" "$MAC_HOME" "$PATH_VAL" <<'PY'
import sys
src, dst, bun, repo, home, path = sys.argv[1:7]
t = open(src, encoding='utf-8').read()
for k, v in (('__BUN__', bun), ('__REPO__', repo), ('__MAC_HOME__', home), ('__PATH__', path)):
    t = t.replace(k, v.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
open(dst, 'w', encoding='utf-8').write(t)
PY
plutil -lint -s "$PLIST" || die "$PLIST is not a valid plist"

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
  for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
echo "loaded $LABEL (log: $MAC_HOME/logs/agent.log)"

#!/bin/bash
# Remove the worker LaunchAgent installed by scripts/install-launchd.sh. The daemon stops; Claude Code sessions keep
# running in tmux, and the next worker start (scripts/start.sh worker, or install-launchd.sh again) picks them up.
set -uo pipefail
LABEL=com.hannigan.worker
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" && echo "stopped $LABEL"
fi
if [ -f "$PLIST" ]; then rm -f "$PLIST" && echo "removed $PLIST"; else echo "$PLIST was not installed"; fi
echo "the worker no longer starts at login; start it by hand with scripts/start.sh worker (Claude Code sessions stayed in tmux)"

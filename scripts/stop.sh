#!/bin/bash
# Stop the hub and worker daemons. Claude Code sessions keep running in their own tmux sessions;
# add --sessions to also end them (secretary and workers) with /exit.
set -uo pipefail
PREFIX="${HANNIGAN_TMUX_PREFIX:-hn}"
for n in hub worker; do tmux kill-session -t "=$PREFIX-$n" 2>/dev/null && echo "stopped $PREFIX-$n"; done
if launchctl print "gui/$(id -u)/com.hannigan.worker" >/dev/null 2>&1; then
  echo "the launchd worker (com.hannigan.worker) keeps running; stop it with: launchctl bootout gui/$(id -u)/com.hannigan.worker"
fi
if [ "${1:-}" = "--sessions" ]; then
  for s in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^$PREFIX-" ); do
    tmux send-keys -t "=$s:" Escape; sleep 0.3; tmux send-keys -t "=$s:" -l /exit; sleep 0.3; tmux send-keys -t "=$s:" Enter
    echo "sent /exit to $s"
  done
fi

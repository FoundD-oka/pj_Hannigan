#!/bin/sh
# Opened with Terminal.app by the Mac agent. macOS gives Claude Code the Accessibility and Screen Recording of the app
# that started its tmux server, and launchd's processes have neither, so Terminal.app starts the server. The agent itself
# stays under launchd. `keepalive` holds the server open while no Claude Code session is running.
PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
export PATH
cd "$(dirname "$0")" || exit 1
./tmux-hannigan.sh has-session -t =keepalive 2>/dev/null ||
  ./tmux-hannigan.sh new-session -d -s keepalive 'while :; do sleep 86400; done'
exit 0

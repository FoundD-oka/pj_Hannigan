#!/bin/bash
# say.sh <tmux-target> <text> : type text into the Claude prompt and press Enter
tmux send-keys -t "$1" -l "$2"
sleep 0.5
tmux send-keys -t "$1" Enter
echo "sent $(date +%T)"

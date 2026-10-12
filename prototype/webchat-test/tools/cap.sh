#!/bin/bash
# cap.sh <tmux-target> <outfile>  : capture pane text with timestamp
tmux capture-pane -p -t "$1" -S -200 > "$2"
echo "captured $(date +%T) -> $2 ($(wc -l < "$2") lines)"

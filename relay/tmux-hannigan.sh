#!/bin/sh
# tmux on its own server socket for the Mac agent's Claude Code sessions. The server's first start decides which app's
# macOS permissions Claude Code inherits (docs/verification/omb-native-cu 3).
exec "${HANNIGAN_MAC_TMUX:-tmux}" -L hannigan "$@"

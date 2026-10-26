#!/bin/sh
# tmux on its own server socket, so the spike's sessions never share a server with the running worker (hn-*)
exec "${HANNIGAN_OMB_ACP_TMUX:-tmux}" -L omb-acp "$@"

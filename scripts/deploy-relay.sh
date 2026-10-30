#!/bin/bash
# Bundle the relay for Node and put it on the VPS. The Caddyfile and the systemd unit are installed separately.
# usage: scripts/deploy-relay.sh [ssh-target]   (default: root@162.43.38.222 with ~/.ssh/hannigan-vps)
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-root@162.43.38.222}"
SSH=(ssh -o BatchMode=yes -i "$HOME/.ssh/hannigan-vps")
bun build relay/server.ts --target=node --outfile=dist/relay/server.js
bun build relay/acp-client.ts --target=node --outfile=dist/relay/acp-client.js
scp -q -o BatchMode=yes -i "$HOME/.ssh/hannigan-vps" dist/relay/server.js dist/relay/acp-client.js deploy/systemd/hannigan-relay.service "$TARGET:/tmp/"
"${SSH[@]}" "$TARGET" 'set -e
install -d -o hannigan -g hannigan -m 700 /home/hannigan/hannigan-relay
install -o hannigan -g hannigan -m 644 /tmp/server.js /tmp/acp-client.js /home/hannigan/hannigan-relay/
install -o root -g root -m 644 /tmp/hannigan-relay.service /etc/systemd/system/hannigan-relay.service
rm -f /tmp/server.js /tmp/acp-client.js /tmp/hannigan-relay.service
systemctl daemon-reload
systemctl enable hannigan-relay >/dev/null 2>&1
systemctl restart hannigan-relay
sleep 1
systemctl is-active hannigan-relay'

#!/usr/bin/env bash
# Phase 4 (docs/design/04-vps-deployment.md): set up the Hannigan hub on a Linux VPS. Run as root on the VPS.
# Idempotent: every step keeps what already exists. What it does, in order (2026-10-19, Ubuntu 24.04, confirmed live):
#   1. user `hannigan` (the hub, the secretary Claude Code sessions and their tmux server run as this user; never root)
#   2. bun, Claude Code (native installer), tmux, the repository at /home/hannigan/pj-Hannigan
#   3. Claude Code first-run marks in ~/.claude.json (the theme wizard would otherwise block the first secretary)
#   4. $HANNIGAN_HOME/hub.json for a hub-only host (no worker.json: Macs pair in from outside)
#   5. systemd unit hannigan-hub.service (KillMode=process: a hub restart leaves the tmux secretaries running)
#   6. a Caddy site for the public host name -> 127.0.0.1:8800 (certificate from Let's Encrypt, automatic)
# After this: log Claude Code in as `hannigan` once (`su - hannigan -c 'tmux new -s hn-login "claude auth login"'`,
# open the URL it prints, paste the code), then pair each Mac from WebChat 設定 → ワーカーを追加.
#
# usage: vps-setup.sh --host hannigan.example.com --email you@example.com [--repo <git url>] [--port 8800]
#        [--caddy-import-into <file>]   # a Caddyfile (or its template) that should `import` the Hannigan site; default /etc/caddy/Caddyfile
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }

HOST=""; EMAIL=""; REPO="https://github.com/FoundD-oka/pj_Hannigan.git"; PORT=8800; IMPORT_INTO="/etc/caddy/Caddyfile"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --caddy-import-into) IMPORT_INTO="$2"; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[ -n "$HOST" ] && [ -n "$EMAIL" ] || { echo "usage: vps-setup.sh --host <public host name> --email <acme email> [--repo <url>] [--port 8800] [--caddy-import-into <file>]"; exit 2; }

U=hannigan; HOME_U=/home/$U; HN=$HOME_U/.hannigan
say() { echo "[vps-setup] $*"; }

# 1. user
id $U >/dev/null 2>&1 || adduser --disabled-password --gecos "Hannigan hub" $U
say "user $U ok"

# 2. tools and repository (as hannigan)
command -v tmux >/dev/null || { apt-get update -qq && apt-get install -y -qq tmux >/dev/null; }
apt-get install -y -qq unzip git curl >/dev/null 2>&1 || true
su - $U -c "set -e
  export PATH=\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH
  command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
  command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
  echo \"bun \$(bun --version), claude \$(claude --version 2>&1 | head -1), tmux \$(tmux -V)\"
  [ -d ~/pj-Hannigan ] || git clone -q '$REPO' ~/pj-Hannigan
  cd ~/pj-Hannigan && git pull -q && bun install --silent"
say "tools and repository ok"

# 3. Claude Code first-run marks (the theme wizard never gets answered inside tmux)
su - $U -c "python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude.json')
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('hasCompletedOnboarding', True)
d.setdefault('theme', 'dark-ansi')
json.dump(d, open(p, 'w'), indent=2)
print('onboarding marks ok')
PY"

# 4. hub.json (hub only)
su - $U -c "mkdir -p $HN/logs && chmod 700 $HN"
if [ ! -f $HN/hub.json ]; then
  cat > $HN/hub.json <<EOF
{
  "version": 8,
  "listen": { "host": "127.0.0.1", "port": $PORT },
  "public_url": "https://$HOST",
  "secretary": {
    "autostart": false,
    "persona": { "name": "Hannigan", "character": "", "user_name": null, "language": "", "verbosity": "short" },
    "routing_notes": "",
    "extra_instructions": "",
    "contexts": { "mode": "per_conversation", "max_active": 2 },
    "shared_ledger": { "enabled": true }
  },
  "webchat": { "conversation_scope": "conversation", "threads": { "enabled": true, "direct_send_enabled": true } },
  "offline_queue": { "enabled": true, "ttl_minutes": 1440, "max_pending_per_worker": 100 },
  "discord": { "enabled": false },
  "workers": [],
  "tmux": { "prefix": "hn" },
  "claude_bin": "$HOME_U/.local/bin/claude",
  "bun_bin": "$HOME_U/.bun/bin/bun"
}
EOF
  chown $U:$U $HN/hub.json; chmod 600 $HN/hub.json
  say "wrote $HN/hub.json"
else say "kept $HN/hub.json"; fi

# 5. systemd
sed -e "s#/home/hannigan#$HOME_U#g" $HOME_U/pj-Hannigan/deploy/systemd/hannigan-hub.service > /etc/systemd/system/hannigan-hub.service
systemctl daemon-reload
systemctl enable --now hannigan-hub.service >/dev/null
sleep 2
say "hannigan-hub.service $(systemctl is-active hannigan-hub.service)"

# 6. Caddy site (the Caddyfile that imports it is the host's own; we only add one import line if it is missing)
if command -v caddy >/dev/null; then
  sed -e "s#hannigan.found-d.com#$HOST#g" -e "s#lo.conozco@gmail.com#$EMAIL#g" -e "s#127.0.0.1:8800#127.0.0.1:$PORT#g" \
    $HOME_U/pj-Hannigan/deploy/caddy/hannigan.caddy > /etc/caddy/hannigan.caddy
  chmod 644 /etc/caddy/hannigan.caddy
  LINE="import /etc/caddy/hannigan.caddy"
  if [ -f "$IMPORT_INTO" ] && ! grep -qF "$LINE" "$IMPORT_INTO"; then
    cp "$IMPORT_INTO" "$IMPORT_INTO.bak-hannigan-$(date +%Y%m%d%H%M%S)"
    printf "\n# Hannigan (pj-Hannigan hub)\n%s\n" "$LINE" >> "$IMPORT_INTO"
    say "added '$LINE' to $IMPORT_INTO"
  fi
  if [ "$IMPORT_INTO" != /etc/caddy/Caddyfile ] && ! grep -qF "$LINE" /etc/caddy/Caddyfile; then
    printf "\n# Hannigan (pj-Hannigan hub)\n%s\n" "$LINE" >> /etc/caddy/Caddyfile
    say "added '$LINE' to /etc/caddy/Caddyfile (the live file; the template gets it for the next render)"
  fi
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy && say "caddy reloaded" \
    || say "WARNING: caddy validate failed; the live config was not reloaded (check /etc/caddy/Caddyfile by hand)"
else
  say "caddy not installed: install Caddy (https://caddyserver.com/docs/install) and import /etc/caddy/hannigan.caddy, or put another TLS proxy in front of 127.0.0.1:$PORT"
fi

say "done. next: su - $U -c 'tmux new -s hn-login \"claude auth login\"' (open the URL, paste the code), then https://$HOST/#token=\$(cat $HN/secrets/webchat-token)"

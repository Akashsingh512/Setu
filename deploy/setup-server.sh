#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (AWS Lightsail) for Setu.
# Installs Node.js, pm2 and Caddy, asks for the keys (kept only on this server),
# builds the app, serves it over HTTPS, and checks GitHub every 5 minutes for updates.
#
#   git clone https://github.com/Akashsingh512/Setu.git /tmp/setu && sudo bash /tmp/setu/deploy/setup-server.sh
#
# Safe to run again. With your own domain later (pointed at this server's IP):
#   sudo SETU_DOMAIN=crm.example.org bash /tmp/setu/deploy/setup-server.sh
set -euo pipefail

ROOT=/opt/setu
APP_USER=setu
NODE_MAJOR=24
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
as_app() { sudo -u "$APP_USER" -H "$@"; }
mask() { local v=$1; [ ${#v} -le 12 ] && echo "(${#v} characters)" || echo "${v:0:6}…${v: -4} (${#v} characters)"; }

# ask VAR "Question" [secret] [optional]
ask() {
  local __var=$1 __q=$2 __secret=${3:-} __optional=${4:-} __v
  while :; do
    if [ "$__secret" = secret ]; then read -rsp "$__q: " __v; echo; else read -rp "$__q: " __v; fi
    __v=$(printf '%s' "$__v" | tr -d '[:space:]')
    if [ -n "$__v" ] || [ "$__optional" = optional ]; then
      printf -v "$__var" '%s' "$__v"
      return
    fi
    echo "  This one is required."
  done
}

# ---------------------------------------------------------------------------
step "1/9 Extra memory (swap) so building never runs out"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

step "2/9 Installing Node.js $NODE_MAJOR, pm2 and Caddy (a few minutes)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
command -v pm2 >/dev/null || npm install -g pm2 --no-audit --no-fund >/dev/null
echo "Node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -1), $(caddy version | cut -d' ' -f1)"

step "3/9 App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$ROOT" "$ROOT/releases" "$ROOT/bin"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$ROOT/shared"

# ---------------------------------------------------------------------------
step "4/9 Keys (saved only on this server, never on GitHub)"
WEB_ENV="$ROOT/shared/web.env"
GW_ENV="$ROOT/shared/gateway.env"
keep=n
if [ -f "$WEB_ENV" ] && [ -f "$GW_ENV" ]; then
  read -rp "Keys are already saved on this server. Keep them? [Y/n] " a
  [[ "${a:-y}" =~ ^[Nn] ]] || keep=y
fi
if [ "$keep" != y ]; then
  echo "Copy each value from apps/web/.env.local and apps/wa-gateway/.env on your PC."
  echo "To paste here: right-click, or Ctrl+Shift+V. Then press Enter."
  ask SB_URL "Supabase URL (NEXT_PUBLIC_SUPABASE_URL)"
  until [[ "$SB_URL" =~ ^https://[^/]+ ]]; do
    echo "  It should look like https://abcd1234.supabase.co"
    ask SB_URL "Supabase URL"
  done
  SB_URL=${SB_URL%/}
  ask SB_PUB "Supabase publishable key (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
  ask VAPID "Web push public key (NEXT_PUBLIC_VAPID_PUBLIC_KEY) - Enter to skip" "" optional
  ask SB_SERVICE "Supabase service role key (SUPABASE_SERVICE_ROLE_KEY) - hidden while you paste" secret
  echo "  Saved service key: $(mask "$SB_SERVICE")"
  [[ "$SB_SERVICE" =~ ^(sb_secret_|eyJ) ]] || echo "  Warning: this doesn't look like a Supabase service key (they start with sb_secret_ or eyJ)."
  echo "Optional: Amazon Bedrock (AI for unclear WhatsApp messages). Press Enter to skip."
  ask AWS_REGION_V "AWS region, e.g. ap-south-1" "" optional
  BEDROCK_V="" AWS_KEY_V="" AWS_SECRET_V=""
  if [ -n "$AWS_REGION_V" ]; then
    ask BEDROCK_V "Bedrock model / inference profile id"
    ask AWS_KEY_V "AWS access key id"
    ask AWS_SECRET_V "AWS secret access key - hidden" secret
  fi

  (
    umask 077
    printf '%s\n' \
      "NEXT_PUBLIC_SUPABASE_URL=$SB_URL" \
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$SB_PUB" \
      "NEXT_PUBLIC_VAPID_PUBLIC_KEY=$VAPID" >"$WEB_ENV"
    printf '%s\n' \
      "SUPABASE_URL=$SB_URL" \
      "SUPABASE_SERVICE_ROLE_KEY=$SB_SERVICE" \
      "LOG_LEVEL=info" \
      "AWS_REGION=$AWS_REGION_V" \
      "BEDROCK_MODEL_ID=$BEDROCK_V" \
      "AWS_ACCESS_KEY_ID=$AWS_KEY_V" \
      "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_V" >"$GW_ENV"
  )
  chown "$APP_USER:$APP_USER" "$WEB_ENV" "$GW_ENV"
  chmod 600 "$WEB_ENV" "$GW_ENV"
fi

# ---------------------------------------------------------------------------
step "5/9 HTTPS address"
if [ -n "${SETU_DOMAIN:-}" ]; then
  HOST=$SETU_DOMAIN
else
  IP=$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')
  HOST="${IP//./-}.sslip.io" # free name that points at this IP; no domain needed
fi
echo "$HOST" >"$ROOT/shared/host"
chown "$APP_USER:$APP_USER" "$ROOT/shared/host"
cat >/etc/caddy/Caddyfile <<EOF
# Written by deploy/setup-server.sh. Caddy gets and renews the HTTPS certificate itself.
$HOST {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
echo "Address: https://$HOST"

# ---------------------------------------------------------------------------
step "6/9 Building Setu (5-10 minutes the first time)"
install -o "$APP_USER" -g "$APP_USER" -m 755 "$HERE/deploy.sh" "$ROOT/bin/deploy.sh"
install -o root -g root -m 755 "$HERE/setu-cli.sh" /usr/local/bin/setu
# Start pm2 (and the apps it runs) when the server boots.
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
if ! as_app "$ROOT/bin/deploy.sh" --force; then
  echo
  echo "The build failed. Show the details with:  tail -n 80 $ROOT/deploy.log"
  exit 1
fi
# Keep pm2 log files small.
as_app pm2 install pm2-logrotate >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true

step "7/9 Automatic updates from GitHub every 5 minutes"
cat >/etc/systemd/system/setu-deploy.service <<EOF
[Unit]
Description=Setu: deploy new commits from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$APP_USER
ExecStart=$ROOT/bin/deploy.sh
TimeoutStartSec=30min
Nice=10
EOF
cat >/etc/systemd/system/setu-deploy.timer <<EOF
[Unit]
Description=Setu: check GitHub for updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now setu-deploy.timer >/dev/null 2>&1

# ---------------------------------------------------------------------------
step "8/9 WhatsApp gateway"
if [ -f "$ROOT/shared/gateway.enabled" ]; then
  echo "Already running on this server."
else
  echo "Only ONE gateway may run at a time. Stop the one on your PC first (Ctrl+C in its window)."
  read -rp "Is it stopped, and should it run on this server now? [y/N] " a
  if [[ "${a:-n}" =~ ^[Yy] ]]; then
    setu gateway-on >/dev/null
    echo "Gateway started. WhatsApp reconnects by itself (no new QR scan)."
  else
    echo "Not started. Later, run:  setu gateway-on"
  fi
fi

# ---------------------------------------------------------------------------
step "9/9 Checking the public address"
ok=n
for _ in $(seq 1 12); do
  if curl -fsS -o /dev/null --max-time 10 "https://$HOST/login"; then ok=y; break; fi
  sleep 5
done
echo
if [ "$ok" = y ]; then
  printf '\033[1;32mSetu is live:  https://%s\033[0m\n' "$HOST"
else
  echo "Setu is running, but https://$HOST did not answer yet."
  echo "Check that the Lightsail firewall allows HTTPS (port 443) and HTTP (port 80),"
  echo "then wait a minute: the certificate is issued on the first visit. Details: journalctl -u caddy -n 50"
fi
cat <<EOF

Next:
  1. Supabase > Authentication > URL Configuration:
       Site URL:       https://$HOST
       Redirect URLs:  add  https://$HOST/**
  2. Open https://$HOST and sign in.

Everyday commands:  setu status | setu logs gateway | setu update | setu help
EOF

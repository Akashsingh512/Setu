#!/usr/bin/env bash
# Everyday commands for the Setu server (installed as /usr/local/bin/setu).
set -euo pipefail

ROOT=/opt/setu
as_app() { sudo -u setu -H "$@"; }
ECO="$ROOT/current/deploy/ecosystem.config.cjs"

case "${1:-help}" in
  status)
    as_app pm2 status
    echo "Address : https://$(cat "$ROOT/shared/host" 2>/dev/null)"
    echo "Version : $(cut -c1-12 "$ROOT/current/.release-sha" 2>/dev/null || echo none)"
    echo "Gateway : $([ -f "$ROOT/shared/gateway.enabled" ] && echo 'on (this server)' || echo 'off here')"
    [ -f "$ROOT/shared/failed-sha" ] && echo "Last update FAILED for $(cut -c1-12 "$ROOT/shared/failed-sha"): see 'setu deploy-log'"
    ;;
  logs)
    # Ctrl+C to stop watching.
    as_app pm2 logs "setu-${2:-gateway}" --lines "${3:-100}"
    ;;
  deploy-log)
    tail -n "${2:-60}" "$ROOT/deploy.log"
    ;;
  update)
    # Build and switch to the latest GitHub version now (normally automatic every 5 minutes).
    as_app "$ROOT/bin/deploy.sh" --force
    ;;
  restart)
    as_app pm2 restart "setu-${2:-web}"
    ;;
  gateway-on)
    echo "Only ONE gateway may run anywhere. Make sure the one on your PC is stopped."
    as_app touch "$ROOT/shared/gateway.enabled"
    as_app pm2 startOrRestart "$ECO" --only setu-gateway
    as_app pm2 save --force
    ;;
  gateway-off)
    as_app rm -f "$ROOT/shared/gateway.enabled"
    as_app pm2 delete setu-gateway 2>/dev/null || true
    as_app pm2 save --force
    ;;
  settings)
    # setu settings gateway  -> Supabase service key, Bedrock keys (then restarts the gateway)
    # setu settings web      -> public Supabase/VAPID values (then rebuilds the site)
    which=${2:-gateway}
    as_app "${EDITOR:-nano}" "$ROOT/shared/$which.env"
    if [ "$which" = web ]; then as_app "$ROOT/bin/deploy.sh" --force; else as_app pm2 restart setu-gateway 2>/dev/null || true; fi
    ;;
  *)
    cat <<'EOF'
setu status            what is running, the address, the version
setu logs [web|gateway] watch the logs (Ctrl+C to stop)
setu deploy-log        the last automatic updates
setu update            update to the latest GitHub version now
setu restart [web|gateway]
setu gateway-on        run the WhatsApp gateway on this server
setu gateway-off       stop it here (e.g. to run it elsewhere)
setu settings [gateway|web]  edit keys, then restart/rebuild
EOF
    ;;
esac

#!/usr/bin/env bash
# Builds the latest commit of GitHub "main" and switches the server to it - but only
# if it is new, it builds, and the site then answers. Otherwise the running version
# stays (or is put back). Run every 5 minutes by the setu-deploy timer as the "setu"
# user; "setu update" runs it with --force (rebuild even if nothing changed).
set -euo pipefail

ROOT=/opt/setu
REPO_URL=${SETU_REPO_URL:-https://github.com/Akashsingh512/Setu.git}
BRANCH=${SETU_BRANCH:-main}
KEEP=3                       # builds kept on disk (the running one is never removed)
LOG="$ROOT/deploy.log"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

exec 9>"$ROOT/deploy.lock"
flock -n 9 || exit 0         # a deploy is already running

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5000000 ]; then
  tail -n 3000 "$LOG" >"$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
fi

latest=$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)
[ -n "$latest" ] || { log "Could not reach GitHub; will try again later."; exit 1; }
running=$(cat "$ROOT/current/.release-sha" 2>/dev/null || true)
if [ "$FORCE" = 0 ]; then
  [ "$latest" = "$running" ] && exit 0
  # A commit that failed once is not retried every 5 minutes; a new push (or --force) tries again.
  [ "$latest" = "$(cat "$ROOT/shared/failed-sha" 2>/dev/null || true)" ] && exit 0
fi

rel="$ROOT/releases/$(date -u +%Y%m%d%H%M%S)-${latest:0:12}"
fail() {
  log "FAILED ($1). ${2:-The site keeps running the previous version.} Details in $LOG"
  echo "$latest" >"$ROOT/shared/failed-sha"
  [ "${3:-}" = keep ] || rm -rf "$rel"
  exit 1
}

log "Building ${latest:0:12}..."
git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$rel" >>"$LOG" 2>&1 || fail "download"
latest=$(git -C "$rel" rev-parse HEAD) # main may have moved since the check above
echo "$latest" >"$rel/.release-sha"
cp "$ROOT/shared/web.env" "$rel/apps/web/.env.production.local" || fail "settings file missing"

cd "$rel"
export NEXT_TELEMETRY_DISABLED=1
# Only the web app and gateway (no test or mobile tools). Install scripts are not
# needed by any package here, so none are run.
npm ci --workspace @crm/web --workspace @crm/wa-gateway --include-workspace-root \
  --ignore-scripts --no-audit --no-fund >>"$LOG" 2>&1 || fail "install"
npm run build -w @crm/web >>"$LOG" 2>&1 || fail "build"

# Switch atomically, restart, and check the site answers; if not, switch back.
previous=""
[ -L "$ROOT/current" ] && previous=$(readlink -f "$ROOT/current")
switch_to() {
  ln -sfn "$1" "$ROOT/current.tmp" && mv -Tf "$ROOT/current.tmp" "$ROOT/current"
  local apps=(setu-web)
  [ -f "$ROOT/shared/gateway.enabled" ] && apps+=(setu-gateway)
  for app in "${apps[@]}"; do
    # A failure here shows up in the health check below, which switches back.
    pm2 startOrRestart "$ROOT/current/deploy/ecosystem.config.cjs" --only "$app" --update-env >>"$LOG" 2>&1 || true
  done
}
healthy() {
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3000/login && return 0
    sleep 2
  done
  return 1
}

switch_to "$rel"
if ! healthy; then
  if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$rel" ]; then
    log "New version did not start; switching back to $(cut -c1-12 "$previous/.release-sha" 2>/dev/null)."
    switch_to "$previous"
    fail "start"
  fi
  # Nothing to go back to (first install): keep the build so the logs can be checked.
  fail "start" "The site is not running yet: see 'setu logs web'." keep
fi
pm2 save --force >>"$LOG" 2>&1
rm -f "$ROOT/shared/failed-sha"
log "Live: ${latest:0:12}"

# Keep this script up to date (rename, so the copy running now is not modified).
cp "$rel/deploy/deploy.sh" "$ROOT/bin/deploy.sh.new" && chmod 755 "$ROOT/bin/deploy.sh.new" && mv -f "$ROOT/bin/deploy.sh.new" "$ROOT/bin/deploy.sh"

# Remove old builds, never the running one.
live=$(readlink -f "$ROOT/current")
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$live" ] || rm -rf "$old"
done

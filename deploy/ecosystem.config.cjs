// pm2 processes on the Lightsail server (see docs/DEPLOY_LIGHTSAIL.md).
// Paths go through /opt/setu/current, which deploy.sh points at each new build.
// Both run node directly (interpreter "none"), so stop signals reach the app itself:
// the gateway uses them to report "disconnected" before exiting.
const ROOT = '/opt/setu';
const node = process.execPath; // the node that runs pm2 (/usr/bin/node)

module.exports = {
  apps: [
    {
      name: 'setu-web',
      cwd: `${ROOT}/current/apps/web`,
      script: node,
      interpreter: 'none',
      // Only reachable from this machine: Caddy serves it publicly over HTTPS.
      args: [`${ROOT}/current/node_modules/next/dist/bin/next`, 'start', '-p', '3000', '-H', '127.0.0.1'],
      env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
      max_memory_restart: '700M',
      kill_timeout: 10000,
    },
    {
      // Only one gateway may run anywhere: deploy.sh starts this only when
      // /opt/setu/shared/gateway.enabled exists (setu gateway-on / gateway-off).
      name: 'setu-gateway',
      cwd: `${ROOT}/current/apps/wa-gateway`,
      script: node,
      interpreter: 'none',
      args: [`--env-file=${ROOT}/shared/gateway.env`, '--import', 'tsx', 'src/index.ts'],
      max_memory_restart: '500M',
      kill_timeout: 10000,
      // Wait longer between restarts if it keeps crashing (e.g. a wrong key), instead of a tight loop.
      exp_backoff_restart_delay: 2000,
    },
  ],
};

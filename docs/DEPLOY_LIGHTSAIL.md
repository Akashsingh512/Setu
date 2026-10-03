# Hosting Setu on AWS Lightsail

One small server runs everything except the database:

```
Browser / phone ──HTTPS──▶ Caddy (certificate, port 443) ──▶ Setu web app (Next.js, pm2)
                                                              WhatsApp gateway (pm2) ──▶ WhatsApp
                    both talk to Supabase (database, logins, storage) - unchanged
```

- **No domain needed**: the address is `https://<your-ip-with-dashes>.sslip.io`, a free name that points at the
  server's IP. Caddy gets and renews the HTTPS certificate by itself. A real domain can be added later.
- **Updates are automatic**: every 5 minutes the server checks GitHub `main`. A new commit is built next to the running
  version and switched to only if it builds and answers; otherwise the old version keeps running (or is put back).
- **Keys stay on the server** (`/opt/setu/shared/*.env`, readable only by the app), never on GitHub.

Why not Amplify: Amplify Hosting supports Next.js up to version 15; Setu uses Next.js 16 (`proxy.ts`, streaming).

## 1. Create the server (Lightsail console)

1. **Create instance** → Region **Mumbai (ap-south-1)** → **Linux/Unix** → **Operating system (OS) only** →
   **Ubuntu 24.04 LTS** → plan **2 GB RAM** → name `setu` → **Create instance**.
2. Open the instance → **Networking** tab:
   - **Attach static IP** (create one). Without it the IP, and so the address, changes when the server restarts.
     Do this *before* step 2.
   - **IPv4 Firewall** → **Add rule** → **HTTPS** (port 443). SSH (22) and HTTP (80) are already allowed.

## 2. Run the setup (once)

Click **Connect using SSH** (opens a terminal in the browser) and paste:

```bash
git clone https://github.com/Akashsingh512/Setu.git /tmp/setu && sudo bash /tmp/setu/deploy/setup-server.sh
```

It installs Node.js, pm2 and Caddy, then asks for the keys. Copy them from your PC:

| Asked for | Where to find it |
|---|---|
| Supabase URL, publishable key, web push public key | `apps/web/.env.local` |
| Supabase service role key | `apps/wa-gateway/.env` (or Supabase → Project Settings → API keys → secret) |
| Bedrock region / model / keys (optional) | see [DIGITAL_VOLUNTEER.md](DIGITAL_VOLUNTEER.md#enabling-bedrock-optional) |

To paste in the browser terminal: right-click, or **Ctrl+Shift+V**. The first build takes 5-10 minutes.

When it asks about the **WhatsApp gateway**: first stop the gateway on your PC (Ctrl+C in its window). **Only one
gateway may run at a time**, or the two keep disconnecting each other. The WhatsApp login is stored in Supabase, so the
server reconnects without a new QR scan.

At the end it prints the address, e.g. `https://13-233-45-67.sslip.io`.

## 3. Tell Supabase the new address

Supabase → **Authentication** → **URL Configuration**:

- **Site URL**: `https://<your address>`
- **Redirect URLs**: add `https://<your address>/**` (keep `http://localhost:3000/**` for local development)

Then open the address, sign in, and check **Digital Volunteer → Overview → Checks**.

## Everyday commands

Connect using SSH, then:

| Command | Does |
|---|---|
| `setu status` | what is running, the address, the live version |
| `setu logs gateway` / `setu logs web` | watch the logs (Ctrl+C to stop) |
| `setu deploy-log` | the last automatic updates (and why one failed) |
| `setu update` | update to the latest GitHub version now |
| `setu restart web` / `setu restart gateway` | restart one part |
| `setu settings gateway` | edit the gateway keys (e.g. add Bedrock), then it restarts |
| `setu settings web` | edit the public Supabase values, then it rebuilds |
| `setu gateway-on` / `setu gateway-off` | run the WhatsApp gateway here, or stop it here |

Everything starts again by itself after a reboot.

## Notes

- **Re-running the setup** is safe (it keeps the saved keys unless you choose to replace them). Do it if the IP changed,
  or to switch to your own domain: point the domain's DNS A record at the static IP, then
  `sudo SETU_DOMAIN=crm.example.org bash /tmp/setu/deploy/setup-server.sh` (clone again first if `/tmp` was cleared),
  and update the Supabase URLs.
- **Cost**: the 2 GB plan is about $12/month after any free trial; Supabase is unchanged.
- **Files**: builds in `/opt/setu/releases` (last 3 kept), the live one at `/opt/setu/current`, logs in
  `/opt/setu/deploy.log` and `~setu/.pm2/logs`.

## Moving to Render later

1. **Web app**: Render → New → **Web Service** from this repository. Build command
   `npm ci --workspace @crm/web --include-workspace-root && npm run build -w @crm/web`, start command
   `npm run start -w @crm/web`, and the three `NEXT_PUBLIC_*` environment variables.
2. **Gateway**: `render.yaml` describes a background worker. Run `setu gateway-off` here **before** starting it there.
3. Update the Supabase URLs to the Render address, then delete the Lightsail instance and its static IP
   (an unattached static IP is charged).

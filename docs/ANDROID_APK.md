# Android APK – Setu CRM

The Setu CRM Android app is a thin **Capacitor 7** shell: a WebView that loads the
live hosted web app. It contains no bundled application code — the full Next.js app
runs on the server and is rendered inside the Android WebView.

## Quick start

### 1. Run the workflow

1. Go to **Actions → Build Android APK (Setu CRM)** in the GitHub repo.
2. Click **Run workflow**.
3. *(Optional)* Override the **server URL** if the app has moved to a new host.
4. The workflow also runs automatically on pushes to `main` that change files in
   `apps/mobile/` or the workflow file itself.

### 2. Download the APK

After the workflow finishes:

| Method | Where |
|--------|-------|
| **GitHub Releases** | Go to the repo's **Releases** page → find the latest `v1.0.<N>` release → download `Setu-1.0.<N>.apk`. This is the easiest way to share the link with volunteers. |
| **Workflow artifacts** | Open the workflow run → **Artifacts** section → download `Setu-Android-APK-<N>.zip`. |

### 3. Install on a phone

1. Transfer the `.apk` file to the Android phone (download directly, AirDrop, email,
   Google Drive, etc.).
2. Open the file. Android will ask you to allow **installing unknown apps** from that
   source — enable it.
3. Tap **Install**, then **Open**.
4. You'll see the Setu login screen. Sign in with your Supabase credentials.

> **Minimum Android version:** 6.0+ (API 23). Tested on Android 12–14.

---

## How it works

```
┌─────────────────────────┐
│  Android APK (Capacitor)│
│  ┌───────────────────┐  │
│  │     WebView        │  │
│  │  loads server.url  │──┼──▶  https://3-108-61-69.sslip.io
│  └───────────────────┘  │
└─────────────────────────┘
```

- **`apps/mobile/capacitor.config.ts`** contains `server.url` — the URL the WebView
  loads on startup.
- `server.allowNavigation` restricts in-WebView navigation to the app's own host.
- External links (WhatsApp, phone dialer, Google Maps) open in their native apps
  because they are outside `allowNavigation`.

---

## Changing the server URL

When the app moves from Lightsail to Render (or anywhere else):

1. **For one-off testing:** Run the workflow manually and type the new URL in the
   `server_url` input field.
2. **Permanently:** Edit `apps/mobile/capacitor.config.ts` — change the default URL
   in the fallback string:
   ```ts
   const serverUrl =
     process.env.SETU_SERVER_URL || "https://your-new-url.example.com";
   ```
   Push to `main`; the workflow will rebuild the APK automatically.

---

## Release signing (optional)

Debug APKs are installable via side-loading, but Google Play requires a signed release
build. The workflow supports this via optional repository secrets.

### Create a keystore

```bash
keytool -genkeypair \
  -v \
  -keystore setu-release.keystore \
  -alias setu \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass YOUR_STORE_PASSWORD \
  -keypass YOUR_KEY_PASSWORD \
  -dname "CN=Setu CRM, OU=Art of Living, O=Art of Living Foundation, L=Bangalore, S=Karnataka, C=IN"
```

### Add the secrets to GitHub

| Secret name | Value |
|-------------|-------|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 setu-release.keystore` (the full base64 string) |
| `ANDROID_KEYSTORE_PASSWORD` | The store password you used above |
| `ANDROID_KEY_ALIAS` | `setu` (or whatever alias you chose) |
| `ANDROID_KEY_PASSWORD` | The key password you used above |

Once all four secrets are set, the workflow will automatically build **both** a debug
and a signed release APK. The release APK will appear as
`Setu-1.0.<N>-release.apk` in the release assets.

> ⚠️ **Never commit the `.keystore` file or passwords to the repository.**

---

## Project structure

```
apps/mobile/
├── capacitor.config.ts       # Capacitor config (server URL, app ID, etc.)
├── package.json              # @capacitor/core, @capacitor/android, @capacitor/app
├── www/
│   └── index.html            # Fallback "Loading…" page (required by Capacitor)
└── scripts/
    └── generate-icons.sh     # Resizes icon-512.png into Android mipmap densities
```

The `android/` directory is generated in CI by `npx cap add android` and is
git-ignored.

---

## External link behavior

| Link type | Example | Behavior |
|-----------|---------|----------|
| App navigation | `/leads`, `/dashboard` | Stays inside WebView ✅ |
| Phone (tel:) | `tel:+91...` | Opens phone dialer 📞 |
| WhatsApp | `https://wa.me/91...` | Opens WhatsApp app 💬 |
| Google Maps | `https://maps.google.com/...` | Opens Maps app 🗺️ |
| Supabase storage | `*.supabase.co/storage/...` | Opens in external browser 🌐 |

This works because `server.allowNavigation` is set to only the app's own host.
Capacitor opens all other URLs in the device's default handler.

---

## Known limitations

### Web push notifications
Web push notifications **do not work** inside an Android WebView. In-app
notifications (toasts, banners rendered by the web app) still display normally.
Native push notifications via Firebase / `@capacitor/push-notifications` are a
**separate future task** — they are not included in this build.

### Offline lead capture
The `/capture` page relies on a service worker for offline support. Service worker
behavior inside a Capacitor WebView varies by Android version and device:
- On **Android 12+** with the WebView updated to ≥ Chrome 100, the service worker
  generally registers and caches assets after the first online visit.
- On **older devices**, service worker support in WebView may be limited or absent.

> This is a known platform limitation. The web app itself has not been modified to
> address it — the offline behavior inside the WebView should be tested on target
> devices and reported.

---

## Updating the app

To release a new version:
1. Make changes under `apps/mobile/` and push to `main`, **or**
2. Go to Actions and manually run the workflow.

Each run produces a unique version (`1.0.<run_number>`) and a matching GitHub Release.
Old releases are preserved for rollback.

---

## Permissions

The app requests only the **INTERNET** permission (Capacitor default). No camera,
contacts, location, or storage permissions are requested.

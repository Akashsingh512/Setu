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

## Release signing (required for updates)

Android installs an update over an existing app **only if both are signed with the same key**.
So every published APK is signed with one release key, kept as repository secrets:

- **With the secrets** the workflow builds a signed release APK and publishes it as a GitHub
  Release (`Setu-1.0.<N>.apk`). Installed apps offer it as an update.
- **Without them** it builds a debug APK as a workflow artifact for testing (`-debug.apk`) and
  publishes nothing. Debug builds can never update, or be updated by, a release build.

> ⚠️ **Back up the key.** If the keystore or its password is lost, no future version can be
> installed over the apps people already have: everyone would have to uninstall and reinstall.
> Keep a copy somewhere safe (e.g. a password manager or an encrypted drive), never in the repo.

### The key

The Setu release key was created once on the maintainer's PC, in
`C:\Users\Lenovo\setu-android-signing\` (`setu-release.p12`, alias `setu`, valid until 2056).
To create a new one elsewhere (only for a brand-new app; it can't update apps signed with the old key):

```bash
export MSYS_NO_PATHCONV=1   # Git Bash on Windows only
openssl req -x509 -newkey rsa:2048 -sha256 -days 10950 -nodes -keyout key.pem -out cert.pem -subj "/CN=Setu/O=Art of Living Setu/C=IN"
openssl pkcs12 -export -inkey key.pem -in cert.pem -name setu -out setu-release.p12 -passout "pass:YOUR_PASSWORD"
rm key.pem
base64 -w0 setu-release.p12 > keystore-base64.txt
```

### The secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `keystore-base64.txt` |
| `ANDROID_KEYSTORE_PASSWORD` | the password |
| `ANDROID_KEY_ALIAS` | `setu` |
| `ANDROID_KEY_PASSWORD` | the same password (a PKCS12 key uses the store password) |

---

## Project structure

```
apps/mobile/
├── capacitor.config.ts       # Capacitor config (server URL, app ID, etc.)
├── package.json              # @capacitor/core, @capacitor/android, @capacitor/app
├── www/index.html            # Fallback "Loading…" page (required by Capacitor)
├── scripts/generate-icons.sh # Resizes icon-512.png into Android mipmap densities
└── android/                  # The native Android project (committed)
    └── app/src/main/java/org/artofliving/setu/
        ├── MainActivity.java   # Capacitor activity; runs the update check on resume
        └── UpdateChecker.java  # "Update available" dialog, download and install
```

`android/` is committed because it holds native code. CI runs `npx cap sync android`, which
writes the server URL and plugins into it; generated files there stay git-ignored.

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

**Most changes need no new APK.** The app loads the live website, so web changes reach every
phone as soon as the server updates. A new APK is only needed when the app shell changes
(icon, name, permissions, native code, the server URL).

### Publishing a new version

1. Push a change under `apps/mobile/` to `main`, or run the workflow by hand (Actions →
   *Build Android APK* → *Run workflow*).
2. The run becomes version `1.0.<run number>` and is published as Release `v1.0.<run number>`.
3. To make it **required** (people can't postpone it), tick *Make this update required* when
   running by hand. That writes the line `required: true` into the release notes; you can also
   add or remove that line by editing the release on GitHub.

### What people see

When Setu opens (and at most every 6 hours while it's used), it checks the latest Release. If
its number is higher than the installed build, an **Update available** dialog shows the version
and the release notes:

- **Update** downloads the signed APK (with a progress notification) and opens Android's
  installer, which installs it over the old app. The first time, Android asks to allow Setu to
  install apps; the dialog explains this and opens the right settings screen.
- **Later** hides that version until a newer one comes out (not offered for required updates).
- If anything fails (no internet, GitHub busy), nothing is shown; it tries again later. If the
  download fails, the APK opens in the browser instead.

> Apps installed from the early **debug** builds (v1.0.4, v1.0.5) are signed with a different
> key, so they can't update to signed releases. Uninstall them once and install the latest
> release; from then on updates work in place.

---

## Permissions

- **INTERNET** - to load Setu.
- **REQUEST_INSTALL_PACKAGES** - so Setu can offer its own updates. Android still asks the
  person to confirm every install.

No camera, contacts, location, or storage permissions are requested.

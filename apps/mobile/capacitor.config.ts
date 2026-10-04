import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Setu CRM – Capacitor shell configuration.
 *
 * The APK is a thin WebView wrapper that loads the live hosted web-app.
 * Change SETU_SERVER_URL in one place (here or via the CI workflow input)
 * when the hosting URL changes (e.g. after moving to Render).
 */

const serverUrl =
  process.env.SETU_SERVER_URL || "https://3-108-61-69.sslip.io";

const host = new URL(serverUrl).host; // e.g. "3-108-61-69.sslip.io"

const config: CapacitorConfig = {
  appId: "org.artofliving.setu",
  appName: "Setu",
  webDir: "www",

  server: {
    url: serverUrl,
    cleartext: false, // HTTPS only
    allowNavigation: [host],
    androidScheme: "https",
  },

  android: {
    backgroundColor: "#1a1a2e",
  },
};

export default config;

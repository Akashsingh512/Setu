package org.artofliving.setu;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * "Update available" for the side-loaded Setu APK.
 *
 * The newest version is the latest GitHub Release of this repository: tag v1.0.N,
 * where N is the build number (= the app's versionCode), with the signed APK attached.
 * If N is higher than the installed versionCode, a dialog offers to download it and
 * hands the file to Android's installer. Android installs it over the old app only
 * because every release is signed with the same key (see docs/ANDROID_APK.md).
 *
 * A release whose notes contain the line "required: true" can't be postponed.
 * Any failure (no internet, GitHub limits, odd data) just means: no dialog this time.
 */
final class UpdateChecker {
    private static final String LATEST_RELEASE = "https://api.github.com/repos/Akashsingh512/Setu/releases/latest";
    private static final String DOWNLOAD_PREFIX = "https://github.com/Akashsingh512/Setu/releases/download/";
    private static final long CHECK_EVERY_MS = 6L * 60 * 60 * 1000;
    private static final String PREFS = "setu_updates";
    private static final String APK_NAME = "Setu-update.apk";

    private static boolean checkedThisLaunch = false;
    private static boolean dialogShowing = false;
    /** Set while the user is in Settings allowing "install unknown apps". */
    private static String pendingDownloadUrl = null;
    private static long downloadId = -1;

    private UpdateChecker() {}

    /** Called from MainActivity.onResume: on every app start, then at most every 6 hours. */
    static void onResume(Activity activity) {
        if (pendingDownloadUrl != null && canInstall(activity)) {
            String url = pendingDownloadUrl;
            pendingDownloadUrl = null;
            startDownload(activity, url);
            return;
        }
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (checkedThisLaunch && now - prefs.getLong("last_check", 0) < CHECK_EVERY_MS) return;
        checkedThisLaunch = true;
        prefs.edit().putLong("last_check", now).apply();

        new Thread(() -> {
            try {
                Release latest = fetchLatest();
                long installed = installedVersionCode(activity);
                if (latest == null || latest.versionCode <= installed) return;
                if (!latest.required && prefs.getLong("skipped_version", -1) == latest.versionCode) return;
                new Handler(Looper.getMainLooper()).post(() -> showDialog(activity, latest, installed));
            } catch (Exception ignored) {
                // An update check must never disturb the app.
            }
        }, "setu-update-check").start();
    }

    private static final class Release {
        long versionCode;
        String versionName;
        String apkUrl;
        String notes;
        boolean required;
    }

    private static Release fetchLatest() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(LATEST_RELEASE).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "Setu-Android");
        try {
            if (c.getResponseCode() != 200) return null;
            JSONObject json = new JSONObject(readAll(c.getInputStream()));
            Matcher m = Pattern.compile("^v?\\d+\\.\\d+\\.(\\d+)$").matcher(json.optString("tag_name"));
            if (!m.matches()) return null;
            Release r = new Release();
            r.versionCode = Long.parseLong(m.group(1));
            r.versionName = json.optString("tag_name").replaceFirst("^v", "");
            String body = json.optString("body", "");
            r.required = Pattern.compile("(?im)^\\s*required:\\s*true\\s*$").matcher(body).find();
            r.notes = body.replaceAll("(?im)^\\s*required:\\s*true\\s*$", "").replaceAll("[#*`>]", "").trim();
            JSONArray assets = json.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                String name = a.optString("name");
                String url = a.optString("browser_download_url");
                // Only the signed APK from this repository's releases.
                if (name.endsWith(".apk") && !name.contains("debug") && url.startsWith(DOWNLOAD_PREFIX)) {
                    r.apkUrl = url;
                    break;
                }
            }
            return r.apkUrl == null ? null : r;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static long installedVersionCode(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
    }

    private static void showDialog(Activity activity, Release r, long installed) {
        if (dialogShowing || activity.isFinishing()) return;
        String notes = r.notes.length() > 300 ? r.notes.substring(0, 300) + "…" : r.notes;
        String message = "Version " + r.versionName + " of Setu is ready (you have build " + installed + ")."
                + (r.required ? "\n\nThis update is required to keep using the app." : "")
                + (notes.isEmpty() ? "" : "\n\n" + notes);
        AlertDialog.Builder b = new AlertDialog.Builder(activity)
                .setTitle("Update available")
                .setMessage(message)
                .setCancelable(!r.required)
                .setPositiveButton("Update", (d, w) -> {
                    dialogShowing = false;
                    beginUpdate(activity, r.apkUrl);
                });
        if (!r.required) {
            b.setNegativeButton("Later", (d, w) -> {
                dialogShowing = false;
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("skipped_version", r.versionCode).apply();
            });
        }
        b.setOnDismissListener(d -> dialogShowing = false);
        dialogShowing = true;
        b.show();
    }

    private static boolean canInstall(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
    }

    private static void beginUpdate(Activity activity, String url) {
        if (canInstall(activity)) {
            startDownload(activity, url);
            return;
        }
        // Android asks once per app: allow Setu to install its own updates.
        new AlertDialog.Builder(activity)
                .setTitle("Allow updates")
                .setMessage("To install the update, allow Setu to install apps on the next screen, then come back.")
                .setPositiveButton("Continue", (d, w) -> {
                    pendingDownloadUrl = url;
                    try {
                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName())));
                    } catch (Exception e) {
                        pendingDownloadUrl = null;
                        openInBrowser(activity, url);
                    }
                })
                .setNegativeButton("Download in browser", (d, w) -> openInBrowser(activity, url))
                .show();
    }

    private static void startDownload(Activity activity, String url) {
        try {
            File dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File apk = new File(dir, APK_NAME);
            if (apk.exists()) //noinspection ResultOfMethodCallIgnored
                apk.delete();
            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("Setu update")
                    .setDescription("Downloading the new version of Setu")
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, APK_NAME);
            downloadId = dm.enqueue(req);
            Context app = activity.getApplicationContext();
            BroadcastReceiver done = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -2) != downloadId) return;
                    app.unregisterReceiver(this);
                    if (succeeded(dm, downloadId) && apk.exists()) install(activity, apk);
                    else openInBrowser(activity, url);
                }
            };
            ContextCompat.registerReceiver(app, done, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED);
            Toast.makeText(activity, "Downloading the update…", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            openInBrowser(activity, url);
        }
    }

    private static boolean succeeded(DownloadManager dm, long id) {
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            return c != null && c.moveToFirst()
                    && c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)) == DownloadManager.STATUS_SUCCESSFUL;
        }
    }

    private static void install(Activity activity, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(activity, "Open the downloaded Setu update from your notifications to install it.", Toast.LENGTH_LONG).show();
        }
    }

    private static void openInBrowser(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
            // No browser at all: nothing more we can do.
        }
    }
}

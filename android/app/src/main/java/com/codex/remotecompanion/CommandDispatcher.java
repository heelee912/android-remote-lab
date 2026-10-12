package com.codex.remotecompanion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;
import android.os.SystemClock;

import org.json.JSONObject;

final class CommandDispatcher {
    private final Context context;
    private final DisplayLease displayLease;

    CommandDispatcher(Context context, DisplayLease displayLease) {
        this.context = context;
        this.displayLease = displayLease;
    }

    JSONObject dispatch(String command, JSONObject args) throws Exception {
        if ("release_lease".equals(command)) {
            displayLease.release();
            return new JSONObject().put("released", true);
        }
        if ("ping".equals(command)) {
            return new JSONObject().put("pong", true).put("leaseRemainingMillis", displayLease.remainingMillis());
        }
        if ("diagnostics".equals(command)) {
            return RendezvousService.diagnostics(context)
                    .put("leaseRemainingMillis", displayLease.remainingMillis());
        }

        if ("wake".equals(command)) {
            // Display-only wake never dismisses or authenticates any keyguard.
            assertConnectionReady();
            boolean before = DeviceReadiness.interactive(context);
            long duration = displayLease.renew(args.optLong("leaseMillis", 120_000L));
            try { awaitInteractive(); }
            catch (Exception error) { displayLease.release(); throw error; }
            return DeviceReadiness.add(context, new JSONObject()
                    .put("leaseMillis", duration).put("alreadyInteractive", before));
        }
        assertTransportReady();
        boolean alreadyInteractive = DeviceReadiness.interactive(context);
        if (DeviceReadiness.secureLocked(context)) {
            throw new SecurityException("Secure keyguard is locked");
        }
        long lease = displayLease.renew(args.optLong("leaseMillis", 120_000L));
        try {
            awaitDisplayReady();
        } catch (Exception error) {
            displayLease.release();
            throw error;
        }
        if ("lease".equals(command)) {
            return DeviceReadiness.add(context, new JSONObject()
                    .put("leaseMillis", lease).put("alreadyInteractive", alreadyInteractive));
        }

        ControlAccessibilityService accessibility = ControlAccessibilityService.getInstance();

        switch (command) {
            case "status":
                return accessibility.status().put("leaseRemainingMillis", displayLease.remainingMillis());
            case "snapshot":
                return accessibility.snapshot();
            case "global":
                return performed(
                        accessibility.performGlobal(args.getString("action")),
                        "Global action");
            case "tap":
                return performed(
                        accessibility.tap(
                                (float) args.getDouble("x"),
                                (float) args.getDouble("y"),
                                2000L),
                        "Tap");
            case "swipe":
                return performed(
                        accessibility.swipe(
                                (float) args.getDouble("startX"),
                                (float) args.getDouble("startY"),
                                (float) args.getDouble("endX"),
                                (float) args.getDouble("endY"),
                                args.optLong("durationMillis", 350L)),
                        "Swipe");
            case "click":
                return performed(
                        accessibility.click(args.getJSONObject("selector")),
                        "Click");
            case "set_text":
                return performed(
                        accessibility.setText(
                                args.getJSONObject("selector"),
                                args.getString("text")),
                        "Text input");
            case "launch": {
                boolean launched = launch(args.getString("packageName"));
                if (!launched) throw new IllegalStateException("Package launch was rejected");
                return new JSONObject().put("launched", true);
            }
            case "screenshot": {
                JSONObject before = accessibility.status();
                String base64 = accessibility.screenshotPngBase64();
                JSONObject after = accessibility.status();
                return new JSONObject()
                        .put("mimeType", "image/png")
                        .put("base64", base64)
                        .put("activeWindowBefore", before)
                        .put("activeWindowAfter", after);
            }
            case "install_begin":
                return ApkInstaller.begin(
                        context,
                        args.getLong("sizeBytes"),
                        args.getString("sha256"),
                        args.optString("fileName", "app.apk"));
            case "install_chunk":
                return ApkInstaller.append(
                        context,
                        args.getString("uploadId"),
                        args.getLong("offset"),
                        args.getString("base64"),
                        args.getString("chunkSha256"));
            case "install_commit":
                return ApkInstaller.commit(context, args.getString("uploadId"));
            case "install_status":
                return ApkInstaller.status(context, args.optString("uploadId", ""));
            default:
                throw new IllegalArgumentException("Unsupported command: " + command);
        }
    }

    private void awaitInteractive() {
        long deadline = SystemClock.elapsedRealtime() + 3000L;
        while (!DeviceReadiness.interactive(context) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(25L);
        if (!DeviceReadiness.interactive(context)) throw new IllegalStateException("Display wake timed out");
    }

    private void awaitDisplayReady() {
        awaitInteractive();
        long deadline = SystemClock.elapsedRealtime() + 3000L;
        if (DeviceReadiness.secureLocked(context)) throw new SecurityException("Secure keyguard is locked");
        if (DeviceReadiness.keyguardShowing(context)) {
            Intent wake = new Intent(context, WakeActivity.class);
            wake.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            context.startActivity(wake);
            while (DeviceReadiness.keyguardShowing(context) && SystemClock.elapsedRealtime() < deadline) {
                if (DeviceReadiness.secureLocked(context)) throw new SecurityException("Secure keyguard is locked");
                SystemClock.sleep(25L);
            }
        }
        if (DeviceReadiness.keyguardShowing(context)) throw new IllegalStateException("Keyguard dismissal timed out");
    }

    private void assertTransportReady() {
        UserManager users = (UserManager) context.getSystemService(Context.USER_SERVICE);
        if (users == null || !users.isUserUnlocked()) {
            throw new SecurityException("Android user storage is locked");
        }
        assertConnectionReady();
        if (ControlAccessibilityService.getInstance() == null) {
            throw new IllegalStateException("Accessibility service is not enabled or not bound");
        }
    }

    private void assertConnectionReady() {
        if (!RendezvousService.hasValidatedVpn(context)) throw new SecurityException("Validated VPN is unavailable");
    }

    private JSONObject performed(boolean value, String operation) throws Exception {
        if (!value) throw new IllegalStateException(operation + " was not performed");
        return new JSONObject().put("performed", true);
    }

    private boolean launch(String packageName) {
        if (!packageName.matches("[A-Za-z0-9_.]{3,200}")) {
            return false;
        }
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent == null) {
            return false;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(intent);
        return true;
    }
}

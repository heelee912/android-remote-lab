package com.codex.remotecompanion;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.UserManager;
import android.os.SystemClock;

import org.json.JSONObject;

final class CommandDispatcher {
    private final Context context;
    private final DisplayLease displayLease;
    private final TvRemoteControl tvRemoteControl;
    private final PrivilegedShellChannel privilegedShell;
    private final BankingCompatibility bankingCompatibility;

    CommandDispatcher(Context context, DisplayLease displayLease) {
        this(context, displayLease, new TvRemoteControl(context));
    }

    CommandDispatcher(Context context, DisplayLease displayLease, TvRemoteControl tvRemoteControl) {
        this.context = context;
        this.displayLease = displayLease;
        this.tvRemoteControl = tvRemoteControl;
        this.privilegedShell = new PrivilegedShellChannel(context);
        this.bankingCompatibility = new BankingCompatibility(context, privilegedShell);
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
        if (command.startsWith("privileged_shell_") || command.startsWith("banking_compatibility_")) {
            // Both capability stores live in device-protected storage and are required
            // before the first unlock to close a bounded ADB window safely.
            assertConnectionReady();
            switch (command) {
                case "privileged_shell_prepare": return privilegedShell.prepare();
                case "privileged_shell_status": return privilegedShell.status();
                case "privileged_shell_exec":
                    return privilegedShell.execute(
                            args.getJSONArray("argv"),
                            args.has("stdinBase64") ? args.getString("stdinBase64") : null,
                            args.optLong("timeoutMillis", 60_000L));
                case "banking_compatibility_status": return bankingCompatibility.status();
                case "banking_compatibility_enable": return bankingCompatibility.enable();
                case "banking_compatibility_disable": return bankingCompatibility.disable();
                case "banking_compatibility_bootstrap_window": return bankingCompatibility.openBootstrapWindow();
                case "banking_compatibility_close_bootstrap_window": return bankingCompatibility.closeBootstrapWindow();
                default: throw new IllegalArgumentException("Unsupported privileged command");
            }
        }
        if (command.startsWith("tv_remote_")) {
            assertUserStorageReady();
            assertConnectionReady();
            switch (command) {
                case "tv_remote_status": return tvRemoteControl.status();
                case "tv_remote_pair_start": return tvRemoteControl.beginPairing();
                case "tv_remote_pair_finish": return tvRemoteControl.finishPairing(args.getString("code"));
                case "tv_remote_press": return tvRemoteControl.press(args.getString("key"));
                default: throw new IllegalArgumentException("Unsupported TV remote command");
            }
        }

        if (command.startsWith("install_")) {
            assertUserStorageReady();
            assertConnectionReady();
            switch (command) {
                case "install_begin":
                    return ApkInstaller.begin(context, args.getLong("sizeBytes"),
                            args.getString("sha256"), args.optString("fileName", "app.apk"));
                case "install_chunk":
                    return ApkInstaller.append(context, args.getString("uploadId"),
                            args.getLong("offset"), args.getString("base64"),
                            args.getString("chunkSha256"));
                case "install_commit":
                    return ApkInstaller.commit(context, args.getString("uploadId"));
                case "install_status":
                    return ApkInstaller.status(context, args.optString("uploadId", ""));
                default:
                    throw new IllegalArgumentException("Unsupported command: " + command);
            }
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
                        accessibility.performGlobal(args.getString("action"), args.optString("expectedPackage", null)),
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
            default:
                throw new IllegalArgumentException("Unsupported command: " + command);
        }
    }

    private void awaitInteractive() {
        long deadline = SystemClock.elapsedRealtime() + 3000L;
        long activityAt = SystemClock.elapsedRealtime() + 750L;
        boolean activityRequested = false;
        while (!DeviceReadiness.interactive(context) && SystemClock.elapsedRealtime() < deadline) {
            if (!activityRequested && SystemClock.elapsedRealtime() >= activityAt) {
                startWakeActivity();
                activityRequested = true;
            }
            SystemClock.sleep(25L);
        }
        if (!DeviceReadiness.interactive(context)) throw new IllegalStateException("Display wake timed out");
    }

    private void startWakeActivity() {
        Intent wake = new Intent(context, WakeActivity.class);
        wake.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        context.startActivity(wake);
    }

    private void awaitDisplayReady() {
        awaitInteractive();
        long deadline = SystemClock.elapsedRealtime() + 3000L;
        if (DeviceReadiness.secureLocked(context)) throw new SecurityException("Secure keyguard is locked");
        if (DeviceReadiness.keyguardShowing(context)) {
            startWakeActivity();
            while (DeviceReadiness.keyguardShowing(context) && SystemClock.elapsedRealtime() < deadline) {
                if (DeviceReadiness.secureLocked(context)) throw new SecurityException("Secure keyguard is locked");
                SystemClock.sleep(25L);
            }
        }
        if (DeviceReadiness.keyguardShowing(context)) throw new IllegalStateException("Keyguard dismissal timed out");
    }

    private void assertTransportReady() {
        assertUserStorageReady();
        assertConnectionReady();
        if (ControlAccessibilityService.getInstance() == null) {
            throw new IllegalStateException("Accessibility service is not enabled or not bound");
        }
    }

    private void assertUserStorageReady() {
        UserManager users = (UserManager) context.getSystemService(Context.USER_SERVICE);
        if (users == null || !users.isUserUnlocked()) {
            throw new SecurityException("Android user storage is locked");
        }
    }

    private void assertConnectionReady() {
        if (!RendezvousService.hasValidatedInternet(context)) throw new IllegalStateException("Internet connection is unavailable");
    }

    private JSONObject performed(boolean value, String operation) throws Exception {
        if (!value) throw new IllegalStateException(operation + " was not performed");
        return new JSONObject().put("performed", true);
    }

    private boolean launch(String packageName) {
        if (!packageName.matches("[A-Za-z0-9_.]{3,200}")) {
            return false;
        }
        PackageManager packages = context.getPackageManager();
        boolean television = packages.hasSystemFeature(PackageManager.FEATURE_LEANBACK);
        Intent intent = television
                ? packages.getLeanbackLaunchIntentForPackage(packageName)
                : packages.getLaunchIntentForPackage(packageName);
        if (intent == null) {
            intent = television
                    ? packages.getLaunchIntentForPackage(packageName)
                    : packages.getLeanbackLaunchIntentForPackage(packageName);
        }
        if (intent == null) {
            return false;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(intent);
        return true;
    }
}

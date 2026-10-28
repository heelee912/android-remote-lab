package com.codex.remotecompanion;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

/** Restarts Android's wireless ADB controller when a settings write cannot start it. */
final class WirelessDebuggingUiRecovery {
    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String SYSTEM_UI_PACKAGE = "com.android.systemui";

    static boolean canAttempt(Context context) {
        if (context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || DeviceReadiness.secureLocked(context)
                || ControlAccessibilityService.getInstance() == null) return false;
        ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = connectivity == null ? null : connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = active == null ? null : connectivity.getNetworkCapabilities(active);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    static void enable(Context context) throws Exception {
        ControlAccessibilityService accessibility = ControlAccessibilityService.getInstance();
        if (accessibility == null) throw new IllegalStateException("Accessibility is unavailable");
        boolean wasDark = !DeviceReadiness.interactive(context);
        DisplayLease temporaryLease = new DisplayLease(context);
        try {
            temporaryLease.renew(30_000L);
            awaitUnlockedDisplay(context);
            if (allowNetworkDialog(accessibility)) return;

            Intent developerOptions = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
            developerOptions.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            context.startActivity(developerOptions);
            awaitSettings(accessibility);
            SystemClock.sleep(250L);

            for (int page = 0; page < 8; page++) {
                JSONObject snapshot = accessibility.snapshot();
                if (!SETTINGS_PACKAGE.equals(accessibility.status().optString("packageName"))) {
                    throw new IllegalStateException("Developer settings lost foreground");
                }
                JSONObject wirelessSwitch = wirelessSwitch(snapshot.optJSONArray("nodes"));
                if (wirelessSwitch != null) {
                    if (wirelessSwitch.optBoolean("checked")) {
                        tap(accessibility, wirelessSwitch);
                        SystemClock.sleep(300L);
                        wirelessSwitch = wirelessSwitch(accessibility.snapshot().optJSONArray("nodes"));
                        if (wirelessSwitch == null || wirelessSwitch.optBoolean("checked")) {
                            throw new IllegalStateException("Wireless debugging did not turn off");
                        }
                    }
                    tap(accessibility, wirelessSwitch);
                    long dialogDeadline = SystemClock.elapsedRealtime() + 2_000L;
                    while (SystemClock.elapsedRealtime() < dialogDeadline
                            && !allowNetworkDialog(accessibility)) {
                        SystemClock.sleep(100L);
                    }
                    return;
                }
                JSONArray nodes = snapshot.optJSONArray("nodes");
                JSONObject root = nodes == null ? null : nodes.optJSONObject(0);
                if (root == null) throw new IllegalStateException("Developer settings tree is empty");
                int width = root.optInt("right") - root.optInt("left");
                int height = root.optInt("bottom") - root.optInt("top");
                if (width <= 0 || height <= 0 || !accessibility.swipe(
                        width * 0.75f, height * 0.82f, width * 0.75f, height * 0.25f, 350L)) {
                    throw new IllegalStateException("Developer settings could not scroll");
                }
                SystemClock.sleep(150L);
            }
            throw new IllegalStateException("Wireless debugging control was not found");
        } finally {
            if (wasDark) accessibility.performGlobal("lock_screen", null);
            temporaryLease.release();
        }
    }

    private static void awaitUnlockedDisplay(Context context) {
        long started = SystemClock.elapsedRealtime();
        long deadline = started + 5_000L;
        boolean activityStarted = false;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (DeviceReadiness.secureLocked(context)) {
                throw new IllegalStateException("Secure keyguard prevents wireless debugging recovery");
            }
            if (DeviceReadiness.interactive(context) && !DeviceReadiness.keyguardShowing(context)) return;
            if (!activityStarted && SystemClock.elapsedRealtime() - started >= 500L) {
                Intent wake = new Intent(context, WakeActivity.class);
                wake.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
                context.startActivity(wake);
                activityStarted = true;
            }
            SystemClock.sleep(50L);
        }
        throw new IllegalStateException("Display did not unlock for wireless debugging recovery");
    }

    private static void awaitSettings(ControlAccessibilityService accessibility) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 4_000L;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (SETTINGS_PACKAGE.equals(accessibility.status().optString("packageName"))) return;
            SystemClock.sleep(100L);
        }
        throw new IllegalStateException("Developer settings did not open");
    }

    private static JSONObject wirelessSwitch(JSONArray nodes) {
        if (nodes == null) return null;
        JSONObject label = null;
        for (int index = 0; index < nodes.length(); index++) {
            JSONObject node = nodes.optJSONObject(index);
            if (node == null || !SETTINGS_PACKAGE.equals(node.optString("packageName"))) continue;
            String text = node.optString("text").trim();
            if ("무선 디버깅".equals(text) || "Wireless debugging".equalsIgnoreCase(text)) {
                label = node;
                break;
            }
        }
        if (label == null) return null;
        int labelCenter = (label.optInt("top") + label.optInt("bottom")) / 2;
        int maximumDistance = Math.max(100, 2 * (label.optInt("bottom") - label.optInt("top")));
        JSONObject nearest = null;
        int nearestDistance = Integer.MAX_VALUE;
        for (int index = 0; index < nodes.length(); index++) {
            JSONObject node = nodes.optJSONObject(index);
            if (node == null || !node.optString("className").contains("Switch")
                    || !node.optBoolean("clickable") || node.optInt("left") <= label.optInt("right")
                    || node.optInt("bottom") <= node.optInt("top")) continue;
            int distance = Math.abs((node.optInt("top") + node.optInt("bottom")) / 2 - labelCenter);
            if (distance <= maximumDistance && distance < nearestDistance) {
                nearest = node;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    private static boolean allowNetworkDialog(ControlAccessibilityService accessibility) throws Exception {
        JSONArray nodes;
        try {
            nodes = accessibility.snapshot().optJSONArray("nodes");
        } catch (IllegalStateException changingWindow) {
            return false;
        }
        if (nodes == null || !SYSTEM_UI_PACKAGE.equals(accessibility.status().optString("packageName"))) return false;
        boolean wirelessDialog = false;
        JSONObject checkbox = null;
        JSONObject allow = null;
        for (int index = 0; index < nodes.length(); index++) {
            JSONObject node = nodes.optJSONObject(index);
            if (node == null) continue;
            String text = node.optString("text");
            if (text.contains("Allow wireless debugging on this network")
                    || (text.contains("무선 디버깅") && text.contains("네트워크"))) wirelessDialog = true;
            if (node.optString("className").contains("CheckBox")) checkbox = node;
            if ("Allow".equals(text) || "허용".equals(text)) allow = node;
        }
        if (!wirelessDialog) return false;
        if (checkbox != null && !checkbox.optBoolean("checked")) {
            tap(accessibility, checkbox);
            SystemClock.sleep(100L);
        }
        if (allow == null) throw new IllegalStateException("Wireless debugging approval button is missing");
        tap(accessibility, allow);
        return true;
    }

    private static void tap(ControlAccessibilityService accessibility, JSONObject node) throws Exception {
        int left = node.optInt("left");
        int top = node.optInt("top");
        int right = node.optInt("right");
        int bottom = node.optInt("bottom");
        if (right <= left || bottom <= top || !accessibility.tap((left + right) / 2f,
                (top + bottom) / 2f, 1500L)) {
            throw new IllegalStateException("Wireless debugging control did not accept a tap");
        }
    }

    private WirelessDebuggingUiRecovery() { }
}

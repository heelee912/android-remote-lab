package com.codex.remotecompanion;

import android.content.Context;
import android.content.Intent;

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

        long lease = displayLease.renew(args.optLong("leaseMillis", 120_000L));
        if ("lease".equals(command)) {
            return new JSONObject().put("leaseMillis", lease);
        }
        if ("ping".equals(command)) {
            return new JSONObject().put("pong", true).put("leaseRemainingMillis", displayLease.remainingMillis());
        }
        if ("diagnostics".equals(command)) {
            return RendezvousService.diagnostics(context)
                    .put("leaseRemainingMillis", displayLease.remainingMillis());
        }

        ControlAccessibilityService accessibility = ControlAccessibilityService.getInstance();
        if (accessibility == null) {
            throw new IllegalStateException("Accessibility service is not enabled or not bound");
        }

        switch (command) {
            case "status":
                return accessibility.status().put("leaseRemainingMillis", displayLease.remainingMillis());
            case "snapshot":
                return accessibility.snapshot();
            case "global":
                return new JSONObject().put("performed", accessibility.performGlobal(args.getString("action")));
            case "tap":
                return new JSONObject().put("performed", accessibility.tap(
                        (float) args.getDouble("x"),
                        (float) args.getDouble("y"),
                        2000L));
            case "swipe":
                return new JSONObject().put("performed", accessibility.swipe(
                        (float) args.getDouble("startX"),
                        (float) args.getDouble("startY"),
                        (float) args.getDouble("endX"),
                        (float) args.getDouble("endY"),
                        args.optLong("durationMillis", 350L)));
            case "click":
                return new JSONObject().put("performed", accessibility.click(args.getJSONObject("selector")));
            case "set_text":
                return new JSONObject().put("performed", accessibility.setText(
                        args.getJSONObject("selector"),
                        args.getString("text")));
            case "launch":
                return new JSONObject().put("launched", launch(args.getString("packageName")));
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

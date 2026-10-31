package com.codex.remotecompanion;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

import org.json.JSONObject;

/** Owns the reversible Android settings transition used while banking apps run. */
final class BankingCompatibility {
    private static final String PREFERENCES = "banking-compatibility";
    private static final String ENABLED = "enabled";
    private static final String ORIGINAL_ADB = "original-adb";
    private static final String ORIGINAL_WIRELESS = "original-wireless";
    private static final String ORIGINAL_DEVELOPMENT = "original-development";

    private final Context context;
    private final PrivilegedShellChannel shell;

    BankingCompatibility(Context context, PrivilegedShellChannel shell) {
        this.context = context.createDeviceProtectedStorageContext();
        this.shell = shell;
    }

    JSONObject enable() throws Exception {
        assertCanChangeSettings();
        SharedPreferences preferences = preferences();
        if (!preferences.getBoolean(ENABLED, false)) {
            preferences.edit()
                    .putInt(ORIGINAL_ADB, read("adb_enabled"))
                    .putInt(ORIGINAL_WIRELESS, read("adb_wifi_enabled"))
                    .putInt(ORIGINAL_DEVELOPMENT, read("development_settings_enabled"))
                    .putBoolean(ENABLED, true)
                    .commit();
        }
        try {
            write("adb_wifi_enabled", 0);
            write("development_settings_enabled", 0);
            write("adb_enabled", 0);
        } catch (Throwable error) {
            restoreSavedSettings();
            preferences.edit().putBoolean(ENABLED, false).commit();
            throw error;
        }
        return status().put("changed", true);
    }

    JSONObject disable() throws Exception {
        assertCanChangeSettings();
        if (!preferences().getBoolean(ENABLED, false)) return status().put("changed", false);
        restoreSavedSettings();
        preferences().edit().putBoolean(ENABLED, false).commit();
        return status().put("changed", true);
    }

    JSONObject openBootstrapWindow() throws Exception {
        assertCanChangeSettings();
        if (!preferences().getBoolean(ENABLED, false)) return status().put("bootstrapOpened", false);
        write("development_settings_enabled", 1);
        write("adb_enabled", 1);
        return status().put("bootstrapOpened", true);
    }

    JSONObject closeBootstrapWindow() throws Exception {
        assertCanChangeSettings();
        if (!preferences().getBoolean(ENABLED, false)) return status().put("bootstrapClosed", false);
        write("adb_wifi_enabled", 0);
        write("development_settings_enabled", 0);
        write("adb_enabled", 0);
        return status().put("bootstrapClosed", true);
    }

    JSONObject status() throws Exception {
        JSONObject broker = shell.status();
        boolean enabled = preferences().getBoolean(ENABLED, false);
        String foregroundPackage = null;
        ControlAccessibilityService accessibility = ControlAccessibilityService.getInstance();
        if (accessibility != null) foregroundPackage = accessibility.status().optString("packageName", null);
        return new JSONObject()
                .put("enabled", enabled)
                .put("adbEnabled", read("adb_enabled") != 0)
                .put("wirelessEnabled", read("adb_wifi_enabled") != 0)
                .put("developmentSettingsEnabled", read("development_settings_enabled") != 0)
                .put("shellReady", broker.optBoolean("ready"))
                .put("shellUid", broker.optInt("uid", -1))
                .put("foregroundPackage", foregroundPackage == null ? JSONObject.NULL : foregroundPackage)
                .put("screenInteractive", DeviceReadiness.interactive(context))
                .put("debugWindowClosed", enabled && read("adb_enabled") == 0);
    }

    private void restoreSavedSettings() throws Exception {
        SharedPreferences preferences = preferences();
        write("development_settings_enabled", preferences.getInt(ORIGINAL_DEVELOPMENT, 1));
        write("adb_enabled", preferences.getInt(ORIGINAL_ADB, 1));
        write("adb_wifi_enabled", preferences.getInt(ORIGINAL_WIRELESS, 0));
    }

    private int read(String name) {
        return Settings.Global.getInt(context.getContentResolver(), name, 0);
    }

    private void write(String name, int value) throws Exception {
        if (!Settings.Global.putInt(context.getContentResolver(), name, value) || read(name) != value) {
            throw new IllegalStateException("Android rejected setting " + name);
        }
    }

    private void assertCanChangeSettings() {
        if (context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS)
                != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("WRITE_SECURE_SETTINGS is required");
        }
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}

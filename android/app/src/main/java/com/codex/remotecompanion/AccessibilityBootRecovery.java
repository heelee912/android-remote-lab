package com.codex.remotecompanion;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

/** Restores an explicitly opted-in accessibility service after TV startup. */
final class AccessibilityBootRecovery {
    private static final String PREFERENCES = "accessibility-boot-recovery";
    private static final String ENABLED = "enabled";

    private AccessibilityBootRecovery() { }

    static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(ENABLED, false);
    }

    static boolean canRestore(Context context) {
        return context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                == PackageManager.PERMISSION_GRANTED;
    }

    static void setEnabled(Context context, boolean enabled) {
        if (enabled && !canRestore(context)) {
            throw new IllegalStateException("WRITE_SECURE_SETTINGS is required");
        }
        if (enabled && ControlAccessibilityService.getInstance() == null) {
            throw new IllegalStateException("Enable Remote Companion accessibility first");
        }
        if (!preferences(context).edit().putBoolean(ENABLED, enabled).commit()) {
            throw new IllegalStateException("Could not save accessibility recovery preference");
        }
    }

    static boolean restoreIfMissing(Context context) {
        if (!isEnabled(context) || !canRestore(context)) return false;
        String component = new ComponentName(context, ControlAccessibilityService.class)
                .flattenToString();
        String current = Settings.Secure.getString(context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        boolean listed = false;
        if (current != null) {
            for (String item : current.split(":")) {
                if (component.equals(item)) {
                    listed = true;
                    break;
                }
            }
        }
        int globallyEnabled = Settings.Secure.getInt(context.getContentResolver(),
                Settings.Secure.ACCESSIBILITY_ENABLED, 0);
        if (listed && globallyEnabled == 1) return false;
        if (!listed) {
            String updated = current == null || current.isEmpty()
                    ? component : current + ":" + component;
            if (!Settings.Secure.putString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, updated)) {
                throw new IllegalStateException("Android rejected accessibility service recovery");
            }
        }
        if (!Settings.Secure.putInt(context.getContentResolver(),
                Settings.Secure.ACCESSIBILITY_ENABLED, 1)) {
            throw new IllegalStateException("Android rejected accessibility recovery");
        }
        return true;
    }

    private static SharedPreferences preferences(Context context) {
        return context.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}

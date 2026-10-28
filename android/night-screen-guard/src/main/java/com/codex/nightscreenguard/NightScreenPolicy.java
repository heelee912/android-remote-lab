package com.codex.nightscreenguard;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

import java.time.LocalTime;

final class NightScreenPolicy {
    static final int DEFAULT_START_MINUTE = 23 * 60;
    static final int DEFAULT_END_MINUTE = 8 * 60;
    private static final int NIGHT_TIMEOUT_MS = 30_000;
    private static final String THEATER_MODE = "theater_mode_on";
    private static final String CHARGING_INFO = "charging_info_always";
    private static final String PREFERENCES = "night_screen_policy";

    private NightScreenPolicy() {
    }

    static SharedPreferences preferences(Context context) {
        return context.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static boolean hasPermission(Context context) {
        return context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                == PackageManager.PERMISSION_GRANTED;
    }

    static void synchronize(Context context) {
        SharedPreferences state = preferences(context);
        boolean enabled = state.getBoolean("enabled", false);
        boolean active = state.getBoolean("active", false);
        if (!enabled && !active) return;
        if (!hasPermission(context)) {
            throw new IllegalStateException("WRITE_SECURE_SETTINGS is required");
        }

        LocalTime now = LocalTime.now();
        int nowMinute = now.getHour() * 60 + now.getMinute();
        int startMinute = state.getInt("startMinute", DEFAULT_START_MINUTE);
        int endMinute = state.getInt("endMinute", DEFAULT_END_MINUTE);
        boolean protect = enabled && inWindow(nowMinute, startMinute, endMinute);
        if (protect) {
            if (!active) {
                boolean saved = state.edit().putBoolean("active", true)
                        .putInt("originalTheater", Settings.Global.getInt(
                                context.getContentResolver(), THEATER_MODE, 0))
                        .putInt("originalTimeout", Settings.System.getInt(
                                context.getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT,
                                NIGHT_TIMEOUT_MS))
                        .putInt("originalChargingInfo", Settings.System.getInt(
                                context.getContentResolver(), CHARGING_INFO, 1))
                        .commit();
                if (!saved) throw new IllegalStateException("Could not save original screen settings");
            }
            putGlobal(context, THEATER_MODE, 1);
            putSystem(context, Settings.System.SCREEN_OFF_TIMEOUT, NIGHT_TIMEOUT_MS);
            putSystem(context, CHARGING_INFO, 0);
            return;
        }

        if (!active) return;
        if (Settings.Global.getInt(context.getContentResolver(), THEATER_MODE, 0) == 1) {
            putGlobal(context, THEATER_MODE, state.getInt("originalTheater", 0));
        }
        if (Settings.System.getInt(context.getContentResolver(),
                Settings.System.SCREEN_OFF_TIMEOUT, 0) == NIGHT_TIMEOUT_MS) {
            putSystem(context, Settings.System.SCREEN_OFF_TIMEOUT,
                    state.getInt("originalTimeout", NIGHT_TIMEOUT_MS));
        }
        if (Settings.System.getInt(context.getContentResolver(), CHARGING_INFO, 1) == 0) {
            putSystem(context, CHARGING_INFO, state.getInt("originalChargingInfo", 1));
        }
        boolean cleared = state.edit().remove("active").remove("originalTheater")
                .remove("originalTimeout").remove("originalChargingInfo").commit();
        if (!cleared) throw new IllegalStateException("Could not clear restored screen settings");
    }

    static boolean inWindow(int nowMinute, int startMinute, int endMinute) {
        if (startMinute == endMinute) return false;
        if (startMinute < endMinute) return nowMinute >= startMinute && nowMinute < endMinute;
        return nowMinute >= startMinute || nowMinute < endMinute;
    }

    private static void putGlobal(Context context, String key, int value) {
        if (Settings.Global.getInt(context.getContentResolver(), key, Integer.MIN_VALUE) == value) return;
        if (!Settings.Global.putInt(context.getContentResolver(), key, value)) {
            throw new IllegalStateException("Could not change global setting " + key);
        }
    }

    private static void putSystem(Context context, String key, int value) {
        if (Settings.System.getInt(context.getContentResolver(), key, Integer.MIN_VALUE) == value) return;
        if (!Settings.System.putInt(context.getContentResolver(), key, value)) {
            throw new IllegalStateException("Could not change system setting " + key);
        }
    }
}

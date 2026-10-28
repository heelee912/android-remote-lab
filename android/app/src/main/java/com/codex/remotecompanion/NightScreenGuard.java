package com.codex.remotecompanion;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.provider.Settings;

import java.time.LocalTime;

final class NightScreenGuard {
    private static final String PREFERENCES = "night_screen_guard";
    private static final String ENABLED = "arlab_night_screen_guard_enabled";
    private static final String START_MINUTE = "arlab_night_screen_guard_start_minute";
    private static final String END_MINUTE = "arlab_night_screen_guard_end_minute";
    private static final String THEATER_MODE = "theater_mode_on";
    private static final int NIGHT_TIMEOUT_MS = 60_000;

    private NightScreenGuard() {
    }

    static void synchronize(Context context) {
        Context storage = context.createDeviceProtectedStorageContext();
        SharedPreferences state = storage.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        boolean enabled = Settings.Global.getInt(context.getContentResolver(), ENABLED, 0) == 1;
        boolean active = state.getBoolean("active", false);
        if (!enabled && !active) return;
        if (context.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS")
                != PackageManager.PERMISSION_GRANTED) {
            throw new IllegalStateException("Night screen guard requires WRITE_SECURE_SETTINGS");
        }

        int startMinute = configuredMinute(context, START_MINUTE, 23 * 60);
        int endMinute = configuredMinute(context, END_MINUTE, 8 * 60);
        LocalTime now = LocalTime.now();
        int nowMinute = now.getHour() * 60 + now.getMinute();
        boolean night = enabled && isWithinWindow(nowMinute, startMinute, endMinute);
        if (night) {
            if (!active) {
                int originalTheater = Settings.Global.getInt(context.getContentResolver(), THEATER_MODE, 0);
                int originalTimeout = Settings.System.getInt(context.getContentResolver(),
                        Settings.System.SCREEN_OFF_TIMEOUT, NIGHT_TIMEOUT_MS);
                state.edit().putBoolean("active", true)
                        .putInt("originalTheater", originalTheater)
                        .putInt("originalTimeout", originalTimeout).apply();
            }
            if (Settings.Global.getInt(context.getContentResolver(), THEATER_MODE, 0) != 1) {
                if (!Settings.Global.putInt(context.getContentResolver(), THEATER_MODE, 1)) {
                    throw new IllegalStateException("Could not enable theater mode");
                }
            }
            if (Settings.System.getInt(context.getContentResolver(),
                    Settings.System.SCREEN_OFF_TIMEOUT, 0) != NIGHT_TIMEOUT_MS) {
                if (!Settings.System.putInt(context.getContentResolver(),
                        Settings.System.SCREEN_OFF_TIMEOUT, NIGHT_TIMEOUT_MS)) {
                    throw new IllegalStateException("Could not set night screen timeout");
                }
            }
            return;
        }

        if (!active) return;
        if (Settings.Global.getInt(context.getContentResolver(), THEATER_MODE, 0) == 1) {
            if (!Settings.Global.putInt(context.getContentResolver(), THEATER_MODE,
                    state.getInt("originalTheater", 0))) {
                throw new IllegalStateException("Could not restore theater mode");
            }
        }
        if (Settings.System.getInt(context.getContentResolver(),
                Settings.System.SCREEN_OFF_TIMEOUT, 0) == NIGHT_TIMEOUT_MS) {
            if (!Settings.System.putInt(context.getContentResolver(),
                    Settings.System.SCREEN_OFF_TIMEOUT,
                    state.getInt("originalTimeout", NIGHT_TIMEOUT_MS))) {
                throw new IllegalStateException("Could not restore screen timeout");
            }
        }
        state.edit().clear().apply();
    }

    static boolean isWithinWindow(int nowMinute, int startMinute, int endMinute) {
        if (startMinute == endMinute) return false;
        if (startMinute < endMinute) return nowMinute >= startMinute && nowMinute < endMinute;
        return nowMinute >= startMinute || nowMinute < endMinute;
    }

    private static int configuredMinute(Context context, String key, int defaultMinute) {
        int value = Settings.Global.getInt(context.getContentResolver(), key, defaultMinute);
        return value >= 0 && value < 24 * 60 ? value : defaultMinute;
    }
}

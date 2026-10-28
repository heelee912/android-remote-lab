package com.codex.nightscreenguard;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

final class ScreenGuardScheduler {
    static final String ALARM_ACTION = "com.codex.nightscreenguard.APPLY";

    private ScreenGuardScheduler() {
    }

    static void schedule(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) throw new IllegalStateException("Alarm service unavailable");
        Intent intent = new Intent(context, ScreenGuardReceiver.class).setAction(ALARM_ACTION);
        PendingIntent pending = PendingIntent.getBroadcast(context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        alarms.cancel(pending);

        SharedPreferences preferences = NightScreenPolicy.preferences(context);
        if (!preferences.getBoolean("enabled", false)) return;
        int startMinute = preferences.getInt("startMinute", NightScreenPolicy.DEFAULT_START_MINUTE);
        int endMinute = preferences.getInt("endMinute", NightScreenPolicy.DEFAULT_END_MINUTE);
        if (startMinute == endMinute) return;
        long start = nextTime(startMinute);
        long end = nextTime(endMinute);
        long next = Math.min(start, end);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pending);
        } else {
            alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pending);
        }
    }

    private static long nextTime(int minuteOfDay) {
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, minuteOfDay / 60);
        next.set(Calendar.MINUTE, minuteOfDay % 60);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) next.add(Calendar.DAY_OF_MONTH, 1);
        return next.getTimeInMillis();
    }
}

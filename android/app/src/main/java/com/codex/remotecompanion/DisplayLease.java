package com.codex.remotecompanion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

final class DisplayLease {
    static final long MAX_LEASE_MILLIS = 120_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final PowerManager.WakeLock wakeLock;
    private long expiresAt;

    @SuppressWarnings("deprecation")
    DisplayLease(Context context) {
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        wakeLock = powerManager.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                "RemoteCompanion:active-session");
        wakeLock.setReferenceCounted(false);
    }

    synchronized long renew(long requestedMillis) {
        long duration = Math.max(5_000L, Math.min(requestedMillis, MAX_LEASE_MILLIS));
        expiresAt = SystemClock.elapsedRealtime() + duration;
        if (wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock.acquire(duration);
        handler.removeCallbacks(releaseIfExpired);
        handler.postDelayed(releaseIfExpired, duration + 250L);
        return duration;
    }

    synchronized void release() {
        expiresAt = 0L;
        handler.removeCallbacks(releaseIfExpired);
        if (wakeLock.isHeld()) {
            wakeLock.release();
        }
    }

    synchronized long remainingMillis() {
        return Math.max(0L, expiresAt - SystemClock.elapsedRealtime());
    }

    private final Runnable releaseIfExpired = new Runnable() {
        @Override
        public void run() {
            synchronized (DisplayLease.this) {
                if (SystemClock.elapsedRealtime() >= expiresAt) {
                    release();
                }
            }
        }
    };
}

package com.codex.remotecompanion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Temporarily supplies a local Wi-Fi interface while native ADB is bootstrapped. */
final class MobileAdbRecovery implements AutoCloseable {
    private final Context context;
    private final Consumer<String> audit;
    private final Runnable interfaceReady;
    private final Object lock = new Object();
    private volatile boolean closed;
    private Thread worker;
    private WifiManager.LocalOnlyHotspotReservation hotspot;
    private Object hotspotRequest;
    private long nextAttemptMillis;

    MobileAdbRecovery(Context context, Consumer<String> audit, Runnable interfaceReady) {
        this.context = context;
        this.audit = audit;
        this.interfaceReady = interfaceReady;
    }

    void start() {
        synchronized (lock) {
            if (closed || worker != null || SystemClock.elapsedRealtime() < nextAttemptMillis) return;
            String permission = Build.VERSION.SDK_INT >= 33
                    ? Manifest.permission.NEARBY_WIFI_DEVICES : Manifest.permission.ACCESS_FINE_LOCATION;
            if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                audit.accept("mobile ADB recovery requires " + permission);
                nextAttemptMillis = SystemClock.elapsedRealtime() + 30_000L;
                return;
            }
            worker = new Thread(this::recover, "arlab-mobile-adb-recovery");
            worker.setDaemon(true);
            worker.start();
        }
    }

    private void recover() {
        try {
            requestHotspot();
            if (!closed) interfaceReady.run();
            // AOSP observes this setting asynchronously. Reassert only a value
            // the framework has switched off; identical writes send no change.
            long deadline = SystemClock.elapsedRealtime() + 120_000L;
            while (!closed && !Thread.currentThread().isInterrupted()
                    && SystemClock.elapsedRealtime() < deadline) {
                if (tcpListening()) {
                    audit.accept("mobile ADB recovery: TCP listener verified");
                    return;
                }
                if (Settings.Global.getInt(context.getContentResolver(), "adb_wifi_enabled", 0) == 0
                        && !Settings.Global.putInt(context.getContentResolver(), "adb_wifi_enabled", 1)) {
                    throw new IllegalStateException("Android rejected wireless debugging recovery");
                }
                Thread.sleep(20L);
            }
            if (!closed) audit.accept("mobile ADB recovery: bootstrap deadline reached");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception error) {
            audit.accept("mobile ADB recovery: " + error.getClass().getSimpleName()
                    + ": " + error.getMessage());
        } finally {
            releaseHotspot();
            synchronized (lock) {
                worker = null;
                nextAttemptMillis = SystemClock.elapsedRealtime() + 30_000L;
            }
        }
    }

    private void requestHotspot() throws Exception {
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        CountDownLatch replied = new CountDownLatch(1);
        Object request = new Object();
        synchronized (lock) { hotspotRequest = request; }
        try {
            wifi.startLocalOnlyHotspot(new WifiManager.LocalOnlyHotspotCallback() {
            @Override public void onStarted(WifiManager.LocalOnlyHotspotReservation reservation) {
                synchronized (lock) {
                    if (closed || hotspotRequest != request) reservation.close();
                    else hotspot = reservation;
                }
                replied.countDown();
            }
            @Override public void onFailed(int reason) {
                audit.accept("mobile ADB recovery: local hotspot refused " + reason);
                replied.countDown();
            }
            @Override public void onStopped() { replied.countDown(); }
            }, new Handler(Looper.getMainLooper()));
        } catch (SecurityException denied) {
            throw new IllegalStateException("Android refused the local hotspot permission", denied);
        }
        if (!replied.await(12, TimeUnit.SECONDS)) {
            throw new IllegalStateException("Local hotspot response timed out");
        }
    }

    private static boolean tcpListening() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 5555), 100);
            return true;
        } catch (java.io.IOException unavailable) { return false; }
    }

    private void releaseHotspot() {
        WifiManager.LocalOnlyHotspotReservation reservation;
        synchronized (lock) {
            hotspotRequest = null;
            reservation = hotspot;
            hotspot = null;
        }
        if (reservation != null) {
            try { reservation.close(); }
            catch (RuntimeException error) {
                audit.accept("mobile ADB recovery: hotspot close failed " + error.getClass().getSimpleName());
            }
        }
    }

    @Override public void close() {
        synchronized (lock) {
            closed = true;
            if (worker != null) worker.interrupt();
        }
        releaseHotspot();
    }
}

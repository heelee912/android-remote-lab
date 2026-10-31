package lab.arcguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.ConsumerIrManager;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public final class ArcGuardService extends Service {
    private static final String TAG = "ArcStandbyGuard";
    private static final String CHANNEL = "arc_standby_guard";
    private static final long CHECK_INTERVAL_MS = 5_000L;
    private final AtomicBoolean checking = new AtomicBoolean();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final SoundbarRecoveryPolicy recovery = new SoundbarRecoveryPolicy();
    private RecoveryAttemptStore attemptStore;
    private boolean healthyPersisted;

    @Override public void onCreate() {
        super.onCreate();
        attemptStore = new RecoveryAttemptStore(
                getSharedPreferences("soundbar_recovery_attempts", MODE_PRIVATE));
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Signa S2 standby guard",
                NotificationManager.IMPORTANCE_LOW));
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Signa S2 standby guard")
                .setContentText("Monitoring ARC standby for a single recovery attempt")
                .setSmallIcon(android.R.drawable.stat_notify_sync).build();
        startForeground(74, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (checking.compareAndSet(false, true)) {
            worker.execute(() -> {
                try {
                    while (!Thread.currentThread().isInterrupted()) {
                        inspectWithWakeLock();
                        Thread.sleep(CHECK_INTERVAL_MS);
                    }
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                } finally {
                    checking.set(false);
                }
            });
        }
        return START_STICKY;
    }

    private void inspectWithWakeLock() {
        PowerManager power = getSystemService(PowerManager.class);
        PowerManager.WakeLock lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                TAG + ":check");
        lock.acquire(60_000);
        try { inspect(); }
        catch (Exception failure) {
            healthyPersisted = false;
            recovery.observe(SystemClock.elapsedRealtime(), null, null, -2);
            Log.e(TAG, "ARC check failed", failure);
        }
        finally { lock.release(); }
    }

    private void inspect() throws Exception {
        ArcGuardConfig config = ArcGuardConfig.load(this);
        try (WebOsClient tv = WebOsClient.connect(config)) {
            String power = tv.request("com.webos.service.tvpower/power/getPowerState")
                    .optString("state");
            String soundOutput = tv.request("com.webos.service.apiadapter/audio/getSoundOutput")
                    .optString("soundOutput");
            JSONObject device = tv.request("com.webos.service.eim/getAllInputStatus");
            int soundbarPower = device.optInt("arcDevicePower", -1);
            boolean healthy = ("Active".equals(power) || "Screen Off".equals(power))
                    && "external_arc".equals(soundOutput) && soundbarPower == 0;
            if (healthy && !healthyPersisted) {
                healthyPersisted = attemptStore.markHealthy();
                if (!healthyPersisted) Log.e(TAG, "Could not persist healthy ARC state");
            } else if (!healthy) {
                healthyPersisted = false;
            }
            SoundbarRecoveryPolicy.Decision action = recovery.observe(
                    SystemClock.elapsedRealtime(), power, soundOutput, soundbarPower);
            if (action == SoundbarRecoveryPolicy.Decision.SEND_POWER) {
                long now = System.currentTimeMillis();
                if (!attemptStore.recordAttempt(now)) {
                    Log.w(TAG, "Recovery suppressed: durable attempt limit or storage failure");
                    return;
                }
                Log.i(TAG, "Recovery: confirmed ARC fallback; sending one power toggle");
                new SoundbarTvInputSignal(getSystemService(ConsumerIrManager.class)).transmitPower();
            } else if (action == SoundbarRecoveryPolicy.Decision.VERIFIED_RECOVERY) {
                Log.i(TAG, "Recovery: TV reports ARC and soundbar active");
            } else if (action == SoundbarRecoveryPolicy.Decision.RECOVERY_UNVERIFIED) {
                Log.w(TAG, "Recovery: no ARC restoration within the verification window");
            }
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }
}

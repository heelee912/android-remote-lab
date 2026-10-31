package lab.arcguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.hardware.ConsumerIrManager;
import android.os.SystemClock;
import android.util.Log;

public final class IrProbeReceiver extends BroadcastReceiver {
    private static final String TAG = "ArcStandbyGuard";

    @Override public void onReceive(Context context, Intent intent) {
        int command = intent.getIntExtra("command", -1);
        long address = intent.getLongExtra("address", 51_345L);
        int repeatCount = intent.getIntExtra("repeatCount", 0);
        int holdMs = intent.getIntExtra("holdMs", 0);
        if (command < 0 || command > 255) {
            throw new IllegalArgumentException("command must be 0..255");
        }
        if (repeatCount < 0 || repeatCount > 100) {
            throw new IllegalArgumentException("repeatCount must be 0..100");
        }
        ConsumerIrManager ir = context.getSystemService(ConsumerIrManager.class);
        if (ir == null || !ir.hasIrEmitter()) {
            throw new IllegalStateException("IR emitter unavailable");
        }
        NecRemoteHold hold = holdMs > 0
                ? NecRemoteHold.forDuration(command, address, holdMs)
                : NecRemoteHold.withRepeats(command, address, repeatCount);
        PendingResult pendingResult = goAsync();
        new Thread(() -> {
            try {
                transmit(ir, hold, command);
            } finally {
                pendingResult.finish();
            }
        }, "soundbar-ir-hold").start();
    }

    /**
     * Each chunk call starts at its offset from the first call. A consistent transmitter
     * start-up delay then cancels out, keeping every repeat on the 108 ms grid.
     */
    private static void transmit(ConsumerIrManager ir, NecRemoteHold hold, int command) {
        long firstCallNs = SystemClock.elapsedRealtimeNanos();
        long worstLateUs = 0;
        for (NecRemoteHold.Chunk chunk : hold.chunks) {
            long dueNs = firstCallNs + (chunk.startOffsetUs * 1_000L);
            long waitNs;
            while ((waitNs = dueNs - SystemClock.elapsedRealtimeNanos()) > 2_000_000L) {
                SystemClock.sleep((waitNs / 1_000_000L) - 1L);
            }
            while (SystemClock.elapsedRealtimeNanos() < dueNs) {
                // Busy-wait the final millisecond; sleep granularity would blur the grid.
            }
            worstLateUs = Math.max(worstLateUs,
                    (SystemClock.elapsedRealtimeNanos() - dueNs) / 1_000L);
            ir.transmit(SoundbarTvInputSignal.CARRIER_FREQUENCY_HZ, chunk.pattern);
        }
        long totalMs = (SystemClock.elapsedRealtimeNanos() - firstCallNs) / 1_000_000L;
        Log.i(TAG, "IR hold sent: command=" + command + " chunks=" + hold.chunks.size()
                + " totalMs=" + totalMs + " worstLateUs=" + worstLateUs);
    }
}

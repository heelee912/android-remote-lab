package lab.arcguard;

import java.util.ArrayDeque;

/** Decides whether a sampled ARC fallback warrants one power-toggle attempt. */
final class SoundbarRecoveryPolicy {
    static final long SAMPLE_INTERVAL_MS = 5_000L;
    static final long MAX_SAMPLE_GAP_MS = 10_000L;
    static final long FALLBACK_DURATION_MS = 30_000L;
    static final long VERIFY_DURATION_MS = 20_000L;
    static final long COOLDOWN_MS = 60_000L;
    static final long ATTEMPT_WINDOW_MS = 3_600_000L;
    private static final int MAX_ATTEMPTS = 3;

    enum Decision { NONE, SEND_POWER, VERIFIED_RECOVERY, RECOVERY_UNVERIFIED }

    private final ArrayDeque<Long> attempts = new ArrayDeque<>();
    private boolean armed;
    private boolean failureLatched;
    private boolean awaitingVerification;
    private long attemptTimeMs = -1L;
    private long fallbackSinceMs = -1L;
    private long lastFallbackSampleMs = -1L;
    private int fallbackPower = Integer.MIN_VALUE;
    private int fallbackSamples;
    private long lastObservedMs = -1L;

    SoundbarRecoveryPolicy() {
        this(new long[0], false);
    }

    /** Restore a same-boot snapshot persisted before transmitting the toggle. */
    SoundbarRecoveryPolicy(long[] recentAttempts, boolean failureLatched) {
        long previous = -1L;
        for (long attempt : recentAttempts) {
            if (attempt < 0 || attempt < previous) {
                throw new IllegalArgumentException("attempt times must be monotonic");
            }
            attempts.addLast(attempt);
            previous = attempt;
        }
        this.failureLatched = failureLatched;
    }

    Decision observe(long nowMs, String tvPower, String soundOutput, int arcPower) {
        if (nowMs < 0 || (lastObservedMs >= 0 && nowMs < lastObservedMs)
                || (!attempts.isEmpty() && nowMs < attempts.peekLast())) {
            throw new IllegalArgumentException("observation times must be monotonic");
        }
        lastObservedMs = nowMs;
        expireAttempts(nowMs);
        boolean tvActive = "Active".equals(tvPower) || "Screen Off".equals(tvPower);
        boolean healthy = tvActive && "external_arc".equals(soundOutput) && arcPower == 0;

        if (awaitingVerification) {
            if (healthy && nowMs - attemptTimeMs <= VERIFY_DURATION_MS) {
                awaitingVerification = false;
                failureLatched = false;
                armed = true;
                clearFallback();
                return Decision.VERIFIED_RECOVERY;
            }
            if (nowMs - attemptTimeMs >= VERIFY_DURATION_MS || !tvActive) {
                awaitingVerification = false;
                armed = false;
                clearFallback();
                return Decision.RECOVERY_UNVERIFIED;
            }
            return Decision.NONE;
        }
        if (healthy) {
            failureLatched = false;
            armed = true;
            clearFallback();
            return Decision.NONE;
        }
        boolean fallback = tvActive && "tv_external_speaker".equals(soundOutput)
                && (arcPower == -1 || arcPower == 1);
        if (!fallback) {
            armed = false;
            clearFallback();
            return Decision.NONE;
        }
        if (!armed || failureLatched) {
            clearFallback();
            return Decision.NONE;
        }
        if (fallbackSinceMs < 0 || fallbackPower != arcPower
                || nowMs - lastFallbackSampleMs > MAX_SAMPLE_GAP_MS) {
            fallbackSinceMs = nowMs;
            lastFallbackSampleMs = nowMs;
            fallbackPower = arcPower;
            fallbackSamples = 1;
            return Decision.NONE;
        }
        if (nowMs - lastFallbackSampleMs >= SAMPLE_INTERVAL_MS) {
            lastFallbackSampleMs = nowMs;
            fallbackSamples++;
        }
        if (fallbackSamples < 2 || nowMs - fallbackSinceMs < FALLBACK_DURATION_MS
                || !rateAllowsAttempt(nowMs)) {
            return Decision.NONE;
        }
        attempts.addLast(nowMs);
        attemptTimeMs = nowMs;
        awaitingVerification = true;
        failureLatched = true;
        armed = false;
        clearFallback();
        return Decision.SEND_POWER;
    }

    long[] recentAttemptTimes() {
        long[] copy = new long[attempts.size()];
        int index = 0;
        for (long attempt : attempts) copy[index++] = attempt;
        return copy;
    }

    boolean failureLatched() { return failureLatched; }

    private void expireAttempts(long nowMs) {
        while (!attempts.isEmpty() && nowMs - attempts.peekFirst() >= ATTEMPT_WINDOW_MS) {
            attempts.removeFirst();
        }
    }

    private boolean rateAllowsAttempt(long nowMs) {
        return attempts.size() < MAX_ATTEMPTS
                && (attempts.isEmpty() || nowMs - attempts.peekLast() >= COOLDOWN_MS);
    }

    private void clearFallback() {
        fallbackSinceMs = -1L;
        lastFallbackSampleMs = -1L;
        fallbackPower = Integer.MIN_VALUE;
        fallbackSamples = 0;
    }
}

package lab.arcguard;

import android.content.SharedPreferences;

/** Persists the decision to send a toggle before the signal is transmitted. */
final class RecoveryAttemptStore {
    private static final long EARLIEST_VALID_WALL_TIME_MS = 1_577_836_800_000L;
    private static final long COOLDOWN_MS = 60_000L;
    private static final long HOUR_MS = 3_600_000L;
    private static final Object LOCK = new Object();

    interface Storage {
        Snapshot read();
        boolean write(Snapshot snapshot);
    }

    static final class Snapshot {
        final long first;
        final long second;
        final long third;
        final boolean failedOrPending;

        Snapshot(long first, long second, long third, boolean failedOrPending) {
            this.first = first;
            this.second = second;
            this.third = third;
            this.failedOrPending = failedOrPending;
        }

        boolean valid() {
            return first >= 0 && second >= 0 && third >= 0
                    && (first != 0 || (second == 0 && third == 0))
                    && (second != 0 || third == 0)
                    && (second == 0 || second >= first)
                    && (third == 0 || third >= second);
        }
    }

    private final Storage storage;
    private boolean storageUnreliable;

    RecoveryAttemptStore(SharedPreferences preferences) {
        this(new PreferenceStorage(preferences));
    }

    RecoveryAttemptStore(Storage storage) {
        this.storage = storage;
    }

    boolean checkAllowed(long nowWallMillis) {
        synchronized (LOCK) {
            try {
                return !storageUnreliable && allowed(storage.read(), nowWallMillis);
            } catch (RuntimeException failure) {
                storageUnreliable = true;
                return false;
            }
        }
    }

    /** Atomically rechecks and persists a pending/failure latch before an IR send. */
    boolean recordAttempt(long nowWallMillis) {
        synchronized (LOCK) {
            try {
                if (storageUnreliable) return false;
                Snapshot previous = storage.read();
                if (!allowed(previous, nowWallMillis)) return false;
                long[] retained = new long[3];
                int count = 0;
                for (long attempt : new long[] {previous.first, previous.second, previous.third}) {
                    if (attempt != 0 && nowWallMillis - attempt < HOUR_MS) {
                        retained[count++] = attempt;
                    }
                }
                retained[count] = nowWallMillis;
                boolean saved = storage.write(new Snapshot(retained[0], retained[1], retained[2], true));
                storageUnreliable = !saved;
                return saved;
            } catch (RuntimeException failure) {
                storageUnreliable = true;
                return false;
            }
        }
    }

    /** Clear only the failure latch after a verified healthy ARC observation. */
    boolean markHealthy() {
        synchronized (LOCK) {
            try {
                if (storageUnreliable) return false;
                Snapshot previous = storage.read();
                if (previous == null || !previous.valid()) return false;
                if (!previous.failedOrPending) return true;
                boolean saved = storage.write(new Snapshot(previous.first, previous.second,
                        previous.third, false));
                storageUnreliable = !saved;
                return saved;
            } catch (RuntimeException failure) {
                storageUnreliable = true;
                return false;
            }
        }
    }

    private static boolean allowed(Snapshot snapshot, long nowWallMillis) {
        if (snapshot == null || !snapshot.valid() || snapshot.failedOrPending
                || nowWallMillis < EARLIEST_VALID_WALL_TIME_MS) return false;
        long latest = snapshot.third != 0 ? snapshot.third
                : snapshot.second != 0 ? snapshot.second : snapshot.first;
        if (latest > nowWallMillis || (latest != 0 && nowWallMillis - latest < COOLDOWN_MS)) {
            return false;
        }
        int withinHour = 0;
        for (long attempt : new long[] {snapshot.first, snapshot.second, snapshot.third}) {
            if (attempt != 0 && nowWallMillis - attempt < HOUR_MS) withinHour++;
        }
        return withinHour < 3;
    }

    private static final class PreferenceStorage implements Storage {
        private final SharedPreferences preferences;

        PreferenceStorage(SharedPreferences preferences) {
            if (preferences == null) throw new IllegalArgumentException("preferences required");
            this.preferences = preferences;
        }

        @Override public Snapshot read() {
            return new Snapshot(preferences.getLong("attempt_first_ms", 0),
                    preferences.getLong("attempt_second_ms", 0),
                    preferences.getLong("attempt_third_ms", 0),
                    preferences.getBoolean("failed_or_pending", false));
        }

        @Override public boolean write(Snapshot snapshot) {
            return preferences.edit()
                    .putLong("attempt_first_ms", snapshot.first)
                    .putLong("attempt_second_ms", snapshot.second)
                    .putLong("attempt_third_ms", snapshot.third)
                    .putBoolean("failed_or_pending", snapshot.failedOrPending)
                    .commit();
        }
    }
}

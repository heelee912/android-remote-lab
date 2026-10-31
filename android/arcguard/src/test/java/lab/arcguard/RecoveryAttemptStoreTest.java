package lab.arcguard;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RecoveryAttemptStoreTest {
    private static final long NOW = 1_800_000_000_000L;

    private static final class MemoryStorage implements RecoveryAttemptStore.Storage {
        RecoveryAttemptStore.Snapshot snapshot = new RecoveryAttemptStore.Snapshot(0, 0, 0, false);
        boolean failWrite;
        boolean failRead;

        @Override public RecoveryAttemptStore.Snapshot read() {
            if (failRead) throw new IllegalStateException("unavailable");
            return snapshot;
        }

        @Override public boolean write(RecoveryAttemptStore.Snapshot next) {
            // Android's in-memory preferences may change even if disk persistence fails.
            snapshot = next;
            return !failWrite;
        }
    }

    @Test public void attemptIsLatchedBeforeSendAndSurvivesAStoreRestart() {
        MemoryStorage storage = new MemoryStorage();
        RecoveryAttemptStore store = new RecoveryAttemptStore(storage);
        assertTrue(store.checkAllowed(NOW));
        assertTrue(store.recordAttempt(NOW));
        assertFalse(store.checkAllowed(NOW + 3_600_000));
        assertFalse(new RecoveryAttemptStore(storage).checkAllowed(NOW + 3_600_000));
        assertTrue(store.markHealthy());
        assertFalse(store.checkAllowed(NOW + 59_999));
        assertTrue(store.checkAllowed(NOW + 60_000));
    }

    @Test public void hourlyLimitAndCooldownRemainAfterHealthyObservation() {
        MemoryStorage storage = new MemoryStorage();
        RecoveryAttemptStore store = new RecoveryAttemptStore(storage);
        assertTrue(store.recordAttempt(NOW));
        assertTrue(store.markHealthy());
        assertTrue(store.recordAttempt(NOW + 60_000));
        assertTrue(store.markHealthy());
        assertTrue(store.recordAttempt(NOW + 120_000));
        assertTrue(store.markHealthy());
        assertFalse(store.checkAllowed(NOW + 3_599_999));
        assertTrue(store.checkAllowed(NOW + 3_600_000));
        assertTrue(store.recordAttempt(NOW + 3_600_000));
        assertTrue(store.markHealthy());
        assertTrue(store.checkAllowed(NOW + 3_660_000));
    }

    @Test public void unknownOrReversedClockAndInvalidStateFailClosed() {
        MemoryStorage storage = new MemoryStorage();
        RecoveryAttemptStore store = new RecoveryAttemptStore(storage);
        assertFalse(store.checkAllowed(0));
        assertTrue(store.recordAttempt(NOW));
        assertTrue(store.markHealthy());
        assertFalse(store.checkAllowed(NOW - 1));
        storage.snapshot = new RecoveryAttemptStore.Snapshot(0, NOW, 0, false);
        assertFalse(store.checkAllowed(NOW + 3_600_000));
        assertFalse(store.markHealthy());
    }

    @Test public void readOrCommitFailureBlocksFurtherActions() {
        MemoryStorage storage = new MemoryStorage();
        RecoveryAttemptStore store = new RecoveryAttemptStore(storage);
        storage.failWrite = true;
        assertFalse(store.recordAttempt(NOW));
        storage.failWrite = false;
        assertFalse(store.markHealthy());
        assertFalse(store.checkAllowed(NOW + 3_600_000));

        MemoryStorage other = new MemoryStorage();
        RecoveryAttemptStore otherStore = new RecoveryAttemptStore(other);
        other.failRead = true;
        assertFalse(otherStore.checkAllowed(NOW));
        other.failRead = false;
        assertFalse(otherStore.recordAttempt(NOW));

        MemoryStorage markFailure = new MemoryStorage();
        RecoveryAttemptStore markFailureStore = new RecoveryAttemptStore(markFailure);
        assertTrue(markFailureStore.recordAttempt(NOW));
        markFailure.failWrite = true;
        assertFalse(markFailureStore.markHealthy());
        markFailure.failWrite = false;
        assertFalse(markFailureStore.checkAllowed(NOW + 60_000));
    }
}

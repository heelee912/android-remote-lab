package lab.arcguard;

import static lab.arcguard.SoundbarRecoveryPolicy.Decision.NONE;
import static lab.arcguard.SoundbarRecoveryPolicy.Decision.RECOVERY_UNVERIFIED;
import static lab.arcguard.SoundbarRecoveryPolicy.Decision.SEND_POWER;
import static lab.arcguard.SoundbarRecoveryPolicy.Decision.VERIFIED_RECOVERY;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SoundbarRecoveryPolicyTest {
    private static SoundbarRecoveryPolicy.Decision observe(
            SoundbarRecoveryPolicy policy, long time, String power, String output, int arc) {
        return policy.observe(time, power, output, arc);
    }

    private static void healthy(SoundbarRecoveryPolicy policy, long time) {
        observe(policy, time, "Active", "external_arc", 0);
    }

    private static SoundbarRecoveryPolicy.Decision fallback(
            SoundbarRecoveryPolicy policy, long time) {
        return observe(policy, time, "Active", "tv_external_speaker", -1);
    }

    private static SoundbarRecoveryPolicy.Decision sampleFallbackFor30Seconds(
            SoundbarRecoveryPolicy policy, long start) {
        SoundbarRecoveryPolicy.Decision decision = NONE;
        for (long time = start; time <= start + 30_000; time += 5_000) {
            decision = fallback(policy, time);
        }
        return decision;
    }

    @Test public void fallbackNeedsAnObservedHealthyArcAndThirtySecondsOfSamples() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        assertEquals(NONE, sampleFallbackFor30Seconds(policy, 0));
        healthy(policy, 35_000);
        for (long time = 40_000; time < 70_000; time += 5_000) {
            assertEquals(NONE, fallback(policy, time));
        }
        assertEquals(SEND_POWER, fallback(policy, 70_000));
        assertTrue(policy.failureLatched());
    }

    @Test public void eitherArcOutputOrPowerOnPreventsToggle() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 0);
        for (long time = 5_000; time <= 45_000; time += 5_000) {
            assertEquals(NONE, observe(policy, time, "Active", "external_arc", 1));
            assertEquals(NONE, observe(policy, time, "Active", "tv_external_speaker", 0));
        }
    }

    @Test public void screenOffIsActiveButActualTvOffClearsFallbackAndArming() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        observe(policy, 0, "Screen Off", "external_arc", 0);
        for (long time = 5_000; time < 35_000; time += 5_000) {
            assertEquals(NONE, observe(policy, time, "Screen Off", "tv_external_speaker", 1));
        }
        assertEquals(SEND_POWER,
                observe(policy, 35_000, "Screen Off", "tv_external_speaker", 1));

        SoundbarRecoveryPolicy other = new SoundbarRecoveryPolicy();
        healthy(other, 0);
        fallback(other, 5_000);
        observe(other, 10_000, "Power Off", "tv_external_speaker", -1);
        assertEquals(NONE, sampleFallbackFor30Seconds(other, 15_000));
    }

    @Test public void missedPollOrUnknownStateRestartsTheContinuousEvidence() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 0);
        fallback(policy, 5_000);
        fallback(policy, 10_000);
        assertEquals(NONE, fallback(policy, 30_000));
        for (long time = 35_000; time < 60_000; time += 5_000) {
            assertEquals(NONE, fallback(policy, time));
        }
        assertEquals(SEND_POWER, fallback(policy, 60_000));

        SoundbarRecoveryPolicy missing = new SoundbarRecoveryPolicy();
        healthy(missing, 0);
        fallback(missing, 5_000);
        observe(missing, 10_000, null, null, -2);
        assertEquals(NONE, sampleFallbackFor30Seconds(missing, 15_000));
    }

    @Test public void changedFallbackReadingMustBeConfirmedAgain() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 0);
        for (long time = 5_000; time <= 30_000; time += 5_000) fallback(policy, time);
        assertEquals(NONE, observe(policy, 35_000, "Active", "tv_external_speaker", 1));
        for (long time = 40_000; time < 65_000; time += 5_000) {
            assertEquals(NONE, observe(policy, time, "Active", "tv_external_speaker", 1));
        }
        assertEquals(SEND_POWER, observe(policy, 65_000, "Active", "tv_external_speaker", 1));
    }

    @Test public void recoveryMustBeObservedWithinTwentySeconds() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 0);
        assertEquals(SEND_POWER, sampleFallbackFor30Seconds(policy, 5_000));
        assertEquals(NONE, fallback(policy, 40_000));
        assertEquals(VERIFIED_RECOVERY,
                observe(policy, 55_000, "Active", "external_arc", 0));
        assertEquals(false, policy.failureLatched());

        SoundbarRecoveryPolicy failure = new SoundbarRecoveryPolicy();
        healthy(failure, 0);
        assertEquals(SEND_POWER, sampleFallbackFor30Seconds(failure, 5_000));
        assertEquals(RECOVERY_UNVERIFIED, fallback(failure, 55_000));
        assertTrue(failure.failureLatched());
        assertEquals(NONE, sampleFallbackFor30Seconds(failure, 60_000));
    }

    @Test public void cooldownAndThreePerHourApplyAcrossHealthyCycles() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 0);
        assertEquals(SEND_POWER, sampleFallbackFor30Seconds(policy, 5_000));
        assertEquals(VERIFIED_RECOVERY,
                observe(policy, 40_000, "Active", "external_arc", 0));
        assertEquals(NONE, sampleFallbackFor30Seconds(policy, 45_000));
        for (long time = 80_000; time < 95_000; time += 5_000) assertEquals(NONE, fallback(policy, time));
        assertEquals(SEND_POWER, fallback(policy, 95_000));
        assertEquals(VERIFIED_RECOVERY,
                observe(policy, 100_000, "Active", "external_arc", 0));
        for (long time = 105_000; time < 155_000; time += 5_000) assertEquals(NONE, fallback(policy, time));
        assertEquals(SEND_POWER, fallback(policy, 155_000));
        assertEquals(VERIFIED_RECOVERY,
                observe(policy, 160_000, "Active", "external_arc", 0));
        assertEquals(NONE, sampleFallbackFor30Seconds(policy, 165_000));
        assertEquals(3, policy.recentAttemptTimes().length);
    }

    @Test public void persistedAttemptAndFailureSurviveProcessRestart() {
        SoundbarRecoveryPolicy original = new SoundbarRecoveryPolicy();
        healthy(original, 0);
        assertEquals(SEND_POWER, sampleFallbackFor30Seconds(original, 5_000));
        SoundbarRecoveryPolicy restored = new SoundbarRecoveryPolicy(
                original.recentAttemptTimes(), original.failureLatched());
        assertEquals(NONE, sampleFallbackFor30Seconds(restored, 40_000));
        assertTrue(restored.failureLatched());
        healthy(restored, 75_000);
        assertEquals(SEND_POWER, sampleFallbackFor30Seconds(restored, 80_000));
    }

    @Test(expected = IllegalArgumentException.class)
    public void backwardsClockIsRejected() {
        SoundbarRecoveryPolicy policy = new SoundbarRecoveryPolicy();
        healthy(policy, 10_000);
        fallback(policy, 9_000);
    }
}

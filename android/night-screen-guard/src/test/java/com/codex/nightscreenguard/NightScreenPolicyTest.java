package com.codex.nightscreenguard;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class NightScreenPolicyTest {
    @Test
    public void overnightWindowIncludesBothSidesOfMidnight() {
        assertFalse(NightScreenPolicy.inWindow(22 * 60 + 59, 23 * 60, 8 * 60));
        assertTrue(NightScreenPolicy.inWindow(23 * 60, 23 * 60, 8 * 60));
        assertTrue(NightScreenPolicy.inWindow(0, 23 * 60, 8 * 60));
        assertTrue(NightScreenPolicy.inWindow(7 * 60 + 59, 23 * 60, 8 * 60));
        assertFalse(NightScreenPolicy.inWindow(8 * 60, 23 * 60, 8 * 60));
    }

    @Test
    public void sameStartAndEndDoesNotActivateGuard() {
        assertFalse(NightScreenPolicy.inWindow(0, 0, 0));
        assertFalse(NightScreenPolicy.inWindow(12 * 60, 0, 0));
    }
}

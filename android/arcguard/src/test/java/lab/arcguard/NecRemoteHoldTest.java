package lab.arcguard;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public final class NecRemoteHoldTest {
    private static final int NIGHT = 0x79;
    private static final long ADDRESS = 51_345L;

    @Test public void shortPressIsTheBareFrame() {
        NecRemoteHold hold = NecRemoteHold.withRepeats(NIGHT, ADDRESS, 0);

        assertEquals(1, hold.chunks.size());
        assertArrayEquals(SoundbarTvInputSignal.buildNecPattern(NIGHT, ADDRESS),
                hold.chunks.get(0).pattern);
    }

    @Test public void everyCodeStartsOnTheRepeatGrid() {
        NecRemoteHold hold = NecRemoteHold.forDuration(NIGHT, ADDRESS, 5_500);

        List<Long> starts = codeStarts(hold);
        assertEquals(52, starts.size());
        for (int code = 0; code < starts.size(); code++) {
            assertEquals((long) code * NecRemoteHold.REPEAT_PERIOD_US, (long) starts.get(code));
        }
    }

    @Test public void firstRepeatFollowsTheFrameAfter108Milliseconds() {
        int[] first = NecRemoteHold.withRepeats(NIGHT, ADDRESS, 1).chunks.get(0).pattern;
        int frameLength = SoundbarTvInputSignal.buildNecPattern(NIGHT, ADDRESS).length;

        long frameAndGapUs = NecRemoteHold.durationUs(Arrays.copyOf(first, frameLength + 1));
        assertEquals(108_000L, frameAndGapUs);
        assertArrayEquals(new int[] {9_000, 2_250, 560},
                Arrays.copyOfRange(first, frameLength + 1, first.length));
    }

    @Test public void chunksFitTheTransmitterLimitAndEndOnAMark() {
        NecRemoteHold hold = NecRemoteHold.forDuration(NIGHT, ADDRESS, 10_000);

        assertTrue(hold.chunks.size() > 1);
        for (NecRemoteHold.Chunk chunk : hold.chunks) {
            assertTrue(NecRemoteHold.durationUs(chunk.pattern) <= NecRemoteHold.MAX_CHUNK_US);
            assertEquals(1, chunk.pattern.length % 2);
            assertEquals(0, chunk.startOffsetUs % NecRemoteHold.REPEAT_PERIOD_US);
        }
    }

    @Test public void laterChunksContainOnlyRepeatCodes() {
        NecRemoteHold hold = NecRemoteHold.forDuration(NIGHT, ADDRESS, 5_500);

        for (int index = 1; index < hold.chunks.size(); index++) {
            int[] pattern = hold.chunks.get(index).pattern;
            for (int offset = 0; offset < pattern.length; offset += 4) {
                assertEquals(9_000, pattern[offset]);
                assertEquals(2_250, pattern[offset + 1]);
                assertEquals(560, pattern[offset + 2]);
            }
        }
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsHoldsBeyondTheSupportedRange() {
        NecRemoteHold.forDuration(NIGHT, ADDRESS, NecRemoteHold.MAX_HOLD_MS + 1);
    }

    /** Start time of every code (frame or repeat) on one timeline, rebuilt from the chunks. */
    private static List<Long> codeStarts(NecRemoteHold hold) {
        int frameLength = SoundbarTvInputSignal.buildNecPattern(NIGHT, ADDRESS).length;
        List<Long> starts = new ArrayList<>();
        for (NecRemoteHold.Chunk chunk : hold.chunks) {
            long time = chunk.startOffsetUs;
            int index = 0;
            while (index < chunk.pattern.length) {
                starts.add(time);
                int length = starts.size() == 1 ? frameLength : 3;
                time += NecRemoteHold.durationUs(Arrays.copyOfRange(chunk.pattern, index,
                        Math.min(chunk.pattern.length, index + length + 1)));
                index += length + 1;
            }
        }
        return starts;
    }
}

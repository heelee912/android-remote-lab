package lab.arcguard;

import java.util.ArrayList;
import java.util.List;

/**
 * One continuously held NEC remote button: the full frame, then a repeat code every 108 ms.
 * Receivers treat a late first repeat as a new short press, so the 108 ms grid must hold
 * across the separate transmitter calls that ConsumerIrService's 2 s limit forces.
 */
final class NecRemoteHold {
    static final int REPEAT_PERIOD_US = 108_000;
    /** ConsumerIrService rejects a pattern longer than two seconds. */
    static final int MAX_CHUNK_US = 2_000_000;
    static final int MAX_HOLD_MS = 10_000;
    private static final int[] REPEAT_CODE = {9_000, 2_250, 560};

    /** A transmitter call and when it must start, measured from the first call's start. */
    static final class Chunk {
        final long startOffsetUs;
        final int[] pattern;

        Chunk(long startOffsetUs, int[] pattern) {
            this.startOffsetUs = startOffsetUs;
            this.pattern = pattern;
        }
    }

    final List<Chunk> chunks;

    private NecRemoteHold(List<Chunk> chunks) {
        this.chunks = chunks;
    }

    static NecRemoteHold forDuration(int command, long deviceAddressBits, int holdMs) {
        if (holdMs < 0 || holdMs > MAX_HOLD_MS) {
            throw new IllegalArgumentException("hold must be 0.." + MAX_HOLD_MS + " ms");
        }
        int repeats = (int) Math.ceil(holdMs * 1_000.0 / REPEAT_PERIOD_US);
        return withRepeats(command, deviceAddressBits, repeats);
    }

    static NecRemoteHold withRepeats(int command, long deviceAddressBits, int repeats) {
        if (repeats < 0) throw new IllegalArgumentException("repeats must not be negative");
        int[] frame = SoundbarTvInputSignal.buildNecPattern(command, deviceAddressBits);
        List<Chunk> chunks = new ArrayList<>();
        List<Integer> pattern = new ArrayList<>();
        long chunkStartUs = 0;
        for (int code = 0; code <= repeats; code++) {
            int[] burst = code == 0 ? frame : REPEAT_CODE;
            long codeStartUs = (long) code * REPEAT_PERIOD_US;
            if (!pattern.isEmpty()
                    && codeStartUs + durationUs(burst) - chunkStartUs > MAX_CHUNK_US) {
                chunks.add(new Chunk(chunkStartUs, toArray(pattern)));
                pattern.clear();
            }
            if (pattern.isEmpty()) {
                chunkStartUs = codeStartUs;
            } else {
                // Pad the previous code's trailing mark out to this code's 108 ms slot.
                long previousEndUs = chunkStartUs + sum(pattern);
                pattern.add((int) (codeStartUs - previousEndUs));
            }
            for (int interval : burst) pattern.add(interval);
        }
        chunks.add(new Chunk(chunkStartUs, toArray(pattern)));
        return new NecRemoteHold(chunks);
    }

    static long durationUs(int[] pattern) {
        long total = 0;
        for (int interval : pattern) total += interval;
        return total;
    }

    private static long sum(List<Integer> pattern) {
        long total = 0;
        for (int interval : pattern) total += interval;
        return total;
    }

    private static int[] toArray(List<Integer> pattern) {
        int[] values = new int[pattern.size()];
        for (int index = 0; index < values.length; index++) values[index] = pattern.get(index);
        return values;
    }
}

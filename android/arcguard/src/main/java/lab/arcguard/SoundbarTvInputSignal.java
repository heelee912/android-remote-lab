package lab.arcguard;

import android.hardware.ConsumerIrManager;
import android.os.SystemClock;

final class SoundbarTvInputSignal {
    static final int CARRIER_FREQUENCY_HZ = 38_000;
    static final int POWER_COMMAND = 0;
    static final int TV_INPUT_COMMAND = 15;
    // This is the address representation proven against the owner's Signa S2.
    // ConsumerIrManager transmits each byte least-significant bit first.
    private static final long DEVICE_ADDRESS_BITS = 51_345L;
    private final ConsumerIrManager consumerIr;

    SoundbarTvInputSignal(ConsumerIrManager consumerIr) {
        this.consumerIr = consumerIr;
    }

    void transmitTvInputCandidateBundle() {
        transmit(TV_INPUT_COMMAND);
        // A short remote-style hold improves reception but stays far below the
        // five-second long-press used by the soundbar's settings gestures.
        for (int repeat = 0; repeat < 2; repeat++) {
            SystemClock.sleep(90L);
            consumerIr.transmit(CARRIER_FREQUENCY_HZ, new int[]{9_000, 2_250, 560});
        }
        // Some NEC decoders accept only full-frame repeats. Repeating the same
        // already-selected TV/ARC command tests that path without changing input.
        SystemClock.sleep(700L);
        transmit(TV_INPUT_COMMAND);
    }

    void transmitPower() {
        transmit(POWER_COMMAND);
    }

    private void transmit(int command) {
        if (consumerIr == null || !consumerIr.hasIrEmitter()) {
            throw new IllegalStateException("Set-top IR emitter is unavailable");
        }
        consumerIr.transmit(CARRIER_FREQUENCY_HZ, buildNecPattern(command));
    }

    static int[] buildNecPattern(int command) {
        return buildNecPattern(command, DEVICE_ADDRESS_BITS);
    }

    static int[] buildNecPattern(int command, long deviceAddressBits) {
        if (command < 0 || command > 255) {
            throw new IllegalArgumentException("NEC command must fit one byte");
        }
        if (deviceAddressBits < 0 || deviceAddressBits > 0xffffL) {
            throw new IllegalArgumentException("NEC extended address must fit two bytes");
        }
        long bits = ((long) command << 16) | deviceAddressBits
                | ((long) (command ^ 0xff) << 24);
        int[] pattern = new int[67];
        pattern[0] = 9_000;
        pattern[1] = 4_500;
        for (int bit = 0; bit < 32; bit++) {
            pattern[(bit * 2) + 2] = 560;
            pattern[(bit * 2) + 3] = ((bits >>> bit) & 1L) == 0L ? 560 : 1_690;
        }
        pattern[66] = 560;
        return pattern;
    }
}

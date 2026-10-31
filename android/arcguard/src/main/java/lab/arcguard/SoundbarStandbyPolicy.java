package lab.arcguard;

final class SoundbarStandbyPolicy {
    private static final String ACTIVE = "Active";
    private static final String SCREEN_OFF = "Screen Off";
    private static final String ARC = "external_arc";
    private static final String TV_SPEAKER_FALLBACK = "tv_external_speaker";

    private SoundbarStandbyPolicy() {}

    enum KeepaliveAction {
        NONE,
        REASSERT_TV_INPUT,
        POWER_ON_THEN_TV_INPUT
    }

    static KeepaliveAction selectAction(String tvPower, String currentInput,
            String requiredInput, String soundOutput, boolean arcDevice, int soundbarPower) {
        boolean tvKeepsHdmiAlive = ACTIVE.equals(tvPower) || SCREEN_OFF.equals(tvPower);
        boolean intendedInput = requiredInput.equals(currentInput);
        if (!tvKeepsHdmiAlive || !intendedInput) {
            return KeepaliveAction.NONE;
        }
        if (arcDevice && ARC.equals(soundOutput) && soundbarPower == 0) {
            return KeepaliveAction.REASSERT_TV_INPUT;
        }
        boolean confirmedStandby = soundbarPower == 1;
        boolean lgArcFallback = !arcDevice && TV_SPEAKER_FALLBACK.equals(soundOutput);
        return confirmedStandby || lgArcFallback
                ? KeepaliveAction.POWER_ON_THEN_TV_INPUT
                : KeepaliveAction.NONE;
    }
}

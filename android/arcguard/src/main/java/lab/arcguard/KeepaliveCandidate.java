package lab.arcguard;

enum KeepaliveCandidate {
    WEBOS_SESSION("webos-session", Interaction.READ_ONLY),
    TV_POWER_STATUS("tv-power-status", Interaction.READ_ONLY),
    FOREGROUND_INPUT("foreground-input", Interaction.READ_ONLY),
    SOUND_OUTPUT_STATUS("sound-output-status", Interaction.READ_ONLY),
    ARC_DEVICE_STATUS("arc-device-status", Interaction.READ_ONLY),
    AUDIO_STATUS("audio-status", Interaction.READ_ONLY),
    AUDIO_VOLUME_STATUS("audio-volume-status", Interaction.READ_ONLY),
    EXTERNAL_INPUT_STATUS("external-input-status", Interaction.READ_ONLY),
    WEBOS_SERVICE_LIST("webos-service-list", Interaction.READ_ONLY),
    SYSTEM_INFO("system-info", Interaction.READ_ONLY),
    REASSERT_ARC_OUTPUT("reassert-arc-output", Interaction.IDEMPOTENT),
    REASSERT_MUTE("reassert-mute", Interaction.IDEMPOTENT),
    REASSERT_VOLUME("reassert-volume", Interaction.IDEMPOTENT),
    IR_TV_INPUT_FRAME("ir-tv-input-frame", Interaction.SAME_INPUT),
    IR_TV_INPUT_REPEAT("ir-tv-input-repeat", Interaction.SAME_INPUT),
    IR_TV_INPUT_FULL_REPEAT("ir-tv-input-full-repeat", Interaction.SAME_INPUT);

    enum Interaction { READ_ONLY, IDEMPOTENT, SAME_INPUT }

    final String id;
    final Interaction interaction;

    KeepaliveCandidate(String id, Interaction interaction) {
        this.id = id;
        this.interaction = interaction;
    }
}

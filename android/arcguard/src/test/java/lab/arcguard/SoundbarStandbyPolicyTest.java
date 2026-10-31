package lab.arcguard;

import static lab.arcguard.SoundbarStandbyPolicy.KeepaliveAction.NONE;
import static lab.arcguard.SoundbarStandbyPolicy.KeepaliveAction.POWER_ON_THEN_TV_INPUT;
import static lab.arcguard.SoundbarStandbyPolicy.KeepaliveAction.REASSERT_TV_INPUT;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class SoundbarStandbyPolicyTest {
    private static final String HDMI_3 = "com.webos.app.hdmi3";

    @Test public void reassertsTvInputOnlyForAnActiveArcSoundbar() {
        assertEquals(REASSERT_TV_INPUT, SoundbarStandbyPolicy.selectAction(
                "Active", HDMI_3, HDMI_3, "external_arc", true, 0));
    }

    @Test public void screenOffStillKeepsTheHdmiSessionAlive() {
        assertEquals(REASSERT_TV_INPUT, SoundbarStandbyPolicy.selectAction(
                "Screen Off", HDMI_3, HDMI_3, "external_arc", true, 0));
    }

    @Test public void confirmedStandbyUsesOnePowerRecovery() {
        assertEquals(POWER_ON_THEN_TV_INPUT, SoundbarStandbyPolicy.selectAction(
                "Active", HDMI_3, HDMI_3, "external_arc", true, 1));
    }

    @Test public void lgSpeakerFallbackUsesOnePowerRecovery() {
        assertEquals(POWER_ON_THEN_TV_INPUT, SoundbarStandbyPolicy.selectAction(
                "Active", HDMI_3, HDMI_3, "tv_external_speaker", false, -1));
    }

    @Test public void tvOffNeverSendsACommand() {
        assertEquals(NONE, SoundbarStandbyPolicy.selectAction(
                "Power Off", HDMI_3, HDMI_3, "external_arc", true, 0));
    }

    @Test public void anotherTvInputNeverSendsACommand() {
        assertEquals(NONE, SoundbarStandbyPolicy.selectAction(
                "Active", "com.webos.app.hdmi1", HDMI_3, "external_arc", true, 0));
    }
}

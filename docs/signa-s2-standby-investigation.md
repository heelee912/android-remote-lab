# Polk Signa S2 automatic-standby investigation

This checklist prevents later work from repeating an already rejected route.
The target is to keep the Signa S2 available during silence without changing the
TV picture, foreground application, input, volume, mute state, or audible output.

## Completed routes

| Route | Result | Reuse decision |
| --- | --- | --- |
| Hold the Signa S2 `TV` remote command | The quick start guide places the five-second `TV` hold under Bluetooth standby (power-on from a registered Bluetooth device, default off), not the 15-minute auto standby. | Not a standby route. |
| Other public remote button combinations | Polk's Australian distributor documents a five-second `Night` hold as the S2 auto-standby toggle. The owner already performed the documented procedures, including the `Night` hold, with the physical Polk remote, and auto standby stayed active. Separately, earlier set-top IR "holds" were malformed (first repeat about 170 ms after the frame instead of NEC's 108 ms); `NecRemoteHold` fixes the timing for any future hold. | Do not repeat; the owner's physical-remote test is the authoritative result. |
| Hidden firmware/configuration flag through Bluetooth | A2DP connection control was available, but GATT, SDP, RFCOMM, and L2CAP probes did not expose a writable configuration or firmware channel. Bluetooth can also change the active input. | Do not repeat without a new firmware artifact or newly identified service. |
| Hidden firmware/configuration flag through HDMI or webOS | The TV can report the ARC device and power state. The set-top CEC controller returned NACK for the directed audio-system status request, and the retail TV's external control API did not expose the webOS CEC service. No writable Signa S2 configuration path was established. | Do not repeat the same probes. |
| Physical USB, board header, teardown, or soldering | Excluded by the owner. | Out of scope. |
| Periodic TV mute/unmute | It displayed an on-screen mute indicator and caused a real muted interval. | Permanently rejected. |
| Periodic volume or sound-output repair | It can display an on-screen volume indicator or interrupt ARC routing. | Permanently rejected. |
| TV panel-off restoration | It blacked the TV while it was being watched. | Permanently rejected for standby prevention. Panel control remains a separate explicit command only. |
| Continuous zero-valued PCM | The soundbar still entered standby after the measured timeout. | Failed; do not repeat. |
| Non-zero, sub-audible PCM | Existing keep-alive tools use this strategy, but it still sends audio data and cannot satisfy the owner's no-audio requirement. | Rejected before deployment. |
| Bluetooth keep-alive | It can switch the Signa S2 away from TV/ARC. | Rejected. |
| Polling LG status APIs | Readback did not prevent standby and does not itself transmit a confirmed CEC query to the soundbar. | Readback only; not a keep-alive. |

## Experiment ledger and current candidate

The previous 16-card run is **invalid**, not 16 independent failures or a
verified solution: TV API reads did not establish delivery to the soundbar,
the IR variants were sent together, and same-value writes and power toggling
were not proven invisible or safe. The installed experimental app was
force-stopped. The current source has observation-only service behavior and is
not yet installed. Do not restart the older installed service.

An independent Claude review reported these earlier observations; the original
timestamped records need to be linked before treating them as independently
verified here: IR address `0xC891`; Bluetooth command `0x12` received; power
command `0x00` woke the soundbar from standby but is a toggle, not a proven
on-only command; TV/ARC `0x0F` did not wake it from standby. The review also
reported one TV/ARC single-frame trial at 553 seconds followed by standby at
831 seconds, and same-ARC reassertion followed by standby at 886 seconds.
Preserve these as reported failed or inconclusive trials and do not repeat
them without new evidence or corrected conditions. The review reports that
TV-input IR can make the soundbar's blue LED flash; invisibility is not proven.

For every new candidate record **success, failure, invalid, or untried**;
invalid means delivery or test conditions were not established. Log the actual
time program audio ended, transmission times, soundbar power observations and
any user action that changes conditions. LG's ARC status can lag, and an API
response or IR transmitter call does not establish receiver delivery. A grouped
test can assess only actions with delivery and user-experience effects established;
its success does not identify which action worked.

The following describes an **older proposal**, not an active or verified
candidate. The subsequent installed version differed and is stopped.

Reassert the already-selected Signa S2 `TV/ARC input` IR command every ten
minutes, but only when all of these conditions are true:

1. The TV is `Active` or `Screen Off`, not in standby.
2. The configured set-top HDMI input remains selected.
3. LG reports an ARC device.
4. ARC is selected, or LG has fallen back to its own speaker because the
   soundbar reports standby.

One immediate before/after trial left LG power, HDMI input, sound output, volume,
mute, and Signa S2 power unchanged. The command carries no audio samples and does
not launch an Android activity. This is evidence of immediate state invariance,
not yet proof that it prevents the fifteen-minute standby transition.

The candidate APK is built but intentionally not installed while the owner is
watching TV. Static inspection of the built artifact found:

- no `AudioTrack`, `AudioManager`, audio-focus, mute, volume, panel, or sound-output
  mutation call;
- no media-playback foreground-service permission or type;
- a no-display launcher activity and a low-importance foreground notification;
- one `ConsumerIrManager.transmit` call using only the known Signa S2 `TV` input
  NEC command;
- a ten-minute exact-alarm interval and boot receiver.

## Required final experiment

Install the candidate only during a time when a quiet interval longer than
fifteen minutes is acceptable. Before the wait, record the TV input, mute,
volume, sound output, foreground app, and ARC device power. During the wait,
observe those fields without changing them. Pass requires all of the following:

- Signa S2 remains powered after more than fifteen minutes with no program audio;
- no TV overlay, foreground-app change, sound interruption, input change, volume
  change, or mute change occurs;
- the ten-minute IR execution is recorded once and the next alarm remains armed;
- the same behavior returns after a set-top reboot.

Any user-visible side effect or standby transition is a failure. Do not compensate
with mute, volume, audio samples, panel control, or input switching.

## 2026-10-31 set-top CEC findings and planned keep-alive

Readback and controlled observations (times KST):

- Before the set-top HDMI cable was replaced, every set-top CEC poll and directed
  message to the TV (logical 0) and the Signa S2 (logical 5) was `no ack`,
  `mIsCecAvailable` was false, and the TV listed no CEC device on HDMI 3. All
  readable flags were already on: TV `SIMPLINK (HDMI-CEC)`, `Auto Device Setup`,
  `Auto Power`; set-top `hdmi_cec_enabled=1`; KT `HDMI power sync` (it maps to
  `hdmi_control_auto_device_off_enabled`). Toggling `hdmi_cec_enabled` 0→1 did
  not help. After the cable was replaced, the set-top's polls to the TV and the
  Signa S2 were acknowledged, `mIsCecAvailable` became true, the Signa S2
  reported OSD name, vendor ID and power status to the set-top, and the TV
  listed the set-top as a SIMPLINK device on HDMI 3.
- The Signa S2 broadcasts `<Set System Audio Mode>` off (`5f 72 00`) at the
  moment it enters standby (observed 18:48:15.98), so the set-top can detect
  standby from CEC alone.
- The set-top's once-a-minute discovery polls did not prevent standby.
- A single timer reset happened at about 18:33:16, at the HDMI reconnect; the
  set-top's later `<Give Device Power Status>`/`<Give Device Vendor ID>` queries
  at 18:33:30 did not move the standby time.
- `cmd hdmi_control onetouchplay` on the set-top (TV already on HDMI 3) produced
  no TV overlay in a TV screenshot and made the set-top send
  `<System Audio Mode Request>` (`70 30 00`) directly to the Signa S2, which
  answered `<Set System Audio Mode>` on (`5f 72 01`). This is the standard
  audio-system wake request. Its effect on the idle timer is untested but it is
  the leading keep-alive candidate.
- TV webOS `changeSoundOutput` to the already-selected `external_arc` woke the
  Signa S2 from standby in 12–25 s twice with no TV overlay in the screenshot
  taken one second later. Same-value `audio/setMute false` showed no overlay;
  its timer effect is untested.
- The TV moved behind the home router; the set-top stays on the separate IPTV
  network, so the set-top cannot reach the TV's webOS API. CEC is the
  set-top's only path to the TV and the Signa S2.

Planned set-top-resident keep-alive (not yet built):

1. Every ten minutes run `cmd hdmi_control onetouchplay` from a shell-privileged
   context on the set-top. No silence detection is needed: when audio is
   playing the bar is already on and the request changes nothing.
2. Skip the send when the TV reports standby (One Touch Play would turn the TV
   on) or when the set-top is not the active source (it would switch the TV's
   input). Both states are visible in `dumpsys hdmi_control`.
3. On the Signa S2 standby broadcast (`72 00`), send the same request at once to
   wake it.
4. Shell privilege: ordinary apps lack `HDMI_CEC`. The set-top's own adbd
   listens on TCP 5555, so the app can authenticate to it locally with its own
   key and run the command as the shell user. The first connection shows the
   debugging authorization prompt once; the Companion can accept it with
   "always allow". The KT `PowerModeReceiver` One Touch Play path is tied to
   power-mode transitions and is not suitable as a keep-alive hook.
5. Verify in operation: the guard logs each send and any standby broadcast, so
   the first silent period over fifteen minutes answers whether the request
   resets the timer, and recovery covers the case where it does not.

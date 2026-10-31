# Signa S2 standby investigation

This is an experimental Android app for observing the LG TV and investigating
whether a Signa S2 soundbar can remain awake without affecting viewing. It is
not a verified standby solution. The service reads TV status and, after a
confirmed ARC fallback, may send one soundbar power toggle by IR. A shell-only
receiver sends a single remote button, optionally held with correct NEC repeat
timing:

    am broadcast -a lab.arcguard.SEND_IR_COMMAND -n lab.arcguard/.IrProbeReceiver \
        --ei command 121 --ei holdMs 5500

Command 121 (0x79) is `Night`; a five-second `Night` hold is the documented S2
auto-standby toggle. Installing the app does not start the service.

## Evidence and candidate status

The earlier bundle was described as 16 non-disruptive candidates. That claim
was not established: the TV's status responses may be cached, same-value
writes can race with user changes or cause a display or audio interruption,
and an IR transmitter's success does not establish soundbar reception. The
three IR variants were sent in one burst, not independently verified. A power
toggle based on stale TV status can turn an already-on soundbar off. These
actions are disabled in the service while candidates are being investigated.

Potential direct queries to the soundbar, each requiring a proven route and
an interference check before inclusion in a bundle:

* HDMI-CEC: give audio status, give system-audio-mode status, get CEC version,
  give physical address, give vendor ID, give OSD name, and request short audio
  descriptors. The previously tested set-top-to-soundbar route returned NACK;
  a TV-originated route has not yet been established.
* Bluetooth: SDP service search, attribute query, and combined search/attribute
  query; L2CAP echo and information request; remote name, supported features,
  and version queries; and AVRCP volume notification registration. Supported
  roles and the effect of connecting while ARC is in use remain unverified.
  These are protocol ideas, not nine independently runnable Android 13 APIs:
  the public L2CAP socket is LE-specific, and a general-app route for arbitrary
  BR/EDR L2CAP or SDP packets has not been established. The public
  `fetchUuidsWithSdp()` query can initiate a connection and may return cached
  UUIDs, so its return value alone does not prove a radio exchange.

An idle Bluetooth connection and the set-top's normal CEC polling were present
before earlier standby failures; they are not treated as proven solutions. The
set-top's `POWER_ON_STATUS_ONLY` code reports the set-top's state to a KT HID
remote, not a demonstrated soundbar power-on command. A soundbar response or
other delivery evidence is required before a candidate can be counted as sent.

A bundle that runs throughout a controlled silent period and still permits
standby can rule out only the delivered actions under those test conditions.
If standby does not occur, the bundle needs subsequent separation to determine
which action mattered. Normal playback remaining active is not an idle test.

Build with `android/gradlew.bat -p android :arcguard:testDebugUnitTest
:arcguard:lintDebug :arcguard:assembleDebug`. Do not deploy the experimental
installer as a standby fix until its behavior and the test outcome are verified.

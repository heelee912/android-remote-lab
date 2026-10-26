# Android Remote Lab

## Remote ADB through the Companion connection

Companion 1.2.0+ carries ADB bytes through its authenticated TLS connection to the
Tailscale Funnel endpoint. The PC opens an owner-scoped listener on loopback only;
the Companion connects that stream only to its own loopback ADB service. A changed
LAN address does not change this route. Commands, original-file transfers and
guarded system input use the same tunnel and still verify the physical serial.
Companion 1.2.1+ handles full send buffers without blocking reads or heartbeats.
Companion 1.2.3+ sends frame headers and bodies together with immediate TCP
transmission, and uses bounded 128 KiB chunks for the remote stream.

The default route is automatic: hardware-verified direct ADB is used when healthy;
if its connection fails before the caller command runs, ARLab uses the Companion
tunnel. This preserves fast local transfers without requiring USB or a LAN route
for remote operation. A failed direct probe is cached for 30 seconds. An executed
command that returns failure or an uncertain outcome is never retried on another
route. Use `--adb-route companion` on `adb` or `files` to verify the remote route
even when direct ADB is available; `--adb-route direct` selects direct ADB only.

```powershell
arlab doctor --background --repair --json
try {
    arlab device adb-status --json
    arlab device adb --adb-route companion --json -- shell getprop ro.product.model
} finally {
    arlab session stop --json
}
```

`adb-status` reports the local ADB listener, not successful PC authentication.
An actual ADB result reports `connectionRoute: companion-tunnel` after checking
the configured hardware serial. The existing ADB key must already be authorized
on that device. The hardware binding and PC SDK path remain local configuration.
Older Companions retain the configured direct USB/LAN path until updated.

During provisioning, grant the Companion
`android.permission.WRITE_SECURE_SETTINGS` over the existing authenticated ADB
connection. It can then restore Android's `adb_wifi_enabled` setting when the
TLS listener is absent. `adb-status --repair` requests this repair explicitly;
tunnel creation also repairs when this grant exists. Normal status does not
change debugging settings. No caller-supplied remote host is accepted.

Companion 1.2.4+ also restores `adb_enabled` during repair. Keeping Android's
ADB service enabled retains a provisioned TCP listener when Wi-Fi disappears.
If wireless debugging is already enabled but its port is dead, repair performs
an off/on transition and waits for an actual listening socket. `adb-status`
reports `adbEnabled`, `wirelessEnabled`, `repairAttempted` and `wirelessRestarted`.

Companion 1.2.5+ removes the first-unlock wait from background connection startup.
Device-protected preferences and the enrollment key are available during direct
boot. Network and ADB listener readiness are checked independently of app UI and
credential-encrypted storage.

Companion 1.2.6+ bounds repair by actual elapsed time and caches property probes.
Native SDK reconnects cannot enqueue repeated listener repair loops; failed
endpoints close and the next owned command creates a fresh tunnel.

Companion 1.2.8+ adds a bounded mobile bootstrap when no listener and no validated
Wi-Fi link exist. With its nearby-Wi-Fi permission granted, it temporarily starts
a local-only hotspot and reasserts wireless debugging in a background worker. The
PC waits for TLS discovery, prepares TCP, and waits for hotspot cleanup before
dispatching the caller command. `adb-status` exposes `mobileRecoveryRunning` and
`mobileRecoveryError`. Device testing establishes support, including separately
testing reboot; the bootstrap depends on Android's implementation. The temporary
hotspot closes after completion, failure, deadline or Companion disconnect.

On the automatic and Companion routes, a recovered TLS-only ADB listener is
verified against the enrolled hardware and provisioned with `adb tcpip 5555`
before the caller command. The relay polls the actual TCP listener after adbd
restarts, then reconnects its tunnel. Explicit native `tcpip` and `usb` requests
retain their requested transport change. `--adb-route direct` uses direct ADB.

Android's TLS debugging listener can stop when Wi-Fi disconnects. For
mobile-data use, an existing ADB connection can run `adb tcpip 5555`; Companion
1.2.1+ also discovers this phone-local listener and carries its ADB authentication
inside the outer TLS connection. Legacy TCP ADB also listens on local network
interfaces and is encrypted by the outer ARLab TLS during remote use.
This bootstrap is distinct from ordinary reconnection. TCP
mode can be cleared by `adb usb` or reboot, and automatic TLS repair depends on
the device accepting Wireless debugging on the available network. Without a
connected Wi-Fi network or retained TCP configuration, a stock device can retain
Companion connectivity while exposing no ADB listener. Mobile bootstrap provides
another recovery route on supported devices; a firmware-supported system/root
provisioning path remains an alternative when Android refuses that route. The
development settings grant alone cannot write protected ADB system properties.
Verify this condition separately from an ordinary cellular handoff or adbd restart.

Disconnects and expired ownership close the local tunnel. A subsequent owned
command creates a new tunnel and reconnects the SDK with its existing key. An
interrupted caller command is not replayed, since installation or a shell change
may already have taken effect. A new tunnel does not require a new enrollment.
Repair preflight, device commands and session start wait up to 30 seconds for that same enrolled
device to reconnect; they fail rather than follow a changed target selection.
The relay requests readiness immediately after authentication. Commands wait for
fresh capabilities after reconnect; an initial missing version is reported as
`CONNECTED_UNVERIFIED`, separately from an actually outdated Companion.

## Background work and screen readiness

ADB commands, file transfers and diagnostics acquire exclusive device ownership
without waking the display or requiring an unlocked keyguard. A locked screen
does not block those commands at the ARLab layer. Run:

```powershell
arlab doctor --repair --background --json
arlab session start --background
arlab device diagnostics --json
arlab device adb --json -- shell getprop ro.product.model
arlab session stop
```

Background preflight returns `BACKGROUND_READY` separately from `uiState`, such
as `PHONE_LOCKED` or `SCREEN_OFF`. This confirms the Companion connection, not
the ADB connection: the actual ADB command verifies its transport and selected
hardware. Android file permissions and encrypted storage access still apply.
The Companion must remain connected. No new Companion APK is required for this
PC-side session change.

Interactive commands upgrade to the existing screen wake and keyguard readiness
checks. A failed upgrade preserves background ownership. Explicitly starting
`--background` after an interactive session releases its display wake lease;
background waits and cleanup do not wake the screen. Ordinary Accessibility UI
control uses the normal phone display; background ownership does not render an
app on a hidden desktop or authenticate a secure keyguard.

## Files and ADB commands

ARLab can execute device-level ADB commands and transfer original files using the
same authorized `systemInput.adbPath` and `systemInput.devices` bindings as system
touch input. The relay verifies the selected device's physical serial and active
session owner before execution. Companion 1.2.0+ supplies the remote ADB route
described above; earlier versions require their configured direct connection.
The Companion's network identity does not replace Android's ADB authentication.

```powershell
arlab doctor --repair --json
arlab device files list /sdcard/Download --json
arlab device files read /sdcard/Download/example.txt --json
arlab device files pull /sdcard/Download/example.bin 'C:\Task\received.bin' --json
arlab device files push 'C:\Task\upload.bin' /sdcard/Download/upload.bin --json
arlab device adb --json -- shell pm list packages --user 0
arlab device adb --json -- logcat -d -t 200
arlab device adb --json --output 'C:\Task\capture.png' -- exec-out screencap -p
arlab device files read /data/user/0/com.example.debug/files/example.bin --as-package com.example.debug --output 'C:\Task\private.bin' --json
arlab session stop --json
```

Use `adb -- ...` for shell, exec-out, APK management, logs, forwarding, bug reports
and other device-level commands. ARLab flags go before `--`; subsequent arguments
pass through unchanged. Select device commands with `--device DEVICE_ID` before
`--`. Native PC host commands, including `connect`, `disconnect`, `pair`,
`start-server`, `kill-server`, `reconnect`, `attach`, `detach`, `keygen`,
`devices`, `mdns`, and `server-status`, run through the SDK without a phone
transport probe. Paths in `files` commands are
quoted for Android and must be absolute. Private app data retains Android's
permissions: `run-as` requires a debuggable package or an existing privileged route.

For PowerShell loops and arguments containing spaces, write a UTF-8 JSON array
such as `["shell","echo","space value"]` to a local file and use
`arlab device adb --args-file 'C:\Task\arguments.json' --json`. A complete UTF-8
Android shell script can instead use `--shell-file 'C:\Task\read.sh'`. These
options preserve argument boundaries and accept a UTF-8 BOM. Each is an alternative
to the other and to inline command arguments.

`files read --as-package PACKAGE` executes through that debuggable app's
`run-as` permission. `files read --as-root` uses already authorized `su` and
checks for UID 0; it does not install root or change an app. Both stream encoded
bytes to private PC temporary storage, decode the original bytes, and remove the
temporary files. No app data is staged in the phone's public storage.

`--output LOCAL_FILE` saves stdout bytes directly to a new file, without text
conversion; `--input-file LOCAL_FILE` supplies binary stdin. Existing output files
are preserved. Native pull/push follow ordinary ADB overwrite/directory semantics.
`--timeout-ms` defaults to 60000 and allows up to 600000. Inline output is bounded
to 4 MiB; use file output for larger data. Failures retain native exit codes and
stderr, and the CLI exits nonzero. Cancellation or timeout means the remote result
is unconfirmed; read back the affected state before repeating a mutation.
Structured Android command tools that print a SecurityException with native exit
code zero return `adb-android-command-failed`, while preserving that native code
and the original error text.

File reads reuse native ADB pull into a private temporary file so Windows shell
newline conversion and exec-out quoting cannot corrupt file bytes. The temporary
copy is removed after reading or saving it. On the older direct route, a rotated
wireless port is discovered only for the configured hardware serial and connected
using existing ADB keys. The Companion tunnel discovers only a listener on the
phone itself. Both routes verify hardware before dispatch. Pairing remains an
explicit Android setup operation.

Companion 1.1.8+ on Android 13+ supports guarded directional keyboard input
without ADB: `arlab device press dpad-right --expect-package PACKAGE --json`.
Use left/up/down to move focus and `dpad-center` or `enter` to activate the
verified control. Capture focus before activation and read back the resulting
screen or installer status. The normal device lease and foreground-package
guard remain enforced.

An authorized ADB connection can also send system touch input to Android installer
buttons that reject the Companion's accessibility gestures. Configure `systemInput`
in the local runtime config with an absolute `adbPath` and a `devices` map keyed by
the enrolled device ID. Each entry requires its ADB `serial` and matching physical
`hardwareSerial` (`ro.serialno`). These local identifiers must stay out of this repo.

Use `arlab device click X Y --input adb --expect-package PACKAGE --json` (or `swipe`).
The relay keeps the same exclusive device lease, verifies the physical serial,
unlocked screen and foreground package, then dispatches system input. Read back
the installer status or next screen to confirm the effect. This uses the same
Companion tunnel and granted repair capability when available; it does not pair
an unauthorized ADB key.

Android Remote Lab provides secure, on-demand control of an enrolled Android physical device from a Windows PC. It combines a signed Android Accessibility companion, a TLS rendezvous relay, a windowless Windows supervisor, an agent-device-compatible CLI, and a Codex skill for repeatable app testing.

This is an independent project and is not an official OpenAI or Tailscale product. The requested task determines which device operations to perform; the project adds no separate approval step for settings, debugging, installation or connection recovery.

## What it does

- Inspect the visible accessibility tree and use semantic selectors.
- Tap, click, enter text, swipe, launch apps, press Back/Home/Recents, and capture screenshots where Android permits.
- Keep the display awake only during an owned, bounded control session.
- Use the device's active internet connection, including an existing VPN when present; no VPN is required or changed.
- Recover the relay without visible console windows and reconnect the phone after the first secure unlock.
- Prevent two Codex threads from controlling the same phone simultaneously.

## Install

Prerequisites: Windows 10/11, Node.js 20 or newer, Tailscale with Funnel enabled, and Android 11 or newer.

```powershell
npm install -g https://github.com/heelee912/android-remote-lab/releases/latest/download/android-remote-lab.tgz
arlab setup --system
arlab skill install
```

The release tarball contains a windowless launcher rebuilt by GitHub Actions, validates its source/executable manifest during installation, and has published SHA-256 and build provenance. A source installation over Git must use HTTPS rather than the `github:` SSH shorthand on machines without GitHub credentials.

`--system` installs a startup task and requires an elevated terminal. Without elevation, use `arlab setup`; the relay then starts at user logon. Setup prints the DNS host and port to enter in the Android app.

Install `remote-companion.apk` from the latest GitHub release, enter the endpoint, enable its Accessibility service, and connect the device to the internet. Companion 1.1.9+ works over Wi-Fi, mobile data, or an existing VPN. Compare the full Device ID displayed in the app with the pending ID before enrolling it:

```powershell
arlab status
arlab enroll <device-id>
arlab doctor --repair --json
```

Compare the pending ID with the Companion's displayed ID to enroll the intended device. For migration to another Windows PC, securely copy the old `%LOCALAPPDATA%\AndroidRemoteLab\state\devices.json`, run `arlab setup --import-state <folder-containing-devices-json>` on the new PC, then change the Companion endpoint to the new DNS name and verify the same Device ID reconnects.

For multiple devices, inspect `arlab device devices --json` and run `arlab select <device-id>` in each task. Selection is saved per owner across relay restarts. Release the selecting task's current session before switching its device. Different tasks can control different devices simultaneously; one device has one active controller. `arlab session start --force` transfers an existing lease when needed. Use `--device <device-id>` on any command for an explicit target. Offline commands retain that target. Snapshot references are stored separately per owner. Phones and tablets have equal support; the task supplies the target.

### Android TV on another network

The Android TV preview is published separately from the stable `Latest` release.
Install the matching PC package and signed Companion APK from the
[`companion-tv-1.2.11` prerelease](https://github.com/heelee912/android-remote-lab/releases/tag/companion-tv-1.2.11).
Companion 1.2.10+ appears in an Android TV app launcher and accepts a validated
internet connection over Ethernet or Wi-Fi. The box must allow APK installation;
the installer may ask to allow that file browser as an installation source.
Android 13+ can also restrict a sideloaded app's Accessibility service until its
app-info menu allows restricted settings.
Companion 1.2.11+ reports its Android version and Accessibility registration,
enabled, and bound states in `arlab device diagnostics`. APK installation and
install-status use a background session even when Accessibility is disabled;
Android may still require confirmation on the TV screen.

After installation, enter the PC relay's DNS host and port in Companion, enable
its Accessibility service, and compare the full displayed Device ID with the
pending ID before `arlab enroll <device-id>`. Remote UI control needs no ADB key.
For the first native ADB connection on Android TV 13+, open its Developer options
and Wireless debugging pairing-code screen. While it is open, run:

```powershell
arlab select <tv-device-id>
arlab doctor --repair --json
arlab device adb-status --json
arlab device adb-pair SIX_DIGIT_CODE --json
arlab device adb --adb-route companion --json -- shell getprop ro.serialno
arlab session stop
```

Select the exact enrolled TV first. `adb-pair` carries the PC's ADB pairing over
the Companion's authenticated connection and saves the verified hardware binding
in the local runtime config. If it reports `paired: true, bound: false`, use
`arlab device adb-bind --json` to finish without repeating the pair. Android TV
firmware can hide or reject Wireless debugging, so native ADB and its behavior
after a reboot require a test on the physical box.

Doctor returns `READY` only when Companion `versionCode >= 7` reports both an unlocked keyguard and an active Accessibility service. `PHONE_LOCKED`, `ACCESSIBILITY_UNAVAILABLE`, `COMPANION_UPDATE_REQUIRED`, and `CONNECTED_UNVERIFIED` are non-ready states; the last two require a Companion upgrade.

After setup, close the Companion activity. Its connection service stays in the background, starts again after package replacement and boot, and reconnects after the first secure unlock. Android requires an ongoing foreground-service indicator; the Companion channel is low-importance, silent, non-vibrating, and badge-free.

## Test an app

```powershell
arlab session start 15
arlab device open com.example.app --json
arlab device snapshot -i --session example --json
arlab device screenshot C:\evidence\example.png --json
arlab session stop
```

The installed skill contains the complete workflow and a deterministic smoke-test script. It verifies the target package immediately before and after capture and applies a conservative central-viewport pixel check for unreadable, tiny, obviously blank, or visually uniform frames. This is a smoke gate, not a substitute for semantic or human visual review.

To deploy a test build without relying on persistent wireless ADB:

```powershell
arlab session start 15
try {
    arlab device diagnostics --json
    arlab device install C:\builds\app-debug.apk --json
    arlab device install-status --json
} finally {
    arlab session stop
}
```

Require Companion `versionCode >= 7` in diagnostics. The CLI hashes the APK, uploads resumable 512 KiB chunks through the authenticated Companion session, verifies every chunk and the complete SHA-256 again on the phone, and submits it to Android's `PackageInstaller`. The first run requests the per-app "install unknown apps" setting; verify the visible screen rather than assuming Android displayed it. `SUBMITTED` is not installation success: handle Android's confirmation UI, then require `install-status` to report `success` before testing the build.

Companion 1.1.7+ requests Android's ordinary automatic-update path. Android can complete an eligible Companion self-update or an update previously installed by this Companion without a confirmation. The OS checks installer/update ownership and the target app's API level; other installs return `pending-user-action`. Play Protect may also show a review while the installation is still `submitted`; complete the authorized APK's review through system input when available. An older installed Companion continues using its old installation policy until it is updated.

The CLI polls the exact upload's result after submission and self-replacement. It
reports `INSTALLED`, `INSTALL_FAILED`, or `PENDING_USER_ACTION` when confirmed.
An unconfirmed submission is never retried as a second commit. Companion can
recover a lost self-update callback by verifying the installed APK hash, version
and actual update time.

## Security model

- The phone signs a fresh server nonce, client nonce, and timestamp with a non-exportable Android Keystore P-256 key.
- Enrollment pins that public key. Authentication replay and non-monotonic command sequences are rejected.
- TLS hostname verification is mandatory.
- The control API binds only to `127.0.0.1` and uses a random 256-bit token protected by Windows ACLs.
- A per-thread owner lease serializes physical-device control.
- Password-node text is redacted; Android secure keyguard and secure screenshot surfaces are not bypassed.
- Companion 1.1.9+ requires an active connection carrying `INTERNET` and `VALIDATED` capabilities, regardless of VPN transport. Earlier Companion versions retain their VPN requirement until updated. TLS hostname verification and enrolled-device authentication apply on every connection.
- Release workflows rebuild the GUI-subsystem launcher from source, verify its manifest, publish SHA-256 files, and issue GitHub build provenance.

The owner lease prevents accidental concurrent control by cooperative Codex tasks. It is not a security boundary against another process already running as the same Windows user with access to the local API token. A command-created or default explicit session is bounded to 60 minutes and keeps the display awake during idle waits; pass an explicit minute value when a shorter or longer session is needed. The relay releases display wake state on session stop, expiry, or device disconnect.

## Exact limits

- Companion 1.2.5+ attempts background reconnection during direct boot; older versions wait for the first unlock. App UI and credential-encrypted data retain Android's lock requirements.
- Companion 1.2.0+ supplies an ADB tunnel; automatic TLS listener repair requires the optional development permission and a network Android accepts. Mobile-only recovery after reboot is device-dependent and must be verified separately.
- APKs up to 512 MiB can be transferred without ADB, but ordinary Android apps cannot guarantee unattended installation. Android may require per-installer permission, package-install confirmation, Play Protect review, or reject a conflicting signature. See the official [PackageInstaller documentation](https://developer.android.com/reference/android/content/pm/PackageInstaller.html).
- Screenshots of secure windows can fail by Android design. See the official [AccessibilityService documentation](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService.html).
- Cross-app `logcat` uses ADB. The skill can repair or provision debugging through available controls, then collect target-app logs.
- Availability depends on PC power/connectivity, Tailscale Funnel, phone power/connectivity, and a usable phone-local ADB listener. First unlock separately governs app UI and credential-encrypted data.

## Development

```powershell
npm run check
npm test
npm run validate-powershell
cd android
.\gradlew.bat lintRelease assembleDebug
```

Release signing is supplied outside the repository through `-PsigningProperties=<path>` or `ANDROID_REMOTE_LAB_SIGNING_PROPERTIES`. Keys, endpoints, device identities, tokens, local paths, and test evidence must never be committed.

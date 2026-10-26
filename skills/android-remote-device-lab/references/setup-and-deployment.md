# Setup And Deployment

## PC And Skill

```powershell
npm install -g https://github.com/heelee912/android-remote-lab/releases/latest/download/android-remote-lab.tgz
arlab setup --system
arlab skill install
arlab doctor --repair --json
```

Run `arlab setup` without `--system` when elevation is unavailable. User-logon mode cannot recover before Windows login.

## Phone Enrollment

1. Install the signed Companion APK from the GitHub release.
2. Enter the relay DNS host and TLS port printed by `arlab setup`.
3. Enable the Companion accessibility service and notification permission.
4. Use an active internet connection. Companion 1.1.9+ supports Wi-Fi, mobile data, and an existing VPN without changing VPN settings. Earlier versions retain the VPN requirement until updated.
5. Run `arlab status`, compare the full pending ID to the Device ID displayed by the Companion, then run `arlab enroll <pending-device-id>` only for an exact match.

Companion 1.2.5+ attempts its background connection during direct boot, using
device-protected endpoint preferences and its existing enrollment key. Network
availability and Android's ADB listener determine command readiness. App UI and
credential-encrypted storage retain Android's lock requirements. Older versions
wait for the first secure unlock before connecting.

The Companion activity may be closed after enrollment. Android requires its long-running connection to use a foreground service, so an ongoing low-importance service indicator can remain visible; the app configures that channel without sound, vibration, or a launcher badge.

## Move An Existing Enrollment

1. On the old PC, securely copy `%LOCALAPPDATA%\AndroidRemoteLab\state\devices.json`. It contains pinned public identities, not the local API token.
2. On the new PC, place that file alone in a temporary protected folder and run `arlab setup --system --import-state <folder>`.
3. In the Companion activity, replace the endpoint with the new setup output and save.
4. Run `arlab doctor --repair --json` and verify the connected Device ID exactly matches the migrated enrollment.
5. Remove the temporary copy and retire the old relay separately.

Uninstalling the Companion removes its Android Keystore identity and requires a new explicit enrollment. An in-place update signed by the same certificate preserves it.

## Remote ADB Provisioning

For a newly enrolled Android TV 13+ or Android phone/tablet 11+ that cannot be
plugged into the controller PC, Companion 1.2.10+ can carry Android's initial
wireless ADB pairing over the existing authenticated connection. On the device,
open Developer options > Wireless debugging > Pair device with pairing code.
Keep that screen open, select the exact enrolled device, and verify
`arlab device adb-status --json` reports a nonzero `pairingPort`. Then run
`arlab device adb-pair SIX_DIGIT_CODE --json`. The PC pairs its ADB key, connects
through the Companion, reads `ro.serialno` from that same device, and adds only
its verified binding to the local runtime config. A successful pair followed by
an interrupted connection reports `paired: true, bound: false`; resume with
`arlab device adb-bind --json` without repeating the pairing step. The code and
hardware serial belong in the local runtime only, never in this repository.
The Android TV firmware must actually expose and accept Wireless debugging;
test this on the physical box before claiming remote native ADB readiness.

Companion 1.2.0+ tunnels ADB through its authenticated TLS connection; use 1.2.1+
for nonblocking bulk transfers and explicitly provisioned TCP-listener support.
Keep the PC SDK path and enrolled-device hardware binding in local configuration.
Android authenticates the PC ADB key. To repair Wireless debugging
automatically, grant `android.permission.WRITE_SECURE_SETTINGS`
to `com.codex.remotecompanion` through that exact device's existing ADB connection.
This optional development permission is not granted by an ordinary APK install.
Companion 1.2.4+ uses it to restore `adb_enabled` and restart an enabled-but-dead
wireless listener. `adb_enabled` keeps a provisioned TCP listener alive across
Wi-Fi loss; the listener still requires ADB-key authentication through ARLab TLS.
Automatic and Companion routes also provision TCP through a recovered TLS ADB
connection before caller execution. This prepares mobile use after a reboot or
ADB service restart when Android initially restores only the TLS listener.
Verify `arlab device adb-status --json`, then `adb --adb-route companion -- ...` whose result
reports `connectionRoute: companion-tunnel`. Companion readiness alone is insufficient.

Normal ADB/files prefer a hardware-verified direct connection, then fall back to
the Companion route only when connection fails before caller execution. Use
`--adb-route companion` to verify the remote route while LAN/USB is healthy.
Companion 1.2.3+ batches TLS frames and uses bounded 128 KiB remote chunks; the PC
batches small TCP records within a bounded queue instead of waiting per packet.

For mobile-data ADB, an existing authenticated ADB connection
can run `arlab device adb --json -- tcpip 5555`; verify the TCP listener and actual
command again before changing networks. This listener also binds local network
interfaces and is not itself encrypted. Remote traffic uses the
authenticated outer ARLab TLS connection. Ordinary adbd restarts can retain TCP
configuration; `adb usb` and phone reboot can clear it.
After reboot, automatic TLS listener repair depends on Android accepting Wireless
debugging on the available network. Test this separately from ordinary reconnection.
Without Wi-Fi and without retained TCP configuration, the settings grant cannot
create a native listener on firmware that rejects wireless debugging in that state.
Companion 1.2.8+ also attempts mobile bootstrap with a temporary local-only hotspot
when no validated Wi-Fi link exists. Grant `android.permission.NEARBY_WIFI_DEVICES`
on Android 13+ to `com.codex.remotecompanion` through the selected device's working
ADB connection. On Android 11/12 grant its declared coarse/fine location permissions
and verify Android's local-hotspot requirements. The PC waits for TLS discovery,
TCP provisioning and hotspot cleanup before the caller's native command. Check
`mobileRecoveryRunning` and `mobileRecoveryError` in `adb-status`; the attempt is
bounded and runs independently of the command reader. This is a device-dependent
fallback, so test mobile-only reboot separately. Existing system/root-capable
provisioning remains another route on firmware that refuses mobile bootstrap.
For unattended enrolled devices, set and read back
`settings put global adb_allowed_connection_time 0` through the selected device's
authorized ADB connection. This retains previously authorized ADB keys across
long idle periods; it does not authorize unknown keys or alter phone unlock credentials.
Companion 1.2.6+ limits repair time and retires failed tunnel endpoints so available
Companion controls remain usable for network recovery.
Verify provisioning with actual commands and file-transfer readback on the
requested devices and network cases.

## App Build Deployment

For an installer confirmation that rejects accessibility taps, Companion 1.1.8+
on Android 13+ can use the guarded `press dpad-* --expect-package PACKAGE` keyboard
path described in the contract. Read keyboard focus before activation and require
the final installer result. Use the existing configured ADB input if available;
neither a successful keyboard dispatch nor a tap is an installation receipt.

Remote UI testing works for apps already installed on the phone. Installing a new APK requires one of these paths:

- The authenticated Companion transport: require `arlab device diagnostics --json` to report Companion `versionCode >= 7`, run `arlab device install <apk> --json`, handle the Android permission/confirmation surface, then poll `arlab device install-status --json` until it reports `success` or `failed`.
- An already-authorized ADB transport: verify the exact device, then use `adb install -r <apk>`.
- Fully managed device-owner provisioning, using Android's management setup procedure when that installation route is needed.

The Companion path accepts APKs up to 512 MiB, resumes an interrupted upload by SHA-256 ID, and verifies each 512 KiB chunk plus the complete SHA-256 on the phone. Companion 1.1.7+ requests Android's automatic-update path for eligible self/installer-owned updates; Android still requires user action for other installs or required review. Play Protect may show a review while status remains `submitted`; inspect the actual UI and complete the authorized APK's review using the configured system input when available. Older installed versions retain their previous installation policy until upgraded. If `INSTALL_PERMISSION_REQUIRED` is returned, the Companion requested its per-app unknown-source setting; verify the screen before interacting. Submission is not success; require the final installer status before testing. The CLI polls the same upload after self-replacement and never repeats an unconfirmed commit. A lost self-update callback can be recovered from the exact installed APK hash, version and update time.
Companion 1.2.11+ carries these installer commands over a background lease even when its Accessibility service is not enabled. Earlier versions still need Accessibility or an existing ADB path to receive remote APK updates.

Wireless debugging, network settings, installer permissions and device-owner setup are available provisioning routes for the requested work. Android's PackageInstaller can return `STATUS_PENDING_USER_ACTION`; privileged management installations use Android's management permissions: https://developer.android.com/reference/android/content/pm/PackageInstaller.html

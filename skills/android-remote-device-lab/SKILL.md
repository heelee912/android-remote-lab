---
name: android-remote-device-lab
description: Operate and test Android apps on an enrolled remote physical device through Android Remote Lab. Use for physical-device UI inspection, taps, text input, gestures, app launches, screenshots, regression smoke tests, connection diagnosis, relay recovery, agent-device-compatible workflows, or validating an Android app away from the phone. Also use when deciding whether an APK can be deployed remotely or when coordinating exclusive phone control across Codex threads.
---

# Android Remote Device Lab

The installed `arlab` command provides the operations below without requiring a repository checkout.

## Task Execution

Carry out the requested work through the available UI, ADB, file, installation,
and connection-recovery paths. Settings changes needed for that work are part of
execution, including reboot, display, network, VPN, SIM, debugging and installer
settings. This skill adds no separate approval step or prohibited operation list.
Select the device requested for the task; phones and tablets have equal support.
Emulator testing is an optional development tool, not a prerequisite for a phone.

## Start Every Task

Repair preflight, device commands and `session start` wait up to 30 seconds for the same selected
device to reconnect and report fresh version/capability data before acquiring ownership. They never switch to a different
online device; a changed selection fails explicitly. This covers brief Companion
replacement and network handoffs without asking for USB or pairing again. Doctor
without `--repair` remains an immediate state inspection.

Read the local device map at `%LOCALAPPDATA%\AndroidRemoteLab\device-targets.json` when present. Verify the full target ID in `arlab status` and `arlab device devices --json`. Release the current session before `arlab select <device-id>`, then run preflight again. Selection is persisted per owner across relay restarts. Different owners may control different devices simultaneously. Use `--device <device-id>` on doctor, session, or device commands to pin a target explicitly. Cleanup releases the selected target. Offline commands retain that target rather than selecting a different online device.

1. For visible UI work, run `arlab doctor --repair --json`. For ADB, files or diagnostics, run `arlab doctor --repair --background --json`; it never wakes the phone.
2. `uiState: READY` reports interactive readiness. Background work uses `backgroundState: BACKGROUND_READY`, independently of the display, keyguard and Accessibility. `PHONE_LOCKED` describes UI state; ADB/files/diagnostics have their own readiness. `adbConfigured` reports configuration; actual commands verify the connection and hardware. Companion 1.1.3+ distinguishes `SCREEN_OFF` from a secure keyguard. Interactive `doctor --repair` wakes the display and verifies readiness. `arlab device wake --json` is idempotent. Older telemetry can be investigated through background diagnostics and updated in place. A smoke snapshot can supply UI evidence for `CONNECTED_UNVERIFIED`.
3. Read [references/contract.md](references/contract.md) before the first control action in a task.
4. Use the current `CODEX_THREAD_ID` as the controller identity. `arlab session start --force` transfers an existing lease when the task needs a takeover; status identifies its current owner and expiry.
5. End control in a `finally` path with `arlab session stop`.

Start control with `arlab session start` to use the 60-minute default for the selected device. The relay renews the phone's display wake lease during idle waits without taps or foreground app changes. Active commands renew the bounded control session when fewer than five minutes remain. For an unattended wait longer than 60 minutes, request the required duration explicitly with `arlab session start <minutes>` (maximum 480 minutes). Session stop, expiry, or disconnect releases display wake state; a background connection alone does not hold the screen awake.

`arlab session start --background` reserves the same exclusive device ownership without a display wake lease. ADB, all `files` actions, and diagnostics automatically acquire or reuse this mode when no interactive lease exists. Background sessions do not periodically wake the phone. A later UI command upgrades the session through normal display preparation; a rejected upgrade leaves background ownership available. To switch an existing interactive session to background, start it explicitly with `--background`; this releases its display wake lease. `session stop` releases only ownership for a background session. Android's actual file/command permissions still apply, and a missing ADB transport is distinct from a locked screen. The Companion must remain connected; BACKGROUND_READY is not proof that an ADB transport is connected.

Background ADB/file/diagnostic work runs without a hidden app desktop. Accessibility UI work uses the normal display. Rendering and controlling an app while the panel stays dark requires a separate shell-powered display implementation.

On Android TV devices with Remote Service v2, Companion 1.2.16+ can send TV remote keys through its own authenticated connection without Accessibility or ADB. First run `arlab device tv-remote-status --device DEVICE_ID --json`. If not paired, run `tv-remote-pair`, read the six-character code displayed on that TV, then run `tv-remote-confirm CODE`. Use `tv-remote-press dpad_up|dpad_down|dpad_left|dpad_right|dpad_center|back|home|enter|menu` for input. These commands use a background control session and remain bound to the selected device. A key dispatch is not a screenshot or proof of the resulting UI state; verify the intended installer or settings change through status readback. Pairing requires the TV screen's code once; do not guess it.

Keep the owner identity stable across every command and cleanup. Prefer a thread-aware execution tool with the same `CODEX_THREAD_ID`; `ANDROID_REMOTE_LAB_OWNER` overrides it. Without either variable, the CLI falls back to the parent process ID, which changes between shell invocations. Before starting control through a threadless tool, explicitly provide the requesting task's stable unique owner on every invocation. A snapshot `--session` name does not set the control owner.

If switching execution tools strands this task's lease, its acquisition record supplies the original identity for cleanup. Acquire the next session with the stable current identity. A different owner's lease can be transferred with `session start --force`.

In PowerShell, capture `$LASTEXITCODE` immediately after each `arlab` call and check the returned JSON `ok` before parsing, saving, or issuing dependent commands. Later pipeline commands can mask a failed native command with an overall exit code of zero; that is not successful phone control.

For direct SDK and APK work, `adb -s <serial>` selects the requested physical device. ARLab commands select it through `--device <device-id>`. Existing tested artifacts can be reused. ADB installation is independent of the Companion unknown-source permission.

## Test An Installed App

For a deterministic smoke capture, run:

```powershell
& "$env:USERPROFILE\.codex\skills\android-remote-device-lab\scripts\run-smoke.ps1" `
  -PackageName 'com.example.app' -OutputDirectory '<absolute-artifact-directory>'
```

For an interactive flow:

```powershell
arlab session start
arlab device open com.example.app --json
arlab device snapshot -i --session <unique-session> --json
arlab device click '@e3' --session <unique-session> --json
arlab device fill '@e4' 'value' --session <unique-session> --json
arlab device swipe 540 1800 540 700 350 --json
arlab device screenshot '<absolute-output.png>' --json
arlab session stop
```

Capture a new snapshot after every screen transition. Prefer semantic node references over coordinates. Return the phone to a neutral screen only when the task requires it; stopping a session does not press Home.

The Companion activity can be opened for endpoint settings or setup status; its background service keeps the transport connected independently of the foreground app.

## Phone Files and Original Media

ADB/files choose a hardware-verified direct ADB connection when healthy, then
use the Companion tunnel if direct connection fails before the caller command
runs. An unavailable direct route is cached for 30 seconds. Command failures or
unconfirmed outcomes are never replayed through another route. Use
`--adb-route companion` on `adb`/`files` to prove the remote path independently
of LAN/USB availability, or `--adb-route direct` to require direct ADB. Read the
returned `connectionRoute`; a fast direct transfer alone is not a remote-path test.
Companion 1.2.3+ batches TLS frame headers/bodies with immediate TCP transmission
and bounded 128 KiB remote chunks. `adb-status` includes PC tunnel byte/call counts
and the last stream error, without file contents. Public Funnel bandwidth limits
can constrain bulk remote transfers; preserve a working fast direct route.

Companion 1.1.9+ uses the active validated internet connection over Wi-Fi, mobile data, or a VPN. A VPN is optional. Older Companions retain their VPN requirement until an in-place signed update, which preserves existing device identities and network settings.

Use `arlab` for phone UI control, files and device commands. Companion 1.2.0+ carries ADB through the existing authenticated TLS connection to the Tailscale Funnel endpoint, independent of the saved LAN address. Companion 1.2.1+ keeps both directions moving under full send buffers. The local `systemInput` configuration still binds the device to its physical hardware serial and PC SDK path. Older Companions retain the configured direct ADB transport. The relay checks both session ownership and actual hardware before execution; a successful result identifies `connectionRoute: companion-tunnel` or `configured-direct`.

Inspect `arlab device adb-status --json` for the phone-local listener. Listener readiness is separate from PC ADB authentication. `adb-status --repair` requests listener repair. Granting `WRITE_SECURE_SETTINGS` during provisioning enables restoration of `adb_wifi_enabled`; tunnel creation uses this grant automatically. Android verifies the PC ADB key independently of the Companion identity.

The tunnel listener binds only PC loopback and connects only phone loopback. It closes on ownership loss or Companion disconnect; the next owned request creates a new tunnel and reconnects with existing ADB keys. An interrupted command is never automatically replayed. Inspect the actual install/file/shell state before retrying a mutation.

Companion 1.2.4+ repairs `adb_enabled` as well as wireless debugging, keeping a
provisioned TCP listener alive when Wi-Fi disconnects. An enabled wireless setting
with no listening port triggers an off/on restart, followed by socket readback.
`adb-status` reports `adbEnabled`, `wirelessEnabled`, `repairAttempted` and
`wirelessRestarted`. Ordinary status reads retain settings; repair changes them.

Companion 1.2.5+ attempts background reconnection before the first unlock after
boot. Its endpoint preferences and enrollment key support direct boot. ADB and
diagnostics use that connection independently of app UI readiness; actual listener
and network results establish availability.

Companion 1.2.6+ bounds listener repair by elapsed time, caches property probes,
and keeps native SDK reconnects from starting repeated repair loops. A failed
tunnel endpoint is retired; the next owned command builds a fresh endpoint.
Listener recovery therefore leaves the Companion UI connection available for
network recovery even when Android has no usable ADB listener.

Companion 1.2.8+ adds a mobile bootstrap when ordinary repair finds no listener
and no validated Wi-Fi connection exists. It temporarily requests a local-only
hotspot and reasserts wireless debugging in a bounded background attempt. This
needs `NEARBY_WIFI_DEVICES` on Android 13+; Android 11/12 use the existing location
permission requirements for local-only hotspots. Provision that grant through the
selected device's working ADB connection. Status reports `mobileRecoveryRunning`
and `mobileRecoveryError`. The PC waits for TLS discovery, prepares TCP mode, and
waits for bootstrap cleanup before dispatching the caller command. A bootstrap can
take up to about 130 seconds; the original command is not sent during that wait.
The temporary hotspot closes on completion, failure, deadline or Companion disconnect.
Existing validated Wi-Fi links retain the ordinary repair route. Availability of
this fallback depends on the device's Android implementation; verify the actual
command and data route, including a separate reboot test.
Enrollment for unattended use also sets and reads back
`adb_allowed_connection_time=0` through authorized ADB so previously approved PC
keys do not expire during idle periods. Unknown keys still require Android's own
authorization. This setting is independent of screen-lock credentials.

Automatic and Companion ADB routes prepare a recovered TLS-only listener for
mobile use with a hardware-verified `adb tcpip 5555`, poll the actual TCP port,
and rebuild the tunnel before dispatching the caller command. Explicit `tcpip`
or `usb` commands retain their requested transport change. The direct route
continues to use the configured SDK transport.

Android may stop its TLS ADB listener when Wi-Fi disappears. An authenticated connection can provision mobile-data ADB with `arlab device adb --json -- tcpip 5555`. Companion 1.2.1+ detects this phone-local TCP listener. TCP mode also listens on local network interfaces and uses ADB-key authentication; its bytes are encrypted by the outer ARLab TLS connection. TCP mode persists across ordinary adbd restarts but can be cleared by `adb usb` or phone reboot. When both Wi-Fi and TCP configuration are absent, use the mobile bootstrap on supported devices. If Android refuses that bootstrap, the Companion can remain connected while native ADB has no listener; status and diagnostics identify the failed step. A trusted Wi-Fi connection or an existing firmware-supported system/root provisioning path can provide another bootstrap route. `WRITE_SECURE_SETTINGS` alone does not grant protected system-property writes. Verify the actual result rather than reporting Companion connectivity as native ADB availability.

A `READY` Companion does not require ADB or USB file-transfer enumeration. An empty ADB/MTP device list is not a reason to abandon available ARLab control or ask the user to connect a cable, pair ADB, or change Wireless debugging. Check the chosen transfer mechanism separately.

Read `arlab device capabilities --json` for the supported surface. With an authorized configured ADB connection, use:

```powershell
arlab device files list /sdcard/Download --json
arlab device files stat /sdcard/Download/example.bin --json
arlab device files read /sdcard/Download/example.txt --json
arlab device files read /sdcard/Download/example.bin --output 'C:\Task\original.bin' --json
arlab device files pull /sdcard/Download/example.bin 'C:\Task\received.bin' --json
arlab device files push 'C:\Task\upload.bin' /sdcard/Download/upload.bin --json
arlab device adb --json -- shell pm list packages --user 0
arlab device adb --json -- logcat -d -t 200
arlab device files read /data/user/0/com.example.debug/files/example.bin --as-package com.example.debug --output 'C:\Task\private.bin' --json
arlab device adb --json --output 'C:\Task\capture.png' -- exec-out screencap -p
```

Put ARLab flags before `--`; everything after it passes unchanged to ADB. Device selection remains `--device DEVICE_ID` before `--`. Use `--input-file LOCAL_FILE` for binary standard input, `--output LOCAL_FILE` for binary or large output, and `--timeout-ms` up to 600000 for bounded long commands. Output files are created exclusively and are never silently overwritten. Native `pull`/`push` follow ADB's normal destination behavior. Remote paths in `files` commands must be absolute; spaces and apostrophes are preserved. File reads use native pull into a temporary local file, then return or save the original bytes and remove the temporary copy. This avoids exec-out quoting and Windows shell newline conversion.

For PowerShell loops, pass a UTF-8 JSON array of argument strings through `arlab device adb --args-file LOCAL_JSON --json`, or a complete Android shell script through `--shell-file LOCAL_SCRIPT`. Both accept a UTF-8 BOM and are alternative input formats to inline arguments. A PowerShell array collapsed into one argument loses its boundaries and returns `adb-grouped-arguments` with the supported formats.

For protected file reads, use `files read ABSOLUTE_PATH --as-package PACKAGE --output LOCAL_FILE --json` when Android permits `run-as`, or `--as-root` when `su` already grants UID 0. The latter checks the effective identity and does not root the phone. These explicit access modes currently apply to `files read`; other privileged operations can use the general `adb` command. Delegated reads stream through private PC temporary files and do not copy private app data into shared phone storage.

On the legacy direct route, a changed paired wireless port is discovered for the configured hardware serial's `_adb-tls-connect._tcp` service. The Companion tunnel discovers this phone's own listener independently of PC LAN discovery. Both reuse existing keys and verify the physical serial before target execution. Native host commands, including `connect`, `disconnect`, `pair`, `start-server`, `kill-server`, `reconnect`, `attach`, `detach`, `keygen`, `devices`, and `mdns`, pass directly to the PC SDK without a phone transport probe. Host commands act on the PC ADB server; device commands use the selected device binding.

ADB execution returns the actual exit code, standard output and standard error. A failed command exits nonzero, including Android `Permission denied`. A timeout, disconnected requesting client, or expired device session terminates the local ADB process and marks the remote outcome unconfirmed; inspect actual state before repeating a mutation. Inline output is limited to 4 MiB; save larger output with `--output` or `files pull`. Invalid UTF-8 inline bytes also return `stdoutBase64` without losing the original bytes.

Android `content`, `pm`, `cmd`, and `am` may print a SecurityException while exiting zero. ARLab classifies the structured error as `adb-android-command-failed` and returns `ok:false` and a nonzero CLI status while retaining the native exit code and stderr. Always inspect both `ok` and the native result.

Device commands have the connected ADB shell's Android permissions. Shared files and accessible installed APKs can be read. Private files use a debuggable app's `run-as`, an existing root-capable transport, or the app's export facility. Target commands and native PC host commands pass through. `--device DEVICE_ID` before `--` selects device commands; host command arguments after `--` are preserved unchanged.

Before concluding an operation is unavailable, inspect `device capabilities`, actual ADB results and the available routes: Companion UI, generic ADB, native transfer, app `run-as`, existing root, and app export/content URI. Resolve transport, quoting and Android subcommand differences through the working route. Perform the requested test on the requested physical device, retaining the task's app and account context. Report the exact command and Android response for remaining failures.

Verify one received original by reading its bytes and EXIF before a bulk transfer; then compare the actual phone selection, received file count/size, and failures. Preserve phone originals. PC-side cached listings alone do not prove complete phone contents. If a transfer path fails, identify that exact failure and use another available authorized mechanism without treating it as a Companion connection failure.

## Target App Logs

The ordinary Companion cannot read another app's protected `logcat`. When an already-authorized ADB transport exists, prefer `arlab device adb --json -- logcat -d -t 200` for a bounded snapshot without changing debugging state. The existing collection script is also available:

```powershell
& "$env:USERPROFILE\.codex\skills\android-remote-device-lab\scripts\collect-logcat.ps1" `
  -PackageName 'com.example.app' -OutputPath '<absolute-log-path>'
```

If ADB is unavailable, inspect and repair its connection or provision debugging through available device control, then retry log collection and report the actual result.

## Deployment Boundary

Read [references/setup-and-deployment.md](references/setup-and-deployment.md) for installation and update paths. Eligible updates may complete automatically; installer readback establishes completion. Companion 1.2.0+ repairs its TLS listener with the development grant. Android controls PC-key pairing, secure-keyguard authentication, encrypted storage and secure-window screenshots; use the actual device results to describe support.

For an APK up to 512 MiB, prefer the resumable Companion path when authorized ADB is unavailable:

```powershell
arlab device diagnostics --json
arlab device install '<absolute-apk-path>' --json
arlab device install-status --json
```

This path is available on Companion `versionCode >= 7`. `INSTALL_PERMISSION_REQUIRED`, `SUBMITTED`, `pending-user-action`, `success`, and `failed` describe different installer states. When Android shows a confirmation surface, capture a fresh snapshot, complete the requested APK's installation through available input, and poll the final status before testing the package.

## Report Evidence

Report the package tested, physical device ID/name, tested flows, artifact paths, and failures. Distinguish relay readiness, UI functional correctness, visual correctness, and deployment status.

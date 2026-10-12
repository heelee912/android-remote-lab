---
name: android-remote-device-lab
description: Operate and test Android apps on an enrolled remote physical device through Android Remote Lab. Use for physical-device UI inspection, taps, text input, gestures, app launches, screenshots, regression smoke tests, connection diagnosis, relay recovery, agent-device-compatible workflows, or validating an Android app away from the phone. Also use when deciding whether an APK can be deployed remotely or when coordinating exclusive phone control across Codex threads.
---

# Android Remote Device Lab

Use only the installed `arlab` command. Do not depend on a repository checkout or private path.

## Start Every Task

For ordinary app development, use the enrolled test tablet first. Reserve the personal phone for phone-specific flows explicitly requested by the user. Read the local device map at `%LOCALAPPDATA%\AndroidRemoteLab\device-targets.json` when present; it is local configuration, not part of a public release. Verify the full target ID in `arlab status` and `arlab device devices --json`. Stop the current session before `arlab select <device-id>`, then run preflight again. Selection persists across relay restarts. An offline tablet never falls back to the phone. Do not reopen a user-completed review merely because a tablet is now available.

1. Run `arlab doctor --repair --json`.
2. Continue interactive control only when `state` is `READY`. Companion 1.1.3+ reports `SCREEN_OFF` separately from a secure keyguard; `doctor --repair` acquires the normal exclusive session to wake it and verifies readiness. `arlab device wake --json` is idempotent and never toggles the power button. A legacy Companion that reports only `keyguardLocked` cannot distinguish an unsecured swipe screen from a secure lock; upgrade it after a one-time manual wake. For `CONNECTED_UNVERIFIED`, permit only the deterministic smoke script as a legacy compatibility gate, then upgrade the Companion. Diagnose every other state before issuing UI commands.
3. Read [references/contract.md](references/contract.md) before the first control action in a task.
4. Use the current `CODEX_THREAD_ID` as the implicit exclusive owner. Never force takeover unless the user explicitly resolves the conflict.
5. End control in a `finally` path with `arlab session stop`.

Start control with `arlab session start` to use the 60-minute default. The relay renews the phone's display wake lease during idle waits without taps or foreground app changes. Active commands renew the bounded control session when fewer than five minutes remain. For an unattended wait longer than 60 minutes, request the required duration explicitly with `arlab session start <minutes>` (maximum 480 minutes). Session stop, expiry, or disconnect releases display wake state; a background connection alone does not hold the screen awake.

Keep the owner identity stable across every command and cleanup. Prefer a thread-aware execution tool with the same `CODEX_THREAD_ID`; `ANDROID_REMOTE_LAB_OWNER` overrides it. Without either variable, the CLI falls back to the parent process ID, which changes between shell invocations. Before starting control through a threadless tool, explicitly provide the requesting task's stable unique owner on every invocation. A snapshot `--session` name does not set the control owner.

If switching execution tools strands a lease, establish from the acquisition record that it belongs to this same task before releasing it with its original owner. Then acquire with the stable current identity. Never adopt an owner merely because `arlab status` displays it.

In PowerShell, capture `$LASTEXITCODE` immediately after each `arlab` call and check the returned JSON `ok` before parsing, saving, or issuing dependent commands. Later pipeline commands can mask a failed native command with an overall exit code of zero; that is not successful phone control.

For SDK and APK work, select the exact authorized tablet serial on every ADB invocation (`adb -s <serial>`); never rely on the first device or use unqualified `adb shell`/`adb install`. Emulator testing comes before final physical-device installation when developing an app. Reuse existing tested artifacts rather than rebuilding or reinstalling unchanged APKs. ADB installation does not require granting the Companion unknown-source permission.

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

The Companion activity does not need to remain visible. Its background connection service is the transport; do not open the Companion itself unless changing endpoint settings or collecting its setup status.

## Phone Files and Original Media

Use `arlab` for phone UI control. File transport is a separate choice: reuse an available authorized transfer mechanism such as Windows mobile-device storage or an installed app's share/export flow. ARLab can operate file selection, sharing, and the required phone screens; it does not need to implement the byte-transfer protocol itself. Prefer a working existing transfer path over building a new one.

A `READY` Companion does not require ADB or USB file-transfer enumeration. An empty ADB/MTP device list is not a reason to abandon available ARLab control or ask the user to connect a cable, pair ADB, or change Wireless debugging. Check the chosen transfer mechanism separately.

Read `arlab device capabilities --json` before assuming a direct file-transfer command exists. The current surface supports UI control and APK installation, not arbitrary file listing or pulling original media to the PC. Do not invent a `pull` command or treat a screenshot as the original file.

Verify one received original by reading its bytes and EXIF before a bulk transfer; then compare the actual phone selection, received file count/size, and failures. Preserve phone originals. PC-side cached listings alone do not prove complete phone contents. If a transfer path fails, identify that exact failure and use another available authorized mechanism without treating it as a Companion connection failure.

## Target App Logs

The Companion cannot read another app's protected `logcat`. When an already-authorized ADB transport exists, collect a bounded snapshot without changing debugging state:

```powershell
& "$env:USERPROFILE\.codex\skills\android-remote-device-lab\scripts\collect-logcat.ps1" `
  -PackageName 'com.example.app' -OutputPath '<absolute-log-path>'
```

If no authorized ADB device exists, report target-app logs as unavailable through this transport. Do not enable Wireless debugging merely to satisfy log collection.

## Deployment Boundary

Read [references/setup-and-deployment.md](references/setup-and-deployment.md) before installing or updating an APK. Do not claim unattended APK installation, secure-keyguard bypass, pre-unlock UI control, secure-window screenshots, or automatic wireless-ADB recovery.

For an APK up to 512 MiB, prefer the resumable Companion path when authorized ADB is unavailable:

```powershell
arlab device diagnostics --json
arlab device install '<absolute-apk-path>' --json
arlab device install-status --json
```

Require Companion `versionCode >= 7` before using this path. Treat `INSTALL_PERMISSION_REQUIRED`, `SUBMITTED`, `pending-user-action`, `success`, and `failed` as distinct states. A transfer or submission is never proof of installation. When Android shows a confirmation surface, capture a fresh snapshot, complete only the explicitly authorized install, and poll until the authoritative status is `success` before launching the target package.

## Report Evidence

Report the package tested, physical device ID/name, tested flows, artifact paths, and failures. Distinguish relay readiness, UI functional correctness, visual correctness, and deployment status.

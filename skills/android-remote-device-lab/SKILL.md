---
name: android-remote-device-lab
description: Operate and test Android apps on an enrolled remote physical device through Android Remote Lab. Use for physical-device UI inspection, taps, text input, gestures, app launches, screenshots, regression smoke tests, connection diagnosis, relay recovery, agent-device-compatible workflows, or validating an Android app away from the phone. Also use when deciding whether an APK can be deployed remotely or when coordinating exclusive phone control across Codex threads.
---

# Android Remote Device Lab

Use only the installed `arlab` command. Do not depend on a repository checkout or private path.

## Start Every Task

1. Run `arlab doctor --repair --json`.
2. Continue interactive control only when `state` is `READY`. For `CONNECTED_UNVERIFIED`, permit only the deterministic smoke script as a legacy compatibility gate, then upgrade the Companion. Diagnose every other state before issuing UI commands.
3. Read [references/contract.md](references/contract.md) before the first control action in a task.
4. Use the current `CODEX_THREAD_ID` as the implicit exclusive owner. Never force takeover unless the user explicitly resolves the conflict.
5. End control in a `finally` path with `arlab session stop`.

## Test An Installed App

For a deterministic smoke capture, run:

```powershell
& "$env:USERPROFILE\.codex\skills\android-remote-device-lab\scripts\run-smoke.ps1" `
  -PackageName 'com.example.app' -OutputDirectory '<absolute-artifact-directory>'
```

For an interactive flow:

```powershell
arlab session start 15
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

## Deployment Boundary

Read [references/setup-and-deployment.md](references/setup-and-deployment.md) before installing or updating an APK. Do not claim unattended APK installation, secure-keyguard bypass, pre-unlock UI control, secure-window screenshots, or automatic wireless-ADB recovery.

For an APK up to 512 MiB, prefer the resumable Companion path when authorized ADB is unavailable:

```powershell
arlab device diagnostics --json
arlab device install '<absolute-apk-path>' --json
arlab device install-status --json
```

Require Companion `versionCode >= 6` before using this path. Treat `INSTALL_PERMISSION_REQUIRED`, `SUBMITTED`, `pending-user-action`, `success`, and `failed` as distinct states. A transfer or submission is never proof of installation. When Android shows a confirmation surface, capture a fresh snapshot, complete only the explicitly authorized install, and poll until the authoritative status is `success` before launching the target package.

## Report Evidence

Report the package tested, physical device ID/name, tested flows, artifact paths, and failures. Distinguish relay readiness, UI functional correctness, visual correctness, and deployment status.

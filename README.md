# Android Remote Lab

Android Remote Lab provides secure, on-demand control of an enrolled Android physical device from a Windows PC. It combines a signed Android Accessibility companion, a TLS rendezvous relay, a windowless Windows supervisor, an agent-device-compatible CLI, and a Codex skill for repeatable app testing.

Use it only with devices and networks you own or are explicitly authorized to administer. This is an independent project and is not an official OpenAI or Tailscale product.

## What it does

- Inspect the visible accessibility tree and use semantic selectors.
- Tap, click, enter text, swipe, launch apps, press Back/Home/Recents, and capture screenshots where Android permits.
- Keep the display awake only during an owned, bounded control session.
- Route the phone connection through its existing validated Android VPN instead of replacing it.
- Recover the relay without visible console windows and reconnect the phone after the first secure unlock.
- Prevent two Codex threads from controlling the same phone simultaneously.

## Install

Prerequisites: Windows 10/11, Node.js 20 or newer, Tailscale with Funnel enabled, and Android 11 or newer.

```powershell
npm install -g github:heelee912/android-remote-lab
arlab setup --system
arlab skill install
```

`--system` installs a startup task and requires an elevated terminal. Without elevation, use `arlab setup`; the relay then starts at user logon. Setup prints the DNS host and port to enter in the Android app.

Install `remote-companion.apk` from the latest GitHub release, enter the endpoint, enable its Accessibility service, and keep the intended Android VPN active. Then enroll the pending device:

```powershell
arlab status
arlab enroll <device-id>
arlab doctor --repair --json
```

Doctor returns `READY` only when the current Companion reports both an unlocked keyguard and an active Accessibility service. `PHONE_LOCKED`, `ACCESSIBILITY_UNAVAILABLE`, and `CONNECTED_UNVERIFIED` are non-ready states; the last state indicates an older Companion that should be upgraded.

After setup, close the Companion activity. Its connection service stays in the background, starts again after package replacement and boot, and reconnects after the first secure unlock. Android requires an ongoing foreground-service indicator; the Companion channel is low-importance, silent, non-vibrating, and badge-free.

## Test an app

```powershell
arlab session start 15
arlab device open com.example.app --json
arlab device snapshot -i --session example --json
arlab device screenshot C:\evidence\example.png --json
arlab session stop
```

The installed skill contains the complete workflow and a deterministic smoke-test script. The smoke test verifies the target package immediately before and after its screenshot so a concurrent screen change cannot be reported as a successful capture.

To deploy a test build without relying on persistent wireless ADB:

```powershell
arlab session start 15
arlab device diagnostics --json
arlab device install C:\builds\app-debug.apk --json
arlab device install-status --json
```

Require Companion `versionCode >= 6` in diagnostics. The CLI hashes the APK, uploads resumable 512 KiB chunks through the authenticated Companion session, verifies every chunk and the complete SHA-256 again on the phone, and submits it to Android's `PackageInstaller`. The first run requests the per-app "install unknown apps" setting; verify the visible screen rather than assuming Android displayed it. `SUBMITTED` is not installation success: handle Android's confirmation UI, then require `install-status` to report `success` before testing the build.

## Security model

- The phone signs a fresh server nonce, client nonce, and timestamp with a non-exportable Android Keystore P-256 key.
- Enrollment pins that public key. Authentication replay and non-monotonic command sequences are rejected.
- TLS hostname verification is mandatory.
- The control API binds only to `127.0.0.1` and uses a random 256-bit token protected by Windows ACLs.
- A per-thread owner lease serializes physical-device control.
- Password-node text is redacted; Android secure keyguard and secure screenshot surfaces are not bypassed.
- The Android app refuses to connect without an active VPN carrying `INTERNET` and `VALIDATED` capabilities.

## Exact limits

- A rebooted phone reconnects only after the first secure unlock. Pre-unlock UI control is not supported.
- Wireless ADB is not the operational transport and is not automatically restored after reboot.
- APKs up to 512 MiB can be transferred without ADB, but ordinary Android apps cannot guarantee unattended installation. Android may require per-installer permission, package-install confirmation, Play Protect review, or reject a conflicting signature. See the official [PackageInstaller documentation](https://developer.android.com/reference/android/content/pm/PackageInstaller.html).
- Screenshots of secure windows can fail by Android design. See the official [AccessibilityService documentation](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService.html).
- Availability still depends on PC power/connectivity, Tailscale Funnel, phone power/connectivity, the configured VPN, and first unlock after reboot.

## Development

```powershell
npm run check
npm test
npm run validate-powershell
cd android
.\gradlew.bat lintRelease assembleDebug
```

Release signing is supplied outside the repository through `-PsigningProperties=<path>` or `ANDROID_REMOTE_LAB_SIGNING_PROPERTIES`. Keys, endpoints, device identities, tokens, local paths, and test evidence must never be committed.

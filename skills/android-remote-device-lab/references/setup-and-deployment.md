# Setup And Deployment

## PC And Skill

```powershell
npm install -g github:heelee912/android-remote-lab
arlab setup --system
arlab skill install
arlab doctor --repair --json
```

Run `arlab setup` without `--system` when elevation is unavailable. User-logon mode cannot recover before Windows login.

## Phone Enrollment

1. Install the signed Companion APK from the GitHub release.
2. Enter the relay DNS host and TLS port printed by `arlab setup`.
3. Enable the Companion accessibility service and notification permission.
4. Keep the intended full Android VPN active.
5. Run `arlab status`, compare the full pending ID to the Device ID displayed by the Companion, then run `arlab enroll <pending-device-id>` only for an exact match.

The device automatically reconnects after its first secure unlock following reboot. It cannot provide pre-unlock UI control.

The Companion activity may be closed after enrollment. Android requires its long-running connection to use a foreground service, so an ongoing low-importance service indicator can remain visible; the app configures that channel without sound, vibration, or a launcher badge.

## Move An Existing Enrollment

1. On the old PC, securely copy `%LOCALAPPDATA%\AndroidRemoteLab\state\devices.json`. It contains pinned public identities, not the local API token.
2. On the new PC, place that file alone in a temporary protected folder and run `arlab setup --system --import-state <folder>`.
3. In the Companion activity, replace the endpoint with the new setup output and save.
4. Run `arlab doctor --repair --json` and verify the connected Device ID exactly matches the migrated enrollment.
5. Remove the temporary copy and retire the old relay separately.

Uninstalling the Companion removes its Android Keystore identity and requires a new explicit enrollment. An in-place update signed by the same certificate preserves it.

## App Build Deployment

Remote UI testing works for apps already installed on the phone. Installing a new APK requires one of these paths:

- The authenticated Companion transport: require `arlab device diagnostics --json` to report Companion `versionCode >= 7`, run `arlab device install <apk> --json`, handle the Android permission/confirmation surface, then poll `arlab device install-status --json` until it reports `success` or `failed`.
- An already-authorized ADB transport: verify the exact device, then use `adb install -r <apk>`.
- Fully managed device-owner provisioning, which materially changes device ownership and is outside this skill.

The Companion path accepts APKs up to 512 MiB, resumes an interrupted upload by SHA-256 ID, verifies each 512 KiB chunk plus the complete SHA-256 on the phone, and deliberately requests Android user action. If `INSTALL_PERMISSION_REQUIRED` is returned, the Companion requested its per-app unknown-source setting; verify the screen before interacting. Submission is not success; require the final installer status before testing.

Do not enable Wireless debugging, alter network state, leave an unneeded unknown-source permission enabled, or provision device-owner mode without explicit user approval. Android's PackageInstaller documentation states that ordinary installers may receive `STATUS_PENDING_USER_ACTION`; silent installation is reserved for privileged management cases: https://developer.android.com/reference/android/content/pm/PackageInstaller.html

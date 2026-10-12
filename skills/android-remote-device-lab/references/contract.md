# Control Contract

## Invariants

- `arlab doctor --repair --json` is the authoritative preflight.
- One Codex thread owns the phone at a time. The relay rejects commands from another thread while the owner's lease is active.
- Multiple enrolled devices may remain connected. Only the explicitly selected device receives commands or display wake leases. `arlab select <device-id>` requires the current session to be stopped; selection is persisted, with no fallback to another device when it is offline. Snapshots bind their element references to the originating device.
- Ordinary device commands maintain a bounded 60-minute display lease by default, including idle waits between commands. `arlab session stop` releases it immediately; disconnect and expiry also release it. Starting a session with an explicit minute value overrides the default within the relay's bounded limit.
- The Android Companion connects only through an active, validated Android VPN. It does not replace or disable that VPN.
- The local control API binds only to loopback and requires a random token. The public endpoint exposes only the authenticated device ingress.
- Password nodes are redacted. Android secure keyguard and secure screenshot surfaces remain enforced.

## Legacy lock telemetry

`LEGACY_LOCK_UNVERIFIED` means the older Companion only reports keyguard visibility. It is not proof of a PIN/password lock. Do not issue legacy UI commands on this ambiguous state; after one physical wake, update through the supported installer. Modern display-only `wake` verifies the screen is interactive without dismissing a secure keyguard. UI control still requires unlocked user storage and no secure lock.

## Display readiness

Companion 1.1.3+ reports `screenInteractive`, `secureKeyguardLocked`, and `userUnlocked`. `SCREEN_OFF` means a connected unlocked device is asleep; repair wakes it via the existing bounded wake lease and confirms actual interactive state. `KEYGUARD_SHOWING` is an unsecured swipe screen. Only a screen Android reports as not device-locked may be dismissed with requestDismissKeyguard, including an already trusted swipe state. Actual authentication is never performed automatically. `PHONE_LOCKED` still blocks all UI commands; no PIN, password, trust, or biometric bypass is provided. Existing awake screens are kept awake without power toggles.

## Doctor States

- `READY`: relay, Funnel, process supervision, and enrolled phone are healthy.
- `PHONE_LOCKED`: the secure keyguard is active. Stop; never bypass it.
- `ACCESSIBILITY_UNAVAILABLE`: the Companion is connected but its Accessibility service is not ready.
- `COMPANION_UPDATE_REQUIRED`: readiness is reported by a Companion older than the minimum hardened protocol version. Upgrade before control.
- `CONNECTED_UNVERIFIED`: a legacy Companion is connected but does not report keyguard and Accessibility readiness. Use a smoke snapshot as the gate; upgrade the Companion for deterministic preflight.
- `WAITING_FOR_PHONE`: PC infrastructure is healthy; the phone may be offline, before first unlock, without a validated VPN, or unable to reach the endpoint.
- `INFRASTRUCTURE_UNHEALTHY`: inspect the returned task, Funnel, process, and local API fields. Do not start UI commands.
- `NOT_CONFIGURED`: run the setup procedure.

## Safety

- Do not reboot, lock, disable Wi-Fi/mobile data/VPN, change Wireless debugging, revoke USB debugging, or alter the default SIM unless the user explicitly requests that state change.
- Do not force a control takeover merely because another owner exists. Report the owner and lease expiry.
- Use a unique snapshot session name per test. Node references are valid only for the snapshot that produced them.
- Always store screenshots and machine-readable snapshots in the requesting project's evidence directory.

## Command Surface

`arlab device` supports `devices`, `capabilities`, `connection`, `diagnostics`, `open`, `snapshot`, `press`, `click`, `fill`, `swipe`, `home`, `back`, `app-switcher`, `screenshot`, `install`, `install-status`, and `close`.

The smoke script uses a central app-viewport pixel heuristic to reject unreadable, tiny, obviously blank, and visually uniform screenshots. A successful screenshot still proves only the captured frame, not semantic UI correctness, animation stability, or a complete workflow. Screenshots can fail on Android secure windows.

Android does not let an ordinary Companion read another app's protected `logcat`. Use the bundled log script only when ADB is already authorized; otherwise preserve the UI evidence and report target-app logs as unavailable rather than weakening debugging settings.

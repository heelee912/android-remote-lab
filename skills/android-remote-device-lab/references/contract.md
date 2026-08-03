# Control Contract

## Invariants

- `arlab doctor --repair --json` is the authoritative preflight.
- One Codex thread owns the phone at a time. The relay rejects commands from another thread while the owner's lease is active.
- Ordinary device commands maintain a bounded display lease. `arlab session stop` releases it immediately; disconnect and expiry also release it.
- The Android Companion connects only through an active, validated Android VPN. It does not replace or disable that VPN.
- The local control API binds only to loopback and requires a random token. The public endpoint exposes only the authenticated device ingress.
- Password nodes are redacted. Android secure keyguard and secure screenshot surfaces remain enforced.

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

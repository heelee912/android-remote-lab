# Device Operations Reference

## Runtime Behavior

The task determines the operations to perform. This reference describes commands,
state reporting and Android prerequisites; it adds no prohibited operations or
separate approval steps for settings changes, installation or recovery.

- `arlab doctor --repair --json` is the authoritative preflight.
- One Codex thread owns each device at a time. Different threads may control different devices simultaneously. The relay rejects commands from another thread while the owner's lease is active.
- Multiple enrolled devices may remain connected. Each task independently selects its target. Only that target receives its commands and display wake leases. `arlab select <device-id>` requires only the selecting owner's session to be stopped; selection is persisted per owner, with no fallback to another device when it is offline. Snapshots bind their element references to the originating device.
- Interactive device sessions maintain a bounded 60-minute display wake lease by default. Background sessions reserve the same exclusive ownership without waking the display; ADB, file operations and diagnostics acquire this mode automatically. Idle background sessions never send display renewals. Starting a session with an explicit minute value overrides the default within the bounded limit.
- Companion 1.1.9+ connects through the active validated internet network: Wi-Fi, mobile data, or an existing VPN. It does not enable, replace, or disable a VPN. Older versions retain their VPN requirement until updated. TLS hostname verification and enrolled-device authentication remain mandatory.
- The local control API binds only to loopback and requires a random token. The public endpoint exposes only the authenticated device ingress.
- Password nodes are redacted. Android secure keyguard and secure screenshot surfaces remain enforced.

## Legacy lock telemetry

`LEGACY_LOCK_UNVERIFIED` means the older Companion reports keyguard visibility without distinguishing an unsecured swipe screen from a PIN/password lock. Background diagnostics supply more detail. Modern display-only `wake` verifies the interactive display. Accessibility UI readiness depends on Android lock state; background ADB/files/diagnostics have separate prerequisites.

## Display readiness

Companion 1.1.3+ reports `screenInteractive`, `secureKeyguardLocked`, and `userUnlocked`. `SCREEN_OFF` means a connected unlocked device is asleep; repair wakes it via the existing bounded wake lease and confirms actual interactive state. `KEYGUARD_SHOWING` is an unsecured swipe screen. Only a screen Android reports as not device-locked may be dismissed with requestDismissKeyguard, including an already trusted swipe state. Actual authentication is never performed automatically. `PHONE_LOCKED` still blocks all UI commands; no PIN, password, trust, or biometric bypass is provided. Existing awake screens are kept awake without power toggles.

## Doctor States

- `READY`: relay, Funnel, process supervision, and enrolled phone are healthy.
- `PHONE_LOCKED`: Android reports a secure keyguard. Background ADB, files and diagnostics remain available according to their own transport and Android permissions.
- `BACKGROUND_READY`: the authenticated Companion and infrastructure are ready for background ownership. Screen and Accessibility state do not gate background commands. This does not prove the configured ADB transport is online or unlock encrypted storage.
- Companion 1.2.11+ also accepts authenticated APK installation and install-status in a background session while Accessibility is unavailable. Android's installer may still require a TV-remote confirmation.
- Companion 1.2.20+ tunnels Android TV Remote Service v2 over the selected TV's authenticated connection. `arlab tv pair --device DEVICE_ID` pairs the PC certificate using the TV's six-character code; `arlab tv press KEY --device DEVICE_ID` sends one remote key. The TV connection targets only its own loopback ports 6466/6467, and the PC listener binds only to loopback while the owner lease is active. This route needs neither Accessibility nor ADB. It does not provide screenshots or a shell. Confirm the visible outcome or installer status separately. `--host TV_ADDRESS` is an explicit direct pairing route when the remote service is reachable without a tunnel.
- LG webOS TV control uses a separate authenticated WebSocket connection on port 3001. `arlab webos inspect-host IP` reports the certificate fingerprint; `arlab webos pair IP FINGERPRINT` saves the approved TV key outside the repository. `status`, `press KEY`, and `request SSAP_URI [JSON_PAYLOAD]` reconnect with the pinned certificate. This does not occupy an Android device lease. TV SSAP replies do not imply access to raw HDMI-CEC traffic, soundbar firmware, or a shell.
- `arlab webos screenshot ABSOLUTE_OUTPUT.jpg` reads the TV's capture resource over the same pinned certificate and creates a JPEG outside the repository without replacing an existing file. Protected video may be absent in the capture; verify the visible UI separately when that matters.
- `ACCESSIBILITY_UNAVAILABLE`: the Companion is connected but its Accessibility service is not ready.
- `COMPANION_UPDATE_REQUIRED`: readiness is reported by a Companion older than the minimum hardened protocol version. Upgrade before control.
- `CONNECTED_UNVERIFIED`: an authenticated connection has not supplied readiness or version data yet, or an older Companion lacks that telemetry. The relay requests the first pong immediately; repair preflight and device commands wait for fresh data before selecting capabilities. A missing version alone is distinct from an installed version below the supported minimum.
- `WAITING_FOR_PHONE`: PC infrastructure is healthy; the phone may be offline, before first unlock, or unable to reach the endpoint. On Companion older than 1.1.9, also inspect its legacy VPN requirement.
- `INFRASTRUCTURE_UNHEALTHY`: the task, Funnel, process and local API fields identify infrastructure components to repair.
- `NOT_CONFIGURED`: run the setup procedure.

## Sessions And Evidence

- Reboot, display, network, VPN, SIM, debugging and installer settings can be changed as needed to complete the task.
- `session start --force` transfers an existing control lease. Status reports the current owner and expiry so concurrent work can be coordinated.
- Use a unique snapshot session name per test. Node references are valid only for the snapshot that produced them.
- Always store screenshots and machine-readable snapshots in the requesting project's evidence directory.

## Command Surface

Companion 1.2.4+ listener repair restores `adb_enabled` so the Android ADB service
and a provisioned TCP listener survive Wi-Fi loss. A stale enabled wireless
listener is restarted through an off/on transition with bounded socket polling.
Status exposes `adbEnabled`, `wirelessEnabled`, `repairAttempted` and
`wirelessRestarted`; settings writes that Android rejects are reported as errors.
Companion 1.2.6+ measures the repair deadline with a monotonic clock, including
time spent probing ports. Native SDK reconnects use a status read without repair;
failed endpoints close so retries cannot accumulate phone-side repair loops.
Companion 1.2.8+ reports `mobileRecoveryRunning` and `mobileRecoveryError` for its
bounded mobile bootstrap. A temporary local-only hotspot supplies an interface;
the worker reasserts wireless debugging while the PC discovers TLS and provisions
TCP. The PC waits for cleanup before dispatching the caller command. Normal
validated Wi-Fi connections retain ordinary repair, and Android permissions and
hotspot acceptance determine whether mobile bootstrap is available.

ADB route selection defaults to `auto`: execute through verified direct ADB when
available, and fall back to the Companion tunnel only on a pre-dispatch transport
exception. A returned failure or unconfirmed command is never retried. Offline
direct probes are cached for 30 seconds. `--adb-route companion` requires the
remote tunnel; `--adb-route direct` disallows fallback. These flags apply to
`adb` and `files` before `--`; subsequent arguments remain native ADB arguments.
Companion 1.2.3+ combines TLS frame headers/bodies, requests immediate TCP
transmission and uses 128 KiB chunks. Status may include PC byte/call statistics
and the last stream failure; these fields contain no transferred data.

`arlab doctor --background --repair --json` returns `uiState` and `backgroundState` separately and does not wake a sleeping phone. `arlab session start --background` reserves ownership using a Companion ping, with no display lease. The local `/control/start` API accepts additive `background: true`; status exposes `controlLease.background`. Direct API UI commands also upgrade background ownership before dispatch. A failed upgrade retains the prior background lease. ADB/files/diagnostics are not blocked by a secure keyguard; Android itself remains authoritative for actual command permissions. Background session stop/expiry sends no display command.

Companion 1.1.8+ on Android 13+ supports Android's global directional keyboard
actions without ADB. Use `arlab device press dpad-right --expect-package PACKAGE
--json` (also `dpad-left`, `dpad-up`, `dpad-down`, `dpad-center`, or `enter`).
The Companion verifies the unlocked screen and exact foreground package before
dispatch. Capture a fresh screenshot to confirm which control has keyboard focus
before pressing center. A successful dispatch alone does not prove activation;
read the changed UI and final install status. This keeps the normal device lease
and does not change the accessibility service's tool classification.

For an already authorized ADB transport configured in the local relay's
`systemInput.devices` map, coordinate `click`, `press`, and `swipe` accept
`--input adb --expect-package <foreground-package>`. This uses system input for
installer buttons that reject accessibility gestures. The relay's normal device
lease remains mandatory. It checks the configured hardware serial, unlocked
screen, and foreground package before dispatch; no default or first ADB device is
used. A `dispatched` result requires actual UI or installation-status readback.
Without the configured ADB connection this path fails; it cannot bootstrap pairing.

`arlab device` supports `devices`, `capabilities`, `connection`, `diagnostics`, `adb-status`, `open`, `snapshot`, `press`, `click`, `fill`, `swipe`, `home`, `back`, `app-switcher`, `screenshot`, `install`, `install-status`, `adb`, `files`, and `close`.

Companion 1.2.0+ transports ADB inside its enrolled TLS connection to the Tailscale Funnel endpoint. The owner-scoped PC listener binds only loopback, accepts at most four ADB streams, and connects only this phone's loopback ADB service. Companion 1.2.1+ uses nonblocking reads and writes so backpressure cannot stop heartbeats or the opposite direction. Stream data is not written to audit logs. Loss of the owner lease or enrolled connection closes the tunnel; later owned commands reconnect using the existing PC ADB key. Physical serial verification remains mandatory before target execution. `system_input` uses this same route.

Companion 1.2.32+ supports banking mode through a bounded native ADB window.
Between commands it disables Android's ADB and developer-setting flags. An
automatic command may open the existing authorized listener only when the
foreground is a known launcher/system package, execute the full native command,
and close the window even after failure. It must refuse while a banking or other
user app is foreground. Reboot leaves debugging off; no root, app patch, or
surviving shell daemon is claimed.

`adb-status` reads the local listener without waking the display. `adb-status --repair` restores `adb_wifi_enabled` when the Companion holds `WRITE_SECURE_SETTINGS`; tunnel creation uses this grant automatically. Provision the grant through ADB when needed. Listener availability, PC authentication and screen state are separate results. Companion 1.2.1+ also uses a provisioned TCP listener (`adb tcpip 5555`), which survives Wi-Fi transitions until an ADB/phone restart. TCP mode listens on local interfaces with ADB-key authentication; the outer ARLab TLS encrypts remote traffic. Mobile-only TLS restoration after reboot depends on Android network behavior and device verification.

`adb [ARLab flags] -- COMMAND [ARGS...]` executes native ADB commands through the relay's per-device queue. `--adb-route privileged` accepts only `shell` and `exec-out` and returns `connectionRoute: privileged-shell`. Device commands use the configured hardware binding selected by `--device DEVICE_ID` before `--`. Native PC host commands (`connect`, `disconnect`, `pair`, `start-server`, `kill-server`, `server`, `nodaemon`, `keygen`, `reconnect`, `attach`, `detach`, `devices`, `version`, `help`, `host-features`, `server-status`, `mdns`) execute unchanged without a phone transport probe. `files list|stat|read REMOTE`, `files pull REMOTE LOCAL`, and `files push LOCAL REMOTE` use device ADB. Android determines file access; private files can use `run-as`, existing root or app export.

`adb --args-file LOCAL_JSON` accepts a UTF-8 (optional BOM) JSON argument array; `adb --shell-file LOCAL_SCRIPT` accepts one complete Android shell script. Both exclude inline command arguments and each other. Use these for PowerShell loops rather than collapsing an array into a single command token. `files read --as-package PACKAGE` selects Android `run-as`; `files read --as-root` selects an already authorized `su` identity and verifies UID 0. Neither mode changes the app or grants new privileges. Binary delegated reads use local private temporary storage and never shared phone storage.

Real command failures return `ok:false`, a nonzero CLI status, and the original exit code/stdout/stderr. A timeout, lost client, device disconnect or expired lease cancels the local process and reports an unconfirmed remote outcome. Binary stdout can be saved directly with `--output LOCAL_FILE`; binary stdin uses `--input-file LOCAL_FILE`. Neither file contents nor command arguments are logged by the relay. New output files are exclusive creations; an existing destination fails instead of being replaced. Native pull/push preserve ADB's own destination rules. Commands default to 60 seconds and may request up to ten minutes; larger output uses files rather than inline JSON.

An Android structured tool (`content`, `pm`, `cmd`, `am`) can print a SecurityException with exit code zero. ARLab returns `adb-android-command-failed` in this case; native exit code and stderr remain intact. A zero native code alone is not success.

File reads use native pull and a private temporary local file, preserving bytes across Windows and Android and returning native transfer failures. Temporary copies are removed after use. Host commands execute independently of phone ADB readiness. The legacy direct route discovers the configured serial's TLS advertisement; the Companion tunnel discovers the phone's own listener. Both reuse existing ADB authentication and verify hardware before target execution. New PC keys are paired through Android's pairing procedure.

The smoke script uses a central app-viewport pixel heuristic to reject unreadable, tiny, obviously blank, and visually uniform screenshots. A successful screenshot still proves only the captured frame, not semantic UI correctness, animation stability, or a complete workflow. Screenshots can fail on Android secure windows.

An ordinary Companion lacks cross-app `logcat` access. ADB supplies that path; repair or provision its connection through the available controls, then collect logs with the general ADB command or bundled script.

# Android Remote Lab contributor instructions

- Use the bundled `android-remote-device-lab` skill for every physical-device operation.
- Run `arlab doctor --repair --json` before control and `arlab session stop` in cleanup.
- Execute the requested device work, including the settings and connection changes needed to complete it. The project adds no separate approval step for reboot, display, network, VPN, SIM, debugging, installation, or connection recovery.
- `CODEX_THREAD_ID` identifies each controller. Per-device leases coordinate concurrent tasks; `arlab session start --force` transfers a lease when needed.
- Keep repository content free of device IDs, account names, local user paths, relay hostnames, tokens, signing files, screenshots, and audit logs.
- Validate with `npm run check`, `npm test`, skill validation, Android lint/build, and a secret scan before release.

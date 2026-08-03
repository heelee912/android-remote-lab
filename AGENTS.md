# Android Remote Lab contributor instructions

- Use the bundled `android-remote-device-lab` skill for every physical-device operation.
- Run `arlab doctor --repair --json` before control and `arlab session stop` in cleanup.
- Do not reboot, lock, change network/VPN/SIM state, or alter Wireless debugging without explicit user authorization.
- Do not bypass the relay ownership conflict. Each `CODEX_THREAD_ID` is one exclusive controller.
- Keep repository content free of device IDs, account names, local user paths, relay hostnames, tokens, signing files, screenshots, and audit logs.
- Validate with `npm run check`, `npm test`, skill validation, Android lint/build, and a secret scan before release.

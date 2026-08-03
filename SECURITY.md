# Security Policy

## Supported version

Only the latest GitHub release is supported with security fixes.

## Reporting a vulnerability

Use the repository's private GitHub Security Advisory reporting flow. Do not open a public issue containing relay endpoints, device IDs, logs, tokens, signing material, screenshots, or reproduction data from a real device.

Include the affected version, threat scenario, prerequisites, impact, and a minimal reproduction that uses synthetic identities and data. Maintainers should revoke exposed credentials, enrollment state, or signing material before sharing diagnostics.

## Trust boundaries

- Use Android Remote Lab only on devices and networks you own or are explicitly authorized to administer.
- Treat the enrolled phone, Windows account, Tailscale account, release-signing key, and local control token as privileged assets.
- Tailscale Funnel provides TLS ingress, not device authorization. The relay still requires the enrolled Android signing identity.
- The Accessibility service can observe visible UI and perform input. Disable it and remove the app when remote testing is no longer required.
- APK submission is not silent installation. Android remains the authority for package permission, user confirmation, signature validation, and installer status.
- The owner label is a coordination boundary between cooperative processes under one Windows account, not isolation from a malicious process that already controls that account and its local API token.
- The Windows launcher is rebuilt from source for releases, checked against its source/executable manifest, and covered by GitHub build provenance. It is not Authenticode-signed by a public certificate authority.

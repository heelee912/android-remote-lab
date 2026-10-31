# LG webOS Luna over an existing SSH connection

ARLab's paired SSAP connection uses the TV's TLS certificate and remains available
independently of this optional route. Luna is webOS's local service bus: a
`luna://service/method` request is executed on the TV rather than sent to the
SSAP endpoint. This route requires an **already enabled, key-authenticated SSH
server on that same TV**; it does not install software, enable Developer Mode,
root the TV, or bypass service permissions. A saved pairing and configuration
are persistent PC-side records, not proof that an SSH server is installed or
running after a TV reboot.

## Connection and trust setup

1. Pair the TV using `arlab webos inspect-host` and `arlab webos pair` as in the
   README. Use the same TV's IP address for SSH. Keep the TV's SSH private key
   outside this repository.
2. Obtain the TV's SSH host public key through a trusted independent channel and
   verify its SHA-256 fingerprint. Store its OpenSSH known-hosts entry in a local
   file outside this repository. For example, `ssh-keyscan -p PORT TV_IP` can
   collect a candidate entry, and `ssh-keygen -lf C:\Path\known_hosts -E sha256`
   can display its fingerprint, but a scan alone does **not** authenticate a TV.
   For a non-default port the entry must include `[TV_IP]:PORT`. Do not proceed
   until the fingerprint matches the independent source. Never turn off strict
   host key checking to make this work.
3. If the key is encrypted, make it available through the Windows OpenSSH agent
   before running the command; ARLab runs SSH in batch mode and cannot prompt for
   a passphrase. Configure the local path and the appropriate existing SSH user:

   ```powershell
   arlab webos luna-config prisoner 9922 C:\Path\tv-key C:\Path\tv-known-hosts
   arlab webos luna luna://com.webos.applicationManager/getForegroundAppInfo
   ```

   For an already rooted TV with a separately configured SSH server, use `root`
   and that server's actual port instead of `prisoner` and `9922`. The root route
   runs `luna-send`; the Developer Mode route runs `luna-send-pub`. Access depends
   on the TV's installed binaries and service permissions. Configuration stores
   only the local paths, username and port under local application data. The SSH
   client checks the separate pinned host key and the existing SSAP pairing state
   supplies the target IP. Changing the SSAP-paired target requires verification
   of the new SSH host key before use.
4. To send a JSON object, pass it as the second argument to `arlab webos luna`.
   Native-command JSON quoting depends on the invoking shell. Inspect the exact
   response and verify the external result independently. A timeout or lost SSH
   connection leaves the remote outcome unconfirmed; do not automatically retry a
   state-changing request.

## What this does and does not establish

LG's [Developer Mode instructions](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
require installing its app, signing in with an LG developer account, enabling the
mode and rebooting the TV. Its session expires unless extended. The official
[CLI guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
describes `ares-setup-device` and `ares-novacom --getkey` for the TV's
`prisoner` SSH account. The developer key's passphrase and the TV's SSH host key
are different things. A normal developer account or app does not automatically
obtain private Luna privileges; verify each call's actual response. The SSH route
is not a replacement for Developer Mode's expiration or renewal process.

A rooted TV can expose broader Luna permissions, as described by the
[webOS Homebrew Luna bus reference](https://www.webosbrew.org/pages/luna-service-bus).
Rooting is firmware-dependent, changes the TV's security posture and may not
survive every update. The [homebrew rooting guide](https://www.webosbrew.org/rooting/)
describes available methods and their limits. ARLab does not install or maintain
root access. An SSH server with root access should be restricted to trusted
networks, use key authentication, and not be exposed to the public internet.

Even a successful `com.webos.service.irdbmanager/sendIrCommand` response does not
prove an IR receiver acted, nor does it prove this TV has an IR emitter. The
remote control itself may send the IR signal. HDMI-CEC support and service names
also vary by hardware and firmware. Check the attached device's state and actual
physical behavior before claiming either IR or CEC works. An unsupported service,
permission error, unavailable SSH server, or failed response must be reported as
such; SSAP `404` is not proof that the local Luna service exists or is callable.

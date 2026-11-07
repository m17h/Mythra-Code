# Security Policy

## Supported versions

Only the latest released version of Mythra Code receives security fixes. The in-app updater (Settings → Updates) delivers them; macOS and Windows releases are published together at <https://github.com/m17h/Mythra-Code/releases>.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via **GitHub Security Advisories** on this repository ("Report a vulnerability"), rather than opening a public issue. Include reproduction steps and the Mythra Code version (Settings → Updates shows it).

You should receive an acknowledgement within a few days. Because Mythra Code is maintained by a single developer, please allow a reasonable window for a fix before public disclosure.

## Scope notes

- Mythra Code executes model-directed commands **by design**, gated by its permission modes and approval UI. Reports about the model doing what an approved permission mode allows are product feedback, not vulnerabilities.
- In scope: sandbox/approval bypasses, credential exposure (OS keyring, isolated Codex home, Claude subscription scrubbing), the updater trust chain (signature verification, downgrade), webview → Rust privilege escalation outside the RPC allowlist, and path-traversal in exports/skills.
- Mythra Code contains no telemetry; there is no server-side component to report against.

## Nearby devices

**Work on another computer** is off by default. With **Allow access from nearby devices** off there is no listener and no announcement on the network, and an update can't turn it on. Paired computers talk directly over TLS 1.3 using each device's own key, with no relay. Each device's private key stays in the OS credential store.

- Pairing needs someone at the host to open a 5-minute window and approve a matching six-digit code. Each direction is paired separately.
- The native host authorizes every remote operation from the key proven by TLS, never from a value in the message. A viewer can't supply a filesystem path, credential, execution folder, or higher permission.
- View shares conversation contents, and those can include anything a model or tool printed. Marked-secret answers and raw approval parameters are never sent.
- Project access limits which conversations and files a device can open through Mythra Code. **It is not a sandbox.** A device with Work can start model turns, and a model with enough permission can reach files and run commands outside the granted projects. Without the Full access switch, remote turns run at Ask to act or lower.
- **Show this name to nearby devices** only controls the name Mythra Code announces. The DNS-SD service record still carries the computer's `.local` hostname, which the OS already answers for. The announcement never includes the device's key.
- Web previews from another computer open in this device's browser through a temporary `127.0.0.1` tunnel to one host port. They close when idle, on revocation, and when the link drops.

In scope: pairing or code-comparison bypass, a device exceeding its grant, a viewer-supplied path or command reaching the host, preview tunnels reaching anything but their one port, and host data or secrets leaving outside the allowlisted wire shapes.

Not vulnerabilities: a device with Work doing what its grant allows, a model reaching outside a granted project at a permission the grant allows, and the computer's `.local` hostname being visible on the network.

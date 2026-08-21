# Security Policy

## Supported versions

Only the latest released version of OpenKiwi receives security fixes. The in-app updater (Settings → Updates) delivers them; macOS and Windows releases are published together at <https://github.com/m17h/OpenKiwi/releases>.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via **GitHub Security Advisories** on this repository ("Report a vulnerability"), rather than opening a public issue. Include reproduction steps and the OpenKiwi version (Settings → Updates shows it).

You should receive an acknowledgement within a few days. Because OpenKiwi is maintained by a single developer, please allow a reasonable window for a fix before public disclosure.

## Scope notes

- OpenKiwi executes model-directed commands **by design**, gated by its permission modes and approval UI. Reports about the model doing what an approved permission mode allows are product feedback, not vulnerabilities.
- In scope: sandbox/approval bypasses, credential exposure (OS keyring, isolated Codex home, Claude subscription scrubbing), the updater trust chain (signature verification, downgrade), webview → Rust privilege escalation outside the RPC allowlist, and path-traversal in exports/skills.
- OpenKiwi contains no telemetry; there is no server-side component to report against.

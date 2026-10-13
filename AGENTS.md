# Mythra Code repository instructions

## Scope

This is the canonical shared macOS and Windows repository:
https://github.com/m17h/Mythra-Code. Keep application behavior shared unless an
OS boundary requires a platform-specific implementation. Keep application,
updater, pricing and release URLs in this repository.

## Development policy

- Work on a topic branch; do not push directly to `main`.
- Preserve unrelated changes, active applications and user data.
- Never commit credentials, private operator files or generated release assets.
- Keep user-facing copy platform-neutral unless the behavior is OS-specific.
- Automated tests and checks are disabled locally and on GitHub until Morgan
  explicitly reintroduces them. Do not add or run lint, type checks, unit tests,
  browser tests, native GUI tests, performance gates, CI verification, upgrade
  evidence planning or independent audit ceremonies.
- Compilation and release operations still run when authorized. A build,
  signature, notarization or upload failure needs diagnosis before continuing;
  disabling tests does not mean reporting failed release work as successful.

## Pull requests and merging

Use `docs/operations/merging.md`. Keep one coherent concern per PR. The
originating development chat owns the commit, push and PR description. A request
for a PR alone does not authorize a merge.

When Morgan asks for a PR and merge, hand it to one separate persisted merge
chat with its own clean worktree. Any available Codex or Claude model can own
the handoff; there is no compulsory model or multi-agent review ceremony.
The merge chat resolves in-scope review findings, merges the authorized source,
cleans obsolete merged topic branches and reports the result. No automated
checks, CI status gates or pre/post-merge test waits are required.

Before deleting a branch, inspect merge evidence, switch off it, and preserve
unmerged commits, protected branches, open-PR branches and active worktrees.
Never archive the originating development chat. Archive only the completed
merge chat and its no-longer-needed managed worktree using recoverable app
operations.

## Native builds and releases

Use `docs/operations/releasing.md`, `docs/operations/release-coordinator.md`
and the private `build.md` runbook when available. A release requires
Morgan's explicit request and chosen version. Do not change the version,
build release assets, tag, sign, notarize or publish without that authorization.

Freeze one clean merged source/version in a dedicated release checkout.
Build macOS on macOS with the base Tauri configuration. Build Windows on
Windows with `src-tauri/tauri.windows.conf.json`. Preserve each platform's
embedded updater signing key; replacing a key requires an explicit migration
plan. Keep signing credentials on their native machine.

Keep one publisher. Produce the signed macOS package and Apple notarization,
the Windows installer and updater signature, and a combined `latest.json`
containing both platforms. Upload both asset sets to one draft release in
`m17h/Mythra-Code`, then finalize and publish that release. Never publish a
one-platform manifest or replace a published version with different binaries.

Generated macOS artifacts belong in `release-assets/`; generated Windows
artifacts belong in `RELEASE ASSETS/`. Do not commit them. Preserve source,
active applications, real profiles and retained release records during cleanup.
Cancellation must stop the owned coordinator and its build/upload/publication
descendants; prove they exited before replacing their owner or starting another
publisher. Report completion only after both platforms and publication actually
finish. Release 1.25.3 was cancelled; these instructions do not resume it.

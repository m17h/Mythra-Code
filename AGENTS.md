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

Follow `docs/operations/releasing.md`. A release requires Morgan's explicit
request and chosen version; do not change the version, tag, sign, notarize or
publish without it. That request also authorizes merging its own version-bump
PR (`npm run release:prepare -- <version> --merge`).

Release with one command on the Mac, `npm run release -- <version>`. It builds
macOS locally and Windows over SSH in parallel from one commit and publishes
one release with a combined `latest.json`. Do not add supervisors, leases,
QA, audit or review stages around it. If it fails, diagnose the reported error,
fix the cause and run the same command again; finished platform builds are
reused. Report a release only after the script prints the published URL.

Preserve each platform's updater signing key; replacing a key requires an
explicit migration plan. Never publish a one-platform manifest or replace a
published version's binaries. Generated assets and private machine settings
stay out of Git.

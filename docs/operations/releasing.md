# Building and publishing a release

Release only when Morgan explicitly requests it and supplies a version.
Complete the authorized version PR and merge, then freeze one clean merged
source/version in a dedicated checkout. Keep development, active applications
and user profiles available. Release 1.25.3 was cancelled; do not resume it.

Automated tests and checks are disabled locally and on GitHub until Morgan
explicitly reintroduces them. Do not run CI verification, lint/type/unit/browser/
native GUI tests, performance gates, upgrade planning or audit ceremonies.
Compilation, signing, notarization and publication are still part of release
execution and their failures must be resolved before continuing.

Build macOS on macOS using the base Tauri configuration. Build Windows on
Windows using `src-tauri/tauri.windows.conf.json`. Retain the existing platform
updater keys and native credentials. Produce the macOS DMG/updater archive,
its updater signature and Apple notarization, and the Windows installer/
updater signature. Do not claim Windows Authenticode signing unless configured
credentials actually produced it.

Use the maintained [release coordinator](release-coordinator.md). Its new
policy-version 2 plan needs no baseline or test input:

```json
{"version":"REQUESTED-VERSION"}
```

Store that input and release state outside mutable build output, then run from
the frozen release checkout:

```sh
npm run release:plan -- --input /absolute/plan-input.json --state /absolute/release-state
npm run release:run -- --state /absolute/release-state --build --upload --publish
npm run release:status -- --state /absolute/release-state
```

For an interrupted authorized release:

```sh
npm run release:resume -- --state /absolute/release-state --build --upload --publish
```

The native builders retain `release:build`; platform upload retains
`release:publish`, and combined publication retains `release:finalize`.
The coordinator supplies their frozen release state and owns ordering. Prefer
the coordinator or the maintained private operator entrypoint over separately
starting builders and publishers.

Upload both platform asset sets to one draft in `m17h/Mythra-Code`, generate
one `latest.json` with `darwin-aarch64` and `windows-x86_64`, and finalize/
publish that release through one publisher. Retain package source/version,
hash and signature handling. Never publish a one-platform manifest, replace
published binaries, steal live leases or start a competing publisher.

Completed packages may be reused when their frozen source/version and package
records match. Diagnose failures before a bounded retry; an upload failure
does not itself require a rebuild. Cancellation must stop the owned process
trees on both machines and preserve state/logs before any new owner starts.
Old policy-version 1 states are status-only, and cancelled work must not be
revived.

Generated Mac assets belong in `release-assets/`; Windows assets belong in
`RELEASE ASSETS/`. Do not commit them. Keep secrets, personal machine paths,
private operator instructions and local retention policies outside GitHub.
Report the release URL and both native outcomes only after publication finishes.

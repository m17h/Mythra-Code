# Resumable native releases

A release requires Morgan's explicit request and chosen version. Use
[releasing.md](releasing.md) and the private operator runbook. Reading these
instructions never authorizes a release. Release 1.25.3 was cancelled and must
not be resumed.

Automated tests and checks are disabled locally and on GitHub until Morgan
explicitly reintroduces them. New policy-version 2 plans contain only:

`build:darwin-aarch64` and `build:windows-x86_64` → `draft` → `publish` → `public`.

`public` records the published GitHub release's tag/source and non-draft status.
It does not download packages or run a public audit.

No CI, native QA, audit, public-audit, performance or upgrade-evidence stage is
required. Both native builds still compile the product and produce their
signed release assets; macOS is notarized. The draft contains both platforms
and one combined updater manifest before publication.

## Start

Finish the normal authorized version PR and merge workflow. Freeze the clean
merged commit/version in a dedicated release checkout so development can
continue separately. Preserve the actively used application and its profile.

Write a plan input outside the checkout. It may be `{}`, or include the requested
version:

```json
{"version":"REQUESTED-VERSION"}
```

An explicit input version must equal the frozen package version. No baseline,
cumulative-diff classification, known-issue test selection or predecessor
coverage file is required.

From the clean frozen checkout:

```sh
npm run release:plan -- --input /absolute/plan-input.json --state /absolute/release-state
npm run release:status -- --state /absolute/release-state
npm run release:run -- --state /absolute/release-state --build --upload --publish
```

These flags describe the already authorized scope; they do not create human
authorization. The coordinator owns the local Mac builder and the Windows
worker on the trusted native machine. Each installs its frozen dependencies
and builds from the same source/version. Workers can build concurrently.
Only the designated publisher uploads and publishes.

Old policy-version 1 states remain readable with `status` but cannot execute
under this coordinator. Preserve their records; do not migrate them, revive a
cancelled release or import their obsolete test receipts into a new plan.

## Native handoffs

The maintained [Windows transport](release-windows-transport.md) prepares the
dedicated Windows checkout, transfers release state, starts one persisted worker
and collects its build result. Native credentials remain on their existing host.
Handoffs do not contain private keys, tokens, leases or active process records.

The portable recovery commands are:

```sh
node scripts/release-coordinator.mjs workspace --state /absolute/release-state --path /absolute/new-release-checkout
node scripts/release-coordinator.mjs export --state /absolute/release-state --to /absolute/new-worker-handoff --platform windows-x86_64
node scripts/release-coordinator.mjs merge --state /absolute/release-state --from /absolute/returned-worker-handoff
```

A Windows worker runs from its native frozen checkout:

```sh
node scripts/release-coordinator.mjs run --state /absolute/remote-release-state --build --native-only
```

Candidates and their build records remain bound to the frozen source/version
and package files. A handoff from another plan or conflicting package cannot
replace an existing result. Windows never uploads or publishes independently.

## Status, resume and failures

```sh
npm run release:status -- --state /absolute/release-state
npm run release:resume -- --state /absolute/release-state --build --upload --publish
```

Resume inspects the existing worker identities and collects their results before
starting work. A disconnected shell does not prove a remote builder exited.
Preserve source, package files and logs; reuse completed packages when their
recorded source/version and package identity still match. An upload failure
alone does not require rebuilding.

Diagnose a failed build, signature, notarization, transfer or publication before
a bounded retry, recording the actual reason:

```sh
npm run release:resume -- --state /absolute/release-state --build --upload --publish --retry-reason 'Upload connectivity restored; frozen package unchanged'
```

Do not use a generic retry reason or claim a failed operation succeeded.
When a publication request times out, inspect the draft/public release state
before another publication attempt.

## Ownership and cancellation

One designated publisher owns the release. Preserve live/foreign leases and
the publisher mutation marker. Before recovering an interrupted publisher,
establish that its coordinator, finalizer and every upload/publication descendant
have exited; a dead parent PID alone is insufficient. Keep ownership intact
while process identity is uncertain.

Cancellation stops only the owned coordinator and its descendant build,
transfer, upload and publication processes on both machines. Inspect the
process records and remote release state, preserve the cancelled state and
logs, and confirm the process trees exited before replacing an owner. No
automatic restart of a cancelled release is allowed.

If work continues beyond a chat turn, use the product's supported follow-up
mechanism for that same release/state, with one owner. Verify it exists and
will collect the actual worker. Stay quiet while nothing actionable changes
and stop it after completion or cancellation.

## Finish

The coordinator uploads both native artifact sets to one draft, prepares the
combined `latest.json`, and publishes through `release:finalize` with
`MYTHRA_RELEASE_STATE` pointing to its state. Finalization retains release
metadata, both-platform package/manifest, signature and hash handling needed
to publish the requested version; it does not require automated test evidence.

Report the actual version, release URL and both platform outcomes only after
publication finishes. A merge, package build, queue record or stopped worker
is not publication. Cleanup preserves source, active apps, real profiles and
retained release records; personal retention policies stay outside GitHub.

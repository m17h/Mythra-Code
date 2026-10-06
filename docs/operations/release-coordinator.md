# Resumable native releases

`AGENTS.md` and the local `build.md` remain the release policy. These commands
implement that policy; reading this document never authorizes a release.

The coordinator freezes a source/validation plan, records each completed stage,
and selects the next runnable stage. Its state belongs outside the checkout's
mutable build directories. A clean detached release worktree lets development
continue on a separate branch. It does not isolate application profiles: native
validation must separately use supported isolation.

## What runs

Every release retains complete exact-source hosted Verify, production-output
startup during native packaging, signing/notarization, package provenance,
cryptographic updater checks, the combined draft audit and fresh public audit.
The plan adds native startup, close, storage, onboarding or installer checks
only for their affected boundaries or a known reported failure. An ordinary UI
change does not select a manual native tour.

The baseline is the last accepted public release. Include any withdrawn version
that users installed as a supported predecessor. Cumulative source differences
drive selection; reverted, never-shipped intermediate edits do not automatically
add tests. Broad native integration files and dependency changes require an
explicit semantic classification with the reviewed symbols/hunks as evidence.
Known failures and detected native integration changes cannot be suppressed by
an unrelated-file classification.

## Start a release

First obtain the user's release authorization and finish the normal version PR
and merge workflow. Use an app-managed release worktree at the frozen merged
SHA, or create a separate detached checkout. Never reset the development
checkout to satisfy a release command.

Write a plan input outside the repository. Example:

```json
{
  "baseline": {
    "tag": "v1.22.0",
    "reason": "Verified last accepted public release"
  },
  "predecessors": [],
  "knownIssues": [],
  "classifications": [],
  "overrides": [],
  "reviewNotes": "Release scope reviewed against the accepted public baseline"
}
```

Resolve the actual public baseline at kickoff; the example version is not a
standing baseline. A withdrawn predecessor entry has `tag`, `reason`, and optional
`classifications` for its own cumulative diff. Its native integration hunks are
classified independently of the current public-baseline diff. A known
issue/additional check has `check`, `reason` and optional `platform`. Check names
are `native-startup`, `native-close`, `native-storage`, `native-onboarding` and
`native-installer`; platforms are `darwin-aarch64` and `windows-x86_64`.

For a reviewed provider command change in the shared native integration file,
a classification can be:

```json
{
  "path": "src-tauri/src/lib.rs",
  "boundaries": [],
  "reason": "Only formats an existing Git command's result",
  "evidence": "Reviewed get_git_status function diff; no startup, lifecycle or persistence changes"
}
```

From the clean release checkout:

```sh
npm run release:plan -- --input /absolute/plan-input.json --state /absolute/release-state
npm run release:status -- --state /absolute/release-state
```

Inspect the generated `plan.json`. It contains the exact source, prior published
baseline, predecessor diffs, classifications, reasons, required/not-required
checks and dependency graph. Do not hand-edit a frozen plan. A scope change
gets a new state directory and invalidates affected evidence.

Run only the actions covered by the user's release request:

```sh
npm run release:run -- --state /absolute/release-state --build --upload --publish
```

These flags record execution scope, not new human permission prompts. An agent
with existing authorization should supply them and continue routine work. The
runner performs local stages and launches the Windows worker over the configured
trusted LAN once exact-source CI evidence is available. Native builds then overlap.
The owned Mac build worker installs its frozen dependencies before packaging;
the Windows builder owns its own dependency installation.
Queued CI waits while eligible local stages proceed. Waiting is bounded to two
hours per invocation; an owned remote worker can continue and be collected on
resume. Exit code 0 means complete, 2 means an incomplete dependency, and other
failures need diagnosis. The CLI never treats a queued request as a live worker.

The Windows builder consumes `MYTHRA_RELEASE_CI_RUN` supplied by the coordinator.
It freshly retrieves the canonical final-source run, every required job and all
nine coverage receipts, validating the same complete gate contract as CI. Only
then does it reuse hosted verification instead of repeating the full local
suite. With no such proof it keeps the normal full local verification. Do not
use `SkipVerify`; the actual Windows production build/startup still runs.

## Work across native machines

The Mac and Windows workers each need a clean checkout at the same source and
their existing native credentials/toolchain. The normal Mac command automatically
prepares the dedicated Windows checkout, transfers validated state, starts a
persisted worker and collects its typed evidence. See
[Windows transport](release-windows-transport.md). Native signing credentials stay
on their existing host; handoffs contain no private keys. The manual handoff
commands below are recovery tools, not routine babysitting steps.

The coordinator can prepare a detached checkout without touching the current
branch/index:

```sh
node scripts/release-coordinator.mjs workspace --state /absolute/release-state --path /absolute/new-release-checkout
```

Portable handoffs include the immutable plan, successful receipts and their
hashed evidence. They exclude credentials, process leases and active-stage
state. For example:

```sh
node scripts/release-coordinator.mjs export --state /absolute/release-state --to /absolute/new-worker-handoff --platform windows-x86_64
```

Transfer that directory to Windows and run the same coordinator from its exact
clean native checkout. Export the completed Windows state to a new handoff,
transfer it back, then merge it on the publishing coordinator:

```sh
node scripts/release-coordinator.mjs merge --state /absolute/release-state --from /absolute/returned-worker-handoff
npm run release:resume -- --state /absolute/release-state --build --upload --publish
```

Merge rejects another plan, invalid evidence and conflicting files/receipts.
It preserves existing approved results. Platform candidates remain immutable
under `candidates/<platform>/`; uploads read those files directly. No operator
needs to reconstruct which build a narrative message referred to.

Native integrity is a fixed adapter exported as `runNativeIntegrity` by
`scripts/release-native-integrity.mjs`. Selected native UI cases use
`scripts/release-native-check.mjs`: one persisted Sol/high worker per platform
shares the selected startup/save/close observations. The launcher explicitly sets
Full Access and approval policy `never`, verifies effective session metadata,
uses file-backed logs and a detached supervisor, and enforces a 25-minute deadline.
A lost coordinator never starts a second worker against the same profile.

Unattended native validation requires the installed Codex CLI to expose supported
Computer Use (CUA on Mac, the installed Windows/Sky skill on Windows), an available
interactive desktop and the candidate's supported `MYTHRA_RELEASE_QA_ROOT` profile
contract. The worker inventories the actual tool before interacting. Missing
capability produces a terminal blocker, not a synthetic pass. Mac CLI capability
was exercised with a real read-only `cua.getState()` invocation during development;
that establishes tool availability, not a successful packaged native test.

The package must implement the isolated profile contract; old candidates cannot
use this harness by renaming production roots. Real pixels, accessibility state,
exact executable hashes/PID/run identity, app-generated profile/window/exit events,
selected behavioral observations and cleanup evidence are required. Final cleanup
removes the owned isolated WebView store. Installer cases require an isolated OS
environment when installer-wide process termination could affect the working app;
profile isolation alone does not make that safe.
The maintained recipe currently has no save-failure injection adapter. An
affected close-failure case that needs one stops with that explicit limitation;
healthy close evidence does not substitute for the missing failure replay.

## Resume and diagnose

If workers may outlive the active chat turn, the release agent creates and
verifies a supported follow-up heartbeat in that same chat, tied to the actual
version and state directory. It checks worker ownership before resuming, stays
quiet while nothing actionable changes, and pauses after public verification
and the authorized completion notification. CLI commands alone are not proof
that this follow-up exists.

```sh
npm run release:status -- --state /absolute/release-state
npm run release:resume -- --state /absolute/release-state --build --upload --publish
```

The plan freezes `publisherHost` (the kickoff host by default). Only that host can
upload/publish; Windows workers cannot. A host-global canonical repository
lease excludes another release state or checkout publishing concurrently, even
for another version. This prevents an older delayed release overtaking a newer
one. The fresh publication check also enforces increasing public versions.
This is deliberately a designated-host protocol, not a distributed lock. Moving
publication to another host requires reviewed recovery and a new frozen plan;
never steal a foreign host's lease or silently alter candidate evidence.

The worker lease records host, PID and process start identity. An orphaned local
owner can be recovered; a live or foreign owner cannot be stolen. Native builds
run in a child worker that owns its completion receipt so a coordinator restart
does not require restarting packaging. Resume checks active worker identity and
waits for its receipt. Preserve its logs and candidate files if recovery cannot
establish completion.

A known failed stage requires a diagnosis, recorded without another approval
when the action is already authorized:

```sh
npm run release:resume -- --state /absolute/release-state --build --upload --publish --retry-reason 'Network outage resolved; frozen inputs and approved package hashes unchanged'
```

Do not supply a generic retry reason to chase a green result. A failing assertion
or unknown native behavior remains a blocker. Missing remote results are
waiting; a changed hash invalidates the result and dependent receipts. An
upload/network failure never implies rebuilding the package. If publication
timed out, the runner inspects remote draft state before deciding whether to
publish or continue the public audit.

Finalization requires `MYTHRA_RELEASE_STATE`. It rejects missing/failed/stale
required receipts and freshly downloads the complete draft for signature,
provenance and hash comparison before publication. This moves enforcement out
of conversation memory while retaining the existing independent CI check.

## Receipts and trust

Receipts bind the plan/source, platform, checker version, timestamps, evidence
file hashes and dependency receipt hashes. Successful receipts are immutable;
conflicting results require diagnosis. Stage-specific checker schemas reject
generic passed JSON. Native receipts also bind the exact
package and require complete cleanup/restoration. Paths must stay within the
state directory, including through symlinks. A successful command exit alone
does not establish a native UI result.

These are local operational records, not a cryptographic attestation against a
malicious local administrator. Run checkers from the trusted frozen repository;
do not accept arbitrary “passed” JSON from untrusted content. Keep private
fixtures/screenshots under the protected state directory and share only the
sanitized outcome.

## Design sources and measured limits

T3 Code resolves release source once, serializes publishers, builds shared JS
once and fans out to native jobs. We use the frozen-source dependency graph and
publisher ownership pattern. Mythra retains separate platform production
outputs; T3's shared bundle and paid runner sizes are not assumptions here.
[T3 Code release workflow](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml).

Browser Use's desktop workflow makes its previous-release selection explicit
and scopes non-canceling build concurrency by tag/platform. Zen's build workflow
separates asset preparation from release creation. These support immutable
metadata and staged publication; their signing options or partial-platform
publication policies are not adopted.
[Browser Use](https://github.com/browser-use/desktop/blob/main/.github/workflows/release.yml),
[Zen](https://github.com/zen-browser/desktop/blob/dev/.github/workflows/build.yml).

No source proves a guaranteed Mythra release time. Record execution, runner
queue, validation, transfer/audit and operator wait separately. The successful
1.22.2 final-source gate took 10m25s and its complete Windows builder about
12m01s; reducing duplicated verification alone cannot account for hours of
coordination and profile-harness work.

`coordinator-events.jsonl` records stage starts, waits, completion and blockers.
Receipts retain checker execution timestamps; CI proof additionally retains run
queue/start timestamps and each job's start/finish times. These records separate
actual execution from waiting without reconstructing private agent transcripts.
A newer failed run on the same SHA is contradictory evidence to investigate
under `AGENTS.md`; an older green run does not excuse a known source assertion
failure. The existing complete exact-source evidence policy remains unchanged.

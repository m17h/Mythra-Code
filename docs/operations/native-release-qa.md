# Native release QA profile contract (version 1)

Use the frozen candidate executable. Confirm its frozen source contains
`RELEASE_QA_CONTRACT_VERSION: u32 = 1` in `src-tauri/src/release_qa.rs` and the
active `initialize`, `configure_context`, and `configure_window` integrations
in `src-tauri/src/lib.rs` **before launching it**. Older binaries ignore the
environment variable and can open the real profile. Do not modify candidate
bundle identifiers, package contents, installed apps, or production profiles.

## Provision an owned profile

`MYTHRA_RELEASE_QA_ROOT` is the sole supported environment variable. Use an
absolute, normalized local path with no symlinks/reparse points. Create a new
directory and `.mythra-release-qa.json` containing exactly:

```json
{"schemaVersion":1,"purpose":"mythra-release-qa","profileId":"UUID-v4"}
```

On macOS make the root mode 0700 and marker mode 0600, owned by the current
user. macOS 14 or later is required. On Windows use a local drive path; set the
current user's SID as owner, protect the root ACL from inheritance, and grant
access only to that SID, SYSTEM, and/or Administrators. Child files/directories
may inherit that safe ACL, but each must still be owned by the current user or the launching token's default owner SID (Administrators for an elevated token).
Reused trees with foreign owners, broad grants, hardlinked files, or links fail
closed. Do not copy provider homes or credentials into the profile.

Run the candidate directly with this variable inherited by its process; do not
use a launcher which drops the environment. The title is
`Mythra Code — Release QA <full profile UUID>`. Identify the
actual executable/PID and this title before every UI interaction. The normal
installed app can stay open, and must remain untouched.

The candidate routes app data to `root/app-data`, application home lookups to
`root/home`, and Windows WebView state to `root/webview`. macOS persistent
WebKit storage is OS managed, identified by a UUID derived from the canonical
root and marker UUID. Copying a marker to another root produces a different
WebKit store. Only one candidate can hold a particular root's native lock.

Providers, credential lookups, provider processes, external mutations, plugin
network/actions, and updater actions are blocked in QA. Status APIs return
unavailable, credential presence false, and model lists empty. Backend SQLite,
transcripts, native render and normal close guards remain real. Production
plugins/updater constructors and CSP remain active. QA permissions and offline
provider behavior mean this cannot prove authenticated/provider/updater flows.

## Fixed startup, onboarding and storage recipe

For a fresh profile, require `profile-open`, `window-constructed`,
`renderer-storage`, and `render-ready` events from the actual candidate PID.
Require actual visible welcome/onboarding pixels using the native UI surface.
No backend event or screenshot from another PID substitutes for that check.

Use the visible onboarding controls: **Make it yours**, choose **Light Mythra**,
**Ready**, then **Done**. After the main workspace renders, use its actual
settings UI to confirm the chosen theme. Inspect only the owned database
`root/app-data/openkiwi.sqlite3` with a read-only SQLite connection:

```sql
SELECT json_extract(value, '$.theme') FROM app_state WHERE key='kiwi.settings';
SELECT value FROM app_state WHERE key='kiwi.onboardingVersion';
PRAGMA integrity_check;
```

Require `light-mythra`, `1`, and `ok`, respectively. Do not insert these rows
directly and call that a UI save. Close normally using the request protocol
below; require accepted `close-finish` with `result: "saved"` and actual process
exit. Reopen the exact same candidate/root. Require a fresh run ID,
`renderer-storage.previous` equal to the marker UUID, no fresh onboarding,
and Light Mythra retained in visible settings and the read-only database.
Offline Codex setup can appear; dismiss **Not now** and inspect settings. Do
not authenticate or start a provider. If the UI cannot reach these controls,
record a failure with evidence, not an equivalent synthetic fixture.

This recipe was exercised on macOS with a development binary and a temporary
development bundle. Each release receipt must repeat it on the exact frozen
package. A development run does not prove that package or Windows behavior.

## Close and event schema

Wait for this process's matching `control-ready` event (profileId, PID and
runId) before sending a request. It follows the stale-nonce snapshot; sending
earlier can misclassify a new request as one from the previous launch.

Atomically replace `root/request.json` (0600/current owner on macOS; safe ACL
and current owner on Windows) with exactly:

```json
{"schemaVersion":1,"profileId":"MARKER-UUID","nonce":"FRESH-UUID-v4","action":"close"}
```

`focus` is also accepted. It shows/focuses only the validated profile's main
window, requires its full UUID title, and records `window-focused`. This can
foreground the QA window, but does not authorize input through an incorrectly
bound UI tool: require a fresh accessibility tree with the same full UUID
before every meaningful action. `close-and-dispose` requests deferred cleanup.
The candidate invokes the normal window close/save guard. Reopening ignores a
previous nonce; every close request needs a new one. Wrong identity/action,
malformed requests, unsupported platforms, invalid ownership, and occupied
locks fail with exit 78. The sole supported injected fault is the owned-profile
close recipe below; no authentication override exists.

`events.jsonl` contains objects with `schemaVersion:1`, `profileId`, a fresh
per-process `runId`, native `pid`, `kind`, and `details`. `profile-open.details`
contains `contractVersion:1`, `providers:"blocked"`, `persistentWebview:true`,
and `webviewStoreId`. Render/storage/close events are scoped by all these
identities; never combine unrelated launches. `render-failed`, `setup-failed`,
`control-rejected`, `renderer-storage-failed`, unexpected `close-finish.result:"failed"`, and nonzero exit are failures.
`close-finish.result:"cancel"` is not a successful close.

## One-shot native close save-failure recipe

When the native contract declares `closeFailureScenario`, its nonce authorizes
exactly one saved-result fault in an owned QA process. Require
`profile-open.details.closeFailureVersion:1`, normal rendered UI, completed
onboarding/settings save and matching `control-ready`. Atomically write:

```json
{"schemaVersion":1,"profileId":"MARKER-UUID","runId":"CURRENT-RUN-UUID","nonce":"CONTRACT-SCENARIO-NONCE","action":"close-save-failure-once"}
```

The production frontend performs its actual save/close protocol. Only its
successful `saved` response is converted once into `failed` at the native close
guard boundary, bound to that run, window generation and request ID. Actual
frontend save errors are never relabelled as injected. Production profiles
cannot arm the fault; a second arm in the same process is rejected.

Capture the actual native **Close Mythra Code? — Release QA FULL-PROFILE-UUID** warning, its **Keep open**
button and owned parent window through supported CUA pixels and accessibility.
Choose **Keep open** explicitly. Require matching `close-prompt-answer` with
`choice:"keep-open"`, `confirmed:false`, `accepted:true`, followed by
`close-cancelled`. Capture the recovered owned window and confirm the saved
theme/state through the UI and read-only SQLite checks above. Normal close
with a fresh nonce must then emit accepted `saved` and exit. Reopen the same
candidate/root, verify retained state and close normally again. This second,
entirely healthy run supplies the primary PID/runId for every result entry.

Retain the complete event stream and a `close-failure.json` observation:

```json
{
  "schemaVersion": 1,
  "nonce": "CONTRACT-SCENARIO-NONCE",
  "kind": "save-failure-once",
  "cause": "override-saved-result",
  "profileId": "MARKER-UUID",
  "pid": 123,
  "runId": "INJECTED-RUN-UUID",
  "requestId": 1,
  "prompt": {"screenshot": "prompt.png", "accessibility": "prompt-ax.json"},
  "recovery": {"screenshot": "recovery.png", "accessibility": "recovery-ax.json"}
}
```

Paths are relative to the state directory; list this JSON and both distinct
captures in the close result's hashed evidence. Point `affected-close-failure`
at this JSON. The validator requires the declared nonce, exactly one arm/apply
trace, matching failed request, real prompt/cancellation events, a successful
subsequent close, exit and later healthy primary launch. Other setup, render,
storage or close failures remain failures even in a different run of the same
profile. Screenshots/AX and state checks must be real observations; event records
alone do not prove visible behavior.

This tests the native guard's SaveFailed prompt and cancellation/recovery path.
It does not simulate disk-write failures, native deadlines or renderer crashes.
A selected case or known issue requiring those behaviors still needs its own
maintained recipe and actual replay; do not substitute this fault for it.

## Dispose after the final reopen

After the visible candidate and its persistent WebView writers have exited,
run the **same executable**, with the same validated environment/root:

```text
candidate-executable --release-qa-dispose-store
```

Without an explicit valid owned profile this argument exits 78 before opening
a production database or window. On macOS the maintenance process constructs
a hidden incognito `about:blank` WebView to initialize WebKit. It verifies the
live native store is nonpersistent and the callback is on the native main
thread; it loads no app frontend. It then uses the public SDK to enumerate and
remove only the root-derived persistent UUID, and enumerate again. Require
exit 0 and, for that maintenance run/PID/store:

- `webview-maintenance-initialized` with `mainThread:true`, `persistent:false`,
  and `url:"about:blank"`;
- `webview-dispose-complete` with `verifiedAbsent:true` and `stage:"complete"`.

Removal is bounded by a ten-second callback timeout and is idempotent. A
`webview-dispose-failed`, timeout, crash, or deferred event is never cleanup
success. Keep fixture data/diagnostics when cleanup fails. On Windows the
maintenance process records `webview-dispose-deferred` with
`maintenancePassRequired:false`, `rootRemovalRequired:true`; the persistent
store is entirely under the root and must be removed after writers exit.

Preserve receipts/events outside the root before deleting its owned tree.
Never infer macOS cleanup from removing the root: named WebKit stores live
outside it. Never remove the default WebKit store or broad Library/WebKit
directories. Do not remove production data to make a receipt pass.

## Supported negative checks and fixture boundaries

Using newly owned temporary roots, assert exit 78 before UI for an absent
marker, empty/relative root, marker with wrong/extra fields, linked/hardlinked
preseeded data, insecure ownership/ACL, and simultaneous use of the same root.
The disposal argument without a valid root must also fail before UI. Hash any
link target before/after to prove it was preserved. A separate-root copy of a
marker must yield a distinct `webviewStoreId`.

For existing-data fixtures, obtain a consistent SQLite online backup from a
read-only source connection and copy only selected noncredential state files.
Do not raw-copy a live database/WAL or an entire provider home. Preserve source
metadata/hashes and never move/rename the source profile. This contract exposes
no corruption, disk-write-failure, installer, provider, or crash-injection hook.
The one-shot native close fault above is the only supported fault scenario;
other cases require a maintained native recipe and evidence of the real
boundary before they may be recorded as tested.

## Optional historical upgrade evidence

This records an already required predecessor replay for later test selection;
it is not another mandatory native test. A fresh profile or arbitrary JSON
label is not upgrade evidence. The native contract lists optional `upgradeCases`
with exact predecessor tag/commit, platform/check and recipe hash. Capture only
the case actually exercised. Ordinary native acceptance can omit this proof.

The release agent prepares the maintained synthetic predecessor SQLite fixture
in the owned QA root. First initialize complete settings through the owned QA
UI and close normally only when the helper confirms its frozen defaults source
(`src/lib/appConfig.ts` and its runtime default dependency
`src/lib/providerUsage.ts`) is byte-identical to the predecessor. Unknown
runtime imports make this narrow fixture unsupported. Preserve that
source hash in the contract; a candidate dump with different defaults must not
be relabeled as a predecessor fixture. A partial settings object would acquire
defaults during replay and correctly fail preservation. Retain the predecessor
schema version, onboarding state and a nonempty synthetic draft alongside those
complete settings. Do not use Morgan's real data. The helper validates the
frozen predecessor storage schema; unsupported migrations or unexpected row
changes fail closed. Its deliberately narrow replay permits only changing the
settings theme from `mythra` to `light-mythra`, preserving other fields/rows.

Before candidate launch, with no database writer, capture the owned database:

```sh
node scripts/release-upgrade-snapshot.mjs /absolute/state/native-workers/darwin-aarch64/contract.json v1.22.1 native-storage:darwin-aarch64 before /absolute/state/evidence/upgrade-before.json
```

Use the actual native UI to select Light Mythra, save and close normally; reopen
and verify persisted settings/draft as required by the selected check, then
close normally again. Capture after the final owned process exits, before
maintenance disposal or profile deletion:

```sh
node scripts/release-upgrade-snapshot.mjs /absolute/state/native-workers/darwin-aarch64/contract.json v1.22.1 native-storage:darwin-aarch64 after /absolute/state/evidence/upgrade-after.json /absolute/state/evidence/upgrade-before.json
```

Use the actual contract path produced by the runner. Capture output must be
inside the release state. The helper copies the actual closed SQLite database,
records event-prefix hashes and profile/run/PID linkage, and rejects linked
files, active writers or pending WAL data. The after manifest is the upgrade
observation; retain it, both SQLite snapshots and native events as hashed
result evidence. The result's primary PID/run must identify that final accepted
replay. Screenshots and matching UUID accessibility evidence remain required.

Capture and qualified proof validation require Node 22.13 or newer with
`node:sqlite`; preflight this capability before optional capture. Ordinary
release commands retain the repository's existing Node support. Retain all
source state and evidence after publication so the coverage exporter can
independently revalidate it; never replace a missing snapshot with handwritten
rows or a generic passed status.

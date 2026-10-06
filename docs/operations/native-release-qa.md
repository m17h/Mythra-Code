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
locks fail with exit 78. No injected failure/authentication flag exists.

`events.jsonl` contains objects with `schemaVersion:1`, `profileId`, a fresh
per-process `runId`, native `pid`, `kind`, and `details`. `profile-open.details`
contains `contractVersion:1`, `providers:"blocked"`, `persistentWebview:true`,
and `webviewStoreId`. Render/storage/close events are scoped by all these
identities; never combine unrelated launches. `render-failed`, `setup-failed`,
`control-rejected`, `renderer-storage-failed`, `close-finish.result:"failed"`, and nonzero exit are failures.
`close-finish.result:"cancel"` is not a successful close.

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
no corruption, save-failure, installer, provider, or crash-injection hook;
those cases require a maintained native recipe and evidence of the real
boundary before they may be recorded as tested.

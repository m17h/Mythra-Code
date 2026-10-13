# Windows worker transport

The publishing coordinator calls `runWindowsWorker({ root, stateRoot, plan,
onStatus, onPrepared })` from `scripts/release-remote.mjs` within an authorized
release. The transport returns the Windows portable build handoff. It never
uploads or publishes release assets.

Use the maintained trusted-machine configuration and private LAN access guide.
The adapter establishes the native host identity and required build tools, then
prepares a dedicated detached checkout at the frozen `m17h/Mythra-Code` source.
It transfers plan/build-record/package files and the fixed runner source.
Credentials, signing keys, tokens, leases and active process state remain on
their owning machine. Preserve active applications and real profiles.

The native worker runs:

```text
node scripts/release-coordinator.mjs run --state <remote-state> --build --native-only
```

It installs the frozen dependencies, compiles and packages Windows with
`src-tauri/tauri.windows.conf.json`, retains the Windows updater signing key,
and exports its Windows build result. No automated test, CI, native GUI,
performance, upgrade-coverage or independent audit stage runs.

A completed Windows handoff identifies the frozen source/version and candidate
package. Exit 2 may mean the Mac build or publication still remains; do not
report the full release complete from Windows exit status alone. A partial
handoff stays incomplete. Diagnose the missing result, preserve the worker's
packages/logs and collect or export its result rather than rebuilding solely
because a transfer failed. No blind failure retry is performed.

Local transport ownership lives in
`<release-state>/remote/windows-x86_64/worker.json`; the native worker has its
own ownership record. Queued, running, waiting, failed and complete are distinct
states. Running records include PID and process start identity. Resume inspects
the same worker and descendants before considering a replacement. An SSH
interruption or dead parent PID does not establish that its builder exited.

Polling and collection deadlines are bounded. A local deadline preserves the
remote worker ownership for the next authorized resume. A returned handoff is
reused while its source/version and package record match. The optional
`onPrepared` callback runs after checkout preparation and before state transfer/
worker launch; private native-machine setup can use it without publishing
personal operator code or policies in this repository.

Cancellation stops the owned remote runner and every build/transfer descendant,
preserves state/logs, and confirms process-tree exit. Never close unrelated apps,
alter real profiles or launch a second owner while the existing one is uncertain.
A cancelled release stays cancelled. See
[release-coordinator.md](release-coordinator.md) for status/resume/export/merge
commands and publisher ownership rules.

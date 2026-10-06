# Windows worker transport

`scripts/release-remote.mjs` exports `runWindowsWorker({ root, stateRoot, plan,
onStatus })`. The publishing coordinator invokes it only within an already
approved release build. It returns a local directory containing the Windows
portable handoff; the owning coordinator validates and merges it under its
existing release lease. The transport never uploads or publishes release assets.

The SSH adapter reads Morgan's authoritative LAN guide on ZEDS-PC, verifies the
computer/user identity and checks Node, Git, npm and GitHub CLI availability.
It uses the existing `zeds-pc-ai` SSH alias and existing Windows credentials.
It transfers plan/receipt/evidence files and its fixed runner source. Signing
keys, bot tokens, leases and active-stage records are excluded from the handoff.

For each frozen plan it creates a dedicated detached checkout under
`%USERPROFILE%/Documents/MythraCode-Releases/<planHash>/checkout`. State, incoming
files and returned evidence are sibling directories outside the builder's
cleared output. It fetches the exact commit from `m17h/Mythra-Code`, checks the
origin, commit and clean tree, then installs the pinned dependencies. Existing
application processes and profiles are preserved.

The persisted Node runner invokes exactly:

```text
node scripts/release-coordinator.mjs run --state <remote-state> --build
```

That worker owns native build/check receipts. It exports its passed Windows
checks on coordinator exit 0 or 2. Exit 2 can mean macOS or publication remains
pending; Windows completion is determined from all required Windows checks and
CI. Missing Windows receipts remain waiting. A blocked stage, invalid evidence
or another command exit records a failure. No automatic failure retry is
performed.

Local transport state lives in
`<release-state>/remote/windows-x86_64/worker.json`. Remote ownership lives in
`<planHash>/worker.json`. Both record queued, running, waiting, failed or complete
states. A queued ownership record is saved before process launch. Running
records include the PID and process start identity; polling verifies both and
checks descendants when the runner has ended. An SSH interruption preserves
ownership. Resume collects the same worker instead of launching another one.
A lost terminal record or ambiguous launch needs diagnosis before replacement.

Polling defaults to five seconds with a two-hour collection deadline. Reaching
the deadline records waiting and releases the local transport lease; the remote
worker keeps its ownership and can be collected by the next resume. Individual
SSH and transfer/setup commands also have deadlines. A completed local handoff
is revalidated and reused on resume without another transfer or builder.

The API also accepts `transport`, `pollMs`, `timeoutMs` and `sleep` overrides for
focused tests. Eleven tests exercise validated receipt roundtrips, resume,
transport interruptions, descendant preservation, deadlines, failures, evidence
rejection, encoded arguments and an actual local child runner/export boundary.
These fixtures do not prove a native Windows release. Live Windows transport,
GUI capability and package behavior require an authorized release on the actual
PC. The transport does not close an active app, change its profile or infer GUI
success from process liveness.

Read-only capability preflight is available without preparing or building:

```sh
node --input-type=module -e 'import {createSshTransport} from "./scripts/release-remote.mjs"; const {host,user,version}=await createSshTransport().preflight(); console.log({host,user,version})'
```

The local `build.md` runbook remains operator policy. Its transfer/hash handling
must be supplied by the release coordinator if that untracked file is required;
portable receipt handoffs do not automatically include arbitrary local files.

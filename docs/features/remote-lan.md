# Remote work over LAN: design contract

Status: in development on `claude/remote-lan-work`. The product brief is
`REMOTE_PLAN.pdf`, kept as an untracked local file in the primary checkout.
This document records the decisions that turn the brief into code. If the code
and this document disagree, fix one of them deliberately.

## Goal

A switcher above **New thread** lets one Mythra Code installation work in the
live threads of another on the same network. Prompts, model calls and file
changes happen on the selected **host** using its accounts and checkout. The
**viewer** only renders. Switching machines never interrupts work on either
one.

## Vocabulary

- **Device**: one Mythra Code installation with one long-lived identity key.
- **Host**: the device whose threads are being used.
- **Viewer**: the device displaying them.
- **Link**: one authenticated TLS connection between two devices.
- **Grant**: what a host allows one paired device to do.
- **Fingerprint**: lowercase hex SHA-256 of the identity key's SPKI DER.

Host and viewer are application roles. They are independent of which side
dialed the TCP connection (see "Reverse links").

## Non-negotiable rules

1. Off by default. With **Allow access from nearby devices** off there is no
   listener and no DNS-SD advertisement.
2. No local-network activity until the user opts in. Browsing starts only when
   hosting is on, at least one device is paired, or the user chooses **Find
   nearby devices**. An upgrade must not trigger the macOS 15 Local Network
   prompt on its own.
3. Every operation is authorized in Rust from the TLS-proven fingerprint, never
   from a value in the message. The renderer receives the verified device and
   grant with each request and re-checks project scope against host data.
4. A viewer never supplies a filesystem path, provider credential, permission
   mode increase or execution folder. The host resolves all of them.
5. Credential changes, sign-ins, permission escalation, always-allow approval
   and changing device grants stay on the host.
6. Remote operations never move the host's UI: no selected thread, workspace,
   composer draft or status banner on the host changes because of a viewer.
7. Remote state lives in its own store keyed by device and thread. It is never
   written to the viewer's task store, SQLite transcripts, thread list, usage
   totals, notifications or tray counts.
8. Marked-secret question answers and raw approval parameters are never sent to
   a viewer. Everything crossing the link goes through an explicit allowlisted
   wire shape, never a copied store object. This does not make a transcript
   secret-free: **View shares the transcript**, which can contain anything the
   model or a tool printed. The approval sheet says so plainly.
9. Project scope and switched-off capabilities limit which remote operations
   exist. They do not confine what a model can do. See "What a grant really
   allows".

## Identity and storage

- Identity: an Ed25519 key generated lazily the first time the feature is
  enabled. The PKCS#8 bytes are stored in the OS credential store under
  `KEYRING_SERVICE` with an account name that includes the Tauri app identifier,
  so a dev build and an installed build are distinct devices.
- Paired devices, grants, last-known addresses, the device name and the hosting
  switch live in new SQLite tables. Public keys are not secrets, and nothing
  secret goes in those tables.
- Device name defaults to the OS hostname and is editable. **Show this name to
  nearby devices** controls whether Mythra Code advertises it. When off, peers
  learn the name only after pairing. This is not invisibility: the DNS-SD SRV
  record still carries the computer's own `.local` hostname, which the OS
  already answers for, and the setting's wording must say so.
- Every remote database write goes through one ordered writer, and its place in
  that order is taken while the in-memory decision is made under the core lock.
  So a stale save can never run after a newer decision. A caller waits for the
  real outcome of its write. It never reports failure from a timer while the
  write can still commit.
- Authority changes fail closed. Narrowing a grant, revoking and forgetting take
  effect in memory at once, and if the save fails the change is retried and
  never lost. Widening a grant and new pairings take effect only after they are
  saved.

## Discovery

- Service type `_mythra-code._tcp`, using `dns_sd.h` from libSystem on macOS and
  `DnsServiceRegister` / `DnsServiceBrowse` / `DnsServiceResolve` on Windows.
- Instance name: random `mythra-<8 hex>`, regenerated each time hosting starts.
- TXT: `v=1`, plus `n=<name>` only when the name is shared. The identity
  fingerprint is **not** published, so a passive observer cannot track a device
  across networks.
- Matching a discovered service to a paired device: dial it with a verifier that
  accepts only known paired keys. The client certificate is sent only after the
  server key passes, so an unknown server learns nothing. Anything that does not
  match stays listed as "nearby, available to pair".
- Paired devices also keep last-known addresses, so an offline device stays
  listed and a reachable one still connects when multicast is blocked.
- A device can answer on several addresses, including two on the same subnet
  from two adapters. Addresses are a set to try, and entries are deduplicated by
  proven key. Loopback, link-local and VPN ranges such as Tailscale's
  `100.64.0.0/10` are not advertised. A stored address in a VPN range may still
  be tried.
- IPv4-mapped IPv6 addresses are converted to plain IPv4 before any address
  rule, cache or dial, so the IPv4 rules cannot be bypassed.
- The 64-service limit covers everything discovery keeps, including native
  callback bookkeeping. Excess entries are dropped, not stored.
- Discovery callbacks and resolves carry the generation of the handle that
  started them. Results from a retired handle or a replaced entry are ignored.
- Windows registers one advertisement per eligible network adapter, each with
  that adapter's own address. While advertising, and only then, it rechecks the
  address list every 30 seconds and after waking, and rebuilds only when the set
  has changed. A native callback owns its own reference to the memory it uses,
  and a waiter seeing "finished" never frees that memory. If a callback never
  arrives the memory leaks, which is safe.
- `Info.plist` gains `NSLocalNetworkUsageDescription` and `NSBonjourServices`.
  The first release of this feature must keep `NSBonjourServices` in sync with
  the service type above.

## Transport

- TLS 1.3 only through `rustls` with the existing `ring` provider, raw public
  keys (RFC 7250) in both directions, via `tokio-rustls`.
- Server side accepts any well-formed client key at the TLS layer because an
  unpaired device must be able to request pairing. Authorization happens after
  the handshake from the peer's proven key.
- Client side uses one of three verifiers: pinned exact key, member of the
  paired set (discovery matching), or unpinned capture (pairing from discovery
  only, always followed by the code comparison below).
- Listener binds a persisted port on all interfaces, falling back to an
  OS-chosen port. A connection that has not finished the handshake and `hello`
  within 10 s is closed. Limit concurrent unauthenticated connections to 8.
- ALPN `mythra-remote`. No TLS resumption and no SNI.
- A source address may hold at most 3 of the 8 unauthenticated slots.
- Framing: 4-byte big-endian length then UTF-8 JSON. Frames over 2 MiB close
  the link, or over 16 KiB before a peer is authenticated. Unknown message kinds are ignored; a higher major `proto` is
  refused with a clear "update Mythra Code" state.
- Keepalive: `ping` every 15 s, link dead after 45 s without traffic.

```jsonc
{ "k": "hello", "proto": 1, "role": "viewer", "appVersion": "1.32.0", "name": "ZEDS-PC" }
{ "k": "req", "id": 7, "op": "threads.list", "args": {} }
{ "k": "res", "id": 7, "ok": true, "result": {} }
{ "k": "res", "id": 7, "ok": false, "error": { "code": "forbidden", "message": "…" } }
{ "k": "evt", "stream": "thread:<id>", "epoch": "<uuid>", "seq": 41, "data": {} }
{ "k": "ping", "t": 1 }
{ "k": "pong", "t": 1 }
```

An unknown peer receives only `proto`, `role`, `appVersion`, and `name` when
sharing is on. `paired`, `port`, `platform`, and `name` when sharing is off, go
only to a peer whose key is already paired.

Other paired-only operation: `device.update` delivers name, platform and port
after pairing and on rename.

Budgets: at most 16 authenticated links in total and 32 outstanding requests per
link. A frame must arrive whole within 30 seconds of its first byte, and a write
that stalls for 10 seconds closes the link. Discovery considers at most 64
services and runs at most 4 probes at once. Subscriptions are capped at 16 per
device and 64 MiB of ring memory overall.

Error codes: `expired`, `not_paired`, `pairing_closed`, `forbidden`, `stale_target`,
`thread_unavailable`, `busy`, `unsupported`, `host_unavailable`, `rate_limited`,
`internal`.

## Pairing

Pairing needs an open **pairing window** on the host: the user chooses **Pair a
device**, which lasts 5 minutes and closes after one approval. Without a window,
a pairing request is refused with `pairing_closed` and shows nothing, so a
stranger on the network cannot put a prompt on the host's screen.

Two ways in, both ending at explicit host approval:

1. **Nearby**: the viewer selects a discovered device and connects unpinned.
   Both sides then run the code exchange below. The host's approval sheet shows
   the code and asks the user to confirm it matches.
2. **Invitation**: the window also produces a copyable
   `mythra-invite:1:<base64url>` string with the host fingerprint, addresses,
   port, a 128-bit single-use token and an expiry. It pins the host key, so it
   works when multicast is blocked. The code is still shown.

### Code exchange

A code derived only from a TLS exporter is not safe here. An active
machine-in-the-middle controls its own server randomness and can recompute the
exporter offline, so it can try about a million handshakes in seconds until the
two 6-digit codes match. The exchange below locks each side in before it can see
the other's value, which leaves an attacker one 1-in-a-million guess per attempt.

The **initiator** sent `pair.request` and the **responder** is the other side,
whichever way the TCP connection was dialed.

1. Initiator picks 32 random bytes `Ni` and sends
   `commit = SHA-256(label || exporter || Ni)` in `pair.request`.
2. Responder stores the commit, then sends 32 random bytes `Nr`.
3. Initiator receives `Nr`, then reveals `Ni` in `pair.reveal`.
4. Responder checks `Ni` against the commit. A mismatch fails the attempt.
5. Both compute `SHA-256(label || exporter || initiator SPKI || responder SPKI
   || Ni || Nr)` and reduce it to 6 digits.

Neither side shows a code before step 4 passes. Invitations use the same
exchange and also require the token. `pair.request`, `pair.reveal` and
`pair.await` are valid only on unpaired links.

### Limits

The window admits one pending request at a time. An invitation token is checked
**before** a slot is taken, so a stranger cannot hold the slot against a device
that has the invitation. A pending request expires after 60 seconds and the host
can cancel it. A nearby request that finds the slot busy gets `busy` and costs
nothing. Five denied or failed nearby attempts stop nearby requests for that
window, and five bad tokens void the invitation; neither closes the other path.
Unpaired links stay in the unauthenticated budget until pairing succeeds, and at
most 10 requests per minute are taken from one source address. On approval the
host stores the viewer's key and grant, the viewer stores the host's key, and
the link continues as paired. Each direction is paired separately: approving a
Mac on a PC grants that Mac access to the PC, nothing more.

### Reverse links

Windows may classify a home network as Public and block inbound traffic. The
session layer therefore treats the dial direction and the role as independent:
after `hello`, either dial direction can carry host or viewer behavior. A host
with hosting enabled also dials paired viewers that are running their own
listener, offering `role: "host"`. The viewer uses a direct link when it has
one and a reverse link otherwise.

First pairing over a reverse link uses `pair.offer`: the host dials the viewer,
which must have its own pairing window open. That window starts a temporary
listener that accepts only offers and paired reverse links, and it advertises
while open so the host can find it. It grants nobody access to the viewer's own
threads and has no invitation. Paired viewer links survive when it closes. The
viewer still sends `pair.request`, and the host's approval sheet still appears.

An offer is never trusted on the host's word alone, because a hostile host can
approve itself instantly. The viewer shows who is offering and the code, and
stores nothing and sends none of its details until its own user accepts. Until
then, an offer is one more pending pairing attempt with the same limits.

Only one physical link serves a peer and role. A viewer-dialed link beats a
host-dialed one at both ends, and the choice is made under the lock that
registers the link. A refused link gets an explicit refusal in its `hello`, so
it is never mistaken for admission, and the current link keeps working until its
replacement is definitely admitted. Probes and ordinary dials share one
reservation per peer and role.

When neither direction connects, the UI says what may be wrong and what to try.
A timeout cannot prove the cause, so the wording says "may".

## Grants

```ts
interface DeviceGrant {
  scope: { kind: "all" } | { kind: "projects"; projectIds: string[] };
  view: boolean;
  work: boolean;
  capabilities: {
    fullAccess: boolean;
    gitWrite: boolean;
    checkpointRestore: boolean;
    terminal: boolean;
    manageProjects: boolean;
  };
}
```

`view` is required for everything else. `work` allows prompts, stop, one-time
approvals and answers. Each capability needs its own explicit switch and
defaults to off. A scope covers every thread in its projects, including archived
and sub-agent threads, because the sidebar and Studio show them. Only threads in
removal are excluded. Permanent deletion needs work and an on-screen confirmation.

Grants carry a revision that only the host sets. Edits name the revision they
started from, and a stale edit is refused rather than merged, so two quick
changes cannot undo each other. Narrowing a grant invalidates affected
subscriptions at once. Revocation closes the link, drops subscriptions and rejects new
operations. Work already delivered to a provider continues under host control.
A queued entry not yet delivered does not: delivery rechecks the current grant,
and an entry that lost its authority ends as rejected with a clear reason.

### What a grant really allows

A device with Work can start model turns on the host, and a model with enough
permission can read files and run commands well beyond the granted project. So:

- **Permission ceiling.** Without `fullAccess`, a turn started remotely runs at
  no more than `ask`, even in a thread the host set to full access. A read-only
  thread stays read-only. The ceiling applies per turn and never changes the
  thread's saved setting. The host enforces it when resolving the turn.
- **Honest wording.** The approval sheet states that View shows conversation
  contents and that Work lets the device run tasks and approve commands on this
  computer. It must not imply that project scope is a sandbox.

## Operations

Each row names the minimum grant. Rust enforces the capability class; the
renderer enforces project scope using data only the host holds.

| Operation | Needs | Phase |
| --- | --- | --- |
| `ping`, `host.info`, `op.status` | paired | 1 |
| `workspaces.list`, `threads.list` | view | 2 |
| `timeline.read`, `timeline.subscribe`, `timeline.unsubscribe` | view | 2 |
| `prompt.send`, `prompt.steer`, `prompt.queue`, `turn.stop` | work | 3 |
| `approval.answer`, `question.answer` | work, per the table below | 3 |
| `files.list`, `files.preview`, `git.status`, `git.diff` | view | 4 |
| `attachment.put` | work | 4 |
| `worktree.*` | work and `terminal` | 4 |
| `git.write` | `gitWrite` and `terminal` | 4 |
| `checkpoint.restore` | `checkpointRestore` and `terminal` | 4 |
| `terminal.*` | `terminal` | 4 |
| `folders.browse`, `projects.add`, `projects.remove`, project settings, prompts, skills, MCP | work, "all" scope and `manageProjects` | 4 |
| `threads.*` row actions, pins, order, queue edits, compact, fork, rollback, workflows | work | 3 |
| Run, Checks, quick actions, anything that saves or runs a shell command | `terminal` | 4 |
| Pull request writes, publishing | `gitWrite` and `terminal` | 4 |

Git hooks, filters and credential or signing helpers on the host can run commands,
so remote operations that keep those local semantics also need `terminal`.
| `preview.*` | work | 4 |

## Host side

The running app remains the host. Rust owns transport, authorization, the event
log and the operation journal. The renderer owns thread logic. Requests reach
the renderer through a `remote-host-request` event and return through a
`remote_host_respond` command, matching the existing `child-agent-request`
bridge, with a timeout in Rust.

### Bridge messages

Types live in `src/lib/remote/wire.ts`. Rust treats frames and results as opaque
JSON apart from the fields named here.

Rust to the host renderer:

- `remote-host-request`: `{ requestId, generation, device, grant, op, args }`.
  `device` is the viewer's fingerprint and `grant` its current grant with
  revision. For `timeline.subscribe`, `args` includes `needSnapshot`, false when
  the ring still covers the viewer's `epoch` and `afterSeq`.
- `remote-host-tick`: `{ tickId, generation }`, every 120 ms only while a
  subscriber is attached. No new tick is sent until the last is acknowledged.
- `remote-host-lease-check`: `{ generation }`, every 5 seconds only while an
  authenticated viewer link is live. Three missed answers lose the lease.
- `remote-host-subscribers`: `{ generation, threadId, count }`, whenever a
  thread's total changes for any reason, including `timeline.unsubscribe`,
  disconnect, revocation and grant narrowing. Rust handles
  `timeline.unsubscribe` itself, and this event is how the renderer learns of it.
  A count of 0 starts the 2-minute grace period and releases that thread's pin
  when it ends. A new request for a thread cancels the grace period.

Host renderer to Rust:

- `remote_host_attach()` returns `{ generation }`. Rust keeps refusing with
  `host_unavailable` until `remote_host_ready({ generation })`, which the renderer
  sends after reconciling. A new generation drops all subscribers, and viewers
  resubscribe.
- `remote_host_renew({ generation })` answers a lease check.
- Every generation-carrying command returns error code `stale_generation` once
  that generation has ended. That is how a renderer learns it lost the lease: it
  discards publishers and epochs and attaches again.
- `remote_host_tick_ack({ generation, tickId })`.
- `remote_host_publish({ generation, threadId, epoch, frames })`, where each
  frame is `{ seq, frame }` with `seq` increasing by one per thread.
- `remote_host_respond({ generation, requestId, result?, error? })`, where
  `error` is `{ code, message }`. A subscribe answers
  `{ epoch, seq, snapshot? }`. Rust registers the subscriber at that `seq` before
  replying. When `snapshot` is absent, the reply to the viewer adds
  `frames: [{ seq, frame }]` from the ring.
- `remote_host_thread_retired({ generation, threadId })` when grace expires, so
  Rust can drop that ring.

Viewer renderer and Rust:

- `remote_request({ device, op, args })` runs a viewer operation and returns its
  result, or an error with a `code`.
- `remote-viewer-frame`: `{ device, threadId, epoch, seq, frame }`.
- `remote-viewer-state`: `{ device, threadId, state }`, where `state` is
  `live`, `recovering`, `stale` or `removed`. It carries `host_unavailable` and
  grant narrowing to the viewer.

Viewer operation arguments, all bounded by the host:

- `workspaces.list`: no arguments, returns `{ workspaces }`.
- `threads.list`: `{ workspaceId, cursor?, limit? }`, returns `{ threads, cursor? }`.
- `timeline.read`: `{ threadId, before?, limit? }`, returns older rows as
  `{ messages, activities, history: { hasMore, cursor? } }`. It does not subscribe.
- `timeline.subscribe`: `{ threadId, epoch?, afterSeq? }`.
- `timeline.unsubscribe`: `{ threadId }`.

Rust enforces view or work on every operation. The renderer applies project
scope and eligibility, and re-checks them for each request using the `grant` it
was given.

### Thread actions independent of selection

`queuedDeliveryContext` only spreads a captured context, so it cannot address an
arbitrary thread on its own. Add one host-side resolver,
`resolveThreadExecutionContext(threadId | newWorkspaceId)`, built from current
host data: logical project binding, provider, saved model, reasoning and
sub-agent settings, project prompts and overrides, the permission policy with the
remote ceiling applied, execution worktree, readiness and task ownership. Both
local and remote callers use the same rules.

Explicit-target functions then cover prompts, steering, stop, approvals, questions
and history. A remote send must also avoid first-prompt UI callbacks and direct
`setActiveThread` calls; no-op setters alone are not enough. Durable bookkeeping
stays active: usage, titles, transcript saves and notifications still happen on
the host.

**Stop** is the outer `stopTurnAndChildren` orchestration, not `stopTurn`: it
retires the parent run, captures child frontiers and routes workflows. Extract it
with an explicit target, and validate the observed turn, run or start handle
before retiring anything. It must cover a turn that is still starting.

`threads.list` must not depend on the selected workspace. Extract the listing
with its reconciliation rules (native paging, local transcripts, tombstones,
logical bindings, child filtering) and its own request lifetime, not the global
sidebar counter. Check eligibility again before every action.

Viewing is separate from selecting. Reading a thread hydrates it without changing
host unread state, drafts or runtime preparation, and restores Cursor ownership
without selection. Paging uses per-thread provider identity and cursors. A thread
with a subscriber holds a reference-counted pin against cold transcript eviction,
released on disconnect, revocation, renderer loss or grace expiry.

### Renderer lease

Rust and the renderer can fail separately. The renderer attaches with a
generation number and renews it. If the lease is lost, Rust refuses host
operations with `host_unavailable` and tells viewers the host is recovering, even
while TLS stays up. A new generation starts new publisher epochs and must
reconcile native turn ownership, the journal, queues and pending requests before
it reports ready. Pending approvals that cannot be recovered show as expired; a
viewer never sees a confident idle state inferred from an empty store.

### Timeline streaming

A per-thread publisher runs in the renderer while a thread has subscribers. After
the last one leaves it stops publishing but keeps its ring and baseline for 2
minutes, doing no work unless the task changes. It projects the task to a
sanitized wire shape, diffs against the last published projection and hands one
frame to Rust. Streaming text uses an append patch when the new text extends
the old.

**The renderer assigns `seq`.** A subscribe runs in one synchronous renderer step:
drain buffered deltas, publish any pending frame, then take the snapshot, which is
therefore exactly the state at `(epoch, seq S)`. Rust registers the subscriber
with `afterSeq = S` before answering, so later frames are delivered once and
nothing is doubled or lost.

Anything that is not a simple upsert or append, including history prepends, order
changes, renamed message IDs and replaced text, publishes a `reset` frame carrying
a fresh bounded window. Scalars use explicit `null` to clear, because a missing
JSON key would leave a stale value on the viewer. Frames carry each item's `order`.

Snapshots are byte-bounded and paged to fit the frame limit, and a single
oversized message is truncated with a marker.

```ts
interface ThreadFrame {
  status: TaskStatus;
  activeTurnId?: string;
  workingStartedAt?: number;
  error?: string;
  upsertMessages?: WireMessage[];
  appendMessageText?: { id: string; text: string }[];
  removeMessageIds?: string[];
  upsertActivities?: WireActivity[];
  removeActivityIds?: string[];
  approvals?: WireApproval[];
  queuedTurns?: WireQueuedTurn[];
  history?: { hasMore: boolean };
  /** Replaces the viewer's window for this thread. */
  reset?: { messages: WireMessage[]; activities: WireActivity[] };
}
```

Publishing is driven by a `remote-host-tick` event that Rust emits every 120 ms
while any subscriber is attached, and which never runs otherwise. Timers and
`requestAnimationFrame` must not drive it, because a hidden webview throttles or
suspends them. The task store buffers streaming text behind
`requestAnimationFrame`, so **each tick must drain those buffers before
projecting**, or a minimized host republishes unchanged text. The tick is
acknowledged so a stalled renderer cannot queue events without limit.

Rust keeps a ring per thread, at most 512 frames or 8 MiB, tagged with an epoch
UUID and an increasing `seq`. A subscribe with `epoch` and `afterSeq` replays
when the ring still covers it. Otherwise the host returns a fresh snapshot with
the current `seq`.

Wire shapes are explicit allowlists, including nested fields, and apply to
snapshots, patches, replay and errors alike. They drop attachment paths and image
URLs, skill and dependency paths, and raw approval parameters, and they redact
marked-secret answers. A viewer sees an approval as a typed summary with only what
it needs to decide.

### Minimized hosts

While hosting is on:

- While at least one authenticated viewer link is live, macOS sets
  `WKPreferences.inactiveSchedulingPolicy` to `none` on the existing preferences
  object and holds an `NSProcessInfo` activity so App Nap cannot pause the
  process. Both end when the last link closes, so an idle host saves power as
  usual. The API starts at macOS 14; older systems skip it.
- The tick above drives publishing on both platforms.
- Timer-driven transcript saves and health probes may still slow down while
  hidden. A working stream does not prove they do not.

This is the first behavior to prove on real machines. Hosting after Mythra quits
is out of scope.

### Operation journal

Every mutating request carries a viewer-generated `opId` and a per-host, strictly
increasing `opSeq`. Rust atomically claims a unique `(device, opId)` row with a
digest of the request **before** dispatching to the renderer. Same `opId` with a
different digest is refused. Results:

- `pending`: claimed, not yet answered.
- `accepted`: with `threadId`, and `turnId` or `queuedTurnId` once known.
- `rejected`: with an error code.
- `uncertain`: dispatched with no confirmed outcome, including a renderer timeout,
  a lost lease or a `pending` row found after restart. Never retried automatically.

A repeated `opId` from the same device never re-executes. It returns the recorded
result, or waits for the in-flight one. `op.status` reads the same row. Rows are
scoped by device and capped at 1,000. Pending and uncertain rows are never
evicted. If only such rows remain, new work gets `busy`.

Eviction must not turn "accepted" into "never seen". Each device keeps an
`evictedThrough` watermark. An `opSeq` at or below it that has no row returns
`expired`, and is never executed. `host.info` returns the highest `opSeq` seen so a
viewer that lost its counter can resume above it.

Viewer rule after a lost acknowledgement: reconnect, ask `op.status`. Offer Retry
with the same `opId` only for `unknown`, which now proves the host never admitted
it. `rejected` needs a new attempt with a new `opId`. `expired` and `uncertain`
say: "We couldn't confirm whether this was sent. Check the conversation before
sending it again."

**The journal alone is not an execution receipt.** The durable queue resets
`sending` entries to `queued` on restore, so a reload after the provider accepted a
prompt could send it again with no retry from anyone. Remote prompts therefore
carry `opId` through queued entries, first-prompt attempts and provider-start
receipts. A delivery disposition is persisted before dispatch, and a dispatched but
unconfirmed entry restores as uncertain, never as queued. Delivery returns a
structured result with thread, message, queue and turn identities plus uncertainty,
not a boolean.

### Approvals and questions

Targets are opaque host handles bound to renderer generation, provider instance,
thread, turn, method, item and request. The host validates and consumes a handle
atomically at native dispatch, so a second viewer gets `stale_target`. Stop uses
the same kind of handle. "Answer this exact request" is never downgraded into
"send this as a new message". The viewer sends a narrow decision; the host rebuilds
the provider response from the request it holds, and never falls back to a stronger
option.

| Method | Remote behavior |
| --- | --- |
| `execCommandApproval`, `applyPatchApproval` | Allow once or Deny |
| Other command and file approvals | Allow once or Deny, each only after an explicit adapter exists |
| `claude/can_use_tool` | Allow once or Deny with no permission updates. `AskUserQuestion` is a question form |
| `cursor/request_permission` | Exactly `allow_once` or `reject_once`. If either is missing, that action is disabled |
| `item/permissions/requestApproval` | Deny only. Allowing is permission escalation and stays on the host |
| `item/tool/requestUserInput`, `cursor/ask_question` | Typed answers or cancel |
| `mcpServer/elicitation/request` | Host only for now |
| `openkiwi/subagents/change` | Host only: it changes saved settings |
| Anything else | Unsupported until mapped |

Host-only requests show as "Continue on ZEDS-PC to answer this request."

## Viewer side

### Same app, different machine

This is the governing rule for everything the user sees. Switching to a remote
machine must look and feel like working locally. The user gets the same sidebar,
conversation, composer, Studio, palette and shortcuts, filled with that machine's
projects, threads, models and files. It is not a smaller remote screen.

- **Reuse, don't rebuild.** Remote mode renders the real components through
  environment seams. A remote-only component needs a reason, such as a host
  folder browser replacing a native dialog.
- **Route first.** A control works against the active machine wherever that makes
  sense. It is disabled only when the capability is missing, and then it says
  which switch grants it. It is hidden only when it can't mean anything remotely.
- **Parity includes defaults.** Model and provider pickers, project prompts,
  skills, `@` file mentions, workflows, the Run and Checks buttons and usage all
  come from the host, because that is where the work runs.
- **The machine is always named**, so "looks local" never means "can't tell where
  this runs".
- **Every stored key includes the machine**: drafts, question drafts, commit and pull
  request drafts, feedback, panel state. A remote ID or path that happens to match a
  local one must never share its data.
- **No import of local defaults.** A remote control never falls back to this
  device's settings.

Decisions for things that have no direct remote meaning:

| Action | On a remote machine |
| --- | --- |
| Open folder, add project | An in-app browser of the host's folders. A native dialog would open on the other machine's screen. Needs Work, an "all" scope and the `manageProjects` capability. |
| Reveal in Finder or Explorer, open in editor | Hidden, with Copy path offered. It would act on a screen the user can't see. |
| Attachments and file drops | Uploaded to the host with `attachment.put`, then attached as usual. |
| Terminal | Runs on the host, with the `terminal` capability. |
| Local web previews | A click opens this device's normal browser on a temporary `127.0.0.1` tunnel to that one host port, through the authenticated link. It never runs in the app's webview, and it closes when idle, on revocation or on link loss. Needs Work. |
| Voice input | Stays on this device. The text goes to the host. |
| Notifications | Shown on this device for the visible remote machine, labeled with it. |
| Settings | Stays this device's settings, labeled so. Project-level settings shown in context belong to the host. |
| Sign-ins and accounts | The host's. A missing sign-in explains that it must be done on that machine. |
| Project settings links | Open a project editor for the host's project, never the local Settings project list. Saving needs `manageProjects`. |
| Links in a conversation | A click opens public web links in this device's browser, like local. `localhost` and private addresses on the host go through `preview.*`, never this device's `localhost`. |
| Pins, project order | The host's, the same from either machine. |
| Model favorites, theme, panel sizes | This device's. |
| Export, copy, image download | Only when the user asks, as an explicit exception to host content not being kept. Never a background cache. |
| Tray and status counts | This device plus the visible machine, labeled. The desktop notification plugin reports no click, so a remote notification also appears in the app with an **Open** action. Focus alone never switches machines. |

Grants offer a **Full control** preset for the user's own machines, which turns on
every switch at once. It is a shortcut in the editor, not a new kind of authority.

### Structure

- `MachineSwitcher` is a dropdown in the sidebar header, next to the app title and
  directly above **New thread**: **This Mac** / **This PC**, paired devices (kept
  when offline) and nearby devices. Switching to a paired online device takes one
  click.
- **The switch animation:** the current content fades out moving up, then the new
  machine's content fades in moving down. It covers the sidebar lists, conversation
  and Studio, and leaves the title bar and switcher still. It uses only `opacity` and
  `transform`, honors reduced motion, and never waits on the network: the incoming
  content is whatever is already known, and fresh data fills in without another
  transition.
- **Speed is part of parity.** Remote work should feel local, not merely correct:
  - A paired online device keeps its link and an in-memory copy of its workspace and
    thread lists and recent timelines, refreshed in the background. Switching back
    and forth shows them at once, and the copy is dropped on exit or revocation.
  - A sent message appears immediately, labeled by the outbox state until the host
    accepts it. Typing, scrolling and switching threads never wait for the network.
  - Streaming text is paced with the same smoothing as local turns.
  - Loading placeholders appear only when nothing is known yet.
- Selecting a remote device swaps what the real workspace and thread lists, the
  conversation pane and the Studio dock display. The local tree stays mounted and
  running underneath, so local work and listeners are undisturbed.
- **Staying mounted does not isolate input.** An active-machine router sends every
  global path to the visible machine: shortcuts (Escape stops the remote thread,
  never the hidden local one), the command palette, native file drops, and portals.
  A path is disabled only under the rules in Same app, different machine. Hidden local UI is inert and its portals close on switch. Switching
  is blocked during a voice session. Local approvals and notifications stay
  available and clearly labeled as this device. Notifications must not treat the
  hidden local thread as being watched. Settings is labeled as this device.
- The conversation header and composer always name the active machine, including
  with the sidebar collapsed.
- `useRemoteStore` holds workspaces, threads, timelines, drafts and the outbox
  keyed by device. Thread drafts use `device/thread`; a new thread's draft uses
  `device/workspace/draftId`, moved to `device/thread` when the host creates it.
  Host content is not persisted beyond the live session, except unsent drafts and
  the outbox.
- `ChatTimeline` splits into the existing local adapter and a presentation-only
  timeline beneath it. The presentation layer receives a **timeline environment**
  covering every descendant: task and child lookups, awaiting state, steer status
  and actions, question records, approval capabilities, feedback, parent-run labels
  and image previews. Remote mode supplies its own environment and never falls back
  to local stores or native provider commands. The scroller remounts on
  `[deviceId, threadId]`.
- The composer's send reports `accepted`, `rejected` or `awaiting confirmation`, not
  a boolean. A lost acknowledgement must not hand back a freely sendable draft,
  because that would bypass the outbox. A failed remote send never falls back to the
  local machine.
- A device has one logical session. Direct and reverse links are generation-fenced,
  so a losing link's close cannot mark the device offline or drop its subscriptions.
- On disconnect the draft stays, the view is labeled stale and remote actions
  are disabled while the host keeps working. Reconnect uses backoff of 1, 2, 5,
  10 then 30 seconds, and resubscribes with `epoch` and `afterSeq`. A restarted
  viewer has no matching baseline, so it always takes a fresh snapshot.

## Settings

Settings → Connections → **Devices**: name this device, **Allow access from
nearby devices**, whether the name is shared, **Pair a device** with the
invitation, the approval sheet, and paired devices with their grants, last seen
state and **Revoke**. Changes here take effect immediately rather than waiting for
Save, and the pane says so. The pane loads with Settings' lazy boundary, so the
always-mounted switcher must not import it, and preloading Settings must not start
discovery.

### Connection states and wording

| State | Wording |
| --- | --- |
| macOS Local Network blocked | Mythra Code can't access your local network. On this Mac, open System Settings → Privacy & Security → Local Network and turn on Mythra Code. Then choose Try again. |
| Windows firewall suspected | Windows may be blocking connections to Mythra Code on ZEDS-PC. On that PC, open Windows Security → Firewall & network protection → Allow an app through firewall, and allow Mythra Code on Private networks. You may need an administrator. |
| Public network detected | Windows marks this network as Public. Only if this is your trusted home or work network, open its Wi-Fi or Ethernet settings and change Network profile to Private. Don't change this on public Wi-Fi. |
| Guest Wi-Fi suspected | This network may keep devices apart. Connect both computers to the same non-guest network, or ask the network owner to allow devices to connect. An invitation won't bypass this restriction. |
| Versions differ | These versions of Mythra Code can't connect. Update Mythra Code on ZEDS-PC in Settings → Updates, then try again. |
| Access removed | Your access to ZEDS-PC was removed. Your draft is saved. Ask someone at ZEDS-PC to pair this device again. |
| Connection lost | Connection lost. This conversation may be out of date. Your draft is saved. Work already started on ZEDS-PC may still be running. |

Viewing and hosting are separate relationships with one device. Being viewed by
a device says nothing about being allowed to view it. Only a successful viewer
authorization or a new pairing clears Access removed, and the switcher reports
the viewing relationship alone.

macOS has no general way to ask whether Local Network access was granted. Only a
DNS-SD policy-denied result counts as evidence, and the first attempt can fail
before the user answers the prompt, so it is retried.

## Phases and acceptance

1. **Prove the connection.** Discovery, pairing, an authenticated ping, reverse
   links, Devices settings and a switcher showing live state. Synthetic data
   only.
2. **Live viewing.** Machine switching, host projects and threads, paged
   history, live streaming, reconnect and replay, and minimized-host behavior.
3. **Remote work.** New and continued text threads, queue, steer, stop, questions
   and one-time approvals across all five provider choices.
4. **Studio parity.** File previews, Git status and diffs, then attachments and
   worktree controls, then separately granted Git writes, checkpoint restore and
   remote terminal, each with host-side safeguards.

Acceptance scenarios from the brief: discover and pair without entering an
address; a prompt changes only the selected host's checkout; switch machines
during a live stream; revoke access while connected; drop the network just after
the host accepts a send and recover without sending twice.

## Verification policy

Morgan lifted the `AGENTS.md` limits for this work on 2026-11-06: they were written
to protect the release process, not to block checking. So type checks, and tests
that prove this feature, are allowed. The release rules still stand: no version
change, tag, release or hand-built Windows release without an explicit request.

Compile with `cargo check` and `npm run build` on both macOS and real Windows, and
type-check with `npx tsc --noEmit`. Real-machine proof (packaged discovery, OS
prompts, Windows inbound blocking and minimized streaming) needs a person at the
machines to click through the prompts and pairing.

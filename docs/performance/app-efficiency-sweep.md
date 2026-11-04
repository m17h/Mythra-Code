# App efficiency and reliability sweep after 1.31.8

This topic branch used all 12 available Sol worker slots across startup,
timeline rendering, frontend state, native persistence, provider events,
sub-agents, Settings, Git/terminal, voice/files, scheduling/workflows,
usage/pricing and context/architecture. Workers coordinated file ownership and
source-reviewed one another's changes. Opus led the substantial storage,
pricing-cache and live-transcription work; Sol reviewed those implementations.
The originating agent integrated the changes and performed the final source
pass.

These are source-derived improvements. No desktop timings, memory measurements,
benchmarks, automated tests or GUI checks were run under repository policy.
Compilation results and remaining limits are recorded below. This is not a
claim that every feature is bug-free or that a measured speedup was established.

## Implemented areas

| Area | Result | Expected impact |
| --- | --- | --- |
| Startup storage | Batch durable-state reads into one native snapshot request, preserve per-key recovery and avoid redundant cache writes/validation | Less startup IPC and repeated serialization; no deferred settings or changed initial defaults |
| Native transcripts | Borrow serialized entries, move decoded values and avoid retaining copied old chunks during comparison | Fewer deep copies and lower transient allocation while preserving transcript contents |
| History save ordering | Return full history and its write token atomically; serialize initial reads and saves per thread | Prevent mismatched write tokens and delayed reads replacing newer save state in the same renderer |
| Live dictation | Replace repeated chain scans with successor lookups and membership sets; maintain exact Unicode character totals | Linear ordering/membership traversal per emission instead of quadratic scans; full-text emission and commit validation remain unchanged |
| Recorded dictation | Borrow raw WAV input and consume fallback audio buffers synchronously | Avoid an extra whole-recording copy and a redundant input-buffer allocation |
| Pricing displays | Cache validated display evidence by storage revision and preserve clock-driven refreshes | Avoid reparsing unchanged catalogs and rerendering unchanged pricing snapshots; accounting remains separate |
| Pricing downloads | Enforce a byte cap while reading, cancel unread bodies and share identical concurrent requests | Bound buffering and avoid duplicate downloads/checking-state races |
| Usage dashboard | Group model buckets once and memoize period calculations | Avoid repeated whole-history filtering while expanding rows or changing display measures |
| Settings | Compare independent drafts separately and fast-path identical values | Avoid serializing unrelated projects/profiles for each text edit |
| Updater/catalogs | Dispose late native updater handles and retain explicit refresh requests after failed predecessors | Less retained native state and more reliable refresh ownership |
| Git | Coalesce passive auto-publish polls; prevent duplicate history reads; reconcile partial failures without erasing errors | Avoid continuous redundant scans and stale status after failed operations; mutations are not retried |
| Timed prompts/workflows | Use a linear queue-head lookup, batch missed entries, retire stale clock callbacks and settle failed command activity | Less queue rebuilding and no orphaned timers or permanently live command rows |
| Managed sub-agents | Own one slot-release retry timer per activation and clear stale timers | Fewer duplicate retries and no detached timer retention |
| Provider events | Reject callbacks, errors and health-probe results from disposed hook lifetimes | Avoid stale UI/store mutations and unnecessary work after teardown |
| Timeline/image preview | Bound modal identity sampling, defer hidden tool projection and guard stale clipboard/dialog callbacks | Less allocation during streaming and fewer stale UI callbacks |
| File browser | Bind directory/search results and attachment actions to their owning project/folder | Prevent late results from constructing paths in the wrong folder |
| Startup/close recovery | Retain startup failure stage without optional bootstrap; cancel obsolete close watchdogs | Prompt failure acknowledgement and fewer retained native timer resources |
| Final reasoning | Claim assistant deltas, materialize pending reasoning and seal compatible unfinished rows before cleanup | Preserve the final renderer reasoning suffix and avoid rows left running after completion |

## Architectural decisions

The larger improvements were kept behind existing authority and data-recovery
boundaries. Startup batching changes transport, not which settings are loaded.
Superseded settings writes also release their captured serialized payloads while
keeping the existing acknowledgement, retry and flush chain. Transcript writes
retain fail-closed validation of saved data; lower allocation does not mean
skipping corruption checks.
Pricing caches retain one parsed copy of display evidence only when the catalog
has at most 900 model rows; larger restored catalogs remain fully readable
without being retained. This trades resident cache memory for less repeated
parsing and allocation, while recalculating clock-sensitive status. Live transcription keeps its exact text, order, limits and emission
protocol; it uses local indexes rather than a persistent cache needing complex
invalidation. Architecture documentation now describes current turn preparation
and the native/managed delegation split.

Several proposals remain deliberately unimplemented:

- **Completed transcript append-only saves:** full snapshots also preserve edits
  to prior turns. Removing them without reliable dirty-region tracking risks
  losing saved history. A boundary-aware snapshot design is a separate change.
- **Whole-timeline prefix caching:** promising upside, but late events,
  steering, history prepend and optimistic rekeying cross the cache boundary.
  It needs stronger evidence and a dedicated design.
- **Long-lived sub-agent ownership indexes:** current evaluation is already
  event-driven and coalesced. A new cache adds takeover/Stop invalidation risk
  without evidence of a common bottleneck.
- **Deferred terminal reads:** retained output can roll over before a deferred
  read and hidden windows stop animation frames. Naive batching can lose text
  or ANSI bytes; xterm already queues parser work.
- **Shared Git observation caches:** stale data on a publishing path is more
  costly than a few saved subprocesses. Identical in-flight read sharing is a
  safer future boundary than a freshness TTL.
- **Larger provider read buffers:** extra per-process memory for an unmeasured,
  likely modest benefit was not prioritized.
- **Prepared-turn architecture extraction and shorter model context:** these
  remain recommendations only. See [model context recommendations](model-context-recommendations.md).
- **Frontend bundle splitting:** compilation still reports large JavaScript
  chunks, including the main app chunk. A dedicated dependency/loading design
  could improve cold loading; this sweep does not establish the runtime cost
  or change chunk-loading boundaries.

## Additional whole-branch review

At Morgan's request, Opus 5.5 reviewed the complete branch first and fixed four
issues. Twelve Sol reviewers then reviewed the resulting branch, implemented
five further corrections and challenged one another's patches. Root reread the
integrated diff and the corrected ownership, persistence and completion paths.
No further concrete source defect was found in the final pass.

Opus corrections:

- Preserve Git operation results and follow-up refreshes when the user switches
  tabs within the same checkout.
- Keep valid prior file-search results visible during debounce, while retaining
  project/folder ownership checks.
- Claim queued assistant deltas before flushing reasoning during completion, so
  an unidentified assistant row cannot be left streaming.
- Let the initial auto-publish effect invalidate an ongoing scan; only periodic
  polling reuses it without queuing another pass.

Sol corrections:

- Preserve snapshot replacement for unfinished logical turns whose native tail
  was sealed by a full save. Reopening or reading the transcript must not make
  the next save append that turn again; load older pages before a replacement.
- Seal only compatible unfinished reasoning buffers, including ownerless or
  ID-less cutoff cases, without relabeling historical terminal rows.
- Reject predecessor health results while a native follow-up activation is
  awaiting its own turn identity, both before and after the probe.
- Observe the current enabled-project configuration after the asynchronous Git
  baseline read, so concurrent enables also request their immediate scan.
- Bound pricing display-cache admission without truncating valid saved or
  returned catalog data.

## Verification and limits

Each worker traced its changes and obtained peer source review; root reviewed
the integrated branch. Compilation does not establish runtime correctness,
measured performance, Windows rendering or model behavior. Both final frontend
and native macOS compilation passed after the additional review corrections:

- Frontend: `npm run build` (Vite production bundle).
- Native macOS: `cargo build --manifest-path src-tauri/Cargo.toml --lib --release`,
  reusing the existing release target directory. No packaging, signing,
  notarization or publishing was performed.

The frontend compiler reports large chunks; that follow-on is recorded above.
Windows compilation and live platform behavior were not exercised. Automated
checks remain disabled under repository policy. The topic branch is
`codex/app-efficiency-sweep`; these changes are not merged or released.

Successful background Git reads no longer clear the visible operation error.
It stays until the next Git action or explicit refresh, which also applies to
"wait for the current operation" messages that a poll used to clear.

The transcript ordering fix covers the renderer's own queued operations and
atomically paired native reads. It does not replace the existing last-writer-wins
full-snapshot recovery policy for conflicting external writers. A stronger
multi-writer protocol needs a separate design.

Pricing display caching relies on the app's revision-tracked writes and external
storage events. Arbitrary same-document writes outside the persistence layer,
or storage becoming inaccessible without an observed change, can leave the
previous cached display until the next invalidation. No supported production
writer bypassing that layer was found; no speculative raw-read cache redesign
was added.

No model-context configuration or assembly, tools, skill content, selected
models, reasoning settings, billing modes, model output limits or animations were
changed to obtain smaller inputs. Correctness fixes do affect stale/cancelled
execution and restore previously lost renderer information, so this does not
claim that every buggy execution would produce identical outcomes.

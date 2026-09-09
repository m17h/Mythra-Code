# Post-1.15.7 review — 2026-09-09

Reviewed the complete working-tree delta from the published `v1.15.7` release
(`6b898d7e`), including `b76c088` and the uncommitted changes present at the
start of the review. The starting delta covered 39 files. Existing edits were
preserved; no release version, signing configuration, tag, or publication changed.

## Findings addressed

- **Claude could report success after a failed exit.** The assistant `end_turn`
  fallback accepted a later crash, cancellation, or forced reap. Recovery now
  requires a successful native exit. A new streamed message also invalidates
  the previous answer's recovery evidence before its final assistant envelope
  arrives. Explicit provider results retain precedence.
- **Stop was unavailable during skill preparation.** Ordinary sends now enter
  the starting state before awaiting skill resolution. Stopping during that
  wait returns the undelivered prompt without creating a bridge, worktree, or
  provider process. Existing-thread and draft-thread cases are covered.
- **A stopped workflow could still submit its prepared prompt.** Workflow
  steps check stop intent after skill loading, before checkpointing or sending.
- **An empty promise rejection was labeled Updated.** Usage refresh now tracks
  rejection independently of its error payload, preserving failure status and
  backoff even when a provider supplies no error detail.
- **The new relay animation repainted continuously.** Its comet now moves a
  composited layer with `transform`, preserving the original path, timing,
  clipping, and reduced-motion behavior at different card heights.

## Review scope and retained behavior

Inspected selected-folder skill matching, path validation, size bounds, startup
preparation, queued/steered sends, child-agent delivery, schedules, and workflow
steps; Claude lifecycle recovery, tool restrictions and model forwarding;
account-owned quota snapshots, parsing, failure/backoff behavior, freshness,
provider events and settings/composer model consistency; and relay CSS.

Integration tests confirm that changing OpenAI accounts immediately hides the
previous account's quota and rejects its delayed response. A temporary failure
retains the current account's reading with its age. Existing skill tests cover
out-of-folder sources, disabled and duplicate names, forged delimiters, and
bounded expansion. Provider catalogs retain their model IDs and aliases.

## Performance evidence

A controlled Chromium 151.0.7922.34 fixture with 12 running relay rails, measured for one
2.6-second cycle after warmup, alternated the old background-position animation
and the transform path twice:

| Variant | Paint events | Total recorded Paint duration |
| --- | ---: | ---: |
| Original, run 1 | 2,366 | 56.230 ms |
| Transform, run 1 | 0 | 0 ms |
| Original, run 2 | 2,366 | 61.547 ms |
| Transform, run 2 | 0 | 0 ms |

This isolates the rail and does not measure overall application FPS, GPU work,
battery life, or provider latency. Real-browser tests check the actual relay
component's path and stable layout at 48px and 104px heights and reduced motion
in Chromium and WebKit. The benchmark is reproducible with
`node scripts/benchmark-relay-animation.mjs`.

The reviewed safeguards add 225 bytes to Safari startup JavaScript compared
with the exact working tree at the start of this review. Relative to the
existing budget caps, the necessary adjustments are 203/188 app-entry bytes,
133/118 startup JavaScript bytes, and 6/6 CSS bytes for Safari/Chrome. These
small correctness costs are recorded explicitly in `performance-budgets.json`;
total JavaScript caps are unchanged. They are not claimed as bundle savings.

## Completed validation

- macOS: full `npm run verify` passed, including lint, TypeScript, native
  Clippy/check, 1,668 unit/integration tests, 159 Chromium browser tests,
  159 native Rust tests, build, release-configuration checks, and bundle gates.
- Windows: the isolated source snapshot passed the same checks, with 1,668
  unit/integration tests, 159 Chromium browser tests, and 160 native Rust tests.
  The first complete run reached the bundle gate and flagged the small recorded
  growth; rerunning that gate with the reviewed exact limits passed. Production
  source was unchanged between those checks.
- WebKit on macOS: 19 focused relay, streaming, and usage-popover tests passed.
- The reproducible benchmark script reproduced zero recurring Paint events for
  the transform path in both alternating runs.
- `git diff --check` passed. Changes remain uncommitted for review.

## Validation boundaries

All test fixtures use synthetic prompts and local processes. No paid model
turns, account sign-outs, or authentication flows were exercised. Native unit
checks are distinct from a full interactive provider smoke test, and static
review plus tests cannot establish absence of every regression.

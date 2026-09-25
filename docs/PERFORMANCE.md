# Mythra Code performance scorecard

Mythra Code treats performance as a compatibility boundary: an optimization is
not complete if it makes an existing feature unreliable, hides content, or
makes another supported platform materially worse.

## Deterministic build evidence and review policy

`npm run verify` builds the production renderer and checks that the scorecard
can measure a supported minified Safari 13 or Chrome 105 build. Missing or
invalid build metadata, manifest entries, startup assets, measurements, or
profile references fail the check. Byte growth alone does not fail CI.

The scorecard reports the critical `App` entry, complete synchronous startup
JavaScript and CSS, and complete JavaScript and CSS bundles as raw and gzip
bytes. The combined startup and total numbers sum their constituent file
measurements. Raw bytes help track local parse and evaluation work; gzip helps
track transfer size. Neither measures wall-clock startup or proves a user
experience improvement.

The four target-specific raw values in
[`scripts/performance-budgets.json`](../scripts/performance-budgets.json) remain
fixed historical references. `budgetEvaluation.checks` preserves the earlier
fields for scorecard readers: `limit` is the historical `referenceBytes`,
`withinReference` reports whether the build is at or below it, and `deltaBytes`
and `deltaPercent` show the difference. `passed` now means the measurements and
profile are valid. Do not edit historical references or `reviewedExceptions` to
make growth disappear.

Review increases in the context of the feature, the startup closure, total
bundle, both build targets, and native interaction evidence. A lazy boundary
can lower startup bytes while raising total bytes; a smaller bundle can still
run slower. The `historicalComparisons` section shows cumulative changes from
profile-matched snapshots. Historical snapshots without a recorded build
profile remain visible but have `comparable: false`, so a release delta is not
guessed across different targets. Future release snapshots should record their
build profile and raw/gzip measurements to enable a direct comparison.

For a local artifact after building, run
`npm run performance:scorecard -- --check --output /absolute/path/to/scorecard.json`.
The command uses the existing build without rebuilding it. CI uploads the JSON
when verification reaches the scorecard step, even if a later check fails.

The scorecard also reports, but does not hard-gate, metrics whose wall-clock
variance is too high for shared CI. A metric should become a gate only after
repeated measurements show that normal variance is less than half the smallest
regression the project would act on.
Use the [opt-in native A/B harness](performance/native-harness.md) for paired
process/window and idle-resource captures; its first runs are pilots until the
full capture loop has been validated on both native platforms.

## Release-time cost

The normal verification path only measures the renderer build it already made
and uploads a small JSON report. Native A/B captures are opt-in and do not run
in CI or the release scripts. Keep cross-platform browser, Rust, signing,
provenance, and public-asset checks: each covers a different failure mode.

The Windows release machine currently repeats the full verification suite.
Although hosted Windows CI also runs it, the release machine's Node and Rust
toolchains are not pinned to the hosted versions. Do not skip that local run
solely because CI is green. A future fast path needs a fail-closed attestation
of the exact merged commit, latest successful canonical main-push workflow,
both platform jobs and required steps, plus matching recorded toolchains;
otherwise fall back to local verification. Measure actual release-machine time
saved before adding that complexity.

## Real-world diagnostics

Settings → General → Diagnostics exports privacy-safe local thread-opening
samples. Summarize an export with:

```sh
npm run build
npm run performance:scorecard -- --diagnostics /absolute/path/to/mythra-code-diagnostics.json
```

The `realWorld.rendererLaunch` summary reports the number of renderer launches
and nearest-rank p50/p95/maximum milliseconds for shell commit, composer mount,
and the first frame after shell commit where the browser had an opportunity to
paint. Each stage has its own sample count because a stage may be unavailable.
The start boundary is `rendererNavigation` (the renderer's navigation timing
origin). These values do not measure native process start, actual first pixels,
or response to user input. The summary accepts only the versioned
`performance.rendererLaunch` payload with that boundary and carries numeric
durations only.

The thread-open summary groups samples by provider and warm/cold state and
reports sample count, outcomes, and nearest-rank p50/p95/maximum values for
completed opens.
Incomplete opens remain visible in the outcome counts but cannot make latency
look artificially faster. It includes client
paint and hydration stages separately from the remaining runtime-preparation
time. It never carries thread ids, prompts, paths, model names, or free-form
error text into the scorecard.

For thread opens, `timelinePaintOpportunityMs` marks the second animation frame
before diagnostic DOM counting, and `runtimeAfterPaintOpportunityMs` is the
remaining runtime delay. The older `runtimeAfterVisibleMs` field is retained
for readers of earlier reports, but its start is the timeline commit, not a
verified visible pixel.

Do not compare pooled percentiles from unlike device or provider mixes. Keep
platform and architecture fixed, report the sample count for every group, and
define “warm” consistently when comparing runs.

The same export also contains aggregate runtime-turn and composer samples:

- streaming delta volume, animation-frame queue delay, and synchronous flush
  work, emitted once after a turn and its debounced persistence have settled;
- local Claude/Cursor transcript write count, failures, estimated retained-data
  bytes, duration, and write strategy (`snapshot`, `tail`, or `metadata`);
- one composer input-to-frame sample per 16 changes, flushed only in batches of
  32 so diagnostics never writes on every keystroke;
- first/last/delta/per-sample memory growth across completed thread-open
  samples, reusing existing heap/cache/process snapshots without another
  runtime memory call.

These records contain provider and numeric aggregates only. Thread ids remain
in renderer memory solely to join lifecycle events and are never passed to the
audit log; prompts, response text, paths, model names, and free-form errors are
not recorded. Input-to-frame is a rendering-opportunity proxy, not a literal
pixel-presentation timestamp.

## Current scope and next measurements

These measurements remain report-only until their variance is understood:

- cold process start → window → first paint → interactive;
- large-transcript rehydration on native macOS and Windows.

Mounted-row counts and payload bytes are implementation signals, not user
outcomes. They must stay paired with content-visible and interaction tests so a
budget can never pass by rendering less information or removing a feature.
The static startup closure intentionally excludes dynamic imports. Renderer
startup timing can expose a moved module if it delays shell commit or the
first paint opportunity; modules loaded just afterward need separate first-use
and idle measurements.

# Mythra Code performance scorecard

Mythra Code treats performance as a compatibility boundary: an optimization is
not complete if it makes an existing feature unreliable, hides content, or
makes another supported platform materially worse.

## Deterministic regression gates

`npm run verify` builds the production renderer and then checks the raw byte
size of the critical `App` entry, its complete synchronous startup closure,
the startup stylesheets, and the complete JavaScript bundle against
[`scripts/performance-budgets.json`](../scripts/performance-budgets.json).
Raw bytes are the primary local-app budget because parse, compile, and evaluate
work matters more than transfer compression. Gzip size remains in the report.

The checked-in limits are target-specific ratchets for minified Safari 13 and
Chrome 105 renderer builds. They may remain fixed or decrease. Raising
one requires an explicit performance-regression explanation in the pull
request; changing a fixture or toolchain must not silently redefine success.

The scorecard also reports, but does not yet hard-gate, metrics whose wall-clock
variance is too high for shared CI. A metric should become a gate only after
repeated measurements show that normal variance is less than half the smallest
regression the project would act on.

## Real-world diagnostics

Settings → General → Diagnostics exports privacy-safe local thread-opening
samples. Summarize an export with:

```sh
npm run build
npm run performance:scorecard -- --diagnostics /absolute/path/to/mythra-code-diagnostics.json
```

The summary groups samples by provider and warm/cold state and reports sample
count, outcomes, and nearest-rank p50/p95/maximum values for completed opens.
Incomplete opens remain visible in the outcome counts but cannot make latency
look artificially faster. It includes client
paint and hydration stages separately from the remaining runtime-preparation
time. It never carries thread ids, prompts, paths, model names, or free-form
error text into the scorecard.

Do not compare pooled percentiles from unlike device or provider mixes. Keep
platform and architecture fixed, report the sample count for every group, and
define “warm” consistently when comparing runs.

## Current scope and next measurements

The first scorecard covers bundle size and existing privacy-safe thread-open
samples. Planned additions are report-only until their variance is understood:

- cold process start → window → first paint → interactive;
- composer input-to-paint and timeline frame pacing during streaming;
- active-turn persistence duration and writes per turn;
- memory-growth slope through a repeated open/stream/evict soak;
- large-transcript rehydration on native macOS and Windows.

Mounted-row counts and payload bytes are implementation signals, not user
outcomes. They must stay paired with content-visible and interaction tests so a
budget can never pass by rendering less information or removing a feature.
The static startup closure intentionally excludes dynamic imports. Runtime
startup timing will catch modules that are moved behind `import()` but still
loaded unconditionally during boot.

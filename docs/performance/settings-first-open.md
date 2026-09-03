# First-open Settings latency

Measured 2026-09-02 on the development Mac (arm64, Node 26), using the minified
Safari-target web build, served locally, with five fresh browser contexts per
engine at 1400×900. No native IPC, provider accounts, or external network.
These are browser-fixture results, not native Windows timings or a guarantee
for every device. The metric is click to the first sampled animation frame
with nonzero backdrop opacity, not completion of the entrance animation.

| Change | Chromium median | WebKit median |
| --- | ---: | ---: |
| Before (`ade2d14`), first open | 343 ms | 367 ms |
| Module prewarm alone, first open | 345 ms | 369 ms |
| Prewarm + stable resolved-component host, first open | 29 ms | 47 ms |
| Stable resolved-component cold path, opened immediately | 32 ms | 52 ms |

Each of the first three cases waited three seconds after the sidebar appeared
before clicking without hover/focus. The last case waited zero milliseconds
and verified the Settings chunk had not been requested before the click.
Separate runs and frame cadence introduce variance; do not interpret the last
row as evidence that cold loading is faster than prewarming.

## Cause and fix

Even a fulfilled module promise suspends an uninitialized `React.lazy` on its
first read. Here the resulting fallback retry added roughly 300 ms. Warming
the files alone did not fix that: the intermediate experiment is retained
above to distinguish the real improvement from an assumed one.

The app now uses a stable loader host that renders the resolved component
directly when available. A cold open sets the component as soon as import
resolves, avoiding the same fallback delay without swapping mounted component
types. Import failures are thrown to the existing error boundary and retry
clears the failed load. The module stays outside the startup dependency closure.

A one-shot preload waits two seconds, then idle time, without a forced idle
deadline. Older WebKit uses an additional 300 ms deferred task. Visibility is
checked again at execution; opening Settings or unmounting cancels pending
work. This loads the Settings JS/CSS even for users who never open Settings,
but never creates its DOM, runs its component effects, or starts provider
checks. Hover/focus/pointer-down retain intent-based loading.

## Reproduce

Run `npm run build`, then `npm run preview -- --host 127.0.0.1 --port 1421`.
In another terminal run `node scripts/benchmark-settings-first-open.mjs` for
settled launch, or append `0` for immediate cold opening. Install Playwright
Chromium and WebKit first if needed. Each run prints all ten paired first/second
open samples; profiles are disposable and requests outside the local preview
are blocked. Run before and after builds under comparable idle conditions.

Regression coverage includes synchronous first opening after a fulfilled
preload (without hidden mounting), cold loading, cancellation and visibility
races, and the existing Settings animation, focus, draft-preservation and
provider/update tests.

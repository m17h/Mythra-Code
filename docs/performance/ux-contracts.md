# Performance UX contracts

The performance scorecard in [`docs/PERFORMANCE.md`](../PERFORMANCE.md) measures bundle cost and diagnostic samples. A faster or smaller implementation still has to preserve the content and controls people use. Do not claim a performance improvement from fewer mounted rows, fewer bytes, or faster tests alone.

The focused real-browser contract in `src/components/PerformanceUxContracts.browser.test.tsx` checks two representative paths:

- A loaded 83-message transcript initially mounts only the latest bounded window. A keyboard user can reveal every older message without losing the current reading position, copy the oldest one, return to the latest message, and find that oldest message through search. The DOM bound therefore cannot pass by silently dropping loaded history or making it impractical to read.
- A completed turn still exposes its progress update and command result through keyboard-operated disclosures. The disclosure chevron retains its normal transition, drops that transition under reduced motion, and keeps the final answer visible in both modes.

The file is included automatically by `npm run test:browser`; no extra default CI job or fixture download is needed. To run only this contract, use `npm run test:browser -- src/components/PerformanceUxContracts.browser.test.tsx`. Set `MYTHRA_BROWSER_TEST_ENGINE=webkit` for the WebKit pass.

Existing browser tests cover finer streaming cadence, modal animation, compaction, question drafts, layout, and keyboard interactions. These two contracts are a small anti-gaming sample, not an app-wide proof of performance or feature parity. Native macOS and Windows interaction, long-running memory use, and subjective motion quality still require direct observation on those platforms.

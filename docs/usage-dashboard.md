# Local usage dashboard

Settings → Usage now compares locally recorded tokens and estimated API-equivalent value by provider. Bars show provider share; the composition chart separates uncached input, cache reads, cache writes and output. Cache counts are subsets of input and reasoning is a subset of output. Total-only counters remain visible without inventing a breakdown.

## Accounting boundaries

- Subscription estimates are not subscription bills. Unknown prices are excluded, not treated as free. Regional, long-context, tool and other pricing adjustments are outside the estimate.
- Each usage increment retains its cost and provider attribution. Catalog refreshes affect future increments only, including background threads. An explicit Claude version is never silently priced as an older version.
- Single-provider threads reuse their existing counters; separate provider subtotals are materialized only for mixed-provider threads and archives. This avoids duplicating every ordinary thread's token and cost data.
- Existing providerless archives appear as earlier/unattributed usage. Retention preserves new provider subtotals, cumulative resume baselines and unique thread counts. Malformed optional subtotals fall back to unattributed authoritative totals.
- Schema 21 adds optional fields; there is no eager transcript migration or destructive rewrite. The original thread token totals remain the source of truth.

## OpenRouter receipts

The compatibility proxy passively observes `usage.cost` in streamed Responses terminal events (also accepting Chat Completions and non-streaming JSON). It forwards the original bytes and status/headers. It does not change prompts, models, generation parameters or token counters, and makes no additional generation-lookup calls.

Receipts are separate from runtime token accounting and API estimates. They are not associated with whichever thread happens to be active. One durable aggregate retains the amount and request count, with at most 1,000 recent receipt ids for duplicate protection. A genuine zero-dollar receipt counts as a captured request; a missing, negative, non-numeric or non-finite cost does not.

This is best-effort captured spend, not an invoice or complete account history. Activity outside Mythra, historical requests, unreported costs, malformed/oversized receipts and events lost during a process shutdown cannot be reconstructed. The observer caps each candidate at 256 KiB and ignores oversized candidates. OpenRouter's Activity page remains authoritative. BYOK upstream charges are not substituted for `usage.cost`.

Source: [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). A live free-model Responses request on 2026-09-03 returned `response.completed` with numeric `usage.cost: 0` and token counts. Paid receipts and fragmented/error/oversized responses are covered by synthetic native tests; no paid model was used for the live probe.

## Freshness and performance

The existing once-per-launch, non-blocking refresh checks Mythra's validated pricing catalog and OpenRouter's model catalog. Settings exposes the catalog publication date, check status, offline failure and manual refresh. A successful check does not imply every model has a newly published price; unavailable rates stay unpriced. The last valid catalog remains available offline. OpenRouter's current catalog supplies prompt, completion and optional cache rates; existing thread rates are retained when unavailable.

The dashboard is in the deferred Settings chunk, is unmounted while Settings is closed, does not open transcripts and subscribes to batched ledger writes rather than streaming text. No chart package or new polling is introduced. Explicit raw bundle review against `82db8e0`:

| Profile | App entry | Startup JS | Startup CSS | All JS |
| --- | ---: | ---: | ---: | ---: |
| Safari | −342 B | +3,991 B | −1,105 B | +9,426 B |
| Chrome | −188 B | +3,853 B | −1,105 B | +9,275 B |

The +2.7–2.9 KB combined startup change is accepted feature overhead, not a runtime speed claim. Exact measured budgets carry no extra allowance. `futures-util` becomes a direct Rust dependency but was already resolved transitively.

## Verification

Run `npm run verify`. Real-browser dashboard tests cover dark/light themes and 900/540/320-pixel panels in Chromium and WebKit. Ledger tests cover mixed providers, retention, resumes, late hydration, pricing changes, missing rates, bounded/free/duplicate receipts, total-only usage and damaged optional breakdowns. Native tests cover byte fragmentation, terminal-only receipt selection, upstream-cost distinction, zero/invalid costs and bounded oversized data.

Opus 5 was requested at high effort for a focused review, but returned HTTP 529 (overloaded). The user confirmed Claude Code was experiencing issues. No successful Opus review is claimed for this change.

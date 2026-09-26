# Local usage dashboard

Settings → Usage shows locally recorded tokens and their estimated API-equivalent cost. While this section is open the Settings sheet widens to `min(1200px, 100%)` (about 928 CSS px of dashboard in a 1380×901 window, versus about 648 px at the standard 920 px width). The dashboard itself is laid out with container queries, so it also works in the standard sheet and down to 320 px.

- **Header**: one line of scope ("recorded on this device … not a subscription bill") and a pricing-freshness summary: "Rates verified today 10:04", "Some rates couldn't be verified" (whenever any source failed) or "Using bundled rates". **Refresh pricing** sits beside it. The summary is a disclosure that opens each source's own result, links to the pricing pages and the "What estimates include" caveats. Each caveat appears once, here.
- **Date range**: Today, 7 days, **30 days (default)**, All time or Custom (inclusive local days, bounded by the 400-day retention). Before any dated detail exists the page opens on All time, the only range with anything in it. It is a keyboard radiogroup (arrows/Home/End).
- **Views** (a keyboard tablist: arrows/Home/End):
  - **Overview**: four headline figures (estimated cost with the share of tokens priced; tokens with input · output; per prompt, with how many prompts the cost average covers; cache reads as a share of input). Below them sit a **daily or weekly trend** of cost or tokens, and **By provider** shares with aligned bars, cost and tokens. The trend has a hover readout, and a "Show as table" disclosure gives the same numbers as a date table. Weekly grouping starts on Monday and flags partial weeks. It defaults to weeks for ranges over 45 days. Periods with usage but no rate are striped, never drawn as $0.
  - **Models**: **By token type · all models** gives uncached input, cache read, cache write and output. Each shows its tokens, its estimated cost, its per-prompt average for both, and **Priced**: the share of that type's tokens its cost covers. In All time, **Earlier usage** adds its known token split to each type, and its cost appears only as a total row. Below that, a **Models** table (cost, tokens, cache-read share, per prompt) where each row expands in place. The expansion shows the model's own token-type table with per-prompt averages, its current rate (including Claude's 1-hour cache-write rate) and a **by day / by week** table of the four types.
  - **Compare**: any two models with usage in the retained history, or with a published rate. Choose a token type (or all), cost or tokens, and day or week. You get a two-series column chart with a legend and a "Show as table" date table. For example, pick Cache read · Tokens · Week to compare Opus and Sol cache reads week by week. Below that is the observed total for each billable part, with its tokens per prompt, then totals, average per prompt, prompts using the model and cache-read share. Selections persist across range and view changes; a model with nothing in the range says so. **Hypothetical: re-price at current standard rates** is collapsed and separately labelled. It never changes recorded estimates.
- **OpenRouter reported charges**: one line of all-time captured receipts, kept separate and never added to estimates.

Charts use no chart package. The two series colors are fixed (blue/orange, validated for color-vision deficiency and 3:1 contrast on the dark and light panels), because theme accents are too close to each other in some themes. Charts are `aria-hidden`; their tables are the accessible equivalent.

Provider quota display settings remain a separate section below the dashboard.

## Dated detail (`kiwi.usageHistory`)

The ledger (`kiwi.usageLedger`) keeps one aggregate per thread and stays the source of truth for all-time totals. It has no dates, per-model splits or turn counts, and those can't be reconstructed for usage recorded before this change. So dated detail is recorded **going forward only**, from the first usage after upgrade:

- Every delta the ledger accepts is recorded once more into a bucket keyed by **local day × provider × resolved model**. `usageHistory.ts` is its own lazily loaded chunk, fetched on the first accepted delta (or with Settings). Deltas accepted before it attaches wait in a bounded in-memory queue, each with its own timestamp and frozen rate, and are drained in order. If the chunk never loads, or the app closes within that first moment, those deltas stay in the ledger and show as earlier, undated usage. `flushUsageLedger` writes the ledger first and detail second, and a sink that attaches while the ledger is unsaved defers its flush until the ledger's persist. An interrupted save can leave a missing detail remainder, but not detail beyond the ledger. Native writes are queued per key, so the order on disk isn't guaranteed. As a read-side guard, if all-time detail ever exceeds the ledger, the page's all-time totals use the ledger and a note explains why. So detail can never double-count what the ledger deduplicated (Claude assistant/result events, Cursor `usage_update` snapshots versus `result`, duplicate event ids, reloads). A resumed Codex runtime whose cumulative counter drops rebaselines to a zero delta in both places.
- The model is the thread's model at the time of the delta. Claude uses the `model` on each assistant message, reduced to its pricing id (`claude-opus-5-5`). A model switch mid-thread splits usage across buckets from that point. Child/sub-agent threads are recorded under their own thread ids. Claude's assistant events carry each message's usage, but only a partial output count. The turn's `result.usage` completes it. The result's `modelUsage` can be a cumulative session snapshot, so its per-model values are used only when every token component exactly reconciles with this turn's result. Already recorded assistant usage is subtracted per model. If the snapshot cannot be reconciled, the result remainder stays unpriced under `unattributed` instead of being charged to the last assistant model. `modelUsage` does not split cache writes by duration; an unobserved 1-hour write is assigned only when one model could own it. Otherwise the remainder is unattributed. This conservative path still keeps the full token count.
- Each bucket stores tokens and the **cost of each component**, priced at the rate in effect when the delta was recorded. That is the same rate the ledger used. A pricing refresh never reprices saved detail by itself; only the evidence-backed correction under [Repricing past usage](#repricing-past-usage) can, and it changes the ledger by the same amount.
- A **turn** (a prompt) is counted once per (thread, provider turn id), in the bucket where that turn's first usage lands (`turns`), so turns sum to the number of prompts. Each bucket also counts `modelTurns`: turns that used its model, once per (thread, turn, provider, model). A turn that switched models therefore adds one prompt overall and one turn to each model it used, and a model's average has a real denominator. Up to 1,000 recent turn and turn-model identities persist, so usage that continues after a reload isn't counted again. Buckets stored before `modelTurns` existed read it as their `turns`. **All of a turn's usage lands on the local day its first usage did** (`turnDays`, persisted for the same 1,000 recent turns). A prompt sent at 23:59 therefore doesn't leave its tokens on the next day without its prompt count. Turns already in flight when this was introduced use each delta's own day. Turn ids come from Codex `thread/tokenUsage/updated.turnId`, the Claude and Cursor run turn ids, or else the thread's active turn. Usage with no turn identity is kept as `unturnedTokens` and excluded from averages rather than given an invented denominator.
- Each bucket also stores `cacheWrite1hTokens`, the part of its cache writes that used Claude's 1-hour cache, so a hypothetical re-price uses the right rate. Buckets stored before it existed read 0; their frozen costs used the 5-minute rate.
- Storage is compact: one array per bucket plus the recent turn ids. Daily detail is kept for 400 days, with a hard cap of 4,000 buckets. Whole oldest days are dropped first, and the earliest retained day is shown. A malformed bucket is dropped on its own and never affects ledger totals.

**All time** anchors totals to the ledger. Whatever the ledger holds beyond dated detail (usage from before tracking began, or detail past retention) is **earlier usage**. It is split per provider using the ledger's own frozen attribution (`providerUsageTotals()`): each provider's remainder is its ledger total minus its dated detail. Its token split is known but its cost only as a total, and it's never attributed to a model, date or turn. Records that never had a provider label stay **Unattributed** and are never assigned a guessed provider. A date range contains dated detail only; if it starts before tracking began, a note says so.

### Per-prompt averages

"Per prompt" divides by distinct provider turns (`turns`), not only by user-typed prompts. A turn is any prompt sent to a model: yours, a queued prompt, a workflow step or a sub-agent's. Per-model averages (model detail and Compare) divide by `modelTurns`, the turns that used that model.

Averages are computed per bucket (one day × provider × model) by `promptAverages`, and a bucket is averaged whole or not at all. Where a turn switched models and its cost cannot be matched to an unambiguous prompt denominator, the cost average is withheld:

- **Token averages** (each of the four types and the total) skip buckets that include usage without a prompt id. The page says how many tokens that leaves out.
- **Cost averages** also skip buckets with any unpriced usage or ambiguous switched-model turn attribution. They are never treated as free, and the page explains the excluded prompts.

**Priced** coverage (`componentBreakdown`) never apportions. A fully priced bucket's tokens are covered; an unpriced bucket's aren't. A bucket priced for only part of its day (the day a new model's rate arrived) makes the share a lower bound ("≥ 80%", or "Partly"). Earlier usage adds tokens to each type, but its cost only to the total.

## Accounting boundaries

- Subscription estimates are not subscription bills. Unknown prices are excluded, not treated as free.
- Estimates use **standard** API rates. Batch/Flex discounts, priority or fast modes, data-residency and regional multipliers (for example Claude's 1.1× US-only inference), and long-context adjustments aren't visible in reported usage, so they aren't applied.
- Claude cache writes are priced by duration. Claude Code reports `usage.cache_creation.ephemeral_1h_input_tokens` on both assistant and result events (checked 2026-09-25 against local transcripts and a live `claude -p` stream-json call). That call's `modelUsage.costUSD` matched 1-hour writes at 2× input. Those tokens use the 1-hour rate: the pricing page's own column when it has been read, otherwise the page's documented 2× base-input rule. The rest use the 5-minute rate. Usage recorded before this keeps its frozen 5-minute estimate.
- Cursor publishes per-model rates on its models-and-pricing page. A Cursor model is priced only when its live catalog name (`cursor_models`) matches a row on that page exactly, ignoring case, spacing and parentheses. Rates are never borrowed from the underlying vendor's own page. Auto is never priced: it bills at whichever model it routed to, and Cursor doesn't report which. Cursor's ACP usage never reports cache writes (`cursorEvents.usageView` sets them to 0), so the page shows Cursor cache writes as **Not reported** rather than zero, and says Cursor estimates may be low. The Teams/Enterprise Cursor Token Rate ($0.25/MTok on third-party models) and the 10% data-residency uplift aren't applied.
- Where a provider publishes no separate cache-read or cache-write rate ("-" on the page), those tokens are priced at the input rate, as they always have been. The stored rate stays absent, and the page says "at the input rate" instead of printing a number the provider never listed.
- Each usage increment retains its cost and provider attribution. Catalog refreshes affect future increments only, including background threads. An explicit Claude version is never silently priced as an older version.
- Single-provider threads reuse their existing counters; separate provider subtotals are materialized only for mixed-provider threads and archives. This avoids duplicating every ordinary thread's token and cost data.
- Existing providerless archives appear as earlier/unattributed usage. Retention preserves new provider subtotals, cumulative resume baselines and unique thread counts. Malformed optional subtotals fall back to unattributed authoritative totals.
- The storage migration adds optional ledger fields; there is no eager transcript migration or destructive rewrite. `kiwi.usageHistory` is a durable key that starts empty on older installs.

## Rates

Bundled fallback rates (per 1M tokens: input / cache read / cache write / output) were last checked on 2026-09-25 (`BUNDLED_PRICING_AS_OF`):

| Model | Input | Cache read | Cache write | Output | Source |
| --- | ---: | ---: | ---: | ---: | --- |
| `gpt-6-astra` | $10 | $1 | $12.50 | $50 | OpenAI model page (standard tier) |
| `gpt-6-sol` | $2 | $0.20 | $2.50 | $10 | OpenAI model page (standard tier) |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 | OpenAI model page (standard tier) |
| `gpt-5.6-sol`, `gpt-5.6` | $4 | $0.40 | $5 | $20 | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) (standard tier; `gpt-5.6` redirects to Sol) |
| `gpt-5.6-terra` | $2 | $0.20 | $2.50 | $12 | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra) (standard tier) |
| `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | $1.20 | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) (standard tier) |
| `claude-opus-5-5` | $4 | $0.20 | $5 | $20 | platform.claude.com pricing |
| `claude-fable-5-1` | $10 | $0.25 | $12.50 | $50 | platform.claude.com pricing |
| `claude-sonnet-5` | $2 | $0.20 | $2.50 | $10 | platform.claude.com pricing (launch price made standard; the planned $3/$15 increase was cancelled) |
| `claude-opus-5`, `claude-opus-4-8` | $5 | $0.50 | $6.25 | $25 | platform.claude.com pricing |
| `claude-fable-5` | $10 | $1 | $12.50 | $50 | platform.claude.com pricing |
| `claude-haiku-4-5` | $1 | $0.10 | $1.25 | $5 | platform.claude.com pricing |

On 2026-09-25 every bundled rate was checked against the live OpenAI (Standard, short-context) and Claude pricing pages. The pages were fetched through the native command below and parsed by `officialPricing.captured.test.ts`, and every rate matched, including GPT-6. The GPT-5.6 rates replace the $5/$30-era rates bundled on 2026-07-28. OpenAI's page notes that GPT-5.6 Sol's price is promotional "at least through November 21, 2026". The official refresh will pick up the change when it happens. Recorded usage normally keeps its frozen estimate; only the narrowly evidenced historical correction described below can change it. `model-pricing.json` carries the same rates, and a test keeps it in step with the bundled table.

## Repricing past usage

When a rate source updates, earlier usage is repriced **only if evidence shows which rate applied at the time the usage happened**. The rate seen today is never applied to a past date.

**What counts as evidence** (`pricingEvidence.ts`, a lazy chunk):

- **Observation epochs.** Each successful official page read extends a model's latest epoch `[firstSeenAt, lastSeenAt, rates…]` if the page shows the same rate again within 48 hours (`OBSERVATION_GAP_MS`). Otherwise it starts a new epoch. A successful read that no longer lists the model closes its epoch. Usage is covered only if its whole span lies inside one epoch, meaning the page showed that rate both before and after it. The assumption made is that a rate didn't change and change back between two identical reads at most 48 hours apart. Epochs are stored in `kiwi.officialModelPricing.epochs`, up to 32 per model, and are dropped along with their model.
- **Catalog periods.** A `model-pricing.json` entry may carry `effectiveFrom` as a UTC day (`YYYY-MM-DD`, meaning midnight UTC) or an exact UTC timestamp (`YYYY-MM-DDTHH:mm:ssZ`, optionally with three fractional digits). Use a timestamp for an intraday price change; a day-only value must not be used when the change began later that day. The entry attests its rate from that instant through the end of its `asOf` day, or until `effectiveUntil` (the same date-or-timestamp format). The attestation never reaches past `asOf`, because the maintainer verified nothing later. Pages read by the app can't set `effectiveFrom`. A future `effectiveFrom` also keeps a catalog rate from applying to live usage early.
- If the sources disagree about a span, nothing changes. OpenRouter, LM Studio and unattributed usage have no evidence source.

**Provenance** (`kiwi.usageHistory`):

- Each bucket keeps up to 4 **contiguous rate cohorts**. A cohort is `[id, rate index or -1 for unpriced, first minute, last minute, uncached, cache read, cache write, 1-hour write, output]`. A→B→A within one day produces three cohorts rather than an A span that misleadingly crosses B. Once repriced, a cohort also carries the rate it was recorded at, the evidence basis, and a correction revision. Rates sit in one deduplicated table, and only referenced rates are written. A bucket with no cohorts is written in the original 19-field shape.
- A cohort's time span is the real time of use, widened to whole minutes, even when a turn that crossed midnight is filed under its first day.
- Detail recorded before cohorts existed has no rate or time. The one exception is a legacy bucket that was **wholly unpriced**. It becomes a cohort spanning its day and the next, which also covers turns that ran past midnight. Claude buckets with cache writes are excluded, because their 1-hour split may not have been recorded.
- Mixed priced/unpriced legacy days, usage past the cohort cap, undated earlier usage and the ledger's 90-day archive are never repriced.

**Keeping ledger and detail in step:**

- `repriceUsageHistory()` runs after an official read succeeds, after the catalog refreshes, after Cursor's model names change, and when dated detail loads. It collects every cohort whose evidence-backed rate would change its cost.
- `commitPricingCorrections` then records each correction in the ledger's synthetic `openkiwi:pricing-corrections` record. That record holds the net cost change and the tokens moved from unpriced to priced, per provider, plus the last 500 applied ids (always every id from the latest pass). An id includes the cohort id, its next correction revision, and a hash of the new rate; revisiting a rate cannot reuse an earlier id.
- Only after that are the buckets updated. The ledger is written first and the detail second.
- A repeated refresh or a restart finds nothing left to change. If the app stops after the ledger save, the next pass sees those ids are already applied and updates only the detail. This ordering is enforced for the webview's local records; native-state persistence is asynchronous and is recovered through its pending-write markers.
- Per-thread records keep their original estimate, because a thread's usage can't be mapped to a day. The all-time and per-provider totals include the corrections.

The Overview and a model's detail report what was repriced, and how many tokens remain unpriced.

## Official rate refresh

**Refresh pricing** (and a deferred launch check) reads three official Markdown pages:

| Source | Page | What is read |
| --- | --- | --- |
| OpenAI | `developers.openai.com/api/docs/pricing.md` | Only the table under `### Standard pricing data`, and only its four short-context columns. Batch, Flex, Fast, long-context and the Specialized (`gpt-5.3-codex`) tables are never read. `gpt-5.5 (<272K context length)` is read as `gpt-5.5`. |
| Anthropic | `platform.claude.com/docs/en/about-claude/pricing.md` | The table after "The following table shows pricing for all Claude models:". Base input, **5m** and **1h** cache writes, cache hits, output (a 1-hour rate below the 5-minute rate fails the source). `Claude Opus 5.5` → `claude-opus-5-5`. Claude 4+ only (3.x used a different id order). Rows annotated "retired"/"limited availability" are kept with a status so usage is still priced, but they aren't offered in Compare. Any other annotation skips the row. |
| Cursor | `cursor.com/docs/models-and-pricing.md` | The `### Model pricing` table, plus the `## Cursor Models` table when present. Both have the same seven columns. Keyed by normalized display name; `Auto` is skipped. |

**Fetching.** `pricing_sources::fetch_pricing_document` (Rust, reqwest) takes only a source name and maps it to one of three fixed HTTPS URLs; no URL is ever accepted from the renderer. It is HTTPS-only with no cookies or credentials. Redirects must stay on the same host and port 443, three at most. It has an 8 s connect and 15 s total timeout and a 2 MiB streamed size cap. It requires a `text/*` content type other than `text/html`, and strict UTF-8. The renderer can't fetch these pages itself: the Claude and Cursor pages send no CORS headers. No `Accept` header is sent: cursor.com answers `Accept: text/markdown` with 404.

**Parsing fails closed.** Parsers live in `src/lib/officialPricing.ts`, a chunk loaded only by the launch check and the refresh button. Each needs its exact anchor (present exactly once) and exact column names. Every row must have the header's cell count. Every rate must be `$N` or `$N / MTok`, positive and at most 10,000; "-" means unpublished. Cache reads must not exceed input and cache writes must not be below it; a violation means columns moved. Any of these fails the **whole source**: its previous rates stay and the failure is shown. So do conflicting duplicate rows (identical repeats are fine), or a page listing fewer than half the models of the last successful check (when that check had at least six). A row whose name can't be mapped to an id with certainty is skipped, not guessed. A row without both input and output rates is skipped.

**Storage and precedence.** Results persist in `kiwi.officialModelPricing`, in the published catalog's shape. Rates are keyed `openai:`, `claude:` or `cursor:<normalized name>`, each with its own `asOf` day and an optional retired/limited `status`. Beside them sit per-source `checkedAt` (last attempt), `verifiedAt` (last success) and `error` (last failure). The ledger reads the rates through the same validator as the catalog (`parseModelPricingCatalog(value, true)`), which additionally requires positive rates and is the only path that accepts `cursor:` keys. The downloaded catalog can never supply Cursor rates. Writing, merging and status live in the lazy module, so startup carries only the lookup. A success merges over the previous snapshot, so a model that disappears from a page keeps its last verified rate at its older date. `pricingForModel` chooses **per model** the candidate with the latest `asOf`: official, catalog (`model-pricing.json`) or bundled. On the same day, official beats the catalog, which beats bundled. A catalog's `updatedAt` never matters, so an old entry in a fresh download can't override a newer bundled or official rate. Catalog maintainers must bump an entry's `asOf` when they change it. `gpt-5.6` resolves to `gpt-5.6-sol`'s official rate. New rates apply to the next usage delta; recorded estimates are frozen.

**When it runs.** On a manual refresh, all three pages are checked alongside the catalog and OpenRouter, each reporting its own result. Otherwise the app checks 6 s after startup and every 6 h while it remains open (Tauri only). Each source is actually fetched only if its last check was more than 24 h ago, or more than 1 h ago after a failure. This keeps long-running apps collecting the observations needed for historical correction without hourly network requests. Settings > Usage lists each source with its state. **OpenAI/Claude/Cursor**: verified (model count and time), not checked yet, or "Couldn't verify … · using rates verified …" with the failure reason. **Mythra catalog**: publication date, as a fallback. **OpenRouter**: live, or couldn't refresh. A failed page is never shown as verified.

**Live verification.** `npm run test:rust -- capture_pricing_pages -- --ignored` fetches all three pages through the real command and saves them under `node_modules/.cache/pricing/`. `npx vitest run src/lib/officialPricing.captured.test.ts` then parses those captures and checks every bundled rate against them; it is skipped when no capture exists. As captured on 2026-09-25, the pages parsed to 39 OpenAI models, 17 Claude models (Haiku 3.5 skipped) and 55 Cursor models.

## Development preview

In a development build, `VITE_PREVIEW_USAGE_DASHBOARD=1 npm run desktop` (or `window.__mythraPreviewUsageDashboard(true)` in the dev console) swaps in synthetic, in-memory usage labelled "Development preview". It never reads or writes the ledger or history. In production the hook is the constant `() => null` and the fixture is tree-shaken.

## OpenRouter receipts

The compatibility proxy passively observes `usage.cost` in streamed Responses terminal events (also accepting Chat Completions and non-streaming JSON). It forwards the original bytes and status/headers. It does not change prompts, models, generation parameters or token counters, and makes no additional generation-lookup calls.

Receipts are separate from runtime token accounting and API estimates. They are not associated with whichever thread happens to be active. One durable aggregate retains the amount and request count, with at most 1,000 recent receipt ids for duplicate protection. A genuine zero-dollar receipt counts as a captured request; a missing, negative, non-numeric or non-finite cost does not.

This is best-effort captured spend, not an invoice or complete account history. Activity outside Mythra, historical requests, unreported costs, malformed/oversized receipts and events lost during a process shutdown cannot be reconstructed. The observer caps each candidate at 256 KiB and ignores oversized candidates. OpenRouter's Activity page remains authoritative. BYOK upstream charges are not substituted for `usage.cost`.

Source: [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). A live free-model Responses request on 2026-09-03 returned `response.completed` with numeric `usage.cost: 0` and token counts. Paid receipts and fragmented/error/oversized responses are covered by synthetic native tests; no paid model was used for the live probe.

## Freshness and performance

Provider quota cards are account-scoped. A successful reading carries the
current account identity and capture time; an account change clears it before
the replacement read starts. A transient provider failure may retain the last
reading only for that same account, and the card shows its age. After one hour
the numbers are hidden as expired rather than presented as current.

Codex quota reads use the documented app-server rate-limit surface, preferring
`rateLimitsByLimitId` and falling back to the legacy `rateLimits` bucket.
Claude consumes structured `rate_limit_event` utilization from ordinary turns
when it is present. Because normal allowed events may omit utilization, the CLI
`/usage` result remains the initial and idle fallback. An event updates only the
window it names, so a card that still carries an untouched window keeps the age
of that older reading: a stream of events cannot present a stale window as
freshly confirmed, nor postpone its one-hour expiry.

Visible Claude polling runs every three minutes, is coalesced across triggers,
and exponentially backs off after repeated failures to a maximum fifteen-minute
delay. A finished turn, a known reset time and an account change force a read
past both the burst floor and the backoff. Focus, returning visibility and
opening the usage card ask for a read but still respect them, so alt-tabbing
cannot re-poll a provider that is already failing.

Usage failures are reduced to timeout, authentication, unsupported-response,
or unavailable categories. Diagnostics may include a semantic provider version
but never provider stderr, credentials, paths, account identifiers, or other
free-form failure text.

The once-per-launch, non-blocking refresh checks Mythra's validated pricing catalog and OpenRouter's model catalog. Deferred checks of the official pricing pages run at most once a day per source and continue in long-running apps (see [Official rate refresh](#official-rate-refresh)). Settings shows each source's status, offline failure and a manual refresh. A successful check does not imply every model has a newly published price; unavailable rates stay unpriced. The last valid catalog remains available offline. OpenRouter's current catalog supplies prompt, completion and optional cache rates; existing thread rates are retained when unavailable.

The dashboard is in the deferred Settings chunk, is unmounted while Settings is closed, does not open transcripts and subscribes to batched ledger writes rather than streaming text. No chart package or new polling is introduced. Explicit raw bundle review against `82db8e0`:

| Profile | App entry | Startup JS | Startup CSS | All JS |
| --- | ---: | ---: | ---: | ---: |
| Safari | −342 B | +3,991 B | −1,105 B | +9,426 B |
| Chrome | −188 B | +3,853 B | −1,105 B | +9,275 B |

The +2.7–2.9 KB combined startup change is accepted feature overhead, not a runtime speed claim. Exact measured budgets carry no extra allowance. `futures-util` becomes a direct Rust dependency but was already resolved transitively.

The dated-detail change keeps summaries, comparison and catalog listing in `usageSummary.ts`, which only the deferred Settings chunk imports. `usageHistory.ts` has its own chunk group in `vite.config.ts`. Without it, being shared between the ledger's dynamic import and Settings would pull it into the startup `shared` chunk. Startup carries only the ledger's bridge and queue, turn-id plumbing in the store and event routers, and the stale-catalog guard. The dashboard UI and CSS stay in the deferred Settings chunk.

Raw bytes on the Safari profile, measured on 2026-09-25 by building `HEAD` (`bc0d205`) with each change set's files swapped in or out. `HEAD` sits exactly at every budget, so any addition fails `verify:performance`; budgets were left unchanged.

| Build | App entry | Startup JS | Startup CSS | All JS |
| --- | ---: | ---: | ---: | ---: |
| `HEAD` (= budget) | 458,696 | 875,733 | 366,036 | 1,716,699 |
| Pre-existing UpdateNotice/approval work only | +2,779 | +2,911 | +3,510 | +2,911 |
| Dated usage detail only, first pass | +34 | +5,223 | 0 | +17,806 |
| Dated usage detail only, lazy history chunk | +119 | +853 | 0 | +23,754 |

About 17.3 KB of the dated-detail All JS growth is the deferred Settings dashboard, and 5.6 KB is the lazily loaded history chunk.

## Verification

Run `npm run verify`. Real-browser dashboard tests (Chromium and WebKit) cover:

- the widened Settings sheet at a 1380×901 window, where the four-up summary is measured;
- 928/640/320-pixel panels in every view, with a model row expanded, and the development preview's five weeks of synthetic Opus/Sol usage in dark and light;
- horizontal overflow, column width caps and control hit sizes;
- keyboard operation of the range radios, view tabs and model rows, and visible focus rings;
- pricing-source layout after a partly failed refresh.

`usageSummary.test.ts` covers per-prompt averages for all four types, with their priced and identified denominators, per-type priced coverage (including partly priced model-days and earlier usage), and day/week periods. `usageHistory.test.ts` adds turns that cross midnight and Claude 1-hour cache writes through the assistant/result event path, alongside its earlier coverage: model splits, ranges, frozen costs, turn counting, event attribution and retention. `officialPricing.test.ts` covers the 1-hour column and its pricing. `usageRepricing.test.ts` covers repricing in several cases. It prices unpriced usage from catalog periods, and Cursor usage from observation epochs, which a long gap breaks. It never uses a rate first seen after the usage or attested only up to an earlier day, and changes nothing when sources conflict. It corrects a wrong-rate cohort and reprices a wholly unpriced legacy day, but never a mixed day or the archive. It also checks that repeated refreshes and restarts change nothing twice, that an interrupted correction is finished on the detail side only, and that a page read reprices automatically. Ledger tests cover mixed providers, retention, resumes, late hydration, pricing changes, stale catalogs, missing rates, bounded/free/duplicate receipts, total-only usage and damaged optional breakdowns. Native tests cover byte fragmentation, terminal-only receipt selection, upstream-cost distinction, zero/invalid costs and bounded oversized data.

Opus 5 was requested at high effort for a focused review, but returned HTTP 529 (overloaded). The user confirmed Claude Code was experiencing issues. No successful Opus review is claimed for this change.

# General reliability and efficiency review — 2026-09-16

This review fixes reproduced failures and redundant work while preserving animation timing, streaming cadence, styling, and background agent recovery. Three Sol reviewers owned persistence, polling/lifecycle, and rendering/interaction; Fable 5.1 on High reviewed and fixed the terminal through a targeted Claude Code tmux session. The primary review covered integration, challenged the fixes, and extended persistence edge coverage before final validation.

## Reviewed and changed

| Area | Failure / unnecessary work | Change and regression evidence |
| --- | --- | --- |
| Paged local transcripts | A short turn that completed inside the 900 ms save debounce could be treated as metadata-only and omitted. Saving only the newest active turn could also skip an intervening completed turn. | Track the last durable turn; append intervening completed turns and the newest completed, active, or pending turn with consecutive generation checks. Remember each successful write so a later failure can retry safely. Tests cover Claude, Cursor session metadata, multiple turns, missing timeline order, generation conflicts, and preservation of full-history snapshot behavior. |
| Transcript processing | Selecting each newly completed turn by repeatedly filtering every entry would add avoidable work. | Group entries once and sort distinct turn groups: O(n + k log k) rather than repeated O(n × k) filtering. This catch-up path is restricted to bounded partial transcripts; ordinary active-tail writes retain their existing path. |
| Skills watcher | Each five-second tick could supersede a still-running scan/sync. Slow storage could trigger repeated work without ever publishing the library. | Skip watcher ticks while a refresh for that folder is in flight. Explicit edits/focus refreshes still supersede old work. The integration regression holds scan and sync promises across several ticks, verifies no extra reads, then verifies polling resumes after completion. |
| Usage refresh | A forced refresh requested during an existing poll was discarded. | Coalesce forced requests into one follow-up read per account identity. Tests cover in-flight requests, unmount, disable, and account changes. |
| Thread health | A slow provider probe could apply an old terminal result after the same turn had reported fresh progress. | Require the task's update timestamp as well as turn identity to still match before applying recovery. Regression confirms a delayed false-inactive result cannot close a progressing turn. |
| Select-menu layout | Captured scroll, resize, and observer notifications repeatedly measured and updated identical positions. | Preserve initial positioning; coalesce subsequent notifications into one animation-frame measurement, avoid unchanged state updates, and cancel pending frames on cleanup. Real-browser regression verifies three same-frame events produce one repositioning read. |
| Terminal routing | The oldest process route was evicted even when it belonged to a live server. Subsequent output could land in the selected project's terminal. | Retire completed routes first and preserve live routes. Regression keeps one server running while 40 later commands finish, then verifies its output reaches the original project. |
| Terminal scrollback | Creating enough other sessions could evict the idle terminal currently on screen. | Protect the displayed scope as well as running sessions. Regression appends output across eight other scopes and verifies the displayed buffer survives. |

## Reviewed without speculative changes

- Transcript debounce/retry scheduler, history normalization, save-hook lifecycle, close-flush behavior, and the native generation/tail-write contract.
- GitHub login polling, checkpoints, and scheduled-work overlap/cancellation guards.
- ChatTimeline layout and history transitions, streaming pacer and fades, disclosure/popover animations, pane and sidebar resizing, UsagePopover, and pointer cleanup.
- Terminal chunk trimming, bounded scrollback, late process output, run/stop/write/resize, and TerminalPanel/XtermPanel consumption.
- App Skills preparation ordering, startup refresh integration, and existing run-discovery worker ownership.

A proposed optimization that suspended health probes while hidden was rejected: recovering missed completion events is functional background work and can affect queued tasks. That behavior remains active. Potential terminal result/stream duplication depends on provider protocol guarantees and was not established as a defect; no speculative change was made. A possible TerminalPanel memoization opportunity was also left for measurement rather than adding unrelated caching.

This is a targeted general review, not an assertion that every application code path or provider account was exercised.

## Explicit performance-regression review

The additional correctness code exceeds the previous byte caps, which had only 103 Safari / 115 Chrome bytes of total-JavaScript headroom against the freshly rebuilt baseline. An independent Sol review found the small increase justified by the reproduced defects and no meaningful safe offset within scope. Removing guards, splitting failure-sensitive persistence into extra lazy chunks, or changing animation behavior would be inappropriate offsets.

Baseline: `f8a43b1`, rebuilt in an isolated directory with the same dependencies, compiler, and target settings. Both target frontend profiles were built on this Mac; the Chrome profile is not evidence of a native Windows application test.

| Metric | Safari baseline | Safari changed | Chrome baseline | Chrome changed |
| --- | ---: | ---: | ---: | ---: |
| App entry JS, raw bytes | 379,783 | 380,346 | 359,726 | 360,236 |
| Startup JS, raw bytes | 753,879 | 756,716 | 725,915 | 728,560 |
| Total JS, raw bytes | 1,525,963 | 1,528,800 | 1,487,000 | 1,489,645 |
| Startup CSS, raw bytes | 363,306 | 363,306 | 356,763 | 356,763 |
| Startup JS, gzip bytes | 229,829 | 230,535 | 221,098 | 221,810 |
| Total JS, gzip bytes | 437,641 | 438,331 | 425,452 | 426,170 |

The increase is 2,837 Safari / 2,645 Chrome raw JavaScript bytes, approximately 0.19% of total JS; gzip total increases by 690 / 718 bytes. No dependencies, CSS, animation timings, or streaming presentation rates changed. Limits are raised only to the measured results, with this exception recorded in `scripts/performance-budgets.json` and the accompanying PR. The existing checks remain enabled. These measurements establish bundle cost and the menu test establishes reduced layout reads; neither establishes an app-wide frame-time, CPU, battery, or memory improvement.

## Validation and boundaries

Focused regressions were exercised against the failing behavior before fixes. Final `npm run verify` passes: 1,780 unit/integration tests, 167 Chromium browser tests, 202 Rust tests (two paid live smoke tests remain opt-in), lint/Clippy, type checks, release-configuration checks, production build, and the explicitly reviewed size caps. Both measured target profiles pass their recorded limits. An isolated baseline replay with the new tests confirmed 12 selected failures in the unpatched application across persistence, Skills polling, usage refresh, thread health, and terminal state. The menu coalescing regression also fails against the original real-browser implementation. Additional WebKit coverage passes 59 real-browser tests across select-menu placement, timeline geometry, streaming, pacing, and fades. The complete default browser suite uses Chromium.

No native Rust implementation, provider model setting, user database, release version, installer, signing material, or updater configuration was changed. The two opt-in paid live application-provider tests were not run; authorized Claude Code use was confined to the targeted Fable review. Native Windows application behavior and a sustained whole-app performance profile were not exercised in this pass. The installed app receives these changes only through a subsequent build/release.

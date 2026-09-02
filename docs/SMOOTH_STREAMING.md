# Streaming presentation: cadence, evidence, and rollback

## Recovery points

- `codex/checkpoint-before-smooth-text`: `a6a64fe96fa38cf1b3cfbd81b84ad1f1524761ec`, before any fade.
- PR #70 / `48b381b7f3e163dc3c096836ffaff6afa2141058`: first fade.
- `codex/checkpoint-before-stream-cadence`: `e4b2d5016df61b9ea98cc271b6b2b03d8e0195be`, before display pacing.

The named checkpoints are preserved on origin. Revert through a topic branch and PR, never reset main. No transcript format, provider protocol, preference, database or migration changes are involved. No release/version change is part of this work.

## Why the longer fade was insufficient

The first fade started at 45% opacity over 180 ms. PR #71 changed that to an 8% / 420 ms smoothstep and fixed premature fade eviction/completion unmounting. Those lifecycle tests passed, but **did not establish perceptual smoothness**. The user reported worse jitter with Haiku 4.5.

A tools-disabled Claude Code capture of a synthetic rainwater article produced 24 text deltas / 3,262 characters in 7,336 ms. Median delta length was 139 characters; maximum 187; largest arrival gap 384 ms. This is one observed sample, not a universal Haiku speed claim. The fixture contains only synthetic text and relative times, not private messages or account data.

Fable 5.1 (high effort, two narrow tools-disabled consultations) identified whole bursts changing geometry/follow-scroll before becoming legible, irregular whole-burst opacity, and closing Markdown syntax clearing every active highlight at once.

## Current approach

`AssistantMessageMarkdown` now has a small **display-only** pacing buffer before the existing deferred Markdown renderer. Canonical provider/store text, task status, persistence, search and export are not paced.

- Each arrival contributes a linear reveal window of 240 ms. Overlapping windows preserve order and older deadlines; updates cannot keep restarting a timer indefinitely. Normal publishes are capped near 30 Hz, with a final drain allowed between ordinary publishes.
- This is an intentional visual delay: ordinarily up to 240 ms plus the next animation frame/deferred render. It is not a hard wall-clock guarantee on a suspended or busy renderer, and not a provider-speed improvement.
- First mounts, including reopened live threads, display their initial snapshot immediately. No heuristic guesses whether a short message is live or history.
- Completion lets only the bounded visual tail drain; it does not delay provider/task completion. The same Markdown DOM survives, including completed-turn compaction. Final edits and thread changes discard obsolete scheduling.
- Copy-message uses complete canonical text. Copy-code explicitly flushes the display tail and bypasses deferral before reading the current code DOM, preventing artificially truncated code after completion.
- Source replacements, hidden documents, selection in the message, reduced motion, forced colors, unsupported policy APIs and work-limit overflow use ordinary immediate rendering. Unmount removes listeners/frames.
- The secondary paint-only fade is now 30% to 100% over 140 ms with cubic ease-out and 20 ms buckets. Text becomes legible promptly while paced updates change layout. Native CSS Custom Highlights still avoid wrapper spans, transforms, geometry animation and an alternate Markdown parser.
- A Markdown-visible tail rewrite retains still-fading unchanged-prefix ranges. Changed semantic regions display normally; already-visible text is never deliberately faded again. Source rewrites reset everything.

## Work limits and tradeoffs

Per pacer: 48,000 source UTF-16 units, 2,048 pending units and 64 arrival batches; one scheduled rAF only while pending. Grapheme-aligned slices avoid splitting surrogate/combining/ZWJ clusters. Huge bursts and long messages deliberately skip pacing. Step size is proportional to burst size: the measured 26-character result below is **not a universal cap**. A hard character cap and a fixed latency bound cannot both hold for arbitrary provider throughput.

Per fade: 48,000 source units, 32,768 rendered units, 512 visited DOM nodes, 256 text nodes, 2,048 new units, 24 color/time groups, 64 ranges and 64 computed color reads per update. No geometry queries or per-frame color reads. Range rebasing is planned before replacing native ranges. Overflow preserves representable old fades and seals skipped intervals against retroactive fading; unrepresentable reparses fall back to ordinary rendering. Theme-only color changes can retain an old hue for at most the remaining 140 ms or until the next streaming commit discards mismatched-color ranges.

Pacing adds small renders, not fewer renders: the captured replay went from 24 burst updates to roughly 150–190 paced updates. This is feature overhead bounded to the visible live response, not a global efficiency win. Most implementation code is lazy; copy-flush integration adds 66 startup JavaScript bytes through shared export bookkeeping. CSS and saved-thread payloads are unchanged. The budget exception records exact production sizes without headroom.

## Evidence and its limits

Before/after use the same captured fixture and real Markdown/flow timeline:

| Replay measurement | PR #71 | Paced prototype |
| --- | ---: | ---: |
| Largest rendered-text increment, deterministic 60 Hz | 187 chars | 26 chars |
| Largest opacity-equivalent increment, same replay | ~161 chars | ~25 chars |
| Largest scroll step, fixed 720 × 300 shell | 81 px | 39 px |
| Real-time Chromium largest text step | 187 chars | 33 chars |
| Real-time WebKit largest text step | 187 chars | 39 chars |
| Real-time largest scroll step, two-pane 1400 × 900 preview | 76 px | 48 px |

The real-time development-browser runs were recorded side by side. Both had identical final rendered text, no page errors and no >50 ms frame gaps. Combined two-pane p95 frame gaps were ~9.6 ms in Chromium and 26 ms in WebKit. These are local recorded runs, not isolated production CPU benchmarks or Windows native FPS guarantees. Native Safari also opened the replay.

A stress replay with 250 formatted sections (~30 KB source before new output) preserved identical final text. Chromium had no >50 ms gaps; WebKit had one 51 ms gap. This does **not** justify a universal no-jank claim.

Automated cadence thresholds are perceptual proxies, not a judge of pleasant motion. Normal-use human feedback is still required. Do not describe passing lifetime/range tests or a still screenshot as proof that streaming feels smooth.

## Verification

Run `npm run verify` (frontend/Rust tests, full Chromium suite, lint, clippy, typecheck, build, release configuration and size gate). Also run:

```sh
MYTHRA_BROWSER_TEST_ENGINE=webkit npm run test:browser -- src/lib/streamingTextPacer.browser.test.ts src/lib/streamingTextFade.browser.test.ts src/components/ChatTimeline.streaming.browser.test.tsx src/components/ChatTimeline.cadence.browser.test.tsx src/components/ChatTimeline.layout.browser.test.tsx
```

macOS CI runs this subset in addition to full macOS/Windows verification. Coverage includes arrival deadlines, rate bounds, graphemes, history mounts, source edits, overflow, policy failure, selection, completion drain, thread switching, resumed streams, DOM identity, code-copy during a pending tail, reader position, and existing layout/long-history regressions.

Fable's policy-fallback and code-copy findings were fixed and regression-tested. Its warning about burst-dependent step size is documented above; no universal 26-character bound is asserted.

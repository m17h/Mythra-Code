# Smooth streaming: scope, safeguards, and rollback

## Recovery point

The clean, verified pre-change main is
`a6a64fe96fa38cf1b3cfbd81b84ad1f1524761ec` (PR #69).
It is preserved locally **and on origin** as
`codex/checkpoint-before-smooth-text`. The implementation lives on
`codex/smooth-streaming-text` and goes through a normal reviewed PR.

Revert this feature's merge through a new topic branch and PR if needed; do not
reset main or overwrite user changes. No transcript format, preference, database,
provider protocol, or migration is changed, so rolling back requires no data
conversion. Removing the decoration hookup in `StreamingMessageMarkdown` alone
also restores the old rendering path.

## Behavior and boundaries

Newly appended assistant text fades from 45% of its normal color opacity to
100% over 180 ms. Text is never queued, hidden from the DOM, or delayed for the
animation. This is a visual feature, not a provider-speed improvement.

The existing memoized, deferred React Markdown renderer stays intact. Decoration
runs only after a committed deferred render. Native CSS Custom Highlights paint
per-text-node ranges; no text splitting, wrapper spans, transforms, height
animation, alternate Markdown parser, or per-frame React state is introduced.
Code copying and links still use the original nodes. Literal originating text
colors avoid the compounded alpha and incorrect hues caused by `currentColor`
in the highlight inheritance chain.

The first committed snapshot is always fully visible, including a reopened live
thread. Only strict appends to both source and rendered text can fade. Markdown
rewrites are shown immediately, not animated. Completed messages have no fade
controller. App's existing `key={threadId}` boundary disposes controllers on
thread switches; row identity is not inferred from matching text prefixes.
Completion, interruption, and unmount dispose listeners, ranges, pending frames,
and the small runtime stylesheet. Text selection, hidden documents, reduced
motion, and forced colors clear the effect and establish a new baseline before
resuming. Unsupported browsers and cosmetic failures keep normal rendering.

Safety limits per live message/controller:

- 48,000 source UTF-16 code units, 32,768 rendered code units.
- 512 visited DOM nodes and 256 text nodes per snapshot.
- 2,048 newly rendered code units per update; larger bursts appear immediately.
- Eight active color/time groups, 64 total ranges, and 64 computed-color reads
  per update. No geometry queries or per-frame color sampling.
- Grapheme-aligned range boundaries; no partial surrogate, combining, or joined
  emoji highlighting. Buttons, SVG icons, and hidden controls are excluded.

Crossing a work budget skips decoration, never content. A normal later append
can recover after a burst/style/range-budget skip. Once a response itself exceeds
the message/DOM bounds, further text uses ordinary rendering. This conservative
large-response fallback is intentional; bounded tail-only decoration can be
investigated separately without weakening these thread-safety guarantees.
Colors changing without a text commit can retain the previous hue for at most
the remaining 180 ms; the next text commit discards mismatched-color ranges.

The module stays inside the existing lazy timeline chunk. It adds no startup
JavaScript/CSS, network requests, provider calls, persisted fields, or saved
transcript bytes. The effect does add bounded live-render work; unchanged startup
size is not a claim that animation is free. Exact production bundle overhead is
recorded in the performance-budget exception and the PR.

## Verification

Run `npm run verify` (full Chromium suite, frontend/Rust tests, typecheck, lint,
production build and performance gate). Also run:

```sh
npx playwright install webkit
MYTHRA_BROWSER_TEST_ENGINE=webkit npm run test:browser -- src/lib/streamingTextFade.browser.test.ts src/components/ChatTimeline.streaming.browser.test.tsx src/components/ChatTimeline.layout.browser.test.tsx
```

macOS CI now runs that WebKit subset, in addition to full macOS/Windows verify.
Browser tests exercise within-paragraph fades, nested colors, replacements,
graphemes, normal/reduced-motion behavior, real selection, bounded work,
failure fallback, cleanup, deferred Markdown under StrictMode, independent
streams, completion, reopening history, copy/link/table semantics, stable
geometry, reader position, and the existing overlap/long-history regressions.

A native macOS Tauri/WKWebView preview was exercised with a continuously
streaming **synthetic** transcript: the newest text visibly faded, old text stayed
steady, and formatted prose, links, and code rendered correctly. No provider
requests or real-thread edits were needed. The temporary preview entry point was
removed before production validation. Automated Windows Chromium coverage is
not a claim of manual validation in the user's installed Windows WebView2 app.

Opus 5 (high effort) reviewed the design and integrated code. Its concrete
style-budget recovery finding was fixed and regression-tested. Its concern
about reusing rows between threads is already prevented by App's thread key;
the deliberately conservative long-response fallback is documented above.

API rationale: [CSS Custom Highlight specification](https://www.w3.org/TR/css-highlight-api-1/)
and [highlight inheritance](https://drafts.csswg.org/css-pseudo-4/).

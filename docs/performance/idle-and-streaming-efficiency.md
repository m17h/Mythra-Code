# Idle and streaming efficiency — 2026-09-07

This pass preserves streaming cadence, animation, model choices, retry behavior,
and handoff text. It removes repeated work rather than changing those features.

## Changes

- Slot-release retries create a timer only after an acknowledgement fails. The
  timer stops once every pending release succeeds. The previous implementation
  scheduled a callback every five seconds even with an empty queue: 720 empty
  callback opportunities per hour before browser throttling. Recovery still
  retries every five seconds and prevents overlapping requests.
- The sub-agent elapsed-time clock stops while the document is hidden and
  immediately catches up when visible. The previous clock scheduled one callback
  per second while children were active, even when hidden. Provider work and
  authoritative completion timestamps are unaffected.
- The streaming text pacer reuses its Unicode segmentation object between
  frames for the same source text and invalidates it on every text change.
  Published text, grapheme boundaries, the 30 Hz display ceiling, the completion
  tail, selection behavior, and reduced-motion behavior remain unchanged.
- Identical fallback model catalogs, effort options, and picker option-building
  code are shared by the composer and Settings. Choices and labels are unchanged.
- Provider-handoff prompt formatting loads after the user confirms a handoff.
  The formatter itself is unchanged. Import failure leaves the source task in
  place, and a selection change during loading prevents a stale handoff.

## Synthetic streaming lookup measurements

Run `node scripts/benchmark-streaming-boundaries.mjs`. It uses local Playwright
browser engines with no app account, provider inference, saved history, or
network request. Windows runs Chromium; macOS runs Chromium and WebKit.

The workload uses a 36,000-code-unit Unicode string, 1,000 source updates and six
boundary lookups per update. Seven paired samples follow warmup; pair ordering
alternates and output checksums must agree. The table reports median total time
for the 6,000 lookups, not time per frame or an end-to-end app speedup.

| Host / engine | Recreate each lookup | Reuse until source changes |
| --- | ---: | ---: |
| macOS arm64 / Chromium 151.0.7922.34 | 26.6 ms | 6.4 ms |
| macOS arm64 / WebKit 26.5 | 36.0 ms | 13.0 ms |
| Windows x64 / Chromium 151.0.7922.34 | 147.6 ms | 26.8 ms |

These are controlled microbenchmarks. They establish reduced lookup work, not a
measured reduction in overall CPU, battery consumption, or typing latency.

## Production frontend size

The baseline was reconstructed from HEAD plus the exact uncommitted diff present
before this pass. Both baseline and changed sources used the same dependencies
and build settings. Both frontend profiles were built on macOS; this table is
not a native Windows executable benchmark. This efficiency pass did not further
raise the candidate's budget values; the same 1.15.7 candidate separately records
an exact reviewed size increase for its correctness and security hardening.

| Profile / metric | Before, bytes | After, bytes | Change |
| --- | ---: | ---: | ---: |
| Safari startup JavaScript | 731,437 | 730,363 | −1,074 |
| Safari total JavaScript | 1,489,870 | 1,489,235 | −635 |
| Chrome startup JavaScript | 705,007 | 703,888 | −1,119 |
| Chrome total JavaScript | 1,453,060 | 1,452,404 | −656 |

Startup CSS is unchanged. Both profiles pass the existing size budgets.

## Validation

- New idle-timer tests fail against the original implementation and pass after
  the changes. They cover successful first acknowledgements, failed/retried
  acknowledgements, hidden startup, visibility transitions, Strict Mode, and
  unmount cleanup.
- Unicode tests cover combining characters, flags, joined emoji, Indic text,
  changing source text, segmentation reuse, and complete final output.
- `npm run verify` passes: 1,624 unit tests, 157 Chromium browser tests, 145 native
  Rust tests, lint, type checks, production build, and performance budgets.
- Two additional handoff integration cases pass for formatter load failure and
  changing tasks during loading. The Windows focused run also passes 259 unit
  and integration tests for retry, clock, pickers, and handoff behavior.
- Focused streaming tests pass in WebKit on macOS and Chromium on Windows
  (18 tests per engine), including Markdown structure, copy behavior, selection,
  scroll position, simultaneous streams, and completion cleanup.

No native implementation, user data, or inference setting was changed by this
efficiency pass. Existing checkout changes were preserved and the release version
was bumped separately. Long-session native-app profiling remains useful future
work; this pass does not establish an app-wide frame-time or memory improvement.

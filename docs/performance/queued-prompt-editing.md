# Queued prompt editing

Users can edit queued or failed prompts inline, save or cancel, and retain their
position, attachments, and unrelated composer draft. A durable hold prevents
delivery while editing, including after navigation/reopening. New prompts and
late steer/question follow-ups join the existing queue. Native answers to live
question requests still use their original response channel.

## Performance review

Both baseline (`3248886`, main before this change) and candidate renderer builds
were measured on the same Mac with the same installed dependencies. This is a
feature-size increase, not a claim of faster startup or native runtime timing.

| Raw bytes | Safari 13 delta | Chrome 105 delta |
| --- | ---: | ---: |
| App entry | +3,024 | +2,713 |
| Startup JavaScript | +3,793 (0.47%) | +3,426 (0.44%) |
| Startup CSS | +1,155 (0.33%) | +1,155 (0.34%) |
| Total JavaScript | +3,793 | +3,426 |

The editor mounts only for an actively edited queue item. Typing stays in that
component and uses the existing 400 ms draft persistence debounce. Begin/end
persist the queue hold synchronously; finishing also flushes obsolete draft
removal. Draft counts are bounded independently for main prompts and queue
edits. No new dependencies, provider requests, polling, idle work, transcript
growth, or per-frame updates are introduced. Existing animations are unchanged.

The budget exception records exact measured sizes with no spare headroom.

## Verification

- 313 focused store, storage, composer, turn-runner, and App integration tests.
- Three real-browser interaction tests each in Chromium and WebKit: compact
  layout, save/cancel/shortcut, preserved attachments and main draft, keyboard
  focus, multiple edits, and empty draft recovery after navigation/remount.
- Store coverage verifies restoration of the durable hold; runner coverage
  verifies completion during editing, FIFO, blocked steering/retry, and failed
  queue recovery. Provider processes are mocked; no subscription requests made.
- Type checking, lint, and both production renderer targets passed. These
  renderer tests do not constitute a native Windows or live-provider smoke test.

Sol independently reviewed the implementation twice. Findings about empty
drafts, queue ordering, focus, stale draft cleanup, draft caps, and idle-state
copy were addressed before the second review found no substantive blocker.

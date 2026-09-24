# Feedback, project checks, and setup before Run

## User workflow

Select text in a completed assistant reply or one file in Review, then choose
Feedback. Add a note, edit/remove it in the composer, and send the notes alone
or with an optional typed message. One ordinary provider message carries the
batch. Selection and note controls animate in and out; exiting controls remain
mounted but inert. Keyboard feedback, reduced motion, light/dark themes, narrow
windows, and UI zoom are supported.

Notes persist by thread and working folder. A send captures an immutable batch;
only unchanged accepted notes are removed. Failures retain the notes and typed
message, and edits made during delivery survive. Switching threads closes only
the temporary editor, without remounting the conversation. Frozen reply quotes
and diff coordinates are evidence; changed sources are never silently relocated.

Review offers AI review for every provider and a separate Run checks control.
Save a project check command once; checks execute only on click, independently
of a development server in Terminal. Stop targets the captured check process.
Results show the last run, elapsed time and bounded diagnostics. Ask agent to fix
stages a feedback note; it does not send or start an automatic repair loop.
AI review preserves unsent composer attachments/drafts, and generated review
text cannot accidentally expand @skill mentions, including after queue restore.

Run has an optional Before each run step. Discovery and the model's existing
Run tool can save it. Setup and launch share their shell environment and use the
thread's working folder; setup failure prevents launch, including launch-side
fallback commands. Setup is deliberately repeatable, not cached as a permanent
success, so new worktrees and changed dependencies remain supported. Existing
single-command recipes keep their original behavior.

## Performance review

Measured renderer output uses the same installed toolchain as the queued-prompt
baseline on this branch. The following is additional feature cost beyond queued
prompt editing; it is not a claim of faster runtime or unchanged startup time.

| Raw bytes | Safari 13 delta | Chrome 105 delta |
| --- | ---: | ---: |
| App entry | +13,659 | +12,557 |
| Startup JavaScript | +33,724 (4.16%) | +32,071 (4.11%) |
| Startup CSS | +10,559 (2.99%) | +10,377 (3.00%) |
| Total JavaScript | +40,511 | +38,693 |

No dependencies, automatic provider requests, or background checks were added.
Selection is examined after a gesture, not per animation frame. Diff anchors are
parsed on selection; advisory source checks coalesce live updates. Feedback is
bounded to 12 notes / 40,000 characters per draft and 100 stored scopes. Checks
have a five-minute timeout, 64 KiB runtime output cap, 12,000-character retained
excerpt, and bounded idle result storage. A captured excerpt may omit later
output beyond the runtime cap; it is not represented as the complete final tail.

Checks controls and their stylesheet load only when Review needs them. Their
loading boundary preserves the rest of the dock. A visible running check updates
its timer once per second; a visible result updates its age every 30 seconds.
Existing timeline virtualization and progressive diff rendering are retained.
Budget limits equal measured output without additional headroom.

## Evidence and limits

- Focused hook/store/Composer tests cover failure, concurrent edits, duplicate
  sends per thread, queue order, restore, cancellation and scope changes.
- App integration covers setup plus Run in a worktree, and failed checks sent
  alone or with an optional prompt as exactly one agent request.
- Real Chromium and WebKit interactions cover selection, diff coordinates,
  mixed added/deleted lines, Shift navigation, scope changes without remount,
  animated inert exits, 150% zoom at a 420px viewport, narrow Review panels,
  and editing setup in a short Run window. Screenshots in `test-results` are
  actual component browser fixtures, not a live native production session.
- Harmless native Windows shell probes verified same-shell environment,
  `.cmd` continuation, parentheses, positive/negative failure codes, and
  setup failure preventing both launch and fallback. macOS shell regression
  tests verify launch gating and inherited setup environment.
- Provider processes are mocked in UI tests; no paid model discovery or live
  provider end-to-end run is claimed. No release, signing, or version change.

Opus 5.5 designed/implemented the UI and performed a targeted follow-up review.
Sol reviews challenged workflow integration, Windows behavior, and browser
interaction. Confirmed issues from those reviews were corrected and retested.

Final local verification: `npm run verify` passed, including 2,100 unit and
integration tests, 219 Chromium browser tests, 244 Rust tests (3 deliberately
ignored), lint, Clippy, type checking, release configuration, renderer build,
and the reviewed bundle budgets. The complete 219-test browser suite also
passed in WebKit. Both Safari and Chrome renderer profiles passed their measured
budgets. These results are for the local source branch, not a published release.

## Automatic check setup follow-up

Project agents now receive `set_project_check_command` alongside the existing
Run command tool, across all five providers. The turn guidance asks them to save
the exact project-relative check command when they identify or change tests.
Saving never executes a command. Models must support tool calls for agent-driven
saving; the explicit finder is available independently.

When no command is saved, Review offers Find checks. It uses the same persisted
provider/model preferences as the Run finder and inspects project files through
a read-only worker. It can save existing package scripts, nested project checks,
local check scripts, and common language test commands; no credible test setup
produces an explicit unavailable result. It does not invent tests or install
packages. Discovery survives navigation, stays attached to its originating
project, and cannot overwrite newer manual or agent edits. Stop suppresses late
results. Run checks remains a separate explicit action.

Opus added the compact finder/status UI and moved manual command/model settings
into an animated popover. Browser verification exposed a dismissal bug caused by
programmatic focus/layout scrolling. Dismissal now distinguishes user scrolling
from layout events, including nested provider/model menus.

Additional renderer cost beyond the preceding feedback/checks implementation:

| Raw bytes | Safari 13 delta | Chrome 105 delta |
| --- | ---: | ---: |
| App entry | +3,438 | +3,045 |
| Startup JavaScript | +10,409 (1.23%) | +9,810 (1.21%) |
| Startup CSS | +1,377 | +1,377 |
| Total JavaScript | +10,559 | +9,908 |

No new dependencies or automatic background model requests on mount. This is
measured feature overhead, not an efficiency improvement. Limits are the measured
output with no spare headroom. Native macOS discovery with Claude Haiku correctly
identified and saved `npm test` for the disposable Node test project, without
executing it or creating an inbox thread. The live macOS demo also verified reply selection, note editing and removal,
feedback-only Send, diff feedback combined with an optional prompt, successful
check execution, and failed-check output staged without sending. Claude Haiku
made the requested changes and reran the actual Node tests successfully.

Native testing exposed an unrelated startup stall: an optional macOS Keychain
read could hold the provider server lock indefinitely. Credential reads now share
one in-flight worker per credential with a four-second wait bound. Saves/deletes
supersede stale reads without spawning extra workers or changing stored secrets.
Four focused concurrency regressions cover sharing, timeout, and save races.

Final verification passed: 2,115 unit/integration tests, 220 Chromium and 220
WebKit browser tests, 251 Rust tests (3 ignored), lint, Clippy, type checks,
release configuration, renderer build, and measured Safari bundle budgets.
Chrome measurements also remain within the updated exact limits. The macOS
debug binary was rebuilt, reopened, and verified to preserve the discovered
command and run the actual checks successfully after restart. This follow-up was not exercised as a native Windows
app, and no version bump, release, signing, push, or merge was performed.

## Final Sol review and native replay

Three Sol reviewers independently examined feedback/UI behavior, send/queue and
skill boundaries, and command discovery/native integration. Confirmed repairs:

- Quoted `@skill` evidence no longer invokes a skill. Only the user's typed
  prompt and feedback comments are scanned; this separate source survives
  queueing, retry, steering, and restart. Editing the raw formatted text of a
  queued feedback item conservatively clears the source: newly typed mentions
  there remain literal. Ordinary queued prompt mentions still work.
- Outside clicks dismiss selection feedback without the retained text selection
  reopening it. Oversized persisted notes no longer discard later valid notes.
- Check discovery rejects echo-only placeholder scripts (including chained ones)
  and missing script aliases, while preserving real test wrappers and nested
  Windows `cd /d` commands. Arbitrary script semantics remain heuristic.
- A native reopen exposed a duplicate prompt written once before its turn ID
  arrived and again afterward. That transition now replaces the pending
  snapshot. Existing duplicate user rows recover by exact ID, preserving their
  first position and newer identified data. Equal text with distinct IDs stays
  separate, including when loading older pages.

Normal transcript pages remain bounded. Deduplication is linear and returns the
original array when IDs are unique. An unresolved no-ID tail with older pages
requires full hydration to recover the snapshot boundary; this can repeat on
reopen until that tail receives a turn ID. This exceptional correctness cost
is explicit rather than claiming all histories remain paged.

Additional raw bytes from these review repairs:

| Measure | Safari 13 | Chrome 105 |
| --- | ---: | ---: |
| App entry | +732 | +586 |
| Startup JavaScript | +1,998 (0.23%) | +1,722 (0.21%) |
| Startup CSS | 0 | 0 |
| Total JavaScript | +2,000 | +1,736 |

No new dependencies, background model calls, or reduced animations. Budget
limits equal measured output without spare headroom.

The rebuilt isolated macOS app recovered the actual duplicate transcript on
reopen, preserved the remaining turns, and kept selection feedback dismissed
after successive outside clicks. A cheap Claude Haiku turn called
`set_project_check_command` successfully; the saved `npm test` then passed in
the native Review panel. The production app/profile was not modified. A native
Windows Rust helper probe verified nested `cd /d` discovery and traversal
rejection; this was not a complete Windows application run.

Final review gate: `npm run verify` passed on the settled source, including
2,131 unit/integration tests, 221 Chromium tests, 252 Rust tests (3 deliberately
ignored), lint, Clippy, type checking, release configuration, production build,
and exact Safari budgets. All 221 WebKit browser tests also passed. Chrome
production output was measured separately at the exact recorded limits. Native
macOS debug rebuild and the live checks described above passed. No commit, push,
merge, version bump, signing, or release was performed in this review.

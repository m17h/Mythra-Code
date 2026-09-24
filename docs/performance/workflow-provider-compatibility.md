# Claude and Cursor saved workflows

The saved workflow runner now dispatches agent steps to the selected provider's
actual runtime. Claude and Cursor create locally persisted project threads,
retain their sessions across steps, and reopen through the existing transcript
adapters. OpenAI, OpenRouter, and LM Studio retain their Codex-backed path.
Explicit shell-command steps still need the Codex runtime; Claude/Cursor
agent-only recipes do not. Model, effort, and permission settings come from the
saved recipe, not whichever composer happens to be visible.

The implementation reuses existing provider event subscriptions, checkpoint
hooks, transcript adapters, and the workflow scheduler. It adds no new idle
polling, dependency, background model request, or animation reduction. Workflow
Project, Trigger, and Run when pickers now use the existing app-native menu.

## Reliability checks

- Local thread identity is remembered before events or navigation. Cursor's
  returned session ID is saved for later steps and normal follow-up turns.
- A completion event arriving before the start response cannot resurrect a turn.
- Workflow navigation waits for the target project to render before opening its
  thread. History links use the same handoff; background transcript saves preserve
  user-renamed thread titles.
- Stop uses one shared interruption operation per turn, including startup races,
  active waits, and timeouts. Provider kill failures surface as failures rather
  than silently claiming that a process stopped. Timed-out turns are not retried.
- Pending-start failures discard their checkpoint; completed/interrupted local
  turns finalize before the next step starts another snapshot. Command steps
  also await checkpoint finalization and honor Stop after checkpoint preparation.
- Manual runs retain normal approvals and question UI. Unattended runs reject
  approval/question requests through the provider's protocol without granting
  broader access. A model may continue within its permitted tools after denial;
  a completed turn is not proof that every requested action succeeded.
- Native Cursor testing reproduced historical assistant text concatenated into
  the next reply on session resume. Session-load display notifications are now
  gated until the new prompt starts. Permission requests, protocol responses,
  stderr, and process exits remain handled during startup.

## Native evidence and boundaries

The isolated macOS debug app completed real two-step Claude Haiku and Cursor
Haiku recipes. Step 2 recalled a word supplied only in step 1, verifying live
session continuity. After the Cursor replay repair, the same reproduction
returned one word per step instead of duplicating the earlier output. Workflow
definitions, run history, and transcripts survived application restart. Opening
a completed Cursor run from a different active project selected its own project
and displayed the complete transcript in the native app. Tests
used a disposable project and did not change the production app/profile.

Provider start/stop, readiness, retry, timeout, early completion, transcript
persistence, saved permissions, and native unattended handling have focused
regressions. The project-instructions switch retains its existing Codex-provider
scope; this change does not claim identical native provider sandbox behavior.
Windows provider processes were not exercised end to end in this pass.

## Future design discussion (not implemented)

Three Sol agents reviewed compatibility and future direction. Recommended
follow-ups are plain-language generation of reviewable recipes, a small set of
parallel read-only reviewers plus synthesis, durable pause/resume, clear phase
and worker progress, structured outputs and bounded fix/retest loops, and
versioned project-shared recipes. Arbitrary workflow JavaScript and large write
fan-out are deferred until isolation and recovery are solid. These remain
proposals; the compatibility implementation adds none of them.

Reference: https://code.claude.com/docs/en/workflows (reviewed 2026-09-24).

## Measured build cost

Both production targets were rebuilt after the final changes. Compared with the
pre-compatibility working tree, startup JavaScript increases by 3,342 bytes
(0.41%) on Chrome and 3,925 bytes (0.46%) on Safari. Startup CSS increases by
295 bytes on each. Total JavaScript increases by 3,406 / 3,990 bytes respectively.
The reviewed performance-budget exception records these exact measurements,
with no spare headroom. This is feature cost, not a claimed speed improvement.

## Final verification

`npm run verify` passed after all source changes settled: lint, Clippy, TypeScript,
Cargo check, 2,154 unit/integration tests, 221 Chromium browser tests, 255 Rust
tests (3 ignored), production build, and exact performance budgets. The full
WebKit suite also passed 221 tests. One earlier WebKit run had a feedback keyboard
focus failure outside this change; its six-test focused replay and the subsequent
full WebKit run passed without a source change. Native macOS checks above provide
the provider integration evidence; these suites do not replace Windows testing.

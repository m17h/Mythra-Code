# Transcript and attachment reliability review — 2026-09-13

## Findings and disposition

1. **Unopened Claude/Cursor rename could erase history: fixed.** Renames now serialize a metadata-only native update with transcript writes; chunks, paging state, and Cursor session identity survive. Legacy histories migrate safely before the update.
2. **Multi-image paste could lose later clipboard items: fixed.** Capture every File handle synchronously before asynchronous preparation. Prepare sequentially to bound memory and retain image order.
3. **Steer could race durable image preparation: fixed.** Send and Steer share a draft-scoped preparation barrier. Navigating away during preparation preserves the original draft instead of delivering to the new conversation.
4. **Reopened prompts could appear below replies: fixed.** Same-ID merges retain durable timeline order for prompts, responses, and activities while accepting fresh live content.
5. **Failed saves retried indefinitely and blocked closing: fixed.** Automatic retries stop after three attempts with backoff; dirty state remains retryable. Flush waits for its revision snapshot rather than all future streaming output. A 15-second close deadline offers an explicit Keep open / Close without saving choice; failure never silently discards unsaved work.
6. **Completed asynchronous sends could steal the selected thread: fixed.** Delivery still updates its original task but respects navigation while provider setup is pending, including newly created tasks.
7. **HEIC/HEIF could be mislabeled as PNG: fixed.** Reject unsupported image attachments before recording/submitting a turn, with conversion guidance. Native Claude/Cursor encoding also rejects unsupported formats; old saved attachments receive the same validation.
8. **Durable image storage grows without collection: confirmed, automatic deletion deferred.** New clipboard images now use one durable copy instead of a temporary copy plus durable copy. Removed blind age/size cleanup of legacy pasted-image paths because histories may still reference them. Safe collection needs an authoritative reference inventory covering SQLite chunks/tails, drafts, queues, legacy files, and provider-owned histories; age alone is not safe evidence of abandonment.
9. **Queued answers said “Answers sent”: corrected.** They now say “Answers submitted,” with an explanation of queued status and the existing Retry control. Failed queued delivery already had retry support; that part of the report was not reproduced.

The synchronous JavaScript base64 loop was replaced with browser-native FileReader, with a 50 MB pre-encoding cap. Restricting image preview to app-owned paths was deferred because existing attached external paths legitimately need previews; this needs reference-aware authorization rather than a blanket path restriction.

## Performance-regression review

The baseline is HEAD plus the four timeline/style files already modified before this task. It was built in a separate snapshot using the same dependencies. Both final builds include those pre-existing edits. Measurements are raw minified production bytes, not runtime latency claims.

| Target / metric | Starting worktree | Final | This task's delta |
| --- | ---: | ---: | ---: |
| Safari 13 app entry | 375,756 | 377,598 | +1,842 |
| Safari 13 startup JS | 747,226 | 749,275 | +2,049 |
| Safari 13 startup CSS | 363,306 | 363,306 | 0 |
| Safari 13 total JS | 1,514,104 | 1,516,419 | +2,315 |
| Chrome 105 app entry | 355,880 | 357,761 | +1,881 |
| Chrome 105 startup JS | 719,545 | 721,626 | +2,081 |
| Chrome 105 startup CSS | 356,763 | 356,763 | 0 |
| Chrome 105 total JS | 1,475,582 | 1,477,902 | +2,320 |

Decision: accept under 0.30% more startup JavaScript for the confirmed data-loss and delivery fixes. No dependency, permanent polling, background provider call, or CSS is added by these fixes. Clipboard encoding no longer performs a synchronous per-byte JavaScript string loop, each new paste is stored once, and failed saves have a bounded automatic retry budget. No app-wide speedup is claimed. Limits match measured output with no extra headroom.

The pre-existing edits separately account for 807 startup CSS bytes on each target and 326 Safari / 349 Chrome total JavaScript bytes above the previous caps. They were preserved, not rewritten during this review.

## Validation

Focused regression tests cover unopened and legacy renames, clipboard lifetime, durable steering, draft navigation, echo ordering, retry exhaustion and recovery, close deadlines and explicit discard, delayed provider setup, and unsupported image formats. Final verification passed:

- macOS `npm run verify`: 1,737 unit/integration tests, 164 Chromium browser tests, 167 Rust tests, release-configuration checks, TypeScript, ESLint, Clippy, production build, and exact performance budgets.
- Windows `npm run verify` on ZEDS-PC against an identical source snapshot: 1,737 unit/integration tests, 164 Chromium browser tests, 168 Rust tests, and the same configuration/lint/type/build/budget gates.
- macOS WebKit: all 164 browser tests passed.
- `git diff --check` passed. The four pre-existing timeline/style files remain byte-for-byte unchanged from the starting worktree.

Windows validation used an isolated temporary source/dependency copy and the existing Cargo target cache; the project checkout was not edited. No paid provider calls or release build/publish were performed. These checks exercise mocked provider delivery and native Rust behavior, not a manual end-to-end session with a signed-in model. Native command changes require rebuilding/restarting the development app before manual testing.

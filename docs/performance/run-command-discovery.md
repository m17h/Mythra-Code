# Run-command discovery and Opus follow-up review — 2026-09-13

## User-visible behavior

The Run popover now has **Find run command** and **Discovery model settings**. All five app providers are supported: OpenAI, Claude, Cursor, OpenRouter and LM Studio. The default is OpenAI GPT-5.6 Luna, Low reasoning, Fast priority service. Model preferences persist across projects and model and effort selections survive switching providers. LM Studio uses the current server URL from Models and accounts. Reasoning controls follow advertised capabilities; Cursor uses exact catalog model IDs and their own reasoning settings; its print runtime rejected separately parameterized effort in live validation. Fast priority service remains an OpenAI option.

Discovery runs separately from the app-server conversation stream and never creates a visible task, child-agent card, or saved local transcript. It can continue with the popover closed; its edit control shows progress, a ready suggestion or failure feedback. Stop cancels it, and changing projects or closing the app cancels and cleans up its worker. Results show the proposed command and supporting explanation. **Use suggestion** fills the draft; **Save run command** remains explicit and nothing starts automatically. Suggestions remain recoverable after an accidental close until saved. Dropdown Escape closes the dropdown without losing the run-command draft.

The worker receives a bounded metadata snapshot: conventional manifests/task files, selected documentation lines and launch-script presence. It does not receive conversation history. Scanning excludes generated/hidden trees and symlinks, prioritizes root manifests, caps directory entries at 16,384, directories at 192, files at 48 and context at 96 KiB, and marks truncated evidence. It returns an actionable error when the metadata cannot identify a reliable command; ambiguous/custom projects may still require manual configuration.

Claude and the direct HTTP providers are tool-free. OpenRouter and LM Studio make stateless chat-completions requests with bounded responses, without requiring the Codex runtime. Cursor uses ask mode with sandboxing and isolated temporary config/data storage. Codex uses an isolated temporary working directory and a read-only sandbox with user configuration/rules disabled; it is not claimed to have a CLI-wide empty-tool setting. CLI workers have bounded output, timeouts, identity-scoped cancellation and temporary-file cleanup, and preserve the app's subscription authentication. HTTP cancellation aborts the request. At most two discoveries may coexist while project navigation cleans up the old worker. This is not a persistent background agent or scheduler.

## Independent Opus review and corrections

Two targeted Claude Code reviews used Opus 5 at High through tmux. Confirmed findings were reproduced or checked in code, then addressed:

- Image preparation now synchronously commits durable paths with React `flushSync`; delivery no longer relies on an animation-frame scheduling assumption.
- Close flushes make bounded passes for final updates and newly dirty threads, and reject if unsaved output remains. A failure in one transcript does not prevent healthy transcripts from completing their passes. Settings/drafts and transcript stores flush independently before an explicit discard choice. Errors are no longer swallowed by a return inside finally.
- HEIC validation precedes expensive native file reading.
- Discovery dropdown Escape, recovery of accepted suggestions, per-provider model choices, cancelled-result handling, and background progress/ready feedback were corrected.

No unrelated timeline/style changes were rewritten. The previous transcript/attachment review's one-pass close behavior is superseded by these bounded draining passes.

## Performance-regression review

Raw minified production measurements compare this change against the immediately preceding verified worktree, including all pre-existing edits.

| Metric | Safari before | Safari after | Chrome before | Chrome after |
| --- | ---: | ---: | ---: | ---: |
| App entry | 377,598 | 378,919 | 357,761 | 358,990 |
| Startup JavaScript | 749,275 | 752,935 | 721,626 | 725,137 |
| Startup CSS | 363,306 | 363,306 | 356,763 | 356,763 |
| Total JavaScript | 1,516,419 | 1,523,598 | 1,477,902 | 1,484,844 |

Decision: accept under 0.5% more startup JavaScript for this feature and the confirmed reliability fixes. Settings and new styling load only with the Run popover; no dependency, permanent polling, or unsolicited provider request is added. Native traversal is bounded. A tested alternative code split increased startup bytes and was not retained. Limits match measured output exactly. These are size measurements, not an app-wide speedup claim.

## Earlier two-provider validation

- Focused tests cover provider preferences, explicit save/use, closing/reopening, nested Escape, worker cancellation/navigation, malformed settings, final transcript updates, independent store failures, process/temporary-file lifecycle, and bounded directory fanout.
- Chromium and WebKit interaction/layout checks passed. The new UI was inspected from a browser screenshot.
- One explicitly announced live Luna/Low/Fast fixture request passed in 3.79 seconds: it returned `pnpm dev`, left saved Codex session artifacts unchanged, and removed its temporary workspace. The regular gate ignores this paid smoke test. No live Claude discovery request was made; Claude's adapter/argument/parser paths have native test coverage.
- macOS `npm run verify` passed: 1,749 unit/integration tests, 165 Chromium browser tests, 176 Rust tests, TypeScript, ESLint, Clippy, release-configuration checks, production build and performance budgets. The native suite and Clippy passed again after the final platform-neutral test assertion adjustment.
- Windows `npm run verify` passed against identical source on ZEDS-PC: 1,749 unit/integration tests, 165 Chromium browser tests, 177 Rust tests, and all configuration/lint/type/build/budget checks. Installed Windows Codex/Claude help also confirms the required ephemeral/safe-mode CLI flags.
- WebKit passed all 165 browser tests. The normal gates skip the one opt-in paid smoke test.
- Verification caught two fixture assumptions: the directory-attachment fixture now has an image extension so it reaches regular-file validation, and nested metadata assertions use native path separators. No production behavior was weakened to pass them.
- `git diff --check` passed. Source hashes for the final native files match the Windows snapshot. Only this report changed after final verification. The existing Windows checkout was not edited; the isolated audit copy was removed. No release, installation, commit or push was performed.

## All-provider follow-up review

Opus performed another targeted review and a follow-up of the provider expansion. The native changes improve provider error parsing, tolerate JSON fences and CLI banners, allow cold starts when sending metadata, stop cancelled scans, and retain valid proposals if scratch cleanup fails. Frontend changes remember model/effort per provider, persist manually typed model IDs on blur, expose account setup, and show background errors. An actual WebKit click test found label activation could close a reopened provider menu; labeled field containers and top-layer menus fix the interaction and clipping.

Incremental measured cost relative to the two-provider feature:

| Metric | Safari before | Safari after | Chrome before | Chrome after |
| --- | ---: | ---: | ---: | ---: |
| App entry | 378,919 | 379,834 | 358,990 | 359,819 |
| Startup JavaScript | 752,935 | 754,367 | 725,137 | 726,427 |
| Startup CSS | 363,306 | 363,306 | 356,763 | 356,763 |
| Total JavaScript | 1,523,598 | 1,526,066 | 1,484,844 | 1,487,115 |

Decision: accept under 0.2% startup JavaScript growth with unchanged startup CSS, no dependencies or polling, and lazy discovery UI. These are bundle measurements, not an app-wide speed claim.

### Follow-up validation

- Opus 5 at High completed two more read-only reviews through Claude Code/tmux. Confirmed issues were corrected; speculative provider requirements were checked against installed CLI behavior before adoption. The installed Claude help explicitly documents `--tools ""` as disabling all tools.
- One live Cursor request using exact model ID `gpt-5.3-codex-low` returned `pnpm dev` in 20.98 seconds, removed its temporary files, and left the pre-existing Cursor session snapshot unchanged. Two earlier attempts failed locally before inference (workspace trust and parameterized model syntax); those fixtures were cleaned. Current Cursor discovery therefore trusts only its newly created empty workspace and passes the catalog model ID unchanged.
- Direct OpenRouter/LM Studio request bodies, JSON parsing, errors, bounds and cancellation were tested with local HTTP fixtures. No live OpenRouter or LM Studio inference was performed. Paid smoke tests remain opt-in.
- macOS full `npm run verify`: 1,760 unit/integration tests, 166 Chromium tests, 183 native tests, two paid smokes ignored; all lint/type/configuration/build/performance checks passed. Final WebKit passed all 166 tests.
- Windows full `npm run verify` passed on the identical source snapshot: 1,760 unit/integration tests, 166 Chromium tests, 184 native tests, two paid smokes ignored, and all lint/type/configuration/build/performance checks. Final native/frontend hashes matched macOS. The isolated Windows test copy was removed; the existing checkout was preserved.
- Only this report changed after the final verification snapshot. No release, installation, commit or push was performed.

# Run-command discovery and Opus follow-up review — 2026-09-13

## User-visible behavior

The Run popover now has **Find run command** and **Discovery model settings**. All five app providers are supported: OpenAI, Claude, Cursor, OpenRouter and LM Studio. New discovery preferences default to OpenAI GPT-5.6 Luna, High reasoning, Fast priority service; existing saved model/effort choices are preserved. Model preferences persist across projects and model and effort selections survive switching providers. LM Studio uses the current server URL from Models and accounts. Reasoning controls follow advertised capabilities; Cursor uses exact catalog model IDs and their own reasoning settings; its print runtime rejected separately parameterized effort in live validation. Fast priority service remains an OpenAI option.

Discovery runs separately from the app-server conversation stream and never creates a visible task or child-agent card. It continues with the popover closed. A successful result is saved directly to the project's Run button through the same project-setting update used by the manual editor. The user sees **Saved to Run**, the command and its explanation, and can launch it by pressing **Run**. Discovery itself never launches the app. Stop and project navigation cancel the worker and suppress late saves. The editor and manual Save/Clear actions are disabled during discovery to prevent conflicting writes; manual editing remains available afterwards. Existing model preferences and all five provider choices remain supported.

OpenAI, Claude and Cursor now investigate in one continuous temporary native-harness session with the actual project folder as their working directory. Codex uses ephemeral execution, its read-only sandbox and disabled user customizations/delegation. Claude allows only Read/Glob/Grep, disables session persistence, and uses safe mode with permission prompts and customization sources disabled. Cursor uses ask mode with sandboxing; its config/data/session storage remains isolated outside the project and is removed afterwards. Native sessions have a five-minute timeout, bounded output, process-tree cancellation and cleanup. Project files are inspected as evidence; workers are instructed not to launch apps, run project scripts, install dependencies or modify files.

OpenRouter and LM Studio retain their conversation across app-owned JSON inspection requests, including prior assistant responses and inspection results. Up to twelve inspection rounds plus a final response are permitted. Context is bounded to 96 KiB, retaining the initial instructions and complete recent request/result pairs; individual HTTP steps retain the 90-second timeout. Directory listing, text reading, literal search and executable location remain bounded. Project-local virtual environments are now visible, including configuration and installed-package metadata, and `locate` checks their executable directories before PATH. No documentation or predefined run script is required. Generated/sensitive paths and symlink file reads remain excluded from this app-owned inspection path.

All providers are instructed to choose the complete development experience, trace launchers and existing environments, prefer the interpreter containing the project's dependencies, and avoid unnecessary reinstalls. An exact redundant `cd <this project> &&` prefix is removed from a final result so Run can use an isolated worktree's working directory; directory changes into nested apps remain intact. At most two discoveries may coexist while navigation cleans up the previous worker. Results and cleanup warnings are surfaced; failed scratch cleanup is retained for retry. No persistent background scheduler is created.

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

## Documented command evidence regression — 2026-09-13

Space Game exposed a real failure: its README documented `/Applications/love.app/Contents/MacOS/love .`, but the documentation keyword filter removed that command and the LÖVE context. The provider saw an empty shell block and correctly declined to invent a command. The filter also silently stopped at 180 retained lines.

Documentation now preserves its text, blank lines and command blocks independently of ecosystem keywords. Existing sensitive-setting redaction, long-line filtering, 16 KiB file reads and 96 KiB total snapshot limits remain. Per-file truncation is disclosed. No frontend bundles, runtime permissions, provider routing, persistence or automatic command execution behavior changed.

Three regressions cover the exact LÖVE README excerpt; quoted Windows paths, shell continuations and unfenced commands; and commands after line 180 plus byte-limit enforcement. A live Luna/Low/Fast request using the real Space Game snapshot returned the exact documented command in 4.95 seconds, removed temporary files, and left saved Codex session artifacts unchanged. The smoke supports a read-only project override for reproducing similar reports; fixture cleanup never removes that external project.

The verified command was saved through the installed app's Run UI for Space Game (label: Play Space Game); the UI showed Run: ready. Its installed LÖVE executable reports version 11.5. The installed Mythra binary still needs a subsequent app build to receive the discovery code fix.

macOS `npm run verify` passed: 1,760 unit/integration tests, 166 Chromium tests, 186 Rust tests (two paid smokes ignored), lint/type/configuration/build checks and unchanged performance budgets.

Windows Clippy and all 187 native tests passed on identical source (two paid smokes ignored). The isolated verification copy was removed; the existing checkout was untouched. Only this report changed after verification. No app build was installed or released.

## AI investigation without documentation — 2026-09-13

Preserving documentation was insufficient for the intended feature. Discovery now uses the selected AI to choose which project files to investigate, continuing across app-owned `list`, `read`, `search` and `locate` requests. Source entry points, configuration and dependencies can establish a development command without a README, manifest or predefined run script. The same loop wraps OpenAI, Claude, Cursor, OpenRouter and LM Studio. Cursor receives fresh isolated directories for each pass. Installed-executable checks read filesystem metadata without executing the candidate; on macOS this includes application bundles such as LÖVE.

Focused regressions cover undocumented source discovery, provider response envelopes, real local HTTP exchanges for both API providers, repeated Cursor isolation, arbitrary source/config/script reads, executable validation, traversal/symlink/secret exclusions, byte and round limits, and cancellation between model and filesystem passes. The final frontend result excludes internal inspection requests. There are no frontend changes, new dependencies, polling, automatic command execution or saved conversations.

An explicitly announced live Luna/Low/Fast investigation used an owned fixture containing only `game/main.lua` and `game/conf.lua`, with no README, package manifest or launch script. Luna listed the game directory, requested both source files and executable locations, and returned `/Applications/love.app/Contents/MacOS/love game` in three model calls (16.74 seconds total test time). Saved Codex session artifacts were unchanged; the isolated provider workspace and owned fixture were removed. This is live proof for Luna; the other providers' new inspection flow is covered by adapter/protocol tests, not new paid inference runs.

Final macOS `npm run verify` passed: 1,760 unit/integration tests, 166 Chromium tests and 195 Rust tests, plus configuration, lint, Clippy, type, production-build and performance-budget checks. All frontend bundle sizes and budgets remain unchanged. Windows Clippy and 196 Rust tests passed on an isolated copy with matching SHA-256 hashes for both native source files. The normal suites ignored the two opt-in paid tests. No app build was installed or released; the installed binary still needs a later build to receive this behavior.

## Continuous sessions, environments and automatic saving — 2026-09-13

Cozy Island exposed why the previous implementation still underperformed a normal task. Its `.venv` contained Pygame, but the app-owned inspection filters hid that directory, and the default `python3` could not import Pygame. Its existing launcher already preferred `.venv/bin/python`. The former four-round, fresh-prompt inspection loop also limited the native models' investigation compared with their normal harnesses.

The current behavior above supersedes the metadata-only and four-round designs documented earlier. Three native providers now use a continuous session with real project-reading tools; API providers retain inspection conversation history and can continue beyond four rounds. New preferences use Luna/High/Fast. Successful discovery saves automatically, without launching, and cancelled or stale results cannot save. A visual browser check confirmed the Saved to Run state and the ready Run button.

Two initial live Luna/High/Fast runs against the real Cozy Island project selected its existing virtual-environment Python, with session and scratch cleanup confirmed. Their smoke assertions were initially too strict about equivalent shell spelling. One also redundantly prefixed the absolute project directory; this prompted the worktree-safe normalization and focused tests preserving nested-directory commands. Importing Pygame with the selected interpreter succeeded; default Python could not locate it. The game was not launched and the pre-existing `cozy/game.py` edit was preserved.

Final live Luna/High/Fast verification returned `./.venv/bin/python main.py` in 46.74 seconds and passed the ephemeral-session, temporary-directory cleanup and command-selection assertions. No live Claude, Cursor, OpenRouter or LM Studio request was made during this follow-up; those adapters were checked through code and native protocol tests.

Final validation: macOS `npm run verify` passed 1,761 unit/integration tests, 166 Chromium tests and 198 Rust tests, plus lint/Clippy, type checks, release-configuration checks, production build and performance budgets. The two focused discovery browser tests also passed in WebKit, with the saved/ready UI visually inspected. Windows Clippy and 199 Rust tests passed on matching native source hashes; its isolated verification copy was removed and the existing checkout was preserved. Paid tests remain opt-in.

Compared with the preceding release, startup JavaScript decreased from 754,367 to 753,922 bytes for Safari and 726,427 to 725,955 for Chrome. Total JavaScript decreased from 1,526,066 to 1,525,968 and 1,487,115 to 1,487,002 bytes respectively. Startup CSS was unchanged. Existing performance budgets were not raised. No new dependencies, release, installation, commit or push were made; the installed app needs a subsequent build to receive these changes.

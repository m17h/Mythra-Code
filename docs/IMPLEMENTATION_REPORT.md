# Mythra Code frontier-workflow implementation report

Date: 2026-07-17
Version: 0.1.0

## Delivered

### Concurrent task engine

- Replaced global turn state with a thread-keyed Zustand task store for messages, activities, status, approvals, child agents, diff, token usage, errors, and unread state.
- Routes deltas and lifecycle events by App Server `threadId` and batches streaming text once per animation frame.
- Supports simultaneous background tasks, in-flight `turn/steer`, root/child interruption, per-thread approval queues, status indicators, unread indicators, native completion notifications, thread pins, project/thread search, and a `⌘K` command palette.
- Automatically answers App Server current-time requests and renders typed command, file, permission, agent-question, and MCP-elicitation requests.

### Native reliability and persistence

- Added a native SQLite database in WAL mode for projects, settings, thread bindings, prompt profiles, agents, actions, schedules, and checkpoints, with migration from the former localStorage-only state.
- Added structured lifecycle/approval audit history and diagnostics export. User-input response content is deliberately excluded from the audit.
- Reports the external Codex runtime path, source, version, and compatibility with the tested 0.145+ App Server contract.
- Detects a closed App Server, fails pending requests cleanly, respawns/reinitializes the runtime, and retries the interrupted RPC once.
- Uses method-aware RPC timeouts and bounded terminal scrollback.

### Developer workflow

- Added fuzzy project-file search, directory browsing, text preview, and file attachment.
- Added safe Markdown/GFM messages with copyable code blocks and a virtualized transcript.
- Replaced the terminal transcript with a real xterm PTY that supports stdin, resize, streaming, and termination.
- Added live diff review, per-hunk review marks, file-level Git stage/revert, stage/revert all, commits, CI/PR commands, conversation checkpoints, forks, rollback, and Git worktree creation.
- Added reusable one-click project actions.

### Harness customization

- Preserved the explicit, empty-by-default harness prompt and added reusable prompt profiles.
- Added an explicit project-instruction/`AGENTS.md` toggle; it remains off by default and is visible in request audit.
- Added persistent custom-agent profiles and injects enabled specialists only when a new thread is configured.
- Preserved the opt-in sub-agent gate, direct-child depth, and 1–24 concurrency selection.
- Added skill enable/disable, local MCP server registration, MCP reload/status, and MCP OAuth.
- Added scheduled project prompts that create normal, inspectable threads while Mythra Code is running.

### Models and performance

- Uses the live App Server model catalog to determine availability, with Sol/Terra/Luna presentation, reasoning effort, Ultra, and a Fast/priority service-tier toggle.
- Retains the searchable OpenRouter catalog and reasoning control.
- Paginates thread and model catalogs instead of stopping at 100 records.
- Code-splits Markdown and Studio/xterm code from the initial shell. The release shell chunks are approximately 194 KB and 95 KB before gzip; Markdown and Studio load on demand.

## Verification

- `npm run verify`: passed.
- TypeScript compile: passed.
- Rust `cargo check`: passed.
- Vitest: 10/10 tests passed across task routing, approval payloads, model controls, and durable storage migration.
- Production Vite build: passed with no initial-chunk warning.
- `npm audit --omit=dev`: 0 vulnerabilities.
- Tauri release build: passed.
- macOS bundle strict signature verification: passed after applying a complete local ad-hoc resource seal.
- Native smoke launch: passed; the release process remained running and initialized `openkiwi.sqlite3` plus the isolated Codex home.

## Artifacts

- `src-tauri/target/release/bundle/macos/Mythra Code.app` — 17 MB, Apple silicon.
- `src-tauri/target/release/bundle/dmg/Mythra Code_0.1.0_aarch64.dmg` — 9.1 MB.

## Distribution boundary

The local app is ad-hoc signed and valid for testing. Public macOS distribution still requires the repository owner’s Apple Developer ID certificate and notarization credentials. Mythra Code intentionally does not bundle Codex; users can install the Codex CLI or ChatGPT for macOS, and the setup UI detects either runtime.

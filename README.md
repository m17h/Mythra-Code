# OpenKiwi

> [!IMPORTANT]
> This is the original **macOS version** of OpenKiwi. The Windows version is developed and released separately in [m17h/OpenKiwi-Windows](https://github.com/m17h/OpenKiwi-Windows).

OpenKiwi is a fast, local-first desktop coding harness with a user-owned instruction prompt. It supports OpenAI through an official ChatGPT subscription sign-in flow, Claude through the locally installed Claude Code CLI, Cursor subscription models (including Grok when entitled) through Cursor Agent, and OpenRouter through a user-supplied API key.

**Platform support:** this repository's packaged releases target **macOS on Apple silicon** only, and its update feed publishes only a `darwin-aarch64` bundle. Windows downloads, source, and release instructions live in [OpenKiwi-Windows](https://github.com/m17h/OpenKiwi-Windows). Intel Macs and Linux are not supported.

This repository contains a runnable desktop coding environment: normal chats, folder-bound project threads, concurrent background tasks, steering and interruption, three permission modes, typed approvals and user-input requests, an explicit empty-by-default instruction prompt, opt-in harness-level sub-agents, prompt/agent profiles, multi-step agent workflows, animated model controls, and an integrated workspace studio.

Download it here: https://www.morgangermani.com/projects/openkiwi

## Why this architecture

- **Tauri 2** keeps the native shell small and puts filesystem/process access behind Rust.
- **React + TypeScript** makes a polished, responsive thread UI straightforward.
- **Codex App Server** is the official open-source protocol for rich Codex clients. It provides ChatGPT sign-in, thread persistence, streaming, approvals, sandboxing, and model-provider support.
- **OpenRouter** is configured as a Responses-compatible model provider, so both providers use one event and tool model.

## Run it

Requirements:

- macOS on Apple silicon (the supported release platform)
- Node.js 20.19 or newer
- Rust stable
- A recent Codex runtime (the Codex CLI or ChatGPT for macOS), Claude Code CLI, and/or Cursor Agent — each provider needs only its own runtime

```bash
npm install
npm run desktop
```

Useful checks:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

`desktop:build` is the contributor/local build and deliberately skips update artifacts. Published releases use the signed release workflow described below.

## Provider setup

### OpenAI subscription

Open **Settings → OpenAI → Sign in**. OpenKiwi starts the official Codex browser login through App Server. The resulting login is stored inside OpenKiwi's isolated Codex home rather than modifying the user's normal `~/.codex` state.

OpenKiwi blocks OpenAI turns until that sign-in completes. Attempting to send while signed out preserves the draft and opens a dedicated authentication dialog rather than issuing an unauthorized request.

OpenKiwi checks for the Codex CLI first and also recognizes the runtime included with ChatGPT for macOS. If neither is available, it opens a guided setup dialog with the official installation guide and a retry action. Only one of the two installations is needed.

### Claude

OpenKiwi drives the locally installed [Claude Code CLI](https://claude.com/claude-code) directly. Open **Settings → Models & accounts**, pick Claude, and sign in through the CLI's own browser flow — OpenKiwi never sees or stores Anthropic credentials. To keep usage on the signed-in subscription, OpenKiwi launches each turn with API-key/Bedrock/Vertex environment overrides scrubbed and warns when such overrides are present.

Each Claude thread runs one CLI process per turn with `--session-id`/`--resume`, so conversations persist and resume across app restarts. OpenKiwi's permission modes map to the CLI's permission system: *Ask to act* routes every tool request through OpenKiwi's approval UI over stdio; *Read only* disables editing and shell tools; *Full access* passes `bypassPermissions`. The CLI runs with `--setting-sources ""`, so a user's personal Claude Code settings, hooks, and allowlists do not silently apply inside OpenKiwi, and the project-instructions toggle currently governs Codex/OpenRouter `AGENTS.md` loading only.

Selected OpenKiwi skills and custom sub-agents are bridged to Claude through a generated local plugin directory. Model and reasoning-effort choices are sent as real CLI flags per turn.

### Cursor

Open **Settings → Models & accounts**, pick Cursor, and sign in with Cursor Agent. OpenKiwi talks to the official `cursor-agent acp` interface, fetches the live model catalog attached to that Cursor account, and exposes Grok 4.5 whenever Cursor advertises it for the subscription. Cursor threads persist locally with their ACP session ID, stream messages and tool activity into the normal timeline, and use OpenKiwi's permission and structured-question UI. The app uses Cursor's official 2D cube mark from its public brand kit.

### OpenRouter

Open **Settings → OpenRouter** and save an API key. The composer then exposes a searchable picker backed by OpenRouter's live tool-capable model catalog, plus direct `provider/model` entry for new or private slugs. OpenKiwi stores the key in the operating system credential store and exposes it only to the local App Server child process.

OpenRouter's Responses API is currently beta, so compatibility can change upstream.

## Prompt transparency

For each new thread, OpenKiwi:

1. Sends the visible Settings prompt as App Server's explicit `baseInstructions` override. The default is the empty string.
2. Sends an empty app developer-instruction override.
3. Disables `AGENTS.md`/project-document instruction loading by default. Users can explicitly enable it in Settings; the request audit shows its state.
4. Renders Markdown through a safe React renderer with no raw-HTML plugin. Code blocks are copyable but never executable by the renderer.

This means **OpenKiwi adds no secret instruction text**. It does not mean the entire inference stack is literally prompt-free: model providers can enforce platform policies, and a coding engine must still provide tool schemas and runtime metadata. A future wire-audit view should make those non-instruction request fields inspectable too.

The relevant OpenAI Codex source path treats `baseInstructions` as the highest-priority override and sends the empty value through to the Responses request. This behavior should be covered by an integration test whenever the bundled/pinned runtime work lands.

## Permissions

| OpenKiwi mode | Sandbox | Approval policy | Intended use |
| --- | --- | --- | --- |
| Read only | `read-only` | `never` | Inspect and explain without edits |
| Ask to act | `workspace-write` | `on-request` | Normal coding with approval for elevated actions |
| Full access | `danger-full-access` | `never` | Trusted projects where speed is preferred over isolation |

Approval requests are delivered as App Server server-initiated RPC calls and must be answered in OpenKiwi's modal before work continues.

## Chats, projects, and threads

The sidebar separates the two working modes explicitly:

- **Chats** creates normal conversations that are not attached to a user project folder. App Server still receives a stable private working directory inside OpenKiwi's application data so those conversations can persist safely, but it is never presented as a project and project workspace tools stay disabled.
- **Projects** contains folders chosen by the user. Every project thread is bound to the folder where it was created. OpenKiwi filters thread history by that exact working directory, records a local binding for new and forked threads, rejects cross-project resumes, and reapplies the project `cwd`, workspace root, and selected sandbox on every turn.

The new-thread button, thread-list heading, top bar, empty state, and composer all show the current scope, making it clear whether the next turn is a normal chat or will work inside a selected folder.

Before the first message in a Git project, the user can choose **Shared project** or **Isolated worktree**. Isolation gives the thread its own app-managed linked worktree and private `openkiwi/*` branch while keeping it grouped under the original project. Every model turn, terminal command, file search, diff, Git action, and checkpoint for that thread runs against the isolated path; the shared folder is not added as a writable model root.

The Studio exposes the worktree's status and actions to apply its complete non-ignored delta into the shared folder, merge a clean committed branch, reveal it in Finder, recreate a missing worktree from its branch, or clean it up. Apply first creates a shared-folder safety checkpoint and preserves the user's branch, `HEAD`, staging index, and ignored files. Cleanup identifies untracked and ignored worktree-only files before requiring destructive confirmation. OpenKiwi also warns before two active shared-folder threads are allowed to edit the same project concurrently.

## Sub-agents

Sub-agents are disabled by default. For a new thread, use the composer toggle or **Settings → Sub-agents** and choose a maximum concurrency from 1–24. When enabled, OpenKiwi exposes the App Server's native collaboration tools and lets the model decide whether delegation is useful.

- The selected maximum counts concurrently active child agents, not the root agent.
- Children inherit the root thread's sandbox and approval policy.
- Nesting is fixed at depth one, so children cannot spawn grandchildren.
- The setting is captured at thread creation and cannot silently change an existing thread.
- Spawn, interaction, wait, close, and interruption activity appears in the thread timeline.

OpenKiwi does not add a hidden instruction telling the model to delegate. The toggle controls tool availability at the harness layer.

## Agent workflows

**Settings → Workflows** can build reusable, project-bound recipes from ordered agent prompts and deterministic shell commands.

- Workflows run manually, on a recurring interval, or once when OpenKiwi starts.
- Every run creates a named project thread, so prompts, model output, commands, and results remain inspectable.
- Agent steps run sequentially in that thread and may expose selected local skills by their visible `$name`.
- The workflow captures its provider, model, reasoning, permission, prompt, and sub-agent settings when saved. The editor can refresh that snapshot from the current composer settings.
- Prompts and commands support saved or run-time variables such as `${branch}`, plus built-ins including `${projectPath}`, `${date}`, `${previousStepOutput}`, and `${previousExitCode}`.
- Each step can be conditional, retry up to five times with a configurable delay, stop the recipe on failure, or explicitly continue.
- Active agent turns and shell processes can be stopped at the workflow level, including while a turn is still starting or waiting to retry. Runs abandoned by an app exit are recovered as interrupted rather than remaining permanently active.
- Interval failures use bounded exponential backoff and never retry sooner than the configured interval. A manual run does not move the recurring schedule.
- Run history records step-level attempts, output, duration, completion, failure, and the resulting thread in a dedicated inspector.
- Manual workflows containing shell commands show the interpolated command preview before execution. Background runs never request interactive approval and still obey the saved sandbox.
- Enabled workflows are available from Settings, the command palette, and the active project’s Tools panel.

Existing one-click project actions and single-prompt schedules remain available for lightweight use. A saved schedule can be converted without removing the original; the converted workflow starts disabled so both versions cannot run at the same time unexpectedly.

## Model and reasoning control

When OpenAI subscription auth is selected, the composer exposes the current GPT-5.6 family as a branded animated control:

- **Sol** (`gpt-5.6-sol`) uses orange and targets detail, judgment, and polish.
- **Terra** (`gpt-5.6-terra`) uses light green and is the everyday workhorse.
- **Luna** (`gpt-5.6-luna`) uses light blue and favors clear, fast, repeatable work.

When OpenRouter is selected, the composer uses a compact searchable catalog with provider, context-window, and reasoning-capability metadata. A separate five-level reasoning slider is persisted and forwarded with thread and turn requests when the selected route supports reasoning.
- The reasoning rail maps Light, Medium, High, Extra High, and Max to the runtime's supported reasoning-effort values.
- The **Ultra** lever maps to Ultra reasoning, explicitly enables sub-agent access, and switches the control into an animated purple powered-up state. Account and model eligibility still come from App Server's model catalog.

Model and effort are sent as real thread/turn overrides. They are not presentation-only aliases.

## Workspace Studio

The right-side Studio contains nine integrated surfaces:

1. **Files** — fuzzy project search, text previews, and one-click context attachment.
2. **Review** — live turn/Git diff, per-hunk review marks, whole-diff approval state, and an App Server review turn.
3. **Agents** — observed child threads, current status, child-thread inspection, and interruption.
4. **Terminal** — a PTY-backed xterm surface with streamed bytes, stdin, resize, cancellation, and the selected permission sandbox.
5. **Checkpoints** — automatic before/after source snapshots for every Git-project run, complete-worktree restore and reapply, reversible acceptance, pre-restore safety copies, run diffs, conversation forks and rollback, plus isolated-thread worktree review, apply, merge, recovery, and cleanup.
6. **Context** — file mentions and native local-image inputs attached to the next turn.
7. **Usage** — cumulative per-thread input/output tokens, API-equivalent inference value, account rate limits, and a visible request-field audit.
8. **Tools** — project actions, skill enable/disable, MCP status/OAuth, and permission-boundary guidance.
9. **Git** — GitHub repository attachment/creation, branch sync state, status, diff, file-level stage/revert, stage all, tracked-file revert confirmation, commits, fetch/pull/push, PR comments, CI checks, and draft PR creation.

Checkpoint snapshots are stored as hidden local Git refs without moving the project's branch, HEAD, commits, or staging index. They include tracked and untracked non-ignored source files; ignored files and build output are left alone. Restoring always requires a fresh safety snapshot of the current source state, and conversation rollback remains a separate chat-only action.

## Privacy and telemetry

OpenKiwi contains **no telemetry, analytics, or crash reporting**. Network connections are limited to the selected model provider, update and model-pricing catalog checks against the OpenKiwi GitHub repository, and user-initiated GitHub account or repository actions through the official GitHub CLI. OpenKiwi never injects GitHub credentials into model prompts or project files. Agents with command access can still invoke credential-aware tools such as `git` or `gh`, just as they could in a terminal. Prompts, transcripts, settings, local usage totals, and audit records stay in local storage (SQLite in the app's data directory). Diagnostics leave the machine only when a user explicitly exports them.

The small [`model-pricing.json`](model-pricing.json) catalog is fetched once on app launch and validated before it is cached. The request is an unauthenticated `GET` that carries no request body, account, or device identifier, and the last validated snapshot keeps working offline. Updating that file on `main` refreshes future API-equivalent usage estimates without requiring an app release. OpenKiwi accumulates estimated cost at the price active when each token increment is recorded, so a later price change never rewrites historical usage.

## Security boundaries

- The webview can call only a small allowlist of App Server RPC methods.
- The packaged app has a restrictive Content Security Policy and no external font dependency.
- OpenRouter credentials use the OS keychain/keyring.
- GitHub credentials remain in the official GitHub CLI credential store.
- ChatGPT credentials use Codex's isolated credential store.
- Model content is not rendered as HTML.
- App Server uses stdio and is never exposed as a network listener.
- Projects, settings, profiles, schedules, and bindings are mirrored to native SQLite in WAL mode. Existing localStorage data is migrated on first launch.
- Approval and lifecycle audit records intentionally omit user-input answers so secret form fields are not persisted.
- App Server requests have bounded, method-aware timeouts; a dead child is detected, restarted, and the interrupted RPC is retried once.

## Performance and task control

- Each thread owns independent messages, activities, approvals, child agents, diff, usage, unread state, and lifecycle status.
- Streaming deltas are batched once per animation frame and routed by `threadId`, so background tasks cannot overwrite the active task.
- Long transcripts are virtualized and Markdown/terminal code is split into lazy chunks to keep startup and scrolling responsive.
- While a turn is running, Send adds a durable FIFO follow-up by default. A separate action can steer a message into the active turn, and Stop interrupts it without disturbing other threads.
- Completed background work can raise a native notification. The sidebar shows running and unread state.
- `⌘K` opens a command palette across commands, projects, and current-scope threads.
- Scheduled project prompts run while OpenKiwi is open and create normal, inspectable App Server threads.

## In-app updates and releases

OpenKiwi checks the public [`m17h/OpenKiwi` GitHub Releases](https://github.com/m17h/OpenKiwi/releases) channel shortly after launch. **Settings → Updates** also provides a manual check. When a newer signed version exists, the user can review its notes, download it with progress feedback, install it, and restart into the new version without leaving the app.

Both `latest.json` and the platform update bundle are hosted as GitHub Release assets. The app embeds only the updater public key and rejects artifacts that do not carry a valid matching signature. The private updater key is not part of this repository.

Publisher workflow:

```bash
# Keep all version declarations synchronized (patch, minor, major, or exact version)
npm run version:bump -- patch

# With Apple notarization variables available, build and stage the latest assets
npm run release:build

# Publish release-assets/latest as the public GitHub Release
npm run release:publish
```

`release-assets/` is intentionally ignored by Git. It holds only the current local staging payload and optional `release-notes.md`. On Morgan's release Mac, the encrypted updater key lives at `~/.tauri/openkiwi-updater.key` and its password lives in macOS Keychain. Back up that key securely: installed copies cannot trust future updates if it is lost.

## Verification and release notes

`npm run verify` runs ESLint, strict Clippy, TypeScript and Rust checks, unit/integration component tests, and the production web build. `npm run desktop:build` produces only the local `.app` without updater artifacts; it never invokes Tauri's DMG bundler. `npm run release:build` requires publisher-owned signing/notarization credentials, builds the signed update payload, and creates the DMG exclusively through the standalone `create-dmg` command. OpenKiwi does not embed those credentials or bundle Codex.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component and state model.

## Acknowledgements

OpenKiwi did **not** use or copy any source code from [T3Code](https://github.com/pingdotgg/t3code). OpenKiwi's inbox-style threads were designed and implemented independently for its own React, Zustand, and Tauri architecture. We did, however, take product-design inspiration from T3Code's inbox-oriented approach, and we gratefully credit [T3 Tools](https://t3.gg/) for helping demonstrate how natural that experience can feel.

## Upstream references

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Codex open-source repository](https://github.com/openai/codex)
- [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication)
- [OpenRouter Responses API](https://openrouter.ai/docs/api/reference/responses/overview)

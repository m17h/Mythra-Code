# OpenKiwi architecture

## Component map

```text
React webview
  ├─ projects + UI preferences (SQLite-backed cache)
  ├─ thread-scoped Zustand task state
  ├─ virtualized Markdown/event rendering
  ├─ animated model/reasoning power rail
  ├─ signed GitHub release checks + update progress
  └─ Studio: review, agents, terminal, checkpoints, context, usage, tools, and Git
          │ Tauri IPC (allowlisted commands)
          ▼
Rust desktop host
  ├─ OS credential store (OpenRouter key + optional LM Studio token)
  ├─ isolated OpenKiwi app-data/Codex home
  ├─ SQLite/WAL state + audit history
  ├─ JSON-RPC request correlation + timeouts
  ├─ Tauri updater signature verification + installation
  └─ health-checked child-process recovery
          │ JSONL over stdio
          ▼
Codex App Server
  ├─ ChatGPT browser authentication
  ├─ persisted threads and turns
  ├─ sandbox + approval enforcement
  ├─ opt-in direct child-agent orchestration
  ├─ coding tool loop
  └─ OpenAI, OpenRouter, or LM Studio Responses transport
```

Cursor subscription threads bypass App Server and use Cursor Agent's ACP stdio transport.

The control plane and execution plane remain separate. The React view never launches commands directly; it asks the Rust host, which talks to App Server. App Server owns the OS sandbox and pauses on approval requests.

## State ownership

| State | Owner | Location |
| --- | --- | --- |
| Project list | UI/native host | SQLite, with localStorage as immediate cache |
| UI settings, profiles, actions, schedules, and visible prompt | UI/native host | SQLite, with localStorage as immediate cache |
| OpenRouter API key | Native host | OS credential store |
| OpenRouter model catalog | Native host | Live tool-capable `/api/v1/models` response |
| LM Studio API token (optional) | Native host | OS credential store |
| LM Studio model catalog | Native host | Live `/api/v1/models`, with `/v1/models` compatibility fallback |
| ChatGPT login | App Server | OpenKiwi-specific `CODEX_HOME` credential storage |
| Cursor login and model catalog | Cursor Agent | Cursor's browser login and `cursor/list_available_models` ACP extension |
| Threads and rollout history | App Server | OpenKiwi-specific `CODEX_HOME` |
| Thread project binding and isolated execution path | UI/native host | SQLite-backed cache; app-managed linked Git worktree |
| Active JSON-RPC requests | Native host | Memory only |
| Active approvals | Thread task store + App Server | Per-thread queue until answered |
| Checkpoint metadata and thread bindings | UI/native host | SQLite-backed cache |
| Checkpoint source snapshots | Native host + Git | Hidden local `refs/openkiwi/checkpoints/*` refs in each project repository |
| Approval/lifecycle audit | Native host | SQLite; secret answers excluded |
| Terminal processes | App Server | Connection-scoped memory |
| Model catalog, usage, MCP and skill inventory | App Server | Refreshed runtime state |

OpenKiwi's private Codex home is under the platform Tauri app-data directory. The native host creates a controlled `config.toml` on first startup and preserves subsequent user-managed skills/MCP configuration. Provider and thread overrides remain explicit.

## Thread creation contract

A new thread is created with:

- the selected shared project or isolated linked worktree as `cwd`;
- the selected model/provider;
- the selected reasoning effort, including Ultra when eligible;
- the selected sandbox and approval policy;
- `baseInstructions` equal to the Settings prompt, including an explicit empty string;
- an empty `developerInstructions` value;
- project instruction loading disabled by default, or explicitly enabled by the user;
- sub-agent tools explicitly enabled or disabled, with a user-selected child cap and depth fixed at one.

These fields are set only when a thread is created. Existing threads retain their original prompt and provider context when resumed, which avoids silently rewriting conversation behavior.

## Isolated worktree contract

Project identity and execution location are deliberately separate. `kiwi.threadProjects` keeps a thread grouped under the user-selected source project. `kiwi.threadWorktrees` optionally supplies that thread's execution path, branch, base commit, shared Git directory, lifecycle status, and last applied tree. Model turns, resumptions, terminal commands, file search, diffs, checkpoints, and Git tools resolve through the execution path. A missing or removed worktree never silently falls back to the source folder; the user must recreate it or explicitly continue in shared mode.

The native host creates linked worktrees below OpenKiwi's application-data directory. The model sandbox receives the worktree as its workspace plus the repository's shared Git common directory as an additional writable root, which permits normal Git metadata updates without making the user's source worktree writable.

Applying isolated work is a source-state operation, not a commit or merge:

1. refuse while either folder has an active model or command;
2. capture a full safety checkpoint of the shared project;
3. capture the isolated non-ignored source tree through a temporary Git index;
4. calculate the delta since the isolated thread's last applied tree, pinned under `refs/openkiwi/worktrees/<thread>/applied` so Git maintenance cannot discard it;
5. apply that delta to the safety tree in another temporary index;
6. verify the source still matches the safety checkpoint and materialize the result without touching the user's real index, `HEAD`, branch, commits, or ignored files.

Merging is available only when both worktrees are clean and isolated work has been committed; conflicts automatically abort the merge. Cleanup inspects modified, untracked, ahead, and ignored worktree-only state and requires an explicit destructive confirmation when any could be lost, then removes the thread's checkpoint and applied-baseline refs. Missing app-managed worktrees can be recreated from their surviving branch after pruning stale Git registrations; the UI warns that a deleted folder's uncommitted files cannot be recovered and that a later Apply may reconcile previously copied work. Forking an isolated conversation is intentionally blocked until independent worktree cloning semantics are available.

## Sub-agent contract

OpenKiwi starts its private App Server with multi-agent support explicitly disabled, overriding the upstream default. A new thread can opt in through its config override:

- `features.multi_agent` mirrors the visible UI toggle;
- `agents.max_threads` is the exact concurrent child-agent limit selected by the user;
- `agents.max_depth = 1` permits only direct children;
- each child inherits the parent thread's sandbox and approval policy;
- no app-authored delegation instruction is added to the visible base or developer prompts.

The webview renders collaboration tool calls and child activity as structured timeline events. The Agent Studio can read child histories and interrupt individual children; the underlying App Server remains the owner of lifecycle and concurrency enforcement.

## Studio protocol map

| Surface | App Server/runtime contract |
| --- | --- |
| Review | `turn/diff/updated`, `gitDiffToRemote`, `review/start` |
| Agents | collaboration thread items, `thread/read`, `turn/interrupt` |
| Files | `fuzzyFileSearch`, `fs/readDirectory`, `fs/readFile` |
| Terminal | PTY `command/exec`, streamed base64 output, `command/exec/write`, `command/exec/resize`, `command/exec/terminate` |
| Checkpoints | Native temporary-index snapshots and guarded complete-worktree restore; `thread/fork`, `thread/rollback`; isolated worktree review/apply/merge/recovery/cleanup |
| Context | `localImage` and explicit file mention inputs on `turn/start` |
| Usage | `thread/tokenUsage/updated`, `account/rateLimits/read` |
| Tools | `skills/list`, `skills/config/write`, MCP status/OAuth/reload, project actions |
| Git | typed `git`/`gh` argv through `command/exec`; destructive tracked-file restore requires UI confirmation |

Standalone terminal and Git commands receive an explicit sandbox policy derived from the same Read only / Ask to act / Full access setting used by agent threads.

## Filesystem checkpoint contract

For a project whose selected folder is the root of a Git repository, OpenKiwi captures a hidden snapshot immediately before a model turn and closes it with a second snapshot when the turn ends. Snapshot creation uses a temporary Git index, so the user's branch, `HEAD`, staged changes, and public commit history are not modified. Tracked files and untracked non-ignored files are represented; ignored paths remain outside checkpoint management.

Restoring either side of a checkpoint:

1. refuses to run while any thread is editing the same project;
2. creates a complete current-state safety checkpoint;
3. verifies natively that the worktree still matches that safety snapshot;
4. replaces the complete non-ignored source worktree with the selected snapshot;
5. preserves later snapshots as alternate restore points and leaves Git commits, `HEAD`, the real index, and ignored files unchanged.

The UI's Accepted flag is metadata only and can always be reversed. Conversation rollback remains independent and never claims to change files.

## Provider contract

### OpenAI

The native host starts App Server with a OpenKiwi-specific `CODEX_HOME`. The webview begins `account/login/start` with `type: "chatgpt"`, then opens the returned authorization URL. App Server owns the callback, token refresh, account state, and subscription rate-limit handling.

### OpenRouter

The native host defines a custom `openrouter` provider with:

```toml
[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

The key comes from the OS credential store and is added only to the App Server child environment. Saving or replacing the key restarts App Server so the child receives the new credential. At runtime the host also injects a loopback proxy as the provider `base_url`; the proxy holds the real bearer key, whitelists request headers, and sanitizes tool JSON schemas that OpenRouter destinations reject.

### LM Studio

LM Studio is a custom App Server provider using `wire_api = "responses"` and the user-configured server URL (default `http://127.0.0.1:1234/v1`). It is registered in the generated per-thread config under the private id `lmstudio_openkiwi`, never `lmstudio`: Codex reserves `lmstudio` (with `openai`, `ollama`, and `amazon-bedrock`) as a built-in provider and fails the entire config load if a `model_providers` entry shadows one. `lmstudio` remains the app-facing provider identity in settings, thread records, and the sub-agent roster; `codexModelProviderId` is the single translation point. The native host queries LM Studio's richer `/api/v1/models` catalog first so the UI can exclude embedding models and retain context-window, reasoning, and tool-use metadata; older servers fall back to the OpenAI-compatible `/v1/models` endpoint.

An optional API token is stored in the OS credential store and passed only to the local App Server child as `LMSTUDIO_API_KEY`; unauthenticated localhost servers receive LM Studio's conventional placeholder token. Connected-app tools are disabled for the provider, while OpenKiwi's shell, files, permissions, MCP servers, workflows, schedules, and managed sub-agent bridge remain available. The catalog's reported context window is injected into root, resumed, forked, automated, and sub-agent threads.

### Cursor

Cursor threads use the locally installed official Cursor Agent CLI in `acp` mode. The native host initializes and authenticates the ACP connection, obtains the account's live model catalog through `cursor/list_available_models`, creates or loads a Cursor session, applies model selection through the session's advertised model config option, and streams `session/update` notifications into OpenKiwi. Permission and question requests remain pending over JSON-RPC until the user answers in OpenKiwi. Session IDs and mirrored transcripts are stored locally so threads resume across app restarts; Cursor retains control of subscription authentication, entitlements, usage, and limits.

### Claude

Claude threads bypass App Server entirely. The native host resolves the locally installed Claude Code CLI (`resolve_claude_binary`: PATH, well-known install dirs, login-shell fallback, `OPENKIWI_CLAUDE_PATH` override) and spawns **one CLI process per turn** in `-p --input-format stream-json --output-format stream-json` mode:

- Thread identity is an app-minted UUID passed as `--session-id` on the first turn and `--resume` on later turns, so conversations persist in Claude Code's own session store and survive app restarts. Transcripts are additionally mirrored into OpenKiwi's SQLite state for instant thread switching.
- Permission modes map to CLI flags: manual approvals use `--permission-prompt-tool stdio` and surface as `control_request`/`control_response` exchanges routed through the same approval UI as Codex; read-only adds `--disallowedTools`; full access passes `bypassPermissions`. Unknown control requests are answered with an error response so a newer CLI cannot stall a turn.
- `--setting-sources ""` keeps the user's personal Claude Code settings, hooks, and allowlists out of OpenKiwi sessions. Subscription-only auth is enforced by scrubbing `ANTHROPIC_*`/Bedrock/Vertex credential overrides from the child environment.
- Events are emitted to the webview as `claude-event` tagged with `threadId` and `turnId`; `src/lib/claudeEvents.ts` normalizes the CLI's stream (`stream_event` deltas, `assistant`/`user` messages, `result`) into the same task-store shapes the Codex router produces. Interrupts are cooperative (a `control_request` on stdin) and escalate to a process kill if the CLI does not unwind within a grace period.
- Selected skills and custom sub-agents are bridged through a generated plugin directory passed via `--plugin-dir`/`--agents`.

## Protocol handling

The Rust host assigns numeric request IDs and stores one-shot response channels in a pending map. A stdout task parses JSONL:

- messages with `id` plus `result`/`error` resolve a pending client request;
- notifications and server-initiated requests are emitted to the webview;
- stderr is emitted only as diagnostic status text;
- connection loss fails all pending requests.

The webview handles streamed assistant deltas, completed items, command/file/sub-agent activities, live diffs, terminal bytes, token usage, account updates, turn lifecycle, command/file/permission approvals, structured agent questions, and MCP elicitation forms. Current-time requests are answered automatically. Every event is routed by thread ID.

## Deliberate constraints

- No remote App Server listener.
- Shell execution is available only through the allowlisted App Server terminal RPC and always carries the selected sandbox policy.
- No raw HTML/Markdown execution from model content.
- No automatic import of global Codex config, auth, skills, or project instructions.
- No silent provider fallback between OpenAI and OpenRouter.

## Runtime and release posture

- OpenKiwi intentionally does not bundle Codex. It detects a CLI installation or the runtime inside ChatGPT for macOS, reports its version, and warns below the tested 0.145 App Server contract.
- A closed/broken App Server fails pending calls, is respawned, reinitialized, and retries the affected RPC once.
- Web assets are code-split so xterm and Markdown parsing do not block the initial shell.
- The updater reads `latest.json` from the public GitHub Releases channel, compares semantic versions, downloads a platform bundle, verifies its mandatory updater signature, installs it, and relaunches the app.
- Local contributor builds disable updater artifacts through `tauri.local.conf.json`; publisher builds enable them in the primary config.
- Version bumps update npm, Tauri, Cargo, and both lockfiles together through `npm run version:bump`.
- Platform signing, notarization, the encrypted updater private key, and staged release assets are publisher responsibilities and are not committed to this repository.

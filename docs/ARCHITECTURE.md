# OpenKiwi architecture

## Component map

```text
React webview
  ├─ projects + UI preferences (SQLite-backed cache)
  ├─ thread-scoped Zustand task state
  ├─ virtualized Markdown/event rendering
  ├─ animated model/reasoning power rail
  ├─ signed GitHub release checks + update progress
  └─ Studio: review, agents, terminal, history, context, usage, tools, and Git
          │ Tauri IPC (allowlisted commands)
          ▼
Rust desktop host
  ├─ OS credential store (OpenRouter key)
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
  └─ OpenAI or OpenRouter Responses transport
```

The control plane and execution plane remain separate. The React view never launches commands directly; it asks the Rust host, which talks to App Server. App Server owns the OS sandbox and pauses on approval requests.

## State ownership

| State | Owner | Location |
| --- | --- | --- |
| Project list | UI/native host | SQLite, with localStorage as immediate cache |
| UI settings, profiles, actions, schedules, and visible prompt | UI/native host | SQLite, with localStorage as immediate cache |
| OpenRouter API key | Native host | OS credential store |
| OpenRouter model catalog | Native host | Live tool-capable `/api/v1/models` response |
| ChatGPT login | App Server | OpenKiwi-specific `CODEX_HOME` credential storage |
| Threads and rollout history | App Server | OpenKiwi-specific `CODEX_HOME` |
| Active JSON-RPC requests | Native host | Memory only |
| Active approvals | Thread task store + App Server | Per-thread queue until answered |
| Checkpoint labels and thread bindings | UI/native host | SQLite-backed cache |
| Approval/lifecycle audit | Native host | SQLite; secret answers excluded |
| Terminal processes | App Server | Connection-scoped memory |
| Model catalog, usage, MCP and skill inventory | App Server | Refreshed runtime state |

OpenKiwi's private Codex home is under the platform Tauri app-data directory. The native host creates a controlled `config.toml` on first startup and preserves subsequent user-managed skills/MCP configuration. Provider and thread overrides remain explicit.

## Thread creation contract

A new thread is created with:

- the selected project as `cwd`;
- the selected model/provider;
- the selected reasoning effort, including Ultra when eligible;
- the selected sandbox and approval policy;
- `baseInstructions` equal to the Settings prompt, including an explicit empty string;
- an empty `developerInstructions` value;
- project instruction loading disabled by default, or explicitly enabled by the user;
- sub-agent tools explicitly enabled or disabled, with a user-selected child cap and depth fixed at one.

These fields are set only when a thread is created. Existing threads retain their original prompt and provider context when resumed, which avoids silently rewriting conversation behavior.

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
| History | `thread/fork`, `thread/rollback`; Git worktrees through sandboxed command execution |
| Context | `localImage` and explicit file mention inputs on `turn/start` |
| Usage | `thread/tokenUsage/updated`, `account/rateLimits/read` |
| Tools | `skills/list`, `skills/config/write`, MCP status/OAuth/reload, project actions |
| Git | typed `git`/`gh` argv through `command/exec`; destructive tracked-file restore requires UI confirmation |

Standalone terminal and Git commands receive an explicit sandbox policy derived from the same Read only / Ask to act / Full access setting used by agent threads.

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

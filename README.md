# Mythra Code

A local-first desktop app for working with coding agents across OpenAI, Claude, Cursor, OpenRouter, and LM Studio. Bring your own accounts, choose your models, and keep conversations, project tools, and Git work in one place.

**[Download the latest release](https://github.com/m17h/Mythra-Code/releases/latest)** · **[Website](https://mythra.work)** · **[Report an issue](https://github.com/m17h/Mythra-Code/issues)**

Packaged releases support **Apple silicon Macs** and **Windows x64**. Intel Macs and Linux are not currently supported. This is the canonical source repository for both platforms; each release includes both platform builds.

## Get started

1. Install the macOS DMG or Windows installer from the latest release. On macOS, copy the app into Applications. The Windows installer is not Authenticode-signed, so Windows may show an **Unknown publisher** warning; download only from the official release page.
2. Open **Settings → Models & accounts** and connect a provider. Install that provider's required runtime if prompted; the table below explains which one you need.
3. Add a project folder to work on code, or start a normal chat without choosing a project. GitHub is optional.
4. Choose a model and a permission mode below the composer, then describe what you want to do.

The onboarding introduces projects, permissions, sub-agents, and appearance settings. You can reopen it from **Settings → Runtime**. Existing installations can check for app updates in **Settings → Updates**.

## Providers and accounts

Configure each provider in **Settings → Models & accounts**. You only need to set up the providers you want to use.

| Provider | What you need | How Mythra Code connects |
| --- | --- | --- |
| **OpenAI** | A supported Codex runtime and either a ChatGPT account with Codex access or an OpenAI API key | Official Codex browser/API-key sign-in through App Server, using an isolated Codex home separate from your normal `~/.codex` state. |
| **Claude** | Claude Code CLI and either an eligible subscription login or an Anthropic API key | The local Claude Code headless runtime. Subscription turns ignore API-key/alternate-cloud environment overrides; API turns receive only the key explicitly saved for Claude. |
| **Cursor** | Cursor Agent and an eligible signed-in account | Cursor's ACP interface and the model catalog available to your account. |
| **OpenRouter** | An OpenRouter API key **and the Codex runtime** | OpenRouter's Responses-compatible endpoint through Codex App Server. Model and tool compatibility depend on the route. |
| **LM Studio** | A running LM Studio server **and the Codex runtime** | A Responses-compatible local model through Codex App Server. The default server address is `http://127.0.0.1:1234/v1`; a trusted remote server and optional token are also supported. |

Mythra Code does not bundle Codex. It looks for the Codex CLI and can also recognize the runtime included with ChatGPT for macOS. Claude and Cursor use their own runtimes for ordinary chats and agent-only workflows. Explicit shell-command workflow steps use Codex.

Model pickers use the available provider catalogs rather than a fixed generation of models. Sol, Luna, and Astra have distinct artwork and animated controls; supported reasoning levels and Fast/priority availability depend on the selected model and account. Selecting a model or effort changes the actual request, not just the label.

Subscriptions and API charges remain with the selected provider. Sub-agents and optional background features use the account configured for them, which can differ from the main conversation's account.

### Subscription or API key

For OpenAI and Claude, choose **Subscription** or **API key** first in Models & accounts. Only that billing method is allowed: missing credentials, exhausted limits/credits, or provider errors never trigger an automatic switch. Billing/key changes apply immediately (Settings Cancel does not undo them), and are refused while the relevant runtime has active work. This includes managed/native sub-agents and background title, learning and discovery requests. Saving a key while Subscription is selected does not activate API billing. Chat keys are separate from voice-input keys.

OpenAI's **Connect saved key** replaces the ChatGPT sign-in in Mythra Code's private Codex profile. Returning to Subscription may require browser sign-in again. Codex keeps its own copy of a connected key in the OS credential store until you remove the key in Mythra Code or sign in with ChatGPT again; switching billing back to Subscription alone does not delete it. Claude subscription sign-in opens your browser, and Models & accounts offers **Cancel sign-in** while it waits. ChatGPT subscription usage is not OpenAI API credit. Claude's API choice leaves the external Claude subscription login untouched, so switching back reuses it if it is still valid. API billing does not require a paid chat subscription, but does require the provider's runtime, a valid key, supported models and available API credit/billing. Provider-specific subscription-only services may not be available with API authentication.

Eligible Anthropic subscriber credits must be linked to the Console organization that owns the key. Mythra Code uses the self-run, headless `claude -p`/Agent SDK integration; Anthropic [explains credit eligibility and exclusions](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans). The provider dashboard is authoritative for credit balances and charges; Mythra Code does not read an organization balance or impose an API spending cap. When giving another person access, use a dedicated key/workspace and configure provider-side spending limits. Commands and MCP servers run locally with the selected permissions; Claude's API credential is passed to its runtime environment, so only use trusted tools.

## Everyday work

### Chats and project threads

- **Chats** are conversations without a user project folder. They use a private working directory for persistence; project workspace tools are unavailable there.
- **Projects** are folders you choose. Each thread stays associated with its project, with its own messages, drafts, attachments, and running state.
- **Shared project** threads work in the same folder. For parallel work, choose an **Isolated worktree** before the first message to give a thread its own folder and branch. This requires a Git repository root with at least one commit.

The sidebar search matches thread titles and conversation content for every provider: Codex threads through the Codex runtime's search, and Claude and Cursor threads through their locally stored transcripts.

Threads can keep working in the background while you view another conversation. While a turn is running, **Send** queues a follow-up; queued prompts can be edited or removed before delivery. **Steer** sends a correction into the current turn, and **Stop** interrupts it.

Agents can ask structured questions. Claude pauses for an answer; supported Codex questions can stay open while work continues. Answering can steer an active turn or start a follow-up when the turn has finished. Exact support depends on the provider runtime.

To give precise feedback, select text in a completed reply or a file's diff in Review, then add a feedback note. Send one or more notes on their own or alongside a normal prompt.

### Instruction files and prompt presets

**Settings → Prompts** has one instruction editor with **Every provider**,
**Codex** and **Claude** tabs (a dot marks tabs that have text), a profile menu
for switching saved sets, and a **What the agent receives** summary with a
preview of your combined instructions. Learned preferences live in
**Settings → Memory**.

Under **Project files**, independently enable project **AGENTS.md** and
**CLAUDE.md** discovery. Both are off by default. Enabled files are read fresh
from the thread's project or isolated working folder for future turns, for any
provider. AGENTS.override.md takes precedence over AGENTS.md; CLAUDE.md can
fall back to .claude/CLAUDE.md. The combined limit is 32 KiB. Nested directories,
ancestor folders and instruction-file imports are not scanned or expanded.

Global Codex and Claude instruction files are discovered locally as available
presets and appear in the matching provider tab. Preview them before use: they
may contain personal information or credentials, and **Use for Codex/Claude**
asks you to confirm. **Use for Codex/Claude** replaces only that provider's prompt layer
after saving Settings, preserving other prompts. **Save copy** keeps a local
snapshot. Discovery and Refresh never activate files or overwrite active prompts
and saved copies. Configured CODEX_HOME and CLAUDE_CONFIG_DIR locations are honored.

Each global file is labelled with its provider logo. **Edit original file**
opens a live file editor beside the preset: edits automatically save back
to that file, with saving/saved/error feedback. These disk edits are separate
from Settings Save/Cancel; Cancel does not undo them. Detected file changes or
unsafe write paths stop saving and retain your draft. Avoid editing the same
file simultaneously in another program: external writes cannot be locked out
on every platform.
Normal window close flushes pending edits through the existing save lifecycle.
Previously selected app prompt layers and saved copies remain snapshots; use
the updated preset again to apply its new text in Mythra Code.

**Escape-to-stop is off by default.** Enable it in Settings → Interface if
desired; an explicit saved on/off choice is preserved. Escape still closes
menus and dialogs while the stop shortcut is disabled.

### Permissions

| Mode | Use it for |
| --- | --- |
| **Read only** | Inspecting and explaining without granting file-write access. |
| **Ask to act** | Coding with the runtime's workspace protections and approval requests for actions that need permission. |
| **Full access** | Trusted work where the agent may edit files and run commands without those approval prompts. |

Enforcement uses each provider runtime's capabilities; the modes are not an identical OS sandbox across all providers. Read only is not a guarantee that every third-party tool is side-effect free. Review the permissions of any tools or MCP servers you enable in **Settings → Tools & MCP**, and use Full access only where you intend to grant it.

### Sub-agents

Enable **Sub-agents** in the composer and configure the models allowed to help. You can use models from the same provider or mix any of the supported providers, provided their accounts and runtimes are ready. Save reusable setups in **Settings → Sub-agents**.

- Choose a concurrency limit of up to **24**, subject to the configured enabled sub-agents. This counts children, not the main agent.
- The main agent decides when to delegate within that setup. Each child's work is visible in the app, and children cannot spawn another layer of sub-agents.
- Children use the parent's permission policy through their own provider runtime.
- For an existing idle thread, changes to its configured sub-agents take effect together on its next message. They do not silently replace the setup of work already running.

Delegation uses Mythra Code's managed bridge rather than giving the model an unrestricted second set of native sub-agent tools. Parallel work consumes usage on each selected provider and can use subscription limits faster.

## Workspace tools

Open the right-side Workspace with **⌘B** on macOS or **Ctrl+B** on Windows. Use **⌘K / Ctrl+K** for the command palette.

| Tab | What it does |
| --- | --- |
| **Files** | Search project files, preview text, and attach context. |
| **Review** | Inspect changes, add feedback, request an AI review, and run project checks. |
| **Agents** | Follow sub-agent status, inspect their work, and interrupt them. |
| **Terminal** | Run commands in a terminal scoped to the project or isolated worktree. |
| **Checkpoints** | Inspect source snapshots, restore or reapply changes, and access conversation recovery actions. |
| **Worktrees** | Review isolated work, copy changes to the shared project, merge locally, or clean up a finished worktree. |
| **Context** | Manage files and images attached to the next message. |
| **Usage** | Inspect thread usage and request information. |
| **Tools** | Use project actions, skills, and MCP controls. |
| **Git** | Work with local branches and commits, connect GitHub, and manage a thread's pull request. |

**Run your project.** From the top-bar **Run** control, save a Run command once, or use **Find run command** to have your chosen provider/model inspect the project and save a command. Discovery does not launch the app or install dependencies. Review the saved command, then press Run. An optional **Before each run** command handles repeatable setup; setup failure prevents launch. Commands run from the thread's working folder, including its worktree.

**Run checks.** Review has a separate **Run checks** action for a saved test or validation command. Agents can save that command when working on tests, and **Find checks** can discover an existing check setup. It does not create missing tests. Checks run on demand, independently of the development server, and failures can be added as feedback for the agent.

**Recover source changes.** Git-project checkpoints capture tracked and untracked non-ignored files without moving your branch or staging index. Restoring creates a safety snapshot first. Ignored files and build output are excluded; checkpoints are not a replacement for backups. Rolling back conversation history is a separate action from restoring files.

## Local Git and GitHub

You can work entirely locally: initialize Git, create a branch, stage files, commit, and merge an isolated branch into the shared project without a GitHub account.

Connecting **Settings → GitHub** adds cloning, publishing, and pull requests through the official GitHub CLI. A branch does **not** automatically create a PR. Each thread can attach one primary PR, either an existing PR or one you create with your own title, description, and target branch. Its number and state appear on the thread's inbox card.

- **Push** publishes committed work. Uncommitted changes remain local.
- **Automatically publish branches and commits** is an optional project setting, off by default. It pushes new branches and committed changes while the app observes the project; it does not automatically commit files, pull changes, or create PRs.
- **Merge on GitHub** merges the PR on GitHub. It does **not** update your local folder. Use the separate **Update local _branch_** action (for example, **Update local main**) to bring the merged result into a clean shared project.
- The merge confirmation can also **archive the thread after a successful merge**. Archiving keeps the conversation recoverable and does not delete the local checkout.
- **Merge into local project** is a separate worktree action that changes local Git history without merging a GitHub PR.

PR availability and merge methods depend on repository permissions and branch rules. The integration supports github.com. See the [Git and pull-request guide](docs/thread-pull-requests.md) for details and safeguards.

## Skills, workflows, and scheduled work

### Skills: reusable instructions

Choose a folder in **Settings → Skills**, enable a skill, and mention its displayed alias, such as `@review`, in a prompt. Skills can reference other enabled skills and local Markdown/text documents. Mythra Code checks those dependencies before sending and shows what was included under **Skill context**.

Missing, disabled, unsafe, or unsupported nested references block delivery instead of silently sending incomplete context. Local references support UTF-8 `.md`, `.markdown`, and `.txt` files, not arbitrary document extraction. See the [skills guide](docs/skills.md) for syntax, limits, and examples.

### Workflows: reusable multi-step recipes

Create a recipe in **Settings → Workflows** from ordered agent prompts and optional shell commands. For example: inspect a change, run the project's checks, then summarize the results. Each run creates an inspectable project thread with step status and history.

- Run a recipe on any project; its saved project is only a default for manual runs and the destination for automatic runs.
- Use any supported provider for agent steps. Workflows save their model, permissions, and other run settings, so review that snapshot when changing providers.
- Supply inputs, use the previous step's output, and configure conditions, retries, and failure handling.
- Export/import `.mythra-workflow.json` recipes. Imports open for review and use the recipient's current model and permissions; project bindings, schedules, and run history are not shared. Referenced skills must be installed separately. Check prompts, commands, and input defaults for private information before sharing.
- Type **`!`** in the composer to search enabled recipes. Click a result, or select one with an arrow key and Enter, to add its chip. Bare Enter does not select the first result, and `!` followed by a space stays ordinary punctuation. Add an optional prompt, then review the destination and inputs before running.

Recipes can also run on an interval or once when Mythra Code starts, with a default project selected. **Settings → Scheduled tasks** offers simpler recurring prompts. Automatic work requires the app to be running; it is not a cloud scheduler. Unattended runs cannot rely on you answering approval dialogs or questions and do not gain extra permissions to bypass them.

Mythra Code workflows are app-managed recipes, not an import of every Claude Code or Cursor hook, command, or automation feature. Claude's personal CLI settings and hooks are not automatically inherited by Mythra Code turns.

## Make it yours

**Settings → Interface** controls themes, chat fonts, UI size, effort-slider styles, and provider marks. **Settings → Projects** provides project-specific defaults and optional **Automatic thread titles**. Its **Project profiles** list shows what each project changes from the app defaults (provider and model, look, project instructions, Run and Check commands, sub-agent settings). From there you can copy those settings to another project or export them as a `.mythra-project.json` file. When you import a file, you review each part first; Run and Check commands from a file start unticked.

Automatic titles use a separate request to your chosen provider/model; the default OpenAI selection follows an available Luna model. A soft animated placeholder covers the title while it is generated, and manually chosen names take precedence. This feature shares part of the first prompt with the title provider even when the main conversation uses a different provider.

**Settings → Prompts** holds your global and provider-specific instructions. The user-defined prompt starts empty. Project-instruction loading is opt-in for Codex-backed providers. Mythra Code also supplies operational guidance for its tools, delegation, completion, and project commands; an empty user prompt does **not** mean an instruction-free request. Provider policies and runtime tool instructions still apply.

To keep a local instruction record, enable **Settings → Usage → Record last-turn instructions** (off by default, saved immediately per device). The workspace panel's **Usage & audit → Last confirmed turn's instructions** shows the assembled system text and separately represented user-invoked skill context for the latest provider-confirmed start. It lists layer sizes, referenced skills and attachment counts, but omits ordinary user-message and attachment content, Mythra's additional operating guidance, and provider-built-in instructions. It confirms the provider accepted the start, not that the model followed every instruction.

Records are limited to 24 threads and the first 32,000 instruction characters per thread; the full pre-truncation character count remains visible. These copies can contain private instructions, Memory and skill text and remain locally until replaced, evicted, archived or deleted, even if their sources change. Turning recording off stops new records without erasing existing ones. **Delete existing instruction records** in Settings → Usage removes these copies from the browser cache and native store and turns recording off, without deleting chats or source files. The feature makes no additional model request or network upload; it is not secure erasure of filesystem backups or SQLite journal remnants.

## Usage and privacy

**Settings → Usage** shows this device's recorded tokens, daily activity, model/provider breakdowns, and estimated API-equivalent cost. These estimates are **not a subscription bill** and do not measure what every other app or computer has used. Account quota indicators use provider-reported information where available; unavailable information is not zero usage. See the [usage guide](docs/usage-dashboard.md) for coverage and pricing details.

Mythra Code has no app telemetry, analytics, or crash reporting. Conversations, settings, and usage records are stored locally, but **local-first does not mean offline**: prompts, supplied context, and tool results are sent to the selected provider. Optional title generation and command discovery use their separately selected provider. LM Studio can keep inference local when configured on your own machine.

Other network activity includes runtime authentication, app/runtime update checks, model and pricing catalogs, GitHub operations, and any network tools or MCP servers you choose to use. Pricing checks do not upload your prompts or usage records. Provider runtimes have their own storage, network behavior, and policies.

API keys saved by Mythra Code use the operating system credential store. GitHub authentication is managed by `gh`; OpenAI uses Mythra Code's isolated Codex home, while Claude and Cursor manage their own subscription sign-ins. Model text is rendered without raw HTML. Agents with command access can still use credential-aware tools available on the computer, so permissions matter.

## Build and contribute

The desktop shell is **Tauri 2 / Rust**, with a **React / TypeScript** UI. Codex App Server powers OpenAI, OpenRouter, and LM Studio; Claude Code and Cursor have dedicated runtime adapters. See [Architecture](docs/ARCHITECTURE.md) for the component and state model.

Requirements:

- Apple silicon macOS or Windows x64.
- Node.js **20.19+**, npm, and stable Rust/Cargo.
- Native Tauri prerequisites: Xcode Command Line Tools on macOS; C++ Build Tools and WebView2 on Windows. See [Tauri's setup guide](https://v2.tauri.app/start/prerequisites/).
- The runtime/account for whichever provider you want to exercise. GitHub CLI is needed for GitHub integration.

```bash
git clone https://github.com/m17h/Mythra-Code.git
cd Mythra-Code
npm ci
npm run desktop
```

`desktop` opens **Mythra Code Local Dev** with a separate app-data identity. It is not the packaged release. `npm run dev` starts only the web frontend and does not provide the native desktop bridge.

When changing user-facing behavior, update this README or the relevant linked guide in the same PR. Describe what users can do in the current app, and keep version-specific changes in the release notes.

Automated tests and checks are disabled locally and on GitHub until Morgan explicitly reintroduces them. There are no lint, type, unit, browser, native GUI, performance or CI gates for contributions, merges or releases. Compilation and release packaging remain available. Follow the [merge procedure](docs/operations/merging.md) for authorized PR handoffs and merges.

Use `npm.cmd` in PowerShell if script execution policy blocks the default wrapper.

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the production web frontend. |
| `npm run desktop:build` | Build a local macOS `.app` or unbundled Windows executable without updater artifacts. |

Local packaging does not have the development command's separate app-data identity; avoid launching it alongside an installed app doing active work. A completed build does not establish installed application behavior.

### Releases

Use [GitHub Releases](https://github.com/m17h/Mythra-Code/releases) for downloads and version-specific changes. This README describes the current source; features on a newer source branch may not yet be in your installed release.

Publishing requires an explicit release request and chosen version. Maintainers run one command on the Mac, `npm run release -- <version>`, which builds macOS locally and Windows over SSH from the same commit, signs both updater packages, notarizes macOS and publishes one release with both platforms in `latest.json`. See [Building and publishing a release](docs/operations/releasing.md).

## More documentation

- [Skills and nested references](docs/skills.md)
- [Local Git and thread pull requests](docs/thread-pull-requests.md)
- [Usage, pricing, and historical estimates](docs/usage-dashboard.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Performance](docs/PERFORMANCE.md)
- [Windows contributor notes](Windows/README.md)

## Acknowledgements

Mythra Code takes product-design inspiration from [T3 Code](https://github.com/pingdotgg/t3code)'s inbox-oriented experience. Its implementation uses its own React, Zustand, and Tauri architecture. Thanks to [T3 Tools](https://t3.gg/) and the maintainers of the open-source runtimes and libraries that make this app possible.

# OpenKiwi roadmap

OpenKiwi 1.0 establishes the core product: a fast, local-first macOS workspace for running and reviewing coding agents across providers. Post-1.0 work should deepen safety, recoverability, review quality, and provider interoperability before expanding into unrelated product areas.

## 1.1 — Safer parallel work

### Isolated worktrees

- Let each thread use either the shared project folder or an isolated Git worktree.
- Create a dedicated branch and worktree for an isolated thread.
- Show the active branch, worktree, and isolation state in the thread sidebar and workspace header.
- Provide clear actions to review, merge or apply changes, open the worktree, and clean it up.
- Warn before starting concurrent shared-folder runs that could edit the same files.
- Continue supporting non-Git projects through the existing shared-folder mode.

### Provider and process recovery

- Detect stale provider processes, disconnected event streams, and threads that appear busy after their process has stopped.
- Show whether a thread is working, waiting for approval, disconnected, recovering, or idle.
- Add a safe force-stop and recover action for individual threads.
- Preserve enough diagnostic information to explain why a run stopped without exposing credentials or private prompt content.

## 1.2 — Recoverability and provider interoperability

### Real run checkpoints

- Create an automatic project checkpoint before a model begins changing files.
- Associate each checkpoint with the run that created it.
- Show the exact files and changes produced by that run.
- Restore the project to its pre-run state without implying that conversation rollback alone changes files.
- Add selective file and hunk restoration after whole-run recovery is proven reliable.

### Continue with another provider

- Add a **Continue with another provider** action to completed and active threads.
- Create a new thread with a concise handoff containing the request, decisions, relevant files, completed work, unresolved issues, and current project state.
- Let the user choose Claude, OpenAI, or an OpenRouter model without changing the app-wide default provider.
- Keep the original thread unchanged and visibly link the source and continuation threads.
- Later, support sending the same request to multiple providers and comparing their approaches or resulting diffs.

### Better completed-work summaries

- Expand the completed-work capsule with duration, commands, file changes, tests, warnings, and unresolved items.
- Link directly from the capsule to the run-specific diff and checkpoint.
- Make the final result, verification status, and recommended next action easy to scan when revisiting an old thread.

## 1.3 — Review and project workflows

### Review and ship from the Studio

- Show run-scoped diffs instead of mixing unrelated workspace changes together.
- Support selective stage, revert, and checkpoint restore actions.
- Present test results and relevant warnings alongside the diff.
- Add guided commit, push, pull-request, and release-note actions with explicit user confirmation.
- Provide a concise shipping checklist rather than turning OpenKiwi into a full code editor.

### Reusable project profiles

- Save provider, model, reasoning effort, permission mode, prompt layers, skills, agents, workflows, and verification commands as a reusable project profile.
- Allow a project to inherit a profile while overriding individual settings.
- Make profiles exportable and easy to audit before importing.

### Context management

- Add a provider-neutral prepare-handoff or compact action that summarizes durable context without relying on provider-specific slash commands.
- Let users pin important messages, decisions, and files so they survive long conversations and handoffs.
- Preview what will be retained before replacing or branching a long context.

## Later opportunities

### Browser and application testing

- Let agents launch and inspect a development build or browser session through an explicit testing workflow.
- Capture screenshots, console errors, network failures, and before-and-after visual evidence.
- Keep browser and app control permissioned and observable.

### Remote access and notifications

- Explore a secure way to monitor local runs, answer approvals, and receive completion notifications from a phone or browser.
- Keep local execution and user control as the default.
- Treat authentication, encryption, reconnection, and unattended-access safety as release gates.

### Workflow triggers

- Extend workflows with optional schedules, Git events, or file-change triggers.
- Require clear enablement, permissions, history, and a kill switch for every unattended workflow.

## Product boundaries

Unless the product direction changes, OpenKiwi should not prioritize:

- Building a complete code editor or replacing the user's IDE.
- Adding providers solely to increase the provider count.
- Cloud execution before the local workflow is exceptionally reliable.
- Team administration and enterprise collaboration ahead of individual-user quality.
- Decorative UI work that does not improve clarity, speed, safety, or confidence.
- Opaque automatic model routing that weakens the user's control over provider choice.

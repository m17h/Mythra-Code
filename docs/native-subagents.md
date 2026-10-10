# Per-thread sub-agent systems

The composer's sub-agent panel lets a root thread choose Mythra Code's managed
crew or its provider's native sub-agent system. The enable switch is separate
from the system selector; new threads still start with sub-agents off. Selecting
native mode does not discard the saved Mythra crew. Switching back restores it.

## Supported native providers

- OpenAI threads use the Codex app-server native agent tools. Codex 0.161.0 or
  newer and a signed-in ChatGPT account are required.
- Claude threads use Claude Code's native Agent/Task tools. Claude Code 2.1.267
  or newer and a signed-in Claude account are required. That minimum includes
  the fix that prevents a child's `bypassPermissions` setting from overriding a
  non-bypass parent.
- Other providers cannot select native mode. Mythra-managed delegation remains
  available according to the existing provider and account readiness rules.

Native mode does not use the Mythra crew's provider/model roster. The app
passes the thread's permissions to the
native provider and retains its read-only tool restrictions and scoped project
bridge. Claude's empty settings-source list excludes user/project custom agent
definitions; mandatory provider-managed policy remains authoritative. This is
not a claim that every managed agent has an identical permission mode or that
arbitrary external MCP tools are sandboxed. Native mode retains project tools but
does not expose Mythra's spawn, collect, cancel, or crew-proposal bridge tools.

## Limits and lifecycle

The native concurrency control permits 1–24 children (default 6). It is a
provider spawn-admission setting, not a billing cap or a guarantee about total
usage. Codex's V2 configuration counts the primary thread, so its internal V2
limit is the selected child limit plus one; the canonical agents limits count
only children. Native Codex descendants have durable ownership links.

Claude native agents run in the foreground, with one level of delegation.
Background tasks, cross-session messaging, agent teams, scheduling, and remote
agents are not enabled by this feature. Claude's child activity appears in
Mythra's history and worker list, but it is not a separately resumable Mythra
conversation. Its Open and individual Stop controls are therefore absent;
stopping the parent stops the owned Claude process tree.

The system selector and limits stay locked while the thread or its children are
working, or their status is unresolved. Archive and delete protect active native
descendants. Stop, restored status, and follow-up activity use ownership and
activation evidence so an old completion cannot settle a newer run.

Changing the system takes effect on the next turn. A required shared Codex
runtime refresh waits rather than interrupting another thread. Scheduled first
prompts retain their chosen system and limit; fresh forks and handoffs keep the
existing sub-agents-off default.

## Implementation boundaries

Preferences are stored per thread in the existing
`kiwi.threadSubagentSettings` entry. Legacy boolean entries migrate to the
Mythra system; malformed entries fail closed. Runtime flags and environment
changes are process/thread scoped: this feature does not rewrite the user's
global Codex or Claude configuration.

Provider activity is preserved separately from the main chat answer. Forwarded
Claude child text is routed using its parent-tool identifier and cannot replace
the root's final answer. Codex lifecycle events can establish native ownership
even when no explicit spawn-tool item is emitted.

The sub-agent panel shows active and finished counts, reported assignments and
each worker's status. Details expands the full assignment, latest reported
progress and result when available. A requested/configured model is labelled
unconfirmed; only execution evidence confirms the model. Missing information
stays unknown rather than borrowing the parent's model or guessing progress.
New activations clear previous task/model/progress/result evidence, and late
snapshots cannot repopulate that older readout. These bounded details are saved
with native ownership so the available history survives reopening.

## Native parameters

The native pane keeps separate Claude and Codex preferences in each thread:

- **Child model:** Claude can request one model for ordinary native agents,
  including Explore, Plan and general-purpose agents. Provider-managed policy
  remains authoritative. Exact Haiku 5.5 selection requires Claude Code
  2.1.293 or newer.
- **Default child model and reasoning:** Codex accepts native child defaults.
  Explicit model or effort choices made when spawning an agent take precedence.
  Selecting a model without an effort uses that model's native default effort.
- **Conversation compaction:** provider default, manual 200K/500K/1M windows,
  and the selected model's published API price boundary when available (such
  as Haiku 5.5's 100K or applicable OpenAI models' 272K input-token boundary).
  The same refreshed pricing catalog powers these choices; unknown models do
  not inherit another model's pricing threshold. Floating Claude aliases use
  the runtime's concrete model identity, not a guessed current generation.
  Existing explicit/custom windows stay selected after model/catalog changes;
  a pricing refresh never silently changes a running or next-turn policy.
  This thread's own setting works with delegation off, Mythra or native mode.
  Each Mythra crew target has a separate choice; omission uses that worker's
  provider default, not its parent's choice. Created Mythra workers retain
  their approved setting for follow-up turns and after reopening.
- **Claude child model compaction:** the selected native child model can use a
  different window through process-local `modelSettings.autoCompactWindow`.
  Opus 5.5 at 1M and Haiku 5.5 at 100K, and the reverse, are supported. This
  needs Claude Code 2.1.288 or newer (Haiku 5.5 additionally requires 2.1.293).
  Parent and child using the same resolved model share that model's window;
  conflicting selections are rejected instead of silently changing the parent.
  A native child that explicitly inherits the parent model uses its window.
- **Codex native child compaction:** the verified Codex 0.161 V2 runtime does
  not expose an independent child-window default. Native workers inherit the
  parent's runtime policy; use Mythra-managed workers for independent windows.
  A saved unsupported child override must be reset before native mode can run.

Changing parameters takes effect on the next turn, stays locked during active
or unresolved work, and survives reopening and scheduled first-prompt snapshots.
Provider default removes the per-thread override; Codex may still use legitimate
base/user configuration, and mandatory provider policies are not bypassed.

Compaction is a context-management request, **not a hard token or spending cap**.
It uses estimated context and headroom, and can fail or overshoot. Haiku 5.5's
API pricing tier counts all input in each request, including cache reads and
writes. A 100K compaction choice therefore does not guarantee the lower API
pricing tier, nor does it change subscription usage rules. The implementation
does not spoof the model's context size or burn a user's allowance to test the
threshold.

Claude model windows use process-local settings, without replacing built-in
agent definitions or enlarging model capacity. Codex uses scoped startup
configuration with a guarded refresh when preferences change, even if
delegation is off.
Neither writes global provider settings. Claude child-specific effort, arbitrary
agent definitions, background/fork/team modes, and permission overrides are not
offered here: those are not equivalent, supported per-thread child controls in
the current integration.

## Enforcing the selected system

Mythra mode disables the providers' integrated native delegation tools; native
mode omits Mythra's spawn/collect/cancel bridge. Mode changes reconfigure loaded
Codex threads with a guarded runtime refresh rather than retaining old tools.
Recurring schedules and workflows retain their existing sub-agents-off rule,
including when they reuse a loaded conversation.

Claude's native Skill tool and provider slash commands can internally create a
forked child without going through the Agent permission gate. Integrated Claude
turns therefore disable those entry points. Skills explicitly enabled and
invoked through Mythra continue to be expanded into the prompt and used inline;
this does not delete or alter the user's skill files. Native mode uses ordinary
Agent/Task delegation, not the unsupported fork route.

These are harness/tool boundaries, not an operating-system sandbox. Full Access
still permits authorized shell programs, and cannot promise that an unrestricted
model could never launch a separate CLI through a shell command.

Primary references:

- [Codex sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Agent SDK sub-agents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude native environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude auto-compaction window](https://code.claude.com/docs/en/settings-reference#autocompactwindow)
- [Claude long-context pricing](https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing)

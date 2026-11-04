# Model context recommendations

Source review of the app after 1.31.8. These are recommendations only: this
branch does not change model-facing prompts, instructions, skills, tool schemas,
history, compaction, model choices or billing modes. No token, cost, cache-hit or
model-quality improvement was measured.

## Best candidate for a later change

The managed spawn tool repeats the same approved destination roster in its main
description and its target parameter description (`src-tauri/src/agents.rs`).
A future change could keep one complete authoritative roster and refer to it
from the parameter description, retaining the exact target enum and native
validation. This could remove repeated text without removing tools or models.
It needs provider-specific evaluation: associating a destination with the right
parameter matters, and changing schemas can affect prompt caching. It is not
implemented here.

## Repeated information that should stay

- Current project-instruction and learned-preference snapshots explicitly
  replace or clear older instructions. Omitting an empty snapshot can leave
  stale instructions active (`projectInstructionContext.ts`,
  `currentLearnedPreferences.ts`, `completionPrompt.ts`).
- Skill dependency resolution already deduplicates by channel and provenance.
  Blind text deduplication can change instruction priority or alias meaning
  (`skills.rs`, `skill_dependencies.rs`).
- Crew guidance applies only to the approved models and captured policy. A
  shared cache keyed only by project/model could reuse the wrong permissions,
  tool registration or instructions (`agentBridge.ts`, `childAgentSessions.ts`).
- The renderer's bounded history is separate from provider-owned conversation
  history. Showing fewer rows does not establish lower model context usage.

## Architecture worth considering separately

Root turns, children, workflows and scheduled prompts share helpers but assemble
their inputs in different orchestration paths. A pure prepared-turn plan with
separate provider adapters could make those responsibilities easier to follow.
Its first goal should be identical output and authority, rather than shorter
prompts. It must retain captured child policy, current file reads, exact
system/user roles, authored skill mentions, cancellation and delivery ownership.
A broad extraction during an efficiency sweep would add unnecessary risk.

This branch corrects the older thread-creation and native-only delegation
descriptions in `docs/ARCHITECTURE.md`. Current turns can carry fresh developer
and system snapshots, and managed delegation has richer lifecycle rules.
See `docs/managed-subagent-conversations.md` and the current turn-preparation
code for details; stale creation-only assumptions must not justify removing
current instructions.

## Better evidence before changing context

Current instruction receipts describe selected app-provided layers, not the
entire model input. They omit some completion/developer framing, tool schemas,
provider-native instructions and provider-owned history; their character counts
are not token counts (`turnContextReceipts.ts`, `useTurnRunner.ts`). They cannot
establish actual cost or cache savings.

Provider handoff copies are intentionally bounded and disclosed. When only
recent history is loaded, the first hydrated user message may be later than the
conversation's original goal (`providerHandoffPrompt.ts`, `App.tsx`). Improving
that coverage would change model input, so it remains a separate recommendation.

Any later context change should compare actual delivered inputs, provider usage
and representative model behavior, while keeping tool access and task quality.
The repository currently disables automated checks and performance measurements;
none were added or run for this report.

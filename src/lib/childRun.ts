import { rpc } from "./codex";
import { saveClaudeTranscript, startClaudeTurn } from "./claude";
import { saveCursorTranscript, startCursorTurn } from "./cursor";
import { childAgentModel } from "./childAgents";
import { withOpenKiwiCompletionInstructions } from "./completionPrompt";
import { threadStartParams, turnStartParams } from "./turnConfig";
import { optimisticStartedThread } from "./threadList";
import { buildTurnInput } from "./turnInput";
import type { ChildAgentPolicy } from "./childAgents";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { ChildAgentTarget, ScheduleRunSettings, Thread, Turn } from "../types";

/**
 * Starting a cross-provider child.
 *
 * A child is a first-class OpenKiwi thread: it runs through the same
 * per-provider start path the composer uses, in the root thread's execution
 * folder (its isolated worktree when it has one), under the root thread's
 * permission policy. What it deliberately does not get is the parent's
 * conversation, the parent's attachments, or any delegation tools of its own.
 */

/** Everything a child inherits from its parent, resolved at spawn time. */
export interface ChildRunContext {
  policy: ChildAgentPolicy;
  /** The root thread's execution folder — worktree path when isolated. */
  executionPath: string;
  additionalWorkspaceRoots: string[];
  systemPrompt: string;
  projectInstructionsEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  serviceTier: string | null;
  serviceName: string;
  /** Context window for an OpenRouter destination, when known. */
  openRouterContextWindow?: number;
}

export interface ChildRunResult {
  thread: Thread;
  turnId?: string;
  provider: ChildAgentTarget["provider"];
  model: string;
  cursorSessionId?: string;
}

/**
 * The run settings a child thread starts with. Sub-agents are switched off and
 * the thread budget is one, so the child's own runtime exposes no delegation
 * surface — the structural half of the depth-one rule.
 */
export function childRunSettings(target: ChildAgentTarget, context: ChildRunContext): ScheduleRunSettings {
  return {
    provider: target.provider,
    model: childAgentModel(target),
    permission: context.policy.permission,
    systemPrompt: context.systemPrompt,
    projectInstructionsEnabled: context.projectInstructionsEnabled,
    subagentsEnabled: false,
    subagentMax: 1,
    reasoningEffort: context.reasoningEffort,
    ultra: false,
    serviceTier: context.serviceTier,
  };
}

/** The thread record OpenKiwi owns for a locally-started child. */
export function childThreadRecord(threadId: string, target: ChildAgentTarget, prompt: string, cwd: string): Thread {
  return {
    id: threadId,
    name: null,
    preview: prompt.slice(0, 140),
    cwd,
    updatedAt: Math.floor(Date.now() / 1000),
    modelProvider: target.provider,
  };
}

export async function startChildAgentTurn(
  target: ChildAgentTarget,
  prompt: string,
  context: ChildRunContext,
): Promise<ChildRunResult> {
  const run = childRunSettings(target, context);
  const systemPrompt = withOpenKiwiCompletionInstructions(context.systemPrompt);

  if (target.provider === "claude") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    await saveClaudeTranscript({ thread, messages: [], activities: [] });
    const result = await startClaudeTurn({
      threadId,
      cwd: context.executionPath,
      prompt,
      model: run.model,
      effort: context.reasoningEffort,
      permission: run.permission,
      systemPrompt,
      resume: false,
      attachments: [],
      subagentMax: 1,
      customAgents: [],
    });
    return { thread, turnId: result.turnId, provider: "claude", model: run.model };
  }

  if (target.provider === "cursor") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    await saveCursorTranscript({ thread, cursorSessionId: "", messages: [], activities: [] });
    const result = await startCursorTurn({
      threadId,
      cwd: context.executionPath,
      prompt,
      model: run.model,
      effort: context.reasoningEffort,
      permission: run.permission,
      systemPrompt,
      attachments: [],
    });
    return {
      thread,
      turnId: result.turnId,
      provider: "cursor",
      model: run.model,
      cursorSessionId: result.cursorSessionId,
    };
  }

  const started = await rpc<{ thread: Thread }>("thread/start", threadStartParams(run, context.executionPath, {
    serviceName: context.serviceName,
    customAgents: [],
    modelContextWindow: target.provider === "openrouter" ? context.openRouterContextWindow : undefined,
    interactive: true,
    additionalWorkspaceRoots: context.additionalWorkspaceRoots,
  }));
  const thread = optimisticStartedThread(started.thread, prompt);
  const turn = await rpc<{ turn: Turn }>("turn/start", turnStartParams(
    run,
    thread.id,
    context.executionPath,
    buildTurnInput(prompt, []),
    context.additionalWorkspaceRoots,
  ));
  return { thread, turnId: turn.turn?.id, provider: target.provider, model: run.model };
}

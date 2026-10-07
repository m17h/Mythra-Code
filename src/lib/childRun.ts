import { rpc } from "./codex";
import { deleteClaudeTranscript, saveClaudeTranscript, startClaudeTurn } from "./claude";
import { deleteCursorTranscript, saveCursorTranscript, startCursorTurn } from "./cursor";
import { friendlyError } from "./errors";
import { childAgentModel } from "./childAgents";
import { withMythraCodeCompletionInstructions } from "./completionPrompt";
import { threadStartParams, turnStartParams } from "./turnConfig";
import { optimisticStartedThread } from "./threadList";
import { buildTurnInput } from "./turnInput";
import type { ChildAgentPolicy } from "./childAgents";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { ChildAgentTarget, ScheduleRunSettings, SkillDependencyReport, SkillReference, Thread, Turn } from "../types";
import type { ResolvedSkillPrompts } from "./skills";
import { appendCurrentLearnedPreferences } from "./currentLearnedPreferences";

/**
 * Starting a cross-provider child.
 *
 * A child is a first-class Mythra Code thread: it runs through the same
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
  /** Stable saved-project identity of the root; null means ordinary Chats. */
  projectId?: string | null;
  projectInstructionsEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  serviceTier: string | null;
  serviceName: string;
  /** Context window reported by the destination's model catalog, when known. */
  modelContextWindow?: number;
  /** Current LM Studio Responses endpoint used by local-model destinations. */
  lmStudioBaseUrl?: string;
  /** Resolve exact enabled Mythra Code skill mentions before provider delivery. */
  resolveSkillPrompt: (message: string) => Promise<string>;
  /** Paired resolution keeps inherited skill instructions in the system channel. */
  resolveSkillPrompts?: (message: string, systemPrompt: string) => Promise<ResolvedSkillPrompts>;
  /** Stop/deletion can land while skill preparation or checkpoints await. */
  isStartCancelled?: () => boolean;
  /**
   * Snapshot the execution folder just before the child's first turn starts,
   * keyed by the child's thread id so the provider's turn-completion handler
   * finalizes it like any other automatic run checkpoint.
   */
  beginCheckpoint?: (childThreadId: string) => Promise<void>;
  /** Drop the snapshot when the turn never actually started. */
  discardCheckpoint?: (childThreadId: string) => void;
}

export interface ChildRunResult {
  thread: Thread;
  turnId?: string;
  provider: ChildAgentTarget["provider"];
  model: string;
  cursorSessionId?: string;
  skillReferences?: SkillReference[];
  skillsFolder?: string;
  skillDependencies?: SkillDependencyReport;
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
    lmStudioBaseUrl: context.lmStudioBaseUrl,
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

/** The thread record Mythra Code owns for a locally-started child. */
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

async function removeUnusedChild(reason: unknown, childId: string, cleanup: () => Promise<unknown>): Promise<never> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cleanup did not finish within five seconds; it may still complete.")), 5000); }),
    ]);
  } catch (cleanupReason) {
    throw new Error(`${friendlyError(reason)}\nThe unused sub-agent thread ${childId} could not be cleaned up: ${friendlyError(cleanupReason)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  throw reason;
}

export async function startChildAgentTurn(
  target: ChildAgentTarget,
  prompt: string,
  context: ChildRunContext,
): Promise<ChildRunResult> {
  const assertCanStart = () => {
    if (context.isStartCancelled?.()) throw new Error("The sub-agent start was cancelled before its model turn began.");
  };
  assertCanStart();
  const resolved: ResolvedSkillPrompts = context.resolveSkillPrompts
    ? await context.resolveSkillPrompts(prompt, context.systemPrompt)
    : { prompt: await context.resolveSkillPrompt(prompt), systemPrompt: context.systemPrompt };
  // Resolution is asynchronous disk work, not permission to start after Stop
  // or root deletion. Check before creating any transcript/provider thread.
  assertCanStart();
  const learnedSystemPrompt = appendCurrentLearnedPreferences(resolved.systemPrompt, context.projectId ?? null);
  assertCanStart();
  const run = { ...childRunSettings(target, context), systemPrompt: learnedSystemPrompt };
  const systemPrompt = withMythraCodeCompletionInstructions(learnedSystemPrompt);
  const providerPrompt = resolved.prompt;
  const provenance = { skillReferences: resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies };

  if (target.provider === "claude") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    let result;
    let modelTurnRequested = false;
    try {
      await saveClaudeTranscript({ thread, messages: [], activities: [] });
      assertCanStart();
      await context.beginCheckpoint?.(threadId);
      assertCanStart();
      modelTurnRequested = true;
      result = await startClaudeTurn({
        threadId,
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: context.reasoningEffort,
        permission: run.permission,
        systemPrompt,
        resume: false,
        attachments: [],
        subagentMax: 1,
        customAgents: [],
      });
    } catch (reason) {
      context.discardCheckpoint?.(threadId);
      if (!modelTurnRequested) return removeUnusedChild(reason, threadId, () => deleteClaudeTranscript(threadId));
      throw reason;
    }
    return { thread, turnId: result.turnId, provider: "claude", model: run.model, ...provenance };
  }

  if (target.provider === "cursor") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    let result;
    let modelTurnRequested = false;
    try {
      await saveCursorTranscript({ thread, cursorSessionId: "", messages: [], activities: [] });
      assertCanStart();
      await context.beginCheckpoint?.(threadId);
      assertCanStart();
      modelTurnRequested = true;
      result = await startCursorTurn({
        threadId,
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: context.reasoningEffort,
        permission: run.permission,
        systemPrompt,
        attachments: [],
      });
    } catch (reason) {
      context.discardCheckpoint?.(threadId);
      if (!modelTurnRequested) return removeUnusedChild(reason, threadId, () => deleteCursorTranscript(threadId));
      throw reason;
    }
    return {
      thread,
      turnId: result.turnId,
      provider: "cursor",
      model: run.model,
      cursorSessionId: result.cursorSessionId,
      ...provenance,
    };
  }

  const started = await rpc<{ thread: Thread; model?: unknown }>("thread/start", threadStartParams(run, context.executionPath, {
    serviceName: context.serviceName,
    perTurnSystemPrompt: true,
    customAgents: [],
    modelContextWindow: context.modelContextWindow,
    interactive: true,
    additionalWorkspaceRoots: context.additionalWorkspaceRoots,
  }));
  const thread = optimisticStartedThread(started.thread, prompt);
  const runtimeModel = typeof started.model === "string" ? started.model.trim() : undefined;
  let turn: { turn: Turn };
  let modelTurnRequested = false;
  try {
    assertCanStart();
    await context.beginCheckpoint?.(thread.id);
    assertCanStart();
    // Validate locally before claiming an RPC was sent; a parameter failure
    // still leaves an unused thread that this caller alone owns.
    const params = turnStartParams(
      run,
      thread.id,
      context.executionPath,
      buildTurnInput(providerPrompt, []),
      context.additionalWorkspaceRoots,
      true,
      { systemPrompt: learnedSystemPrompt, model: runtimeModel },
    );
    modelTurnRequested = true;
    turn = await rpc<{ turn: Turn }>("turn/start", params);
  } catch (reason) {
    context.discardCheckpoint?.(thread.id);
    // The thread is newly owned and no turn request was sent. Archive exactly
    // that unused record; an ambiguous start RPC failure is not proof of this.
    if (!modelTurnRequested) return removeUnusedChild(reason, thread.id, () => rpc("thread/archive", { threadId: thread.id }));
    throw reason;
  }
  return { thread, turnId: turn.turn?.id, provider: target.provider, model: run.model || runtimeModel || "", ...provenance };
}

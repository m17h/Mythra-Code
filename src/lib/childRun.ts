import { rpc, runtimeThreadState } from "./codex";
import { invoke } from "@tauri-apps/api/core";
import { deleteClaudeTranscript, saveClaudeTranscript, startClaudeTurn } from "./claude";
import { deleteCursorTranscript, loadCursorTranscript, saveCursorTranscript, startCursorTurn } from "./cursor";
import { friendlyError } from "./errors";
import { childAgentAutoCompactIssue, childAgentModel } from "./childAgents";
import { withMythraCodeCompletionInstructions } from "./completionPrompt";
import { threadResumeParams, threadStartParams, turnStartParams } from "./turnConfig";
import { planSubagentCapabilities, recordSubagentCapabilities, subagentCapabilitySignature } from "./threadCapabilities";
import { DEFAULT_CHILD_AGENT_SETTINGS } from "./appConfig";
import type { ChildAgentLink } from "./childAgents";
import { optimisticStartedThread } from "./threadList";
import { buildTurnInput } from "./turnInput";
import type { ChildAgentPolicy } from "./childAgents";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import type { ChildAgentTarget, ScheduleRunSettings, SkillDependencyReport, SkillReference, Thread, Turn } from "../types";
import type { ResolvedSkillPrompts } from "./skills";
import { appendCurrentLearnedPreferences } from "./currentLearnedPreferences";
import { appendProjectInstructionContext } from "./projectInstructionContext";
import { startChildAgentSession, type ChildAgentBridgeLaunch, type ProjectBridgeContext } from "./agentBridge";
import { ensureChildAgentBridge, registerChildProjectLaunch, releaseChildAgentSession } from "./childAgentSessions";
import { useTaskStore } from "./taskStore";
import { normalizedProjectPath } from "./paths";
import { beginCursorTurnStart, rejectCursorTurnStart, type CursorStartAttempt } from "./cursorTurnOwnership";

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
  projectClaudeInstructionsEnabled?: boolean;
  reasoningEffort: ReasoningEffort;
  serviceTier: string | null;
  serviceName: string;
  /** Context window reported by the destination's model catalog, when known. */
  modelContextWindow?: number;
  /** Current LM Studio Responses endpoint used by local-model destinations. */
  lmStudioBaseUrl?: string;
  /** Resolve exact enabled Mythra Code skill mentions before provider delivery. */
  resolveSkillPrompt: (message: string, mentionSource?: string) => Promise<string>;
  /** Paired resolution keeps inherited skill instructions in the system channel. */
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
  /** Stop/deletion can land while skill preparation or checkpoints await. */
  isStartCancelled?: () => boolean;
  /** Reconfirm backend request authority immediately before model dispatch. */
  validateDispatch?: () => Promise<void>;
  /** Claim this initial spawn's backend reservation before any model request. */
  claimDispatch: (childThreadId: string) => Promise<void>;
  /** Setup after publishing the new child's prompt, before its first snapshot. */
  prepareNewThreadGit?: (childThreadId: string) => Promise<boolean>;
  /** Published ownership may have been resumed or replaced while claiming. */
  canDiscardUnusedChild?: (childThreadId: string) => boolean;
  /** Same optimistic prompt identity the caller publishes with ownership. */
  initialMessageId?: string;
  /**
   * Snapshot the execution folder just before the child's first turn starts,
   * keyed by the child's thread id so the provider's turn-completion handler
   * finalizes it like any other automatic run checkpoint.
   */
  beginCheckpoint?: (childThreadId: string) => Promise<string | undefined | void>;
  /** Drop the snapshot when the turn never actually started. */
  discardCheckpoint?: (childThreadId: string, expectedCheckpointId?: string) => void;
  /** Exact never-dispatched child is being discarded: cancel saves/sidebar identity first. */
  onDiscardUnusedChild?: (childThreadId: string) => void;
  /**
   * Called synchronously before its first model turn is requested. Persist
   * the conversation and bridge ownership here so a renderer reload during
   * provider acknowledgement can recover the actual child.
   */
  onChildIdentified?: (
    thread: Thread,
    languageSessionId: string,
    provenance: Pick<ChildRunResult, "skillReferences" | "skillsFolder" | "skillDependencies">,
    /** Owner-bound native start identity (Claude/Cursor), known before dispatch. */
    startRequestId?: string,
  ) => void;
}

/**
 * Appended to V2 Mythra Code children's system prompts. The MCP server
 * instructions say the same, but not every runtime surfaces those.
 */
export const CHILD_PARENT_MESSAGING_INSTRUCTIONS = [
  "You are a sub-agent started by a parent agent through Mythra Code; the parent does not see this conversation.",
  "Use the mythra_agents tool message_parent to send the parent a progress update or a question; it is stored in the parent's mailbox and is not an instant reply, so keep working when you can.",
  "Parent guidance may arrive in this conversation or through read_parent_messages. Your final message each turn is returned to the parent, which may continue this same conversation with more work.",
  "You cannot start sub-agents of your own.",
].join(" ");

function withChildMessaging(systemPrompt: string, enabled: boolean): string {
  if (!enabled) return systemPrompt;
  return systemPrompt.trim() ? `${systemPrompt}\n\n${CHILD_PARENT_MESSAGING_INSTRUCTIONS}` : CHILD_PARENT_MESSAGING_INSTRUCTIONS;
}

/** Capability record matching what useTurnRunner computes for a child turn. */
/**
 * Includes the shared startup identity (provider, LM Studio endpoint, model
 * context window) exactly as passed to thread/start or thread/resume, so a
 * warm runtime loaded with a different endpoint/window is never reused.
 */
function childCapabilitySignature(
  autoCompactTokens: number | undefined,
  bridge: ChildAgentBridgeLaunch | undefined,
  identity: { provider: ChildAgentTarget["provider"]; lmStudioBaseUrl?: string; modelContextWindow?: number },
): string {
  return subagentCapabilitySignature(
    { subagentsEnabled: false, subagentMax: 1, autoCompactTokens, bridgeInstanceId: bridge?.configPath },
    { provider: identity.provider, lmStudioBaseUrl: identity.lmStudioBaseUrl, modelContextWindow: identity.modelContextWindow },
  );
}

export interface ChildRunResult {
  superseded?: boolean;
  stopped?: boolean;
  languageSessionId?: string;
  /** Native start identity a Stop can target before any turn ID exists. */
  startRequestId?: string;
  thread: Thread;
  turnId?: string;
  provider: ChildAgentTarget["provider"];
  model: string;
  cursorSessionId?: string;
  skillReferences?: SkillReference[];
  skillsFolder?: string;
  skillDependencies?: SkillDependencyReport;
}

/** A dispatched first turn may exist even when its acknowledgement was lost. */
export class ChildAgentStartUncertainError extends Error {
  readonly child: ChildRunResult;

  constructor(reason: unknown, child: ChildRunResult) {
    super(`The sub-agent start could not be confirmed: ${friendlyError(reason)}`);
    this.name = "ChildAgentStartUncertainError";
    this.child = child;
  }
}

/**
 * Native start commands prefix an error with this marker only when they
 * refused before writing any prompt to the provider (owner-bound proof).
 * Any other failure after the request was issued stays uncertain.
 */
export const NOT_DISPATCHED_PREFIX = "MYTHRA_NOT_DISPATCHED:";

export function definitelyNotDispatched(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return text.startsWith(NOT_DISPATCHED_PREFIX) || text.includes(` ${NOT_DISPATCHED_PREFIX}`);
}

/**
 * The run settings a child thread starts with. Sub-agents are switched off and
 * the thread budget is one, so the child's own runtime exposes no delegation
 * surface — the structural half of the depth-one rule.
 */
export function childRunSettings(target: ChildAgentTarget, context: ChildRunContext): ScheduleRunSettings {
  const compactionError = childAgentAutoCompactIssue(target);
  if (compactionError) throw new Error(compactionError);
  return {
    provider: target.provider,
    model: childAgentModel(target),
    lmStudioBaseUrl: context.lmStudioBaseUrl,
    permission: context.policy.permission,
    systemPrompt: context.systemPrompt,
    projectInstructionsEnabled: context.projectInstructionsEnabled === true,
    projectClaudeInstructionsEnabled: context.projectClaudeInstructionsEnabled === true,
    subagentsEnabled: false,
    subagentMax: 1,
    ...(target.autoCompactTokens !== undefined ? { autoCompactTokens: target.autoCompactTokens } : {}),
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
  const childSettings = childRunSettings(target, context);
  // Generated parent assignments are literal input. Only inherited system
  // instructions, rather than incidental @mentions in this text, select skills.
  const resolved: ResolvedSkillPrompts = context.resolveSkillPrompts
    ? await context.resolveSkillPrompts(prompt, context.systemPrompt, "")
    : { prompt: await context.resolveSkillPrompt(prompt, ""), systemPrompt: context.systemPrompt };
  // Resolution is asynchronous disk work, not permission to start after Stop
  // or root deletion. Check before creating any transcript/provider thread.
  assertCanStart();
  const learnedSystemPrompt = await appendCurrentLearnedPreferences(resolved.systemPrompt, context.projectId ?? null);
  assertCanStart();
  const projectSystemPrompt = await appendProjectInstructionContext(
    learnedSystemPrompt, context.projectId ? context.executionPath : null, context, assertCanStart,
  );
  assertCanStart();
  const run = { ...childSettings, systemPrompt: projectSystemPrompt };
  const systemPrompt = withMythraCodeCompletionInstructions(projectSystemPrompt);
  const providerPrompt = resolved.prompt;
  const provenance = { skillReferences: resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies };
  // Every owned child gets its own bridge session: the parent mailbox only
  // for its captured V2 crew, language tools inside a saved project. It never carries delegation,
  // project-control or terminal authority (the backend enforces that scope).
  let languageBridge: ChildAgentBridgeLaunch | undefined;
  const languageSessionId = `language-child-${crypto.randomUUID()}`;
  const languageContext: ProjectBridgeContext = {
    ...(context.projectId ? { projectPath: context.executionPath } : {}),
    permission: run.permission,
    provider: target.provider,
    childThread: true,
    parentMessaging: context.policy.collaborationV2 === true,
  };
  if (context.projectId) {
    // A delegated child is a new project thread too. A parent opened before
    // this feature or a newly added language must get the same optional setup.
    await invoke("language_tools_prepare_project", { cwd: context.executionPath, permission: run.permission }).catch(() => undefined);
    assertCanStart();
  }
  try {
    languageBridge = await startChildAgentSession({
      ...context.policy, sessionId: languageSessionId, rootThreadId: "", targets: [], maxConcurrent: 1, collaborationV2: false,
    }, [], [], languageContext);
    assertCanStart();
  } catch (reason) {
    await releaseChildAgentSession(languageSessionId);
    throw reason;
  }
  const messagingSystemPrompt = withChildMessaging(systemPrompt, Boolean(languageBridge?.toolNames.includes("message_parent")));
  const messagingProjectPrompt = withChildMessaging(projectSystemPrompt, Boolean(languageBridge?.toolNames.includes("message_parent")));
  // Bind before the model turn is requested: its first tool call may be a
  // parent message, and that must resolve to this child immediately.
  let childPublished = false;
  // Claude/Cursor starts carry an owner-bound identity, so a Stop before any
  // turn ID can cut off exactly this start and never a newer one. Cursor's
  // identity is the renderer owner reservation its adapter requires.
  let startRequestId: string | undefined = target.provider === "claude" ? crypto.randomUUID() : undefined;
  let cursorAttempt: CursorStartAttempt | undefined;
  const bindLanguageBridge = (thread: Thread) => {
    if (languageBridge) registerChildProjectLaunch(thread.id, languageSessionId, languageBridge, languageContext);
    if (context.onChildIdentified) {
      childPublished = true;
      context.onChildIdentified(thread, languageSessionId, provenance, startRequestId);
    }
  };
  // Save local providers' optimistic prompt before publishing ownership. A
  // reload can recover it even before acknowledgement. Backend reservation
  // claiming then guards the boundary between publication and model dispatch.
  const initialTimeline = {
    messages: [{ id: context.initialMessageId ?? `local-${crypto.randomUUID()}`, role: "user" as const, text: prompt, ...provenance }],
    activities: [],
  };
  const releaseLanguageBridge = async () => {
    await releaseChildAgentSession(languageSessionId);
  };
  /** Exact checkpoint this start created; cleanup never removes a newer one. */
  let checkpointId: string | undefined;
  const beginCheckpoint = async (threadId: string) => {
    const id = await context.beginCheckpoint?.(threadId);
    if (typeof id === "string" && id) checkpointId = id;
  };
  const discardUnusedChild = async (reason: unknown, child: ChildRunResult, cleanup: () => Promise<unknown>): Promise<never> => {
    const assertCleanupOwned = () => {
      if (childPublished && context.canDiscardUnusedChild?.(child.thread.id) === false) {
        throw new ChildAgentStartUncertainError(reason, { ...child, superseded: true });
      }
    };
    // A Stop followed by a manual turn (or renderer replacement) can take
    // over this conversation during the claim await. None of its bridge,
    // checkpoint or transcript then belongs to this unused initial request.
    assertCleanupOwned();
    await releaseLanguageBridge();
    assertCleanupOwned();
    context.onDiscardUnusedChild?.(child.thread.id);
    if (checkpointId) context.discardCheckpoint?.(child.thread.id, checkpointId);
    try {
      return await removeUnusedChild(reason, child.thread.id, cleanup);
    } catch (cleanupReason) {
      // Native deletion/archive can await while a manual turn takes over.
      // Preserve its owned result even when that race rejects the cleanup.
      assertCleanupOwned();
      throw cleanupReason;
    }
  };

  if (target.provider === "claude") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    let result;
    let modelTurnRequested = false;
    try {
      await saveClaudeTranscript({ thread, ...initialTimeline });
      assertCanStart();
      await context.validateDispatch?.();
      assertCanStart();
      bindLanguageBridge(thread);
      assertCanStart();
      await context.prepareNewThreadGit?.(threadId);
      assertCanStart();
      await beginCheckpoint(threadId);
      assertCanStart();
      await context.claimDispatch(threadId);
      assertCanStart();
      modelTurnRequested = true;
      result = await startClaudeTurn({
        threadId,
        ...(startRequestId ? { startRequestId } : {}),
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: context.reasoningEffort,
        permission: run.permission,
        systemPrompt: messagingSystemPrompt,
        resume: false,
        attachments: [],
        subagentMax: 1,
        customAgents: [],
        ...(run.autoCompactTokens !== undefined ? { autoCompactTokens: run.autoCompactTokens } : {}),
        ...(languageBridge ? { childAgentBridgeConfig: languageBridge.configPath } : {}),
      });
    } catch (reason) {
      if (modelTurnRequested && !definitelyNotDispatched(reason)) throw new ChildAgentStartUncertainError(reason, {
        thread, provider: target.provider, model: run.model, ...provenance, languageSessionId, startRequestId,
      });
      return discardUnusedChild(reason, {
        thread, provider: target.provider, model: run.model, ...provenance, languageSessionId,
      }, () => deleteClaudeTranscript(threadId));
    }
    return { thread, turnId: result.turnId, provider: "claude", model: run.model, ...provenance, languageSessionId, startRequestId };
  }

  if (target.provider === "cursor") {
    const thread = childThreadRecord(crypto.randomUUID(), target, prompt, context.executionPath);
    const threadId = thread.id;
    let result;
    let modelTurnRequested = false;
    try {
      await saveCursorTranscript({ thread, cursorSessionId: "", ...initialTimeline });
      assertCanStart();
      await context.validateDispatch?.();
      assertCanStart();
      cursorAttempt = beginCursorTurnStart(threadId);
      startRequestId = cursorAttempt.owner.startRequestId;
      bindLanguageBridge(thread);
      assertCanStart();
      await context.prepareNewThreadGit?.(threadId);
      assertCanStart();
      await beginCheckpoint(threadId);
      assertCanStart();
      await context.claimDispatch(threadId);
      assertCanStart();
      modelTurnRequested = true;
      result = await startCursorTurn({
        threadId,
        ...(startRequestId ? { startRequestId } : {}),
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: context.reasoningEffort,
        permission: run.permission,
        systemPrompt: messagingSystemPrompt,
        attachments: [],
        ...(languageBridge ? { childAgentBridge: { name: languageBridge.name, command: languageBridge.command, args: languageBridge.args } } : {}),
      });
    } catch (reason) {
      // An uncertain start keeps its owner open so its events still land.
      if (modelTurnRequested && !definitelyNotDispatched(reason)) throw new ChildAgentStartUncertainError(reason, {
        thread, provider: target.provider, model: run.model, ...provenance, languageSessionId, startRequestId,
      });
      // Nothing was sent: the adapter leaves a caller-reserved owner to us.
      if (cursorAttempt) rejectCursorTurnStart(threadId, cursorAttempt);
      return discardUnusedChild(reason, {
        thread, provider: target.provider, model: run.model, ...provenance, languageSessionId,
      }, () => deleteCursorTranscript(threadId));
    }
    return {
      thread,
      turnId: result.turnId,
      provider: "cursor",
      superseded: result.superseded,
      stopped: result.stopped,
      model: run.model,
      cursorSessionId: result.cursorSessionId,
      ...provenance,
      languageSessionId,
      startRequestId,
    };
  }

  let started: { thread: Thread; model?: unknown; runtimeInstance?: unknown };
  try {
    started = await rpc<{ thread: Thread; model?: unknown; runtimeInstance?: unknown }>("thread/start", threadStartParams(run, context.executionPath, {
      serviceName: context.serviceName,
      perTurnSystemPrompt: true,
      customAgents: [],
      modelContextWindow: context.modelContextWindow,
      interactive: true,
      additionalWorkspaceRoots: context.additionalWorkspaceRoots,
      childAgentBridge: languageBridge,
    }));
  } catch (reason) {
    await releaseLanguageBridge();
    throw reason;
  }
  const thread = optimisticStartedThread(started.thread, prompt);
  const runtimeModel = typeof started.model === "string" ? started.model.trim() : undefined;
  // thread/start applied exactly this child bridge in the instance its
  // response attests. Recording it lets a later follow-up (or the user's own
  // message) reuse the loaded runtime thread instead of demanding a refresh.
  // An instance queried separately could be a replacement runtime.
  const startedInstance = typeof started.runtimeInstance === "string" && started.runtimeInstance ? started.runtimeInstance : undefined;
  if (startedInstance) recordSubagentCapabilities(thread.id, startedInstance, childCapabilitySignature(run.autoCompactTokens, languageBridge, {
    provider: target.provider, lmStudioBaseUrl: context.lmStudioBaseUrl, modelContextWindow: context.modelContextWindow,
  }));
  let turn: { turn: Turn };
  let modelTurnRequested = false;
  try {
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
      { systemPrompt: messagingProjectPrompt, model: runtimeModel },
    );
    await context.validateDispatch?.();
    assertCanStart();
    bindLanguageBridge(thread);
    assertCanStart();
    await context.prepareNewThreadGit?.(thread.id);
    assertCanStart();
    await beginCheckpoint(thread.id);
    assertCanStart();
    await context.claimDispatch(thread.id);
    assertCanStart();
    modelTurnRequested = true;
    // The turn must run in the instance that loaded this child with its bridge.
    turn = await rpc<{ turn: Turn }>("turn/start", startedInstance ? { ...params, expectedRuntimeInstance: startedInstance } : params);
  } catch (reason) {
    // A runtime that proves it refused before writing (for example a replaced
    // instance under expectedRuntimeInstance) left this thread unused.
    if (modelTurnRequested && !definitelyNotDispatched(reason)) throw new ChildAgentStartUncertainError(reason, {
      thread, provider: target.provider, model: run.model || runtimeModel || "", ...provenance, languageSessionId,
    });
    // The thread is newly owned and no turn request was sent. Archive exactly
    // that unused record; an ambiguous start RPC failure is not proof of this.
    return discardUnusedChild(reason, {
      thread, provider: target.provider, model: run.model || runtimeModel || "", ...provenance, languageSessionId,
    }, () => rpc("thread/archive", { threadId: thread.id }));
  }
  return { thread, turnId: turn.turn?.id, provider: target.provider, model: run.model || runtimeModel || "", ...provenance, languageSessionId };
}

/** Everything a same-conversation follow-up turn needs, resolved by its caller. */
export interface ChildFollowUpContext {
  link: ChildAgentLink;
  /** The root's live policy: permission and prompts the child inherits. */
  policy: ChildAgentPolicy;
  /** Ownership graph, so the bridge recognises this as a managed child. */
  links: Record<string, ChildAgentLink>;
  executionPath: string;
  additionalWorkspaceRoots: string[];
  projectId: string | null;
  serviceName: string;
  modelContextWindow?: number;
  lmStudioBaseUrl?: string;
  /** Cursor conversation identity to resume, when one was recorded. */
  cursorSessionId?: string;
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
  /** Throws when Stop, acceptance, deletion or ownership changes forbid the start. */
  assertCanStart: () => void;
  /** The caller discards this checkpoint when the follow-up fails to start. */
  beginCheckpoint?: (childThreadId: string) => Promise<void>;
  /** Runs synchronously right before the provider request is sent. */
  onDispatch?: (startRequestId?: string) => void;
}

export interface ChildFollowUpResult {
  turnId?: string;
  superseded?: boolean;
  stopped?: boolean;
  cursorSessionId?: string;
  /** Model the runtime actually reported, for Codex-backed destinations. */
  runtimeModel?: string;
  /**
   * A Codex runtime that already had this child loaded with an older bridge
   * cannot adopt a new one without a shared runtime refresh, which a model
   * tool must never trigger. Its Mythra tools may be unavailable this turn.
   */
  bridgeMayBeStale?: boolean;
}

/**
 * Continue an existing child on its own provider conversation.
 *
 * Nothing here is chosen by the parent model: provider, model, reasoning and
 * compaction come from the child's frozen link, and permission/prompts from
 * the root's current policy — the same inheritance a fresh spawn gets. The
 * child keeps its history; it never becomes a new or unrelated conversation.
 * The caller owns task-store status, slot accounting and every guard; this
 * function only performs the provider half and re-checks `assertCanStart`
 * after each await.
 */
export async function continueChildAgentTurn(prompt: string, context: ChildFollowUpContext): Promise<ChildFollowUpResult> {
  const { link, policy, assertCanStart } = context;
  if (link.signoff !== "required") throw new Error("This sub-agent was started in one-shot mode and cannot receive follow-up turns.");
  const threadId = link.childThreadId;
  const provider = link.provider;
  const owned = context.links[threadId];
  if (!owned || owned.childThreadId !== threadId || owned.rootThreadId !== policy.rootThreadId || owned.sessionId !== policy.sessionId
    || owned.provider !== provider || owned.model !== link.model || owned.reasoningEffort !== link.reasoningEffort
    || owned.autoCompactTokens !== link.autoCompactTokens || owned.activationId !== link.activationId) {
    throw new Error("This sub-agent's conversation no longer matches its parent-owned provider settings.");
  }
  if (!link.model.trim()) throw new Error("This sub-agent's frozen model identity is unavailable. Select an approved destination for a new sub-agent.");
  // The caller hydrates the original transcript before continuing it. A
  // parent's later worktree handoff must not redirect this child's history to
  // a different folder, including when Cursor has a cached resume identity.
  const task = useTaskStore.getState().tasks[threadId];
  if (!task?.messages.length) throw new Error("This sub-agent's conversation is not loaded yet. Try again in a moment.");
  if (!task.workspacePath?.trim() || !context.executionPath.trim()
    || normalizedProjectPath(task.workspacePath) !== normalizedProjectPath(context.executionPath)) {
    throw new Error("This sub-agent's existing conversation belongs to a different or unknown execution folder. Its history cannot be continued in the parent's current folder.");
  }
  const run: ScheduleRunSettings = {
    provider,
    model: link.model,
    lmStudioBaseUrl: context.lmStudioBaseUrl,
    permission: policy.permission,
    systemPrompt: policy.providerSystemPrompts?.[provider] ?? policy.systemPrompt,
    projectInstructionsEnabled: policy.projectInstructionsEnabled === true,
    projectClaudeInstructionsEnabled: policy.projectClaudeInstructionsEnabled === true,
    subagentsEnabled: false,
    subagentMax: 1,
    ...(link.autoCompactTokens !== undefined ? { autoCompactTokens: link.autoCompactTokens } : {}),
    reasoningEffort: link.reasoningEffort,
    ultra: false,
    serviceTier: policy.serviceTier,
  };
  assertCanStart();
  // The parent's text is generated, not authored: never resolve skill
  // mentions from it. Inherited system-channel skills still resolve.
  const resolved = context.resolveSkillPrompts
    ? await context.resolveSkillPrompts(prompt, run.systemPrompt, "")
    : { prompt, systemPrompt: run.systemPrompt };
  assertCanStart();
  const learned = await appendCurrentLearnedPreferences(resolved.systemPrompt, context.projectId);
  assertCanStart();
  const projectSystemPrompt = await appendProjectInstructionContext(
    learned, context.projectId ? context.executionPath : null, run, assertCanStart,
  );
  assertCanStart();
  const bridge = await ensureChildAgentBridge({
    threadId,
    policies: {},
    links: context.links,
    isChildThread: true,
    settings: {
      childAgents: DEFAULT_CHILD_AGENT_SETTINGS,
      subagentsEnabled: false,
      subagentMax: 1,
      subagentEngine: "mythra",
    },
    permission: run.permission,
    provider,
    systemPrompt: run.systemPrompt,
    projectInstructionsEnabled: run.projectInstructionsEnabled,
    projectClaudeInstructionsEnabled: run.projectClaudeInstructionsEnabled === true,
    reasoningEffort: link.reasoningEffort,
    serviceTier: policy.serviceTier,
    readiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: true, claudeReady: true, cursorReady: true },
    ...(context.projectId ? { projectPath: context.executionPath } : {}),
  });
  assertCanStart();
  const launch = bridge?.launch;
  if (!launch?.toolNames.includes("message_parent") || !launch.toolNames.includes("read_parent_messages")
    || launch.toolNames.some((name) => ["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent", "send_agent_message", "accept_agent", "propose_agent_settings", "set_project_run_command", "set_project_check_command", "read_project_terminal", "get_commit_message_context", "set_commit_message"].includes(name))) {
    throw new Error("This sub-agent's parent messaging bridge is unavailable or has the wrong authority.");
  }
  const messaging = Boolean(launch?.toolNames.includes("message_parent"));
  const providerPrompt = resolved.prompt;

  if (provider === "claude" || provider === "cursor") {
    let cursorSessionId = context.cursorSessionId?.trim();
    if (provider === "cursor" && !cursorSessionId) {
      const transcript = await loadCursorTranscript(threadId);
      assertCanStart();
      if (transcript && (transcript.thread.id !== threadId || transcript.thread.modelProvider !== "cursor"
        || !transcript.thread.cwd?.trim()
        || normalizedProjectPath(transcript.thread.cwd) !== normalizedProjectPath(context.executionPath))) {
        throw new Error("The saved Cursor conversation no longer matches this sub-agent's provider or execution folder.");
      }
      cursorSessionId = transcript?.cursorSessionId?.trim();
      if (!cursorSessionId) throw new Error("This sub-agent's Cursor conversation identity is unavailable. Its existing conversation could not be resumed.");
    }
    await context.beginCheckpoint?.(threadId);
    assertCanStart();
    const systemPrompt = withChildMessaging(withMythraCodeCompletionInstructions(projectSystemPrompt), messaging);
    if (provider === "claude") {
      const startRequestId = crypto.randomUUID();
      context.onDispatch?.(startRequestId);
      const result = await startClaudeTurn({
        threadId,
        startRequestId,
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: link.reasoningEffort,
        permission: run.permission,
        systemPrompt,
        resume: true,
        attachments: [],
        subagentMax: 1,
        customAgents: [],
        ...(run.autoCompactTokens !== undefined ? { autoCompactTokens: run.autoCompactTokens } : {}),
        ...(launch ? { childAgentBridgeConfig: launch.configPath } : {}),
      });
      return { turnId: result.turnId };
    }
    // Reserve the exact renderer owner the adapter admits; its id is the
    // persisted start identity a Stop can target before any turn ID.
    const attempt = beginCursorTurnStart(threadId, useTaskStore.getState().tasks[threadId]?.activeTurnId);
    let requested = false;
    try {
      context.onDispatch?.(attempt.owner.startRequestId);
      requested = true;
      const result = await startCursorTurn({
        threadId,
        startRequestId: attempt.owner.startRequestId,
        cwd: context.executionPath,
        prompt: providerPrompt,
        model: run.model,
        effort: link.reasoningEffort,
        permission: run.permission,
        systemPrompt,
        resumeSessionId: cursorSessionId,
        attachments: [],
        ...(launch ? { childAgentBridge: { name: launch.name, command: launch.command, args: launch.args } } : {}),
      });
      return { turnId: result.turnId, superseded: result.superseded, stopped: result.stopped, cursorSessionId: result.cursorSessionId };
    } catch (reason) {
      // Only an unsent start releases its owner; an uncertain one keeps it.
      if (!requested || definitelyNotDispatched(reason)) rejectCursorTurnStart(threadId, attempt);
      throw reason;
    }
  }

  // Codex app-server destinations (OpenAI, OpenRouter, LM Studio).
  const state = await runtimeThreadState(threadId);
  assertCanStart();
  const signature = childCapabilitySignature(run.autoCompactTokens, launch, {
    provider, lmStudioBaseUrl: context.lmStudioBaseUrl, modelContextWindow: context.modelContextWindow,
  });
  const plan = planSubagentCapabilities(threadId, state.instance, signature, state.loaded);
  if (state.loaded && plan.restartRuntime) {
    throw new Error("This sub-agent is loaded with different runtime capabilities or an older parent messaging bridge. Its existing conversation must be refreshed before continuing.");
  }
  let runtimeModel: string | undefined;
  if (provider === "openrouter" || provider === "lmstudio" || plan.resume) {
    const resume = threadResumeParams(run, threadId, context.executionPath, {
      customAgents: [],
      modelContextWindow: context.modelContextWindow,
      excludeTurns: true,
      perTurnSystemPrompt: true,
      interactive: true,
      additionalWorkspaceRoots: context.additionalWorkspaceRoots,
      childAgentBridge: launch,
      refreshRuntimeConfig: true,
    });
    const resumed = await rpc<{ model?: unknown; runtimeInstance?: unknown }>("thread/resume", { ...resume, model: run.model, expectedRuntimeInstance: state.instance });
    runtimeModel = typeof resumed?.model === "string" ? resumed.model.trim() || undefined : undefined;
    if (typeof resumed?.runtimeInstance === "string" && resumed.runtimeInstance !== state.instance) {
      throw new Error("The runtime was replaced while this sub-agent was resuming. Its capabilities were not recorded; try again.");
    }
    // A warm resume ignores startup config: only a cold load proves it applied.
    recordSubagentCapabilities(threadId, state.instance, signature);
    assertCanStart();
  }
  await context.beginCheckpoint?.(threadId);
  assertCanStart();
  const params = turnStartParams(
    run,
    threadId,
    context.executionPath,
    buildTurnInput(providerPrompt, []),
    context.additionalWorkspaceRoots,
    true,
    { systemPrompt: withChildMessaging(projectSystemPrompt, messaging), model: runtimeModel },
  );
  context.onDispatch?.();
  const turn = await rpc<{ turn: Turn }>("turn/start", { ...params, expectedRuntimeInstance: state.instance });
  return { turnId: turn.turn?.id, runtimeModel };
}

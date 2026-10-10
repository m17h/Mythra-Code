import { latestCodexTurn, terminalTurnStatus } from "./useThreadHealth";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  onChildAgentRequest,
  reportChildAgentFinished,
  respondToChildAgentRequest,
  type ChildAgentRequest,
} from "../lib/agentBridge";
import {
  childAgentModel,
  childAgentAutoCompactIssue,
  childAgentReasoningEffort,
  childAgentTargetIssue,
  childLifecycle,
  childLifecycleForLink,
  isChildActive,
  sanitizeProjectSubagentSettings,
  type ChildAgentReadiness,
  type ChildAgentLink,
  type ChildAgentPolicy,
} from "../lib/childAgents";
import { childAgentPolicyForSession } from "../lib/childAgentSessions";
import { startChildAgentTurn } from "../lib/childRun";
import { auditEvent, rpc, type JsonObject } from "../lib/codex";
import { isClaudeTurnActive, killClaudeTurn, loadClaudeTranscript } from "../lib/claude";
import { isCursorTurnActive, killCursorTurn, loadCursorTranscript } from "../lib/cursor";
import { friendlyError } from "../lib/errors";
import type { ResolvedSkillPrompts } from "../lib/skills";
import { isActiveAgentRecord } from "../lib/subAgentActivity";
import { decodeHtmlEntities } from "../lib/text";
import { upsertThread } from "../lib/threadList";
import { timelineFromTurns } from "../lib/threadTimeline";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { LMStudioModel } from "../lib/lmStudio";
import type { SetPersisted } from "./usePersistedState";
import { MAX_RUN_COMMAND_LENGTH, sanitizeProjectRunCommand } from "../lib/projectRun";
import { MAX_CHECK_COMMAND_LENGTH, sanitizeProjectCheckCommand } from "../lib/projectChecks";
import { nativeDescendantIds, type NativeAgentLink } from "../lib/nativeAgentLinks";
import type { AgentRecord } from "../components/StudioDock";
import type { PendingApproval, ProjectCheckCommand, ProjectRunCommand, ProjectSubagentSettings, Provider, Thread, ThreadReasoning } from "../types";

/**
 * Routes the delegation requests a root agent makes through the Mythra Code
 * bridge into real per-provider turns.
 *
 * Every decision that could be abused lives here or in the backend, never in
 * the model's hands: the destination must be one the frozen policy approved,
 * the child inherits the parent's folder and permission mode, a child may
 * never delegate again, and the concurrency budget is the same one the
 * composer shows.
 */

/** Longest a single `collect_agent` call blocks before reporting progress. */
const DEFAULT_COLLECT_SECONDS = 45;
const MAX_COLLECT_SECONDS = 45;

/** Cap on the result text handed back to a parent model. */
const MAX_RESULT_CHARACTERS = 24_000;

export interface ChildAgentContext {
  /** Bridge sessions keyed by session id, frozen when each root thread started. */
  policies: Record<string, ChildAgentPolicy>;
  links: Record<string, ChildAgentLink>;
  /** Durable ownership for native children, including nested V2 descendants. */
  nativeLinks?: Record<string, NativeAgentLink>;
  persistNativeAgentLinks?: SetPersisted<Record<string, NativeAgentLink>>;
  persistChildAgentLinks: SetPersisted<Record<string, ChildAgentLink>>;
  openRouterModels: OpenRouterModel[];
  lmStudioModels?: LMStudioModel[];
  lmStudioBaseUrl?: string;
  readiness: ChildAgentReadiness;
  /** Logical project path a thread is bound to, before worktree resolution. */
  projectPathForThread: (threadId: string) => string | undefined;
  /** Saved-project scope for a root, never the currently selected project. */
  projectIdForThread?: (threadId: string) => string | null;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  /** Shared Git directory of a thread's isolated worktree, when it has one. */
  isolationGitDirFor: (threadId: string) => string | undefined;
  serviceNameFor: (threadId: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadReasoning: (threadId: string, reasoning: ThreadReasoning) => void;
  /** Capture this child's own context policy for later turns and renderer reloads. */
  persistThreadAutoCompactTokens?: (threadId: string, tokens?: number) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
  projectSubagentSettingsForThread: (rootThreadId: string) => ProjectSubagentSettings;
  applyProjectSubagentSettings: (rootThreadId: string, settings: ProjectSubagentSettings) => void | Promise<void>;
  /** Save (or clear, with null) the project's top-bar Run button command. */
  applyProjectRunCommand: (rootThreadId: string, run: ProjectRunCommand | null) => void | Promise<void>;
  projectRunCommandForThread: (rootThreadId: string) => ProjectRunCommand | undefined;
  /** Save or clear the project's Checks button command without running it. */
  applyProjectCheckCommand: (rootThreadId: string, check: ProjectCheckCommand | null) => void | Promise<void>;
  projectCheckCommandForThread: (rootThreadId: string) => ProjectCheckCommand | undefined;
  /**
   * Start a run command in the Terminal panel for the thread's project.
   * Resolves once the process has either exited quickly or run for a moment,
   * with the output so far, so the model can report an immediate failure.
   */
  runProjectCommand: (rootThreadId: string, run: ProjectRunCommand) => Promise<ProjectRunOutcome>;
  /** Automatic pre-turn file snapshots for child turns, same as user turns. */
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string) => void;
  /** Materialize enabled selected-folder skills for any child-provider prompt. */
  resolveSkillPrompt: (message: string) => Promise<string>;
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
}

export interface ProjectRunOutcome {
  started: boolean;
  /** Why it did not start, in words the model can relay. */
  reason?: string;
  /** True when the process already exited during the short wait. */
  exited?: boolean;
  output?: string;
}

function taskStatusOf(threadId: string): TaskStatus {
  return useTaskStore.getState().statuses[threadId] ?? "idle";
}

// Re-exported from the policy module, where the UI can reach them without
// pulling in the delegation transport.
export { childLifecycle, childLifecycleForLink, isChildActive };

/** Children of one bridge session that still hold a concurrency slot. */
export function activeChildThreadIds(sessionId: string, links: Record<string, ChildAgentLink>): string[] {
  return Object.values(links)
    .filter((link) => link.sessionId === sessionId
      && link.childThreadId !== link.rootThreadId
      && isChildActive(taskStatusOf(link.childThreadId)))
    .map((link) => link.childThreadId);
}

function lastAssistantText(threadId: string): string {
  const messages = useTaskStore.getState().tasks[threadId]?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return "";
}

async function restoreChildTimeline(link: ChildAgentLink): Promise<string> {
  if (link.provider === "claude" || link.provider === "cursor") {
    const transcript = link.provider === "claude"
      ? await loadClaudeTranscript(link.childThreadId)
      : await loadCursorTranscript(link.childThreadId);
    if (!transcript) return "";
    useTaskStore.getState().hydrateTask(
      link.childThreadId,
      transcript.messages,
      transcript.activities,
      transcript.thread.cwd,
    );
    return lastAssistantText(link.childThreadId);
  }
  const result = await rpc<{ thread: Thread }>("thread/read", { threadId: link.childThreadId, includeTurns: true });
  const timeline = timelineFromTurns(result.thread.turns, { includeContextCompaction: link.provider === "openai" });
  useTaskStore.getState().hydrateTask(link.childThreadId, timeline.messages, timeline.activities, result.thread.cwd);
  return lastAssistantText(link.childThreadId);
}

function truncateResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARACTERS) return { text, truncated: false };
  const marker = "\n… [middle omitted] …\n";
  return { text: text.slice(0, 4000) + marker + text.slice(-(MAX_RESULT_CHARACTERS - 4000 - marker.length)), truncated: true };
}

/**
 * Resolve once the child reaches a terminal state, or when the wait elapses.
 * Never rejects: a timeout is a legitimate answer the parent can act on.
 */
export function waitForChildTerminalStatus(threadId: string, timeoutMs: number): Promise<TaskStatus> {
  const current = taskStatusOf(threadId);
  if (!isChildActive(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: TaskStatus) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => finish(taskStatusOf(threadId)), timeoutMs);
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      if (state.statuses === previous.statuses) return;
      const status = state.statuses[threadId];
      if (status && !isChildActive(status)) finish(status);
    });
  });
}

/**
 * Cut a child off now.
 *
 * Stop is a promise to the user, so the subscription providers get a process
 * kill rather than a cooperative interrupt a wedged CLI could ignore; both
 * kill commands are idempotent, so a child that already exited settles quietly.
 * Codex-hosted children are real runtime threads, and `turn/interrupt` is the
 * only cutoff their runtime exposes.
 */
async function hardStopChild(provider: ChildAgentLink["provider"], childThreadId: string, turnId?: string): Promise<TaskStatus> {
  if (provider === "claude") {
    await killClaudeTurn(childThreadId);
    return confirmedLocalTerminal(childThreadId) ?? "interrupted";
  }
  if (provider === "cursor") {
    await killCursorTurn(childThreadId);
    return confirmedLocalTerminal(childThreadId) ?? "interrupted";
  }
  return stopCodexChild(childThreadId, turnId);
}

function cutoffAlreadySettled(reason: unknown): boolean {
  return /not currently running|no active task|unknown (?:thread|turn)|not found|already (?:finished|stopped|completed)|connection closed/i
    .test(friendlyError(reason));
}

function confirmedLocalTerminal(threadId: string): TaskStatus | null {
  const status = useTaskStore.getState().statuses[threadId];
  return status === "completed" || status === "interrupted" || status === "error" ? status : null;
}

function confirmedRuntimeTerminal(turn: Awaited<ReturnType<typeof latestCodexTurn>>): TaskStatus | null {
  return turn?.status === "completed" || turn?.status === "failed" || turn?.status === "interrupted"
    ? terminalTurnStatus(turn) : null;
}

/** Interrupt only a known running turn; a stale/absent turn is not a cutoff. */
async function stopCodexChild(threadId: string, knownTurnId?: string, assertNativeActivation?: () => void): Promise<TaskStatus> {
  // A resumed native agent can still carry the previous turn's terminal task.
  // Only a fresh local terminal event or a runtime read proves this turn ended.
  const initialTask = useTaskStore.getState().tasks[threadId];
  const freshLocalTerminal = () => {
    const current = useTaskStore.getState().tasks[threadId];
    if (!current || current === initialTask) return null;
    const terminal = confirmedLocalTerminal(threadId);
    // Roster/usage updates also replace the task object; that cannot make a
    // previous terminal status evidence of a new completion.
    return terminal && (current.status !== initialTask?.status
      || Boolean(initialTask?.activeTurnId && !current.activeTurnId)) ? terminal : null;
  };
  const readLatest = async () => {
    try {
      return await latestCodexTurn(threadId);
    } catch (reason) {
      throw new Error(`Could not confirm the native sub-agent's current turn: ${friendlyError(reason)}`);
    }
  };
  let turnId = knownTurnId ?? useTaskStore.getState().tasks[threadId]?.activeTurnId;
  let activationTask = initialTask;
  const assertSameActivation = () => {
    assertNativeActivation?.();
    const current = useTaskStore.getState().tasks[threadId];
    const replacedTurn = Boolean(current?.activeTurnId && current.activeTurnId !== turnId);
    // Without a local turn ID, any changed active task is uncertain. Native
    // reactivation always calls setActiveTurn(undefined), which replaces it
    // even when the repeated status/ID values are unchanged.
    const clearedForNewActivation = Boolean(current !== activationTask
      && current && !current.activeTurnId && isChildActive(current.status));
    if (replacedTurn || clearedForNewActivation) {
      throw new Error("The native sub-agent started another turn before Stop settled. Its current turn remains active.");
    }
  };
  if (!turnId) {
    const latest = await readLatest();
    const discoveredLocalTurn = useTaskStore.getState().tasks[threadId]?.activeTurnId;
    if (discoveredLocalTurn && discoveredLocalTurn !== latest?.id) {
      turnId = discoveredLocalTurn;
    }
    turnId ??= latest?.status === "inProgress" ? latest.id : undefined;
    assertSameActivation();
    const terminal = confirmedRuntimeTerminal(latest);
    if (!turnId && terminal) {
      const freshTerminal = freshLocalTerminal();
      if (freshTerminal) return freshTerminal;
      const currentTask = useTaskStore.getState().tasks[threadId];
      if (isChildActive(initialTask?.status ?? "idle") || isChildActive(currentTask?.status ?? "idle")) {
        throw new Error("Could not confirm the newly active native sub-agent's turn. The runtime only exposed an older terminal turn.");
      }
      return terminal;
    }
    if (!turnId && (latest?.status !== "inProgress" || !latest.id)) {
      throw new Error("Could not confirm an active turn for this native sub-agent. Its stop status remains unknown.");
    }
    turnId ??= latest?.id;
  }
  activationTask = useTaskStore.getState().tasks[threadId];
  try {
    await rpc("turn/interrupt", { threadId, turnId });
  } catch (reason) {
    assertSameActivation();
    const terminal = freshLocalTerminal();
    if (terminal) return terminal;
    if (cutoffAlreadySettled(reason)) {
      const latest = await readLatest();
      assertSameActivation();
      const settled = confirmedRuntimeTerminal(latest);
      if (settled) return settled;
    }
    throw new Error(`Could not confirm the native sub-agent stopped: ${friendlyError(reason)}`);
  }
  assertSameActivation();
  const terminal = freshLocalTerminal();
  if (terminal) return terminal;
  return "interrupted";
}

type NativeChild = AgentRecord & { rootThreadId: string };

function assertNativeChildActivation(agent: NativeChild): void {
  const current = useTaskStore.getState().tasks[agent.rootThreadId]?.agents.find((entry) => entry.id === agent.id);
  if (current?.activationId !== agent.activationId) {
    throw new Error("The native sub-agent received another activation before Stop settled. Its current work remains active.");
  }
}

/** Include durable descendants even when their conversations are not loaded. */
function nativeChildrenFor(rootThreadId: string, links: Record<string, NativeAgentLink> = {}): NativeChild[] {
  const tasks = useTaskStore.getState().tasks;
  const children = new Map<string, NativeChild>();
  const parents = [rootThreadId, ...nativeDescendantIds(links, rootThreadId)];
  const seen = new Set<string>();
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index];
    if (seen.has(parent)) continue;
    seen.add(parent);
    const link = links[parent];
    if (parent !== rootThreadId && link) {
      children.set(parent, {
        id: parent, rootThreadId: link.rootThreadId, prompt: link.title,
        status: link.status ?? "unknown", provider: link.provider, runtime: link.runtime, model: link.model, createdAt: link.createdAt,
      });
    }
    for (const agent of tasks[parent]?.agents ?? []) {
      if (agent.id === rootThreadId || agent.id === parent) continue;
      const owner = links[agent.id]?.rootThreadId ?? parent;
      if (owner !== parent) continue;
      children.set(agent.id, { ...children.get(agent.id), ...agent, rootThreadId: owner });
      if (!seen.has(agent.id)) parents.push(agent.id);
    }
  }
  // Prefer hydrated records to durable status, regardless of graph traversal order.
  return [...children.values()].map((child) => {
    const hydrated = { ...child, ...tasks[child.rootThreadId]?.agents.find((agent) => agent.id === child.id) };
    const ownStatus = tasks[child.id]?.status;
    // A user can reopen and run the child independently of its parent. The
    // child's current activation outranks a settled parent roster/link.
    return { ...hydrated, ...(ownStatus && isChildActive(ownStatus) ? { status: ownStatus } : {}), rootThreadId: child.rootThreadId };
  });
}

function settleStoppedChild(rootThreadId: string, childThreadId: string, prompt: string, status: TaskStatus): void {
  const store = useTaskStore.getState();
  store.setActiveTurn(childThreadId, undefined);
  store.setTaskStatus(childThreadId, status);
  const activityStatus = status === "interrupted" ? "cancelled" : status === "error" ? "failed" : "completed";
  settleChildInParent(rootThreadId, childThreadId, prompt, status, activityStatus);
}

/**
 * Make the parent roster and every Relay card representing a child agree with
 * the provider cutoff. Spawn waves remain live while one represented sibling
 * is genuinely active, then settle when the last worker stops.
 */
function settleChildInParent(
  rootThreadId: string,
  childThreadId: string,
  prompt: string,
  agentStatus: string,
  activityStatus: "completed" | "cancelled" | "failed",
): void {
  const store = useTaskStore.getState();
  const existing = store.tasks[rootThreadId]?.agents.find((entry) => entry.id === childThreadId);
  store.upsertAgent(rootThreadId, {
    ...existing,
    id: childThreadId,
    prompt,
    status: agentStatus,
    path: existing?.path,
  });

  const latest = useTaskStore.getState();
  const rootTask = latest.tasks[rootThreadId];
  if (!rootTask) return;
  const activeAgentIds = new Set(rootTask.agents
    .filter((agent) => isActiveAgentRecord(agent.status))
    .map((agent) => agent.id));
  for (const activity of rootTask.activities) {
    if (activity.kind !== "agent" || activity.agent?.action !== "spawn") continue;
    const represented = activity.agent.threadIds ?? [];
    const representsChild = activity.id === `child-agent-${childThreadId}`
      || represented.includes(childThreadId);
    if (!representsChild) continue;
    const siblingStillActive = represented.some((id) => activeAgentIds.has(id)
      || isChildActive(latest.statuses[id] ?? "idle"));
    if (!siblingStillActive) store.upsertActivity(rootThreadId, { ...activity, status: activityStatus });
  }
}

export function useChildAgents(context: ChildAgentContext): {
  cancelChildAgentsFor: (rootThreadId: string) => Promise<void>;
  stopChildAgent: (rootThreadId: string, childThreadId: string) => Promise<void>;
  respondToSettingsProposal: (approval: PendingApproval, result: JsonObject) => Promise<void>;
  /**
   * Whether a provider is still starting a child for this root, before the
   * child's durable ownership link exists. Archive and delete must treat such
   * a root as busy: its link map and agent roster cannot see the child yet.
   */
  hasChildStartInFlight: (rootThreadId: string) => boolean;
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  /** Roots already reported finished, so a slot is released exactly once. */
  const releasedRef = useRef(new Set<string>());
  const releases = useRef(new Map<string, ChildAgentLink>());
  const releasing = useRef(new Set<string>());
  const [retryNeeded, setRetryNeeded] = useState(false);
  const releaseSlot = useCallback((link: ChildAgentLink) => {
    const id = link.childThreadId;
    releases.current.set(id, link);
    if (releasing.current.has(id)) return;
    releasing.current.add(id);
    void reportChildAgentFinished(link.sessionId, id).then(() => {
      releases.current.delete(id);
      if (!releases.current.size) setRetryNeeded(false);
    }).catch(() => setRetryNeeded(true)).finally(() => releasing.current.delete(id));
  }, []);
  useEffect(() => {
    if (!retryNeeded) return;
    const timer = setInterval(() => { for (const link of releases.current.values()) releaseSlot(link); }, 5000);
    return () => clearInterval(timer);
  }, [releaseSlot, retryNeeded]);
  /**
   * Children this hook created that the rendered link map has not caught up
   * with yet, keyed by bridge session. Two tool calls can arrive between
   * renders, and without this both would read the same stale map and both pass
   * the concurrency check. Entries are dropped once the link map has them.
   */
  const pendingChildrenRef = useRef<Map<string, Set<string>>>(new Map());
  /** Links written by a spawn response before React has rendered persistence. */
  const pendingLinksRef = useRef<Map<string, ChildAgentLink>>(new Map());
  /** Monotonic per-root stop generation. A child whose provider start resolves
   * after Stop was pressed is killed before it can escape into the background. */
  const stopGenerationRef = useRef<Map<string, number>>(new Map());
  /**
   * Provider starts in progress per root. A start holds this from the moment
   * the provider is asked until the child's ownership link is persisted, the
   * window in which neither the link map nor the agent roster knows the child.
   */
  const inFlightStartsRef = useRef<Map<string, number>>(new Map());
  const hasChildStartInFlight = useCallback(
    (rootThreadId: string): boolean => (inFlightStartsRef.current.get(rootThreadId) ?? 0) > 0,
    [],
  );

  const linksIncludingPending = useCallback((links: Record<string, ChildAgentLink>): Record<string, ChildAgentLink> => {
    if (!pendingLinksRef.current.size) return links;
    return { ...links, ...Object.fromEntries(pendingLinksRef.current) };
  }, []);

  const persistNativeSettlement = useCallback((expected: NativeAgentLink | undefined, status: TaskStatus) => {
    if (!expected) return;
    contextRef.current.persistNativeAgentLinks?.((current) => {
      const latest = current[expected.childThreadId];
      if (!latest || latest.rootThreadId !== expected.rootThreadId || latest.rootTurnId !== expected.rootTurnId || latest.createdAt !== expected.createdAt
        || latest.activationId !== expected.activationId || latest.status !== expected.status) return current;
      return {
        ...current,
        [expected.childThreadId]: { ...latest, status, finishedAt: isActiveAgentRecord(expected.status ?? "unknown") ? latest.finishedAt ?? Date.now() : Date.now() },
      };
    });
  }, []);

  /** Live child count for a session, counting spawns still settling. */
  const reservedChildCount = useCallback((
    sessionId: string,
    rootThreadId: string,
    links: Record<string, ChildAgentLink>,
  ): number => {
    const pending = pendingChildrenRef.current.get(sessionId);
    if (pending) {
      for (const childThreadId of [...pending]) {
        if (!childThreadId.startsWith("pending-")
          && (links[childThreadId] || !isChildActive(taskStatusOf(childThreadId)))) pending.delete(childThreadId);
      }
      if (!pending.size) pendingChildrenRef.current.delete(sessionId);
    }
    const crossProviderIds = new Set([
      ...Object.values(links).filter((link) => link.sessionId === sessionId).map((link) => link.childThreadId),
      ...(pending ?? []),
    ]);
    // The budget counts children, never the root. A runtime that reported the
    // root as one of its own agents would otherwise burn a slot the user's
    // limit was meant to give to real delegated work.
    const nativeActive = (useTaskStore.getState().tasks[rootThreadId]?.agents ?? []).filter((agent) => (
      agent.id !== rootThreadId && !crossProviderIds.has(agent.id) && isActiveAgentRecord(agent.status)
    )).length;
    return activeChildThreadIds(sessionId, links).length + (pending?.size ?? 0) + nativeActive;
  }, []);

  const spawnChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const currentLinks = linksIncludingPending(ctx.links);
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy) throw new Error("This thread is not allowed to start sub-agents.");
    const rootThreadId = policy.rootThreadId;
    if (!rootThreadId) throw new Error("This thread has not finished starting yet.");
    // Depth one. A thread that is itself a child never receives a bridge, so
    // this only fires if a stale bridge process outlived its root thread.
    if (currentLinks[rootThreadId]) throw new Error("A sub-agent cannot start further sub-agents.");

    const targetId = String(request.arguments.target ?? "");
    const target = policy.targets.find((entry) => entry.id === targetId);
    if (!target || !target.enabled) {
      throw new Error(`\`${targetId}\` is not an approved destination for this thread.`);
    }
    const compactionError = childAgentAutoCompactIssue(target);
    if (compactionError) throw new Error(compactionError);
    const prompt = String(request.arguments.prompt ?? "").trim();
    if (!prompt) throw new Error("`prompt` is required.");
    const title = decodeHtmlEntities(String(request.arguments.title ?? "").trim() || prompt.slice(0, 80));
    const reasoningEffort = childAgentReasoningEffort(
      target,
      policy.reasoningEffort,
      request.arguments.reasoningEffort,
    );
    const targetSystemPrompt = policy.providerSystemPrompts?.[target.provider];

    const reservation = `pending-${crypto.randomUUID()}`;
    const stopGeneration = stopGenerationRef.current.get(rootThreadId) ?? 0;
    const active = reservedChildCount(policy.sessionId, rootThreadId, currentLinks);
    if (active >= policy.maxConcurrent) {
      throw new Error(
        `This thread already has ${active} sub-agent${active === 1 ? "" : "s"} running, which is its configured maximum.`,
      );
    }

    const logicalPath = ctx.projectPathForThread(rootThreadId);
    if (!logicalPath) throw new Error("Mythra Code no longer knows which project folder this thread belongs to.");
    const executionPath = ctx.executionPathFor(rootThreadId, logicalPath);
    const gitDir = ctx.isolationGitDirFor(rootThreadId);

    const pending = pendingChildrenRef.current.get(policy.sessionId) ?? new Set<string>();
    pending.add(reservation);
    pendingChildrenRef.current.set(policy.sessionId, pending);
    const inFlight = inFlightStartsRef.current;
    inFlight.set(rootThreadId, (inFlight.get(rootThreadId) ?? 0) + 1);
    let startSettled = false;
    const settleStart = () => {
      if (startSettled) return;
      startSettled = true;
      const remaining = (inFlight.get(rootThreadId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(rootThreadId, remaining);
      else inFlight.delete(rootThreadId);
    };
    let result;
    try {
      result = await startChildAgentTurn(target, prompt, {
        policy,
        executionPath,
        additionalWorkspaceRoots: gitDir ? [gitDir] : [],
        systemPrompt: targetSystemPrompt ?? policy.systemPrompt,
        projectId: ctx.projectIdForThread?.(rootThreadId) ?? null,
        projectInstructionsEnabled: policy.projectInstructionsEnabled,
        reasoningEffort,
        serviceTier: policy.serviceTier,
        serviceName: ctx.serviceNameFor(rootThreadId),
        modelContextWindow: target.provider === "openrouter"
          ? ctx.openRouterModels.find((entry) => entry.id === childAgentModel(target))?.context_length
          : target.provider === "lmstudio"
            ? ctx.lmStudioModels?.find((entry) => entry.id === childAgentModel(target))?.maxContextLength
            : undefined,
        lmStudioBaseUrl: ctx.lmStudioBaseUrl,
        resolveSkillPrompt: ctx.resolveSkillPrompt,
        resolveSkillPrompts: ctx.resolveSkillPrompts,
        isStartCancelled: () => (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration
          || !childAgentPolicyForSession(contextRef.current.policies, request.sessionId),
        beginCheckpoint: async (childThreadId) => {
          await ctx.beginRunCheckpoint(childThreadId, executionPath, prompt, target.provider, childAgentModel(target));
        },
        discardCheckpoint: ctx.discardRunCheckpoint,
      });
    } catch (reason) {
      settleStart();
      throw reason;
    } finally {
      pending.delete(reservation);
    }
    // Hold the slot under the real child id until the rendered link map has it.
    pending.add(result.thread.id);
    pendingChildrenRef.current.set(policy.sessionId, pending);

    const childThreadId = result.thread.id;
    const stoppedWhileStarting = (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration;
    // The root was deleted while the provider was starting: its frozen policy
    // (and the live session cache) are gone. The child is still recorded and
    // cut off below, exactly like a Stop, so it can never run unowned.
    const rootForgotten = !childAgentPolicyForSession(contextRef.current.policies, request.sessionId);
    ctx.bindThreadToProject(childThreadId, logicalPath);
    ctx.rememberThread(result.thread);
    ctx.setThreads((current) => upsertThread(current, result.thread));
    ctx.persistThreadModel(childThreadId, result.model);
    ctx.persistThreadReasoning(childThreadId, { reasoningEffort, ultra: false });
    ctx.persistThreadAutoCompactTokens?.(childThreadId, target.autoCompactTokens);
    if (result.cursorSessionId) ctx.cursorSessionIdsRef.current[childThreadId] = result.cursorSessionId;

    const taskStore = useTaskStore.getState();
    taskStore.ensureTask(childThreadId, executionPath);
    taskStore.appendUserMessage(childThreadId, { id: `local-${crypto.randomUUID()}`, role: "user", text: prompt, turnId: result.turnId, skillReferences: result.skillReferences, skillsFolder: result.skillsFolder, skillDependencies: result.skillDependencies });
    const completedBeforeStartReturned = Boolean(
      result.turnId && taskStore.tasks[childThreadId]?.lastCompletedTurnId === result.turnId,
    );
    if (result.turnId && !completedBeforeStartReturned) taskStore.setActiveTurn(childThreadId, result.turnId);
    if (!completedBeforeStartReturned) {
      taskStore.setTaskStatus(childThreadId, "running");
    }
    const lifecycle = childLifecycle(taskStatusOf(childThreadId));
    taskStore.upsertAgent(rootThreadId, {
      id: childThreadId,
      prompt: title,
      status: isChildActive(taskStatusOf(childThreadId)) ? "inProgress" : lifecycle,
      path: `${target.provider} · ${childAgentModel(target) || "default"}`,
    });
    taskStore.upsertActivity(rootThreadId, {
      id: `child-agent-${childThreadId}`,
      kind: "agent",
      title: `Spawned ${target.label || target.id} sub-agent`,
      detail: `${target.provider} · ${childAgentModel(target) || "provider default"}\n${title}`,
      status: isChildActive(taskStatusOf(childThreadId)) ? "inProgress" : lifecycle,
      agent: {
        action: "spawn",
        provider: target.provider,
        model: childAgentModel(target),
        task: title,
        count: 1,
        threadIds: [childThreadId],
      },
    });
    if (result.provider === "claude") ctx.scheduleClaudeThreadSave(childThreadId);
    if (result.provider === "cursor") ctx.scheduleCursorThreadSave(childThreadId);

    const link: ChildAgentLink = {
      ...(result.languageSessionId ? { languageSessionId: result.languageSessionId } : {}),
      childThreadId,
      rootThreadId,
      sessionId: policy.sessionId,
      targetId: target.id,
      provider: target.provider,
      model: childAgentModel(target),
      reasoningEffort,
      title,
      createdAt: Date.now(),
      ...(!isChildActive(taskStatusOf(childThreadId))
        ? { terminalStatus: lifecycle as "completed" | "cancelled" | "failed", finishedAt: Date.now() }
        : {}),
    };
    releasedRef.current.delete(childThreadId);
    pendingLinksRef.current.set(childThreadId, link);
    ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: link }));
    // The durable ownership record now exists, so archive and delete can see
    // this child through the link map from here on.
    settleStart();
    void auditEvent("childAgent.spawned", {
      target: target.id,
      provider: target.provider,
      model: link.model,
      reasoningEffort,
      childThreadId,
    }, rootThreadId);

    // Stop landed while the provider was still starting this child. Install
    // the ownership record before the cutoff so a provider failure can never
    // leave invisible work editing the project. Only claim success after the
    // provider confirms the hard cutoff; otherwise the still-live child stays
    // in the roster for the user to see and retry stopping.
    if (stoppedWhileStarting || rootForgotten) {
      try {
        if (isChildActive(taskStatusOf(childThreadId))) {
          const status = await hardStopChild(target.provider, childThreadId, result.turnId);
          settleStoppedChild(rootThreadId, childThreadId, title, status);
          const terminalStatus = status === "interrupted" ? "cancelled" : status === "error" ? "failed" : "completed";
          const interrupted: ChildAgentLink = { ...link, terminalStatus, finishedAt: Date.now() };
          pendingLinksRef.current.set(childThreadId, interrupted);
          ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: interrupted }));
        }
      } catch (reason) {
        throw new Error(`The run was stopped, but Mythra Code could not confirm the ${target.label || target.id} sub-agent cutoff: ${friendlyError(reason)}. It remains visible in Live agents so you can stop it again.`);
      }
      throw new Error(rootForgotten
        ? "This thread was removed while the sub-agent was starting, so the sub-agent was stopped."
        : "The user stopped this run while the sub-agent was starting.");
    }

    return {
      childId: childThreadId,
      target: target.id,
      provider: target.provider,
      model: link.model,
      reasoningEffort,
      status: lifecycle,
      note: "The child runs in this thread's workspace under the same permission policy. Use collect_agent to read its result.",
    };
  }, [linksIncludingPending, reservedChildCount]);

  const reportStatus = useCallback((request: ChildAgentRequest): Record<string, unknown> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const links = Object.values(linksIncludingPending(ctx.links)).filter((link) => link.sessionId === request.sessionId
      && (!childId || link.childThreadId === childId));
    return {
      children: links.map((link) => {
        const status = childLifecycleForLink(link, taskStatusOf(link.childThreadId));
        const error = useTaskStore.getState().tasks[link.childThreadId]?.error;
        return {
          childId: link.childThreadId,
          target: link.targetId,
          provider: link.provider,
          model: link.model,
          reasoningEffort: link.reasoningEffort,
          title: link.title,
          status,
          ...(error ? { error } : {}),
          ...(status === "failed" ? {
            retryable: true,
            recovery: "Inspect the error, then use spawn_mythra_agent with a corrected self-contained prompt or another approved destination. Collect the replacement before finishing.",
          } : {}),
        };
      }),
    };
  }, [linksIncludingPending]);

  const collectChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(ctx.links)[childId];
    if (!link || link.sessionId !== request.sessionId) {
      throw new Error(`\`${childId}\` was not started from this thread.`);
    }
    if (taskStatusOf(childId) === "idle" && !link.terminalStatus) {
      let recovered: TaskStatus | null = null;
      if (link.provider === "claude" || link.provider === "cursor") {
        const active = await (link.provider === "claude" ? isClaudeTurnActive(childId) : isCursorTurnActive(childId));
        if (active) return { childId, status: "running", result: "", note: "Still working. Collect again to wait for the result." };
        await restoreChildTimeline(link);
        const last = useTaskStore.getState().tasks[childId]?.messages.at(-1)?.turnStatus;
        recovered = last === "completed" ? "completed" : last === "failed" ? "error" : "interrupted";
      } else {
        const turn = await latestCodexTurn(childId);
        recovered = terminalTurnStatus(turn);
        if (!recovered) return { childId, status: turn?.status === "inProgress" ? "running" : "unknown", result: "", note: "Awaiting runtime status. Collect again to check." };
      }
      if (taskStatusOf(childId) === "idle") useTaskStore.getState().setTaskStatus(childId, recovered);
    }
    const requested = Number(request.arguments.timeoutSeconds);
    const seconds = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_COLLECT_SECONDS, requested)
      : DEFAULT_COLLECT_SECONDS;
    const waitId = `child-wait-${request.requestId}`;
    const waiting = isChildActive(taskStatusOf(childId));
    if (waiting) useTaskStore.getState().upsertActivity(link.rootThreadId, {
      id: waitId, kind: "agent", title: `Waiting for sub-agent: ${link.title}`, status: "inProgress",
      agent: { action: "wait", threadIds: [childId] },
    });
    let status: TaskStatus;
    try { status = await waitForChildTerminalStatus(childId, seconds * 1000); }
    finally {
      if (waiting) useTaskStore.getState().upsertActivity(link.rootThreadId, {
        id: waitId, kind: "agent", title: `Checked sub-agent: ${link.title}`, status: "completed",
        agent: { action: "wait", threadIds: [childId] },
      });
    }
    const lifecycle = childLifecycleForLink(link, status);
    if (isChildActive(status) || (status === "idle" && !link.terminalStatus)) {
      return { childId, status: lifecycle, result: "", note: "Still working. Call collect_agent again to keep waiting." };
    }
    const storedText = lastAssistantText(childId) || await restoreChildTimeline(link).catch(() => "");
    const { text, truncated } = truncateResult(storedText);
    return {
      childId,
      target: link.targetId,
      provider: link.provider,
      model: link.model,
      status: lifecycle,
      result: text,
      ...(!text ? { note: "No final text was returned. Inspect the sub-agent task for tool activity or errors." } : {}),
      truncated,
      ...(useTaskStore.getState().tasks[childId]?.error ? { error: useTaskStore.getState().tasks[childId]?.error } : {}),
      ...(lifecycle === "failed" ? {
        retryable: true,
        recovery: "Retry this work with spawn_mythra_agent using a corrected self-contained prompt or another approved destination, then collect the replacement before finishing.",
      } : {}),
    };
  }, [linksIncludingPending]);

  /**
   * Stop exactly one child from the command center or the model bridge.
   *
   * Cross-provider children have a durable ownership link and use their
   * provider-specific interrupt path. Codex-native children are first-class
   * runtime threads, so their latest turn can be discovered before interrupting.
   * Claude native children share the root process and cannot be stopped alone.
   */
  const stopChildAgent = useCallback(async (rootThreadId: string, childThreadId: string): Promise<void> => {
    const ctx = contextRef.current;
    const link = linksIncludingPending(ctx.links)[childThreadId];
    let status: TaskStatus;
    let parentThreadId = rootThreadId;
    let prompt = link?.title ?? "Delegated task";
    if (link) {
      if (link.rootThreadId !== rootThreadId) {
        throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      }
      if (!isChildActive(taskStatusOf(childThreadId))) {
        const terminalStatus = childLifecycleForLink(link, taskStatusOf(childThreadId)) as "completed" | "cancelled" | "failed";
        settleChildInParent(rootThreadId, childThreadId, link.title, terminalStatus, terminalStatus);
        return;
      }
      status = await hardStopChild(link.provider, childThreadId);
    } else {
      const agent = nativeChildrenFor(rootThreadId, ctx.nativeLinks).find((entry) => entry.id === childThreadId);
      if (!agent) throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      if (agent.runtime === "claude" || agent.provider === "claude" || childThreadId.startsWith("claude-native:")) {
        throw new Error("Claude native sub-agents share their root process. Stop the root thread to stop them.");
      }
      parentThreadId = agent.rootThreadId;
      prompt = agent.prompt;
      status = await stopCodexChild(childThreadId, undefined, () => assertNativeChildActivation(agent));
    }

    settleStoppedChild(parentThreadId, childThreadId, prompt, status);
    if (!link) persistNativeSettlement(ctx.nativeLinks?.[childThreadId], status);
    void auditEvent("childAgent.stopped", { rootThreadId, childThreadId, kind: link ? "cross-provider" : "native" });
  }, [linksIncludingPending, persistNativeSettlement]);

  const cancelChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(ctx.links)[childId];
    if (!link || link.sessionId !== request.sessionId) {
      throw new Error(`\`${childId}\` was not started from this thread.`);
    }
    if (!isChildActive(taskStatusOf(childId))) {
      return { childId, status: childLifecycleForLink(link, taskStatusOf(childId)), note: "That sub-agent had already finished." };
    }
    await stopChildAgent(link.rootThreadId, childId);
    return { childId, status: "cancelled" };
  }, [linksIncludingPending, stopChildAgent]);

  const proposeSettings = useCallback((request: ChildAgentRequest): Record<string, unknown> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This thread is not attached to a project sub-agent policy.");
    const current = ctx.projectSubagentSettingsForThread(policy.rootThreadId);
    const proposedEnabled = typeof request.arguments.enabled === "boolean" ? request.arguments.enabled : current.enabled;
    const rawTargets = Array.isArray(request.arguments.targets)
      ? request.arguments.targets.map((target) => ({ ...(target as Record<string, unknown>), enabled: true }))
      : current.childAgents.targets;
    if (Array.isArray(request.arguments.targets)) {
      for (const candidate of rawTargets) {
        const error = childAgentAutoCompactIssue(candidate as unknown as import("../types").ChildAgentTarget);
        if (error) throw new Error(error);
      }
    }
    const next = sanitizeProjectSubagentSettings({
      // Older tool clients can still send the removed secondary switch.
      // Treat an explicit revocation as the single main switch being off.
      enabled: proposedEnabled && request.arguments.crossProviderEnabled !== false,
      maxConcurrent: request.arguments.maxConcurrent ?? current.maxConcurrent,
      childAgents: { targets: rawTargets },
    });
    if (!next) throw new Error("The proposed project sub-agent settings were invalid.");
    // Only the destinations this proposal would actually switch on have to be
    // usable. A project that keeps a signed-out destination parked and
    // disabled must not block an unrelated change to the parallel limit.
    const proposedCrew = next.childAgents.targets.filter((target) => target.enabled);
    if (next.enabled && next.childAgents.enabled) {
      for (const target of proposedCrew) {
        const issue = childAgentTargetIssue(target, ctx.readiness);
        if (issue) throw new Error(`The proposed \`${target.id}\` destination is not ready: ${issue}`);
      }
    }
    if (next.enabled && next.childAgents.enabled && !proposedCrew.length) {
      throw new Error("Enable at least one configured sub-agent, or propose `enabled: false` to switch sub-agents off.");
    }
    // One project change can be in front of the user at a time. Without this a
    // model that re-proposes on every tool result would bury the approval it
    // is waiting for under its own retries.
    const outstanding = (useTaskStore.getState().tasks[policy.rootThreadId]?.approvals ?? [])
      .some((approval) => approval.method === "openkiwi/subagents/change");
    if (outstanding) {
      throw new Error("A sub-agent settings change is already waiting for the user. Continue with the approved crew until they answer it.");
    }

    const approvalId = `openkiwi-subagents-${request.requestId}`;
    // The reason is the one free-text field a model controls in this dialog.
    // Collapsing its whitespace keeps it a single explanatory line, so it
    // cannot be laid out to imitate the settings block below it.
    const reason = String(request.arguments.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    const crew = proposedCrew
      .map((target) => {
        const reasoning = target.reasoningMode === "fixed"
          ? `fixed ${target.reasoningEffort}`
          : target.reasoningMode === "agent"
            ? `agent decides up to ${target.reasoningMaxEffort}`
            : "inherits parent";
        const compaction = target.autoCompactTokens === undefined ? "auto-compaction: provider default" : `auto-compaction: ${target.autoCompactTokens.toLocaleString("en-US")} tokens`;
        return `${target.label || target.id}: ${target.provider} / ${childAgentModel(target) || "provider default"} / ${reasoning} / ${compaction}`;
      })
      .join("\n") || "No configured sub-agents";
    useTaskStore.getState().enqueueApproval({
      id: approvalId,
      method: "openkiwi/subagents/change",
      threadId: policy.rootThreadId,
      receivedAt: Date.now(),
      params: {
        title: "Update this project's sub-agents?",
        reason: reason || "The agent requested a project sub-agent crew change.",
        // Everything below the reason is written by Mythra Code from the
        // sanitized settings, so the model cannot dress up what it is asking
        // for — including how long the change lasts.
        command: [
          "Scope: crew and limit saved for this project; spawning switch applies only to this thread, from your next message onward",
          `Sub-agents in this thread: ${next.enabled ? "on" : "off"}`,
          `Parallel limit: ${next.maxConcurrent}`,
          crew,
        ].join("\n"),
        settings: next,
      },
    });
    return {
      approved: false,
      status: "awaiting_user",
      proposalId: approvalId,
      note: "Mythra Code is asking the user to approve this project change. Do not claim it was applied; continue only with the destinations already approved for this turn.",
    };
  }, []);

  /**
   * Apply a project sub-agent change the user just approved. The proposal is
   * re-sanitized here rather than trusted from the queued approval, so the only
   * thing the model ever influenced is what the user was shown.
   */
  const respondToSettingsProposal = useCallback(async (approval: PendingApproval, result: JsonObject): Promise<void> => {
    const decision = String(result.decision ?? "decline");
    const approved = decision === "accept" || decision === "acceptForSession" || decision === "approved" || decision === "approved_for_session";
    const note = (title: string, detail: string) => useTaskStore.getState().upsertActivity(approval.threadId, {
      id: `subagent-settings-${approval.id}`,
      kind: approved ? "agent" : "warning",
      title,
      detail,
      status: "completed",
    });
    if (!approved) {
      note("Sub-agent change declined", "The configured crew, parallel limit, and this thread's spawning switch are unchanged.");
      return;
    }
    const next = sanitizeProjectSubagentSettings(approval.params.settings);
    if (!next) throw new Error("This sub-agent settings proposal is no longer valid.");
    await contextRef.current.applyProjectSubagentSettings(approval.threadId, next);
    note(
      "Sub-agent settings updated",
      "The current turn keeps the crew it started with. Your next message runs with the approved settings.",
    );
  }, []);

  /**
   * Save what the top-bar Run button executes for this thread's project. This
   * is deliberately not an approval: nothing runs until the user clicks the
   * button, and the saved command is shown on it and in its editor.
   */
  const setRunCommand = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This conversation is not inside a saved project, so it has no Run button.");
    const rootThreadId = policy.rootThreadId;
    const command = typeof request.arguments.command === "string" ? request.arguments.command.trim() : "";
    const setupCommand = typeof request.arguments.setupCommand === "string" ? request.arguments.setupCommand.trim() : "";
    const label = typeof request.arguments.label === "string" ? request.arguments.label : "";
    const wantsRun = request.arguments.run === true;
    const existing = ctx.projectRunCommandForThread(rootThreadId);
    const activity = (title: string, detail: string, kind: "agent" | "warning" = "agent") => useTaskStore.getState().upsertActivity(rootThreadId, {
      id: `run-command-${request.requestId}`,
      kind,
      title,
      detail,
      status: "completed",
    });

    let run: ProjectRunCommand | null;
    let saved = false;
    if (command) {
      const next = sanitizeProjectRunCommand({ command, setupCommand, label });
      if (!next) throw new Error(`\`command\` must be a shell command of at most ${MAX_RUN_COMMAND_LENGTH} characters.`);
      // Re-saving an identical command is harmless, but a run request must
      // never silently replace a different saved command with a label-less
      // copy of it; the model passed a new command, so that is what it wants.
      if (!existing || existing.command !== next.command || existing.setupCommand !== next.setupCommand || (existing.label ?? "") !== (next.label ?? "")) {
        await ctx.applyProjectRunCommand(rootThreadId, next);
        saved = true;
      }
      run = next;
    } else if (wantsRun) {
      if (!existing) throw new Error("Nothing is saved for the Run button yet. Pass the command to run; it is saved for next time.");
      run = existing;
    } else {
      await ctx.applyProjectRunCommand(rootThreadId, null);
      activity("Run button cleared", "The top-bar Run button has no command for this project now.");
      void auditEvent("project.runCommand.set", { command: null }, rootThreadId);
      return { saved: true, command: null, note: "The Run button is now cleared for this project." };
    }
    if (saved) void auditEvent("project.runCommand.set", { command: run.command }, rootThreadId);

    if (!wantsRun) {
      activity("Run button updated", `Click Run in the top bar to execute: ${run.command}`);
      return { saved: true, command: run.command, setupCommand: run.setupCommand ?? null, label: run.label ?? null, note: "Saved for this project. Nothing was executed; the user runs it by clicking the Run button in the top bar." };
    }

    const outcome = await ctx.runProjectCommand(rootThreadId, run);
    if (!outcome.started) {
      activity("Run command not started", outcome.reason ?? "The Terminal panel could not start it.", "warning");
      return { saved, command: run.command, setupCommand: run.setupCommand ?? null, label: run.label ?? null, started: false, reason: outcome.reason ?? "The Terminal panel could not start it." };
    }
    activity(saved ? "Run button set and started" : "Run button started", `Running in the Terminal panel: ${run.command}`);
    void auditEvent("project.run", { command: run.command, source: "model" }, rootThreadId);
    return {
      saved,
      command: run.command,
      setupCommand: run.setupCommand ?? null,
      label: run.label ?? null,
      started: true,
      exited: Boolean(outcome.exited),
      output: (outcome.output ?? "").slice(-1_500),
      note: outcome.exited
        ? "The command already exited; read the output above before telling the user it works."
        : "Running in the app's Terminal panel. The user can stop it with the Stop button next to Run in the top bar; you cannot see further output from here.",
    };
  }, []);

  const setCheckCommand = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This conversation is not inside a saved project, so it has no Checks button.");
    const rootThreadId = policy.rootThreadId;
    if (typeof request.arguments.command !== "string") throw new Error("`command` must be a string.");
    const command = request.arguments.command.trim();
    if (command.length > MAX_CHECK_COMMAND_LENGTH) throw new Error("`command` is too long for the Checks button.");
    const current = ctx.projectCheckCommandForThread(rootThreadId);
    if (current?.command === command) return { saved: false, command, note: "This command is already saved for the project." };
    const next = command ? sanitizeProjectCheckCommand({ command }) : null;
    if (command && !next) throw new Error("`command` is not a valid shell command.");
    await ctx.applyProjectCheckCommand(rootThreadId, next ?? null);
    useTaskStore.getState().upsertActivity(rootThreadId, {
      id: `check-command-${request.requestId}`,
      kind: "agent",
      title: next ? "Checks command updated" : "Checks command cleared",
      detail: next ? `Checks button will run: ${next.command}` : "No check command is saved for this project.",
      status: "completed",
    });
    void auditEvent("project.checkCommand.set", { command: next?.command ?? null }, rootThreadId);
    return { saved: true, command: next?.command ?? null, note: "Saved for this project. Nothing was executed." };
  }, []);

  const handleRequest = useCallback(async (request: ChildAgentRequest): Promise<void> => {
    try {
      let result: Record<string, unknown>;
      if (request.tool === "spawn_mythra_agent") result = await spawnChild(request);
      else if (request.tool === "agent_status") result = reportStatus(request);
      else if (request.tool === "collect_agent") result = await collectChild(request);
      else if (request.tool === "cancel_agent") result = await cancelChild(request);
      else if (request.tool === "propose_agent_settings") result = await proposeSettings(request);
      else if (request.tool === "set_project_run_command") result = await setRunCommand(request);
      else if (request.tool === "set_project_check_command") result = await setCheckCommand(request);
      else throw new Error(`\`${request.tool}\` is not a sub-agent tool.`);
      await respondToChildAgentRequest(request.requestId, result);
    } catch (reason) {
      const message = friendlyError(reason);
      void auditEvent("childAgent.rejected", { tool: request.tool, reason: message });
      // A refusal is delivered as a tool result, not a transport failure, so
      // the parent model can read why and choose a different destination.
      await respondToChildAgentRequest(request.requestId, null, message).catch(() => undefined);
    }
  }, [cancelChild, collectChild, proposeSettings, reportStatus, setCheckCommand, setRunCommand, spawnChild]);

  // Tauri events are fire-and-forget. Re-subscribing this listener whenever a
  // child changes state creates a small window with no receiver at all; a tool
  // call emitted in that window then waits until the backend relay timeout and
  // can strand the parent provider inside `collect_agent`. Keep one listener
  // for the lifetime of the hook and route it through the newest callback.
  const handleRequestRef = useRef(handleRequest);
  handleRequestRef.current = handleRequest;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onChildAgentRequest((request) => { void handleRequestRef.current(request); })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Once React sees a just-created persisted link, the temporary mirror is no
  // longer needed. Keeping the mirror until then makes spawn → collect/status
  // calls safe even when both arrive before the next render.
  useEffect(() => {
    for (const childThreadId of pendingLinksRef.current.keys()) {
      if (context.links[childThreadId]) pendingLinksRef.current.delete(childThreadId);
    }
  }, [context.links, releaseSlot]);

  // Release the backend's concurrency slot as soon as a child's turn reaches a
  // terminal state, and mirror the outcome onto the parent's agent list.
  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      if (state.statuses === previous.statuses) return;
      const { links } = contextRef.current;
      for (const link of Object.values(links)) {
        const status = state.statuses[link.childThreadId];
        if (!status || status === "idle") continue;
        if (isChildActive(status)) {
          // A resumed child can become active after a persisted terminal
          // record. Reopen it so the new turn's actual outcome can settle.
          if (releasedRef.current.has(link.childThreadId)) {
            releasedRef.current.delete(link.childThreadId);
            contextRef.current.persistChildAgentLinks((current) => {
              const latest = current[link.childThreadId];
              if (!latest?.terminalStatus) return current;
              const { terminalStatus: _settled, finishedAt: _finishedAt, ...reopened } = latest;
              return { ...current, [link.childThreadId]: reopened };
            });
            const store = useTaskStore.getState();
            store.upsertAgent(link.rootThreadId, {
              id: link.childThreadId,
              prompt: link.title,
              status: childLifecycle(status),
            });
            const spawnActivity = store.tasks[link.rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${link.childThreadId}`);
            if (spawnActivity) store.upsertActivity(link.rootThreadId, { ...spawnActivity, status: "running" });
          }
          continue;
        }
        if (releasedRef.current.has(link.childThreadId)) continue;
        releasedRef.current.add(link.childThreadId);
        releaseSlot(link);
        const terminalStatus = childLifecycle(status) as "completed" | "cancelled" | "failed";
        contextRef.current.persistChildAgentLinks((current) => {
          const latest = current[link.childThreadId];
          if (!latest || latest.terminalStatus === terminalStatus) return current;
          return { ...current, [link.childThreadId]: { ...latest, terminalStatus, finishedAt: latest.finishedAt ?? Date.now() } };
        });
        settleChildInParent(
          link.rootThreadId,
          link.childThreadId,
          link.title,
          childLifecycle(status),
          terminalStatus,
        );
      }
    });
    return unsubscribe;
  }, [releaseSlot]);

  // A very fast child can finish before its persisted ownership link reaches
  // this hook. Reconcile on every link update so that early completion still
  // releases the backend slot and updates the parent's roster.
  useEffect(() => {
    for (const link of Object.values(context.links)) {
      const status = taskStatusOf(link.childThreadId);
      if ((status === "idle" && !link.terminalStatus) || isChildActive(status) || releasedRef.current.has(link.childThreadId)) continue;
      releasedRef.current.add(link.childThreadId);
      releaseSlot(link);
      const terminalStatus = childLifecycleForLink(link, status) as "completed" | "cancelled" | "failed";
      contextRef.current.persistChildAgentLinks((current) => {
        const latest = current[link.childThreadId];
        if (!latest || latest.terminalStatus === terminalStatus) return current;
        return { ...current, [link.childThreadId]: { ...latest, terminalStatus, finishedAt: latest.finishedAt ?? Date.now() } };
      });
      settleChildInParent(
        link.rootThreadId,
        link.childThreadId,
        link.title,
        terminalStatus,
        terminalStatus,
      );
    }
  }, [context.links, releaseSlot]);

  const cancelChildAgentsFor = useCallback(async (rootThreadId: string): Promise<void> => {
    stopGenerationRef.current.set(rootThreadId, (stopGenerationRef.current.get(rootThreadId) ?? 0) + 1);
    const attempted = new Set<string>();
    // Runtime-native spawns can arrive while the first cutoff wave settles.
    // Rescan a bounded number of waves, retaining visible uncertainty if the
    // runtime continues to create or reactivate work after Stop.
    for (let wave = 0; wave <= 3; wave += 1) {
      const ctx = contextRef.current;
      const allLinks = linksIncludingPending(ctx.links);
      const running = Object.values(allLinks).filter((link) => link.rootThreadId === rootThreadId
        && isChildActive(taskStatusOf(link.childThreadId)));
      const ownedIds = new Set(Object.values(allLinks)
        .filter((link) => link.rootThreadId === rootThreadId)
        .map((link) => link.childThreadId));
      const nativeChildren = nativeChildrenFor(rootThreadId, ctx.nativeLinks);
      const native = nativeChildren.filter((agent) => (
        !ownedIds.has(agent.id) && isActiveAgentRecord(agent.status)
      ));
      if (!running.length && !native.length) return;
      if (wave === 3 || [...running.map((link) => link.childThreadId), ...native.map((agent) => agent.id)].some((id) => attempted.has(id))) {
        throw new Error("Could not confirm every sub-agent stopped: the runtime created or reactivated work while Stop was settling. Remaining workers are still visible.");
      }
      for (const id of [...running.map((link) => link.childThreadId), ...native.map((agent) => agent.id)]) attempted.add(id);
      const claudeNative = native.filter((agent) => agent.runtime === "claude" || agent.provider === "claude" || agent.id.startsWith("claude-native:"));
      const claudeNativeIds = new Set(claudeNative.map((agent) => agent.id));
      const claudeParents = new Map(nativeChildren
        .filter((agent) => !ownedIds.has(agent.id) && (agent.runtime === "claude" || agent.provider === "claude" || agent.id.startsWith("claude-native:")))
        .map((agent) => [agent.id, agent.rootThreadId]));
      const claudeRoots = new Map<string, NativeChild[]>();
      for (const agent of claudeNative) {
        let processThreadId = agent.rootThreadId;
        const seen = new Set([agent.id]);
        while (claudeParents.has(processThreadId) && !seen.has(processThreadId)) {
          seen.add(processThreadId);
          processThreadId = claudeParents.get(processThreadId)!;
        }
        claudeRoots.set(processThreadId, [...(claudeRoots.get(processThreadId) ?? []), agent]);
      }
      // Dispatch every provider cutoff before awaiting any one runtime.
      const results = await Promise.allSettled([
        ...running.map(async (link) => {
          try {
            const status = await hardStopChild(link.provider, link.childThreadId);
            settleStoppedChild(rootThreadId, link.childThreadId, link.title, status);
          } catch (reason) {
            throw new Error(`Could not stop ${link.title}: ${friendlyError(reason)}`);
          }
        }),
        ...native.filter((agent) => !claudeNativeIds.has(agent.id)).map(async (agent) => {
          try {
            const status = await stopCodexChild(agent.id, undefined, () => assertNativeChildActivation(agent));
            settleStoppedChild(agent.rootThreadId, agent.id, agent.prompt, status);
            persistNativeSettlement(ctx.nativeLinks?.[agent.id], status);
          } catch (reason) {
            throw new Error(`Could not stop ${agent.prompt || "native sub-agent"}: ${friendlyError(reason)}`);
          }
        }),
        ...[...claudeRoots].map(async ([processThreadId, agents]) => {
          const rootTurnId = useTaskStore.getState().tasks[processThreadId]?.activeTurnId;
          await killClaudeTurn(processThreadId);
          const currentTurnId = useTaskStore.getState().tasks[processThreadId]?.activeTurnId;
          if (currentTurnId && currentTurnId !== rootTurnId) {
            throw new Error("Claude started another root turn while Stop was settling. Native worker status remains unknown.");
          }
          for (const agent of agents) {
            const current = useTaskStore.getState().tasks[agent.rootThreadId]?.agents.find((entry) => entry.id === agent.id);
            if (current && !isActiveAgentRecord(current.status)) continue;
            if (current?.createdAt !== undefined && agent.createdAt !== undefined && current.createdAt !== agent.createdAt) {
              throw new Error("A newer Claude native worker appeared while Stop was settling. Its status remains unknown.");
            }
            // Synthetic Claude IDs never create independent app thread state.
            settleChildInParent(agent.rootThreadId, agent.id, agent.prompt, "interrupted", "cancelled");
            persistNativeSettlement(ctx.nativeLinks?.[agent.id], "interrupted");
          }
        }),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [friendlyError(result.reason)] : []);
      if (failures.length) throw new Error(failures.join("\n"));
    }
  }, [linksIncludingPending, persistNativeSettlement]);

  return { cancelChildAgentsFor, hasChildStartInFlight, respondToSettingsProposal, stopChildAgent };
}

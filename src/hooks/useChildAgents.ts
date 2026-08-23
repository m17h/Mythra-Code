import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  onChildAgentRequest,
  reportChildAgentFinished,
  respondToChildAgentRequest,
  type ChildAgentRequest,
} from "../lib/agentBridge";
import {
  childAgentModel,
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
import { killClaudeTurn, loadClaudeTranscript } from "../lib/claude";
import { killCursorTurn, loadCursorTranscript } from "../lib/cursor";
import { friendlyError } from "../lib/errors";
import { isActiveAgentRecord } from "../lib/subAgentActivity";
import { decodeHtmlEntities } from "../lib/text";
import { upsertThread } from "../lib/threadList";
import { timelineFromTurns } from "../lib/threadTimeline";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { LMStudioModel } from "../lib/lmStudio";
import type { SetPersisted } from "./usePersistedState";
import type { PendingApproval, ProjectSubagentSettings, Thread, ThreadReasoning } from "../types";

/**
 * Routes the delegation requests a root agent makes through the OpenKiwi
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
  persistChildAgentLinks: SetPersisted<Record<string, ChildAgentLink>>;
  openRouterModels: OpenRouterModel[];
  lmStudioModels?: LMStudioModel[];
  lmStudioBaseUrl?: string;
  readiness: ChildAgentReadiness;
  /** Logical project path a thread is bound to, before worktree resolution. */
  projectPathForThread: (threadId: string) => string | undefined;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  /** Shared Git directory of a thread's isolated worktree, when it has one. */
  isolationGitDirFor: (threadId: string) => string | undefined;
  serviceNameFor: (threadId: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadReasoning: (threadId: string, reasoning: ThreadReasoning) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
  projectSubagentSettingsForThread: (rootThreadId: string) => ProjectSubagentSettings;
  applyProjectSubagentSettings: (rootThreadId: string, settings: ProjectSubagentSettings) => void | Promise<void>;
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
  const timeline = timelineFromTurns(result.thread.turns);
  useTaskStore.getState().hydrateTask(link.childThreadId, timeline.messages, timeline.activities, result.thread.cwd);
  return lastAssistantText(link.childThreadId);
}

function truncateResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_RESULT_CHARACTERS), truncated: true };
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
async function hardStopChild(provider: ChildAgentLink["provider"], childThreadId: string, turnId?: string): Promise<void> {
  if (provider === "claude") {
    await killClaudeTurn(childThreadId);
    return;
  }
  if (provider === "cursor") {
    await killCursorTurn(childThreadId);
    return;
  }
  const activeTurnId = turnId ?? useTaskStore.getState().tasks[childThreadId]?.activeTurnId;
  if (!activeTurnId) throw new Error("That sub-agent does not have an active task to stop.");
  await rpc("turn/interrupt", { threadId: childThreadId, turnId: activeTurnId });
}

function cutoffAlreadySettled(reason: unknown): boolean {
  return /not currently running|no active task|unknown (?:thread|turn)|not found|already (?:finished|stopped|completed)|connection closed/i
    .test(friendlyError(reason));
}

export function useChildAgents(context: ChildAgentContext): {
  cancelChildAgentsFor: (rootThreadId: string) => Promise<void>;
  stopChildAgent: (rootThreadId: string, childThreadId: string) => Promise<void>;
  respondToSettingsProposal: (approval: PendingApproval, result: JsonObject) => Promise<void>;
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  /** Roots already reported finished, so a slot is released exactly once. */
  const releasedRef = useRef(new Set<string>());
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

  const linksIncludingPending = useCallback((links: Record<string, ChildAgentLink>): Record<string, ChildAgentLink> => {
    if (!pendingLinksRef.current.size) return links;
    return { ...links, ...Object.fromEntries(pendingLinksRef.current) };
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
    if (!target) {
      throw new Error(`\`${targetId}\` is not an approved destination for this thread.`);
    }
    const prompt = String(request.arguments.prompt ?? "").trim();
    if (!prompt) throw new Error("`prompt` is required.");
    const title = decodeHtmlEntities(String(request.arguments.title ?? "").trim() || prompt.slice(0, 80));
    const reasoningEffort = childAgentReasoningEffort(
      target,
      policy.reasoningEffort,
      request.arguments.reasoningEffort,
    );
    const targetSystemPrompt = target.provider === "openai" || target.provider === "claude"
      ? policy.providerSystemPrompts?.[target.provider]
      : undefined;

    const reservation = `pending-${crypto.randomUUID()}`;
    const stopGeneration = stopGenerationRef.current.get(rootThreadId) ?? 0;
    const active = reservedChildCount(policy.sessionId, rootThreadId, currentLinks);
    if (active >= policy.maxConcurrent) {
      throw new Error(
        `This thread already has ${active} sub-agent${active === 1 ? "" : "s"} running, which is its configured maximum.`,
      );
    }

    const logicalPath = ctx.projectPathForThread(rootThreadId);
    if (!logicalPath) throw new Error("OpenKiwi no longer knows which project folder this thread belongs to.");
    const executionPath = ctx.executionPathFor(rootThreadId, logicalPath);
    const gitDir = ctx.isolationGitDirFor(rootThreadId);

    const pending = pendingChildrenRef.current.get(policy.sessionId) ?? new Set<string>();
    pending.add(reservation);
    pendingChildrenRef.current.set(policy.sessionId, pending);
    let result;
    try {
      result = await startChildAgentTurn(target, prompt, {
        policy,
        executionPath,
        additionalWorkspaceRoots: gitDir ? [gitDir] : [],
        systemPrompt: targetSystemPrompt ?? policy.systemPrompt,
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
      });
    } finally {
      pending.delete(reservation);
    }
    // Hold the slot under the real child id until the rendered link map has it.
    pending.add(result.thread.id);
    pendingChildrenRef.current.set(policy.sessionId, pending);

    const childThreadId = result.thread.id;
    const stoppedWhileStarting = (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration;
    ctx.bindThreadToProject(childThreadId, logicalPath);
    ctx.rememberThread(result.thread);
    ctx.setThreads((current) => upsertThread(current, result.thread));
    ctx.persistThreadModel(childThreadId, result.model);
    ctx.persistThreadReasoning(childThreadId, { reasoningEffort, ultra: false });
    if (result.cursorSessionId) ctx.cursorSessionIdsRef.current[childThreadId] = result.cursorSessionId;

    const taskStore = useTaskStore.getState();
    taskStore.ensureTask(childThreadId, executionPath);
    taskStore.appendUserMessage(childThreadId, { id: `local-${crypto.randomUUID()}`, role: "user", text: prompt });
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
        ? { terminalStatus: lifecycle as "completed" | "cancelled" | "failed" }
        : {}),
    };
    releasedRef.current.delete(childThreadId);
    pendingLinksRef.current.set(childThreadId, link);
    ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: link }));
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
    if (stoppedWhileStarting) {
      try {
        if (isChildActive(taskStatusOf(childThreadId))) {
          await hardStopChild(target.provider, childThreadId, result.turnId);
          taskStore.setActiveTurn(childThreadId, undefined);
          taskStore.setTaskStatus(childThreadId, "interrupted");
          taskStore.upsertAgent(rootThreadId, { id: childThreadId, prompt: title, status: "interrupted" });
          const spawnActivity = taskStore.tasks[rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${childThreadId}`);
          if (spawnActivity) taskStore.upsertActivity(rootThreadId, { ...spawnActivity, status: "cancelled" });
          const interrupted = { ...link, terminalStatus: "cancelled" as const };
          pendingLinksRef.current.set(childThreadId, interrupted);
          ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: interrupted }));
        }
      } catch (reason) {
        throw new Error(`The run was stopped, but OpenKiwi could not confirm the ${target.label || target.id} sub-agent cutoff: ${friendlyError(reason)}. It remains visible in Live agents so you can stop it again.`);
      }
      throw new Error("The user stopped this run while the sub-agent was starting.");
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
            recovery: "Inspect the error, then use spawn_agent with a corrected self-contained prompt or another approved destination. Collect the replacement before finishing.",
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
    const requested = Number(request.arguments.timeoutSeconds);
    const seconds = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_COLLECT_SECONDS, requested)
      : DEFAULT_COLLECT_SECONDS;
    const status = await waitForChildTerminalStatus(childId, seconds * 1000);
    const lifecycle = childLifecycleForLink(link, status);
    if (isChildActive(status)) {
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
      truncated,
      ...(useTaskStore.getState().tasks[childId]?.error ? { error: useTaskStore.getState().tasks[childId]?.error } : {}),
      ...(lifecycle === "failed" ? {
        retryable: true,
        recovery: "Retry this work with spawn_agent using a corrected self-contained prompt or another approved destination, then collect the replacement before finishing.",
      } : {}),
    };
  }, [linksIncludingPending]);

  /**
   * Stop exactly one child from the command center or the model bridge.
   *
   * Cross-provider children have a durable ownership link and use their
   * provider-specific interrupt path. Codex-native children are first-class
   * runtime threads, so they can be interrupted when their child turn id has
   * reached the task store. Unknown/native providers fail closed instead of
   * pretending the work stopped.
   */
  const stopChildAgent = useCallback(async (rootThreadId: string, childThreadId: string): Promise<void> => {
    const ctx = contextRef.current;
    const taskStore = useTaskStore.getState();
    const link = linksIncludingPending(ctx.links)[childThreadId];
    if (link) {
      if (link.rootThreadId !== rootThreadId) {
        throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      }
      if (!isChildActive(taskStatusOf(childThreadId))) return;
      await hardStopChild(link.provider, childThreadId);
    } else {
      const agent = taskStore.tasks[rootThreadId]?.agents.find((entry) => entry.id === childThreadId);
      if (!agent) throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      const turnId = taskStore.tasks[childThreadId]?.activeTurnId;
      if (!turnId) {
        throw new Error("This provider has not exposed an individual stop control for that sub-agent.");
      }
      await rpc("turn/interrupt", { threadId: childThreadId, turnId });
    }

    taskStore.setActiveTurn(childThreadId, undefined);
    taskStore.setTaskStatus(childThreadId, "interrupted");
    const existing = taskStore.tasks[rootThreadId]?.agents.find((entry) => entry.id === childThreadId);
    taskStore.upsertAgent(rootThreadId, {
      id: childThreadId,
      prompt: link?.title ?? existing?.prompt ?? "Delegated task",
      status: "interrupted",
      path: existing?.path,
    });
    void auditEvent("childAgent.stopped", { rootThreadId, childThreadId, kind: link ? "cross-provider" : "native" });
  }, [linksIncludingPending]);

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
    const proposedCrossProvider = typeof request.arguments.crossProviderEnabled === "boolean"
      ? request.arguments.crossProviderEnabled
      : current.childAgents.enabled;
    const rawTargets = Array.isArray(request.arguments.targets)
      ? request.arguments.targets.map((target) => ({ ...(target as Record<string, unknown>), enabled: true }))
      : current.childAgents.targets;
    const next = sanitizeProjectSubagentSettings({
      enabled: proposedEnabled,
      maxConcurrent: request.arguments.maxConcurrent ?? current.maxConcurrent,
      childAgents: { enabled: proposedEnabled && proposedCrossProvider, targets: rawTargets },
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
    if (next.childAgents.enabled && !proposedCrew.length) {
      throw new Error("A cross-provider crew needs at least one enabled destination. Propose `crossProviderEnabled: false` instead if you want to switch it off.");
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
        return `${target.label || target.id}: ${target.provider} / ${childAgentModel(target) || "provider default"} / ${reasoning}`;
      })
      .join("\n") || "No cross-provider destinations";
    useTaskStore.getState().enqueueApproval({
      id: approvalId,
      method: "openkiwi/subagents/change",
      threadId: policy.rootThreadId,
      receivedAt: Date.now(),
      params: {
        title: "Update this project's sub-agents?",
        reason: reason || "The agent requested a project sub-agent crew change.",
        // Everything below the reason is written by OpenKiwi from the
        // sanitized settings, so the model cannot dress up what it is asking
        // for — including how long the change lasts.
        command: [
          "Scope: this project's saved settings, from your next message onward",
          `Sub-agents: ${next.enabled ? "on" : "off"}`,
          `Cross-provider: ${next.childAgents.enabled ? "on" : "off"}`,
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
      note: "OpenKiwi is asking the user to approve this project change. Do not claim it was applied; continue only with the destinations already approved for this turn.",
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
      note("Sub-agent change declined", "This project keeps its current sub-agent crew, parallel limit, and switches.");
      return;
    }
    const next = sanitizeProjectSubagentSettings(approval.params.settings);
    if (!next) throw new Error("This sub-agent settings proposal is no longer valid.");
    await contextRef.current.applyProjectSubagentSettings(approval.threadId, next);
    note(
      "Sub-agent change applied to this project",
      "The current turn keeps the crew it started with. Your next message runs with the approved settings.",
    );
  }, []);

  const handleRequest = useCallback(async (request: ChildAgentRequest): Promise<void> => {
    try {
      let result: Record<string, unknown>;
      if (request.tool === "spawn_agent") result = await spawnChild(request);
      else if (request.tool === "agent_status") result = reportStatus(request);
      else if (request.tool === "collect_agent") result = await collectChild(request);
      else if (request.tool === "cancel_agent") result = await cancelChild(request);
      else if (request.tool === "propose_agent_settings") result = await proposeSettings(request);
      else throw new Error(`\`${request.tool}\` is not a sub-agent tool.`);
      await respondToChildAgentRequest(request.requestId, result);
    } catch (reason) {
      const message = friendlyError(reason);
      void auditEvent("childAgent.rejected", { tool: request.tool, reason: message });
      // A refusal is delivered as a tool result, not a transport failure, so
      // the parent model can read why and choose a different destination.
      await respondToChildAgentRequest(request.requestId, null, message).catch(() => undefined);
    }
  }, [cancelChild, collectChild, proposeSettings, reportStatus, spawnChild]);

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
  }, [context.links]);

  // Release the backend's concurrency slot as soon as a child's turn reaches a
  // terminal state, and mirror the outcome onto the parent's agent list.
  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      if (state.statuses === previous.statuses) return;
      const { links } = contextRef.current;
      for (const link of Object.values(links)) {
        const status = state.statuses[link.childThreadId];
        if (!status || isChildActive(status)) continue;
        if (releasedRef.current.has(link.childThreadId)) continue;
        releasedRef.current.add(link.childThreadId);
        void reportChildAgentFinished(link.sessionId, link.childThreadId).catch(() => undefined);
        const terminalStatus = childLifecycle(status) as "completed" | "cancelled" | "failed";
        contextRef.current.persistChildAgentLinks((current) => {
          const latest = current[link.childThreadId];
          if (!latest || latest.terminalStatus === terminalStatus) return current;
          return { ...current, [link.childThreadId]: { ...latest, terminalStatus } };
        });
        const store = useTaskStore.getState();
        store.upsertAgent(link.rootThreadId, {
          id: link.childThreadId,
          prompt: link.title,
          status: childLifecycle(status),
        });
        const spawnActivity = store.tasks[link.rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${link.childThreadId}`);
        if (spawnActivity) store.upsertActivity(link.rootThreadId, { ...spawnActivity, status: terminalStatus });
      }
    });
    return unsubscribe;
  }, []);

  // A very fast child can finish before its persisted ownership link reaches
  // this hook. Reconcile on every link update so that early completion still
  // releases the backend slot and updates the parent's roster.
  useEffect(() => {
    for (const link of Object.values(context.links)) {
      const status = taskStatusOf(link.childThreadId);
      if (isChildActive(status) || releasedRef.current.has(link.childThreadId)) continue;
      releasedRef.current.add(link.childThreadId);
      void reportChildAgentFinished(link.sessionId, link.childThreadId).catch(() => undefined);
      const terminalStatus = childLifecycleForLink(link, status) as "completed" | "cancelled" | "failed";
      contextRef.current.persistChildAgentLinks((current) => {
        const latest = current[link.childThreadId];
        if (!latest || latest.terminalStatus === terminalStatus) return current;
        return { ...current, [link.childThreadId]: { ...latest, terminalStatus } };
      });
      const store = useTaskStore.getState();
      store.upsertAgent(link.rootThreadId, {
        id: link.childThreadId,
        prompt: link.title,
        status: terminalStatus,
      });
      const spawnActivity = store.tasks[link.rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${link.childThreadId}`);
      if (spawnActivity) store.upsertActivity(link.rootThreadId, { ...spawnActivity, status: terminalStatus });
    }
  }, [context.links]);

  const cancelChildAgentsFor = useCallback(async (rootThreadId: string): Promise<void> => {
    const ctx = contextRef.current;
    stopGenerationRef.current.set(rootThreadId, (stopGenerationRef.current.get(rootThreadId) ?? 0) + 1);
    const taskStore = useTaskStore.getState();
    const allLinks = linksIncludingPending(ctx.links);
    const running = Object.values(allLinks).filter((link) => link.rootThreadId === rootThreadId
      && isChildActive(taskStatusOf(link.childThreadId)));
    const ownedIds = new Set(Object.values(allLinks)
      .filter((link) => link.rootThreadId === rootThreadId)
      .map((link) => link.childThreadId));
    const native = (taskStore.tasks[rootThreadId]?.agents ?? []).filter((agent) => (
      !ownedIds.has(agent.id) && isActiveAgentRecord(agent.status)
    ));
    // Every cutoff is dispatched in one pass. Waiting for the cross-provider
    // children before even asking the native ones to stop would make Stop as
    // slow as the slowest runtime in the fleet.
    const results = await Promise.allSettled([
      ...running.map(async (link) => {
        try {
          await hardStopChild(link.provider, link.childThreadId);
        } catch (reason) {
          if (!cutoffAlreadySettled(reason)) throw new Error(`Could not stop ${link.title}: ${friendlyError(reason)}`);
        }
        taskStore.setActiveTurn(link.childThreadId, undefined);
        taskStore.setTaskStatus(link.childThreadId, "interrupted");
        taskStore.upsertAgent(rootThreadId, { id: link.childThreadId, prompt: link.title, status: "interrupted" });
      }),
      // Provider-native children have no cross-provider ownership link, but if
      // their runtime exposed a turn id we can still cut them off independently.
      // The rest die with the parent process the composer's Stop kills.
      ...native.map(async (agent) => {
        const turnId = useTaskStore.getState().tasks[agent.id]?.activeTurnId;
        if (turnId) {
          try {
            await rpc("turn/interrupt", { threadId: agent.id, turnId });
          } catch (reason) {
            if (!cutoffAlreadySettled(reason)) throw new Error(`Could not stop ${agent.prompt || "native sub-agent"}: ${friendlyError(reason)}`);
          }
        }
        taskStore.setActiveTurn(agent.id, undefined);
        taskStore.setTaskStatus(agent.id, "interrupted");
        taskStore.upsertAgent(rootThreadId, { ...agent, status: "interrupted" });
      }),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [friendlyError(result.reason)] : []);
    if (failures.length) throw new Error(failures.join("\n"));
  }, [linksIncludingPending]);

  return { cancelChildAgentsFor, respondToSettingsProposal, stopChildAgent };
}

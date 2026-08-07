import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  onChildAgentRequest,
  reportChildAgentFinished,
  respondToChildAgentRequest,
  type ChildAgentRequest,
} from "../lib/agentBridge";
import { childAgentModel, childAgentReasoningEffort, type ChildAgentLink, type ChildAgentPolicy } from "../lib/childAgents";
import { childAgentPolicyForSession } from "../lib/childAgentSessions";
import { startChildAgentTurn } from "../lib/childRun";
import { auditEvent, rpc } from "../lib/codex";
import { interruptClaudeTurn, loadClaudeTranscript } from "../lib/claude";
import { interruptCursorTurn, loadCursorTranscript } from "../lib/cursor";
import { friendlyError } from "../lib/errors";
import { upsertThread } from "../lib/threadList";
import { timelineFromTurns } from "../lib/threadTimeline";
import { useTaskStore, type TaskStatus } from "../lib/taskStore";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { SetPersisted } from "./usePersistedState";
import type { Thread } from "../types";

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
  /** Logical project path a thread is bound to, before worktree resolution. */
  projectPathForThread: (threadId: string) => string | undefined;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  /** Shared Git directory of a thread's isolated worktree, when it has one. */
  isolationGitDirFor: (threadId: string) => string | undefined;
  serviceNameFor: (threadId: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
}

function taskStatusOf(threadId: string): TaskStatus {
  return useTaskStore.getState().statuses[threadId] ?? "idle";
}

/** Lifecycle word a model reads, kept stable across providers. */
export function childLifecycle(status: TaskStatus): string {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "error") return "failed";
  if (status === "starting") return "starting";
  if (status === "running") return "running";
  // A persisted link with no in-memory task is from an earlier app process;
  // no provider turn owned by that process can still hold a live slot.
  return "completed";
}

/** Preserve a persisted outcome when no task from this app process exists. */
export function childLifecycleForLink(link: ChildAgentLink, status: TaskStatus): string {
  if (status !== "idle") return childLifecycle(status);
  // An unterminated link from an earlier process cannot still be running. It
  // was interrupted by that process ending, so cancellation is the only
  // outcome we can assert without fabricating a successful completion.
  return link.terminalStatus ?? "cancelled";
}

export function isChildActive(status: TaskStatus): boolean {
  return status === "starting" || status === "running";
}

/** Children of one bridge session that still hold a concurrency slot. */
export function activeChildThreadIds(sessionId: string, links: Record<string, ChildAgentLink>): string[] {
  return Object.values(links)
    .filter((link) => link.sessionId === sessionId && isChildActive(taskStatusOf(link.childThreadId)))
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

async function interruptChild(link: ChildAgentLink): Promise<void> {
  if (link.provider === "claude") {
    await interruptClaudeTurn(link.childThreadId);
    return;
  }
  if (link.provider === "cursor") {
    await interruptCursorTurn(link.childThreadId);
    return;
  }
  const turnId = useTaskStore.getState().tasks[link.childThreadId]?.activeTurnId;
  if (!turnId) throw new Error("That sub-agent does not have an active task to stop.");
  await rpc("turn/interrupt", { threadId: link.childThreadId, turnId });
}

export function useChildAgents(context: ChildAgentContext): {
  cancelChildAgentsFor: (rootThreadId: string) => Promise<void>;
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
    const nativeActive = (useTaskStore.getState().tasks[rootThreadId]?.agents ?? []).filter((agent) => (
      !crossProviderIds.has(agent.id)
      && ["starting", "started", "running", "working", "inProgress"].includes(agent.status)
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
    const title = String(request.arguments.title ?? "").trim() || prompt.slice(0, 80);
    const reasoningEffort = childAgentReasoningEffort(
      target,
      policy.reasoningEffort,
      request.arguments.reasoningEffort,
    );

    const reservation = `pending-${crypto.randomUUID()}`;
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
        systemPrompt: policy.systemPrompt,
        projectInstructionsEnabled: policy.projectInstructionsEnabled,
        reasoningEffort,
        serviceTier: policy.serviceTier,
        serviceName: ctx.serviceNameFor(rootThreadId),
        openRouterContextWindow: target.provider === "openrouter"
          ? ctx.openRouterModels.find((entry) => entry.id === childAgentModel(target))?.context_length
          : undefined,
      });
    } finally {
      pending.delete(reservation);
    }
    // Hold the slot under the real child id until the rendered link map has it.
    pending.add(result.thread.id);
    pendingChildrenRef.current.set(policy.sessionId, pending);

    const childThreadId = result.thread.id;
    ctx.bindThreadToProject(childThreadId, logicalPath);
    ctx.rememberThread(result.thread);
    ctx.setThreads((current) => upsertThread(current, result.thread));
    ctx.persistThreadModel(childThreadId, result.model);
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
      children: links.map((link) => ({
        childId: link.childThreadId,
        target: link.targetId,
        provider: link.provider,
        model: link.model,
        reasoningEffort: link.reasoningEffort,
        title: link.title,
        status: childLifecycleForLink(link, taskStatusOf(link.childThreadId)),
      })),
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
    };
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
    await interruptChild(link);
    const taskStore = useTaskStore.getState();
    taskStore.setActiveTurn(childId, undefined);
    taskStore.setTaskStatus(childId, "interrupted");
    taskStore.upsertAgent(link.rootThreadId, { id: childId, prompt: link.title, status: "interrupted" });
    return { childId, status: "cancelled" };
  }, [linksIncludingPending]);

  const handleRequest = useCallback(async (request: ChildAgentRequest): Promise<void> => {
    try {
      let result: Record<string, unknown>;
      if (request.tool === "spawn_agent") result = await spawnChild(request);
      else if (request.tool === "agent_status") result = reportStatus(request);
      else if (request.tool === "collect_agent") result = await collectChild(request);
      else if (request.tool === "cancel_agent") result = await cancelChild(request);
      else throw new Error(`\`${request.tool}\` is not a sub-agent tool.`);
      await respondToChildAgentRequest(request.requestId, result);
    } catch (reason) {
      const message = friendlyError(reason);
      void auditEvent("childAgent.rejected", { tool: request.tool, reason: message });
      // A refusal is delivered as a tool result, not a transport failure, so
      // the parent model can read why and choose a different destination.
      await respondToChildAgentRequest(request.requestId, null, message).catch(() => undefined);
    }
  }, [cancelChild, collectChild, reportStatus, spawnChild]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onChildAgentRequest((request) => { void handleRequest(request); })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleRequest]);

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
        useTaskStore.getState().upsertAgent(link.rootThreadId, {
          id: link.childThreadId,
          prompt: link.title,
          status: childLifecycle(status),
        });
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
      useTaskStore.getState().upsertAgent(link.rootThreadId, {
        id: link.childThreadId,
        prompt: link.title,
        status: terminalStatus,
      });
    }
  }, [context.links]);

  const cancelChildAgentsFor = useCallback(async (rootThreadId: string): Promise<void> => {
    const ctx = contextRef.current;
    const running = Object.values(ctx.links).filter((link) => link.rootThreadId === rootThreadId
      && isChildActive(taskStatusOf(link.childThreadId)));
    await Promise.all(running.map(async (link) => {
      try {
        await interruptChild(link);
      } catch {
        // The child may already be gone; its status is settled below either way.
      }
      const taskStore = useTaskStore.getState();
      taskStore.setActiveTurn(link.childThreadId, undefined);
      taskStore.setTaskStatus(link.childThreadId, "interrupted");
    }));
  }, []);

  return { cancelChildAgentsFor };
}

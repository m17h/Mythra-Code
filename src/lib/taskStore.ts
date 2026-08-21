import { create } from "zustand";
import type { Activity, ChatMessage, PendingApproval, Turn } from "../types";
import type { AgentRecord, TokenUsageView } from "../components/StudioDock";
import type { AttachmentRecord } from "../components/StudioDock";
import { isActiveAgentRecord } from "./subAgentActivity";
import { durationForTurn, recordTurnDuration } from "./turnDurations";
import { recordCumulativeUsage, recordUsageDelta, resetUsageLedgerCache, usageForThread, USAGE_LEDGER_KEY } from "./usageLedger";
import { loadStored, removeStoredValue, storeValue } from "./storage";

export type TaskStatus = "idle" | "starting" | "running" | "completed" | "interrupted" | "error";

export type QueuedTurnStatus = "queued" | "sending" | "failed";

export interface QueuedTurn {
  id: string;
  threadId: string;
  text: string;
  attachments: AttachmentRecord[];
  createdAt: number;
  status: QueuedTurnStatus;
  error?: string;
}

const QUEUED_TURNS_KEY = "kiwi.queuedTurns";

/**
 * Rebuild the durable queue from storage. Anything that cannot be delivered
 * verbatim is dropped or normalised here rather than at delivery time: a
 * half-written record must never turn into a model turn with a missing prompt
 * or a bogus attachment path.
 */
export function sanitizeStoredQueuedTurns(stored: unknown): Record<string, QueuedTurn[]> {
  if (!stored || typeof stored !== "object") return {};
  const result: Record<string, QueuedTurn[]> = {};
  const seenIds = new Set<string>();
  for (const [threadId, entries] of Object.entries(stored as Record<string, unknown>)) {
    if (!threadId.trim() || !Array.isArray(entries)) continue;
    const queuedTurns: QueuedTurn[] = [];
    for (const candidate of entries) {
      if (!candidate || typeof candidate !== "object") continue;
      const entry = candidate as Record<string, unknown>;
      if (typeof entry.id !== "string" || !entry.id.trim() || seenIds.has(entry.id)) continue;
      if (typeof entry.text !== "string" || !entry.text.trim()) continue;
      seenIds.add(entry.id);
      const attachments: AttachmentRecord[] = Array.isArray(entry.attachments)
        ? entry.attachments.flatMap((candidateAttachment) => {
            if (!candidateAttachment || typeof candidateAttachment !== "object") return [];
            const attachment = candidateAttachment as Record<string, unknown>;
            if (typeof attachment.path !== "string" || !attachment.path.trim()) return [];
            if (typeof attachment.name !== "string" || !attachment.name.trim()) return [];
            if (attachment.kind !== "file" && attachment.kind !== "image") return [];
            return [{ path: attachment.path, name: attachment.name, kind: attachment.kind }];
          })
        : [];
      queuedTurns.push({
        id: entry.id,
        threadId,
        text: entry.text,
        attachments,
        createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
        // A process cannot still be delivering after an app restart, and an
        // unknown status would be a queue entry the pump never picks up.
        status: entry.status === "failed" ? "failed" : "queued",
        ...(typeof entry.error === "string" && entry.error ? { error: entry.error } : {}),
      });
    }
    if (queuedTurns.length) result[threadId] = queuedTurns;
  }
  return result;
}

function loadQueuedTurns(): Record<string, QueuedTurn[]> {
  return sanitizeStoredQueuedTurns(loadStored<Record<string, QueuedTurn[]>>(QUEUED_TURNS_KEY, {}));
}

let queuedTurnsCache = loadQueuedTurns();

function persistQueuedTurns(threadId: string, entries: QueuedTurn[]): void {
  if (entries.length) queuedTurnsCache = { ...queuedTurnsCache, [threadId]: entries };
  else {
    const next = { ...queuedTurnsCache };
    delete next[threadId];
    queuedTurnsCache = next;
  }
  storeValue(QUEUED_TURNS_KEY, queuedTurnsCache);
}

export interface ThreadTaskState {
  threadId: string;
  activeTurnId?: string;
  /**
   * The active turn has entered user-facing assistant output. This stays
   * latched after the last text delta so the item-completed/turn-completed
   * gap cannot briefly make steering available again. A genuinely new tool
   * or reasoning item clears it because the turn has returned to active work.
   */
  assistantOutputTurnId?: string;
  /** First optimistic entry waiting for the runtime to return its turn id. */
  pendingTurnStartOrder?: number;
  /** Wall-clock anchor for the sidebar's live "Working" duration. */
  workingStartedAt?: number;
  /** Captures elapsed time if an idle status arrives before turn/completed. */
  pendingTurnDurationMs?: number;
  lastCompletedTurnId?: string;
  lastCompletedTurnStatus?: TaskStatus;
  workspacePath?: string;
  status: TaskStatus;
  messages: ChatMessage[];
  activities: Activity[];
  approvals: PendingApproval[];
  queuedTurns: QueuedTurn[];
  agents: AgentRecord[];
  /** Only child activity created at or after this root turn belongs in the
   * live crew panel. A new user prompt advances this boundary. */
  agentRunStartedAt?: number;
  diff: string;
  usage: TokenUsageView | null;
  unread: boolean;
  error?: string;
  updatedAt: number;
}

/** Steering is unsafe while the active turn is presenting its response. */
export function isAssistantOutputActive(task: ThreadTaskState | undefined): boolean {
  return Boolean(
    task?.status === "running"
    && task.activeTurnId
    && task.assistantOutputTurnId === task.activeTurnId,
  );
}

interface TaskStoreState {
  activeThreadId: string | null;
  tasks: Record<string, ThreadTaskState>;
  statuses: Record<string, TaskStatus>;
  setActiveThread: (threadId: string | null) => void;
  ensureTask: (threadId: string, workspacePath?: string) => void;
  hydrateTask: (threadId: string, messages: ChatMessage[], activities: Activity[], workspacePath?: string) => void;
  appendUserMessage: (threadId: string, message: ChatMessage) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  queueAssistantDelta: (threadId: string, itemId: string, delta: string) => void;
  queueReasoningDelta: (threadId: string, itemId: string, delta: string, source: "summary" | "content") => void;
  flushDeltas: () => void;
  completeMessage: (threadId: string, message: ChatMessage) => void;
  upsertActivity: (threadId: string, activity: Activity) => void;
  setActiveTurn: (threadId: string, turnId?: string) => void;
  completeTurn: (threadId: string, turnId: string | undefined, status: TaskStatus) => void;
  setTaskStatus: (threadId: string, status: TaskStatus, error?: string) => void;
  setDiff: (threadId: string, diff: string) => void;
  setUsage: (threadId: string, usage: TokenUsageView | null) => void;
  addUsage: (threadId: string, usage: TokenUsageView, eventId?: string) => void;
  upsertAgent: (threadId: string, agent: AgentRecord) => void;
  beginAgentRun: (threadId: string, startedAt?: number) => void;
  enqueueApproval: (approval: PendingApproval) => void;
  resolveApproval: (threadId: string, approvalId: string | number) => void;
  clearApprovals: (threadId: string) => void;
  enqueueTurn: (threadId: string, text: string, attachments: AttachmentRecord[]) => QueuedTurn;
  setQueuedTurnStatus: (threadId: string, queuedTurnId: string, status: QueuedTurnStatus, error?: string) => void;
  removeQueuedTurn: (threadId: string, queuedTurnId: string) => void;
  clearUnread: (threadId: string) => void;
  removeTask: (threadId: string) => void;
}

const pendingDeltas = new Map<string, Map<string, string>>();
const pendingReasoningItems = new Map<string, Set<string>>();
const reasoningStreams = new Map<string, { summary: string; content: string }>();
let deltaFrame: number | ReturnType<typeof setTimeout> | null = null;
let timelineSequence = 0;

function withTimelineOrder<T extends { timelineOrder?: number }>(entry: T): T {
  if (entry.timelineOrder !== undefined) {
    timelineSequence = Math.max(timelineSequence, entry.timelineOrder);
    return entry;
  }
  return { ...entry, timelineOrder: ++timelineSequence };
}

function emptyTask(threadId: string, workspacePath?: string): ThreadTaskState {
  return {
    threadId,
    workspacePath,
    status: "idle",
    messages: [],
    activities: [],
    approvals: [],
    queuedTurns: queuedTurnsCache[threadId] ?? [],
    agents: [],
    diff: "",
    usage: usageForThread(threadId)?.usage ?? null,
    unread: false,
    updatedAt: Date.now(),
  };
}

function scheduleDeltaFlush(flush: () => void): void {
  if (deltaFrame !== null) return;
  if (typeof requestAnimationFrame === "function") {
    deltaFrame = requestAnimationFrame(() => {
      deltaFrame = null;
      flush();
    });
  } else {
    deltaFrame = setTimeout(() => {
      deltaFrame = null;
      flush();
    }, 16);
  }
}

function completedTurnStatus(status: TaskStatus): Turn["status"] {
  if (status === "interrupted") return "interrupted";
  if (status === "error") return "failed";
  if (status === "completed") return "completed";
  return "inProgress";
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  activeThreadId: null,
  tasks: {},
  statuses: {},
  setActiveThread: (threadId) => set((state) => {
    if (!threadId || !state.tasks[threadId]) return { activeThreadId: threadId };
    return {
      activeThreadId: threadId,
      tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], unread: false } },
    };
  }),
  ensureTask: (threadId, workspacePath) => set((state) => {
    if (state.tasks[threadId]) {
      if (!workspacePath || state.tasks[threadId].workspacePath === workspacePath) return state;
      return { tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], workspacePath } } };
    }
    return {
      tasks: { ...state.tasks, [threadId]: emptyTask(threadId, workspacePath) },
      statuses: { ...state.statuses, [threadId]: "idle" },
    };
  }),
  hydrateTask: (threadId, messages, activities, workspacePath) => set((state) => {
    const existing = state.tasks[threadId];
    const hydratedMessages = messages.map((message) => withTimelineOrder({
      ...message,
      turnDurationMs: message.turnDurationMs ?? durationForTurn(threadId, message.turnId),
    }));
    // The turns-derived history excludes the incomplete turn's partially
    // streamed assistant message. Keep it, so re-opening a running thread does
    // not truncate the stream to whatever deltas arrive after the hydrate.
    const inFlight = (existing?.messages ?? [])
      .filter((message) => message.streaming && !hydratedMessages.some((entry) => entry.id === message.id))
      .map(({ timelineOrder: _order, ...message }) => withTimelineOrder(message as ChatMessage));
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...(existing ?? emptyTask(threadId, workspacePath)),
          workspacePath,
          messages: [...hydratedMessages, ...inFlight],
          activities: activities.map((activity) => withTimelineOrder({
            ...activity,
            turnDurationMs: activity.turnDurationMs ?? durationForTurn(threadId, activity.turnId),
          })),
          unread: false,
          updatedAt: Date.now(),
        },
      },
      statuses: { ...state.statuses, [threadId]: state.statuses[threadId] ?? "idle" },
    };
  }),
  appendUserMessage: (threadId, message) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const nextMessage = withTimelineOrder({ ...message, turnId: message.turnId ?? task.activeTurnId });
    const pendingTurnStartOrder = task.pendingTurnStartOrder
      ?? (task.status === "starting" && !task.activeTurnId ? nextMessage.timelineOrder : undefined);
    return { tasks: { ...state.tasks, [threadId]: { ...task, pendingTurnStartOrder, messages: [...task.messages, nextMessage], updatedAt: Date.now() } } };
  }),
  removeMessage: (threadId, messageId) => set((state) => {
    const task = state.tasks[threadId];
    const removed = task?.messages.find((message) => message.id === messageId);
    if (!task || !removed) return state;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          pendingTurnStartOrder: task.pendingTurnStartOrder === removed.timelineOrder ? undefined : task.pendingTurnStartOrder,
          messages: task.messages.filter((message) => message.id !== messageId),
          updatedAt: Date.now(),
        },
      },
    };
  }),
  queueAssistantDelta: (threadId, itemId, delta) => {
    // Delta text is frame-batched below, but the steering lock must become
    // authoritative synchronously. Otherwise a click in that frame can still
    // reach turn/steer even though final output has already started arriving.
    if (delta) {
      const task = get().tasks[threadId];
      if (task?.activeTurnId && task.assistantOutputTurnId !== task.activeTurnId) {
        set((state) => {
          const current = state.tasks[threadId];
          if (!current?.activeTurnId || current.assistantOutputTurnId === current.activeTurnId) return state;
          return {
            tasks: {
              ...state.tasks,
              [threadId]: { ...current, assistantOutputTurnId: current.activeTurnId, updatedAt: Date.now() },
            },
          };
        });
      }
    }
    const byItem = pendingDeltas.get(threadId) ?? new Map<string, string>();
    byItem.set(itemId, `${byItem.get(itemId) ?? ""}${delta}`);
    pendingDeltas.set(threadId, byItem);
    scheduleDeltaFlush(get().flushDeltas);
  },
  queueReasoningDelta: (threadId, itemId, delta, source) => {
    const key = `${threadId}\0${itemId}`;
    const current = get().tasks[threadId];
    const reasoningAlreadyKnown = reasoningStreams.has(key)
      || Boolean(current?.activities.some((activity) => (
        activity.id === itemId
        && (!current.activeTurnId || !activity.turnId || activity.turnId === current.activeTurnId)
      )));
    if (delta && !reasoningAlreadyKnown && current?.activeTurnId && current.assistantOutputTurnId === current.activeTurnId) {
      set((state) => {
        const task = state.tasks[threadId];
        if (!task || task.assistantOutputTurnId !== task.activeTurnId) return state;
        return {
          tasks: {
            ...state.tasks,
            [threadId]: { ...task, assistantOutputTurnId: undefined, updatedAt: Date.now() },
          },
        };
      });
    }
    const stream = reasoningStreams.get(key) ?? { summary: "", content: "" };
    stream[source] = `${stream[source]}${delta}`;
    reasoningStreams.set(key, stream);
    const items = pendingReasoningItems.get(threadId) ?? new Set<string>();
    items.add(itemId);
    pendingReasoningItems.set(threadId, items);
    scheduleDeltaFlush(get().flushDeltas);
  },
  flushDeltas: () => {
    if (!pendingDeltas.size && !pendingReasoningItems.size) return;
    const batch = new Map(pendingDeltas);
    const reasoningBatch = new Map(pendingReasoningItems);
    pendingDeltas.clear();
    pendingReasoningItems.clear();
    set((state) => {
      const tasks = { ...state.tasks };
      const threadIds = new Set([...batch.keys(), ...reasoningBatch.keys()]);
      for (const threadId of threadIds) {
        const task = tasks[threadId] ?? emptyTask(threadId);
        let messages = task.messages;
        let messagesCopied = false;
        for (const [itemId, delta] of batch.get(threadId) ?? []) {
          const index = messages.findIndex((message) => message.id === itemId);
          if (index < 0) {
            messages = [...messages, withTimelineOrder<ChatMessage>({ id: itemId, role: "assistant", text: delta, streaming: true, turnId: task.activeTurnId })];
            messagesCopied = true;
          } else {
            if (!messagesCopied) {
              messages = [...messages];
              messagesCopied = true;
            }
            const message = messages[index];
            messages[index] = { ...message, text: `${message.text}${delta}`, streaming: true };
          }
        }
        let activities = task.activities;
        let activitiesCopied = false;
        for (const itemId of reasoningBatch.get(threadId) ?? []) {
          const stream = reasoningStreams.get(`${threadId}\0${itemId}`);
          const detail = (stream?.content || stream?.summary || "").trim();
          if (!detail) continue;
          const index = activities.findIndex((activity) => activity.id === itemId);
          const activity: Activity = { id: itemId, kind: "reasoning", title: "Model thinking", detail, status: "inProgress", turnId: task.activeTurnId };
          if (index < 0) {
            activities = [...activities, withTimelineOrder(activity)];
            activitiesCopied = true;
          } else {
            if (!activitiesCopied) {
              activities = [...activities];
              activitiesCopied = true;
            }
            activities[index] = { ...activities[index], ...activity, turnId: activity.turnId ?? activities[index].turnId, turnStatus: activity.turnStatus ?? activities[index].turnStatus, timelineOrder: activities[index].timelineOrder };
          }
        }
        tasks[threadId] = { ...task, messages, activities, unread: state.activeThreadId !== threadId, updatedAt: Date.now() };
      }
      return { tasks };
    });
  },
  completeMessage: (threadId, message) => {
    // Drop any queued deltas for this item so a flush scheduled before the
    // completion event cannot re-append the tail of the finalized text.
    pendingDeltas.get(threadId)?.delete(message.id);
    return set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const exists = task.messages.some((entry) => entry.id === message.id);
    const messages = exists
      ? task.messages.map((entry) => entry.id === message.id ? { ...message, streaming: false, turnId: message.turnId ?? entry.turnId ?? task.activeTurnId, turnStatus: message.turnStatus ?? entry.turnStatus, timelineOrder: entry.timelineOrder } : entry)
      : [...task.messages, withTimelineOrder({ ...message, streaming: false, turnId: message.turnId ?? task.activeTurnId })];
    const messageTurnId = message.turnId ?? task.activeTurnId;
    const assistantOutputTurnId = task.status === "running"
      && message.role === "assistant"
      && Boolean(message.text)
      && messageTurnId === task.activeTurnId
      ? task.activeTurnId
      : task.assistantOutputTurnId;
    return { tasks: { ...state.tasks, [threadId]: { ...task, messages, assistantOutputTurnId, unread: state.activeThreadId !== threadId, updatedAt: Date.now() } } };
    });
  },
  upsertActivity: (threadId, activity) => {
    if (activity.kind === "reasoning" && activity.status === "completed") reasoningStreams.delete(`${threadId}\0${activity.id}`);
    set((state) => {
      const task = state.tasks[threadId] ?? emptyTask(threadId);
      const exists = task.activities.some((entry) => entry.id === activity.id);
      const activityTurnId = activity.turnId ?? task.activeTurnId;
      const activities = exists
        ? task.activities.map((entry) => entry.id === activity.id ? { ...activity, turnId: activity.turnId ?? entry.turnId ?? task.activeTurnId, turnStatus: activity.turnStatus ?? entry.turnStatus, timelineOrder: entry.timelineOrder } : entry)
        : [...task.activities, withTimelineOrder({ ...activity, turnId: activity.turnId ?? task.activeTurnId })];
      const beginsNewWork = !exists
        && activity.kind !== "warning"
        && activity.status !== "completed"
        && activity.status !== "failed";
      const assistantOutputTurnId = beginsNewWork && activityTurnId === task.assistantOutputTurnId
        ? undefined
        : task.assistantOutputTurnId;
      return { tasks: { ...state.tasks, [threadId]: { ...task, activities, assistantOutputTurnId, unread: state.activeThreadId !== threadId, updatedAt: Date.now() } } };
    });
  },
  setActiveTurn: (threadId, turnId) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const threshold = turnId ? task.pendingTurnStartOrder : undefined;
    const messages = threshold === undefined
      ? task.messages
      : task.messages.map((message) => !message.turnId && (message.timelineOrder ?? -1) >= threshold ? { ...message, turnId } : message);
    const activities = threshold === undefined
      ? task.activities
      : task.activities.map((activity) => !activity.turnId && (activity.timelineOrder ?? -1) >= threshold ? { ...activity, turnId } : activity);
    const assistantOutputTurnId = turnId && task.assistantOutputTurnId === turnId
      ? task.assistantOutputTurnId
      : undefined;
    return { tasks: { ...state.tasks, [threadId]: { ...task, activeTurnId: turnId, assistantOutputTurnId, pendingTurnStartOrder: turnId ? undefined : task.pendingTurnStartOrder, messages, activities, updatedAt: Date.now() } } };
  }),
  completeTurn: (threadId, turnId, status) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const completedTurnId = turnId ?? task.activeTurnId;
    const newerTurnActive = Boolean(task.activeTurnId && turnId && task.activeTurnId !== turnId);
    const threadStatus = newerTurnActive ? task.status : status;
    const turnStatus = completedTurnStatus(status);
    const elapsedMs = task.workingStartedAt !== undefined
      ? Date.now() - task.workingStartedAt
      : task.pendingTurnDurationMs;
    const turnDurationMs = status === "completed"
      && !newerTurnActive
      && completedTurnId
      && elapsedMs !== undefined
      ? recordTurnDuration(threadId, completedTurnId, elapsedMs)
      : undefined;
    const messages = completedTurnId
      ? task.messages.map((message) => message.turnId === completedTurnId
        ? { ...message, turnStatus, turnDurationMs: turnDurationMs ?? message.turnDurationMs }
        : message)
      : task.messages;
    const activities = completedTurnId
      ? task.activities.map((activity) => activity.turnId === completedTurnId
        ? {
            ...activity,
            // A provider can disappear while a tool card is awaiting its
            // result. The turn is terminal, so that card must not keep
            // claiming it is live after the composer has returned to idle.
            status: activity.status === "inProgress"
              ? (status === "completed" ? "completed" : "failed")
              : activity.status,
            turnStatus,
            turnDurationMs: turnDurationMs ?? activity.turnDurationMs,
          }
        : activity)
      : task.activities;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          messages,
          activities,
          activeTurnId: task.activeTurnId === turnId || !turnId ? undefined : task.activeTurnId,
          assistantOutputTurnId: completedTurnId === task.assistantOutputTurnId
            ? undefined
            : task.assistantOutputTurnId,
          pendingTurnStartOrder: newerTurnActive ? task.pendingTurnStartOrder : undefined,
          workingStartedAt: newerTurnActive ? task.workingStartedAt : undefined,
          pendingTurnDurationMs: newerTurnActive ? task.pendingTurnDurationMs : undefined,
          // A completion without a turn id (runtime exit, provider crash)
          // must not erase the record of the last turn that really finished —
          // workflow waiters key off it and would otherwise idle out.
          lastCompletedTurnId: completedTurnId ?? task.lastCompletedTurnId,
          lastCompletedTurnStatus: completedTurnId ? status : task.lastCompletedTurnStatus,
          status: threadStatus,
          unread: state.activeThreadId !== threadId && threadStatus === "completed" ? true : task.unread,
          updatedAt: Date.now(),
        },
      },
      statuses: { ...state.statuses, [threadId]: threadStatus },
    };
  }),
  setTaskStatus: (threadId, status, error) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const isWorking = status === "starting" || status === "running";
    const wasWorking = task.status === "starting" || task.status === "running";
    const pendingTurnDurationMs = isWorking
      ? (wasWorking ? task.pendingTurnDurationMs : undefined)
      : wasWorking && task.workingStartedAt !== undefined
        ? Date.now() - task.workingStartedAt
        : task.pendingTurnDurationMs;
    let latestPendingUser: number | undefined;
    if (status === "starting" && !wasWorking && !task.activeTurnId) {
      for (let index = task.messages.length - 1; index >= 0; index -= 1) {
        const message = task.messages[index];
        if (message.role === "user" && !message.turnId) {
          latestPendingUser = message.timelineOrder;
          break;
        }
      }
    }
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          status,
          error,
          assistantOutputTurnId: isWorking ? task.assistantOutputTurnId : undefined,
          pendingTurnStartOrder: task.pendingTurnStartOrder ?? latestPendingUser,
          workingStartedAt: isWorking ? (wasWorking ? task.workingStartedAt ?? Date.now() : Date.now()) : undefined,
          pendingTurnDurationMs,
          unread: state.activeThreadId !== threadId && status === "completed" ? true : task.unread,
          updatedAt: Date.now(),
        },
      },
      statuses: { ...state.statuses, [threadId]: status },
    };
  }),
  setDiff: (threadId, diff) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, diff, updatedAt: Date.now() } } };
  }),
  setUsage: (threadId, usage) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const persisted = usage ? recordCumulativeUsage(threadId, usage) : null;
    return { tasks: { ...state.tasks, [threadId]: { ...task, usage: persisted, updatedAt: Date.now() } } };
  }),
  addUsage: (threadId, usage, eventId) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const persisted = recordUsageDelta(threadId, usage, eventId);
    return { tasks: { ...state.tasks, [threadId]: { ...task, usage: persisted, updatedAt: Date.now() } } };
  }),
  upsertAgent: (threadId, agent) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const exists = task.agents.some((entry) => entry.id === agent.id);
    const agents = exists ? task.agents.map((entry) => entry.id === agent.id ? { ...entry, ...agent } : entry) : [...task.agents, agent];
    return { tasks: { ...state.tasks, [threadId]: { ...task, agents, updatedAt: Date.now() } } };
  }),
  beginAgentRun: (threadId, startedAt = Date.now()) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const activeAgents = task.agents.filter((agent) => isActiveAgentRecord(agent.status));
    return {
      tasks: {
        ...state.tasks,
        [threadId]: { ...task, agents: activeAgents, agentRunStartedAt: startedAt, updatedAt: Date.now() },
      },
    };
  }),
  enqueueApproval: (approval) => set((state) => {
    const task = state.tasks[approval.threadId] ?? emptyTask(approval.threadId);
    if (task.approvals.some((entry) => entry.id === approval.id)) return state;
    return { tasks: { ...state.tasks, [approval.threadId]: { ...task, approvals: [...task.approvals, approval], unread: state.activeThreadId !== approval.threadId, updatedAt: Date.now() } } };
  }),
  resolveApproval: (threadId, approvalId) => set((state) => {
    const task = state.tasks[threadId];
    if (!task) return state;
    return { tasks: { ...state.tasks, [threadId]: { ...task, approvals: task.approvals.filter((entry) => entry.id !== approvalId), updatedAt: Date.now() } } };
  }),
  clearApprovals: (threadId) => set((state) => {
    const task = state.tasks[threadId];
    if (!task || task.approvals.length === 0) return state;
    return { tasks: { ...state.tasks, [threadId]: { ...task, approvals: [], updatedAt: Date.now() } } };
  }),
  enqueueTurn: (threadId, text, attachments) => {
    const queuedTurn: QueuedTurn = {
      id: `queued-${crypto.randomUUID()}`,
      threadId,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      createdAt: Date.now(),
      status: "queued",
    };
    set((state) => {
      const task = state.tasks[threadId] ?? emptyTask(threadId);
      const queuedTurns = [...task.queuedTurns, queuedTurn];
      persistQueuedTurns(threadId, queuedTurns);
      return { tasks: { ...state.tasks, [threadId]: { ...task, queuedTurns, updatedAt: Date.now() } } };
    });
    return queuedTurn;
  },
  setQueuedTurnStatus: (threadId, queuedTurnId, status, error) => set((state) => {
    const task = state.tasks[threadId];
    if (!task || !task.queuedTurns.some((entry) => entry.id === queuedTurnId)) return state;
    const queuedTurns = task.queuedTurns.map((entry) => entry.id === queuedTurnId
      ? { ...entry, status, ...(error ? { error } : { error: undefined }) }
      : entry);
    persistQueuedTurns(threadId, queuedTurns);
    return { tasks: { ...state.tasks, [threadId]: { ...task, queuedTurns, updatedAt: Date.now() } } };
  }),
  removeQueuedTurn: (threadId, queuedTurnId) => set((state) => {
    const task = state.tasks[threadId];
    if (!task || !task.queuedTurns.some((entry) => entry.id === queuedTurnId)) return state;
    const queuedTurns = task.queuedTurns.filter((entry) => entry.id !== queuedTurnId);
    persistQueuedTurns(threadId, queuedTurns);
    return { tasks: { ...state.tasks, [threadId]: { ...task, queuedTurns, updatedAt: Date.now() } } };
  }),
  clearUnread: (threadId) => set((state) => state.tasks[threadId] ? { tasks: { ...state.tasks, [threadId]: { ...state.tasks[threadId], unread: false } } } : state),
  removeTask: (threadId) => {
    // Clear queued streaming buffers so a pending flush cannot resurrect the
    // deleted thread as a ghost task.
    pendingDeltas.delete(threadId);
    pendingReasoningItems.delete(threadId);
    for (const key of reasoningStreams.keys()) {
      if (key.startsWith(`${threadId}\0`)) reasoningStreams.delete(key);
    }
    return set((state) => {
      const tasks = { ...state.tasks };
      const statuses = { ...state.statuses };
      delete tasks[threadId];
      delete statuses[threadId];
      persistQueuedTurns(threadId, []);
      return { tasks, statuses, activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId };
    });
  },
}));

export function resetTaskStore(): void {
  pendingDeltas.clear();
  pendingReasoningItems.clear();
  reasoningStreams.clear();
  timelineSequence = 0;
  removeStoredValue(USAGE_LEDGER_KEY);
  resetUsageLedgerCache();
  queuedTurnsCache = {};
  removeStoredValue(QUEUED_TURNS_KEY);
  useTaskStore.setState({ activeThreadId: null, tasks: {}, statuses: {} });
}

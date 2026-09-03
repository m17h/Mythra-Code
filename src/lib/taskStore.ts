import { create } from "zustand";
import type { Activity, ChatMessage, PendingApproval, Turn } from "../types";
import type { AgentRecord, TokenUsageView } from "../components/StudioDock";
import type { AttachmentRecord } from "../components/StudioDock";
import { EMPTY_REVIEW_DIFF, type ReviewDiff } from "./gitDiff";
import { isActiveAgentRecord } from "./subAgentActivity";
import { durationForTurn, recordTurnDuration } from "./turnDurations";
import { recordCumulativeUsage, recordUsageDelta, resetUsageLedgerCache, usageForThread, USAGE_LEDGER_KEY } from "./usageLedger";
import { loadStored, removeStoredValue, storeValue } from "./storage";
import { EMPTY_THREAD_HISTORY, type ThreadHistoryState } from "./threadHistory";
import { beginRuntimePerformanceTurn, bindRuntimePerformanceTurn, completeRuntimePerformanceTurn, recordStreamingDelta, recordStreamingFlush, resetRuntimePerformanceDiagnostics } from "./runtimePerformanceBridge";

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
  /** Conservative estimate of the retained transcript heap. This is used to
   * bound the renderer cache; it is not a measurement of process RSS. */
  estimatedTranscriptBytes: number;
  approvals: PendingApproval[];
  queuedTurns: QueuedTurn[];
  agents: AgentRecord[];
  /** Only child activity created at or after this root turn belongs in the
   * live crew panel. A new user prompt advances this boundary. */
  agentRunStartedAt?: number;
  /**
   * What the Review panel shows for this thread, including where it came from
   * and what it is taken against. Typed so no other surface can drop an
   * unrelated command's stdout into the review state.
   */
  diff: ReviewDiff;
  usage: TokenUsageView | null;
  /** Local-provider transcript changes not yet acknowledged by durable disk
   * persistence. Dirty transcripts are never eligible for memory eviction. */
  transcriptDirty: boolean;
  /** Window/cursor metadata for Codex history loaded into this task. */
  history: ThreadHistoryState;
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
  hydrateTask: (threadId: string, messages: ChatMessage[], activities: Activity[], workspacePath?: string, history?: ThreadHistoryState) => void;
  setHistory: (threadId: string, patch: Partial<ThreadHistoryState>) => void;
  prependHistory: (threadId: string, messages: ChatMessage[], activities: Activity[], patch: Partial<ThreadHistoryState>) => void;
  setTranscriptDirty: (threadId: string, dirty: boolean) => void;
  appendUserMessage: (threadId: string, message: ChatMessage) => void;
  setMessageSteerStatus: (threadId: string, messageId: string, status: ChatMessage["steerStatus"]) => void;
  removeMessage: (threadId: string, messageId: string) => void;
  queueAssistantDelta: (threadId: string, itemId: string, delta: string) => void;
  queueReasoningDelta: (threadId: string, itemId: string, delta: string, source: "summary" | "content") => void;
  flushDeltas: () => void;
  completeMessage: (threadId: string, message: ChatMessage) => void;
  upsertActivity: (threadId: string, activity: Activity) => void;
  setActiveTurn: (threadId: string, turnId?: string) => void;
  completeTurn: (threadId: string, turnId: string | undefined, status: TaskStatus) => void;
  setTaskStatus: (threadId: string, status: TaskStatus, error?: string) => void;
  setDiff: (threadId: string, diff: ReviewDiff) => void;
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
    estimatedTranscriptBytes: 0,
    approvals: [],
    queuedTurns: queuedTurnsCache[threadId] ?? [],
    agents: [],
    diff: EMPTY_REVIEW_DIFF,
    usage: usageForThread(threadId)?.usage ?? null,
    transcriptDirty: false,
    history: EMPTY_THREAD_HISTORY,
    unread: false,
    updatedAt: Date.now(),
  };
}

/** Most hydrated transcripts kept in renderer memory at once. */
const MAX_HYDRATED_TRANSCRIPTS = 12;
const DEFAULT_TRANSCRIPT_CACHE_HIGH_WATER_BYTES = 64 * 1024 * 1024;
const DEFAULT_TRANSCRIPT_CACHE_LOW_WATER_BYTES = 48 * 1024 * 1024;
let transcriptCacheHighWaterBytes = DEFAULT_TRANSCRIPT_CACHE_HIGH_WATER_BYTES;
let transcriptCacheLowWaterBytes = DEFAULT_TRANSCRIPT_CACHE_LOW_WATER_BYTES;
/** A transcript this recently touched may still have a debounced disk save
 * pending; never evict it, or the re-hydrate would read a stale file. */
const EVICT_MIN_IDLE_MS = 5 * 60_000;

const UTF16_BYTES_PER_CODE_UNIT = 2;
const MESSAGE_BASE_BYTES = 160;
const ACTIVITY_BASE_BYTES = 192;
const ATTACHMENT_BASE_BYTES = 96;
const AGENT_ACTIVITY_BASE_BYTES = 128;
const ARRAY_SLOT_BYTES = 8;

function stringBytes(value: string | undefined): number {
  return (value?.length ?? 0) * UTF16_BYTES_PER_CODE_UNIT;
}

function estimateMessageBytes(message: ChatMessage): number {
  const attachments = message.attachments ?? [];
  return MESSAGE_BASE_BYTES
    + stringBytes(message.id)
    + stringBytes(message.role)
    + stringBytes(message.text)
    + stringBytes(message.turnId)
    + stringBytes(message.turnStatus)
    + stringBytes(message.steerStatus)
    + attachments.reduce((total, attachment) => total
      + ATTACHMENT_BASE_BYTES
      + stringBytes(attachment.path)
      + stringBytes(attachment.name)
      + stringBytes(attachment.kind), attachments.length * ARRAY_SLOT_BYTES);
}

function estimateActivityBytes(activity: Activity): number {
  const agent = activity.agent;
  const threadIds = agent?.threadIds ?? [];
  return ACTIVITY_BASE_BYTES
    + stringBytes(activity.id)
    + stringBytes(activity.kind)
    + stringBytes(activity.title)
    + stringBytes(activity.detail)
    + stringBytes(activity.status)
    + stringBytes(activity.turnId)
    + stringBytes(activity.turnStatus)
    + (agent ? AGENT_ACTIVITY_BASE_BYTES
      + stringBytes(agent.action)
      + stringBytes(agent.provider)
      + stringBytes(agent.model)
      + stringBytes(agent.task)
      + threadIds.reduce((total, threadId) => total + ARRAY_SLOT_BYTES + stringBytes(threadId), 0)
      : 0);
}

/** Estimate retained transcript data without serializing or reading string
 * contents. JavaScript strings expose their length in constant time. */
export function estimateTranscriptBytes(messages: ChatMessage[], activities: Activity[]): number {
  return messages.reduce((total, message) => total + ARRAY_SLOT_BYTES + estimateMessageBytes(message), 0)
    + activities.reduce((total, activity) => total + ARRAY_SLOT_BYTES + estimateActivityBytes(activity), 0);
}

function adjustedBytes(current: number, previous: number, next: number): number {
  return Math.max(0, current - previous + next);
}

/** Keeps byte-budget tests small instead of allocating tens of megabytes. */
export function setTranscriptCacheByteBudgetForTests(highWaterBytes: number, lowWaterBytes = highWaterBytes): void {
  transcriptCacheHighWaterBytes = highWaterBytes;
  transcriptCacheLowWaterBytes = Math.min(lowWaterBytes, highWaterBytes);
}

/**
 * Visited threads hydrate their full transcript into memory and, without this,
 * never release it — a day of touring large threads grows the renderer
 * monotonically. On every thread switch, drop the messages/activities of the
 * coldest idle threads beyond a small working set; they rehydrate from disk
 * (or runtime history) on the next visit. Everything that must survive —
 * approvals, queued turns, agent rosters, statuses — stays on the task shell.
 */
function evictColdTranscripts(
  state: TaskStoreState,
  activeThreadId: string | null,
): Record<string, ThreadTaskState> | null {
  const hydrated = Object.values(state.tasks).filter(
    (task) => task.messages.length > 0 || task.activities.length > 0,
  );
  let hydratedCount = hydrated.length;
  let hydratedBytes = hydrated.reduce((total, task) => total + task.estimatedTranscriptBytes, 0);
  const bytesOverHighWater = hydratedBytes > transcriptCacheHighWaterBytes;
  if (hydratedCount <= MAX_HYDRATED_TRANSCRIPTS && !bytesOverHighWater) return null;
  const now = Date.now();
  const victims = hydrated
    .filter((task) => (
      task.threadId !== activeThreadId
      && state.statuses[task.threadId] !== "starting"
      && state.statuses[task.threadId] !== "running"
      && task.approvals.length === 0
      && task.queuedTurns.length === 0
      && !task.transcriptDirty
      && now - task.updatedAt > EVICT_MIN_IDLE_MS
    ))
    .sort((left, right) => left.updatedAt - right.updatedAt);
  if (victims.length === 0) return null;
  const evictableBytes = victims.reduce((total, task) => total + task.estimatedTranscriptBytes, 0);
  const protectedCount = hydratedCount - victims.length;
  const protectedBytes = Math.max(0, hydratedBytes - evictableBytes);
  // Hysteresis is useful only when its target is reachable. If protected work
  // already exceeds the high-water mark, byte eviction cannot fix the breach
  // and must not punish every otherwise useful cold transcript. If only the
  // low-water target is unreachable, release enough to return below high.
  const byteTarget = !bytesOverHighWater || protectedBytes >= transcriptCacheHighWaterBytes
    ? null
    : protectedBytes <= transcriptCacheLowWaterBytes
      ? transcriptCacheLowWaterBytes
      : transcriptCacheHighWaterBytes;
  const canSatisfyCountCap = protectedCount < MAX_HYDRATED_TRANSCRIPTS;
  const tasks = { ...state.tasks };
  for (const task of victims) {
    const mustReduceCount = canSatisfyCountCap && hydratedCount > MAX_HYDRATED_TRANSCRIPTS;
    const mustReduceBytes = byteTarget !== null && hydratedBytes > byteTarget;
    if (!mustReduceCount && !mustReduceBytes) break;
    // A cursor describes the window that was just discarded. Keeping it on
    // the shell would let an empty transcript request page two and silently
    // skip the recent page when the thread is revisited.
    tasks[task.threadId] = {
      ...task,
      messages: [],
      activities: [],
      estimatedTranscriptBytes: 0,
      history: EMPTY_THREAD_HISTORY,
    };
    hydratedCount -= 1;
    hydratedBytes = Math.max(0, hydratedBytes - task.estimatedTranscriptBytes);
    pendingDeltas.delete(task.threadId);
    pendingReasoningItems.delete(task.threadId);
    for (const key of reasoningStreams.keys()) {
      if (key.startsWith(`${task.threadId}\0`)) reasoningStreams.delete(key);
    }
  }
  return hydratedCount === hydrated.length ? null : tasks;
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
    const tasks = evictColdTranscripts(state, threadId);
    if (!threadId || !state.tasks[threadId]) {
      return tasks ? { activeThreadId: threadId, tasks } : { activeThreadId: threadId };
    }
    const base = tasks ?? state.tasks;
    return {
      activeThreadId: threadId,
      tasks: { ...base, [threadId]: { ...base[threadId], unread: false } },
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
  hydrateTask: (threadId, messages, activities, workspacePath, history) => set((state) => {
    const existing = state.tasks[threadId];
    const hydratedMessages = messages.map((message) => withTimelineOrder({
      ...message,
      turnDurationMs: message.turnDurationMs ?? durationForTurn(threadId, message.turnId),
    }));
    // The turns-derived history excludes the incomplete turn's partially
    // streamed assistant message. Keep it, along with an optimistic user
    // message that may have been appended while the paged read was in flight,
    // so hydration cannot erase a send that is already on screen.
    const hydratedMessageIds = new Set(hydratedMessages.map((message) => message.id));
    const preservedEntries: Array<
      { kind: "message"; entry: ChatMessage }
      | { kind: "activity"; entry: Activity }
    > = (existing?.messages ?? [])
      .filter((message) => (
        message.streaming
        || (message.role === "user" && !message.turnId)
        || Boolean(existing?.activeTurnId && message.turnId === existing.activeTurnId)
      ) && !hydratedMessageIds.has(message.id))
      .map((entry) => ({ kind: "message" as const, entry }));
    const hydratedActivities = activities.map((activity) => withTimelineOrder({
      ...activity,
      turnDurationMs: activity.turnDurationMs ?? durationForTurn(threadId, activity.turnId),
    }));
    const hydratedActivityIds = new Set(hydratedActivities.map((activity) => activity.id));
    preservedEntries.push(...(existing?.activities ?? [])
      .filter((activity) => (
        activity.status === "inProgress"
        || Boolean(existing?.activeTurnId && activity.turnId === existing.activeTurnId)
      ) && !hydratedActivityIds.has(activity.id))
      .map((entry) => ({ kind: "activity" as const, entry })));
    preservedEntries.sort((left, right) => (left.entry.timelineOrder ?? Number.MAX_SAFE_INTEGER) - (right.entry.timelineOrder ?? Number.MAX_SAFE_INTEGER));
    const inFlight: ChatMessage[] = [];
    const inFlightActivities: Activity[] = [];
    for (const preserved of preservedEntries) {
      const { timelineOrder: _order, ...entry } = preserved.entry;
      if (preserved.kind === "message") inFlight.push(withTimelineOrder(entry as ChatMessage));
      else inFlightActivities.push(withTimelineOrder(entry as Activity));
    }
    const nextMessages = [...hydratedMessages, ...inFlight];
    const nextActivities = [...hydratedActivities, ...inFlightActivities];
    const nextTasks = {
      ...state.tasks,
      [threadId]: {
        ...(existing ?? emptyTask(threadId, workspacePath)),
        workspacePath: workspacePath ?? existing?.workspacePath,
        messages: nextMessages,
        activities: nextActivities,
        estimatedTranscriptBytes: estimateTranscriptBytes(nextMessages, nextActivities),
        transcriptDirty: false,
        history: history ?? existing?.history ?? EMPTY_THREAD_HISTORY,
        unread: false,
        updatedAt: Date.now(),
      },
    };
    const statuses = { ...state.statuses, [threadId]: state.statuses[threadId] ?? "idle" };
    const evictedTasks = evictColdTranscripts({ ...state, tasks: nextTasks, statuses }, state.activeThreadId);
    return { tasks: evictedTasks ?? nextTasks, statuses };
  }),
  setHistory: (threadId, patch) => set((state) => {
    const task = state.tasks[threadId];
    if (!task) return state;
    return { tasks: { ...state.tasks, [threadId]: { ...task, history: { ...task.history, ...patch }, updatedAt: Date.now() } } };
  }),
  prependHistory: (threadId, messages, activities, patch) => set((state) => {
    const task = state.tasks[threadId];
    if (!task) return state;
    const existingIds = new Set<string>();
    let oldestOrder = 0;
    let hasOrder = false;
    for (const entry of task.messages) {
      existingIds.add(entry.id);
      if (entry.timelineOrder === undefined) continue;
      oldestOrder = hasOrder ? Math.min(oldestOrder, entry.timelineOrder) : entry.timelineOrder;
      hasOrder = true;
    }
    for (const entry of task.activities) {
      existingIds.add(entry.id);
      if (entry.timelineOrder === undefined) continue;
      oldestOrder = hasOrder ? Math.min(oldestOrder, entry.timelineOrder) : entry.timelineOrder;
      hasOrder = true;
    }
    const seenIds = new Set(existingIds);
    const incoming = [...messages.map((entry) => ({ kind: "message" as const, entry })), ...activities.map((entry) => ({ kind: "activity" as const, entry }))]
      .sort((left, right) => (left.entry.timelineOrder ?? 0) - (right.entry.timelineOrder ?? 0));
    const uniqueIncoming = incoming.filter(({ entry }) => {
      if (seenIds.has(entry.id)) return false;
      seenIds.add(entry.id);
      return true;
    });
    const nextMessages: ChatMessage[] = [];
    const nextActivities: Activity[] = [];
    uniqueIncoming.forEach(({ kind, entry }, index) => {
      const timelineOrder = oldestOrder - uniqueIncoming.length + index;
      if (kind === "message") nextMessages.push({ ...entry, timelineOrder });
      else nextActivities.push({ ...entry, timelineOrder });
    });
    if (!nextMessages.length && !nextActivities.length && Object.keys(patch).length === 0) return state;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          messages: [...nextMessages, ...task.messages],
          activities: [...nextActivities, ...task.activities],
          estimatedTranscriptBytes: task.estimatedTranscriptBytes
            + estimateTranscriptBytes(nextMessages, nextActivities),
          history: { ...task.history, ...patch },
          updatedAt: Date.now(),
        },
      },
    };
  }),
  setTranscriptDirty: (threadId, dirty) => set((state) => {
    const task = state.tasks[threadId];
    if (!task || task.transcriptDirty === dirty) return state;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: { ...task, transcriptDirty: dirty },
      },
    };
  }),
  appendUserMessage: (threadId, message) => set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const nextMessage = withTimelineOrder({ ...message, turnId: message.turnId ?? task.activeTurnId });
    const pendingTurnStartOrder = task.pendingTurnStartOrder
      ?? (task.status === "starting" && !task.activeTurnId ? nextMessage.timelineOrder : undefined);
    return { tasks: { ...state.tasks, [threadId]: {
      ...task,
      pendingTurnStartOrder,
      messages: [...task.messages, nextMessage],
      estimatedTranscriptBytes: task.estimatedTranscriptBytes + ARRAY_SLOT_BYTES + estimateMessageBytes(nextMessage),
      updatedAt: Date.now(),
    } } };
  }),
  setMessageSteerStatus: (threadId, messageId, status) => set((state) => {
    const task = state.tasks[threadId];
    if (!task) return state;
    const index = task.messages.findIndex((message) => message.id === messageId);
    if (index < 0 || task.messages[index].steerStatus === status) return state;
    const messages = [...task.messages];
    const previous = messages[index];
    messages[index] = { ...previous, steerStatus: status };
    return { tasks: { ...state.tasks, [threadId]: {
      ...task,
      messages,
      estimatedTranscriptBytes: adjustedBytes(task.estimatedTranscriptBytes, estimateMessageBytes(previous), estimateMessageBytes(messages[index])),
      updatedAt: Date.now(),
    } } };
  }),
  removeMessage: (threadId, messageId) => set((state) => {
    const task = state.tasks[threadId];
    const removed = task?.messages.filter((message) => message.id === messageId) ?? [];
    if (!task || removed.length === 0) return state;
    const removedBytes = estimateTranscriptBytes(removed, []);
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          pendingTurnStartOrder: removed.some((message) => task.pendingTurnStartOrder === message.timelineOrder)
            ? undefined
            : task.pendingTurnStartOrder,
          messages: task.messages.filter((message) => message.id !== messageId),
          estimatedTranscriptBytes: Math.max(0, task.estimatedTranscriptBytes - removedBytes),
          updatedAt: Date.now(),
        },
      },
    };
  }),
  queueAssistantDelta: (threadId, itemId, delta) => {
    // Delta text is frame-batched below, but the steering lock must become
    // authoritative synchronously. Otherwise a click in that frame can still
    // reach turn/steer even though final output has already started arriving.
    const currentTask = delta ? get().tasks[threadId] : undefined;
    if (delta) {
      if (currentTask?.activeTurnId && currentTask.assistantOutputTurnId !== currentTask.activeTurnId) {
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
    recordStreamingDelta(threadId, delta.length, performance.now(), currentTask?.activeTurnId);
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
    recordStreamingDelta(threadId, delta.length, performance.now(), current?.activeTurnId);
    scheduleDeltaFlush(get().flushDeltas);
  },
  flushDeltas: () => {
    if (!pendingDeltas.size && !pendingReasoningItems.size) return;
    const flushStartedAt = performance.now();
    const batch = new Map(pendingDeltas);
    const reasoningBatch = new Map(pendingReasoningItems);
    pendingDeltas.clear();
    pendingReasoningItems.clear();
    set((state) => {
      const tasks = { ...state.tasks };
      const threadIds = new Set([...batch.keys(), ...reasoningBatch.keys()]);
      for (const threadId of threadIds) {
        const task = tasks[threadId] ?? emptyTask(threadId);
        let estimatedTranscriptBytes = task.estimatedTranscriptBytes;
        let messages = task.messages;
        let messagesCopied = false;
        for (const [itemId, delta] of batch.get(threadId) ?? []) {
          const index = messages.findIndex((message) => message.id === itemId);
          if (index < 0) {
            const nextMessage = withTimelineOrder<ChatMessage>({ id: itemId, role: "assistant", text: delta, streaming: true, turnId: task.activeTurnId });
            messages = [...messages, nextMessage];
            estimatedTranscriptBytes += ARRAY_SLOT_BYTES + estimateMessageBytes(nextMessage);
            messagesCopied = true;
          } else {
            if (!messagesCopied) {
              messages = [...messages];
              messagesCopied = true;
            }
            const message = messages[index];
            messages[index] = { ...message, text: `${message.text}${delta}`, streaming: true };
            estimatedTranscriptBytes = adjustedBytes(
              estimatedTranscriptBytes,
              estimateMessageBytes(message),
              estimateMessageBytes(messages[index]),
            );
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
            const nextActivity = withTimelineOrder(activity);
            activities = [...activities, nextActivity];
            estimatedTranscriptBytes += ARRAY_SLOT_BYTES + estimateActivityBytes(nextActivity);
            activitiesCopied = true;
          } else {
            if (!activitiesCopied) {
              activities = [...activities];
              activitiesCopied = true;
            }
            const previous = activities[index];
            activities[index] = { ...previous, ...activity, turnId: activity.turnId ?? previous.turnId, turnStatus: activity.turnStatus ?? previous.turnStatus, timelineOrder: previous.timelineOrder };
            estimatedTranscriptBytes = adjustedBytes(
              estimatedTranscriptBytes,
              estimateActivityBytes(previous),
              estimateActivityBytes(activities[index]),
            );
          }
        }
        tasks[threadId] = { ...task, messages, activities, estimatedTranscriptBytes, unread: state.activeThreadId !== threadId, updatedAt: Date.now() };
      }
      return { tasks };
    });
    recordStreamingFlush(new Set([...batch.keys(), ...reasoningBatch.keys()]), flushStartedAt, performance.now());
  },
  completeMessage: (threadId, message) => {
    // Drop any queued deltas for this item so a flush scheduled before the
    // completion event cannot re-append the tail of the finalized text.
    pendingDeltas.get(threadId)?.delete(message.id);
    return set((state) => {
    const task = state.tasks[threadId] ?? emptyTask(threadId);
    const existingIndex = task.messages.findIndex((entry) => entry.id === message.id);
    const nextMessage = existingIndex >= 0
      ? { ...message, streaming: false, turnId: message.turnId ?? task.messages[existingIndex].turnId ?? task.activeTurnId, turnStatus: message.turnStatus ?? task.messages[existingIndex].turnStatus, timelineOrder: task.messages[existingIndex].timelineOrder }
      : withTimelineOrder({ ...message, streaming: false, turnId: message.turnId ?? task.activeTurnId });
    const messages = existingIndex >= 0
      ? task.messages.map((entry, index) => index === existingIndex ? nextMessage : entry)
      : [...task.messages, nextMessage];
    const estimatedTranscriptBytes = existingIndex >= 0
      ? adjustedBytes(task.estimatedTranscriptBytes, estimateMessageBytes(task.messages[existingIndex]), estimateMessageBytes(nextMessage))
      : task.estimatedTranscriptBytes + ARRAY_SLOT_BYTES + estimateMessageBytes(nextMessage);
    const messageTurnId = message.turnId ?? task.activeTurnId;
    const assistantOutputTurnId = task.status === "running"
      && message.role === "assistant"
      && Boolean(message.text)
      && messageTurnId === task.activeTurnId
      ? task.activeTurnId
      : task.assistantOutputTurnId;
    return { tasks: { ...state.tasks, [threadId]: { ...task, messages, estimatedTranscriptBytes, assistantOutputTurnId, unread: state.activeThreadId !== threadId, updatedAt: Date.now() } } };
    });
  },
  upsertActivity: (threadId, activity) => {
    if (activity.kind === "reasoning" && activity.status === "completed") reasoningStreams.delete(`${threadId}\0${activity.id}`);
    set((state) => {
      const task = state.tasks[threadId] ?? emptyTask(threadId);
      const existingIndex = task.activities.findIndex((entry) => entry.id === activity.id);
      const exists = existingIndex >= 0;
      const activityTurnId = activity.turnId ?? task.activeTurnId;
      const activities = exists
        ? task.activities.map((entry, index) => {
            if (index !== existingIndex) return entry;
            const representedChildren = activity.agent?.threadIds ?? entry.agent?.threadIds ?? [];
            const terminalSpawn = entry.kind === "agent"
              && entry.agent?.action === "spawn"
              && ["completed", "cancelled", "interrupted", "failed", "error"].includes(entry.status ?? "");
            const stoppedSpawn = ["cancelled", "interrupted"].includes(entry.status ?? "");
            const childrenRemainTerminal = representedChildren.length > 0
              && representedChildren.every((childId) => !["starting", "running"].includes(state.statuses[childId] ?? "idle"));
            const lateReactivation = terminalSpawn
              && isActiveAgentRecord(activity.status ?? "")
              && childrenRemainTerminal;
            const preserveStopped = stoppedSpawn && childrenRemainTerminal;
            return {
              ...activity,
              // Stop can race final provider events. Once every represented
              // child task is terminal, a late event may enrich the card but
              // must never replace its explicit Stopped outcome.
              status: lateReactivation || preserveStopped ? entry.status : activity.status,
              turnId: activity.turnId ?? entry.turnId ?? task.activeTurnId,
              turnStatus: activity.turnStatus ?? entry.turnStatus,
              timelineOrder: entry.timelineOrder,
            };
          })
        : [...task.activities, withTimelineOrder({ ...activity, turnId: activity.turnId ?? task.activeTurnId })];
      const beginsNewWork = !exists
        && activity.kind !== "warning"
        && activity.status !== "completed"
        && activity.status !== "failed";
      const assistantOutputTurnId = beginsNewWork && activityTurnId === task.assistantOutputTurnId
        ? undefined
        : task.assistantOutputTurnId;
      const estimatedTranscriptBytes = exists
        ? adjustedBytes(
            task.estimatedTranscriptBytes,
            estimateActivityBytes(task.activities[existingIndex]),
            estimateActivityBytes(activities[existingIndex]),
          )
        : task.estimatedTranscriptBytes + ARRAY_SLOT_BYTES + estimateActivityBytes(activities[activities.length - 1]);
      return { tasks: { ...state.tasks, [threadId]: {
        ...task,
        activities,
        estimatedTranscriptBytes,
        assistantOutputTurnId,
        unread: state.activeThreadId !== threadId,
        updatedAt: Date.now(),
      } } };
    });
  },
  setActiveTurn: (threadId, turnId) => {
    bindRuntimePerformanceTurn(threadId, turnId);
    set((state) => {
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
      return { tasks: { ...state.tasks, [threadId]: {
        ...task,
        activeTurnId: turnId,
        assistantOutputTurnId,
        pendingTurnStartOrder: turnId ? undefined : task.pendingTurnStartOrder,
        messages,
        activities,
        estimatedTranscriptBytes: threshold === undefined
          ? task.estimatedTranscriptBytes
          : estimateTranscriptBytes(messages, activities),
        updatedAt: Date.now(),
      } } };
    });
  },
  completeTurn: (threadId, turnId, status) => {
    const previousTask = get().tasks[threadId];
    const newerTurnActive = Boolean(previousTask?.activeTurnId && turnId && previousTask.activeTurnId !== turnId);
    set((state) => {
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
        ? {
            ...message,
            // A terminal turn cannot still have a streaming message. Sealing
            // it here also lets the timeline identify the final response and
            // collapse the preceding work reliably after crash recovery.
            streaming: false,
            turnStatus,
            turnDurationMs: turnDurationMs ?? message.turnDurationMs,
          }
        : message)
      : task.messages;
    const terminalAgentStatus = status === "completed"
      ? "completed"
      : status === "interrupted"
        ? "interrupted"
        : "failed";
    const agents = newerTurnActive
      ? task.agents
      : task.agents.map((agent) => {
          if (!isActiveAgentRecord(agent.status)) return agent;
          const childStatus = state.statuses[agent.id];
          // A child is live only when its own task says so. Provider-native
          // `started` records occasionally arrive without a matching terminal
          // event; letting the parent record win forever leaves Stop and the
          // concurrency counter stuck after the parent has visibly finished.
          if (childStatus === "starting" || childStatus === "running") return agent;
          return { ...agent, status: terminalAgentStatus };
        });
    const activeAgentIds = new Set(agents.filter((agent) => isActiveAgentRecord(agent.status)).map((agent) => agent.id));
    const activities = completedTurnId
      ? task.activities.map((activity) => activity.turnId === completedTurnId
        ? (() => {
            const isLiveSpawn = activity.kind === "agent"
              && activity.agent?.action === "spawn"
              && isActiveAgentRecord(activity.status ?? "");
            const representedChildren = activity.agent?.threadIds ?? [];
            const childStillActive = representedChildren.length
              ? representedChildren.some((childThreadId) => activeAgentIds.has(childThreadId)
                || state.statuses[childThreadId] === "starting"
                || state.statuses[childThreadId] === "running")
              : activeAgentIds.size > 0;
            const shouldSettle = activity.status === "inProgress" && !isLiveSpawn
              || (isLiveSpawn && !childStillActive);
            return {
              ...activity,
              // Spawn cards may outlive their parent only while at least one
              // represented child task is genuinely active. This keeps the
              // timeline, composer Stop button, and worker count in agreement.
              status: shouldSettle ? terminalAgentStatus : activity.status,
              turnStatus,
              turnDurationMs: turnDurationMs ?? activity.turnDurationMs,
            };
          })()
        : activity)
      : task.activities;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          messages,
          activities,
          estimatedTranscriptBytes: completedTurnId
            ? estimateTranscriptBytes(messages, activities)
            : task.estimatedTranscriptBytes,
          agents,
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
    });
    if (!newerTurnActive) {
      completeRuntimePerformanceTurn(
        threadId,
        status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "error",
        turnId,
      );
    }
  },
  setTaskStatus: (threadId, status, error) => {
    const previousTask = get().tasks[threadId];
    const wasWorking = previousTask?.status === "starting" || previousTask?.status === "running";
    const isWorking = status === "starting" || status === "running";
    if (isWorking && !wasWorking) beginRuntimePerformanceTurn(threadId);
    set((state) => {
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
    // Disconnects and systemError may have no turn/completed event. Stop the
    // compaction animation without inventing a successful provider boundary.
    const stalledCompaction = (activity: Activity) => activity.kind === "compaction" && activity.status === "inProgress";
    let estimatedTranscriptBytes = task.estimatedTranscriptBytes;
    const activities = !isWorking && task.activities.some(stalledCompaction)
      ? task.activities.map((activity) => {
          if (!stalledCompaction(activity)) return activity;
          const settled = { ...activity, status: "interrupted" };
          estimatedTranscriptBytes = adjustedBytes(estimatedTranscriptBytes, estimateActivityBytes(activity), estimateActivityBytes(settled));
          return settled;
        })
      : task.activities;
    return {
      tasks: {
        ...state.tasks,
        [threadId]: {
          ...task,
          status,
          error,
          activities,
          estimatedTranscriptBytes,
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
    });
    if (wasWorking && !isWorking) {
      completeRuntimePerformanceTurn(
        threadId,
        status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : status === "error" ? "error" : "abandoned",
      );
    }
  },
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
    const agents = exists ? task.agents.map((entry) => {
      if (entry.id !== agent.id) return entry;
      const terminal = ["completed", "cancelled", "interrupted", "failed", "error"].includes(entry.status);
      const childRemainsTerminal = !["starting", "running"].includes(state.statuses[agent.id] ?? "idle");
      const lateReactivation = terminal && isActiveAgentRecord(agent.status) && childRemainsTerminal;
      const preserveStopped = ["cancelled", "interrupted"].includes(entry.status) && childRemainsTerminal;
      return { ...entry, ...agent, status: lateReactivation || preserveStopped ? entry.status : agent.status };
    }) : [...task.agents, agent];
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
  resetRuntimePerformanceDiagnostics();
  pendingDeltas.clear();
  pendingReasoningItems.clear();
  reasoningStreams.clear();
  timelineSequence = 0;
  removeStoredValue(USAGE_LEDGER_KEY);
  resetUsageLedgerCache();
  queuedTurnsCache = {};
  transcriptCacheHighWaterBytes = DEFAULT_TRANSCRIPT_CACHE_HIGH_WATER_BYTES;
  transcriptCacheLowWaterBytes = DEFAULT_TRANSCRIPT_CACHE_LOW_WATER_BYTES;
  removeStoredValue(QUEUED_TURNS_KEY);
  useTaskStore.setState({ activeThreadId: null, tasks: {}, statuses: {} });
}

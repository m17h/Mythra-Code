import type { CursorEvent } from "./cursor";
import type { JsonObject } from "./codex";
import type { TokenUsageView } from "../components/StudioDock";
import { useTaskStore } from "./taskStore";

const activeAssistantSegments = new Map<string, string>();
const assistantSegmentCounts = new Map<string, number>();
// Turns whose `result` (or terminal error) already arrived. Cursor can deliver
// a late session/update after the result; treating it as fresh work would flip
// the completed thread back to "running" forever.
const completedTurns = new Set<string>();
const MAX_COMPLETED_TURNS = 200;
// Turns whose usage was already accumulated from in-turn `usage_update`
// snapshots; the result total for those turns must not be added again.
const turnsWithUsageSnapshots = new Set<string>();

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}

function markTurnCompleted(key: string): void {
  completedTurns.delete(key);
  completedTurns.add(key);
  if (completedTurns.size > MAX_COMPLETED_TURNS) {
    const oldest = completedTurns.values().next().value;
    if (oldest !== undefined) completedTurns.delete(oldest);
  }
}

/**
 * Cursor's ACP stream does not provide a message-completed notification and
 * may emit assistant text both before and after tool calls. Keep each stretch
 * of text on its own timeline item so the final answer is anchored after the
 * work that produced it instead of at the turn's first text chunk.
 */
function assistantMessageId(threadId: string, turnId: string): string {
  const key = turnKey(threadId, turnId);
  const active = activeAssistantSegments.get(key);
  if (active) return active;
  const next = (assistantSegmentCounts.get(key) ?? 0) + 1;
  assistantSegmentCounts.set(key, next);
  const id = `cursor-${turnId}-message-${next}`;
  activeAssistantSegments.set(key, id);
  return id;
}

function finalizeAssistantSegments(threadId: string, turnId: string, all = false): void {
  const key = turnKey(threadId, turnId);
  const activeId = activeAssistantSegments.get(key);
  const store = useTaskStore.getState();
  // Materialize queued chunks before looking up their message objects.
  store.flushDeltas();
  const messages = useTaskStore.getState().tasks[threadId]?.messages ?? [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.streaming || message.turnId !== turnId) continue;
    if (!all && message.id !== activeId) continue;
    store.completeMessage(threadId, { ...message, streaming: false });
  }
  activeAssistantSegments.delete(key);
  if (all) assistantSegmentCounts.delete(key);
}

export function resetCursorEventStateForTests(): void {
  activeAssistantSegments.clear();
  assistantSegmentCounts.clear();
  completedTurns.clear();
  turnsWithUsageSnapshots.clear();
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentText(value: unknown): string {
  const content = object(value);
  return content.type === "text" ? text(content.text) : "";
}

function activityKind(kind: string): "command" | "file" | "agent" {
  if (/edit|delete|move|write/i.test(kind)) return "file";
  if (/agent|search/i.test(kind)) return "agent";
  return "command";
}

function detailFor(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(-4000);
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded && encoded !== "{}" ? encoded.slice(-4000) : undefined;
  } catch {
    return undefined;
  }
}

function usageView(value: unknown): TokenUsageView | null {
  const usage = object(value);
  const inputTokens = number(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = number(usage.outputTokens ?? usage.output_tokens);
  if (!inputTokens && !outputTokens) return null;
  return {
    totalTokens: number(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: number(usage.cachedInputTokens ?? usage.cached_input_tokens),
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: number(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens),
    contextWindow: number(usage.contextWindow ?? usage.context_window) || null,
  };
}

export interface CursorEventContext {
  bindingFor: (threadId: string) => string | undefined;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onTurnCompleted: (threadId: string) => void;
  onApprovalRequested: (threadId: string) => void;
  onTranscriptChanged: (threadId: string) => void;
}

export function routeCursorEvent(event: CursorEvent, ctx: CursorEventContext): void {
  const { threadId, turnId } = event;
  const message = object(event.message);
  const store = useTaskStore.getState();
  store.ensureTask(threadId, ctx.bindingFor(threadId));
  const turnAlreadyCompleted = completedTurns.has(turnKey(threadId, turnId));

  if (message.type === "permission_request") {
    const params = object(message.params);
    const tool = object(params.toolCall);
    store.enqueueApproval({
      id: (message.requestId as string | number) ?? crypto.randomUUID(),
      method: "cursor/request_permission",
      params: {
        ...params,
        command: text(object(tool.rawInput).command),
        reason: text(tool.title) || "Cursor wants to use a tool",
      },
      threadId,
      receivedAt: Date.now(),
    });
    ctx.onApprovalRequested(threadId);
    return;
  }

  if (message.type === "cursor_request" && message.method === "cursor/ask_question") {
    const params = object(message.params);
    const questions = (Array.isArray(params.questions) ? params.questions : []).map((value) => {
      const question = object(value);
      return {
        id: text(question.id),
        header: "Question",
        question: text(question.prompt),
        options: (Array.isArray(question.options) ? question.options : []).map((option) => {
          const entry = object(option);
          return { label: text(entry.label), description: text(entry.label) };
        }),
      };
    });
    store.enqueueApproval({
      id: (message.requestId as string | number) ?? crypto.randomUUID(),
      method: "cursor/ask_question",
      params: { questions },
      threadId,
      receivedAt: Date.now(),
    });
    ctx.onApprovalRequested(threadId);
    return;
  }

  if (message.type === "notification" && message.method === "cursor/create_plan") {
    const params = object(message.params);
    const id = `cursor-plan-${turnId}`;
    const existing = useTaskStore.getState().tasks[threadId]?.activities.find((activity) => activity.id === id);
    if (turnAlreadyCompleted && !existing) return;
    if (!turnAlreadyCompleted) {
      store.setActiveTurn(threadId, turnId);
      store.setTaskStatus(threadId, "running");
      ctx.onStatus("Working");
    }
    store.upsertActivity(threadId, { id, kind: "agent", title: text(params.name) || "Cursor plan", detail: text(params.plan) || text(params.overview), status: "inProgress" });
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (message.type === "notification" && message.method === "cursor/update_todos") {
    const params = object(message.params);
    const todos = Array.isArray(params.todos) ? params.todos : [];
    const id = `cursor-plan-${turnId}`;
    const existing = useTaskStore.getState().tasks[threadId]?.activities.find((activity) => activity.id === id);
    if (turnAlreadyCompleted && !existing) return;
    if (!turnAlreadyCompleted) {
      store.setActiveTurn(threadId, turnId);
      store.setTaskStatus(threadId, "running");
      ctx.onStatus("Working");
    }
    store.upsertActivity(threadId, {
      id,
      kind: "agent",
      title: "Cursor plan",
      detail: todos.map((value) => {
        const todo = object(value);
        return `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "→" : "○"} ${text(todo.content) || text(todo.title)}`;
      }).join("\n"),
      status: todos.length > 0 && todos.every((value) => object(value).status === "completed") ? "completed" : "inProgress",
    });
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (message.type === "notification" && message.method === "session/update") {
    const update = object(object(message.params).update);
    const kind = text(update.sessionUpdate);
    if (!turnAlreadyCompleted) {
      // Install the turn before materializing a tool/plan activity. Cursor can
      // emit notifications before session/prompt returns; doing this at the
      // end left the first activity detached from its turn in that race.
      store.setActiveTurn(threadId, turnId);
      store.setTaskStatus(threadId, "running");
      ctx.onStatus("Working");
    }
    if (kind === "agent_message_chunk") {
      // Skip empty/non-text chunks so they cannot open a segment that would
      // finalize into an empty assistant bubble at the next tool boundary.
      // A chunk arriving after the turn's result would open a streaming
      // segment nothing will ever finalize, so drop it too.
      const delta = contentText(update.content);
      if (delta && !turnAlreadyCompleted) store.queueAssistantDelta(threadId, assistantMessageId(threadId, turnId), delta);
    } else if (kind === "agent_thought_chunk") {
      if (!turnAlreadyCompleted) store.queueReasoningDelta(threadId, `thinking-${turnId}`, contentText(update.content), "content");
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      // A new tool call ends the preceding assistant-text segment. Updates to
      // an already-running tool are not boundaries because Cursor can deliver
      // a late status update while it has started streaming its final answer.
      if (kind === "tool_call") finalizeAssistantSegments(threadId, turnId);
      const id = text(update.toolCallId) || crypto.randomUUID();
      const existing = useTaskStore.getState().tasks[threadId]?.activities.find((activity) => activity.id === id);
      const status = text(update.status);
      // A genuinely new tool after result is stale noise and would otherwise
      // appear below the final answer, detached from the completed turn. A
      // late status update for a tool we already showed may still refine it.
      if (!turnAlreadyCompleted || existing) {
        store.upsertActivity(threadId, {
          id,
          kind: activityKind(text(update.kind) || existing?.kind || "tool"),
          title: text(update.title) || existing?.title || "Cursor tool",
          detail: detailFor(update.rawOutput ?? update.rawInput ?? update.content) || existing?.detail,
          status: status === "completed" ? "completed" : status === "failed" ? "failed" : "inProgress",
        });
      }
    } else if (kind === "plan") {
      const entries = Array.isArray(object(update.plan).entries) ? object(update.plan).entries as unknown[] : [];
      const id = `cursor-plan-${turnId}`;
      const existing = useTaskStore.getState().tasks[threadId]?.activities.find((activity) => activity.id === id);
      if (!turnAlreadyCompleted || existing) {
        store.upsertActivity(threadId, {
          id,
          kind: "agent",
          title: "Cursor plan",
          detail: entries.map((entry) => {
            const item = object(entry);
            return `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "→" : "○"} ${text(item.content)}`;
          }).join("\n"),
          status: entries.every((entry) => object(entry).status === "completed") ? "completed" : "inProgress",
        });
      }
    } else if (kind === "usage_update") {
      const usage = usageView(update.usage ?? update);
      if (usage && !turnAlreadyCompleted) {
        store.setUsage(threadId, usage);
        turnsWithUsageSnapshots.add(turnKey(threadId, turnId));
      }
    }
    // A late update for a turn that already delivered its result may still
    // refine content (a tool call finishing), but must not resurrect the
    // thread as busy or reinstall the finished turn as active.
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (message.type === "result") {
    const key = turnKey(threadId, turnId);
    finalizeAssistantSegments(threadId, turnId, true);
    markTurnCompleted(key);
    const result = object(message.result);
    const usage = usageView(result.usage);
    // In-turn usage_update snapshots already accumulated this turn's tokens
    // through the cumulative-snapshot path; adding the result total on top
    // would double count and corrupt the snapshot baseline.
    if (usage && !turnsWithUsageSnapshots.has(key)) store.addUsage(threadId, usage, `cursor-result:${turnId}`);
    turnsWithUsageSnapshots.delete(key);
    // Re-read state: the flush inside finalizeAssistantSegments may have just
    // materialized the thinking activity, which the entry snapshot predates.
    const task = useTaskStore.getState().tasks[threadId];
    const thinking = task?.activities.find((activity) => activity.id === `thinking-${turnId}`);
    if (thinking?.detail) store.upsertActivity(threadId, { ...thinking, status: "completed" });
    const interrupted = result.stopReason === "cancelled" || task?.status === "interrupted";
    store.completeTurn(threadId, turnId, interrupted ? "interrupted" : "completed");
    ctx.onStatus(interrupted ? "Stopped" : "Ready");
    ctx.onTranscriptChanged(threadId);
    ctx.onTurnCompleted(threadId);
    return;
  }

  if (message.type === "openkiwi_error" || message.type === "openkiwi_exit") {
    const key = turnKey(threadId, turnId);
    finalizeAssistantSegments(threadId, turnId, true);
    markTurnCompleted(key);
    turnsWithUsageSnapshots.delete(key);
    const detail = text(message.message) || "Cursor Agent stopped unexpectedly.";
    const interrupted = useTaskStore.getState().tasks[threadId]?.status === "interrupted";
    store.completeTurn(threadId, turnId, interrupted ? "interrupted" : "error");
    if (!interrupted) {
      store.setTaskStatus(threadId, "error", detail);
      store.upsertActivity(threadId, { id: `cursor-error-${turnId}`, kind: "warning", title: "Cursor Agent stopped", detail, status: "failed" });
      ctx.onError(detail);
    }
    ctx.onStatus(interrupted ? "Stopped" : "Task failed");
    ctx.onTurnCompleted(threadId);
  }
}

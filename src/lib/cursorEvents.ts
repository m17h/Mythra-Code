import type { CursorEvent } from "./cursor";
import type { JsonObject } from "./codex";
import type { TokenUsageView } from "../components/StudioDock";
import { useTaskStore } from "./taskStore";

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
    store.upsertActivity(threadId, { id: `cursor-plan-${turnId}`, kind: "agent", title: text(params.name) || "Cursor plan", detail: text(params.plan) || text(params.overview), status: "inProgress" });
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (message.type === "notification" && message.method === "cursor/update_todos") {
    const params = object(message.params);
    const todos = Array.isArray(params.todos) ? params.todos : [];
    store.upsertActivity(threadId, {
      id: `cursor-plan-${turnId}`,
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
    if (kind === "agent_message_chunk") {
      store.queueAssistantDelta(threadId, text(update.messageId) || `cursor-${turnId}`, contentText(update.content));
    } else if (kind === "agent_thought_chunk") {
      store.queueReasoningDelta(threadId, `thinking-${turnId}`, contentText(update.content), "content");
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = text(update.toolCallId) || crypto.randomUUID();
      const existing = store.tasks[threadId]?.activities.find((activity) => activity.id === id);
      const status = text(update.status);
      store.upsertActivity(threadId, {
        id,
        kind: activityKind(text(update.kind) || existing?.kind || "tool"),
        title: text(update.title) || existing?.title || "Cursor tool",
        detail: detailFor(update.rawOutput ?? update.rawInput ?? update.content) || existing?.detail,
        status: status === "completed" ? "completed" : status === "failed" ? "failed" : "inProgress",
      });
    } else if (kind === "plan") {
      const entries = Array.isArray(object(update.plan).entries) ? object(update.plan).entries as unknown[] : [];
      store.upsertActivity(threadId, {
        id: `cursor-plan-${turnId}`,
        kind: "agent",
        title: "Cursor plan",
        detail: entries.map((entry) => {
          const item = object(entry);
          return `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "→" : "○"} ${text(item.content)}`;
        }).join("\n"),
        status: entries.every((entry) => object(entry).status === "completed") ? "completed" : "inProgress",
      });
    } else if (kind === "usage_update") {
      const usage = usageView(update.usage ?? update);
      if (usage) store.setUsage(threadId, usage);
    }
    store.setActiveTurn(threadId, turnId);
    store.setTaskStatus(threadId, "running");
    ctx.onStatus("Working");
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (message.type === "result") {
    store.flushDeltas();
    const result = object(message.result);
    const usage = usageView(result.usage);
    if (usage) store.addUsage(threadId, usage, `cursor-result:${turnId}`);
    const thinking = store.tasks[threadId]?.activities.find((activity) => activity.id === `thinking-${turnId}`);
    if (thinking?.detail) store.upsertActivity(threadId, { ...thinking, status: "completed" });
    const interrupted = result.stopReason === "cancelled" || store.tasks[threadId]?.status === "interrupted";
    store.completeTurn(threadId, turnId, interrupted ? "interrupted" : "completed");
    ctx.onStatus(interrupted ? "Stopped" : "Ready");
    ctx.onTranscriptChanged(threadId);
    ctx.onTurnCompleted(threadId);
    return;
  }

  if (message.type === "openkiwi_error" || message.type === "openkiwi_exit") {
    store.flushDeltas();
    const detail = text(message.message) || "Cursor Agent stopped unexpectedly.";
    const interrupted = store.tasks[threadId]?.status === "interrupted";
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

import type { ClaudeEvent } from "./claude";
import type { JsonObject } from "./codex";
import type { TokenUsageView } from "../components/StudioDock";
import { useTaskStore } from "./taskStore";
import { consumeProviderStopIntent } from "./providerStopIntent";

interface ClaudeBlock {
  id: string;
  name: string;
  input: string;
}

const assistantIds = new Map<string, string>();
const blocks = new Map<string, Map<number, ClaudeBlock>>();
const partialUsage = new Map<string, { usage: TokenUsageView; messageIds: Set<string> }>();

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageView(value: unknown): TokenUsageView | null {
  const usage = object(value);
  if (!Object.keys(usage).length) return null;
  const inputTokens =
    number(usage.input_tokens) +
    number(usage.cache_creation_input_tokens) +
    number(usage.cache_read_input_tokens);
  const cachedInputTokens = number(usage.cache_read_input_tokens);
  const cacheWriteInputTokens = number(usage.cache_creation_input_tokens);
  const outputTokens = number(usage.output_tokens);
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    contextWindow: null,
  };
}

function addUsage(left: TokenUsageView, right: TokenUsageView): TokenUsageView {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: (left.cacheWriteInputTokens ?? 0) + (right.cacheWriteInputTokens ?? 0),
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    contextWindow: null,
  };
}

function remainingUsage(total: TokenUsageView, recorded: TokenUsageView): TokenUsageView {
  const inputTokens = Math.max(0, total.inputTokens - recorded.inputTokens);
  const outputTokens = Math.max(0, total.outputTokens - recorded.outputTokens);
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: Math.max(0, total.cachedInputTokens - recorded.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, (total.cacheWriteInputTokens ?? 0) - (recorded.cacheWriteInputTokens ?? 0)),
    outputTokens,
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - recorded.reasoningOutputTokens),
    contextWindow: null,
  };
}

function recordAssistantUsage(threadId: string, turnId: string, messageId: string, value: unknown): void {
  const usage = usageView(value);
  if (!usage || usage.totalTokens <= 0) return;
  const key = `${threadId}\0${turnId}`;
  const current = partialUsage.get(key);
  if (current?.messageIds.has(messageId)) return;
  useTaskStore.getState().addUsage(threadId, usage, `claude-assistant:${messageId}`);
  partialUsage.set(key, {
    usage: current ? addUsage(current.usage, usage) : usage,
    messageIds: new Set([...(current?.messageIds ?? []), messageId]),
  });
  if (partialUsage.size > 100) {
    // Evict the oldest-inserted turn that is not currently live; dropping a
    // live turn's partial record would double count its usage at the result.
    const tasks = useTaskStore.getState().tasks;
    let evictKey: string | undefined;
    for (const candidate of partialUsage.keys()) {
      const separator = candidate.indexOf("\0");
      const candidateThread = candidate.slice(0, separator);
      const candidateTurn = candidate.slice(separator + 1);
      if (tasks[candidateThread]?.activeTurnId === candidateTurn) continue;
      evictKey = candidate;
      break;
    }
    partialUsage.delete(evictKey ?? (partialUsage.keys().next().value as string));
  }
}

function recordResultUsage(threadId: string, turnId: string, value: unknown): void {
  const key = `${threadId}\0${turnId}`;
  const recorded = partialUsage.get(key)?.usage;
  partialUsage.delete(key);
  const total = usageView(value);
  if (!total) return;
  const usage = recorded ? remainingUsage(total, recorded) : total;
  if (usage.totalTokens > 0) {
    useTaskStore.getState().addUsage(threadId, usage, `claude-result:${turnId}`);
  }
}

export function resetClaudeEventUsageState(): void {
  partialUsage.clear();
}

function activityKind(name: string): "command" | "file" | "agent" {
  if (/^(write|edit|notebookedit)$/i.test(name)) return "file";
  if (/^(task|sendmessage|taskcreate|taskupdate|teamcreate)$/i.test(name))
    return "agent";
  return "command";
}

function activityTitle(name: string, input: JsonObject): string {
  if (/^bash$/i.test(name)) return text(input.command) || "Run command";
  if (/^(write|edit|notebookedit|read)$/i.test(name))
    return text(input.file_path) || text(input.path) || name;
  if (/^task$/i.test(name))
    return text(input.description) || "Delegate to sub-agent";
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function activityDetail(input: JsonObject): string | undefined {
  const direct = text(input.description) || text(input.prompt);
  if (direct) return direct;
  try {
    const encoded = JSON.stringify(input, null, 2);
    return encoded === "{}" ? undefined : encoded.slice(-4000);
  } catch {
    return undefined;
  }
}

function finalizeTool(threadId: string, block: ClaudeBlock): void {
  let input: JsonObject = {};
  try {
    input = object(JSON.parse(block.input || "{}"));
  } catch {
    input = { input: block.input };
  }
  useTaskStore.getState().upsertActivity(threadId, {
    id: block.id,
    kind: activityKind(block.name),
    title: activityTitle(block.name, input),
    detail: activityDetail(input),
    status: "inProgress",
  });
}

export interface ClaudeEventContext {
  bindingFor: (threadId: string) => string | undefined;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onTurnCompleted: (threadId: string) => void;
  onApprovalRequested: (threadId: string) => void;
  onTranscriptChanged: (threadId: string) => void;
  onUnsupportedControlRequest: (
    threadId: string,
    requestId: string,
    subtype: string,
  ) => void;
}

function foregroundStatus(ctx: ClaudeEventContext, threadId: string, status: string): void {
  if (useTaskStore.getState().activeThreadId === threadId) ctx.onStatus(status);
}

function foregroundError(ctx: ClaudeEventContext, threadId: string, message: string): void {
  if (useTaskStore.getState().activeThreadId === threadId) ctx.onError(message);
}

export function routeClaudeEvent(
  event: ClaudeEvent,
  ctx: ClaudeEventContext,
): void {
  const { threadId, turnId } = event;
  const message = object(event.message);
  const type = text(message.type);
  const store = useTaskStore.getState();
  store.ensureTask(threadId, ctx.bindingFor(threadId));

  if (type === "control_request") {
    const request = object(message.request);
    if (request.subtype === "can_use_tool") {
      const input = object(request.input);
      store.enqueueApproval({
        id: text(message.request_id),
        method: "claude/can_use_tool",
        params: {
          ...request,
          command: input.command,
          reason: request.decision_reason || request.description,
        },
        threadId,
        receivedAt: Date.now(),
      });
      ctx.onApprovalRequested(threadId);
      return;
    }
    // A blocking control request OpenKiwi does not implement (a newer CLI's
    // hook callback or permission variant). Never leave it unanswered — a CLI
    // waiting on the reply would stall the turn until the process is killed.
    const requestId = text(message.request_id);
    const subtype = text(request.subtype) || "unknown";
    if (requestId) ctx.onUnsupportedControlRequest(threadId, requestId, subtype);
    store.upsertActivity(threadId, {
      id: `claude-control-${requestId || crypto.randomUUID()}`,
      kind: "warning",
      title: "Unsupported Claude Code request",
      detail: `Claude Code sent a \`${subtype}\` control request this version of OpenKiwi does not support. It was answered with an error; updating OpenKiwi may be required.`,
    });
    return;
  }

  if (type === "stream_event") {
    const stream = object(message.event);
    const streamType = text(stream.type);
    if (streamType === "message_start") {
      const assistant = object(stream.message);
      assistantIds.set(threadId, text(assistant.id) || `claude-${turnId}`);
      store.setActiveTurn(threadId, turnId);
      store.setTaskStatus(threadId, "running");
      foregroundStatus(ctx, threadId, "Working");
      return;
    }
    if (streamType === "content_block_start") {
      const block = object(stream.content_block);
      if (block.type === "tool_use") {
        const byIndex = blocks.get(threadId) ?? new Map<number, ClaudeBlock>();
        byIndex.set(Number(stream.index ?? 0), {
          id: text(block.id) || crypto.randomUUID(),
          name: text(block.name) || "Tool",
          input: "",
        });
        blocks.set(threadId, byIndex);
      }
      return;
    }
    if (streamType === "content_block_delta") {
      const delta = object(stream.delta);
      if (delta.type === "text_delta") {
        store.queueAssistantDelta(
          threadId,
          assistantIds.get(threadId) || `claude-${turnId}`,
          text(delta.text),
        );
      } else if (delta.type === "thinking_delta") {
        store.queueReasoningDelta(
          threadId,
          `thinking-${turnId}`,
          text(delta.thinking),
          "content",
        );
      } else if (delta.type === "input_json_delta") {
        const block = blocks.get(threadId)?.get(Number(stream.index ?? 0));
        if (block) block.input += text(delta.partial_json);
      }
      return;
    }
    if (streamType === "content_block_stop") {
      const block = blocks.get(threadId)?.get(Number(stream.index ?? 0));
      if (block) {
        finalizeTool(threadId, block);
        blocks.get(threadId)?.delete(Number(stream.index ?? 0));
        ctx.onTranscriptChanged(threadId);
      }
      return;
    }
    return;
  }

  if (type === "assistant") {
    const assistant = object(message.message);
    const id =
      text(assistant.id) || assistantIds.get(threadId) || `claude-${turnId}`;
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    recordAssistantUsage(threadId, turnId, id, assistant.usage);
    const answer = content
      .map((entry) => object(entry))
      .filter((entry) => entry.type === "text")
      .map((entry) => text(entry.text))
      .join("");
    if (answer)
      store.completeMessage(threadId, { id, role: "assistant", text: answer });
    for (const entry of content
      .map(object)
      .filter((entry) => entry.type === "tool_use")) {
      finalizeTool(threadId, {
        id: text(entry.id) || crypto.randomUUID(),
        name: text(entry.name) || "Tool",
        input: JSON.stringify(object(entry.input)),
      });
    }
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (type === "user") {
    const user = object(message.message);
    const content = Array.isArray(user.content) ? user.content.map(object) : [];
    for (const result of content.filter(
      (entry) => entry.type === "tool_result",
    )) {
      const id = text(result.tool_use_id);
      const existing = store.tasks[threadId]?.activities.find(
        (activity) => activity.id === id,
      );
      if (!existing) continue;
      const resultContent = Array.isArray(result.content)
        ? result.content
            .map(object)
            .map((entry) => text(entry.text))
            .filter(Boolean)
            .join("\n")
        : text(result.content);
      store.upsertActivity(threadId, {
        ...existing,
        detail: resultContent.slice(-4000) || existing.detail,
        status: result.is_error ? "failed" : "completed",
      });
    }
    ctx.onTranscriptChanged(threadId);
    return;
  }

  if (type === "result") {
    store.flushDeltas();
    recordResultUsage(threadId, turnId, message.usage);
    const subtype = text(message.subtype);
    const stopRequested = consumeProviderStopIntent(threadId, turnId);
    const alreadyInterrupted =
      useTaskStore.getState().tasks[threadId]?.status === "interrupted";
    const interrupted =
      stopRequested || alreadyInterrupted || subtype.toLowerCase().includes("interrupt");
    const failed =
      !interrupted &&
      (Boolean(message.is_error) || subtype.toLowerCase().startsWith("error"));
    const thinking = useTaskStore
      .getState()
      .tasks[threadId]?.activities.find(
        (activity) => activity.id === `thinking-${turnId}`,
      );
    if (thinking?.detail)
      store.upsertActivity(threadId, { ...thinking, status: "completed" });
    store.completeTurn(
      threadId,
      turnId,
      interrupted ? "interrupted" : failed ? "error" : "completed",
    );
    if (interrupted) {
      foregroundStatus(ctx, threadId, "Stopped");
    } else if (failed) {
      const error =
        text(message.result) || "Claude could not complete this request.";
      store.setTaskStatus(threadId, "error", error);
      foregroundError(ctx, threadId, error);
      foregroundStatus(ctx, threadId, "Task failed");
    } else {
      foregroundStatus(ctx, threadId, "Ready");
    }
    assistantIds.delete(threadId);
    blocks.delete(threadId);
    ctx.onTurnCompleted(threadId);
    return;
  }

  if (type === "openkiwi_error") {
    const detail = text(message.message);
    store.upsertActivity(threadId, {
      id: `claude-error-${crypto.randomUUID()}`,
      kind: "warning",
      title: "Claude Code reported an issue",
      detail,
    });
    foregroundError(ctx, threadId, detail);
    return;
  }

  if (type === "openkiwi_exit") {
    store.flushDeltas();
    // The result event that would clean this up is never coming.
    partialUsage.delete(`${threadId}\0${turnId}`);
    const interrupted = consumeProviderStopIntent(threadId, turnId)
      || useTaskStore.getState().tasks[threadId]?.status === "interrupted";
    const detail =
      text(message.message) ||
      "Claude Code exited before completing the turn.";
    store.completeTurn(
      threadId,
      turnId,
      interrupted ? "interrupted" : "error",
    );
    if (interrupted) {
      foregroundStatus(ctx, threadId, "Stopped");
    } else {
      store.setTaskStatus(threadId, "error", detail);
      store.upsertActivity(threadId, {
        id: `claude-exit-${crypto.randomUUID()}`,
        kind: "warning",
        title: "Claude Code stopped unexpectedly",
        detail,
        status: "failed",
      });
      foregroundError(ctx, threadId, detail);
      foregroundStatus(ctx, threadId, "Task failed");
    }
    assistantIds.delete(threadId);
    blocks.delete(threadId);
    ctx.onTurnCompleted(threadId);
    return;
  }

  if (type === "system" && message.subtype === "init") {
    store.setActiveTurn(threadId, turnId);
    store.setTaskStatus(threadId, "running");
  }
}

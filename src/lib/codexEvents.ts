import type { CodexEvent, JsonObject } from "./codex";
import type { ThreadItem, Turn } from "../types";
import { useTaskStore } from "./taskStore";
import type { TokenUsageView } from "../components/StudioDock";

/**
 * Events that arrive without a threadId are routed to this bucket instead of
 * whichever thread happens to be active, so a background thread's output can
 * never be misattributed to the thread the user is looking at.
 */
export const RUNTIME_THREAD_ID = "runtime";

const FALLBACK_MODEL_METADATA_WARNING = /^Model metadata for [`'“].+?[`'”] not found\. Defaulting to fallback metadata/i;

export function runtimeMessage(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return value.message.trim();
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "details", "reason"]) {
    const nested = runtimeMessage(object[key]);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Runtime error";
  }
}

export function isFallbackModelMetadataWarning(value: unknown): boolean {
  return FALLBACK_MODEL_METADATA_WARNING.test(runtimeMessage(value));
}

export function isProviderToolCompatibilityError(method: string, message: string): boolean {
  return method === "error" && /INVALID_ARGUMENT/i.test(message) && /(function_declarations|required\[|tool)/i.test(message);
}

function runtimeActivityTitle(method: string, message: string): string {
  if (isProviderToolCompatibilityError(method, message)) {
    return "The selected model rejected an incompatible connected-app tool.";
  }
  return message || (method === "error" ? "Runtime error" : "Runtime warning");
}

export function decodeBase64Utf8(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

// Terminal output arrives as independent base64 chunks that can split a
// multi-byte UTF-8 sequence, so each output stream gets its own persistent
// streaming decoder — a single shared decoder would glue one stream's dangling
// byte prefix onto another stream's next chunk.
const terminalDecoders = new Map<string, TextDecoder>();
const MAX_TERMINAL_DECODERS = 32;

export function decodeTerminalChunk(value: unknown, streamKey = "default"): string {
  if (typeof value !== "string" || !value) return "";
  let decoder = terminalDecoders.get(streamKey);
  if (!decoder) {
    if (terminalDecoders.size >= MAX_TERMINAL_DECODERS) {
      const oldest = terminalDecoders.keys().next().value;
      if (oldest !== undefined) terminalDecoders.delete(oldest);
    }
    decoder = new TextDecoder("utf-8");
    terminalDecoders.set(streamKey, decoder);
  }
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return decoder.decode(bytes, { stream: true });
  } catch {
    return "";
  }
}

/** Command output can reach megabytes; the UI only ever shows the tail. */
const MAX_ACTIVITY_DETAIL = 4000;

function truncatedDetail(detail: string | undefined): string | undefined {
  if (!detail || detail.length <= MAX_ACTIVITY_DETAIL) return detail;
  return detail.slice(-MAX_ACTIVITY_DETAIL);
}

export interface CodexEventContext {
  bindingFor: (threadId: string) => string | undefined;
  respond: (id: number | string, result: JsonObject) => Promise<void>;
  audit: (kind: string, payload: JsonObject, threadId?: string) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  onAuthRequired: () => void;
  onRateSummary: (summary: string) => void;
  onTerminalOutput: (delta: string) => void;
  onTurnCompleted: (threadId: string, turn: Turn | null) => void;
  onApprovalRequested: (threadId: string) => void;
  onAccountUpdated: () => void;
  onLoginFailed: (message: string) => void;
  onProviderToolCompatibilityError: (threadId: string) => void;
}

export function handleThreadItem(threadId: string, item: ThreadItem, ctx: CodexEventContext): void {
  const taskStore = useTaskStore.getState();
  taskStore.ensureTask(threadId, ctx.bindingFor(threadId));
  const id = item.id ?? crypto.randomUUID();
  if (item.type === "agentMessage" || item.type === "plan") {
    taskStore.completeMessage(threadId, { id, role: "assistant", text: item.text ?? "", streaming: false });
    return;
  }
  if (item.type === "commandExecution") {
    taskStore.upsertActivity(threadId, {
      id,
      kind: "command",
      title: item.command ?? "Run command",
      detail: truncatedDetail(item.aggregatedOutput ?? item.cwd),
      status: item.status,
    });
    return;
  }
  if (item.type === "fileChange") {
    taskStore.upsertActivity(threadId, {
      id,
      kind: "file",
      title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`,
      itemCount: item.changes?.length,
      status: item.status,
    });
    return;
  }
  if (item.type === "reasoning") {
    const content = (item.content ?? []).filter((entry): entry is string => typeof entry === "string").join("\n\n").trim();
    const summary = (item.summary ?? []).join("\n\n").trim();
    const existing = taskStore.tasks[threadId]?.activities.find((activity) => activity.id === id);
    const detail = content || existing?.detail || summary;
    if (detail) taskStore.upsertActivity(threadId, { id, kind: "reasoning", title: "Model thinking", detail, status: "completed" });
    return;
  }
  if (item.type === "collabAgentToolCall") {
    const titles: Record<string, string> = {
      spawnAgent: `Spawn sub-agent${item.receiverThreadIds?.length === 1 ? "" : "s"}`,
      sendInput: "Send input to sub-agent",
      resumeAgent: "Resume sub-agent",
      wait: "Wait for sub-agents",
      closeAgent: "Close sub-agent",
    };
    taskStore.upsertActivity(threadId, {
      id,
      kind: "agent",
      title: titles[item.tool ?? ""] ?? "Sub-agent activity",
      detail: item.prompt ?? undefined,
      status: item.status,
    });
    if (item.receiverThreadIds?.length) {
      for (const childThreadId of item.receiverThreadIds) {
        taskStore.upsertAgent(threadId, { id: childThreadId, prompt: item.prompt ?? "Delegated task", status: item.status ?? "inProgress" });
        taskStore.ensureTask(childThreadId, ctx.bindingFor(threadId));
      }
    }
    return;
  }
  if (item.type === "subAgentActivity") {
    const action = item.kind === "started" ? "started" : item.kind === "interrupted" ? "interrupted" : "working";
    taskStore.upsertActivity(threadId, {
      id,
      kind: "agent",
      title: `Sub-agent ${action}`,
      detail: item.agentPath || item.agentThreadId,
      status: item.kind,
    });
    if (item.agentThreadId) {
      taskStore.upsertAgent(threadId, { id: item.agentThreadId, prompt: "Delegated task", status: item.kind ?? "working", path: item.agentPath });
    }
  }
}

export function routeCodexEvent(event: CodexEvent, ctx: CodexEventContext): void {
  if (event.stream === "stderr") {
    const line = event.line?.toLowerCase() ?? "";
    if (line.includes("401 unauthorized")) {
      ctx.onStatus("Sign-in required");
      ctx.onError("Sign in to your ChatGPT account in Settings before using OpenAI models.");
      ctx.onAuthRequired();
    } else if (line.includes("error")) {
      ctx.onStatus("Runtime issue");
    }
    return;
  }

  const method = event.method ?? "";
  const params = event.params ?? {};
  const eventThreadId = typeof params.threadId === "string" ? params.threadId : RUNTIME_THREAD_ID;
  if (event.id !== undefined && method === "currentTime/read") {
    void ctx.respond(event.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (event.id !== undefined && (
    method.includes("requestApproval")
    || method.endsWith("Approval")
    || method === "item/tool/requestUserInput"
    || method === "mcpServer/elicitation/request"
  )) {
    useTaskStore.getState().enqueueApproval({
      id: event.id,
      method,
      params,
      threadId: eventThreadId,
      receivedAt: Date.now(),
    });
    ctx.audit("approval.requested", { method, params }, eventThreadId);
    ctx.onApprovalRequested(eventThreadId);
    return;
  }
  if (method === "item/agentMessage/delta") {
    useTaskStore.getState().queueAssistantDelta(eventThreadId, String(params.itemId), String(params.delta ?? ""));
    return;
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    useTaskStore.getState().queueReasoningDelta(
      eventThreadId,
      String(params.itemId),
      String(params.delta ?? ""),
      method === "item/reasoning/textDelta" ? "content" : "summary",
    );
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    if (params.item && typeof params.item === "object") handleThreadItem(eventThreadId, params.item as ThreadItem, ctx);
    return;
  }
  if (method === "turn/diff/updated") {
    useTaskStore.getState().setDiff(eventThreadId, String(params.diff ?? ""));
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage as { total?: Partial<TokenUsageView>; modelContextWindow?: number | null } | undefined;
    if (usage?.total) {
      useTaskStore.getState().setUsage(eventThreadId, {
        totalTokens: Number(usage.total.totalTokens ?? 0),
        inputTokens: Number(usage.total.inputTokens ?? 0),
        cachedInputTokens: Number(usage.total.cachedInputTokens ?? 0),
        outputTokens: Number(usage.total.outputTokens ?? 0),
        reasoningOutputTokens: Number(usage.total.reasoningOutputTokens ?? 0),
        contextWindow: usage.modelContextWindow,
      });
    }
    return;
  }
  if (method === "command/exec/outputDelta") {
    ctx.onTerminalOutput(decodeTerminalChunk(params.deltaBase64, String(params.processId ?? eventThreadId)));
    return;
  }
  if (method === "account/rateLimits/updated") {
    const limits = params.rateLimits as { primary?: { usedPercent?: number } } | undefined;
    if (limits?.primary) ctx.onRateSummary(`${Math.round(limits.primary.usedPercent ?? 0)}% used`);
    return;
  }
  if (method === "turn/started") {
    const taskStore = useTaskStore.getState();
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as unknown as Turn) : null;
    if (turn?.id) taskStore.setActiveTurn(eventThreadId, turn.id);
    taskStore.setTaskStatus(eventThreadId, "running");
    ctx.audit("turn.started", {}, eventThreadId);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus("Working");
    return;
  }
  if (method === "turn/completed") {
    const taskStore = useTaskStore.getState();
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as unknown as Turn) : null;
    const nextStatus = turn?.status === "interrupted" ? "interrupted" : turn?.status === "failed" ? "error" : "completed";
    taskStore.completeTurn(eventThreadId, turn?.id, nextStatus);
    ctx.audit("turn.completed", {}, eventThreadId);
    ctx.onTurnCompleted(eventThreadId, turn);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus(nextStatus === "interrupted" ? "Stopped" : nextStatus === "error" ? "Task failed" : "Ready");
    return;
  }
  if (method === "thread/status/changed") {
    const statusValue = params.status as { type?: string } | undefined;
    const nextStatus = statusValue?.type === "active" ? "running" : statusValue?.type === "systemError" ? "error" : "idle";
    useTaskStore.getState().setTaskStatus(eventThreadId, nextStatus);
    return;
  }
  if (method === "error" || method === "warning" || method === "guardianWarning" || method === "configWarning") {
    const message = runtimeMessage(params.message ?? params.error);
    if (method !== "error" && isFallbackModelMetadataWarning(message)) {
      ctx.audit("runtime.warning.suppressed", { method, message }, eventThreadId);
      return;
    }
    const details = runtimeMessage(params.details);
    const title = runtimeActivityTitle(method, message);
    if (isProviderToolCompatibilityError(method, message)) ctx.onProviderToolCompatibilityError(eventThreadId);
    useTaskStore.getState().upsertActivity(eventThreadId, {
      id: `${method}-${Date.now()}`,
      kind: "warning",
      title,
      detail: details || (title !== message ? message : undefined),
    });
    return;
  }
  if (method === "account/updated") {
    ctx.onAccountUpdated();
    return;
  }
  if (method === "account/login/completed" && params.success === false) {
    ctx.onLoginFailed(String(params.error ?? "Sign in did not complete"));
    return;
  }
  if (event.id !== undefined) {
    // A server→client request nobody above recognized. Never leave it
    // unanswered — a newer runtime that blocks on the reply (a new consent or
    // elicitation method, for example) would otherwise hang the turn with no
    // diagnostic.
    void ctx.respond(event.id, {});
    ctx.audit("rpc.unhandledRequest", { method }, eventThreadId);
    useTaskStore.getState().upsertActivity(eventThreadId, {
      id: `unhandled-request-${String(event.id)}`,
      kind: "warning",
      title: "Unsupported runtime request",
      detail: `The Codex runtime sent a \`${method}\` request this version of OpenKiwi does not support. It was answered with an empty response; updating OpenKiwi may be required.`,
    });
  }
}

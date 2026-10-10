import { saveQuestionRequest } from "./agentQuestionRecords";
import { agentMessagePhase, timelineFromTurns } from "./threadTimeline";
import { isAuthenticationError } from "./errors";
import type { CodexEvent, JsonObject } from "./codex";
import type { Activity, ChatMessage, ThreadItem, Turn } from "../types";
import { useTaskStore } from "./taskStore";
import { isActiveAgentRecord, workerStatusFromAgentRecord } from "./subAgentActivity";
import { parseCodexRateLimits, type ProviderRateLimits } from "./providerUsage";
import type { TokenUsageView } from "../components/StudioDock";
import { nativeSubAgentPresentation } from "./nativeSubAgentActivity";
import { codexCompactionStatus, compactionActivity, compactionState } from "./contextCompaction";
import { recordOpenRouterCharge, reportThreadServiceTier } from "./usageLedger";
import { boundedNativeText, type NativeAgentReadout } from "./nativeAgentLinks";

/**
 * Events that arrive without a threadId are routed to this bucket instead of
 * whichever thread happens to be active, so a background thread's output can
 * never be misattributed to the thread the user is looking at.
 */
export const RUNTIME_THREAD_ID = "runtime";

// Receipt-only operation evidence. Restored history and completion-only
// snapshots cannot manufacture a wait's ownership of a newer activation.
const nativeOperationActivations = new WeakMap<Activity, { rootTurnId: string; activations: Map<string, string> }>();

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
  if (decoder) {
    // Re-insert to refresh recency, so eviction below always removes the
    // least-recently-used stream and never one that is actively writing.
    terminalDecoders.delete(streamKey);
  } else {
    if (terminalDecoders.size >= MAX_TERMINAL_DECODERS) {
      const oldest = terminalDecoders.keys().next().value;
      if (oldest !== undefined) terminalDecoders.delete(oldest);
    }
    decoder = new TextDecoder("utf-8");
  }
  terminalDecoders.set(streamKey, decoder);
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
  providerFor: (threadId: string) => "openai" | "openrouter" | "lmstudio" | undefined;
  respond: (id: number | string, result: JsonObject) => Promise<void>;
  audit: (kind: string, payload: JsonObject, threadId?: string) => void;
  onStatus: (status: string) => void;
  onError: (message: string) => void;
  /** The runtime confirmed there is no signed-in account. */
  onAuthRequired: () => void;
  /**
   * Something on the runtime's stderr looked like an auth rejection. That
   * stream is shared with MCP servers, OpenRouter, and LM Studio, so this
   * asks the app to verify the ChatGPT session rather than drop it.
   */
  onAuthSuspected: () => void;
  onRateLimits: (limits: ProviderRateLimits | null) => void;
  onTerminalOutput: (delta: string, processId?: string) => void;
  onTurnCompleted: (threadId: string, turn: Turn | null) => void;
  onApprovalRequested: (threadId: string) => void;
  onAccountUpdated: () => void;
  onLoginFailed: (message: string) => void;
  onProviderToolCompatibilityError: (threadId: string) => void;
  onNativeAgentDiscovered: (rootThreadId: string, childThreadId: string, details: NativeAgentReadout & { prompt?: string; path?: string; model?: string; status?: string; provider?: "openai"; runtime?: "codex"; rootTurnId?: string; compactionInheritedFromParent?: boolean }) => boolean | void;
}

/** Update only already accepted ownership; child output never becomes root text. */
function nativeChildEvidence(childId: string, details: NativeAgentReadout & { model?: string }, ctx: CodexEventContext, sourceTurnId?: string): void {
  const store = useTaskStore.getState();
  const childTask = store.tasks[childId];
  if ((childTask?.pendingNativeActivationId && details.modelSource !== "configured")
    || (sourceTurnId && childTask?.retiredNativeTurnIds?.includes(sourceTurnId))) return;
  if (sourceTurnId && store.tasks[childId]?.activeTurnId && store.tasks[childId].activeTurnId !== sourceTurnId) return;
  // Reactivated children have no concrete new turn yet. An old completed
  // message must not refill the newly cleared result during that gap.
  if (sourceTurnId && ["starting", "running"].includes(store.tasks[childId]?.status ?? "") && !store.tasks[childId].activeTurnId) return;
  for (const [parentId, task] of Object.entries(store.tasks)) {
    const agent = task.agents.find((entry) => entry.id === childId && entry.runtime === "codex");
    if (!agent) continue;
    if (ctx.onNativeAgentDiscovered(parentId, childId, { ...details, status: agent.status, provider: "openai", runtime: "codex" }) === false) continue;
    store.upsertAgent(parentId, { ...agent, ...details });
  }
}

function nativeChildStatus(parentId: string, childId: string, incoming: string): string {
  const state = useTaskStore.getState();
  const child = state.statuses[childId];
  if (child === "starting" || child === "running") return child === "starting" ? "starting" : "inProgress";
  if (child === "completed") return "completed";
  if (child === "error") return "failed";
  if (child === "interrupted") return "interrupted";
  const existing = state.tasks[parentId]?.agents.find((agent) => agent.id === childId);
  if (existing && ["cancelled", "interrupted"].includes(existing.status)) return existing.status;
  if (existing && ["completed", "failed", "error"].includes(existing.status) && isActiveAgentRecord(incoming)) return existing.status;
  return incoming;
}

/** A native worker can be resumed from its own app conversation. */
function nativeChildTurnStarted(childId: string, turnId: string, ctx: CodexEventContext): void {
  const store = useTaskStore.getState();
  for (const [parentId, task] of Object.entries(store.tasks)) {
    const agent = task.agents.find((entry) => entry.id === childId && entry.runtime === "codex");
    if (!agent) continue;
    const freshActivation = !isActiveAgentRecord(agent.status);
    const readout = freshActivation ? {
      prompt: "Task not reported", task: "", requestedModel: "", model: "", modelSource: undefined,
      progress: "", result: "", activationId: `turn:${turnId}`, activatedAt: Date.now(), lifecycleTurnId: undefined,
    } : {};
    if (ctx.onNativeAgentDiscovered(parentId, childId, { ...readout, status: "inProgress", provider: "openai", runtime: "codex" }) === false) continue;
    store.upsertAgent(parentId, { ...agent, ...readout, status: "inProgress" });
  }
}

export function handleThreadItem(
  threadId: string,
  item: ThreadItem,
  ctx: CodexEventContext,
  lifecycle: "started" | "completed" = "started",
  turnId?: string,
): void {
  const taskStore = useTaskStore.getState();
  taskStore.ensureTask(threadId, ctx.bindingFor(threadId));
  if (item.type === "contextCompaction") {
    // OpenRouter and LM Studio share the app-server transport, but this
    // product surface is intentionally limited to provider-owned Codex
    // compaction. Never infer the provider from the item itself.
    if (ctx.providerFor(threadId) !== "openai") return;
    // Commit already-received text before assigning the seam's order. Deltas
    // normally wait for the next animation frame, which may follow this event.
    taskStore.flushDeltas();
    const task = useTaskStore.getState().tasks[threadId];
    // The started and completed halves must land on one row. A runtime that
    // omits the item id would otherwise deal a second marker on completion,
    // so fall back to the turn this compaction belongs to.
    const compactionId = item.id
      ?? `context-compaction-${turnId ?? task?.activeTurnId ?? "pending"}`;
    const existing = task?.activities.find((entry) => entry.id === compactionId);
    // Replayed starts must not reactivate a settled marker.
    if (lifecycle === "started" && existing && compactionState(existing.status) !== "active") return;
    taskStore.upsertActivity(threadId, {
      ...compactionActivity({
        id: compactionId,
        provider: "openai",
        status: codexCompactionStatus(item.status, lifecycle),
      }),
      turnId: turnId ?? existing?.turnId ?? task?.activeTurnId,
    });
    return;
  }
  const id = item.id ?? crypto.randomUUID();
  if (item.type === "userMessage") {
    const message = timelineFromTurns([{ id: turnId ?? taskStore.tasks[threadId]?.activeTurnId ?? "", items: [{ ...item, id }] }]).messages[0];
    if (message) taskStore.completeMessage(threadId, message);
    return;
  }
  if (item.type === "agentMessage" || item.type === "plan") {
    const phase = agentMessagePhase(item);
    const message: ChatMessage = { id, role: "assistant", text: item.text ?? "", questions: item.questions ?? undefined,
      ...(phase ? { phase } : {}), turnId };
    if (lifecycle === "started") taskStore.startAssistantMessage(threadId, message);
    else taskStore.completeMessage(threadId, message);
    if (lifecycle === "completed" && item.text?.trim()) nativeChildEvidence(threadId, {
      progress: boundedNativeText(item.text, "progress"),
      ...(phase === "final" ? { result: boundedNativeText(item.text, "result") } : {}),
    }, ctx, turnId);
    return;
  }
  if (item.type === "commandExecution") {
    taskStore.upsertActivity(threadId, {
      id,
      turnId,
      kind: "command",
      title: item.command ?? "Run command",
      detail: truncatedDetail(item.aggregatedOutput ?? item.cwd),
      status: item.status,
    });
    if (item.command) nativeChildEvidence(threadId, { progress: boundedNativeText(`${item.command}${lifecycle === "completed" && item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ""}`, "progress") }, ctx, turnId);
    return;
  }
  if (item.type === "fileChange") {
    taskStore.upsertActivity(threadId, {
      id,
      turnId,
      kind: "file",
      workType: "files",
      title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`,
      itemCount: item.changes?.length,
      status: item.status,
    });
    return;
  }
  if (item.type === "webSearch") {
    taskStore.upsertActivity(threadId, {
      id, turnId, kind: "command", workType: "research", title: "Web Search", detail: item.query,
      status: item.status ?? (lifecycle === "started" ? "inProgress" : "completed"),
    });
    return;
  }
  if (item.type === "reasoning") {
    const content = (item.content ?? []).filter((entry): entry is string => typeof entry === "string").join("\n\n").trim();
    const summary = (item.summary ?? []).join("\n\n").trim();
    const existing = taskStore.tasks[threadId]?.activities.find((activity) => activity.id === id);
    const detail = content || existing?.detail || summary;
    if (lifecycle === "started" && ["completed", "failed", "interrupted", "cancelled"].includes(existing?.status ?? "")) return;
    if (detail) taskStore.upsertActivity(threadId, { id, turnId, kind: "reasoning", title: "Model thinking", detail,
      status: lifecycle === "started" ? "inProgress" : "completed" });
    if (lifecycle === "started" && !existing) {
      // Seed the correct stream so subsequent deltas extend initial content
      // rather than replacing it. Replayed starts must not append twice.
      if (summary) taskStore.queueReasoningDelta(threadId, id, summary, "summary", turnId);
      if (content) taskStore.queueReasoningDelta(threadId, id, content, "content", turnId);
      taskStore.flushDeltas();
    }
    return;
  }
  if (item.type === "collabAgentToolCall") {
    const childIds = [...new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])].filter((childId) => childId && childId !== threadId);
    const previousItem = taskStore.tasks[threadId]?.activities.find((activity) => activity.id === id);
    const previousOperation = previousItem ? nativeOperationActivations.get(previousItem) : undefined;
    const activeRoot = Boolean(turnId && taskStore.tasks[threadId]?.activeTurnId === turnId)
      && ["starting", "running"].includes(taskStore.statuses[threadId] ?? "");
    const operation = lifecycle === "started" && (item.tool === "wait" || item.tool === "listAgents") && activeRoot
      ? previousOperation?.rootTurnId === turnId ? previousOperation
        : !previousItem ? { rootTurnId: turnId!, activations: new Map((taskStore.tasks[threadId]?.agents ?? [])
          .filter((agent) => agent.runtime === "codex" && agent.activationId)
          .map((agent) => [agent.id, agent.activationId!])) } : undefined
      : previousOperation;
    const currentActivation = Boolean(turnId && taskStore.tasks[threadId]?.activeTurnId === turnId)
      && (item.tool === "sendInput" || item.tool === "resumeAgent" || item.tool === "followupTask");
    const titles: Record<string, string> = {
      spawnAgent: `Spawn sub-agent${item.receiverThreadIds?.length === 1 ? "" : "s"}`,
      sendInput: "Send input to sub-agent",
      resumeAgent: "Resume sub-agent",
      wait: "Wait for sub-agents",
      closeAgent: "Close sub-agent",
      sendMessage: "Message sub-agent",
      followupTask: "Continue sub-agent task",
      interruptAgent: "Stop sub-agent",
      listAgents: "List sub-agents",
    };
    const actions = {
      spawnAgent: "spawn",
      sendInput: "sendInput",
      resumeAgent: "resume",
      wait: "wait",
      closeAgent: "close",
      sendMessage: "sendInput",
      followupTask: "resume",
      interruptAgent: "close",
      listAgents: "status",
    } as const;
    const acceptedIds: string[] = [];
    const settledChildren: string[] = [];
    if (childIds.length) {
      for (const childThreadId of childIds) {
        // A runtime that names the thread itself as its own receiver would
        // otherwise add the root to its own worker list, where it holds a
        // concurrency slot and shows up in Live agents as a third agent.
        if (!childThreadId || childThreadId === threadId) continue;
        const reported = item.agentsStates?.[childThreadId];
        const reportedStatus = typeof reported === "string" ? reported : reported?.status;
        const previousAgent = useTaskStore.getState().tasks[threadId]?.agents.find((agent) => agent.id === childThreadId);
        const reactivating = currentActivation && !previousItem?.agent?.threadIds?.includes(childThreadId)
          && (!reportedStatus || isActiveAgentRecord(reportedStatus));
        const childTask = useTaskStore.getState().tasks[childThreadId];
        const childAlreadyActive = childTask?.status === "running" || childTask?.status === "starting";
        // The collaboration tool finishing is not child completion evidence.
        const incoming = reportedStatus || ((item.tool === "closeAgent" || item.tool === "interruptAgent") && lifecycle === "completed" && item.status === "completed" ? "interrupted" : item.tool === "spawnAgent" ? "starting" : "unknown");
        const reportedTerminal = reportedStatus && ["completed", "cancelled", "failed"].includes(workerStatusFromAgentRecord(reportedStatus));
        const correlatedTerminal = lifecycle === "completed" && (item.tool === "wait" || item.tool === "listAgents") && activeRoot
          && operation?.rootTurnId === turnId && reportedTerminal && previousAgent?.activationId
          && operation?.activations.get(childThreadId) === previousAgent.activationId
          && childTask?.pendingNativeActivationId === previousAgent.activationId && !childTask.activeTurnId;
        const status = correlatedTerminal ? reportedStatus! : reactivating ? (reportedStatus || childAlreadyActive ? "inProgress" : "starting") : nativeChildStatus(threadId, childThreadId, incoming);
        const activationItem = previousAgent?.activationId ? taskStore.tasks[threadId]?.activities.find((activity) => activity.id === previousAgent.activationId) : undefined;
        const staleSnapshot = !reactivating && ((turnId && taskStore.tasks[threadId]?.activeTurnId && turnId !== taskStore.tasks[threadId].activeTurnId)
          || (previousItem && activationItem && (previousItem.timelineOrder ?? Infinity) < (activationItem.timelineOrder ?? 0)));
        const statusMatches = !reportedStatus || workerStatusFromAgentRecord(status) === workerStatusFromAgentRecord(reportedStatus);
        const enrichLifecycle = item.tool === "spawnAgent" && Boolean(turnId && taskStore.tasks[threadId]?.activeTurnId === turnId)
          && previousAgent?.lifecycleTurnId === turnId && !previousAgent?.task && !staleSnapshot;
        const ownsAssignment = !previousAgent || reactivating || previousAgent.activationId === id || enrichLifecycle;
        const acceptEvidence = !staleSnapshot && statusMatches && (item.tool !== "spawnAgent" || ownsAssignment);
        const assignedTask = ownsAssignment && !staleSnapshot ? boundedNativeText(item.prompt, "task") : undefined;
        const model = acceptEvidence && typeof reported === "object" ? reported.model : undefined;
        const observedModel = reactivating ? model || "" : model;
        const prompt = reactivating ? assignedTask || "Task not reported" : assignedTask || previousAgent?.prompt || "Delegated task";
        const reportMessage = acceptEvidence && typeof reported === "object" ? reported.message : undefined;
        const readout: NativeAgentReadout = {
          ...(enrichLifecycle ? { activationId: id, lifecycleTurnId: undefined } : {}),
          task: reactivating ? assignedTask || "" : previousAgent?.task || assignedTask,
          requestedModel: reactivating ? item.model?.trim() || "" : (ownsAssignment && !staleSnapshot ? item.model?.trim() : undefined) || previousAgent?.requestedModel,
          ...(reactivating ? { activationId: id, activatedAt: Date.now(), progress: "", result: "", modelSource: undefined } : {}),
          ...(reportMessage ? { progress: boundedNativeText(reportMessage, "progress"), ...(!isActiveAgentRecord(reportedStatus ?? "unknown") ? { result: boundedNativeText(reportMessage, "result") } : {}) } : {}),
        };
        if (ctx.onNativeAgentDiscovered(threadId, childThreadId, { ...readout, prompt: reactivating ? prompt : assignedTask, status, model: observedModel, provider: "openai", runtime: "codex", ...(acceptEvidence && turnId ? { rootTurnId: turnId, ...(item.tool === "spawnAgent" ? { compactionInheritedFromParent: true } : {}) } : {}) }) === false) continue;
        acceptedIds.push(childThreadId);
        if (correlatedTerminal) {
          const terminal = workerStatusFromAgentRecord(status);
          taskStore.completeTurn(childThreadId, undefined, terminal === "failed" ? "error" : terminal === "cancelled" ? "interrupted" : "completed");
          settledChildren.push(childThreadId);
        }
        if (reactivating && (!childAlreadyActive || childTask?.pendingNativeActivationId)) {
          // A real new activation may reuse a completed child. Its old local
          // turn is no longer cutoff/completion evidence for this operation.
          taskStore.beginNativeActivation(childThreadId, id);
          taskStore.setTaskStatus(childThreadId, reportedStatus ? "running" : "starting");
        }
        taskStore.upsertAgent(threadId, { ...readout, id: childThreadId, prompt, status, provider: "openai", runtime: "codex", ...(observedModel !== undefined ? { model: observedModel } : {}),
          ...((reactivating || !previousAgent) ? { activationId: id } : {}) });
        taskStore.ensureTask(childThreadId, ctx.bindingFor(threadId));
      }
    }
    if (childIds.length && !acceptedIds.length) return;
    taskStore.upsertActivity(threadId, {
      id, turnId, kind: "agent", title: titles[item.tool ?? ""] ?? "Sub-agent activity", detail: item.prompt ?? undefined, status: item.status,
      agent: { action: item.tool ? actions[item.tool] : "status", provider: "openai", task: boundedNativeText(item.prompt, "task"), requestedModel: item.model || undefined, count: acceptedIds.length, threadIds: acceptedIds },
    });
    if (lifecycle === "started" && operation) {
      const activity = useTaskStore.getState().tasks[threadId]?.activities.find((entry) => entry.id === id);
      if (activity) nativeOperationActivations.set(activity, operation);
    }
    for (const childId of settledChildren) ctx.onTurnCompleted(childId, null);
    return;
  }
  if (item.type === "subAgentActivity") {
    const liveStart = item.kind === "started" && Boolean(turnId && taskStore.tasks[threadId]?.activeTurnId === turnId)
      && ["starting", "running"].includes(taskStore.statuses[threadId] ?? "");
    if (item.agentThreadId && item.agentThreadId !== threadId) {
      const status = nativeChildStatus(threadId, item.agentThreadId, item.kind ?? "unknown");
      if (ctx.onNativeAgentDiscovered(threadId, item.agentThreadId, { path: item.agentPath, status, model: item.agentModel, provider: "openai", runtime: "codex", ...(liveStart ? { rootTurnId: turnId, compactionInheritedFromParent: true } : {}) }) === false) return;
    }
    taskStore.upsertActivity(threadId, {
      id,
      turnId,
      ...nativeSubAgentPresentation(item),
    });
    if (item.agentThreadId && item.agentThreadId !== threadId) {
      const status = nativeChildStatus(threadId, item.agentThreadId, item.kind ?? "unknown");
      const previousAgent = useTaskStore.getState().tasks[threadId]?.agents.find((agent) => agent.id === item.agentThreadId);
      taskStore.upsertAgent(threadId, { id: item.agentThreadId, prompt: previousAgent?.prompt || "Delegated task", status, path: item.agentPath, provider: "openai", runtime: "codex", ...(item.agentModel ? { model: item.agentModel } : {}),
        ...(!previousAgent ? { activationId: id, ...(liveStart ? { lifecycleTurnId: turnId } : {}) } : {}) });
      taskStore.ensureTask(item.agentThreadId, ctx.bindingFor(threadId));
    }
  }
}

export function routeCodexEvent(event: CodexEvent, ctx: CodexEventContext): void {
  if (event.stream === "stderr") {
    const line = event.line?.toLowerCase() ?? "";
    if (isAuthenticationError(line)) {
      ctx.onAuthSuspected();
    } else if (line.includes("error")) {
      ctx.onStatus("Runtime issue");
    }
    return;
  }

  const method = event.method ?? "";
  const params = event.params ?? {};
  if (method === "mythra/openrouterCharge") {
    recordOpenRouterCharge(params.id, params.cost);
    return;
  }
  const eventThreadId = typeof params.threadId === "string" ? params.threadId : RUNTIME_THREAD_ID;
  if (method === "thread/started" || method === "thread/settings/updated") {
    const metadata = (method === "thread/started" ? params.thread : params.threadSettings) as { id?: string; model?: string | null } | undefined;
    const childId = method === "thread/started" ? metadata?.id : eventThreadId;
    if (childId && metadata?.model) nativeChildEvidence(childId, { model: metadata.model, modelSource: "configured" }, ctx);
    return;
  }
  if (method === "serverRequest/resolved") {
    if (typeof params.requestId === "string" || typeof params.requestId === "number") useTaskStore.getState().resolveApproval(eventThreadId, params.requestId);
    return;
  }
  if (event.id !== undefined && method === "currentTime/read") {
    void ctx.respond(event.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
      .catch((reason) => ctx.audit("rpc.respondFailed", { method, error: String(reason) }, eventThreadId));
    return;
  }
  if (event.id !== undefined && (
    method.includes("requestApproval")
    || method.endsWith("Approval")
    || method === "item/tool/requestUserInput"
    || method === "mcpServer/elicitation/request"
  )) {
    if (method === "item/tool/requestUserInput" && params.isBlocking === false && Array.isArray(params.questions)) {
      const questions = (params.questions as Array<{ id: string; question: string; isSecret?: boolean; options?: Array<{ label: string }> }>).map((question) => ({ id: question.id, title: question.question, secret: question.isSecret, options: question.options?.map((option) => option.label) }));
      const questionMessage: ChatMessage = {
        id: `question-request-${JSON.stringify([params.turnId, params.itemId, event.id])}`, role: "assistant", text: "", questions, questionRequestId: event.id,
        questionRequestItemId: typeof params.itemId === "string" ? params.itemId : undefined,
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      };
      saveQuestionRequest(eventThreadId, questionMessage);
      useTaskStore.getState().completeMessage(eventThreadId, questionMessage);
    }
    useTaskStore.getState().enqueueApproval({
      id: event.id,
      method,
      params,
      threadId: eventThreadId,
      receivedAt: Date.now(),
    });
    ctx.audit("approval.requested", { method, params }, eventThreadId);
    if (!(method === "item/tool/requestUserInput" && params.isBlocking === false)) ctx.onApprovalRequested(eventThreadId);
    return;
  }
  if (method === "item/agentMessage/delta") {
    useTaskStore.getState().queueAssistantDelta(eventThreadId, String(params.itemId), String(params.delta ?? ""), typeof params.turnId === "string" ? params.turnId : undefined);
    return;
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    useTaskStore.getState().queueReasoningDelta(
      eventThreadId,
      String(params.itemId),
      String(params.delta ?? ""),
      method === "item/reasoning/textDelta" ? "content" : "summary",
      typeof params.turnId === "string" ? params.turnId : undefined,
    );
    return;
  }
  if (method === "item/started" || method === "item/completed") {
    if (params.item && typeof params.item === "object") {
      handleThreadItem(eventThreadId, params.item as ThreadItem, ctx, method === "item/completed" ? "completed" : "started", typeof params.turnId === "string" ? params.turnId : undefined);
    }
    return;
  }
  if (method === "turn/diff/updated") {
    // The runtime's live turn diff, against whatever remote the thread tracks.
    useTaskStore.getState().setDiff(eventThreadId, {
      text: String(params.diff ?? ""),
      source: "runtime",
      baseline: "the tracked remote branch",
      untrackedPaths: [],
    });
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = params.tokenUsage as {
      total?: Partial<TokenUsageView>;
      last?: Partial<TokenUsageView>;
      modelContextWindow?: number | null;
    } | undefined;
    if (usage?.total) {
      useTaskStore.getState().setUsage(eventThreadId, {
        totalTokens: Number(usage.total.totalTokens ?? 0),
        // `total` is cumulative billing usage and repeatedly counts the same
        // conversation prefix. `last` is the latest model request and is the
        // runtime's current-context signal.
        contextTokens: usage.last ? Number(usage.last.totalTokens ?? 0) : undefined,
        inputTokens: Number(usage.total.inputTokens ?? 0),
        cachedInputTokens: Number(usage.total.cachedInputTokens ?? 0),
        cacheWriteInputTokens: Number(usage.total.cacheWriteInputTokens ?? 0),
        cacheReadReported: Number.isSafeInteger(usage.total.cachedInputTokens) && Number(usage.total.cachedInputTokens) >= 0,
        cacheWriteReported: Number.isSafeInteger(usage.total.cacheWriteInputTokens) && Number(usage.total.cacheWriteInputTokens) >= 0,
        serviceTier: typeof usage.total.serviceTier === "string" ? usage.total.serviceTier : undefined,
        serviceTierSource: typeof usage.total.serviceTier === "string" ? "reported" : "unknown",
        tokenAvailability: Number.isSafeInteger(usage.total.inputTokens) && Number.isSafeInteger(usage.total.outputTokens)
          && Number(usage.total.inputTokens) >= 0 && Number(usage.total.outputTokens) >= 0 ? "reported" : "partial",
        outputTokens: Number(usage.total.outputTokens ?? 0),
        reasoningOutputTokens: Number(usage.total.reasoningOutputTokens ?? 0),
        contextWindow: usage.modelContextWindow,
      }, typeof params.turnId === "string" && params.turnId ? params.turnId : undefined);
    }
    return;
  }
  if (method === "command/exec/outputDelta") {
    const processId = typeof params.processId === "string" ? params.processId : undefined;
    ctx.onTerminalOutput(
      decodeTerminalChunk(params.deltaBase64, processId ?? eventThreadId),
      processId,
    );
    return;
  }
  if (method === "account/rateLimits/updated") {
    // Same payload as `account/rateLimits/read`, so the push path and the poll
    // path normalize through one parser and render identically. A valid update
    // with no windows must also clear the previous quota instead of leaving a
    // stale percentage on screen.
    ctx.onRateLimits(parseCodexRateLimits(params));
    return;
  }
  if (method === "turn/started") {
    const taskStore = useTaskStore.getState();
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as unknown as Turn) : null;
    const childTask = taskStore.tasks[eventThreadId];
    const nativeChild = Object.values(taskStore.tasks).some((task) => task.agents.some((agent) => agent.id === eventThreadId && agent.runtime === "codex"));
    if (turn?.id && nativeChild && (childTask?.lastCompletedTurnId === turn.id
      || childTask?.messages.some((message) => message.turnId === turn.id && message.turnStatus && message.turnStatus !== "inProgress")
      || childTask?.activities.some((activity) => activity.turnId === turn.id && activity.turnStatus && activity.turnStatus !== "inProgress"))) return;
    reportThreadServiceTier(eventThreadId, (params.turn as { serviceTier?: unknown } | undefined)?.serviceTier);
    if (turn?.id && !taskStore.setActiveTurn(eventThreadId, turn.id)) return;
    taskStore.setTaskStatus(eventThreadId, "running");
    if (turn?.id) nativeChildTurnStarted(eventThreadId, turn.id, ctx);
    ctx.audit("turn.started", {}, eventThreadId);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus("Working");
    return;
  }
  if (method === "turn/completed") {
    const taskStore = useTaskStore.getState();
    const turn = params.turn && typeof params.turn === "object" ? (params.turn as unknown as Turn) : null;
    // An ID-less provider notification is not the explicit process cutoff
    // used by Stop; it cannot settle an activation still awaiting its turn.
    if (taskStore.tasks[eventThreadId]?.pendingNativeActivationId && !turn?.id?.trim()) return;
    reportThreadServiceTier(eventThreadId, (params.turn as { serviceTier?: unknown } | undefined)?.serviceTier);
    const nextStatus = turn?.status === "interrupted" ? "interrupted" : turn?.status === "failed" ? "error" : "completed";
    if (!taskStore.completeTurn(eventThreadId, turn?.id, nextStatus)) return;
    ctx.audit("turn.completed", {}, eventThreadId);
    ctx.onTurnCompleted(eventThreadId, turn);
    if (useTaskStore.getState().activeThreadId === eventThreadId) ctx.onStatus(nextStatus === "interrupted" ? "Stopped" : nextStatus === "error" ? "Task failed" : "Ready");
    return;
  }
  if (method === "thread/status/changed") {
    const statusValue = params.status as { type?: string } | undefined;
    const nextStatus = statusValue?.type === "active"
      ? "running"
      : statusValue?.type === "systemError"
        ? "error"
        : statusValue?.type === "idle"
          ? "idle"
          : undefined;
    // A status type this version does not recognize (from a newer runtime)
    // must not flip a running thread back to idle.
    if (nextStatus) {
      const store = useTaskStore.getState();
      const task = store.tasks[eventThreadId];
      if (nextStatus === "idle" && task?.pendingNativeActivationId) return;
      if (nextStatus === "error" && (task?.activeTurnId || task?.status === "running" || task?.status === "starting")) {
        // A system error can be terminal without a turn/completed event.
        // Drain queued deltas and seal the active turn before reporting error.
        store.completeTurn(eventThreadId, task?.activeTurnId, "error");
      } else {
        store.setTaskStatus(eventThreadId, nextStatus);
      }
    }
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
    if (params.authMode === null) ctx.onAuthRequired();
    else ctx.onAccountUpdated();
    return;
  }
  if (method === "account/login/completed") {
    // A successful browser sign-in is confirmed here. Runtimes also announce
    // `account/updated`, but the app must not depend on that second
    // notification to leave "Waiting for sign-in" and load the account.
    if (params.success === false) ctx.onLoginFailed(String(params.error ?? "Sign in did not complete"));
    else ctx.onAccountUpdated();
    return;
  }
  if (event.id !== undefined) {
    // A server→client request nobody above recognized. Never leave it
    // unanswered — a newer runtime that blocks on the reply (a new consent or
    // elicitation method, for example) would otherwise hang the turn with no
    // diagnostic.
    void ctx.respond(event.id, {})
      .catch((reason) => ctx.audit("rpc.respondFailed", { method, error: String(reason) }, eventThreadId));
    ctx.audit("rpc.unhandledRequest", { method }, eventThreadId);
    useTaskStore.getState().upsertActivity(eventThreadId, {
      id: `unhandled-request-${String(event.id)}`,
      kind: "warning",
      title: "Unsupported runtime request",
      detail: `The Codex runtime sent a \`${method}\` request this version of Mythra Code does not support. It was answered with an empty response; updating Mythra Code may be required.`,
    });
  }
}

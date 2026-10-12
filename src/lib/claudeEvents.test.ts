import { beforeEach, describe, expect, it, vi } from "vitest";
import * as tauri from "@tauri-apps/api/core";
import { resetClaudeEventUsageState, routeClaudeEvent, type ClaudeEventContext } from "./claudeEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { markProviderStopIntent } from "./providerStopIntent";
import { usageTotals } from "./usageLedger";
import { useClaudeContinuationStore } from "./claudeContinuation";
import { compactActivityPresentation } from "./compactActivity";
import { usedSkillsForRun } from "./skillUsage";
import { collectSubAgentWorkers, isActiveAgentRecord, isSubAgentWorkerActive } from "./subAgentActivity";
import type { NativeAgentLink } from "./nativeAgentLinks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const context: ClaudeEventContext = {
  bindingFor: () => "/tmp/project",
  onStatus: vi.fn(),
  onError: vi.fn(),
  onTurnCompleted: vi.fn(),
  onApprovalRequested: vi.fn(),
  onTranscriptChanged: vi.fn(),
  onUnsupportedControlRequest: vi.fn(),
  onNativeAgentDiscovered: vi.fn(),
  onNativeAgentReidentified: vi.fn(),
};

function send(message: Record<string, unknown>, turnId = "turn-1") {
  routeClaudeEvent(
    { threadId: "thread-1", turnId, message },
    context,
  );
}

describe("Claude event routing", () => {
  beforeEach(() => {
    resetClaudeEventUsageState();
    resetTaskStore();
    useClaudeContinuationStore.setState({ byThread: {} });
    vi.clearAllMocks();
  });

  it("isolates child partial streams without losing the root message or pending tool input", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "outer-agent", name: "Agent", input: { prompt: "Child assignment" } }] } });
    send({ type: "stream_event", event: { type: "message_start", message: { id: "root-stream" } } });
    send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "root-command", name: "Bash" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo root"}' } } });
    const childStream = (event: Record<string, unknown>) => send({ type: "stream_event", parent_tool_use_id: "outer-agent", event });
    childStream({ type: "message_start", message: { id: "child-stream", model: "child-model" } });
    childStream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Private child text" } });
    childStream({ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "Private child thinking" } });
    childStream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "nested-agent", name: "Agent" } });
    childStream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"prompt":"Nested child"}' } });
    childStream({ type: "content_block_stop", index: 0 });
    send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Root reply" } } });
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages).toEqual([expect.objectContaining({ id: "root-stream", text: "Root reply" })]);
    expect(task.activities).toEqual([
      expect.objectContaining({ id: "outer-agent", kind: "agent" }),
      expect.objectContaining({ id: "root-command", kind: "command", title: "echo root" }),
    ]);
    expect(task.agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:outer-agent", model: undefined })]);
  });

  it.each([
    { type: "result", subtype: "success", result: "Child final output" },
    { type: "openkiwi_exit", message: "Child process ended" },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } },
    { type: "system", subtype: "task_started", task_id: "nested-task", task_type: "local_agent" },
  ])("does not attribute parent-linked $type lifecycle or telemetry to the root", (message) => {
    send({ type: "system", subtype: "init" });
    send({ ...message, parent_tool_use_id: "outer-agent" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("running");
    expect(task.messages).toEqual([]);
    expect(task.activities).toEqual([]);
    expect(task.agents).toEqual([]);
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown", "completed", "failed", "stopped"].flatMap((status) => [false, true].flatMap((canonicalAlias) => (["execution", "configured", undefined] as const).map((modelSource) => ({ status, canonicalAlias, modelSource })))))("retires only active prior durable Claude activations with %j", ({ status, canonicalAlias, modelSource }) => {
    const rawId = "claude-native:thread-1:prior-tool";
    const priorId = canonicalAlias ? "claude-native:thread-1:task:old-turn:prior-task:001" : rawId;
    const oldResult = isActiveAgentRecord(status) ? undefined : "Original outcome";
    const prior: NativeAgentLink = { childThreadId: priorId, rootThreadId: "thread-1", rootTurnId: "old-turn", runtime: "claude", title: "Original assignment", createdAt: 1, status, model: "original-model", modelSource, progress: "Original progress", result: oldResult };
    const links: Record<string, NativeAgentLink> = { [priorId]: prior };
    const resumedContext: ClaudeEventContext = { ...context, nativeAgentLinkFor: (id) => links[id], onNativeAgentDiscovered: (_root, id, details) => {
      links[id] = { ...links[id], ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)), childThreadId: id, rootThreadId: "thread-1", title: links[id]?.title ?? details.prompt ?? "Delegated task", createdAt: links[id]?.createdAt ?? 2 };
    } };
    useTaskStore.getState().ensureTask("thread-1");
    if (canonicalAlias) useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activities: [{ id: "prior-tool", kind: "agent", title: "Old Agent", agent: { provider: "claude", action: "spawn", threadIds: [priorId] } }] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "init" } }, resumedContext);
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "prior-task", run_id: "002", tool_use_id: "prior-tool" } }, resumedContext);
    const workers = collectSubAgentWorkers({ rootThreadId: "thread-1", links: {}, statuses: {}, agents: useTaskStore.getState().tasks["thread-1"].agents, nativeLinks: links });
    expect(workers.filter((worker) => isSubAgentWorkerActive(worker.status))).toHaveLength(1);
    expect(links[priorId]).toMatchObject({ ...prior, status: isActiveAgentRecord(status) ? "idle" : status });
    if (isActiveAgentRecord(status)) expect(useTaskStore.getState().tasks["thread-1"].agents.find((agent) => agent.id === priorId)).toMatchObject({ rootTurnId: "old-turn", createdAt: 1, model: "original-model", modelSource, status: "idle" });
    expect(links["claude-native:thread-1:task:turn-2:prior-task:002"]).toMatchObject({ rootTurnId: "turn-2", status: "inProgress" });
  });

  it.each(["running", "unknown"].flatMap((status) => (["execution", "configured", undefined] as const).map((modelSource) => ({ status, modelSource }))))("preserves mixed legacy turn provenance during neutral retirement with %j", ({ status, modelSource }) => {
    const id = "claude-native:thread-1:mixed-tool";
    const old: NativeAgentLink = { childThreadId: id, rootThreadId: "thread-1", runtime: "claude", title: "Original assignment", status, model: "original-model", modelSource, progress: "Original progress", createdAt: 1 };
    const links: Record<string, NativeAgentLink> = { [id]: old };
    const resumedContext: ClaudeEventContext = { ...context, nativeAgentLinkFor: (childId) => links[childId], onNativeAgentDiscovered: (_root, childId, details) => {
      links[childId] = { ...links[childId], ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)), childThreadId: childId, rootThreadId: "thread-1", title: links[childId]?.title ?? "Delegated task", createdAt: links[childId]?.createdAt ?? 2 };
    } };
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.getState().upsertAgent("thread-1", { id, prompt: "Original assignment", rootTurnId: "old-turn", runtime: "claude", status, model: old.model, modelSource, progress: old.progress, createdAt: 1 });
    useTaskStore.getState().upsertActivity("thread-1", { id: "mixed-tool", kind: "agent", title: "Original assignment", turnId: "old-turn", status, agent: { action: "spawn", provider: "claude", threadIds: [id] } });
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "init" } }, resumedContext);
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "mixed-task", run_id: "002", tool_use_id: "mixed-tool" } }, resumedContext);
    const agents = useTaskStore.getState().tasks["thread-1"].agents;
    expect(agents.filter((agent) => isActiveAgentRecord(agent.status))).toHaveLength(1);
    expect(agents.find((agent) => agent.id === id)).toMatchObject({ rootTurnId: "old-turn", status: "idle", model: old.model, modelSource, createdAt: 1 });
    expect(links[id]).toMatchObject({ ...old, status: "idle" });
    expect(links[id]).not.toHaveProperty("rootTurnId");
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ turnId: "old-turn", status: "idle" });
  });

  it.each(["completed", "failed", "interrupted", "stopped"].flatMap((status) => [false, true].flatMap((canonicalAlias) => [false, true].flatMap((missingLinkTurn) => [false, true].map((missingActivityTurn) => ({ status, canonicalAlias, missingLinkTurn, missingActivityTurn }))))))("preserves actual terminal history against an unknown legacy mirror with %j", ({ status, canonicalAlias, missingLinkTurn, missingActivityTurn }) => {
    const rawId = "claude-native:thread-1:terminal-history-tool";
    const priorId = canonicalAlias ? "claude-native:thread-1:task:old-turn:terminal-task:001" : rawId;
    const prior: NativeAgentLink = { childThreadId: priorId, rootThreadId: "thread-1", ...(missingLinkTurn ? {} : { rootTurnId: "old-turn" }), runtime: "claude", title: "Original assignment", status: "unknown", createdAt: 1 };
    const links: Record<string, NativeAgentLink> = { [priorId]: prior };
    const activity = { id: "terminal-history-tool", kind: "agent" as const, title: "Original assignment", ...(missingActivityTurn ? {} : { turnId: "old-turn" }), status, agent: { action: "spawn" as const, provider: "claude" as const, threadIds: [priorId], task: "Actual assignment", model: "actual-model", modelSource: "execution" as const, progress: "Actual progress", result: "Actual terminal outcome" } };
    const resumedContext: ClaudeEventContext = { ...context, nativeAgentLinkFor: (id) => links[id], onNativeAgentDiscovered: (_root, id, details) => {
      links[id] = { ...links[id], ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)), childThreadId: id, rootThreadId: "thread-1", title: links[id]?.title ?? "Resumed assignment", createdAt: links[id]?.createdAt ?? 2 };
    } };
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activities: [activity] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "init" } }, resumedContext);
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "terminal-task", run_id: "002", tool_use_id: "terminal-history-tool" } }, resumedContext);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toBe(activity);
    expect(links[priorId]).toEqual(prior);
    const workers = collectSubAgentWorkers({ rootThreadId: "thread-1", links: {}, statuses: {}, agents: useTaskStore.getState().tasks["thread-1"].agents, nativeLinks: links });
    expect(workers.filter((worker) => worker.status === "working" || worker.status === "starting")).toHaveLength(1);
    expect(workers.find((worker) => worker.id === priorId)?.status).toBe("unknown");
  });

  it.each(["other-child", "different-old-turn", "current-turn"])("preserves terminal history and honors the prior %s identity boundary", (conflict) => {
    const id = "claude-native:thread-1:conflict-history-tool";
    const prior: NativeAgentLink = { childThreadId: id, rootThreadId: "thread-1", rootTurnId: "old-turn", runtime: "claude", title: "Original assignment", status: "unknown", createdAt: 1 };
    const links: Record<string, NativeAgentLink> = { [id]: prior };
    const activity = { id: "conflict-history-tool", kind: "agent" as const, title: "Other assignment", turnId: conflict === "current-turn" ? "turn-2" : conflict === "different-old-turn" ? "different-old-turn" : "old-turn", status: "completed", agent: { action: "spawn" as const, provider: "claude" as const, threadIds: [conflict === "other-child" ? "claude-native:thread-1:other-child" : id], result: "Unrelated outcome" } };
    const resumedContext: ClaudeEventContext = { ...context, nativeAgentLinkFor: (childId) => links[childId], onNativeAgentDiscovered: (_root, childId, details) => {
      links[childId] = { ...links[childId], ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)), childThreadId: childId, rootThreadId: "thread-1", title: links[childId]?.title ?? "Resumed assignment", createdAt: links[childId]?.createdAt ?? 2 };
    } };
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activities: [activity] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "init" } }, resumedContext);
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "conflict-task", run_id: "002", tool_use_id: "conflict-history-tool" } }, resumedContext);
    expect(links[id].status).toBe(conflict === "other-child" ? "idle" : "unknown");
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toBe(activity);
  });

  it.each([false, true])("retains richer active launch evidence during neutral retirement with canonical alias=%s", (canonicalAlias) => {
    const rawId = "claude-native:thread-1:rich-history-tool";
    const priorId = canonicalAlias ? "claude-native:thread-1:task:old-turn:rich-task:001" : rawId;
    const prior: NativeAgentLink = { childThreadId: priorId, rootThreadId: "thread-1", rootTurnId: "old-turn", runtime: "claude", title: "Original assignment", status: "unknown", createdAt: 1 };
    const links: Record<string, NativeAgentLink> = { [priorId]: prior };
    const evidence = { action: "spawn" as const, provider: "claude" as const, threadIds: [priorId], task: "Actual assignment", model: "actual-model", modelSource: "execution" as const, progress: "Actual progress", result: "Actual intermediate readout" };
    const activity = { id: "rich-history-tool", kind: "agent" as const, title: "Original assignment", turnId: "old-turn", status: "inProgress", agent: evidence };
    const resumedContext: ClaudeEventContext = { ...context, nativeAgentLinkFor: (id) => links[id], onNativeAgentDiscovered: (_root, id, details) => {
      links[id] = { ...links[id], ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)), childThreadId: id, rootThreadId: "thread-1", title: links[id]?.title ?? "Resumed assignment", createdAt: links[id]?.createdAt ?? 2 };
    } };
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activities: [activity] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "init" } }, resumedContext);
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "rich-task", run_id: "002", tool_use_id: "rich-history-tool" } }, resumedContext);
    expect(links[priorId].status).toBe("idle");
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ turnId: "old-turn", status: "idle", agent: evidence });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].agent).toBe(evidence);
  });

  it("does not attribute unversioned task-only completion to a resumed versioned agent", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "versioned-task", run_id: "001", tool_use_id: "old-versioned-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "versioned-task", run_id: "001", status: "completed" });
    send({ type: "system", subtype: "task_started", task_id: "versioned-task", run_id: "002", tool_use_id: "current-versioned-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "versioned-task", status: "completed", summary: "Unattributable outcome" });
    send({ type: "system", subtype: "task_notification", task_id: "versioned-task", tool_use_id: "old-versioned-tool", status: "completed", summary: "Old tool outcome" });
    expect(useTaskStore.getState().tasks["thread-1"].agents.find((agent) => agent.id === "claude-native:thread-1:current-versioned-tool")).toMatchObject({ status: "inProgress", result: undefined });
    send({ type: "system", subtype: "task_notification", task_id: "versioned-task", tool_use_id: "current-versioned-tool", status: "completed", summary: "Current tool outcome" });
    expect(useTaskStore.getState().tasks["thread-1"].agents.find((agent) => agent.id === "claude-native:thread-1:current-versioned-tool")).toMatchObject({ status: "completed", result: "Current tool outcome" });
  });

  it("tracks Agent and native lifecycle without pretending child output is the root answer", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "root-call", content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Audit", prompt: "Review ownership and report evidence", model: "requested" } }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ requestedModel: "requested", task: "Review ownership and report evidence" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0].model).toBeUndefined();
    send({ type: "assistant", parent_tool_use_id: "agent-tool", message: { id: "child-answer", model: "actual-model", content: [{ type: "text", text: "Private child progress" }] } });
    send({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "agent-tool", description: "Audit" });
    send({ type: "system", subtype: "task_notification", task_id: "task", status: "completed", summary: "Audit done" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages.some((message) => message.id === "child-answer")).toBe(false);
    expect(task.agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:agent-tool", runtime: "claude", provider: "claude", model: "actual-model", modelSource: "execution", requestedModel: "requested", task: "Review ownership and report evidence", progress: "Private child progress", result: "Audit done", status: "completed" })]);
    expect(task.activities[0]).toMatchObject({ kind: "agent", status: "completed", agent: { threadIds: ["claude-native:thread-1:agent-tool"] } });
    expect(useTaskStore.getState().tasks["claude-native:thread-1:agent-tool"]).toBeUndefined();
    expect(context.onNativeAgentDiscovered).toHaveBeenCalledWith("thread-1", "claude-native:thread-1:agent-tool", expect.objectContaining({ runtime: "claude", status: "completed" }));
  });

  it("does not turn background command tasks into sub-agents", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell-tool", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } });
    send({ type: "system", subtype: "task_started", task_id: "shell-task", tool_use_id: "shell-tool", task_type: "local_bash", description: "Development server" });
    send({ type: "system", subtype: "task_progress", task_id: "shell-task", tool_use_id: "shell-tool", summary: "Server listening" });
    send({ type: "system", subtype: "task_notification", task_id: "shell-task", status: "completed", summary: "Server stopped" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.agents).toEqual([]);
    expect(context.onNativeAgentDiscovered).not.toHaveBeenCalled();
    expect(task.activities).toEqual([expect.objectContaining({ id: "shell-tool", kind: "command", title: "npm run dev" })]);
  });

  it("does not guess that untyped or unknown background tasks are agents", () => {
    send({ type: "system", subtype: "init" });
    for (const taskType of [undefined, "mcp_task", "local_bash", "future_task"]) {
      const taskId = taskType || "untyped";
      send({ type: "system", subtype: "task_started", task_id: taskId, task_type: taskType, owned_by_subagent: true, description: "Working" });
      send({ type: "system", subtype: "task_progress", task_id: taskId, summary: "Progress" });
      send({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed" });
    }
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([]);
    expect(context.onNativeAgentDiscovered).not.toHaveBeenCalled();
  });

  it("tracks positively identified agents when lifecycle arrives before the Agent tool", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "native-task", tool_use_id: "agent-first", task_type: "local_agent", description: "Review code" });
    send({ type: "system", subtype: "task_progress", task_id: "native-task", summary: "Reviewed parser" });
    send({ type: "system", subtype: "task_notification", task_id: "native-task", status: "completed", summary: "Review complete" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:agent-first", status: "completed", progress: "Reviewed parser", result: "Review complete" })]);
  });

  it("does not reuse another turn's native task binding", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "reused", tool_use_id: "old-agent", task_type: "local_agent" });
    send({ type: "result", subtype: "success", result: "Done" });
    send({ type: "system", subtype: "init" }, "turn-2");
    send({ type: "system", subtype: "task_progress", task_id: "reused", tool_use_id: "old-agent", summary: "Not new agent evidence" }, "turn-2");
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:old-agent", status: "completed", rootTurnId: "turn-1" })]);
  });

  it("keeps a task-only native start, later tool identity and forwarded child as one worker", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "canonical-task", task_type: "local_agent", description: "Audit" });
    send({ type: "system", subtype: "task_started", task_id: "canonical-task", tool_use_id: "canonical-tool", task_type: "local_agent" });
    send({ type: "assistant", parent_tool_use_id: "canonical-tool", agent_id: "canonical-task", message: { model: "reported-model", content: [{ type: "text", text: "Checking" }] } });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "canonical-tool", name: "Agent", input: { description: "Audit", prompt: "Check code" } }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "canonical-tool", content: "Done" }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:task:turn-1:canonical-task", model: "reported-model", status: "completed", result: "Done" })]);
  });

  it("correlates a forwarded child's agent_id before any task_started event", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", parent_tool_use_id: "child-tool", agent_id: "child-task", message: { content: [{ type: "text", text: "Checking" }] } });
    send({ type: "system", subtype: "task_notification", task_id: "child-task", status: "completed", summary: "Done" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:child-tool", status: "completed", result: "Done" })]);
  });

  it.each(["child", "lifecycle"])("merges a late %s task/tool join after both identities were recorded", (join) => {
    const links = new Map<string, object>();
    const mergedContext: ClaudeEventContext = {
      ...context,
      onNativeAgentDiscovered: (_root, id, details) => { links.set(id, details); },
      onNativeAgentReidentified: (_root, previousId, canonicalId) => {
        expect(links.get(canonicalId)).toMatchObject({ task: "Full assignment", status: "failed", result: "Failure evidence" });
        links.delete(previousId);
      },
    };
    const route = (message: Record<string, unknown>) => routeClaudeEvent({ threadId: "thread-1", turnId: "turn-1", message }, mergedContext);
    const canonicalId = "claude-native:thread-1:task:turn-1:late-task";
    route({ type: "system", subtype: "init" });
    route({ type: "system", subtype: "task_started", task_id: "late-task", task_type: "local_agent", description: "Audit" });
    route({ type: "system", subtype: "task_notification", task_id: "late-task", status: "completed", summary: "Earlier completion evidence" });
    route({ type: "assistant", message: { content: [{ type: "tool_use", id: "late-tool", name: "Agent", input: { description: "Audit", prompt: "Full assignment", model: "requested-only" } }] } });
    route({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "late-tool", is_error: true, content: "Failure evidence" }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toHaveLength(2);
    expect(links.size).toBe(2);
    route(join === "child"
      ? { type: "assistant", parent_tool_use_id: "late-tool", agent_id: "late-task", message: { content: [{ type: "text", text: "Late progress" }] } }
      : { type: "system", subtype: "task_started", task_id: "late-task", tool_use_id: "late-tool", task_type: "local_agent" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: canonicalId, task: "Full assignment", requestedModel: "requested-only", model: undefined, status: "failed", result: "Failure evidence" })]);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ status: "failed", agent: { threadIds: [canonicalId], result: "Failure evidence" } });
    expect([...links.keys()]).toEqual([canonicalId]);
    route({ type: "system", subtype: "task_notification", task_id: "late-task", status: "failed", summary: "Final failure evidence" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toHaveLength(1);
  });

  it("keeps terminal agent activities settled through late tool and lifecycle replay", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "settled-task", tool_use_id: "settled-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "settled-task", status: "completed", summary: "Completed evidence" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "settled-tool", name: "Agent", input: { prompt: "Assignment", model: "requested-only" } }] } });
    send({ type: "system", subtype: "task_progress", task_id: "settled-task", summary: "Late progress" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.agents[0]).toMatchObject({ status: "completed", result: "Completed evidence", model: undefined });
    expect(task.activities[0]).toMatchObject({ status: "completed", agent: { result: "Completed evidence", requestedModel: "requested-only" } });
  });

  it("preserves a duplicate worker when durable ownership refuses the identity join", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "refused-task", task_type: "local_agent" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "refused-tool", name: "Agent", input: {} }] } });
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-1", message: { type: "assistant", parent_tool_use_id: "refused-tool", agent_id: "refused-task", message: { content: [] } } }, {
      ...context, onNativeAgentReidentified: () => false,
    });
    expect(useTaskStore.getState().tasks["thread-1"].agents.map((agent) => agent.id)).toEqual([
      "claude-native:thread-1:task:turn-1:refused-task", "claude-native:thread-1:refused-tool",
    ]);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].agent?.threadIds).toEqual(["claude-native:thread-1:refused-tool"]);
  });

  it("leaves conflicting execution models unknown at a late identity join until fresh confirmation", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "model-task", task_type: "local_agent" });
    send({ type: "assistant", parent_tool_use_id: "first-model-tool", agent_id: "model-task", message: { model: "model-a", content: [] } });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "second-model-tool", name: "Agent", input: {} }] } });
    send({ type: "assistant", parent_tool_use_id: "second-model-tool", message: { model: "model-b", content: [] } });
    send({ type: "system", subtype: "task_started", task_id: "model-task", tool_use_id: "second-model-tool", task_type: "local_agent" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ model: "", modelSource: undefined })]);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].agent).toMatchObject({ model: "", modelSource: undefined });
    send({ type: "assistant", parent_tool_use_id: "second-model-tool", agent_id: "model-task", message: { model: "model-c", content: [] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ model: "model-c", modelSource: "execution" })]);
  });

  it.each([false, true])("counts only the current positively resumed activation when its launch tool is reused=%s", (reused) => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "active-prior-tool", name: "Agent", input: { prompt: "Original assignment" } }] } });
    send({ type: "system", subtype: "task_started", task_id: "active-prior-task", run_id: "001", tool_use_id: "active-prior-tool", task_type: "local_agent" });
    send({ type: "assistant", parent_tool_use_id: "active-prior-tool", agent_id: "active-prior-task", message: { model: "original-model", content: [{ type: "text", text: "Original progress" }] } });
    const newTool = reused ? "active-prior-tool" : "active-resume-tool";
    send({ type: "system", subtype: "task_started", task_id: "active-prior-task", run_id: "002", tool_use_id: newTool, task_type: "local_agent" });
    const agents = () => useTaskStore.getState().tasks["thread-1"].agents;
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toHaveLength(1);
    expect(agents()[0]).toMatchObject({ status: "idle", task: "Original assignment", model: "original-model", progress: "Original progress", result: undefined });
    send({ type: "assistant", parent_tool_use_id: "active-prior-tool", agent_id: "active-prior-task", message: { model: "late-old-model", content: [{ type: "text", text: "Late old child" }] } });
    send({ type: "system", subtype: "task_progress", task_id: "active-prior-task", run_id: "001", tool_use_id: "active-prior-tool", summary: "Late old progress" });
    expect(agents()[0]).toMatchObject({ status: "idle", task: "Original assignment", model: "original-model", progress: "Original progress", result: undefined });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ status: "idle" });
    send({ type: "system", subtype: "task_notification", task_id: "active-prior-task", run_id: "002", tool_use_id: newTool, status: "completed", summary: "Current outcome" });
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toHaveLength(0);
    expect(agents()[1]).toMatchObject({ status: "completed", result: "Current outcome" });
  });

  it("retains a stopped source and its outcome when a late positive join merges it into an active canonical agent", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "active-canonical-task", task_type: "local_agent", description: "Active canonical" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "stopped-source-tool", name: "Agent", input: { prompt: "Source assignment" } }] } });
    send({ type: "system", subtype: "task_started", task_id: "stopped-source-task", tool_use_id: "stopped-source-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "stopped-source-task", tool_use_id: "stopped-source-tool", status: "stopped", summary: "Stopped source outcome" });
    send({ type: "system", subtype: "task_started", task_id: "active-canonical-task", tool_use_id: "stopped-source-tool", task_type: "local_agent" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([
      expect.objectContaining({ id: "claude-native:thread-1:task:turn-1:active-canonical-task", status: "stopped", result: "Stopped source outcome" }),
    ]);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ status: "stopped", agent: { result: "Stopped source outcome", threadIds: ["claude-native:thread-1:task:turn-1:active-canonical-task"] } });
  });

  it("routes versioned lifecycle to a resumed activation when Claude reuses its original launch tool", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "shared-resume-tool", name: "Agent", input: { prompt: "Original assignment" } }] } });
    send({ type: "system", subtype: "task_started", task_id: "shared-resume-task", run_id: "0m1aaaaaa-11111111", tool_use_id: "shared-resume-tool", task_type: "local_agent", description: "Original assignment", is_backgrounded: true });
    send({ type: "system", subtype: "task_notification", task_id: "shared-resume-task", run_id: "0m1aaaaaa-11111111", tool_use_id: "shared-resume-tool", status: "completed", summary: "Original outcome" });
    // Claude's automatic resume falls back to the task's previous toolUseId.
    send({ type: "system", subtype: "task_started", task_id: "shared-resume-task", run_id: "0m1aaaaab-22222222", tool_use_id: "shared-resume-tool", task_type: "local_agent", description: "Resumed assignment", is_backgrounded: true });
    send({ type: "assistant", parent_tool_use_id: "shared-resume-tool", agent_id: "shared-resume-task", message: { model: "ambiguous-model", content: [{ type: "text", text: "Unversioned child frame" }] } });
    send({ type: "system", subtype: "task_progress", task_id: "shared-resume-task", run_id: "0m1aaaaab-22222222", tool_use_id: "shared-resume-tool", description: "Resumed assignment", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 }, summary: "Resumed progress" });
    send({ type: "system", subtype: "task_notification", task_id: "shared-resume-task", run_id: "0m1aaaaab-22222222", tool_use_id: "shared-resume-tool", status: "completed", summary: "Resumed outcome" });
    const agents = useTaskStore.getState().tasks["thread-1"].agents;
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ id: "claude-native:thread-1:shared-resume-tool", status: "completed", result: "Original outcome" });
    expect(agents[1]).toMatchObject({ id: "claude-native:thread-1:task:turn-1:shared-resume-task:0m1aaaaab-22222222", status: "completed", progress: "Resumed progress", result: "Resumed outcome", model: undefined });
  });

  it.each(["stopped", "canceled", "shutdown", "failure", "succeeded"])("keeps the terminal %s agent settled through same-run replay", (status) => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "terminal-task", run_id: "001", tool_use_id: "terminal-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "terminal-task", run_id: "001", status, summary: "Terminal outcome" });
    send({ type: "system", subtype: "task_progress", task_id: "terminal-task", run_id: "001", summary: "Late progress" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "terminal-tool", name: "Agent", input: { prompt: "Assignment" } }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ status, result: "Terminal outcome" });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ status });
  });

  it("does not merge a new launch tool into a versioned active run before its positive resumed start", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "paused-old-tool", name: "Agent", input: { prompt: "Original assignment" } }] } });
    send({ type: "system", subtype: "task_started", task_id: "paused-task", run_id: "001", tool_use_id: "paused-old-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_updated", task_id: "paused-task", run_id: "001", patch: { status: "paused" } });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "paused-new-tool", name: "Agent", input: { prompt: "Resumed assignment" } }] } });
    send({ type: "assistant", parent_tool_use_id: "paused-new-tool", agent_id: "paused-task", message: { content: [{ type: "text", text: "Resumed child before lifecycle" }] } });
    send({ type: "system", subtype: "task_started", task_id: "paused-task", run_id: "002", tool_use_id: "paused-new-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "paused-task", run_id: "002", tool_use_id: "paused-new-tool", status: "completed", summary: "Resumed outcome" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([
      expect.objectContaining({ id: "claude-native:thread-1:paused-old-tool", task: "Original assignment", result: undefined }),
      expect.objectContaining({ id: "claude-native:thread-1:paused-new-tool", task: "Resumed assignment", status: "completed", result: "Resumed outcome" }),
    ]);
  });

  it("keeps a newer resumed task active and refuses old run or child frames in the same root turn", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "resumed-task", run_id: "001", tool_use_id: "old-run-tool", task_type: "local_agent" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "old-run-tool", name: "Agent", input: { prompt: "Old assignment" } }] } });
    send({ type: "system", subtype: "task_notification", task_id: "resumed-task", run_id: "001", status: "completed", summary: "Old result" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "new-run-tool", name: "Agent", input: { prompt: "Resume assignment" } }] } });
    send({ type: "assistant", parent_tool_use_id: "new-run-tool", agent_id: "resumed-task", message: { content: [{ type: "text", text: "Resume child before start" }] } });
    send({ type: "system", subtype: "task_progress", task_id: "resumed-task", run_id: "002", tool_use_id: "new-run-tool", summary: "Unconfirmed run progress" });
    send({ type: "system", subtype: "task_started", task_id: "resumed-task", run_id: "002", tool_use_id: "new-run-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "resumed-task", run_id: "001", tool_use_id: "old-run-tool", status: "failed", summary: "Late old failure" });
    send({ type: "system", subtype: "task_started", task_id: "resumed-task", run_id: "001", tool_use_id: "old-run-tool", task_type: "local_agent" });
    send({ type: "assistant", parent_tool_use_id: "old-run-tool", agent_id: "resumed-task", message: { model: "old-model", content: [{ type: "text", text: "Old child progress" }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([
      expect.objectContaining({ id: "claude-native:thread-1:old-run-tool", status: "completed", result: "Old result" }),
      expect.objectContaining({ id: "claude-native:thread-1:new-run-tool", status: "inProgress", task: "Resume assignment", model: undefined, progress: "Resume child before start", result: undefined }),
    ]);
    send({ type: "assistant", parent_tool_use_id: "new-run-tool", agent_id: "resumed-task", message: { model: "new-model", content: [{ type: "text", text: "Current child progress" }] } });
    send({ type: "system", subtype: "task_notification", task_id: "resumed-task", run_id: "002", status: "completed", summary: "Resume result" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[1]).toMatchObject({ model: "new-model", progress: "Current child progress", result: "Resume result", status: "completed" });
    expect(context.onNativeAgentReidentified).not.toHaveBeenCalled();
  });

  it("gives task-only runs separate identities and keeps earlier tool aliases on their own activation", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "task-only-resume", run_id: "001", task_type: "local_agent" });
    send({ type: "system", subtype: "task_started", task_id: "task-only-resume", run_id: "001", tool_use_id: "old-only-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "task-only-resume", run_id: "001", status: "completed", summary: "Prior outcome" });
    send({ type: "system", subtype: "task_started", task_id: "task-only-resume", run_id: "002", task_type: "local_agent" });
    send({ type: "assistant", parent_tool_use_id: "old-only-tool", agent_id: "task-only-resume", message: { content: [{ type: "text", text: "Prior child" }] } });
    send({ type: "assistant", parent_tool_use_id: "new-only-tool", agent_id: "task-only-resume", message: { content: [{ type: "text", text: "Resumed child" }] } });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "new-only-tool", name: "Agent", input: { prompt: "Resume" } }] } });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.agents).toEqual([
      expect.objectContaining({ id: "claude-native:thread-1:task:turn-1:task-only-resume:001", status: "completed", result: "Prior outcome", progress: "Prior child" }),
      expect.objectContaining({ id: "claude-native:thread-1:task:turn-1:task-only-resume:002", status: "inProgress", task: "Resume", progress: "Resumed child", result: undefined }),
    ]);
    expect(task.activities[0].agent?.threadIds).toEqual(["claude-native:thread-1:task:turn-1:task-only-resume:002"]);
  });

  it("does not bind a run-bearing progress event before that run is positively started", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "early-tool", name: "Agent", input: {} }] } });
    send({ type: "system", subtype: "task_progress", task_id: "early-task", run_id: "001", tool_use_id: "early-tool", summary: "Premature progress" });
    send({ type: "system", subtype: "task_notification", task_id: "early-task", run_id: "001", status: "completed", summary: "Premature result" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ status: "inProgress", progress: undefined, result: undefined });
    send({ type: "system", subtype: "task_started", task_id: "early-task", run_id: "001", tool_use_id: "early-tool", task_type: "local_agent" });
    send({ type: "system", subtype: "task_notification", task_id: "early-task", run_id: "001", status: "completed", summary: "Confirmed result" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ status: "completed", result: "Confirmed result" });
  });

  it("does not promote generic parent-tool progress to a native agent", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "tool_progress", parent_tool_use_id: "shell-tool", tool_name: "Bash" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([]);
  });

  it("recognizes a native lifecycle during streamed Agent input without promoting Bash", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "stream-agent", name: "Agent" } } });
    send({ type: "system", subtype: "task_started", task_id: "agent-task", tool_use_id: "stream-agent" });
    send({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "stream-shell", name: "Bash" } } });
    send({ type: "system", subtype: "task_started", task_id: "shell-task", tool_use_id: "stream-shell" });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id: "claude-native:thread-1:stream-agent" })]);
  });

  it("does not reuse an abandoned Agent stream block on a new turn's text", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "abandoned-agent", name: "Agent" } } });
    useTaskStore.getState().completeTurn("thread-1", "turn-1", "interrupted");
    send({ type: "system", subtype: "init" }, "turn-2");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "new-answer" } } }, "turn-2");
    send({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }, "turn-2");
    send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, "turn-2");
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([]);
  });

  it("clears old readout when a confirmed task identity is used by a new root turn", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "task_started", task_id: "reusable-task", task_type: "local_agent", description: "Old task" });
    send({ type: "system", subtype: "task_notification", task_id: "reusable-task", status: "completed", summary: "Old result" });
    send({ type: "result", subtype: "success", result: "Parent done" });
    send({ type: "system", subtype: "init" }, "turn-2");
    send({ type: "system", subtype: "task_started", task_id: "reusable-task", task_type: "local_agent", description: "New task" }, "turn-2");
    const agents = useTaskStore.getState().tasks["thread-1"].agents;
    expect(agents).toEqual([
      expect.objectContaining({ id: "claude-native:thread-1:task:turn-1:reusable-task", status: "completed", result: "Old result" }),
      expect.objectContaining({ id: "claude-native:thread-1:task:turn-2:reusable-task", status: "inProgress", rootTurnId: "turn-2", prompt: "New task", result: undefined, model: undefined }),
    ]);
  });

  it.each(["retained", "pruned", "unloaded", "unknown-turn"])("keeps a reused launch tool on its original root turn with %s prior evidence", (priorEvidence) => {
    const links = new Map<string, object>();
    const resumedContext: ClaudeEventContext = { ...context,
      nativeAgentLinkFor: (id) => {
        const details = links.get(id);
        return details ? { ...details, childThreadId: id, rootThreadId: "thread-1", runtime: "claude", title: "Original assignment", createdAt: 1 } : undefined;
      },
      onNativeAgentDiscovered: (_root, id, details) => {
      links.set(id, { ...links.get(id), ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)) });
    } };
    const route = (turnId: string, message: Record<string, unknown>) => routeClaudeEvent({ threadId: "thread-1", turnId, message }, resumedContext);
    const originalId = "claude-native:thread-1:cross-turn-tool";
    const resumedId = "claude-native:thread-1:task:turn-2:cross-turn-task:002";
    route("turn-1", { type: "system", subtype: "init" });
    route("turn-1", { type: "assistant", message: { content: [{ type: "tool_use", id: "cross-turn-tool", name: "Agent", input: { prompt: "Original assignment" } }] } });
    route("turn-1", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "cross-turn-task", run_id: "001", tool_use_id: "cross-turn-tool" });
    route("turn-1", { type: "assistant", parent_tool_use_id: "cross-turn-tool", agent_id: "cross-turn-task", message: { model: "original-model", content: [{ type: "text", text: "Original progress" }] } });
    route("turn-1", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", run_id: "001", status: "completed", summary: "Original outcome" });
    route("turn-1", { type: "result", subtype: "success", result: "Parent done" });
    const originalActivity = useTaskStore.getState().tasks["thread-1"].activities[0];
    if (priorEvidence !== "retained") useTaskStore.getState().beginAgentRun("thread-1");
    if (priorEvidence === "unloaded" || priorEvidence === "unknown-turn") useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activities: [] } } }));
    if (priorEvidence === "unknown-turn") links.set(originalId, { ...links.get(originalId), rootTurnId: undefined });
    route("turn-2", { type: "system", subtype: "init" });
    // Forwarded raw-tool replay can arrive before its resumed lifecycle start.
    route("turn-2", { type: "assistant", parent_tool_use_id: "cross-turn-tool", agent_id: "cross-turn-task", message: { model: "stale-model", content: [{ type: "text", text: "Before start replay" }] } });
    route("turn-2", { type: "assistant", message: { content: [{ type: "tool_use", id: "cross-turn-tool", name: "Agent", input: { prompt: "Old launch replay" } }] } });
    route("turn-2", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "cross-turn-task", run_id: "002", tool_use_id: "cross-turn-tool", description: "Resumed assignment" });
    const agents = () => useTaskStore.getState().tasks["thread-1"].agents;
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toEqual([expect.objectContaining({ id: resumedId, rootTurnId: "turn-2", prompt: "Resumed assignment", model: undefined, progress: undefined, result: undefined })]);
    expect(links.get(originalId)).toMatchObject({ rootTurnId: priorEvidence === "unknown-turn" ? undefined : "turn-1", status: "completed", model: "original-model", result: "Original outcome" });
    route("turn-2", { type: "assistant", parent_tool_use_id: "cross-turn-tool", agent_id: "cross-turn-task", message: { model: "stale-model", content: [{ type: "text", text: "Ambiguous old child" }] } });
    route("turn-2", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", tool_use_id: "cross-turn-tool", status: "failed", summary: "Ambiguous old outcome" });
    route("turn-2", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cross-turn-tool", is_error: true, content: "Old tool result" }] } });
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toHaveLength(1);
    if (priorEvidence === "retained" || priorEvidence === "pruned") expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toEqual(originalActivity);
    else expect(useTaskStore.getState().tasks["thread-1"].activities).toEqual([]);
    expect(links.get(originalId)).toMatchObject({ rootTurnId: priorEvidence === "unknown-turn" ? undefined : "turn-1", model: "original-model", result: "Original outcome" });
    route("turn-2", { type: "system", subtype: "task_progress", task_id: "cross-turn-task", run_id: "002", tool_use_id: "cross-turn-tool", summary: "Resumed progress" });
    route("turn-2", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", run_id: "002", tool_use_id: "cross-turn-tool", status: "completed", summary: "Resumed outcome" });
    expect(agents().find((agent) => agent.id === resumedId)).toMatchObject({ status: "completed", progress: "Resumed progress", result: "Resumed outcome", model: undefined });
    expect(links.get(resumedId)).toMatchObject({ rootTurnId: "turn-2", status: "completed", result: "Resumed outcome" });
    expect(links.get(resumedId)).not.toHaveProperty("model");
    // The same original tool can be reused again after the cross-turn resume.
    route("turn-2", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "cross-turn-task", run_id: "003", tool_use_id: "cross-turn-tool" });
    const thirdId = "claude-native:thread-1:task:turn-2:cross-turn-task:003";
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toEqual([expect.objectContaining({ id: thirdId, model: undefined, result: undefined })]);
    route("turn-2", { type: "system", subtype: "task_progress", task_id: "cross-turn-task", run_id: "003", tool_use_id: "cross-turn-tool", summary: "Third progress" });
    route("turn-2", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", run_id: "003", tool_use_id: "cross-turn-tool", status: "completed", summary: "Third outcome" });
    expect(links.get(thirdId)).toMatchObject({ status: "completed", result: "Third outcome" });
    route("turn-2", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "cross-turn-task", run_id: "004", tool_use_id: "cross-turn-tool" });
    route("turn-2", { type: "system", subtype: "task_started", task_type: "local_agent", task_id: "cross-turn-task", run_id: "005", tool_use_id: "cross-turn-tool" });
    expect(agents().find((agent) => agent.id.endsWith(":004"))).toMatchObject({ status: "idle", result: undefined });
    expect(agents().filter((agent) => isActiveAgentRecord(agent.status))).toEqual([expect.objectContaining({ id: "claude-native:thread-1:task:turn-2:cross-turn-task:005", result: undefined })]);
    route("turn-2", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", run_id: "004", tool_use_id: "cross-turn-tool", status: "failed", summary: "Stale fourth outcome" });
    route("turn-2", { type: "system", subtype: "task_notification", task_id: "cross-turn-task", run_id: "005", tool_use_id: "cross-turn-tool", status: "completed", summary: "Fifth outcome" });
    expect(agents().find((agent) => agent.id.endsWith(":004"))).toMatchObject({ status: "idle", result: undefined });
    expect(agents().find((agent) => agent.id.endsWith(":005"))).toMatchObject({ status: "completed", result: "Fifth outcome" });
    expect(links.get(originalId)).toMatchObject({ rootTurnId: priorEvidence === "unknown-turn" ? undefined : "turn-1", model: "original-model", result: "Original outcome" });
  });

  it.each([
    { rootTurnId: "old-turn", canonicalAlias: false }, { rootTurnId: undefined, canonicalAlias: false },
    { rootTurnId: "old-turn", canonicalAlias: true }, { rootTurnId: undefined, canonicalAlias: true },
  ])("preserves durable Claude ownership and legacy history with prior identity %j", ({ rootTurnId, canonicalAlias }) => {
    const id = "claude-native:thread-1:legacy-tool";
    const durableId = canonicalAlias ? "claude-native:thread-1:task:old-turn:legacy-task:001" : id;
    const nativeAgentDiscovered = vi.fn();
    const legacyActivity = { id: "legacy-tool", kind: "agent" as const, title: "Original assignment", status: "completed", agent: { action: "spawn" as const, provider: "claude" as const, threadIds: [durableId], result: "Original outcome" } };
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activeTurnId: "turn-2", activities: [legacyActivity] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "legacy-tool", is_error: true, content: "Ambiguous old result" }] } } }, {
      ...context,
      nativeAgentLinkFor: (childThreadId) => childThreadId === durableId ? { childThreadId: durableId, rootThreadId: "thread-1", rootTurnId, runtime: "claude", title: "Original assignment", status: "completed", result: "Original outcome", createdAt: 1 } : undefined,
      onNativeAgentDiscovered: nativeAgentDiscovered,
    });
    expect(nativeAgentDiscovered).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks["thread-1"].activities).toEqual([legacyActivity]);
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([]);
  });

  it("accepts a current-turn native tool result when durable ownership proves a legacy row's turn", () => {
    const id = "claude-native:thread-1:current-tool";
    const nativeAgentDiscovered = vi.fn();
    useTaskStore.getState().ensureTask("thread-1");
    useTaskStore.setState((state) => ({ tasks: { ...state.tasks, "thread-1": { ...state.tasks["thread-1"], activeTurnId: "turn-2", activities: [{ id: "current-tool", kind: "agent", title: "Current assignment", status: "inProgress", agent: { action: "spawn", provider: "claude", threadIds: [id] } }] } } }));
    routeClaudeEvent({ threadId: "thread-1", turnId: "turn-2", message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "current-tool", content: "Current result" }] } } }, {
      ...context,
      nativeAgentLinkFor: (childThreadId) => childThreadId === id ? { childThreadId: id, rootThreadId: "thread-1", rootTurnId: "turn-2", runtime: "claude", title: "Current assignment", status: "inProgress", createdAt: 1 } : undefined,
      onNativeAgentDiscovered: nativeAgentDiscovered,
    });
    expect(nativeAgentDiscovered).toHaveBeenCalledWith("thread-1", id, expect.objectContaining({ rootTurnId: "turn-2", status: "completed", result: "Current result" }));
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ turnId: "turn-2", status: "completed", agent: { result: "Current result" } });
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([expect.objectContaining({ id, rootTurnId: "turn-2", status: "completed", result: "Current result" })]);
  });

  it("bounds forwarded native text and keeps task descriptions separate from assignments", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "bounded", name: "Agent", input: { description: "Short title", prompt: "Actual assignment" } }] } });
    send({ type: "assistant", parent_tool_use_id: "bounded", message: { content: [{ type: "text", text: "a".repeat(16000) + "recent" }] } });
    send({ type: "system", subtype: "task_progress", task_id: "task", tool_use_id: "bounded", description: "Changed progress description", summary: "Checked ownership" });
    let agent = useTaskStore.getState().tasks["thread-1"].agents[0];
    expect(agent).toMatchObject({ prompt: "Short title", task: "Actual assignment", progress: "Checked ownership" });
    send({ type: "assistant", parent_tool_use_id: "bounded", message: { content: [{ type: "text", text: "a".repeat(16000) + "recent" }] } });
    agent = useTaskStore.getState().tasks["thread-1"].agents[0];
    expect(agent.progress?.length).toBe(8001);
    expect(agent.progress).toMatch(/recent$/);
    send({ type: "user", parent_tool_use_id: "bounded", message: { model: "not-assistant-execution", content: [{ type: "tool_result", content: "Actual child tool output" }] } });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ progress: "Actual child tool output" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0].model).toBeUndefined();
    expect(useTaskStore.getState().tasks["thread-1"].messages.some((entry) => entry.text.includes("recent"))).toBe(false);
    expect(useTaskStore.getState().tasks["thread-1"].agents).toHaveLength(1);
  });

  it("keeps child permission requests on the actual root control channel", () => {
    send({ type: "control_request", parent_tool_use_id: "agent-tool", request_id: "approval", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" } } });
    expect(useTaskStore.getState().tasks["thread-1"].approvals[0]).toMatchObject({ id: "approval", threadId: "thread-1" });
    send({ type: "control_cancel_request", parent_tool_use_id: "agent-tool", request_id: "approval" });
    expect(useTaskStore.getState().tasks["thread-1"].approvals).toEqual([]);
    expect(useTaskStore.getState().tasks["thread-1"].agents).toEqual([]);
  });

  it("preserves a failed native child when the root finishes successfully", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Audit" } }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", is_error: true, content: "Failed child" }] } });
    send({ type: "result", subtype: "success", result: "Recovered in the parent" });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0].status).toBe("failed");
  });

  it("persists native child failure on process exit without a final result", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Audit" } }] } });
    send({ type: "openkiwi_exit", message: "Process crashed" });
    expect(context.onNativeAgentDiscovered).toHaveBeenLastCalledWith("thread-1", "claude-native:thread-1:agent-tool", expect.objectContaining({ status: "failed", rootTurnId: "turn-1" }));
    expect(useTaskStore.getState().tasks["thread-1"].agents[0].status).toBe("failed");
  });

  it("does not settle a replacement turn's native children from an old process exit", () => {
    send({ type: "system", subtype: "init" }, "new-turn");
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "new-agent", name: "Agent", input: { description: "New task" } }] } }, "new-turn");
    const callbacks = vi.mocked(context.onNativeAgentDiscovered!).mock.calls.length;
    send({ type: "openkiwi_exit", message: "Old process crashed" }, "old-turn");
    expect(vi.mocked(context.onNativeAgentDiscovered!).mock.calls).toHaveLength(callbacks);
    expect(useTaskStore.getState().tasks["thread-1"].agents[0]).toMatchObject({ status: "inProgress", rootTurnId: "new-turn" });
  });

  it("counts native Skill only after a successful result, preserving streamed/replayed identity and reload", () => {
    send({ type: "system", subtype: "init", skills: ["available-but-unused"] });
    send({ type: "stream_event", event: { type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "skill-call", name: "Skill" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"skill":"openkiwi-skills:review","args":"private instructions"}' } } });
    send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    const entries = () => useTaskStore.getState().tasks["thread-1"].activities.map((value) => ({ kind: "activity" as const, value }));
    expect(usedSkillsForRun(entries())).toEqual([]);
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill-call", content: "Launching skill" }] } });
    expect(usedSkillsForRun(entries())).toEqual([{ identity: "name:openkiwi-skills:review", name: "openkiwi-skills:review" }]);
    send({ type: "assistant", message: { id: "replay", content: [{ type: "tool_use", id: "skill-call", name: "Skill",
      input: { skill: "openkiwi-skills:review", args: "private instructions" } }] } });
    expect(entries()).toHaveLength(1);
    expect(entries()[0].value).toMatchObject({ status: "completed", detail: "Launching skill",
      skillUsage: [{ name: "openkiwi-skills:review", source: "claude-skill-tool", status: "loaded" }] });
    const snapshot = JSON.parse(JSON.stringify(useTaskStore.getState().tasks["thread-1"].activities));
    expect(snapshot[0].skillUsage[0]).not.toHaveProperty("args");
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", [], snapshot);
    expect(usedSkillsForRun(entries())).toHaveLength(1);
  });

  it.each([true, false])("does not count failed or unconfirmed native Skill loads after turn completion (error=%s)", (failed) => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "tool-message", content: [{ type: "tool_use", id: "skill-call", name: "Skill", input: { skill: "review" } }] } });
    if (failed) send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill-call", is_error: true, content: "Unknown skill" }] } });
    send({ type: "result", subtype: "success", result: "Done" });
    const activity = useTaskStore.getState().tasks["thread-1"].activities[0];
    expect(activity.skillUsage?.[0].status).toBe(failed ? "failed" : "pending");
    expect(usedSkillsForRun([{ kind: "activity", value: activity }])).toEqual([]);
  });

  it("does not infer native skill use from generic tools, available catalogs, or assistant prose", () => {
    send({ type: "system", subtype: "init", skills: ["review"] });
    send({ type: "assistant", message: { id: "tool-message", content: [
      { type: "text", text: "I am using the review skill." },
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "/skills/review/SKILL.md" } },
      { type: "tool_use", id: "mcp", name: "mcp__fake__Skill", input: { skill: "review" } },
    ] } });
    expect(useTaskStore.getState().tasks["thread-1"].activities.every((activity) => activity.skillUsage === undefined)).toBe(true);
  });

  it("keeps a failed Bash command after Claude compaction in details while a retry runs", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary", compact_metadata: { trigger: "auto", pre_tokens: 12320 } });
    send({ type: "assistant", message: { id: "tools", content: [
      { type: "tool_use", id: "failed-bash", name: "Bash", input: { command: "npm test" } },
    ] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "failed-bash", is_error: true, content: "Command exited with code 1" }] } });
    send({ type: "assistant", message: { id: "retry-tools", content: [
      { type: "tool_use", id: "retry-bash", name: "Bash", input: { command: "npm run check" } },
    ] } });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities.find((activity) => activity.id === "failed-bash")).toMatchObject({ kind: "command", status: "failed", detail: "Command exited with code 1" });
    const entries = task.activities.map((value) => ({ kind: "activity" as const, value }));
    const presentation = compactActivityPresentation(entries, { running: true, activeTurnId: "turn-1" });
    expect(presentation.filter((entry) => entry.kind === "activity").map((entry) => entry.value.kind)).toEqual(["compaction"]);
    expect(presentation.filter((entry) => entry.kind === "work").flatMap((entry) => entry.value)).toEqual(
      entries.filter((entry) => entry.value.kind === "command"),
    );
  });

  it("recovers authoritative successful result text after progress and tools when the final assistant event is lost", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "progress", content: [
      { type: "text", text: "I will inspect the file." },
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "file.ts" } },
    ] } });
    const result = { type: "result", subtype: "success", is_error: false, result: "The file is correct.", usage: { input_tokens: 10, output_tokens: 5 } };
    send(result);
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages.map((message) => [message.id, message.text, message.phase])).toEqual([
      ["progress", "I will inspect the file.", undefined],
      ["claude-result-turn-1", "The file is correct.", "final"],
    ]);
    const presentation = compactActivityPresentation([
      ...task.messages.map((value) => ({ kind: "message" as const, value })),
      ...task.activities.map((value) => ({ kind: "activity" as const, value })),
    ].sort((left, right) => (left.value.timelineOrder ?? 0) - (right.value.timelineOrder ?? 0)), { running: false });
    expect(presentation.filter((entry) => entry.kind === "message").map((entry) => entry.value.text)).toEqual(["The file is correct."]);
    expect(presentation.some((entry) => entry.kind === "work" && entry.value.some((item) => item.kind === "message" && item.value.id === "progress"))).toBe(true);
    const usage = task.usage;
    const totals = usageTotals();
    send(result);
    expect(useTaskStore.getState().tasks["thread-1"].messages).toEqual(task.messages);
    expect(useTaskStore.getState().tasks["thread-1"].usage).toEqual(usage);
    expect(usageTotals()).toEqual(totals);
    const saved = JSON.parse(JSON.stringify(task.messages));
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", saved, []);
    expect(useTaskStore.getState().tasks["thread-1"].messages.at(-1)).toMatchObject({ phase: "final", turnStatus: "completed" });
  });

  it("marks the matching last assistant as final without duplicating it", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "progress", content: [{ type: "text", text: "Checking" }] } });
    send({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: "Done" }] } });
    send({ type: "result", subtype: "success", result: "Done" });
    expect(useTaskStore.getState().tasks["thread-1"].messages.map((message) => [message.id, message.phase])).toEqual([
      ["progress", undefined], ["answer", "final"],
    ]);
  });

  it.each([
    { subtype: "error_during_execution", is_error: true, result: "Tool failed" },
    { subtype: "interrupted", result: "Stopped" },
    { subtype: "success", result: { text: "Not a string result" } },
  ])("does not manufacture final text for $subtype with an untrusted result", (result) => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "progress", content: [{ type: "text", text: "Checking" }] } });
    send({ type: "result", ...result });
    expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(1);
    expect(useTaskStore.getState().tasks["thread-1"].messages[0].phase).toBeUndefined();
  });

  it.each([
    ["Read", "research"], ["Glob", "research"], ["Grep", "research"], ["WebSearch", "research"], ["WebFetch", "research"],
    ["Write", "files"], ["Edit", "files"], ["NotebookEdit", "files"], ["Bash", "commands"],
  ])("attributes %s using the actual tool identity and retains it through result/reload", (name, workType) => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "tool-message", content: [{ type: "tool_use", id: "tool", name,
      input: { file_path: "/project/ResearchCommands.ts", command: "npm test" } }] } });
    const activity = useTaskStore.getState().tasks["thread-1"].activities[0];
    expect(activity).toMatchObject({ workType, status: "inProgress" });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] } });
    send({ type: "result", subtype: "success", result: "" });
    const snapshot = JSON.parse(JSON.stringify(useTaskStore.getState().tasks["thread-1"].activities));
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", [], snapshot);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({ workType, status: "completed" });
  });

  it("keeps tool-separated assistant messages phase-unknown until the successful result identifies the answer", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "progress", content: [
      { type: "text", text: "I will inspect the file." },
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "file.ts" } },
    ] } });
    expect(useTaskStore.getState().tasks["thread-1"].messages[0]).toMatchObject({ text: "I will inspect the file.", streaming: false });
    expect(useTaskStore.getState().tasks["thread-1"].messages[0].phase).toBeUndefined();
    send({ type: "assistant", message: { id: "answer", content: [{ type: "text", text: "The file is correct." }] } });
    send({ type: "result", subtype: "success", is_error: false, result: "The file is correct." });
    const messages = useTaskStore.getState().tasks["thread-1"].messages;
    expect(messages.map((message) => [message.id, message.phase, message.turnStatus])).toEqual([
      ["progress", undefined, "completed"], ["answer", "final", "completed"],
    ]);
  });

  it("keeps a partial result remainder unpriced even when modelUsage has complete-looking cache zeros", () => {
    send({ type: "assistant", message: { id: "complete", model: "claude-sonnet-5", content: [], usage: {
      input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    } } });
    send({ type: "result", subtype: "success", usage: { output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { "claude-sonnet-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
    expect(usageTotals()).toMatchObject({ totalTokens: 30, pricedTokens: 20, unpricedTokens: 10 });
    expect(useTaskStore.getState().tasks["thread-1"].usage?.tokenAvailability).toBe("partial");
  });

  it("forwards structured subscription usage without putting it in the timeline", () => {
    const onRateLimits = vi.fn();
    routeClaudeEvent({
      threadId: "thread-1",
      turnId: "turn-1",
      message: {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.42, resetsAt: 4567 },
      },
    }, { ...context, onRateLimits });

    expect(onRateLimits).toHaveBeenCalledWith({
      windows: [{ label: "Weekly", usedPercent: 42, resetsAt: 4567 }],
    });
    expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(0);
  });

  it("accepts tools and streamed text after an allowed grace event until the successful result", () => {
    const invoke = vi.mocked(tauri.invoke);
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    const info = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 1, rateLimitGraceActive: true };
    send({ type: "rate_limit_event", rate_limit_info: info });
    send({ type: "rate_limit_event", rate_limit_info: info });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("running");
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toMatchObject({ kind: "grace", turnId: "turn-1" });
    expect(useTaskStore.getState().tasks["thread-1"].activities.filter((row) => row.id.startsWith("claude-continuation"))).toHaveLength(1);
    expect(useTaskStore.getState().tasks["thread-1"].activities.find((row) => row.id.startsWith("claude-continuation"))?.detail).toContain("counts toward your weekly usage");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "wrap-up-tools" } } });
    send({ type: "stream_event", event: {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "wrap-up-read", name: "Read" },
    } });
    send({ type: "stream_event", event: {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/project/file.ts"}' },
    } });
    send({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    send({ type: "user", message: { content: [{
      type: "tool_result", tool_use_id: "wrap-up-read", content: "The file contains the completed change.",
    }] } });
    send({ type: "stream_event", event: { type: "message_start", message: { id: "wrap-up-answer" } } });
    send({ type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The change is complete." },
    } });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ status: "running", activeTurnId: "turn-1" });
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]?.kind).toBe("grace");

    // Leave the final delta queued: the terminal boundary must flush it.
    send({ type: "result", subtype: "success", is_error: false, result: "The change is complete." });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ status: "completed", lastCompletedTurnId: "turn-1", lastCompletedTurnStatus: "completed" });
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages).toEqual([expect.objectContaining({
      id: "wrap-up-answer", text: "The change is complete.", turnId: "turn-1", turnStatus: "completed", streaming: false,
    })]);
    expect(task.activities).toContainEqual(expect.objectContaining({
      id: "wrap-up-read", status: "completed", detail: "The file contains the completed change.", turnStatus: "completed",
    }));
    expect(context.onTurnCompleted).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenLastCalledWith("Ready");
    expect(context.onStatus).not.toHaveBeenCalledWith("Stopped");
    expect(invoke.mock.calls.filter(([command]) => command.startsWith("claude_"))).toEqual([]);
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
  });

  it("preserves partial output when rejection retains the grace flag and the turn ends in an error", () => {
    const invoke = vi.mocked(tauri.invoke);
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } });
    send({ type: "assistant", message: { id: "partial-tool", content: [{
      type: "tool_use", id: "partial-read", name: "Read", input: { file_path: "/tmp/project/file.ts" },
    }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "partial-read", content: "Existing source." }] } });
    send({ type: "stream_event", event: { type: "message_start", message: { id: "partial-answer" } } });
    send({ type: "stream_event", event: {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I inspected the source, but" },
    } });
    send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitGraceActive: true } });
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ status: "running", activeTurnId: "turn-1" });
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();

    const failure = { type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your limit." };
    send(failure);
    // A duplicate terminal event must not restart or complete the turn twice.
    send(failure);
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ status: "error", error: "You've hit your limit.", lastCompletedTurnStatus: "error" });
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages).toEqual([expect.objectContaining({
      id: "partial-answer", text: "I inspected the source, but", turnStatus: "failed", streaming: false,
    })]);
    expect(task.activities).toContainEqual(expect.objectContaining({
      id: "partial-read", detail: "Existing source.", status: "completed", turnStatus: "failed",
    }));
    expect(context.onError).toHaveBeenCalledExactlyOnceWith("You've hit your limit.");
    expect(context.onTurnCompleted).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(context.onStatus).toHaveBeenLastCalledWith("Task failed");
    expect(context.onStatus).not.toHaveBeenCalledWith("Stopped");
    expect(invoke.mock.calls.filter(([command]) => command.startsWith("claude_"))).toEqual([]);
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
  });

  it("distinguishes paid credits and clears the notice when a request is rejected", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", overageInUse: true } });
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]?.kind).toBe("paid");
    send({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitGraceActive: true, overageInUse: true } });
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
  });

  it.each(["grace", "paid"])("recovers result text after a %s notice when the assistant event was lost", (kind) => {
    send({ type: "system", subtype: "init" });
    send({ type: "rate_limit_event", rate_limit_info: {
      status: "allowed", ...(kind === "grace" ? { rateLimitGraceActive: true } : { overageInUse: true }),
    } });
    send({ type: "result", subtype: "success", result: "The requested changes are complete." });
    expect(useTaskStore.getState().tasks["thread-1"].messages).toContainEqual(expect.objectContaining({
      role: "assistant", text: "The requested changes are complete.", turnId: "turn-1",
    }));
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
  });

  it("reports a notice-only empty success instead of claiming Claude responded", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } });
    send({ type: "result", subtype: "success", result: "" });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({
      status: "error", lastCompletedTurnStatus: "error",
    });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toContainEqual(expect.objectContaining({
      id: "claude-empty-result-turn-1", status: "failed",
    }));
  });

  it("preserves tool-only success when its final activity is an allowance notice", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "assistant", message: { id: "tool-message", content: [{
      type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/project/file.ts" },
    }] } });
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } });
    send({ type: "result", subtype: "success", result: "" });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("completed");
    expect(useTaskStore.getState().tasks["thread-1"].activities.find((row) => row.id === "claude-empty-result-turn-1")).toBeUndefined();
  });

  it("keeps the wrap-up notice through streaming and a same-turn init, retiring only another turn's notice", () => {
    useClaudeContinuationStore.getState().update("thread-1", "old-turn", { kind: "grace" });
    send({ type: "system", subtype: "init" });
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitGraceActive: true } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still working" } } });
    send({ type: "system", subtype: "init" });
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toMatchObject({ kind: "grace", turnId: "turn-1" });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("running");
  });

  it("ignores old-turn telemetry after a newer turn starts", () => {
    send({ type: "system", subtype: "init" }, "new-turn");
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } }, "turn-1");
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
    send({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitGraceActive: true } }, "new-turn");
    send({ type: "openkiwi_exit", message: "process ended" }, "new-turn");
    expect(useClaudeContinuationStore.getState().byThread["thread-1"]).toBeUndefined();
  });

  it("streams thinking and answer text into the compact timeline", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Checking files" },
      },
    });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Done." },
      },
    });
    expect(context.onTranscriptChanged).toHaveBeenCalledWith("thread-1");
    useTaskStore.getState().flushDeltas();

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0]).toMatchObject({
      id: "message-1",
      text: "Done.",
      streaming: true,
    });
    expect(task.activities[0]).toMatchObject({
      id: "thinking-turn-1",
      kind: "reasoning",
      detail: "Checking files",
    });
  });

  it("routes Claude questions without answering them and removes cancelled requests", () => {
    send({ type: "control_request", request_id: "question-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which layout?" }] } } });
    expect(useTaskStore.getState().tasks["thread-1"].approvals[0]).toMatchObject({ params: { tool_name: "AskUserQuestion", input: { questions: [{ question: "Which layout?" }] } } });
    send({ type: "control_cancel_request", request_id: "question-1" });
    expect(useTaskStore.getState().tasks["thread-1"].approvals).toEqual([]);
  });

  it("turns Claude permission callbacks into normal Mythra Code approvals", () => {
    send({
      type: "control_request",
      request_id: "request-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "npm test" },
        permission_suggestions: [{ type: "addRules" }],
      },
    });
    expect(
      useTaskStore.getState().tasks["thread-1"].approvals[0],
    ).toMatchObject({
      id: "request-1",
      method: "claude/can_use_tool",
      threadId: "thread-1",
    });
    expect(context.onApprovalRequested).toHaveBeenCalledWith("thread-1");
  });

  it("keeps Claude spawn identity when its tool result completes", () => {
    send({
      type: "assistant",
      message: {
        id: "message-1",
        content: [{
          type: "tool_use",
          id: "spawn-1",
          name: "Task",
          input: {
            description: "Audit the Rust bridge",
            prompt: "Inspect the bridge and report risks.",
            model: "opus",
          },
        }],
      },
    });
    expect(useTaskStore.getState().tasks["thread-1"].agents[0].model).toBeUndefined();
    send({ type: "assistant", parent_tool_use_id: "spawn-1", message: { id: "child-model", model: "claude-opus-5", content: [] } });
    send({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "spawn-1", content: "Audit complete" }],
      },
    });

    expect(useTaskStore.getState().tasks["thread-1"].activities[0]).toMatchObject({
      id: "spawn-1",
      kind: "agent",
      status: "completed",
      detail: "Audit complete",
      agent: {
        action: "spawn",
        provider: "claude",
        model: "claude-opus-5",
        task: "Inspect the bridge and report risks.",
        count: 1,
      },
    });
  });

  it("completes the turn after final output", () => {
    send({
      type: "assistant",
      message: {
        id: "message-1",
        content: [{ type: "text", text: "Finished" }],
      },
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, output_tokens: 8 },
    });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0]).toMatchObject({
      text: "Finished",
      streaming: false,
    });
    expect(task.status).toBe("completed");
    expect(task.usage).toMatchObject({
      totalTokens: 27,
      inputTokens: 19,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      outputTokens: 8,
    });
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");
  });

  it("surfaces a successful Claude result that produced no response", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "result", subtype: "success", is_error: false, result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({
      status: "error",
      lastCompletedTurnId: "turn-1",
      lastCompletedTurnStatus: "error",
      error: expect.stringContaining("finished without returning a response"),
    });
    expect(task.activities).toMatchObject([{
      id: "claude-empty-result-turn-1",
      kind: "warning",
      title: "Claude Code returned no response",
      status: "failed",
      turnId: "turn-1",
      turnStatus: "failed",
    }]);
    expect(context.onError).toHaveBeenCalledWith(expect.stringContaining("Your prompt was saved"));
    expect(context.onStatus).toHaveBeenCalledWith("Task failed");
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");

    send({ type: "result", subtype: "success", is_error: false, result: "" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(1);
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);

    const savedMessages = JSON.parse(JSON.stringify(task.messages));
    const savedActivities = JSON.parse(JSON.stringify(task.activities));
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread-1", savedMessages, savedActivities);
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{
      id: "claude-empty-result-turn-1",
      turnStatus: "failed",
    }]);
  });

  it("recovers result text when Claude's assistant event was lost", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "result", subtype: "success", is_error: false, result: "Recovered answer" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.messages).toMatchObject([{
      id: "claude-result-turn-1",
      role: "assistant",
      text: "Recovered answer",
      turnId: "turn-1",
      turnStatus: "completed",
    }]);
    expect(task.activities).toHaveLength(0);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("does not duplicate assistant text repeated in the result payload", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: { id: "message-1", content: [{ type: "text", text: "One answer" }] },
    });
    send({ type: "result", subtype: "success", result: "One answer" });

    expect(useTaskStore.getState().tasks["thread-1"].messages).toMatchObject([{
      id: "message-1",
      text: "One answer",
      turnStatus: "completed",
    }]);
    expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(1);
  });

  it("accepts a tool-only Claude turn as meaningful output", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: {
        id: "tool-only-message",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } }],
      },
    });
    send({ type: "result", subtype: "success", is_error: false, result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      id: "tool-1",
      kind: "command",
      title: "/tmp/a",
      turnStatus: "completed",
    }]);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("does not mistake an unrendered thinking-only message for a visible response", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: {
        id: "thinking-only-message",
        content: [{ type: "thinking", thinking: "Internal thought" }],
      },
    });
    send({ type: "result", subtype: "success", is_error: false, result: "   " });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("error");
    expect(task.messages).toHaveLength(0);
    expect(task.activities[0].title).toBe("Claude Code returned no response");
    expect(context.onError).toHaveBeenCalledOnce();
  });

  it("accepts a streamed reasoning-only turn because its activity is visible", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Visible reasoning" },
      },
    });
    send({ type: "result", subtype: "success", result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      kind: "reasoning",
      detail: "Visible reasoning",
      turnStatus: "completed",
    }]);
    expect(task.activities.find((entry) => entry.kind === "warning")).toBeUndefined();
  });

  it("keeps empty-result detection isolated between concurrent threads", () => {
    send({ type: "system", subtype: "init" });
    send({
      type: "assistant",
      message: { id: "message-1", content: [{ type: "text", text: "Thread one answer" }] },
    });
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "system", subtype: "init" } },
      context,
    );
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "result", subtype: "success", result: "" } },
      context,
    );

    expect(useTaskStore.getState().tasks["thread-2"].status).toBe("error");
    expect(useTaskStore.getState().tasks["thread-2"].activities[0].title).toBe("Claude Code returned no response");
    send({ type: "result", subtype: "success", result: "" });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("completed");
    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(0);
  });

  it("recovers result text without overwriting a prior turn after a delayed result", () => {
    send({ type: "system", subtype: "init" }, "turn-a");
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-a" } },
    }, "turn-a");
    send({
      type: "assistant",
      message: { id: "message-a", content: [{ type: "text", text: "Answer A" }] },
    }, "turn-a");

    send({ type: "system", subtype: "init" }, "turn-b");
    send({ type: "result", subtype: "success", result: "" }, "turn-a");
    send({ type: "result", subtype: "success", result: "Recovered B" }, "turn-b");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.messages).toMatchObject([
      { id: "message-a", text: "Answer A", turnId: "turn-a" },
      { id: "claude-result-turn-b", text: "Recovered B", turnId: "turn-b", turnStatus: "completed" },
    ]);
  });

  it("accepts a compaction-only Claude turn as visible output", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start-1" });
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 1234 },
    });
    send({ type: "result", subtype: "success", result: "" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activities).toMatchObject([{
      kind: "compaction",
      status: "completed",
      turnStatus: "completed",
    }]);
    expect(context.onError).not.toHaveBeenCalled();
  });

  it("ignores late output from a completed Claude process", () => {
    useTaskStore.getState().setActiveTurn("thread-1", "turn-old");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    send({
      type: "assistant",
      message: { id: "old-final", content: [{ type: "text", text: "Finished" }] },
    }, "turn-old");
    send({ type: "result", subtype: "success", is_error: false }, "turn-old");

    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "late-message" } },
    }, "turn-old");
    send({
      type: "assistant",
      message: { id: "late-message", content: [{ type: "text", text: "Late output" }] },
    }, "turn-old");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("completed");
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages.map((message) => message.text)).toEqual(["Finished"]);
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it("does not let an older Claude process replace a newer active turn", () => {
    useTaskStore.getState().setActiveTurn("thread-1", "turn-new");
    useTaskStore.getState().setTaskStatus("thread-1", "running");

    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "old-message" } },
    }, "turn-old");
    send({ type: "result", subtype: "success", is_error: false }, "turn-old");

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("running");
    expect(task.activeTurnId).toBe("turn-new");
    expect(task.messages).toEqual([]);
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onStatus).not.toHaveBeenCalledWith("Ready");
  });

  it("keeps accumulating input and output usage across Claude runs", () => {
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
    }, "turn-1");
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 80, cache_read_input_tokens: 10, output_tokens: 45 },
    }, "turn-2");

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      totalTokens: 285,
      inputTokens: 210,
      cachedInputTokens: 30,
      outputTokens: 75,
    });
  });

  it("counts assistant usage once when the final result repeats the turn total", () => {
    send({
      type: "assistant",
      message: {
        id: "message-usage",
        content: [{ type: "text", text: "Working" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
      },
    });
    send({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 30 },
    });

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      totalTokens: 150,
    });
  });

  it("retains usage from an interrupted run even when no result usage arrives", () => {
    send({
      type: "assistant",
      message: {
        id: "message-interrupted",
        content: [{ type: "text", text: "Partial work" }],
        usage: { input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 15 },
      },
    }, "turn-interrupted");

    expect(useTaskStore.getState().tasks["thread-1"].usage).toMatchObject({
      inputTokens: 80,
      cacheWriteInputTokens: 10,
      outputTokens: 15,
      totalTokens: 95,
    });
  });

  it("does not turn a user interruption into a failed or completed task", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    useTaskStore.getState().completeTurn("thread-1", "turn-1", "interrupted");
    vi.clearAllMocks();
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Interrupted by user",
    });

    expect(useTaskStore.getState().tasks["thread-1"].status).toBe(
      "interrupted",
    );
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).not.toHaveBeenCalled();
  });

  it("honors explicit stop intent when exit races ahead of the stopped status write", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "openkiwi_exit", message: "process ended during kill" });

    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("interrupted");
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenCalledWith("Stopped");
  });

  it("honors explicit stop intent when Claude synthesizes an empty recovery success", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "system", subtype: "init" });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "result", subtype: "success", is_error: false, result: "", openkiwi_recovered_from_assistant_end_turn: true });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("interrupted");
    expect(task.activities).toHaveLength(0);
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.onStatus).toHaveBeenCalledWith("Stopped");
  });

  it.each([
    { subtype: "success", is_error: false, result: "Authoritative answer", expected: "completed" },
    { subtype: "error_during_execution", is_error: true, result: "Provider failed", expected: "error" },
  ])("keeps a genuine $expected result arriving before Stop seals the turn", ({ expected, ...message }) => {
    send({ type: "system", subtype: "init" });
    markProviderStopIntent("thread-1", "turn-1");
    send({ type: "result", ...message });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe(expected);
    if (expected === "completed") expect(task.messages).toContainEqual(expect.objectContaining({ text: "Authoritative answer", phase: "final", turnStatus: "completed" }));
  });

  it("keeps an exact confirmed cutoff interrupted when genuine output arrives later", () => {
    send({ type: "system", subtype: "init" });
    useTaskStore.getState().completeTurn("thread-1", "turn-1", "interrupted");
    send({ type: "result", subtype: "success", result: "Late final answer" });
    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({ status: "interrupted", lastCompletedTurnStatus: "interrupted", messages: [] });
  });

  it("does not mistake another turn's interrupted status for this genuine result", () => {
    send({ type: "system", subtype: "init" });
    useTaskStore.getState().completeTurn("thread-1", "older-turn", "interrupted");
    useTaskStore.getState().setTaskStatus("thread-1", "interrupted");
    send({ type: "result", subtype: "success", result: "Actual answer" });
    expect(useTaskStore.getState().tasks["thread-1"].status).toBe("completed");
  });

  it("does not disguise a recovered provider exit as a user stop", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    useTaskStore.getState().setTaskStatus("thread-1", "interrupted");
    send({ type: "openkiwi_exit", message: "MCP request ended unexpectedly" });

    expect(useTaskStore.getState().tasks["thread-1"]).toMatchObject({
      status: "error",
      error: "MCP request ended unexpectedly",
    });
    expect(context.onError).toHaveBeenCalledWith("MCP request ended unexpectedly");
    expect(context.onStatus).toHaveBeenCalledWith("Task failed");
  });

  it("does not let a background thread overwrite the foreground status", () => {
    useTaskStore.getState().ensureTask("foreground");
    useTaskStore.getState().setActiveThread("foreground");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });

    expect(context.onStatus).not.toHaveBeenCalled();
  });

  it("closes a running task when Claude exits without a result", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "openkiwi_exit",
      code: 1,
      message: "Authentication expired",
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.status).toBe("error");
    expect(task.error).toBe("Authentication expired");
    expect(task.activities.at(-1)).toMatchObject({
      title: "Claude Code stopped unexpectedly",
      status: "failed",
    });
    expect(context.onTurnCompleted).toHaveBeenCalledWith("thread-1");
  });

  it("marks a Claude compact boundary in place and asks for a transcript save", () => {
    send({
      type: "stream_event",
      event: { type: "message_start", message: { id: "message-1" } },
    });
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 154_231 },
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-boundary-1",
      kind: "compaction",
      title: "Context compacted",
      detail: "Claude Code · Automatic · 154K tokens before",
      status: "completed",
      turnId: "turn-1",
    }]);
    expect(context.onTranscriptChanged).toHaveBeenCalledWith("thread-1");
    // Status-bar copy is Ready/Working only; compaction never speaks there.
    expect(context.onStatus).not.toHaveBeenCalledWith(expect.stringContaining("ompact"));
  });

  it("keeps a replayed boundary on one row and leaves the transcript intact", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } },
    });
    useTaskStore.getState().flushDeltas();
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "manual", pre_tokens: 900 },
    };
    send(boundary);
    send(boundary);

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toHaveLength(1);
    expect(task.activities[0].detail).toBe("Claude Code · Manual · 900 tokens before");
    expect(task.messages.map((message) => message.text)).toEqual(["Before"]);
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("places a compact boundary after earlier text even before the next frame flush", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } } });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 100 } });
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("animates a Claude compaction from the status message and never speaks in the status bar", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      kind: "compaction",
      title: "Compacting context",
      detail: "Claude Code",
      status: "inProgress",
      turnId: "turn-1",
    }]);
    expect(context.onTranscriptChanged).toHaveBeenCalledWith("thread-1");
    expect(context.onStatus).not.toHaveBeenCalledWith(expect.stringContaining("ompact"));
    expect(context.onStatus).toHaveBeenCalledWith("Working");
  });

  it("folds the boundary into the animating row instead of adding a second marker", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Before" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    const started = useTaskStore.getState().tasks["thread-1"].activities[0];
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 154_231 },
    });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Context compacted",
      detail: "Claude Code · Automatic · 154K tokens before",
      status: "completed",
      turnId: "turn-1",
    }]);
    expect(task.activities[0].timelineOrder).toBe(started.timelineOrder);
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("keeps a merged boundary deduplicated when it is replayed", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "auto", pre_tokens: 900 },
    };
    send(boundary);
    send(boundary);
    send({ type: "system", subtype: "status", status: null, uuid: "status-2" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toHaveLength(1);
    // The closing status is not evidence either way once the boundary landed.
    expect(task.activities[0]).toMatchObject({ id: "claude-compaction-status-1", status: "completed" });
  });

  it("stops the animation on a null status without claiming the compaction finished", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: null, uuid: "status-2" });

    const settled = useTaskStore.getState().tasks["thread-1"].activities;
    expect(settled).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Compaction ended",
      status: "unconfirmed",
    }]);

    // A boundary arriving after the close is still the proof of success, and
    // it belongs on the same row at the same timeline position.
    send({
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary-1",
      compact_metadata: { trigger: "manual", pre_tokens: 2_000 },
    });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      id: "claude-compaction-status-1",
      title: "Context compacted",
      detail: "Claude Code · Manual · 2.0K tokens before",
      status: "completed",
    }]);
    expect(task.activities[0].timelineOrder).toBe(settled[0].timelineOrder);
  });

  it("uses an explicit successful reset before the boundary without flashing a failure", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status: null, compact_result: "success", uuid: "end" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "completed", title: "Context compacted" }]);
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary", compact_metadata: { trigger: "manual", pre_tokens: 12320 } });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{
      id: "claude-compaction-start", status: "completed", detail: "Claude Code · Manual · 12K tokens before",
      compaction: { boundaryId: "boundary", endStatusId: "end" },
    }]);
  });

  it("binds the live turn when compaction begins before system/init", () => {
    useTaskStore.getState().setTaskStatus("thread-1", "starting");
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task).toMatchObject({ activeTurnId: "turn-1", status: "running" });
    useTaskStore.getState().hydrateTask("thread-1", [], task.activities);
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].status).toBe("inProgress");
  });

  it.each([{ compact_result: "failed" }, { compact_error: "too_few_groups" }])("honors an explicit failed reset: %j", (outcome) => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status: null, uuid: "end", ...outcome });
    send({ type: "system", subtype: "status", status: null, uuid: "later-reset" });
    send({ type: "result", subtype: "success" });
    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "failed" }]);
  });

  it("retains replay identities through a saved transcript reload while another compaction is active", () => {
    send({ type: "system", subtype: "init" });
    const start = { type: "system", subtype: "status", status: "compacting", uuid: "start" };
    const end = { type: "system", subtype: "status", status: null, compact_result: "success", uuid: "end" };
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary" };
    send(start); send(end); send(boundary);
    const saved = JSON.parse(JSON.stringify(useTaskStore.getState().tasks["thread-1"].activities));
    resetTaskStore(); resetClaudeEventUsageState();
    useTaskStore.getState().hydrateTask("thread-1", [], saved);
    useTaskStore.getState().setActiveTurn("thread-1", "turn-1");
    send({ ...start, uuid: "next-start" });
    send(start); send(end); send(boundary);
    expect(useTaskStore.getState().tasks["thread-1"].activities.map((entry) => entry.status)).toEqual(["completed", "inProgress"]);
  });

  it("does not overwrite a failed attempt with a later completion-only boundary", () => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "failed-start" });
    send({ type: "system", subtype: "status", status: null, compact_error: "failed", uuid: "failed-end" });
    send({ type: "system", subtype: "compact_boundary", uuid: "later-boundary" });
    expect(useTaskStore.getState().tasks["thread-1"].activities.map((entry) => entry.status)).toEqual(["failed", "completed"]);
  });

  it.each([undefined, "", "requesting"])("ignores malformed or unrelated status %s", (status) => {
    send({ type: "system", subtype: "init" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "start" });
    send({ type: "system", subtype: "status", status, uuid: "other" });
    expect(useTaskStore.getState().tasks["thread-1"].activities[0].status).toBe("inProgress");
  });

  it("gives each compaction in a turn its own row", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 1_000 } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-2" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-2", compact_metadata: { trigger: "auto", pre_tokens: 2_000 } });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities.map((activity) => activity.id)).toEqual([
      "claude-compaction-status-1",
      "claude-compaction-status-2",
    ]);
    expect(task.activities.map((activity) => activity.detail)).toEqual([
      "Claude Code · Automatic · 1.0K tokens before",
      "Claude Code · Automatic · 2.0K tokens before",
    ]);
  });

  it("repeats a start status onto the row it already opened", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-2" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{ id: "claude-compaction-status-1", status: "inProgress" }]);
  });

  it("does not let a completed turn promote an unfinished compaction", () => {
    useTaskStore.getState().setActiveThread("thread-1");
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "result", subtype: "success", usage: { input_tokens: 5, output_tokens: 5 } });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities).toMatchObject([{
      title: "Context compaction did not finish",
      status: "interrupted",
    }]);
    expect(task.status).toBe("completed");
    expect(context.onStatus).toHaveBeenCalledWith("Ready");
  });

  it("settles a compaction left animating by a provider exit", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "openkiwi_exit", code: 1, message: "Authentication expired" });

    const task = useTaskStore.getState().tasks["thread-1"];
    expect(task.activities[0]).toMatchObject({
      id: "claude-compaction-status-1",
      title: "Context compaction did not finish",
      status: "failed",
    });
  });

  it("ignores compaction events replayed after the turn is retired", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "Done" }] } });
    send({ type: "result", subtype: "success" });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-late" });
    send({ type: "system", subtype: "compact_boundary", uuid: "boundary-late", compact_metadata: { trigger: "auto", pre_tokens: 100 } });

    expect(useTaskStore.getState().tasks["thread-1"].activities).toHaveLength(0);
  });

  it("keeps one thread's compaction out of another thread's timeline", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    routeClaudeEvent(
      { threadId: "thread-2", turnId: "turn-2", message: { type: "stream_event", event: { type: "message_start", message: { id: "message-2" } } } },
      context,
    );
    routeClaudeEvent(
      {
        threadId: "thread-2",
        turnId: "turn-2",
        message: { type: "system", subtype: "compact_boundary", uuid: "boundary-1", compact_metadata: { trigger: "auto", pre_tokens: 300 } },
      },
      context,
    );

    const tasks = useTaskStore.getState().tasks;
    expect(tasks["thread-1"].activities).toMatchObject([{ id: "claude-compaction-status-1", status: "inProgress" }]);
    expect(tasks["thread-2"].activities).toMatchObject([{ id: "claude-compaction-boundary-1", status: "completed", turnId: "turn-2" }]);
  });

  it("leaves an unrecognised status message alone", () => {
    send({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
    send({ type: "system", subtype: "status", status: "compacting", uuid: "status-1" });
    send({ type: "system", subtype: "status", status: "some_future_phase", uuid: "status-2" });

    expect(useTaskStore.getState().tasks["thread-1"].activities).toMatchObject([{ status: "inProgress" }]);
  });

  it("answers unknown control requests with an error instead of stalling", () => {
    send({
      type: "control_request",
      request_id: "request-9",
      request: { subtype: "hook_callback", data: {} },
    });

    expect(context.onUnsupportedControlRequest).toHaveBeenCalledWith(
      "thread-1",
      "request-9",
      "hook_callback",
    );
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks["thread-1"].activities.at(-1)).toMatchObject({
      kind: "warning",
      title: "Unsupported Claude Code request",
    });
  });
});

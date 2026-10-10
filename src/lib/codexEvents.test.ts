import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_THREAD_ID, decodeBase64Utf8, routeCodexEvent, runtimeMessage, type CodexEventContext } from "./codexEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { openRouterReportedCost, usageTotals } from "./usageLedger";
import { latestCompactActivity, compactActivityPresentation } from "./compactActivity";
import { usedSkillsForRun } from "./skillUsage";

function makeContext(overrides: Partial<CodexEventContext> = {}): CodexEventContext {
  return {
    bindingFor: () => undefined,
    providerFor: () => "openai",
    respond: vi.fn(async () => {}),
    audit: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onAuthRequired: vi.fn(),
    onAuthSuspected: vi.fn(),
    onRateLimits: vi.fn(),
    onTerminalOutput: vi.fn(),
    onTurnCompleted: vi.fn(),
    onApprovalRequested: vi.fn(),
    onAccountUpdated: vi.fn(),
    onLoginFailed: vi.fn(),
    onProviderToolCompatibilityError: vi.fn(),
    onNativeAgentDiscovered: vi.fn(),
    ...overrides,
  };
}

describe("routeCodexEvent", () => {
  beforeEach(() => { localStorage.clear(); resetTaskStore(); });

  it("enriches a lifecycle-first child from its authoritative spawn assignment", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "root", turn: { id: "current" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "current", item: { id: "lifecycle", type: "subAgentActivity", kind: "started", agentThreadId: "child" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "current", item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "The actual assignment", model: "requested-model", receiverThreadIds: ["child"], agentsStates: { child: { status: "inProgress" } } } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "The actual assignment", task: "The actual assignment", requestedModel: "requested-model", activationId: "spawn" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "older", item: { id: "older-spawn", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "Old assignment", model: "old-model", receiverThreadIds: ["child"], agentsStates: { child: { status: "inProgress" } } } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "The actual assignment", task: "The actual assignment", requestedModel: "requested-model", activationId: "spawn" });
  });

  it("does not refill a newer activation from an unrelated late spawn with a matching status", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "unseen-old-spawn", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "Old assignment", model: "old-requested", receiverThreadIds: ["child"], agentsStates: { child: { status: "starting", model: "old-model", message: "Old progress" } } } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Fresh task", activationId: "fresh", model: "", requestedModel: "", progress: "", result: "" });
  });

  it("clears finished readout when a native child's own conversation starts a fresh turn", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.upsertAgent("root", { id: "child", prompt: "Old assignment", task: "Old assignment", status: "completed", runtime: "codex", activationId: "spawn", model: "old-model", modelSource: "execution", requestedModel: "old-requested", progress: "Old progress", result: "Old result" });
    store.setActiveTurn("child", "old-child-turn");
    store.completeTurn("child", "old-child-turn", "completed");
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "old-child-turn" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("Old result");
    expect(useTaskStore.getState().statuses.child).toBe("completed");
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "fresh-child-turn" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "Task not reported", task: "", status: "inProgress", activationId: "turn:fresh-child-turn", requestedModel: "", model: "", progress: "", result: "" });
    expect(useTaskStore.getState().tasks.root.agents[0].modelSource).toBeUndefined();
    expect(ctx.onNativeAgentDiscovered).toHaveBeenLastCalledWith("root", "child", expect.objectContaining({ prompt: "Task not reported", activationId: "turn:fresh-child-turn", result: "", model: "", activatedAt: expect.any(Number) }));
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "fresh-child-turn", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Fresh result" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("Fresh result");
    expect(useTaskStore.getState().tasks.root.messages).toHaveLength(0);
    routeCodexEvent({ method: "turn/completed", params: { threadId: "child", turn: { id: "fresh-child-turn", status: "completed" } } }, ctx);
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "old-child-turn" } } }, ctx);
    expect(useTaskStore.getState().statuses.child).toBe("completed");
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ result: "Fresh result", activationId: "turn:fresh-child-turn" });
  });

  it("keeps a native child's fresh assigned readout when its turn identity arrives", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.upsertAgent("root", { id: "child", prompt: "Assigned work", task: "Assigned work", status: "starting", runtime: "codex", activationId: "fresh-spawn", requestedModel: "fresh-requested" });
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Assigned work", prompt: "Assigned work", requestedModel: "fresh-requested", activationId: "fresh-spawn", status: "inProgress" });
  });

  it.each(["starting", "running"] as const)("does not settle a %s native activation from an old completion before its new turn starts", (status) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.setActiveTurn("child", "old-child-turn");
    store.completeTurn("child", "old-child-turn", "completed");
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    store.setTaskStatus("child", status);
    routeCodexEvent({ method: "turn/completed", params: { threadId: "child", turn: { id: "old-child-turn", status: "completed" } } }, ctx);
    expect(useTaskStore.getState().statuses.child).toBe(status);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "Fresh task", status: "starting", activationId: "fresh" });
    expect(ctx.onTurnCompleted).not.toHaveBeenCalled();
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "old-child-turn" } } }, ctx);
    expect(useTaskStore.getState().tasks.child.activeTurnId).toBeUndefined();
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "fresh-child-turn" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "fresh-child-turn", item: { id: "fresh-answer", type: "agentMessage", phase: "final_answer", text: "Fresh result" } } }, ctx);
    routeCodexEvent({ method: "turn/completed", params: { threadId: "child", turn: { id: "fresh-child-turn", status: "completed" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ status: "completed", result: "Fresh result" });
    expect(ctx.onTurnCompleted).toHaveBeenCalledOnce();
  });

  it.each([undefined, ""])("does not treat a provider completion with turn id %j as a pending native activation's hard cutoff", (id) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.beginNativeActivation("child", "fresh");
    store.setTaskStatus("child", "starting");
    routeCodexEvent({ method: "turn/completed", params: { threadId: "child", turn: { id, status: "completed" } } }, ctx);
    expect(useTaskStore.getState().tasks.child).toMatchObject({ status: "starting", pendingNativeActivationId: "fresh" });
    expect(ctx.onTurnCompleted).not.toHaveBeenCalled();
  });

  it("retains the activation fence across an uncorrelated idle notification and retired final output", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.setActiveTurn("child", "old-child-turn");
    store.completeTurn("child", "old-child-turn", "completed");
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "child", status: { type: "idle" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "old-child-turn", item: { id: "old-answer", type: "agentMessage", phase: "final_answer", text: "Old result" } } }, ctx);
    expect(useTaskStore.getState().tasks.child).toMatchObject({ status: "starting", pendingNativeActivationId: "fresh" });
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Fresh task", progress: "", result: "" });
    routeCodexEvent({ method: "turn/started", params: { threadId: "child", turn: { id: "fresh-child-turn" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "fresh-child-turn", item: { id: "fresh-answer", type: "agentMessage", phase: "final_answer", text: "Fresh result" } } }, ctx);
    routeCodexEvent({ method: "turn/completed", params: { threadId: "child", turn: { id: "fresh-child-turn", status: "completed" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "old-child-turn", item: { id: "old-answer-replay", type: "agentMessage", phase: "final_answer", text: "Old result replay" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("Fresh result");
  });

  it("settles a pending activation from a wait that started for that exact activation", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    routeCodexEvent({ method: "turn/started", params: { threadId: "root", turn: { id: "root-turn" } } }, ctx);
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh-wait", type: "collabAgentToolCall", tool: "wait" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh-wait", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Fresh result" } } } } }, ctx);
    expect(useTaskStore.getState().statuses.child).toBe("completed");
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Fresh task", status: "completed", result: "Fresh result", activationId: "fresh" });
    expect(ctx.onTurnCompleted).toHaveBeenCalledWith("child", null);
  });

  it("cannot settle a fresh activation from a wait started before its activation", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    routeCodexEvent({ method: "turn/started", params: { threadId: "root", turn: { id: "root-turn" } } }, ctx);
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    routeCodexEvent({ method: "item/started", params: { threadId: "root", turnId: "root-turn", item: { id: "old-wait", type: "collabAgentToolCall", tool: "wait" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "old-wait", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Old result" } } } } }, ctx);
    expect(useTaskStore.getState().statuses.child).toBe("starting");
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Fresh task", status: "starting", result: "", activationId: "fresh" });
    expect(ctx.onTurnCompleted).not.toHaveBeenCalled();
  });

  it.each(["activation", "root-turn", "replayed-start"])("does not reuse a wait snapshot across %s changes", (change) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    const emit = (id: string, tool: string, lifecycle: "started" | "completed", turnId = "root-turn", report = false) => routeCodexEvent({ method: `item/${lifecycle}`, params: { threadId: "root", turnId, item: { id, type: "collabAgentToolCall", tool, prompt: "Fresh assignment", receiverThreadIds: ["child"], ...(report ? { agentsStates: { child: { status: "completed", message: "Stale result" } } } : {}) } } }, ctx);
    routeCodexEvent({ method: "turn/started", params: { threadId: "root", turn: { id: "root-turn" } } }, ctx);
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old" });
    emit("activation-1", "followupTask", "completed");
    emit("wait", "wait", "started");
    if (change === "activation") emit("activation-2", "followupTask", "completed");
    if (change === "root-turn") routeCodexEvent({ method: "turn/started", params: { threadId: "root", turn: { id: "root-turn-2" } } }, ctx);
    if (change === "replayed-start") {
      emit("wait", "wait", "completed", "root-turn", true);
      emit("activation-2", "followupTask", "completed");
      emit("wait", "wait", "started");
    }
    emit("wait", "wait", "completed", "root-turn", true);
    expect(useTaskStore.getState().statuses.child).toBe("starting");
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("");
    if (change !== "root-turn") {
      emit("fresh-wait", "wait", "started");
      emit("fresh-wait", "wait", "completed", "root-turn", true);
      expect(useTaskStore.getState().statuses.child).toBe("completed");
    }
  });

  it("settles a pending native activation on a real provider system error", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.beginNativeActivation("child", "fresh");
    store.setTaskStatus("child", "starting");
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "child", status: { type: "systemError" } } }, ctx);
    expect(useTaskStore.getState().statuses.child).toBe("error");
    expect(useTaskStore.getState().tasks.child.pendingNativeActivationId).toBeUndefined();
  });

  it("preserves assignments across native lifecycle and passive snapshots, separating requested and configured models", () => {
    const ctx = makeContext();
    const emit = (item: Record<string, unknown>, lifecycle = "completed") => routeCodexEvent({ method: `item/${lifecycle}`, params: { threadId: "root", turnId: "root-turn", item } }, ctx);
    emit({ id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "Audit actual ownership", model: "requested-model", receiverThreadIds: ["child"], agentsStates: { child: { status: "running", message: "Reviewing event adapters" } } });
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "Audit actual ownership", requestedModel: "requested-model", progress: "Reviewing event adapters" });
    expect(useTaskStore.getState().tasks.root.agents[0].model).toBeUndefined();
    emit({ id: "native", type: "subAgentActivity", kind: "started", agentThreadId: "child", agentPath: "0/1" });
    emit({ id: "wait", type: "collabAgentToolCall", tool: "wait", agentsStates: { child: { status: "running" } }, receiverThreadIds: [] });
    routeCodexEvent({ method: "thread/started", params: { thread: { id: "child", model: "actual-configured" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "Audit actual ownership", task: "Audit actual ownership", requestedModel: "requested-model", model: "actual-configured", modelSource: "configured" });
    routeCodexEvent({ method: "thread/settings/updated", params: { threadId: "child", threadSettings: { model: "new-configured" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "child-turn", item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "Actual child result" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ model: "new-configured", result: "Actual child result", progress: "Actual child result" });
    expect(useTaskStore.getState().tasks.root.messages).toHaveLength(0);
    expect(useTaskStore.getState().tasks.root.agents).toHaveLength(1);
  });

  it("clears old result on a new native activation but preserves it through passive events", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "turn");
    store.upsertAgent("root", { id: "child", prompt: "Old task", task: "Old task", status: "completed", runtime: "codex", result: "Old result", progress: "Old progress", activationId: "old", requestedModel: "current-requested", model: "current-configured" });
    store.upsertActivity("root", { id: "old", kind: "agent", title: "Spawn", turnId: "turn", agent: { action: "spawn", threadIds: ["child"] } });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { id: "new", type: "collabAgentToolCall", tool: "followupTask", prompt: "New task", receiverThreadIds: ["child"] } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ task: "New task", result: "", progress: "", activationId: "new", status: "starting" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "old-turn", item: { id: "late-old-answer", type: "agentMessage", phase: "final_answer", text: "Old result replay" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("");
    store.setTaskStatus("child", "running");
    routeCodexEvent({ method: "item/completed", params: { threadId: "child", turnId: "old-turn", item: { id: "late-old-running-answer", type: "agentMessage", phase: "final_answer", text: "Old result replay while running" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0].result).toBe("");
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { id: "wait", type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed", message: "Old result replay", model: "old-model" } } } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { id: "old", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "Old task", model: "old-requested", receiverThreadIds: ["child"], agentsStates: { child: { status: "running", message: "Old progress replay", model: "old-model" } } } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ prompt: "New task", task: "New task", activationId: "new", result: "", progress: "", requestedModel: "", model: "" });
  });

  it("does not carry previous activation model evidence into a fresh native followup", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.upsertAgent("root", { id: "child", prompt: "Old task", status: "completed", runtime: "codex", activationId: "old", model: "old-executed", modelSource: "execution", requestedModel: "old-requested", result: "Old result" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh", type: "collabAgentToolCall", tool: "followupTask", prompt: "Fresh task", receiverThreadIds: ["child"] } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ model: "", requestedModel: "", result: "", progress: "" });
    expect(useTaskStore.getState().tasks.root.agents[0].modelSource).toBeUndefined();
    expect(ctx.onNativeAgentDiscovered).toHaveBeenLastCalledWith("root", "child", expect.objectContaining({ model: "", requestedModel: "", activationId: "fresh" }));
    routeCodexEvent({ method: "thread/settings/updated", params: { threadId: "child", threadSettings: { model: "fresh-configured" } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ model: "fresh-configured", modelSource: "configured" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "fresh-no-task", type: "collabAgentToolCall", tool: "followupTask", model: "fresh-requested", receiverThreadIds: ["child"], agentsStates: { child: { status: "running", model: "fresh-reported" } } } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ model: "fresh-reported", requestedModel: "fresh-requested", task: "", prompt: "Task not reported" });
    expect(useTaskStore.getState().tasks.root.agents[0].modelSource).toBeUndefined();
  });

  it("retains provider-native explicit skill inputs without guessing use from catalog updates or prose", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "skills/changed", params: {} }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
      id: "native-input", type: "userMessage", content: [
        { type: "text", text: "Review this" },
        { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
        { type: "mention", name: "unused", path: "/skills/unused/SKILL.md" },
      ],
    } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
      id: "answer", type: "agentMessage", text: "I used @unused skill.",
    } } }, ctx);
    const task = useTaskStore.getState().tasks.thread;
    expect(task.messages[0].skillUsage).toEqual([{ name: "review", path: "/skills/review/SKILL.md", source: "codex-skill-input", status: "selected" }]);
    expect(usedSkillsForRun(task.messages.map((value) => ({ kind: "message", value })))).toEqual([
      { identity: "path:/skills/review/SKILL.md", name: "review", path: "/skills/review/SKILL.md" },
    ]);
  });

  it("attributes native web searches from their item type and actual event lifecycle", () => {
    const ctx = makeContext();
    const item = { id: "search", type: "webSearch", query: "provider protocol" };
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } }, ctx);
    expect(useTaskStore.getState().tasks.thread.activities[0]).toMatchObject({ workType: "research", detail: "provider protocol", status: "inProgress" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item } }, ctx);
    expect(useTaskStore.getState().tasks.thread.activities[0]).toMatchObject({ workType: "research", status: "completed" });
  });

  it.each(["webSearch", "commandExecution", "fileChange", "reasoning", "collabAgentToolCall", "subAgentActivity"])("retains late %s in its completed turn without claiming new work", (type) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    store.appendUserMessage("thread", { id: "old-prompt", role: "user", text: "Old request", turnId: "old" });
    store.completeMessage("thread", { id: "old-answer", role: "assistant", text: "Done", turnId: "old" });
    store.completeTurn("thread", "old", "completed");
    store.setActiveTurn("thread", "new");
    store.setTaskStatus("thread", "running");
    store.appendUserMessage("thread", { id: "new-prompt", role: "user", text: "New request", turnId: "new" });
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "old",
      item: { id: "late-work", type, status: "inProgress", kind: "started", query: "Old search", command: "old command", content: ["Old thinking"] },
    } }, ctx);
    const task = useTaskStore.getState().tasks.thread;
    expect(task.activities[0]).toMatchObject({ turnId: "old", turnStatus: "completed", status: "completed" });
    expect(task.activities[0].timelineOrder).toBeLessThan(task.messages.at(-1)!.timelineOrder!);
    expect(latestCompactActivity(task.activities.map((value) => ({ kind: "activity", value })), { activeTurnId: "new" }).activity).toBeUndefined();
    expect(task.activeTurnId).toBe("new");
    expect(task.status).toBe("running");
  });

  it.each(["summary", "content"])("extends seeded current-turn reasoning %s without accepting replayed terminal starts", (source) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "turn");
    store.setTaskStatus("thread", "running");
    const item = { id: "thought", type: "reasoning", [source]: ["Initial thinking"] };
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } }, ctx);
    routeCodexEvent({ method: source === "summary" ? "item/reasoning/summaryTextDelta" : "item/reasoning/textDelta",
      params: { threadId: "thread", turnId: "turn", itemId: "thought", delta: " continues" } }, ctx);
    store.flushDeltas();
    expect(useTaskStore.getState().tasks.thread.activities[0]).toMatchObject({ detail: "Initial thinking continues", status: "inProgress", turnId: "turn" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { ...item, [source]: ["Authoritative thinking"] } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } }, ctx);
    expect(useTaskStore.getState().tasks.thread.activities[0]).toMatchObject({ detail: source === "content" ? "Authoritative thinking" : "Initial thinking continues", status: "completed" });
  });

  it.each(["collabAgentToolCall", "subAgentActivity"])("does not infer late %s child completion from its parent", (type) => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    store.completeTurn("thread", "old", "completed");
    store.setActiveTurn("thread", "new");
    store.setTaskStatus("thread", "running");
    const event = (id: string, child: string) => ({ method: "item/started", params: { threadId: "thread", turnId: "old",
      item: { id, type, status: "inProgress", tool: "spawnAgent", receiverThreadIds: [child], agentThreadId: child, kind: "started" },
    } });
    routeCodexEvent(event("settled-spawn", "settled-child"), ctx);
    expect(useTaskStore.getState().tasks.thread.agents[0]).toMatchObject({ id: "settled-child", status: type === "collabAgentToolCall" ? "starting" : "started" });
    store.setTaskStatus("live-child", "running");
    routeCodexEvent(event("live-spawn", "live-child"), ctx);
    expect(useTaskStore.getState().tasks.thread.agents[1]).toMatchObject({ id: "live-child", status: "inProgress" });
  });

  it("keeps a child live when its own task is running after the dispatch tool completes", () => {
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "turn");
    store.setTaskStatus("child", "running");
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: {
      id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed" } },
    } } }, makeContext());
    expect(useTaskStore.getState().tasks.thread.agents[0]).toMatchObject({ id: "child", status: "inProgress" });
  });

  it("retains authoritative late child completion after an interrupted parent", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    store.completeTurn("thread", "old", "interrupted");
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "old", item: {
      id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "completed" } },
    } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.agents[0]).toMatchObject({ id: "child", status: "completed" });
  });

  it("reactivates a completed native child only for a fresh current-turn activation", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "new");
    store.setTaskStatus("child", "completed");
    store.upsertAgent("thread", { id: "child", prompt: "Review", status: "completed", runtime: "codex" });
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "new", item: {
      id: "new-input", type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["child"], agentsStates: { child: { status: "running", model: "actual-child" } },
    } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.agents[0]).toMatchObject({ status: "inProgress", model: "actual-child", activationId: "new-input" });
    store.completeTurn("child", undefined, "completed");
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "new", item: {
      id: "new-input", type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } },
    } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.agents[0].status).toBe("completed");
    expect(useTaskStore.getState().tasks.thread.agents[0].activationId).toBe("new-input");
  });

  it("reopens a V2 followup when receiver identity first arrives on tool completion", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "new");
    store.setTaskStatus("child", "completed");
    store.upsertAgent("thread", { id: "child", prompt: "Review", status: "completed", runtime: "codex" });
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "new", item: {
      id: "followup", type: "collabAgentToolCall", tool: "followupTask", status: "inProgress",
    } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "new", item: {
      id: "followup", type: "collabAgentToolCall", tool: "followupTask", status: "completed", receiverThreadIds: ["child"],
    } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.agents[0].status).toBe("starting");
    expect(useTaskStore.getState().tasks.child.activeTurnId).toBeUndefined();
  });

  it("preserves the known active child turn when a new input steers that same work", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "root-turn");
    store.setActiveTurn("child", "actual-active-turn");
    store.setTaskStatus("child", "running");
    routeCodexEvent({ method: "item/started", params: { threadId: "root", turnId: "root-turn", item: {
      id: "steer", type: "collabAgentToolCall", tool: "sendInput", receiverThreadIds: ["child"],
    } } }, ctx);
    expect(useTaskStore.getState().tasks.child.activeTurnId).toBe("actual-active-turn");
    expect(useTaskStore.getState().tasks.root.agents[0]).toMatchObject({ status: "inProgress", activationId: "steer" });
  });

  it.each(["collabAgentToolCall", "subAgentActivity"])("does not mutate a foreign main task when %s ownership is rejected", (type) => {
    const ctx = makeContext({ onNativeAgentDiscovered: vi.fn(() => false) });
    const store = useTaskStore.getState();
    store.setActiveTurn("root", "turn");
    store.setTaskStatus("foreign-main", "completed");
    const foreignTask = useTaskStore.getState().tasks["foreign-main"];
    routeCodexEvent({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: {
      id: "rejected", type, tool: "followupTask", status: "completed", receiverThreadIds: ["foreign-main"], agentThreadId: "foreign-main", kind: "started",
    } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents).toEqual([]);
    expect(useTaskStore.getState().tasks.root.activities).toEqual([]);
    expect(useTaskStore.getState().tasks["foreign-main"]).toBe(foreignTask);
    expect(useTaskStore.getState().statuses["foreign-main"]).toBe("completed");
  });

  it("excludes rejected receiver IDs from a mixed native wave", () => {
    const ctx = makeContext({ onNativeAgentDiscovered: vi.fn((_root: string, child: string) => child !== "foreign-main") });
    routeCodexEvent({ method: "item/started", params: { threadId: "root", turnId: "turn", item: {
      id: "wave", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child", "foreign-main"],
    } } }, ctx);
    expect(useTaskStore.getState().tasks.root.agents.map((agent) => agent.id)).toEqual(["child"]);
    expect(useTaskStore.getState().tasks.root.activities[0].agent).toMatchObject({ count: 1, threadIds: ["child"] });
    expect(useTaskStore.getState().tasks["foreign-main"]).toBeUndefined();
  });

  it("keeps many late rows before the next prompt without floating-point rank drift", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    store.appendUserMessage("thread", { id: "old-prompt", role: "user", text: "Old request", turnId: "old" });
    store.completeTurn("thread", "old", "completed");
    store.setActiveTurn("thread", "new");
    store.appendUserMessage("thread", { id: "new-prompt", role: "user", text: "New request", turnId: "new" });
    for (let index = 0; index < 100; index += 1) routeCodexEvent({ method: "item/started", params: {
      threadId: "thread", turnId: "old", item: { id: `late-${index}`, type: "webSearch" },
    } }, ctx);
    const task = useTaskStore.getState().tasks.thread;
    expect(task.activities).toHaveLength(100);
    expect(task.activities.every((activity) => activity.timelineOrder! < task.messages.at(-1)!.timelineOrder! && activity.turnStatus === "completed")).toBe(true);
  });

  it("ignores completed reasoning deltas without clearing a newer final-output lock", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "old");
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "old",
      item: { id: "thought", type: "reasoning", content: ["Retained thinking"] },
    } }, ctx);
    store.completeTurn("thread", "old", "completed");
    store.setActiveTurn("thread", "new");
    store.setTaskStatus("thread", "running");
    store.queueAssistantDelta("thread", "new-answer", "Final draft", "new");
    store.flushDeltas();
    routeCodexEvent({ method: "item/reasoning/textDelta", params: { threadId: "thread", turnId: "old", itemId: "thought", delta: "Late text" } }, ctx);
    store.flushDeltas();
    expect(useTaskStore.getState().tasks.thread.activities[0]).toMatchObject({ turnId: "old", turnStatus: "completed", detail: "Retained thinking", status: "completed" });
    expect(useTaskStore.getState().tasks.thread.assistantOutputTurnId).toBe("new");
  });

  it("keeps native commentary separate from a streamed final answer across completion and reload", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    for (const [id, phase, answer] of [["progress", "commentary", "Checking"], ["answer", "final_answer", "Done"]]) {
      routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id, type: "agentMessage", text: "", phase } } }, ctx);
      routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: id, delta: answer } }, ctx);
      useTaskStore.getState().flushDeltas();
      expect(useTaskStore.getState().tasks.thread.messages.at(-1)).toMatchObject({ phase: phase === "final_answer" ? "final" : "commentary", streaming: true });
      // An older completion writer may omit phase; known start metadata survives.
      routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id, type: "agentMessage", text: answer } } }, ctx);
    }
    useTaskStore.getState().completeTurn("thread", "turn", "completed");
    const messages = useTaskStore.getState().tasks.thread.messages;
    expect(messages.map((message) => [message.id, message.phase, message.turnStatus])).toEqual([
      ["progress", "commentary", "completed"], ["answer", "final", "completed"],
    ]);
    resetTaskStore();
    useTaskStore.getState().hydrateTask("thread", messages, []);
    expect(useTaskStore.getState().tasks.thread.messages.map((message) => message.phase)).toEqual(["commentary", "final"]);
  });

  it("retains a late native phase after deltas arrived before item-started", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "answer", delta: "Preserved draft" } }, ctx);
    useTaskStore.getState().flushDeltas();
    const order = useTaskStore.getState().tasks.thread.messages[0].timelineOrder;
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "", phase: "final_answer" } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ text: "Preserved draft", phase: "final", streaming: true, timelineOrder: order });
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Completed draft", phase: "final_answer" } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "", phase: "final_answer" } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ text: "Completed draft", phase: "final", streaming: false });
  });

  it.each([undefined, null, "future_phase", "final"])("leaves unsupported native phase %s unknown", (phase) => {
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", item: { id: "unknown", type: "agentMessage", text: "Text", phase } } }, makeContext());
    expect(useTaskStore.getState().tasks.thread.messages[0].phase).toBeUndefined();
  });

  it("keeps a plan-only successful turn as commentary even if it carries an answer-like phase", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "plan", type: "plan", text: "Inspect then test", phase: "final_answer" } } }, ctx);
    useTaskStore.getState().completeTurn("thread", "turn", "completed");
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ phase: "commentary", turnStatus: "completed" });
  });

  it("keeps cache counters omitted by the runtime unknown, not verified zero", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "thread/tokenUsage/updated", params: { threadId: "missing", tokenUsage: {
      total: { totalTokens: 110, inputTokens: 100, outputTokens: 10 }, last: { totalTokens: 110 },
    } } }, ctx);
    expect(useTaskStore.getState().tasks.missing.usage).toMatchObject({ cacheReadReported: false, cacheWriteReported: false,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, cacheReadUnknownTokens: 100, cacheWriteUnknownTokens: 100 });
    routeCodexEvent({ method: "thread/tokenUsage/updated", params: { threadId: "zero", tokenUsage: {
      total: { totalTokens: 110, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
    } } }, ctx);
    expect(useTaskStore.getState().tasks.zero.usage).toMatchObject({ cacheReadReported: true, cacheWriteReported: true,
      cacheReadUnknownTokens: 0, cacheWriteUnknownTokens: 0 });
  });

  it("reconciles live user echoes and retains nonblocking questions after request cleanup", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "turn");
    store.appendUserMessage("thread", { id: "local-1", role: "user", text: "Please review" });
    const event = { method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "runtime-1", type: "userMessage", content: [{ type: "text", text: "Please review" }] } } };
    routeCodexEvent(event, ctx);
    routeCodexEvent(event, ctx);
    expect(useTaskStore.getState().tasks.thread.messages).toHaveLength(1);
    routeCodexEvent({ method: "item/tool/requestUserInput", id: 42, params: { threadId: "thread", turnId: "turn", isBlocking: false, questions: [{ id: "layout", question: "Which layout?", options: [{ label: "Compact", description: "Dense" }] }] } }, ctx);
    routeCodexEvent({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 42 } }, ctx);
    expect(useTaskStore.getState().tasks.thread.approvals).toEqual([]);
    expect(ctx.onApprovalRequested).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks.thread.messages.at(-1)).toMatchObject({ questionRequestId: 42, questions: [{ id: "layout", title: "Which layout?", options: ["Compact"] }] });
  });

  it("replaces a stale pending question when a new request reuses its ID", () => {
    const ctx = makeContext();
    for (const turnId of ["old", "new"]) {
      routeCodexEvent({ method: "item/tool/requestUserInput", id: 42, params: { threadId: "thread", turnId, itemId: `${turnId}-item`, isBlocking: false, questions: [{ id: "layout", question: `Question from ${turnId}` }] } }, ctx);
    }
    const task = useTaskStore.getState().tasks.thread;
    expect(task.messages).toHaveLength(2);
    expect(task.approvals).toEqual([expect.objectContaining({ params: expect.objectContaining({ turnId: "new", itemId: "new-item" }) })]);
    const pending = task.approvals[0];
    routeCodexEvent({ method: pending.method, id: pending.id, params: pending.params }, ctx);
    expect(useTaskStore.getState().tasks.thread.approvals[0]).toBe(pending);
  });

  it("does not overwrite an earlier question when request IDs are reused", () => {
    const ctx = makeContext();
    for (const turnId of ["old-turn", "new-turn"]) {
      routeCodexEvent({ method: "item/tool/requestUserInput", id: 42, params: { threadId: "thread", turnId, itemId: `${turnId}-item`, isBlocking: false, questions: [{ id: "layout", question: `Question from ${turnId}` }] } }, ctx);
      routeCodexEvent({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: 42 } }, ctx);
    }
    const messages = useTaskStore.getState().tasks.thread.messages;
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it("keeps Astra assistant questions with streaming text and history", () => {
    const ctx = makeContext();
    const questions = [{ title: "Which layout?", options: ["Compact"] }];
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { type: "agentMessage", id: "answer", text: "I will keep working.", questions } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.messages[0].questions).toEqual(questions);
    expect(useTaskStore.getState().tasks.thread.approvals).toEqual([]);
  });

  it("streams an assistant item after its start event and seals its final text", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "" } } }, ctx);
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "answer", delta: "draft" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ id: "answer", text: "draft", streaming: true });

    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "final answer" } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ id: "answer", text: "final answer", streaming: false });
    expect(useTaskStore.getState().tasks.thread.messages).toHaveLength(1);
  });

  it("keeps started assistant text while later deltas extend it", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "first" } } }, ctx);
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "answer", delta: " second" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ id: "answer", text: "first second", streaming: true });

    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "first second!" } } }, ctx);
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({ id: "answer", text: "first second!", streaming: false });
  });

  it("captures OpenRouter receipts without assigning them to the active thread or counting tokens again", () => {
    const before = usageTotals();
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("unrelated-openai-thread");
    const receipt = { method: "mythra/openrouterCharge", params: { id: "gen-test", cost: 0.25 } };
    routeCodexEvent(receipt, ctx);
    routeCodexEvent(receipt, ctx);
    expect(openRouterReportedCost()).toEqual({ cost: 0.25, requests: 1 });
    expect(usageTotals()).toEqual(before);
    expect(useTaskStore.getState().tasks[RUNTIME_THREAD_ID]).toBeUndefined();
    expect(ctx.onStatus).not.toHaveBeenCalled();
  });

  it("routes deltas to the thread named in the event", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-active");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-b", itemId: "item-1", delta: "hello" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks["thread-b"]?.messages[0]?.text).toBe("hello");
    expect(useTaskStore.getState().tasks["thread-active"]?.messages ?? []).toHaveLength(0);
  });

  it("keeps a late delta attached to its stated turn after a newer turn starts", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread", "turn-new");
    store.setTaskStatus("thread", "running");

    routeCodexEvent({ method: "item/agentMessage/delta", params: {
      threadId: "thread", turnId: "turn-old", itemId: "late-answer", delta: "late text",
    } }, ctx);
    expect(useTaskStore.getState().tasks.thread.assistantOutputTurnId).toBeUndefined();
    store.flushDeltas();
    expect(useTaskStore.getState().tasks.thread.messages[0]).toMatchObject({
      id: "late-answer", turnId: "turn-old", streaming: true,
    });

    store.completeTurn("thread", "turn-old", "completed");
    const task = useTaskStore.getState().tasks.thread;
    expect(task.messages[0]).toMatchObject({
      id: "late-answer", turnId: "turn-old", streaming: false, turnStatus: "completed",
    });
    expect(task.activeTurnId).toBe("turn-new");
    expect(task.status).toBe("running");
  });

  it("normalizes a pushed rate limit update through the shared parser", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000 } } } }, ctx);
    expect(ctx.onRateLimits).toHaveBeenCalledWith({
      windows: [{ label: "5h", usedPercent: 42, resetsAt: 1_800_000_000 }],
    });
  });

  it("clears stale rate limits when an update carries no active window", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "account/rateLimits/updated", params: { rateLimits: {} } }, ctx);
    expect(ctx.onRateLimits).toHaveBeenCalledWith(null);
  });

  it("streams model thinking into a collapsed reasoning activity and prefers full content", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-a", itemId: "reasoning-1", delta: "Short summary" } }, ctx);
    routeCodexEvent({ method: "item/reasoning/textDelta", params: { threadId: "thread-a", itemId: "reasoning-1", delta: "Detailed thinking" } }, ctx);
    useTaskStore.getState().flushDeltas();

    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({
      id: "reasoning-1",
      kind: "reasoning",
      title: "Model thinking",
      detail: "Detailed thinking",
      status: "inProgress",
    });

    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-a", item: { id: "reasoning-1", type: "reasoning", summary: ["Finished summary"], content: ["Finished thinking"] } } }, ctx);
    expect(useTaskStore.getState().tasks["thread-a"].activities[0]).toMatchObject({ detail: "Finished thinking", status: "completed" });
  });

  it("never attributes threadless events to the active thread", () => {
    const ctx = makeContext();
    useTaskStore.getState().ensureTask("thread-active");
    useTaskStore.getState().setActiveThread("thread-active");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { itemId: "item-1", delta: "orphan" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks["thread-active"].messages).toHaveLength(0);
    expect(useTaskStore.getState().tasks[RUNTIME_THREAD_ID]?.messages[0]?.text).toBe("orphan");
  });

  it("enqueues approvals under their own thread and audits them", () => {
    const ctx = makeContext();
    routeCodexEvent({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-bg", command: "rm -rf" } }, ctx);
    const approvals = useTaskStore.getState().tasks["thread-bg"]?.approvals ?? [];
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe(7);
    expect(ctx.audit).toHaveBeenCalledWith("approval.requested", expect.anything(), "thread-bg");
  });

  it("answers currentTime/read directly", () => {
    const ctx = makeContext();
    routeCodexEvent({ id: 3, method: "currentTime/read", params: {} }, ctx);
    expect(ctx.respond).toHaveBeenCalledWith(3, expect.objectContaining({ currentTimeAt: expect.any(Number) }));
  });

  it("audits instead of throwing when a direct response fails", async () => {
    const ctx = makeContext({ respond: vi.fn(async () => { throw new Error("runtime gone"); }) });
    routeCodexEvent({ id: 3, method: "currentTime/read", params: {} }, ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.audit).toHaveBeenCalledWith("rpc.respondFailed", expect.objectContaining({ method: "currentTime/read" }), expect.anything());
  });

  it("maps known thread status types and ignores unknown ones", () => {
    const ctx = makeContext();
    useTaskStore.getState().setTaskStatus("thread-a", "running");
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "futureStatusType" } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-a"]).toBe("running");
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "idle" } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-a"]).toBe("idle");
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "active" } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-a"]).toBe("running");
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "systemError" } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-a"]).toBe("error");
  });

  it.each(["started", "completed"])("keeps a %s final item hidden when idle arrives before turn completion", (lifecycle) => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn", items: [] } } }, ctx);
    useTaskStore.getState().appendUserMessage("thread", { id: "prompt", role: "user", text: "Check it", turnId: "turn" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "progress", type: "agentMessage", text: "Checking", phase: "commentary" } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "", phase: "final_answer" } } }, ctx);
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "answer", delta: "Done" } }, ctx);
    useTaskStore.getState().flushDeltas();
    if (lifecycle === "completed") routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" } } }, ctx);
    const visibleIds = () => {
      const task = useTaskStore.getState().tasks.thread;
      return compactActivityPresentation(task.messages.map((value) => ({ kind: "message" as const, value })), {
        running: task.status === "running" || task.status === "starting", activeTurnId: task.activeTurnId,
      }).filter((entry) => entry.kind === "message").map((entry) => entry.value.id);
    };
    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread", status: { type: "idle" } } }, ctx);
    expect(visibleIds()).toEqual(["prompt"]);
    expect(useTaskStore.getState().tasks.thread.status).toBe("idle");
    routeCodexEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } } }, ctx);
    expect(visibleIds()).toEqual(["prompt", "answer"]);
    expect(useTaskStore.getState().tasks.thread.activeTurnId).toBeUndefined();
  });

  it.each(["optimistic", "runtime"])("keeps the prior final visible at the %s start boundary before new entries arrive", (start) => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "prior", items: [] } } }, ctx);
    useTaskStore.getState().appendUserMessage("thread", { id: "prompt", role: "user", text: "Check it", turnId: "prior" });
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread", turnId: "prior", item: { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer" } } }, ctx);
    routeCodexEvent({ method: "turn/completed", params: { threadId: "thread", turn: { id: "prior", status: "completed", items: [] } } }, ctx);
    if (start === "optimistic") useTaskStore.getState().setTaskStatus("thread", "starting");
    else routeCodexEvent({ method: "turn/started", params: { threadId: "thread", turn: { id: "next", items: [] } } }, ctx);
    const task = useTaskStore.getState().tasks.thread;
    const visible = compactActivityPresentation(task.messages.map((value) => ({ kind: "message" as const, value })), {
      running: task.status === "running" || task.status === "starting", activeTurnId: task.activeTurnId,
    }).filter((entry) => entry.kind === "message").map((entry) => entry.value.id);
    expect(visible).toEqual(["prompt", "answer"]);
  });

  it("seals queued assistant text when the runtime reports a system error", () => {
    const ctx = makeContext();
    const store = useTaskStore.getState();
    store.setActiveTurn("thread-a", "turn-a");
    store.setTaskStatus("thread-a", "running");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "answer", delta: "partial answer" } }, ctx);

    routeCodexEvent({ method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "systemError" } } }, ctx);

    const task = useTaskStore.getState().tasks["thread-a"];
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages).toEqual([expect.objectContaining({
      id: "answer", text: "partial answer", turnId: "turn-a", streaming: false, turnStatus: "failed",
    })]);
    expect(task.status).toBe("error");
  });

  it("marks turn lifecycle and only reports status for the active thread", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-a");
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-b", turn: { id: "turn-b", items: [] } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-b"]).toBe("running");
    expect(useTaskStore.getState().tasks["thread-b"].activeTurnId).toBe("turn-b");
    expect(ctx.onStatus).not.toHaveBeenCalled();

    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-a", items: [] } } }, ctx);
    expect(ctx.onStatus).toHaveBeenCalledWith("Working");

    routeCodexEvent({ method: "turn/completed", params: { threadId: "thread-b", turn: { id: "t1", items: [] } } }, ctx);
    expect(useTaskStore.getState().statuses["thread-b"]).toBe("running");
    expect(useTaskStore.getState().tasks["thread-b"].activeTurnId).toBe("turn-b");
    expect(useTaskStore.getState().tasks["thread-b"].lastCompletedTurnId).toBe("t1");
    expect(ctx.onTurnCompleted).toHaveBeenCalledWith("thread-b", { id: "t1", items: [] });
  });

  it("asks for verification instead of signing out on a stderr auth hint", () => {
    const ctx = makeContext();
    routeCodexEvent({ stream: "stderr", line: "request failed: 401 Unauthorized" }, ctx);
    expect(ctx.onAuthSuspected).toHaveBeenCalledTimes(1);
    // An MCP server or OpenRouter rejection shares this stream, so the
    // ChatGPT account must not be dropped before the runtime is asked.
    expect(ctx.onAuthRequired).not.toHaveBeenCalled();
    expect(ctx.onStatus).not.toHaveBeenCalledWith("Sign-in required");
    expect(ctx.onError).not.toHaveBeenCalled();
  });

  it("loads the account once a browser sign-in completes", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "account/login/completed", params: { loginId: "login-1", success: true } }, ctx);
    expect(ctx.onAccountUpdated).toHaveBeenCalledTimes(1);
    expect(ctx.onLoginFailed).not.toHaveBeenCalled();

    routeCodexEvent({ method: "account/login/completed", params: { loginId: "login-2", success: false, error: "browser closed" } }, ctx);
    expect(ctx.onLoginFailed).toHaveBeenCalledWith("browser closed");
    expect(ctx.onAccountUpdated).toHaveBeenCalledTimes(1);
  });

  it("treats a signed-out account notification as a sign-in requirement", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "account/updated", params: { authMode: null, planType: null } }, ctx);
    expect(ctx.onAuthRequired).toHaveBeenCalledTimes(1);
    expect(ctx.onAccountUpdated).not.toHaveBeenCalled();

    routeCodexEvent({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } }, ctx);
    expect(ctx.onAccountUpdated).toHaveBeenCalledTimes(1);
  });

  it("preserves an interrupted turn as stopped when its completion event arrives", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-a");
    useTaskStore.getState().setActiveTurn("thread-a", "turn-a");

    routeCodexEvent({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", items: [], status: "interrupted" } } }, ctx);

    expect(useTaskStore.getState().statuses["thread-a"]).toBe("interrupted");
    expect(useTaskStore.getState().tasks["thread-a"].activeTurnId).toBeUndefined();
    expect(ctx.onStatus).toHaveBeenCalledWith("Stopped");
  });

  it("decodes terminal output deltas", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "command/exec/outputDelta", params: { deltaBase64: btoa("ok\n"), processId: "process-7" } }, ctx);
    expect(ctx.onTerminalOutput).toHaveBeenCalledWith("ok\n", "process-7");
  });

  it("records runtime warnings as activities", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "guardianWarning", params: { threadId: "thread-w", message: "careful" } }, ctx);
    expect(useTaskStore.getState().tasks["thread-w"]?.activities[0]?.title).toBe("careful");
  });

  it("separates cumulative Codex usage from the latest request's context pressure", () => {
    const ctx = makeContext();
    routeCodexEvent({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage",
        tokenUsage: {
          total: { totalTokens: 100_000, inputTokens: 92_000, outputTokens: 8_000, cachedInputTokens: 80_000 },
          last: { totalTokens: 20_000, inputTokens: 19_000, outputTokens: 1_000, cachedInputTokens: 18_000 },
          modelContextWindow: 200_000,
        },
      },
    }, ctx);
    routeCodexEvent({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-usage",
        tokenUsage: {
          total: { totalTokens: 140_000, inputTokens: 130_000, outputTokens: 10_000, cachedInputTokens: 110_000 },
          last: { totalTokens: 25_000, inputTokens: 24_000, outputTokens: 1_000, cachedInputTokens: 22_000 },
          modelContextWindow: 200_000,
        },
      },
    }, ctx);

    expect(useTaskStore.getState().tasks["thread-usage"].usage).toMatchObject({
      totalTokens: 140_000,
      inputTokens: 130_000,
      outputTokens: 10_000,
      contextTokens: 25_000,
      contextWindow: 200_000,
    });
  });

  it("keeps interacted native agents live and discovers their durable child threads", () => {
    const ctx = makeContext({ bindingFor: () => "/workspace" });
    routeCodexEvent({
      method: "item/completed",
      params: {
        threadId: "root",
        item: { id: "activity-1", type: "subAgentActivity", kind: "interacted", agentThreadId: "child", agentPath: "/root/worker" },
      },
    }, ctx);

    expect(useTaskStore.getState().tasks.root.agents).toContainEqual(expect.objectContaining({ id: "child", status: "interacted" }));
    expect(useTaskStore.getState().tasks.root.activities).toContainEqual(expect.objectContaining({
      id: "activity-1",
      kind: "agent",
      detail: "/root/worker",
      status: "interacted",
      agent: {
        action: "spawn",
        provider: "openai",
        count: 1,
        threadIds: ["child"],
      },
    }));
    expect(useTaskStore.getState().tasks.child.workspacePath).toBe("/workspace");
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledWith("root", "child", { path: "/root/worker", status: "interacted", model: undefined, provider: "openai", runtime: "codex" });
  });

  it("renders a native Codex start as a structured Relay spawn", () => {
    const ctx = makeContext({ bindingFor: () => "/workspace" });
    routeCodexEvent({
      method: "item/completed",
      params: {
        threadId: "root",
        item: {
          id: "activity-1",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/audio_regression_audit",
        },
      },
    }, ctx);

    expect(useTaskStore.getState().tasks.root.activities).toContainEqual(expect.objectContaining({
      id: "activity-1",
      title: "Sub-agent started",
      detail: "/root/audio_regression_audit",
      status: "started",
      agent: {
        action: "spawn",
        provider: "openai",
        count: 1,
        threadIds: ["child"],
      },
    }));
  });

  it("never records the root thread as one of its own sub-agents", () => {
    // A runtime that names the thread itself as the delegation receiver would
    // otherwise put the root in its own worker list, where it holds a slot in
    // the user's parallel budget and renders as an extra agent.
    const ctx = makeContext({ bindingFor: () => "/workspace" });
    routeCodexEvent({
      method: "item/completed",
      params: {
        threadId: "root",
        item: { id: "activity-1", type: "subAgentActivity", kind: "started", agentThreadId: "root", agentPath: "/root" },
      },
    }, ctx);
    routeCodexEvent({
      method: "item/completed",
      params: {
        threadId: "root",
        item: { id: "activity-2", type: "collabAgentToolCall", tool: "spawnAgent", prompt: "Split the work", status: "inProgress", receiverThreadIds: ["root", "child"] },
      },
    }, ctx);

    expect(useTaskStore.getState().tasks.root.agents.map((agent) => agent.id)).toEqual(["child"]);
    expect(useTaskStore.getState().tasks.root.activities).toContainEqual(expect.objectContaining({
      id: "activity-2",
      agent: {
        action: "spawn",
        provider: "openai",
        task: "Split the work",
        count: 1,
        threadIds: ["child"],
      },
    }));
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledTimes(1);
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledWith("root", "child", expect.objectContaining({ prompt: "Split the work", task: "Split the work", status: "starting", model: undefined, provider: "openai", runtime: "codex" }));
  });

  it("keeps fallback model metadata warnings in diagnostics instead of the chat", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "warning", params: { threadId: "thread-w", message: "Model metadata for `vendor/new-model` not found. Defaulting to fallback metadata; this can degrade performance." } }, ctx);
    expect(useTaskStore.getState().tasks["thread-w"]?.activities ?? []).toHaveLength(0);
    expect(ctx.audit).toHaveBeenCalledWith("runtime.warning.suppressed", expect.objectContaining({ method: "warning" }), "thread-w");
  });

  it("renders structured provider errors instead of object coercion", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "error", params: { threadId: "thread-e", error: { message: "Provider failed", code: 400 } } }, ctx);
    expect(useTaskStore.getState().tasks["thread-e"]?.activities[0]?.title).toBe("Provider failed");
  });

  it("keeps one animated compaction marker across the app-server item lifecycle", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-c", turn: { id: "turn-1" } } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread-c", item: { id: "compaction-1", type: "contextCompaction", status: "inProgress" } } }, ctx);

    const live = useTaskStore.getState().tasks["thread-c"].activities;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: "compaction-1",
      kind: "compaction",
      title: "Compacting context",
      detail: "Codex",
      status: "inProgress",
      turnId: "turn-1",
    });

    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-c", item: { id: "compaction-1", type: "contextCompaction", status: "completed" } } }, ctx);

    const settled = useTaskStore.getState().tasks["thread-c"].activities;
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ id: "compaction-1", title: "Context compacted", status: "completed" });
    expect(settled[0].timelineOrder).toBe(live[0].timelineOrder);
  });

  it.each(["openrouter", "lmstudio"] as const)("ignores compaction items for %s threads", (provider) => {
    const ctx = makeContext({ providerFor: () => provider });
    routeCodexEvent({ method: "item/started", params: { threadId: "thread-third-party", item: { id: "compaction-1", type: "contextCompaction" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-third-party", item: { id: "compaction-1", type: "contextCompaction" } } }, ctx);

    expect(useTaskStore.getState().tasks["thread-third-party"]?.activities ?? []).toEqual([]);
  });

  it("settles a compaction whose completion still carries a stale in-progress body", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "item/started", params: { threadId: "thread-c", item: { id: "compaction-1", type: "contextCompaction" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-c", item: { id: "compaction-1", type: "contextCompaction", status: "inProgress" } } }, ctx);

    expect(useTaskStore.getState().tasks["thread-c"].activities).toMatchObject([
      { kind: "compaction", status: "completed", title: "Context compacted" },
    ]);
  });

  it("places the compaction marker between the work on either side of it", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-c", turn: { id: "turn-1" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-c", item: { id: "cmd-1", type: "commandExecution", command: "ls", status: "completed" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-c", item: { id: "compaction-1", type: "contextCompaction", status: "completed" } } }, ctx);
    routeCodexEvent({ method: "item/completed", params: { threadId: "thread-c", item: { id: "cmd-2", type: "commandExecution", command: "pwd", status: "completed" } } }, ctx);

    const activities = useTaskStore.getState().tasks["thread-c"].activities;
    expect(activities.map((activity) => activity.id)).toEqual(["cmd-1", "compaction-1", "cmd-2"]);
    expect(activities[0].timelineOrder!).toBeLessThan(activities[1].timelineOrder!);
    expect(activities[1].timelineOrder!).toBeLessThan(activities[2].timelineOrder!);
    expect(ctx.onStatus).not.toHaveBeenCalledWith(expect.stringContaining("Compact"));
  });

  it("flushes earlier frame-batched text before inserting a compaction boundary", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "turn/started", params: { threadId: "thread-c", turn: { id: "turn-1" } } }, ctx);
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-c", itemId: "before", delta: "Before compaction" } }, ctx);
    routeCodexEvent({ method: "item/started", params: { threadId: "thread-c", item: { id: "compact", type: "contextCompaction" } } }, ctx);
    useTaskStore.getState().flushDeltas();
    const task = useTaskStore.getState().tasks["thread-c"];
    expect(task.messages[0].timelineOrder!).toBeLessThan(task.activities[0].timelineOrder!);
  });

  it("does not reactivate a completed marker on a duplicate start", () => {
    const ctx = makeContext();
    const params = { threadId: "thread-c", turnId: "turn-1", item: { id: "compact", type: "contextCompaction" } };
    routeCodexEvent({ method: "item/completed", params }, ctx);
    routeCodexEvent({ method: "item/started", params }, ctx);
    expect(useTaskStore.getState().tasks["thread-c"].activities).toMatchObject([{ status: "completed", turnId: "turn-1" }]);
  });

  it("flags incompatible provider tool schemas for a runtime refresh", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "error", params: { threadId: "thread-e", error: { message: "400 INVALID_ARGUMENT: function_declarations[9].parameters.required[0] property is not defined" } } }, ctx);
    expect(ctx.onProviderToolCompatibilityError).toHaveBeenCalledWith("thread-e");
    expect(useTaskStore.getState().tasks["thread-e"]?.activities[0]?.title).toBe("The selected model rejected an incompatible connected-app tool.");
  });
});

describe("decodeBase64Utf8", () => {
  it("decodes utf-8 payloads and tolerates garbage", () => {
    expect(decodeBase64Utf8(btoa("plain"))).toBe("plain");
    expect(decodeBase64Utf8("&&& not base64 &&&")).toBe("");
    expect(decodeBase64Utf8(undefined)).toBe("");
  });
});

describe("runtimeMessage", () => {
  it("extracts nested error messages and serializes unknown objects", () => {
    expect(runtimeMessage({ error: { message: "Readable failure" } })).toBe("Readable failure");
    expect(runtimeMessage({ code: 400 })).toBe('{"code":400}');
  });
  it("answers unknown server requests with an empty response and a visible warning", () => {
    const ctx = makeContext();
    routeCodexEvent({ id: 42, method: "consent/requestDecision", params: { threadId: "thread-a" } }, ctx);

    expect(ctx.respond).toHaveBeenCalledWith(42, {});
    expect(ctx.audit).toHaveBeenCalledWith("rpc.unhandledRequest", { method: "consent/requestDecision" }, "thread-a");
    expect(useTaskStore.getState().tasks["thread-a"].activities.at(-1)).toMatchObject({
      kind: "warning",
      title: "Unsupported runtime request",
    });
  });

  it("leaves unknown notifications without an id unanswered", () => {
    const ctx = makeContext();
    routeCodexEvent({ method: "some/futureNotification", params: { threadId: "thread-a" } }, ctx);
    expect(ctx.respond).not.toHaveBeenCalled();
  });
});

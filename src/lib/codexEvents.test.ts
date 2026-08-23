import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_THREAD_ID, decodeBase64Utf8, routeCodexEvent, runtimeMessage, type CodexEventContext } from "./codexEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";

function makeContext(overrides: Partial<CodexEventContext> = {}): CodexEventContext {
  return {
    bindingFor: () => undefined,
    respond: vi.fn(async () => {}),
    audit: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onAuthRequired: vi.fn(),
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
  beforeEach(() => resetTaskStore());

  it("routes deltas to the thread named in the event", () => {
    const ctx = makeContext();
    useTaskStore.getState().setActiveThread("thread-active");
    routeCodexEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-b", itemId: "item-1", delta: "hello" } }, ctx);
    useTaskStore.getState().flushDeltas();
    expect(useTaskStore.getState().tasks["thread-b"]?.messages[0]?.text).toBe("hello");
    expect(useTaskStore.getState().tasks["thread-active"]?.messages ?? []).toHaveLength(0);
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

  it("surfaces sign-in problems from stderr", () => {
    const ctx = makeContext();
    routeCodexEvent({ stream: "stderr", line: "request failed: 401 Unauthorized" }, ctx);
    expect(ctx.onAuthRequired).toHaveBeenCalled();
    expect(ctx.onStatus).toHaveBeenCalledWith("Sign-in required");
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
    routeCodexEvent({ method: "command/exec/outputDelta", params: { deltaBase64: btoa("ok\n") } }, ctx);
    expect(ctx.onTerminalOutput).toHaveBeenCalledWith("ok\n");
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
        task: "/root/worker",
        count: 1,
      },
    }));
    expect(useTaskStore.getState().tasks.child.workspacePath).toBe("/workspace");
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledWith("root", "child", { path: "/root/worker" });
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
        task: "/root/audio_regression_audit",
        count: 1,
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
      },
    }));
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledTimes(1);
    expect(ctx.onNativeAgentDiscovered).toHaveBeenCalledWith("root", "child", { prompt: "Split the work" });
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

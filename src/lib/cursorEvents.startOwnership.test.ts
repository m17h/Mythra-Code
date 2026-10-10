import { beforeEach, describe, expect, it, vi } from "vitest";
import { killCursorTurn, startCursorTurn, type CursorTurnOptions } from "./cursor";
import { resetCursorEventStateForTests, routeCursorEvent, type CursorEventContext } from "./cursorEvents";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { beginCursorTurnStart, cursorTurnOwner } from "./cursorTurnOwnership";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const options: CursorTurnOptions = {
  threadId: "thread", cwd: "/tmp/project", prompt: "Work", model: "auto",
  effort: "high", permission: "full", systemPrompt: "", attachments: [],
};
const context: CursorEventContext = {
  bindingFor: () => "/tmp/project", onStatus: vi.fn(), onError: vi.fn(),
  onTurnCompleted: vi.fn(), onApprovalRequested: vi.fn(), onTranscriptChanged: vi.fn(),
};
// Fixture native envelopes echo the matching invocation's request identity.
const requestIds = new Map<string, string>();
const send = (turnId: string, message: Record<string, unknown>) => {
  if (!requestIds.has(turnId)) {
    const starts = native.invoke.mock.calls.filter(([command]) => command === "cursor_turn_start");
    const start = turnId === "old" ? starts[0] : starts.at(-1);
    if (start) requestIds.set(turnId, start[1].options.startRequestId);
  }
  routeCursorEvent({ threadId: "thread", turnId, startRequestId: requestIds.get(turnId), message }, context);
};

describe("Cursor start ownership across native acknowledgments", () => {
  beforeEach(() => {
    resetCursorEventStateForTests();
    resetTaskStore();
    vi.clearAllMocks();
    native.invoke.mockReset();
    requestIds.clear();
    useTaskStore.getState().setTaskStatus("thread", "starting");
  });

  it.each([
    { type: "notification", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Old tail" } } } },
    { type: "notification", method: "cursor/create_plan", params: { plan: "Old plan" } },
    { type: "permission_request", requestId: "old-permission", params: {} },
    { type: "cursor_request", method: "cursor/ask_question", requestId: "old-question", params: { questions: [] } },
    { type: "openkiwi_error", message: "Old process stopped" },
  ])("rejects old $type during replacement startup while admitting new pre-ack approval", async (oldMessage) => {
    // The old process was accepted but has emitted no event. Its native start
    // acknowledgment is the only evidence available to identify its late tail.
    native.invoke.mockResolvedValueOnce({ turnId: "old", cursorSessionId: "session" });
    await startCursorTurn(options);
    useTaskStore.getState().setActiveTurn("thread", "old");
    useTaskStore.getState().setTaskStatus("thread", "running");
    native.invoke.mockResolvedValueOnce(undefined);
    await killCursorTurn("thread");
    useTaskStore.getState().setActiveTurn("thread", undefined);
    useTaskStore.getState().setTaskStatus("thread", "interrupted");

    let acknowledge!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    useTaskStore.getState().setTaskStatus("thread", "starting");
    const replacement = startCursorTurn(options);
    const starting = useTaskStore.getState().tasks.thread;
    send("old", oldMessage);
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ status: "starting" });
    expect(useTaskStore.getState().tasks.thread.activeTurnId).toBeUndefined();
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks.thread.workingStartedAt).toBe(starting.workingStartedAt);

    send("new", { type: "permission_request", requestId: "new-permission", params: {} });
    expect(context.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ activeTurnId: "new", status: "running" });
    acknowledge({ turnId: "new", cursorSessionId: "session" });
    await replacement;
    send("old", { type: "openkiwi_error", message: "Old finalizer" });
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ activeTurnId: "new", status: "running" });
    expect(useTaskStore.getState().tasks.thread.approvals.map((approval) => approval.id)).toEqual(["new-permission"]);
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
  });

  it("restores a still-live owner when a new native start is rejected", async () => {
    native.invoke.mockResolvedValueOnce({ turnId: "old", cursorSessionId: "session" });
    await startCursorTurn(options);
    useTaskStore.getState().setActiveTurn("thread", "old");
    useTaskStore.getState().setTaskStatus("thread", "starting");
    native.invoke.mockRejectedValueOnce(new Error("already working"));
    await expect(startCursorTurn(options)).rejects.toThrow("already working");
    send("old", { type: "permission_request", requestId: "still-live", params: {} });
    expect(context.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ activeTurnId: "old", status: "running" });
  });

  it("does not retire a successor when the predecessor's Stop acknowledgment arrives late", async () => {
    native.invoke.mockResolvedValueOnce({ turnId: "old", cursorSessionId: "session" });
    await startCursorTurn(options);
    useTaskStore.getState().setActiveTurn("thread", "old");
    let stopped!: () => void;
    native.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { stopped = resolve; }));
    const stop = killCursorTurn("thread");
    native.invoke.mockResolvedValueOnce({ turnId: "new", cursorSessionId: "session" });
    await startCursorTurn(options);
    useTaskStore.getState().setActiveTurn("thread", "new");
    useTaskStore.getState().setTaskStatus("thread", "running");
    stopped();
    await stop;
    send("new", { type: "permission_request", requestId: "live", params: {} });
    send("old", { type: "permission_request", requestId: "retired", params: {} });
    expect(useTaskStore.getState().tasks.thread.approvals.map((approval) => approval.id)).toEqual(["live"]);
  });

  it("does not revive an early completed turn when its acknowledgment arrives during the next start", async () => {
    let acknowledgeShort!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeShort = resolve; }));
    const short = startCursorTurn(options);
    send("short", { type: "result", result: {} });
    expect(useTaskStore.getState().tasks.thread.status).toBe("completed");
    let acknowledgeNext!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeNext = resolve; }));
    useTaskStore.getState().setTaskStatus("thread", "starting");
    const next = startCursorTurn(options);
    acknowledgeShort({ turnId: "short", cursorSessionId: "session" });
    await short;
    send("short", { type: "permission_request", requestId: "closed", params: {} });
    send("next", { type: "cursor_request", method: "cursor/ask_question", requestId: "current", params: { questions: [] } });
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ activeTurnId: "next", status: "running" });
    expect(useTaskStore.getState().tasks.thread.approvals.map((approval) => approval.id)).toEqual(["current"]);
    acknowledgeNext({ turnId: "next", cursorSessionId: "session" });
    await next;
  });

  it.each(["preparing", "completed"])("a retired terminal preserves a %s successor even without an active turn", async (phase) => {
    native.invoke.mockResolvedValueOnce({ turnId: "old", cursorSessionId: "session" });
    await startCursorTurn(options);
    native.invoke.mockResolvedValueOnce(undefined);
    await killCursorTurn("thread");
    useTaskStore.getState().setActiveTurn("thread", undefined);
    useTaskStore.getState().setTaskStatus("thread", "starting");
    let acknowledge!: (result: { turnId: string; cursorSessionId: string }) => void;
    let replacement: ReturnType<typeof startCursorTurn> | undefined;
    if (phase === "preparing") beginCursorTurnStart("thread");
    if (phase === "completed") {
      native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
      replacement = startCursorTurn(options);
      send("new", { type: "result", result: {} });
    }
    const before = useTaskStore.getState().tasks.thread;
    vi.clearAllMocks();
    send("old", { type: "openkiwi_error", message: "Late stopped process" });
    const after = useTaskStore.getState().tasks.thread;
    expect(after.status).toBe(before.status);
    expect(after.lastCompletedTurnId).toBe(before.lastCompletedTurnId);
    expect(context.onTurnCompleted).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    if (replacement) {
      acknowledge({ turnId: "new", cursorSessionId: "session" });
      expect(await replacement).not.toMatchObject({ superseded: true });
      expect(useTaskStore.getState().tasks.thread.lastCompletedTurnId).toBe("new");
    }
  });

  it("labels a stale native acknowledgment without permitting its events to adopt the pending successor", async () => {
    let acknowledgeFirst!: (result: { turnId: string; cursorSessionId: string }) => void;
    let acknowledgeNext!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeFirst = resolve; }));
    const first = startCursorTurn(options);
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeNext = resolve; }));
    const next = startCursorTurn(options);
    acknowledgeFirst({ turnId: "old", cursorSessionId: "old-session" });
    expect(await first).toMatchObject({ superseded: true });
    send("old", { type: "permission_request", requestId: "old-request", params: {} });
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks.thread.status).toBe("starting");
    send("new", { type: "permission_request", requestId: "new-request", params: {} });
    acknowledgeNext({ turnId: "new", cursorSessionId: "session" });
    expect(await next).not.toMatchObject({ superseded: true });
    expect(useTaskStore.getState().tasks.thread.activeTurnId).toBe("new");
  });

  it("uses a reserved request identity and rejects a closed intent before native dispatch", async () => {
    const attempt = beginCursorTurnStart("thread");
    native.invoke.mockResolvedValueOnce({ turnId: "new", cursorSessionId: "session" });
    await startCursorTurn({ ...options, startRequestId: attempt.owner.startRequestId });
    expect(native.invoke.mock.calls[0][1].options.startRequestId).toBe(attempt.owner.startRequestId);
    native.invoke.mockResolvedValueOnce(undefined);
    await killCursorTurn("thread");
    const calls = native.invoke.mock.calls.length;
    await expect(startCursorTurn({ ...options, startRequestId: attempt.owner.startRequestId })).rejects.toThrow("superseded");
    expect(native.invoke.mock.calls.length).toBe(calls);
  });

  it("retires a failed direct start and forgets authority when its task is removed", async () => {
    native.invoke.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(startCursorTurn(options)).rejects.toThrow("spawn failed");
    expect(cursorTurnOwner("thread")).toBeUndefined();
    native.invoke.mockResolvedValueOnce({ turnId: "old", cursorSessionId: "session" });
    await startCursorTurn(options);
    useTaskStore.getState().removeTask("thread");
    expect(cursorTurnOwner("thread")).toBeUndefined();
    send("old", { type: "permission_request", requestId: "forgotten", params: {} });
    expect(context.onApprovalRequested).not.toHaveBeenCalled();
  });

  it("does not reopen a stopped early turn when its start acknowledgment precedes the delayed terminal", async () => {
    let acknowledge!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const start = startCursorTurn(options);
    send("new", { type: "permission_request", requestId: "approval", params: {} });
    expect(useTaskStore.getState().tasks.thread.activeTurnId).toBe("new");
    native.invoke.mockResolvedValueOnce(undefined);
    await killCursorTurn("thread");
    useTaskStore.getState().setActiveTurn("thread", undefined);
    useTaskStore.getState().setTaskStatus("thread", "interrupted");
    acknowledge({ turnId: "new", cursorSessionId: "session" });
    const accepted = await start;
    expect(accepted).toMatchObject({ stopped: true, cursorSessionId: "session" });
    expect(accepted.superseded).toBeUndefined();
    send("new", { type: "openkiwi_error", message: "Stopped" });
    expect(useTaskStore.getState().tasks.thread).toMatchObject({ status: "interrupted" });
    expect(useTaskStore.getState().tasks.thread.activities.some((activity) => activity.status === "failed")).toBe(false);
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().tasks.thread.lastCompletedTurnId).toBe("new");
    send("new", { type: "openkiwi_error", message: "Duplicate stopped terminal" });
    expect(context.onTurnCompleted).toHaveBeenCalledTimes(1);
  });

  it("keeps a stopped predecessor acknowledgment superseded once a successor owns the session", async () => {
    let acknowledge!: (result: { turnId: string; cursorSessionId: string }) => void;
    native.invoke.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const old = startCursorTurn(options);
    send("old", { type: "permission_request", requestId: "old-approval", params: {} });
    native.invoke.mockResolvedValueOnce(undefined);
    await killCursorTurn("thread");
    useTaskStore.getState().setActiveTurn("thread", undefined);
    useTaskStore.getState().setTaskStatus("thread", "starting");
    native.invoke.mockResolvedValueOnce({ turnId: "new", cursorSessionId: "new-session" });
    expect(await startCursorTurn(options)).toMatchObject({ cursorSessionId: "new-session" });
    acknowledge({ turnId: "old", cursorSessionId: "old-session" });
    const stale = await old;
    expect(stale.superseded).toBe(true);
    expect(stale.stopped).toBeUndefined();
  });
});

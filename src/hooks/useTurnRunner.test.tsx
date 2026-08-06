import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { PendingTurnStarts } from "../lib/pendingTurnStarts";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { Thread } from "../types";

const codex = vi.hoisted(() => ({ rpc: vi.fn() }));
const claude = vi.hoisted(() => ({
  interruptClaudeTurn: vi.fn(),
  isClaudeThreadBusyError: vi.fn(() => false),
  killClaudeTurn: vi.fn(),
  saveClaudeTranscript: vi.fn(),
  startClaudeTurn: vi.fn(),
  steerClaudeTurn: vi.fn(),
}));
const cursor = vi.hoisted(() => ({
  interruptCursorTurn: vi.fn(),
  killCursorTurn: vi.fn(),
  saveCursorTranscript: vi.fn(),
  startCursorTurn: vi.fn(),
  steerCursorTurn: vi.fn(),
}));
const worktrees = vi.hoisted(() => ({
  createThreadWorktree: vi.fn(),
  removeThreadWorktree: vi.fn(),
}));

vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", () => claude);
vi.mock("../lib/cursor", () => cursor);
vi.mock("../lib/worktrees", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/worktrees")>(),
  ...worktrees,
}));

import { forgetQueuedDeliveries, useTurnRunner, type TurnRunnerContext } from "./useTurnRunner";

const CURSOR_THREAD: Thread = {
  id: "thread-cursor",
  name: null,
  preview: "Cursor thread",
  cwd: "/tmp/project",
  updatedAt: 1,
  modelProvider: "cursor",
};

function context(overrides: Partial<TurnRunnerContext> = {}): TurnRunnerContext {
  const pendingTurnStarts = new PendingTurnStarts();
  return {
    activeThread: CURSOR_THREAD,
    activeWorkspace: { id: "project-1", name: "Project", path: "/tmp/project" },
    activeProject: { id: "project-1", name: "Project", path: "/tmp/project" },
    running: false,
    attachments: [],
    effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "grok-4.5" },
    settings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "grok-4.5" },
    customAgents: [],
    openRouterModels: [],
    runtimeStatus: null,
    claudeStatus: null,
    cursorStatus: {
      available: true,
      loggedIn: true,
      version: "test",
      path: "/usr/local/bin/agent",
      email: "test@example.com",
      subscriptionType: "pro",
      warning: null,
    },
    account: null,
    openRouterReady: false,
    workspaceGitInfo: null,
    draftThreadIsolated: false,
    worktreeBusy: false,
    skillsFolder: "",
    threadWorktreesRef: { current: {} },
    threadProjectBindingsRef: { current: { [CURSOR_THREAD.id]: "/tmp/project" } },
    activeWorkspacePathRef: { current: "/tmp/project" },
    pendingTurnStartsRef: { current: pendingTurnStarts },
    skillRuntimeRootRef: { current: "" },
    cursorSessionIdsRef: { current: {} },
    executionPathFor: (_threadId, path) => path,
    bindThreadToProject: vi.fn(),
    rememberThread: vi.fn(),
    onThreadCreated: vi.fn(),
    persistThreadModel: vi.fn(),
    persistThreadWorktrees: vi.fn(),
    beginRunCheckpoint: vi.fn(async () => "checkpoint-1"),
    discardRunCheckpoint: vi.fn(),
    refreshLocalSkills: vi.fn(async () => undefined),
    ensureSkillRoots: vi.fn(async () => undefined),
    scheduleClaudeThreadSave: vi.fn(),
    scheduleCursorThreadSave: vi.fn(),
    setThreads: vi.fn(),
    setActiveThread: vi.fn(),
    setAttachments: vi.fn(),
    setDraftThreadIsolated: vi.fn(),
    setStartingDraftTurn: vi.fn(),
    setError: vi.fn(),
    setStatus: vi.fn(),
    setTransientStatus: vi.fn(),
    setRuntimeSetupOpen: vi.fn(),
    setAuthRequiredOpen: vi.fn(),
    openSettings: vi.fn(),
    ...overrides,
  };
}

describe("useTurnRunner", () => {
  beforeEach(() => {
    resetTaskStore();
    forgetQueuedDeliveries();
    vi.clearAllMocks();
    cursor.interruptCursorTurn.mockResolvedValue(undefined);
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-new", cursorSessionId: "session-new" });
    cursor.steerCursorTurn.mockResolvedValue(undefined);
  });

  it("interrupts the active provider turn and records the stopped state", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => result.current.stopTurn());

    expect(cursor.interruptCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.activeTurnId).toBeUndefined();
    expect(useTaskStore.getState().statuses[CURSOR_THREAD.id]).toBe("interrupted");
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Stopped");
  });

  it("records cancellation only for a start that is actually in flight", async () => {
    const deps = context({ running: true });
    const pending = deps.pendingTurnStartsRef.current.begin(CURSOR_THREAD.id);
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => result.current.stopTurn());

    expect(deps.setStatus).toHaveBeenCalledWith("Stopping");
    expect(cursor.interruptCursorTurn).not.toHaveBeenCalled();
    expect(deps.pendingTurnStartsRef.current.finish(CURSOR_THREAD.id, pending)).toBe(true);
  });

  it("uses the latest context without changing callback identity", async () => {
    const first = context({ activeThread: null, running: false });
    const second = context({ running: true });
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), { initialProps: { deps: first } });
    const stop = result.current.stopTurn;

    rerender({ deps: second });
    await act(async () => result.current.stopTurn());

    expect(result.current.stopTurn).toBe(stop);
    expect(cursor.interruptCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id);
  });

  it("queues a running-task message by default without steering", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = false;
    await act(async () => { delivered = await result.current.sendMessage("do this next"); });

    expect(delivered).toBe(true);
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({ text: "do this next", status: "queued" }),
    ]);
  });

  it("refuses a second send until the first thread has an id", async () => {
    const deps = context({ activeThread: null, running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.sendMessage("do this after startup"); });

    expect(delivered).toBe(false);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it("starts the oldest queued message after the active turn completes", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("do this next"); });

    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "do this next" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("starts a queue restored from an earlier app session when the task is opened", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    // A durable entry with no in-memory delivery context and an idle task is
    // exactly the state an app restart leaves behind.
    useTaskStore.getState().enqueueTurn(CURSOR_THREAD.id, "finish the migration", []);
    const deps = context({ running: false });

    renderHook(() => useTurnRunner(deps));
    await act(async () => { await Promise.resolve(); });

    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "finish the migration" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("holds the queue at a failed head instead of starting later follow-ups", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("first follow-up"); });
    await act(async () => { await result.current.sendMessage("second follow-up"); });

    cursor.startCursorTurn.mockRejectedValueOnce(new Error("cursor is already working"));
    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    const failed = useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns ?? [];
    expect(failed.map((entry) => [entry.text, entry.status])).toEqual([
      ["first follow-up", "failed"],
      ["second follow-up", "queued"],
    ]);

    // A later completion must not let the second follow-up jump the failed one.
    await act(async () => {
      useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "completed");
      await Promise.resolve();
    });
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.retryQueuedMessage(failed[0].id);
      await Promise.resolve();
    });
    expect(cursor.startCursorTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "first follow-up" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns.map((entry) => entry.text)).toEqual(["second follow-up"]);
  });

  it("holds the queued turn without a modal when another shared-folder run overlaps", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("do this next"); });

    // A second conversation starts working in the same shared folder before the
    // queued follow-up gets its turn.
    useTaskStore.getState().ensureTask("thread-other", "/tmp/project");
    useTaskStore.getState().setTaskStatus("thread-other", "running");
    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]).toMatchObject({
      text: "do this next",
      status: "failed",
      error: expect.stringContaining("another conversation is working"),
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.activities).toContainEqual(
      expect.objectContaining({ kind: "warning", title: "Another thread is working in this project folder" }),
    );
    confirmSpy.mockRestore();
  });

  it("removes an optimistic steering message when explicit Cursor steering fails", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("steer failed"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.steerMessage("change direction"); });

    expect(delivered).toBe(false);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toEqual([]);
    expect(deps.setError).toHaveBeenLastCalledWith("steer failed");
  });

  it("cleans up a failed local-provider start so the thread can retry", async () => {
    cursor.startCursorTurn.mockRejectedValueOnce(new Error("provider unavailable"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const deps = context();
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.sendMessage("build it"); });

    expect(delivered).toBe(false);
    expect(deps.discardRunCheckpoint).toHaveBeenCalledWith(CURSOR_THREAD.id);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toEqual([]);
    expect(useTaskStore.getState().statuses[CURSOR_THREAD.id]).toBe("error");
    expect(deps.setStatus).toHaveBeenCalledWith("Ready");
    expect(deps.setError).toHaveBeenLastCalledWith("provider unavailable");
  });

  it("does not resurrect a turn whose result beat the start response", async () => {
    cursor.startCursorTurn.mockImplementationOnce(async () => {
      const store = useTaskStore.getState();
      store.setActiveTurn(CURSOR_THREAD.id, "turn-fast");
      store.setTaskStatus(CURSOR_THREAD.id, "running");
      store.completeTurn(CURSOR_THREAD.id, "turn-fast", "completed");
      return { turnId: "turn-fast", cursorSessionId: "session-fast" };
    });
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const deps = context();
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = false;
    await act(async () => { delivered = await result.current.sendMessage("answer quickly"); });

    const task = useTaskStore.getState().tasks[CURSOR_THREAD.id];
    expect(delivered).toBe(true);
    expect(task.activeTurnId).toBeUndefined();
    expect(task.status).toBe("completed");
    expect(task.lastCompletedTurnId).toBe("turn-fast");
    expect(cursor.interruptCursorTurn).not.toHaveBeenCalled();
  });
});

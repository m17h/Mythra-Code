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

import { useTurnRunner, type TurnRunnerContext } from "./useTurnRunner";

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

  it("removes an optimistic steering message when Cursor rejects it", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("steer failed"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.sendMessage("change direction"); });

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
});

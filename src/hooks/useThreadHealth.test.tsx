import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { Thread } from "../types";

const codex = vi.hoisted(() => ({ rpc: vi.fn() }));
const claude = vi.hoisted(() => ({ isClaudeTurnActive: vi.fn() }));
const cursor = vi.hoisted(() => ({ isCursorTurnActive: vi.fn() }));

vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", () => claude);
vi.mock("../lib/cursor", () => cursor);

import { terminalTurnStatus, THREAD_HEALTH_STALE_MS, useThreadHealth } from "./useThreadHealth";

const CURSOR_THREAD: Thread = {
  id: "thread-cursor",
  name: null,
  preview: "Cursor",
  cwd: "/tmp/project",
  updatedAt: 1,
  modelProvider: "cursor",
};

function makeStaleWorkingTask(threadId: string, turnId?: string): void {
  useTaskStore.getState().ensureTask(threadId, "/tmp/project");
  if (turnId) useTaskStore.getState().setActiveTurn(threadId, turnId);
  useTaskStore.getState().setTaskStatus(threadId, "running");
  useTaskStore.setState((state) => ({
    tasks: {
      ...state.tasks,
      [threadId]: { ...state.tasks[threadId], updatedAt: Date.now() - THREAD_HEALTH_STALE_MS - 1 },
    },
  }));
}

describe("useThreadHealth", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => vi.useRealTimers());

  it("maps only terminal turn states", () => {
    expect(terminalTurnStatus({ id: "1", items: [], status: "completed" })).toBe("completed");
    expect(terminalTurnStatus({ id: "2", items: [], status: "interrupted" })).toBe("interrupted");
    expect(terminalTurnStatus({ id: "3", items: [], status: "failed" })).toBe("error");
    expect(terminalTurnStatus({ id: "4", items: [], status: "inProgress" })).toBeNull();
  });

  it("safely interrupts a local-provider thread after its process disappears", async () => {
    cursor.isCursorTurnActive.mockResolvedValue(false);
    makeStaleWorkingTask(CURSOR_THREAD.id);
    renderHook(() => useThreadHealth({ runtimeAvailable: false, threadFor: () => CURSOR_THREAD }));

    act(() => fireEvent.focus(window));

    await waitFor(() => expect(useTaskStore.getState().statuses[CURSOR_THREAD.id]).toBe("interrupted"));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.activities.at(-1)).toMatchObject({
      title: "Thread status recovered",
    });
  });

  it("leaves a live Codex turn alone and applies its eventual terminal state", async () => {
    const thread: Thread = { ...CURSOR_THREAD, id: "thread-codex", modelProvider: "openai" };
    codex.rpc
      .mockResolvedValueOnce({ thread: { ...thread, turns: [{ id: "turn-1", items: [], status: "inProgress" }] } })
      .mockResolvedValueOnce({ thread: { ...thread, turns: [{ id: "turn-1", items: [], status: "failed" }] } });
    makeStaleWorkingTask(thread.id, "turn-1");
    renderHook(() => useThreadHealth({ runtimeAvailable: true, threadFor: () => thread }));

    act(() => fireEvent.focus(window));
    await waitFor(() => expect(codex.rpc).toHaveBeenCalledTimes(1));
    expect(useTaskStore.getState().statuses[thread.id]).toBe("running");

    act(() => fireEvent.focus(window));
    await waitFor(() => expect(useTaskStore.getState().statuses[thread.id]).toBe("error"));
  });

  it("does not apply a terminal status from a different Codex turn", async () => {
    const thread: Thread = { ...CURSOR_THREAD, id: "thread-codex-newer", modelProvider: "openai" };
    codex.rpc.mockResolvedValue({
      thread: { ...thread, turns: [{ id: "turn-old", items: [], status: "completed" }] },
    });
    makeStaleWorkingTask(thread.id, "turn-new");
    renderHook(() => useThreadHealth({ runtimeAvailable: true, threadFor: () => thread }));

    await waitFor(() => expect(codex.rpc).toHaveBeenCalled());
    expect(useTaskStore.getState().statuses[thread.id]).toBe("running");
    expect(useTaskStore.getState().tasks[thread.id]?.activeTurnId).toBe("turn-new");
  });
});

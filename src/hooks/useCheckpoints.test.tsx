import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { CheckpointRecord } from "../lib/checkpoints";

const checkpointApi = vi.hoisted(() => ({
  completeCheckpointSnapshot: vi.fn(),
  createCheckpointSnapshot: vi.fn(),
  deleteCheckpointSnapshot: vi.fn(),
  readCheckpointDiff: vi.fn(),
  restoreCheckpointSnapshot: vi.fn(),
}));

vi.mock("../lib/checkpoints", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/checkpoints")>(),
  ...checkpointApi,
}));

import { useCheckpoints, type CheckpointsContext } from "./useCheckpoints";

function context(overrides: Partial<CheckpointsContext> = {}): CheckpointsContext {
  return {
    chatWorkspacePath: "/tmp/chat",
    activeThread: null,
    activeProject: { id: "project-1", name: "Project", path: "/tmp/project" },
    activeThreadId: null,
    activeExecutionPath: "/tmp/project",
    defaultProvider: "openai",
    threadModels: { "thread-1": "gpt-test" },
    knownThreadsRef: { current: {
      "thread-1": {
        id: "thread-1",
        name: "Test thread",
        preview: "Preview",
        cwd: "/tmp/project",
        updatedAt: 1,
        modelProvider: "openai",
      },
    } },
    threadProjectBindingsRef: { current: { "thread-1": "/tmp/project" } },
    threadWorktreesRef: { current: {} },
    persistThreadWorktrees: vi.fn(),
    refreshDiffFor: vi.fn(async () => undefined),
    setError: vi.fn(),
    setTransientStatus: vi.fn(),
    ...overrides,
  };
}

function checkpoint(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    id: "checkpoint-1",
    threadId: "thread-1",
    workspacePath: "/tmp/project",
    threadLabel: "Test thread",
    provider: "openai",
    model: "gpt-test",
    label: "Run: test",
    createdAt: 1,
    status: "ready",
    beforeCommit: "before",
    afterCommit: "after",
    ...overrides,
  };
}

describe("useCheckpoints", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTaskStore();
    vi.clearAllMocks();
    checkpointApi.createCheckpointSnapshot.mockResolvedValue({
      repoRoot: "/tmp/project",
      commit: "before",
      fileCount: 2,
      branch: "main",
      head: "head",
    });
    checkpointApi.completeCheckpointSnapshot.mockResolvedValue({
      snapshot: { commit: "after", fileCount: 3 },
      changedFiles: 1,
      additions: 4,
      deletions: 2,
    });
    checkpointApi.deleteCheckpointSnapshot.mockResolvedValue(undefined);
  });

  it("captures and finalizes the automatic checkpoint for a model run", async () => {
    const deps = context();
    const { result } = renderHook(() => useCheckpoints(deps));

    let id: string | undefined;
    await act(async () => {
      id = await result.current.beginRunCheckpoint("thread-1", "/tmp/project", "test the app", "cursor", "grok-4.5");
    });
    await act(async () => {
      await result.current.finalizeRunCheckpoint("thread-1", "turn-1");
    });

    expect(id).toBeTruthy();
    expect(checkpointApi.createCheckpointSnapshot).toHaveBeenCalledWith(id, "/tmp/project", "Run: test the app · before");
    expect(checkpointApi.completeCheckpointSnapshot).toHaveBeenCalledWith(id, "/tmp/project", "Run: test the app · completed");
    expect(result.current.checkpoints[0]).toMatchObject({
      id,
      provider: "cursor",
      model: "grok-4.5",
      status: "ready",
      turnId: "turn-1",
      beforeCommit: "before",
      afterCommit: "after",
      additions: 4,
      deletions: 2,
    });
    expect(result.current.checkpointHeads["/tmp/project"]).toEqual({ checkpointId: id, position: "after" });
  });

  it("disables repeated snapshot attempts for an unsupported workspace", async () => {
    checkpointApi.createCheckpointSnapshot.mockRejectedValueOnce(new Error("Checkpoints require a Git repository"));
    useTaskStore.getState().ensureTask("thread-1", "/tmp/project");
    const { result } = renderHook(() => useCheckpoints(context()));

    await act(async () => {
      expect(await result.current.beginRunCheckpoint("thread-1", "/tmp/project", "first", "openai", "gpt-test")).toBeUndefined();
      expect(await result.current.beginRunCheckpoint("thread-1", "/tmp/project", "second", "openai", "gpt-test")).toBeUndefined();
    });

    expect(checkpointApi.createCheckpointSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.checkpoints).toEqual([]);
    expect(useTaskStore.getState().tasks["thread-1"]?.activities[0]).toMatchObject({
      kind: "warning",
      title: "Automatic checkpoints unavailable",
    });
  });

  it("removes a deleted thread's records, heads, and backing snapshots", async () => {
    const saved = checkpoint();
    localStorage.setItem("kiwi.checkpoints", JSON.stringify([saved, checkpoint({ id: "keep", threadId: "thread-2" })]));
    localStorage.setItem("kiwi.checkpointHeads", JSON.stringify({
      "/tmp/project": { checkpointId: saved.id, position: "after" },
      "/tmp/keep": { checkpointId: "keep", position: "after" },
    }));
    const { result } = renderHook(() => useCheckpoints(context()));

    act(() => result.current.forgetThreadCheckpoints("thread-1"));

    expect(result.current.checkpoints.map((entry) => entry.id)).toEqual(["keep"]);
    expect(result.current.checkpointHeads).toEqual({ "/tmp/keep": { checkpointId: "keep", position: "after" } });
    await waitFor(() => expect(checkpointApi.deleteCheckpointSnapshot).toHaveBeenCalledWith(saved.id, "/tmp/project"));
  });

  it("cleans up a half-created checkpoint recovered after restart", async () => {
    const incomplete = checkpoint({ status: "running", beforeCommit: undefined, afterCommit: undefined });
    localStorage.setItem("kiwi.checkpoints", JSON.stringify([incomplete]));

    const { result } = renderHook(() => useCheckpoints(context()));

    await waitFor(() => expect(result.current.checkpoints[0]).toMatchObject({
      id: incomplete.id,
      status: "failed",
      error: "Mythra Code closed before the initial project snapshot finished.",
    }));
    await waitFor(() => expect(checkpointApi.deleteCheckpointSnapshot).toHaveBeenCalledWith(incomplete.id, "/tmp/project"));
  });
});

import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { CheckpointRecord } from "../lib/checkpoints";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import { routeCodexEvent, type CodexEventContext } from "../lib/codexEvents";
import type { ScheduleRunRecord, ScheduledTask } from "../types";

const checkpointApi = vi.hoisted(() => ({
  completeCheckpointSnapshot: vi.fn(),
  createCheckpointSnapshot: vi.fn(),
  deleteCheckpointSnapshot: vi.fn(),
  readCheckpointDiff: vi.fn(),
  restoreCheckpointSnapshot: vi.fn(),
}));
const schedulerApi = vi.hoisted(() => ({ rpc: vi.fn(), auditEvent: vi.fn(async () => undefined) }));
vi.mock("../lib/codex", () => ({
  ...schedulerApi,
  runtimeInstanceId: async () => "checkpoint-fixture-runtime",
  runtimeThreadState: async () => ({ instance: "checkpoint-fixture-runtime", loaded: false }),
}));
vi.mock("../lib/currentLearnedPreferences", () => ({ appendCurrentLearnedPreferences: async (prompt: string) => prompt }));

vi.mock("../lib/checkpoints", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/checkpoints")>(),
  ...checkpointApi,
}));

import { useCheckpoints, type CheckpointsContext } from "./useCheckpoints";
import { useScheduler } from "./useScheduler";

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
  it("keeps checkpoint restoration from rewriting a pull request operation's files", async () => {
    const ctx = context();
    const { result } = renderHook(() => useCheckpoints(ctx));
    const lease = acquirePullRequestMutation("/tmp/project")!;
    try {
      await act(() => result.current.restoreCheckpoint(checkpoint(), "before"));
      expect(checkpointApi.restoreCheckpointSnapshot).not.toHaveBeenCalled();
      expect(ctx.setError).toHaveBeenCalledWith(expect.stringContaining("pull request operation"));
    } finally { releasePullRequestMutation(lease); }
  });

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
    schedulerApi.rpc.mockReset();
  });

  it("finalizes the retained scheduled checkpoint when native completion arrives after an acknowledgement timeout", async () => {
    const ctx = context();
    const runs: ScheduleRunRecord[] = [];
    const schedule: ScheduledTask = {
      id: "scheduled", name: "Scheduled", prompt: "Check files", projectId: "project-1",
      intervalMinutes: 60, enabled: true, nextRunAt: 0, run: scheduleRunSnapshot(DEFAULT_SETTINGS),
    };
    schedulerApi.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start") throw new Error("Codex App Server timed out while handling turn/start");
      return { thread: { id: "thread-1" } };
    });
    const { result, unmount } = renderHook(() => {
      const checkpoints = useCheckpoints(ctx);
      useScheduler({
        schedules: [schedule], updateSchedule: vi.fn(), projects: [ctx.activeProject!], settings: DEFAULT_SETTINGS,
        runtimeAvailable: true, chatGptConnected: true, openRouterReady: false,
        ensureSkillRoots: async () => undefined, resolveSkillPrompt: async (prompt) => prompt,
        bindThreadToProject: vi.fn(), beginRunCheckpoint: checkpoints.beginRunCheckpoint,
        discardRunCheckpoint: checkpoints.discardRunCheckpoint, onThreadStarted: vi.fn(), recordRun: (run) => { runs.push(run); },
      });
      return checkpoints;
    });
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("delivery could not be confirmed") });
    expect(result.current.checkpoints).toHaveLength(1);
    expect(checkpointApi.deleteCheckpointSnapshot).not.toHaveBeenCalled();
    const completion: Promise<void>[] = [];
    const events: CodexEventContext = {
      bindingFor: () => "/tmp/project", providerFor: () => "openai", respond: async () => undefined,
      audit: vi.fn(), onStatus: vi.fn(), onError: vi.fn(), onAuthRequired: vi.fn(), onAuthSuspected: vi.fn(),
      onRateLimits: vi.fn(), onTerminalOutput: vi.fn(), onApprovalRequested: vi.fn(), onAccountUpdated: vi.fn(),
      onLoginFailed: vi.fn(), onProviderToolCompatibilityError: vi.fn(), onNativeAgentDiscovered: vi.fn(),
      onTurnCompleted: (threadId, turn) => { completion.push(result.current.finalizeRunCheckpoint(threadId, turn?.id)); },
    };
    await act(async () => {
      routeCodexEvent({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "late-turn", items: [] } } }, events);
      routeCodexEvent({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "late-turn", status: "completed", items: [] } } }, events);
      await Promise.all(completion);
    });
    expect(result.current.checkpoints[0]).toMatchObject({ status: "ready", turnId: "late-turn", beforeCommit: "before", afterCommit: "after" });
    expect(checkpointApi.completeCheckpointSnapshot).toHaveBeenCalledOnce();
    expect(checkpointApi.deleteCheckpointSnapshot).not.toHaveBeenCalled();
    unmount();
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

  it("keeps a newer checkpoint when an earlier preparation discards its own id", async () => {
    const { result } = renderHook(() => useCheckpoints(context()));
    let first: string | undefined;
    let second: string | undefined;
    await act(async () => {
      first = await result.current.beginRunCheckpoint("thread-1", "/tmp/project", "first", "openai", "gpt-test");
      second = await result.current.beginRunCheckpoint("thread-1", "/tmp/project", "second", "openai", "gpt-test");
    });
    act(() => result.current.discardRunCheckpoint("thread-1", first));
    expect(checkpointApi.deleteCheckpointSnapshot).not.toHaveBeenCalled();
    expect(result.current.checkpoints.map(({ id }) => id)).toContain(second);
    await act(async () => result.current.discardRunCheckpoint("thread-1", second));
    expect(checkpointApi.deleteCheckpointSnapshot).toHaveBeenCalledExactlyOnceWith(second, "/tmp/project");
    expect(result.current.checkpoints.map(({ id }) => id)).not.toContain(second);
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

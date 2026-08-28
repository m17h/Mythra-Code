import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { ScheduleRunRecord, ScheduledTask } from "../types";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  auditEvent: vi.fn(() => Promise.resolve()),
}));

vi.mock("../lib/codex", () => codex);

import { useScheduler, type SchedulerDeps } from "./useScheduler";

function testSchedule(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "schedule-1",
    name: "Nightly checks",
    prompt: "Run the checks",
    projectId: "project-1",
    intervalMinutes: 60,
    enabled: true,
    nextRunAt: 0,
    run: scheduleRunSnapshot(DEFAULT_SETTINGS),
    ...overrides,
  };
}

function testSchedulerDeps(
  schedule: ScheduledTask,
  runs: ScheduleRunRecord[],
  overrides: Partial<SchedulerDeps> = {},
): SchedulerDeps {
  return {
    schedules: [schedule],
    updateSchedule: vi.fn(),
    projects: [{ id: "project-1", name: "Project", path: "/tmp/project" }],
    settings: DEFAULT_SETTINGS,
    runtimeAvailable: true,
    chatGptConnected: true,
    openRouterReady: false,
    ensureSkillRoots: vi.fn(async () => undefined),
    bindThreadToProject: vi.fn(),
    beginRunCheckpoint: vi.fn(async () => undefined),
    discardRunCheckpoint: vi.fn(),
    onThreadStarted: vi.fn(),
    recordRun: (run) => {
      runs.push(run);
    },
    ...overrides,
  };
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

describe("useScheduler", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.useFakeTimers();
    codex.rpc.mockReset();
    codex.auditEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a due schedule and records the run", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule(), runs)));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.anything());
    expect(runs.at(-1)).toMatchObject({ status: "started", threadId: "thread-1" });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("starting");
  });

  it("continues the previous thread when the schedule requests it", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/resume") return Promise.resolve({ thread: { id: "thread-existing" } });
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({
      threadMode: "reuse",
      lastThreadId: "thread-existing",
    }), runs)));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("thread/resume", expect.objectContaining({
      threadId: "thread-existing",
      cwd: "/tmp/project",
    }));
    expect(codex.rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "thread-existing" }));
    expect(runs.at(-1)).toMatchObject({ status: "started", threadId: "thread-existing" });
  });

  it("starts a replacement reusable thread when the previous one was deleted", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/resume") return Promise.reject(new Error("thread not found"));
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-replacement" } });
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({
      threadMode: "reuse",
      lastThreadId: "thread-deleted",
    }), runs)));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("thread/resume", expect.anything());
    expect(codex.rpc).toHaveBeenCalledWith("thread/start", expect.anything());
    expect(runs.at(-1)).toMatchObject({ status: "started", threadId: "thread-replacement" });
  });

  it("waits rather than overlapping turns in a reusable thread", async () => {
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" });
    const updateSchedule = vi.fn();
    useTaskStore.getState().ensureTask("thread-existing", "/tmp/project");
    useTaskStore.getState().setTaskStatus("thread-existing", "running");
    renderHook(() => useScheduler(testSchedulerDeps(schedule, runs, { updateSchedule })));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    const patch = updateSchedule.mock.calls[0][1] as (current: ScheduledTask) => ScheduledTask;
    expect(patch(schedule).nextRunAt).toBeGreaterThan(schedule.nextRunAt);
  });

  it("does not strand the thread in starting when turn/start fails", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      if (method === "turn/start") return Promise.reject(new Error("model unavailable"));
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule(), runs)));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(runs.at(-1)).toMatchObject({ status: "failed", threadId: "thread-1" });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("error");
    expect(useTaskStore.getState().tasks["thread-1"].error).toContain("model unavailable");
  });

  it("disables a schedule whose project was removed and records why", async () => {
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule({ projectId: "missing-project" });
    const updateSchedule = vi.fn();
    renderHook(() => useScheduler(testSchedulerDeps(schedule, runs, { updateSchedule })));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).not.toHaveBeenCalled();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", error: expect.stringContaining("disabled") });
    expect(updateSchedule).toHaveBeenCalledWith("schedule-1", expect.any(Function));
    const patch = updateSchedule.mock.calls[0][1] as (current: ScheduledTask) => ScheduledTask;
    expect(patch(schedule).enabled).toBe(false);
  });
});

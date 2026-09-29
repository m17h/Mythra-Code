import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { ScheduleRunRecord, ScheduledTask, SkillDependencyReport } from "../types";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "../lib/skillDependencies";

const DEPENDENCIES: SkillDependencyReport = {
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [{ nodeId: "policy", channel: "system", name: "policy" }],
  nodes: [{ id: "policy", kind: "skill", name: "policy", path: "/skills/policy.md", status: "loaded", characterCount: 12, depth: 0 }], edges: [], issues: [],
};

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
    chatWorkspace: { id: "openkiwi-normal-chats", name: "Chats", path: "/tmp/chats", isChat: true },
    settings: DEFAULT_SETTINGS,
    runtimeAvailable: true,
    chatGptConnected: true,
    openRouterReady: false,
    ensureSkillRoots: vi.fn(async () => undefined),
    resolveSkillPrompt: vi.fn(async (message: string) => message),
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

  it("delivers resolved skill context while storing the raw scheduled prompt", async () => {
    const runs: ScheduleRunRecord[] = [];
    const resolveSkillPrompt = vi.fn(async () => "resolved schedule skill context");
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "thread-1" } });
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(
      testSchedule({ prompt: "@review the release" }),
      runs,
      { resolveSkillPrompt },
    )));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(resolveSkillPrompt).toHaveBeenCalledExactlyOnceWith("@review the release");
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [{ type: "text", text: "resolved schedule skill context", text_elements: [] }],
    }));
    expect(useTaskStore.getState().tasks["thread-1"].messages.at(-1)?.text).toBe("@review the release");
  });

  it.each(["new", "reuse"] as const)("resolves user and captured system skills before scheduled %s thread preparation", async (mode) => {
    const runs: ScheduleRunRecord[] = [];
    const skillReferences = [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }];
    const resolveSkillPrompts = vi.fn(async () => ({ prompt: "resolved scheduled user", systemPrompt: "resolved scheduled policy", skillReferences, skillsFolder: "/skills", skillDependencies: DEPENDENCIES }));
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), systemPrompt: "Use @policy" };
    codex.rpc.mockImplementation((method: string) => method.startsWith("thread/") ? Promise.resolve({ thread: { id: "thread-1" }, model: run.model }) : Promise.resolve({}));
    const deps = testSchedulerDeps(testSchedule({ prompt: "Use @review", run, threadMode: mode, lastThreadId: mode === "reuse" ? "thread-1" : undefined }), runs, { resolveSkillPrompts });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use @review", "Use @policy");
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    const preparation = codex.rpc.mock.calls.find(([method]) => method === (mode === "new" ? "thread/start" : "thread/resume"))!;
    expect(preparation[1].baseInstructions).toBe("");
    const turn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")!;
    expect(turn[1].collaborationMode.settings.developer_instructions).toContain("resolved scheduled policy");
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [{ type: "text", text: "resolved scheduled user", text_elements: [] }] }));
    expect(useTaskStore.getState().tasks["thread-1"].messages.at(-1)?.text).toBe("Use @review");
    expect(useTaskStore.getState().tasks["thread-1"].messages.at(-1)).toMatchObject({ skillReferences, skillsFolder: "/skills", skillDependencies: DEPENDENCIES });
    expect(run.systemPrompt).toBe("Use @policy");
  });

  it.each(["openai", "openrouter", "lmstudio"] as const)("rejects a %s schedule's graph before runtime roots, thread preparation, or checkpoint", async (provider) => {
    const runs: ScheduleRunRecord[] = [];
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), provider, model: "selected/model" };
    const deps = testSchedulerDeps(testSchedule({ run }), runs, {
      openRouterReady: true, lmStudioReady: true,
      resolveSkillPrompts: async () => { throw new SkillDependencyError({ ...DEPENDENCIES, issues: [{ code: "missing-document", message: "Missing guide", chain: ["policy", "guide.md"] }] }); },
    });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(deps.ensureSkillRoots).not.toHaveBeenCalled();
    expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("policy → guide.md: Missing guide") });
  });

  it("retains the full bounded dependency reason chain in a failed scheduled run", async () => {
    const runs: ScheduleRunRecord[] = [];
    const error = new SkillDependencyError({ ...DEPENDENCIES, issues: [{ code: "missing-document", message: "Missing final guide", chain: ["policy", "folder-".repeat(35) + "guide.md"] }] });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule(), runs, { resolveSkillPrompts: async () => { throw error; } })));
    await act(async () => { await flushMicrotasks(); });
    expect(runs.at(-1)?.error).toBe(error.message);
    expect(runs.at(-1)?.error).toContain("Missing final guide");
    expect(codex.rpc).not.toHaveBeenCalled();
  });

  it("uses the actual top-level scheduled thread model when its saved model selects a provider default", async () => {
    const runs: ScheduleRunRecord[] = [];
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), model: "", systemPrompt: "" };
    codex.rpc.mockImplementation((method: string) => method === "thread/start" ? Promise.resolve({ thread: { id: "thread-1" }, model: "server-chosen-model" }) : Promise.resolve({}));
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run }), runs)));
    await act(async () => { await flushMicrotasks(); });
    const turn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")!;
    expect(turn[1].collaborationMode.settings.model).toBe("server-chosen-model");
    expect(turn[1].collaborationMode.settings.developer_instructions).toContain("Current effective app system prompt: none");
  });

  it("runs a projectless schedule in the normal Chats workspace", async () => {
    const runs: ScheduleRunRecord[] = [];
    const bindThreadToProject = vi.fn();
    const onThreadStarted = vi.fn();
    codex.rpc.mockImplementation((method: string) => {
      if (method === "thread/start") return Promise.resolve({ thread: { id: "chat-thread" } });
      return Promise.resolve({});
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ projectId: null }), runs, {
      bindThreadToProject,
      onThreadStarted,
    })));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: "/tmp/chats" }));
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ cwd: "/tmp/chats", threadId: "chat-thread" }));
    expect(bindThreadToProject).toHaveBeenCalledWith("chat-thread", "/tmp/chats");
    expect(onThreadStarted).toHaveBeenCalledWith(expect.objectContaining({ name: "Chats", isChat: true }));
    expect(runs.at(-1)).toMatchObject({ status: "started", projectId: null, threadId: "chat-thread" });
  });

  it("waits for the normal Chats workspace to initialize without disabling the schedule", async () => {
    const runs: ScheduleRunRecord[] = [];
    const updateSchedule = vi.fn();
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ projectId: null }), runs, {
      chatWorkspace: null,
      updateSchedule,
    })));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(codex.rpc).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
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

import { act, renderHook } from "@testing-library/react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import { forgetSubagentCapabilities, recordSubagentCapabilities, subagentCapabilitySignature } from "../lib/threadCapabilities";
import type { ScheduleRunRecord, ScheduledTask, SkillDependencyReport } from "../types";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "../lib/skillDependencies";

const DEPENDENCIES: SkillDependencyReport = {
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [{ nodeId: "policy", channel: "system", name: "policy" }],
  nodes: [{ id: "policy", kind: "skill", name: "policy", path: "/skills/policy.md", status: "loaded", characterCount: 12, depth: 0 }], edges: [], issues: [],
};

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  auditEvent: vi.fn(() => Promise.resolve()),
  runtimeInstanceId: vi.fn(async () => "schedule-runtime"),
  runtimeThreadState: vi.fn(async () => ({ instance: "schedule-runtime", loaded: false })),
}));

vi.mock("../lib/codex", () => codex);
const preferences = vi.hoisted(() => ({
  scopes: {} as Record<string, Partial<{ enabled: boolean; markdown: string }>>,
  hydrated: true,
  load: vi.fn(async () => {}),
}));
vi.mock("../lib/preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => preferences.hydrated,
  loadPreferenceLearning: () => preferences.load(),
  getPreferenceLearningScope: (scopeKey: string) => ({ scopeKey, enabled: false, markdown: "", ...preferences.scopes[scopeKey] }),
}));

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
    preferences.scopes = {};
    preferences.hydrated = true;
    preferences.load.mockReset().mockResolvedValue(undefined);
    resetTaskStore();
    forgetSubagentCapabilities();
    vi.useFakeTimers();
    codex.rpc.mockReset();
    codex.auditEvent.mockClear();
    codex.runtimeInstanceId.mockReset().mockResolvedValue("schedule-runtime");
    codex.runtimeThreadState.mockReset().mockResolvedValue({ instance: "schedule-runtime", loaded: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const preparationStages = ["skills", "resolved skills", "preferences", "runtime roots", "thread start", "thread resume", "checkpoint"] as const;
  it.each(preparationStages.flatMap((stage) => ["disable", "delete", "retarget", "convert to Chats"].map((change) => [stage, change] as const)))(
    "revokes a pending schedule during %s after %s",
    async (stage, change) => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const schedule = testSchedule(stage === "thread resume" ? { threadMode: "reuse", lastThreadId: "thread-1" } : {});
      const runs: ScheduleRunRecord[] = [];
      codex.rpc.mockImplementation(async (method: string) => {
        if (method === "thread/start" || method === "thread/resume") {
          if (stage === "thread start" && method === "thread/start" || stage === "thread resume" && method === "thread/resume") await pending;
          return { thread: { id: "thread-1" } };
        }
        return {};
      });
      if (stage === "preferences") {
        preferences.hydrated = false;
        preferences.load.mockImplementation(async () => { await pending; preferences.hydrated = true; });
      }
      const deps = testSchedulerDeps(schedule, runs, {
        resolveSkillPrompt: vi.fn(async (prompt) => { if (stage === "skills") await pending; return prompt; }),
        ...(stage === "resolved skills" ? { resolveSkillPrompts: vi.fn(async (prompt, systemPrompt) => { await pending; return { prompt, systemPrompt }; }) } : {}),
        ensureSkillRoots: vi.fn(async () => { if (stage === "runtime roots") await pending; }),
        beginRunCheckpoint: vi.fn(async () => { if (stage === "checkpoint") await pending; return "owned-checkpoint"; }),
      });
      const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
      await act(async () => { await flushMicrotasks(30); });
      const schedules = change === "delete" ? [] : [{ ...schedule, ...(change === "disable" ? { enabled: false } : { projectId: change === "convert to Chats" ? null : "project-2" }) }];
      rerender({ ...deps, schedules });
      await act(async () => { release(); await flushMicrotasks(30); });

      expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
      expect(runs).toHaveLength(0);
      expect(deps.updateSchedule).not.toHaveBeenCalled();
      expect(deps.onThreadStarted).not.toHaveBeenCalled();
      if (stage === "checkpoint") {
        expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-1", "owned-checkpoint");
        expect(useTaskStore.getState().statuses["thread-1"]).toBe("interrupted");
        expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(0);
      } else expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    },
  );

  it("does not revive preparation when a schedule is disabled and enabled again", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const schedule = testSchedule();
    const deps = testSchedulerDeps(schedule, [], { resolveSkillPrompt: async (prompt) => { await pending; return prompt; } });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    rerender({ ...deps, schedules: [{ ...schedule, enabled: false }] });
    rerender(deps);
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
  });

  it.each(["changed path", "removed project", "changed Chats path"])("revokes preparation for a %s", async (change) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const schedule = testSchedule(change === "changed Chats path" ? { projectId: null } : {});
    const deps = testSchedulerDeps(schedule, [], { resolveSkillPrompt: async (prompt) => { await pending; return prompt; } });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    rerender({
      ...deps,
      projects: change === "removed project" ? [] : [{ ...deps.projects[0], path: "/tmp/moved-project" }],
      chatWorkspace: change === "changed Chats path" ? { ...deps.chatWorkspace!, path: "/tmp/moved-chats" } : deps.chatWorkspace,
    });
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(deps.updateSchedule).not.toHaveBeenCalled();
  });

  it("does not start a fallback thread after a revoked resume rejects", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const schedule = testSchedule({ threadMode: "reuse", lastThreadId: "thread-1" });
    const deps = testSchedulerDeps(schedule, []);
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? pending : { thread: { id: "fallback" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    rerender({ ...deps, schedules: [] });
    await act(async () => { reject(new Error("thread not found")); await flushMicrotasks(30); });
    expect(codex.rpc.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
  });

  it("revokes pending preparation when the scheduler unmounts", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const deps = testSchedulerDeps(testSchedule(), [], { resolveSkillPrompt: async (prompt) => { await pending; return prompt; } });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { unmount } = renderHook(() => useScheduler(deps));
    unmount();
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
  });

  it("does not discard another run's checkpoint when preparation created none", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const deps = testSchedulerDeps(testSchedule(), [], {
      beginRunCheckpoint: async () => { await pending; return undefined; },
    });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    rerender({ ...deps, schedules: [] });
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
  });

  it("does not interrupt a turn accepted elsewhere while a cancelled checkpoint is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const deps = testSchedulerDeps(testSchedule(), [], {
      beginRunCheckpoint: async () => { await pending; return "owned-checkpoint"; },
    });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    rerender({ ...deps, schedules: [] });
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it("keeps a dispatched turn and its checkpoint when disabling during its acknowledgement", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const schedule = testSchedule();
    const runs: ScheduleRunRecord[] = [];
    const deps = testSchedulerDeps(schedule, runs);
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start") { await pending; return {}; }
      return { thread: { id: "thread-1" } };
    });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    rerender({ ...deps, schedules: [{ ...schedule, enabled: false }] });
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("starting");
    expect(runs).toEqual([expect.objectContaining({ status: "started", threadId: "thread-1" })]);
    expect(deps.updateSchedule).not.toHaveBeenCalled();
  });

  it.each(["skills", "resume", "checkpoint", "workflow"])("does not overwrite or dispatch into a reused thread that became busy during %s", async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const schedule = testSchedule({ threadMode: "reuse", lastThreadId: "thread-1" });
    const deps = testSchedulerDeps(schedule, [], {
      resolveSkillPrompt: async (prompt) => { if (stage === "skills" || stage === "workflow") await pending; return prompt; },
      beginRunCheckpoint: vi.fn(async () => { if (stage === "checkpoint") await pending; return "owned-checkpoint"; }),
    });
    useTaskStore.getState().ensureTask("thread-1", "/tmp/project");
    codex.rpc.mockImplementation(async () => { if (stage === "resume") await pending; return { thread: { id: "thread-1" } }; });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    if (stage === "workflow") useTaskStore.getState().setWorkflowOwner("thread-1", { runId: "workflow-run", workflowId: "workflow" });
    else {
      useTaskStore.getState().setActiveTurn("thread-1", "user-turn");
      useTaskStore.getState().setTaskStatus("thread-1", "running");
    }
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
    expect(useTaskStore.getState().statuses["thread-1"]).toBe(stage === "workflow" ? "idle" : "running");
    if (stage === "checkpoint") expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-1", "owned-checkpoint");
    else expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
  });

  it.each(["busy", "disable", "delete", "checkpoint failure"])("preserves a workflow's starting reservation during %s checkpoint cleanup", async (change) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const schedule = testSchedule();
    const deps = testSchedulerDeps(schedule, [], {
      beginRunCheckpoint: vi.fn(async () => { await pending; if (change === "checkpoint failure") throw new Error("checkpoint failure"); return "owned-checkpoint"; }),
    });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setWorkflowOwner("thread-1", { workflowId: "workflow", runId: "workflow-run" });
    if (change === "disable") rerender({ ...deps, schedules: [{ ...schedule, enabled: false }] });
    else if (change === "delete") rerender({ ...deps, schedules: [] });
    await act(async () => { release(); await flushMicrotasks(30); });
    expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("starting");
    expect(useTaskStore.getState().workflowOwners["thread-1"]).toEqual({ workflowId: "workflow", runId: "workflow-run" });
  });

  it("does not create a fallback conversation when a rejected resume became busy meanwhile", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const runs: ScheduleRunRecord[] = [];
    const deps = testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-1" }), runs);
    useTaskStore.getState().ensureTask("thread-1", "/tmp/project");
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? pending : { thread: { id: "fallback-thread" } });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setActiveTurn("thread-1", "user-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    await act(async () => { reject(new Error("resume rejected")); await flushMicrotasks(30); });
    expect(codex.rpc.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(runs).toHaveLength(0);
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it.each([false, true].flatMap((disable) => (["running", "completed", "interrupted"] as const).map((status) => [disable, status] as const)))("preserves runtime-accepted work if turn acknowledgement rejects after disabling %s with status %s", async (disable, status) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const schedule = testSchedule();
    const runs: ScheduleRunRecord[] = [];
    const nativePrompt = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [], userMessage: schedule.prompt })}\n</mythra_code_invoked_skills>`;
    const deps = testSchedulerDeps(schedule, runs, {
      beginRunCheckpoint: vi.fn(async () => "owned-checkpoint"),
      resolveSkillPrompts: vi.fn(async () => ({ prompt: nativePrompt, systemPrompt: "Resolved authored policy" })),
    });
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start") return pending;
      return { thread: { id: "thread-1" } };
    });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setActiveTurn("thread-1", "accepted-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.getState().completeMessage("thread-1", { id: "runtime-user-item", role: "user", text: nativePrompt, turnId: "accepted-turn" });
    if (status !== "running") useTaskStore.getState().completeTurn("thread-1", "accepted-turn", status);
    if (disable) rerender({ ...deps, schedules: [{ ...schedule, enabled: false }] });
    await act(async () => { reject(new Error("request acknowledgement timed out")); await flushMicrotasks(30); });
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe(status);
    expect(runs).toEqual([expect.objectContaining({ status: "started", threadId: "thread-1" })]);
  });

  it("does not treat an identical competing user prompt as exact scheduled acceptance", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule();
    const deps = testSchedulerDeps(schedule, runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockImplementation(async (method: string) => method === "turn/start" ? pending : { thread: { id: "thread-1" } });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().appendUserMessage("thread-1", { id: "local-competing-prompt", role: "user", text: schedule.prompt });
    useTaskStore.getState().setActiveTurn("thread-1", "competing-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.getState().completeMessage("thread-1", { id: "native-competing-item", role: "user", text: schedule.prompt, turnId: "competing-turn" });
    await act(async () => { reject(new Error("acknowledgement timed out")); await flushMicrotasks(30); });
    expect(runs).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it("keeps exact scheduled acceptance when a different local followup arrives before acknowledgement fails", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule();
    const deps = testSchedulerDeps(schedule, runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockImplementation(async (method: string) => method === "turn/start" ? pending : { thread: { id: "thread-1" } });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setActiveTurn("thread-1", "accepted-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.getState().completeMessage("thread-1", { id: "native-scheduled-item", role: "user", text: schedule.prompt, turnId: "accepted-turn" });
    useTaskStore.getState().appendUserMessage("thread-1", { id: "local-followup", role: "user", text: "Continue with extra checks" });
    await act(async () => { reject(new Error("acknowledgement timed out")); await flushMicrotasks(30); });
    expect(runs).toEqual([expect.objectContaining({ status: "started", threadId: "thread-1" })]);
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("running");
  });

  it.each([false, true])("records a genuine dispatch rejection and does not claim an unrelated later turn %s", async (unrelated) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const runs: ScheduleRunRecord[] = [];
    const deps = testSchedulerDeps(testSchedule(), runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockImplementation(async (method: string) => method === "turn/start" ? pending : { thread: { id: "thread-1" } });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    if (unrelated) {
      useTaskStore.getState().setActiveTurn("thread-1", "unrelated-turn");
      useTaskStore.getState().setTaskStatus("thread-1", "running");
      useTaskStore.getState().completeMessage("thread-1", { id: "unrelated-runtime-item", role: "user", text: "A different user prompt", turnId: "unrelated-turn" });
    }
    await act(async () => { reject(new Error("explicit turn rejection")); await flushMicrotasks(30); });
    expect(runs).toEqual([expect.objectContaining({ status: "failed" })]);
    if (unrelated) expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    else {
      expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-1", "owned-checkpoint");
      expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(0);
    }
    expect(useTaskStore.getState().statuses["thread-1"]).toBe(unrelated ? "running" : "error");
  });

  it.each([false, true].flatMap((disable) => (["running", "completed", "interrupted"] as const).map((status) => [disable, status] as const)))("keeps ambiguous runtime work without claiming scheduled acceptance after disabling %s with status %s", async (disable, status) => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_, fail) => { reject = fail; });
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule();
    const deps = testSchedulerDeps(schedule, runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockImplementation(async (method: string) => method === "turn/start" ? pending : { thread: { id: "thread-1" } });
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    await act(async () => { await flushMicrotasks(30); });
    useTaskStore.getState().setActiveTurn("thread-1", "unconfirmed-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    if (status !== "running") useTaskStore.getState().completeTurn("thread-1", "unconfirmed-turn", status);
    if (disable) rerender({ ...deps, schedules: [{ ...schedule, enabled: false }] });
    await act(async () => { reject(new Error("request acknowledgement timed out")); await flushMicrotasks(30); });
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe(status);
    expect(runs).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("timed out") })]);
    if (disable) expect(deps.updateSchedule).not.toHaveBeenCalled();
    else {
      const patch = vi.mocked(deps.updateSchedule).mock.calls.at(-1)![1];
      expect(patch(schedule).nextRunAt).toBe(Date.now() + schedule.intervalMinutes * 60_000);
    }
  });

  it.each(["string", "Error"])("retains a checkpoint on native turn/start timeout before any runtime event (%s)", async (kind) => {
    const runs: ScheduleRunRecord[] = [];
    const schedule = testSchedule();
    const message = "Codex App Server timed out while handling turn/start";
    const deps = testSchedulerDeps(schedule, runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start") throw kind === "Error" ? new Error(message) : message;
      return { thread: { id: "thread-1" } };
    });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(useTaskStore.getState().statuses["thread-1"]).toBe("error");
    expect(runs).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("delivery could not be confirmed") })]);
    const patch = vi.mocked(deps.updateSchedule).mock.calls.at(-1)![1];
    expect(patch(schedule).nextRunAt).toBe(Date.now() + schedule.intervalMinutes * 60_000);
    // Delayed native acceptance/completion still updates the retained thread.
    useTaskStore.getState().setActiveTurn("thread-1", "late-turn");
    useTaskStore.getState().setTaskStatus("thread-1", "running");
    useTaskStore.getState().completeMessage("thread-1", { id: "late-user-item", role: "user", text: schedule.prompt, turnId: "late-turn" });
    useTaskStore.getState().completeTurn("thread-1", "late-turn", "completed");
    expect(useTaskStore.getState().tasks["thread-1"].lastCompletedTurnId).toBe("late-turn");
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(runs[0].status).toBe("failed");
  });

  it.each(["started", "failed", "busy"])("does not overwrite a newer edit when a deferred %s schedule updater executes", async (outcome) => {
    const schedule = testSchedule(outcome === "busy" ? { threadMode: "reuse", lastThreadId: "thread-1" } : {});
    const deps = testSchedulerDeps(schedule, []);
    if (outcome === "busy") {
      useTaskStore.getState().ensureTask("thread-1", "/tmp/project");
      useTaskStore.getState().setTaskStatus("thread-1", "running");
    }
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "turn/start" && outcome === "failed") throw new Error("explicit turn rejection");
      return { thread: { id: "thread-1" } };
    });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    const updater = vi.mocked(deps.updateSchedule).mock.calls.at(-1)![1];
    const newer = { ...schedule, prompt: "User edited the prompt", nextRunAt: Date.now() + 7_200_000 };
    expect(updater(newer)).toBe(newer);
    expect(updater({ ...newer, enabled: false })).toEqual({ ...newer, enabled: false });
    expect(updater(schedule)).not.toBe(schedule);
  });

  it("checks revocation immediately before dispatch and removes an undelivered optimistic prompt", async () => {
    const runs: ScheduleRunRecord[] = [];
    const deps = testSchedulerDeps(testSchedule(), runs, { beginRunCheckpoint: vi.fn(async () => "owned-checkpoint") });
    codex.rpc.mockResolvedValue({ thread: { id: "thread-1" } });
    const append = useTaskStore.getState().appendUserMessage;
    const appendSpy = vi.spyOn(useTaskStore.getState(), "appendUserMessage");
    const { rerender } = renderHook((current: SchedulerDeps) => useScheduler(current), { initialProps: deps });
    appendSpy.mockImplementation((...args) => {
      append(...args);
      flushSync(() => rerender({ ...deps, schedules: [] }));
    });
    try {
      await act(async () => { await flushMicrotasks(30); });
      expect(codex.rpc.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
      expect(useTaskStore.getState().tasks["thread-1"].messages).toHaveLength(0);
      expect(useTaskStore.getState().statuses["thread-1"]).toBe("interrupted");
      expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-1", "owned-checkpoint");
      expect(runs).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it.each([null, "project-1"])("uses live app and target-project preferences for deferred schedule %s", async (projectId) => {
    preferences.scopes = {
      app: { enabled: true, markdown: "- App preference with @trap" },
      "project:project-1": { enabled: true, markdown: "- Target project preference" },
      "project:other": { enabled: true, markdown: "- Unrelated project preference" },
    };
    const runs: ScheduleRunRecord[] = [];
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), systemPrompt: "Saved @authored" };
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Resolved authored policy" }));
    codex.rpc.mockImplementation(async (method: string) => method.startsWith("thread/") ? { thread: { id: "thread-1" } } : {});
    const deps = testSchedulerDeps(testSchedule({ projectId, run }), runs, { resolveSkillPrompts });
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Run the checks", "Saved @authored");
    const instructions = codex.rpc.mock.calls.find(([method]) => method === "turn/start")![1].collaborationMode.settings.developer_instructions;
    expect(instructions).toContain("Resolved authored policy");
    expect(instructions).toContain("App preference with ＠trap");
    expect(instructions.includes("Target project preference")).toBe(projectId !== null);
    expect(instructions).not.toContain("Unrelated project preference");
    expect(run.systemPrompt).toBe("Saved @authored");
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

  it.each([false, true])("records new scheduled threads off before a failing turn, including reuse fallback %s", async (reuse) => {
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), subagentsEnabled: true, autoCompactTokens: 100_000 };
    const schedule = testSchedule({ run, threadMode: reuse ? "reuse" : "new", lastThreadId: reuse ? "gone" : undefined });
    const onThreadCreated = vi.fn();
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/resume") throw new Error("thread not found");
      if (method === "thread/start") return { thread: { id: "fresh" } };
      if (method === "turn/start") throw new Error("turn failed");
      return {};
    });
    const runs: ScheduleRunRecord[] = [];
    renderHook(() => useScheduler(testSchedulerDeps(schedule, runs, { onThreadCreated })));
    await act(async () => { await flushMicrotasks(30); });
    expect(onThreadCreated).toHaveBeenCalledWith("fresh", expect.objectContaining({ id: "project-1" }), { autoCompactTokens: 100_000 });
    const start = codex.rpc.mock.calls.find(([method]) => method === "thread/start")!;
    expect(start[1].config.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(start[1].config).not.toHaveProperty("mcp_servers.mythra_agents");
    expect(start[1].config.model_auto_compact_token_limit).toBe(100_000);
    expect(schedule.run?.subagentsEnabled).toBe(true);
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("uses the captured parent compaction window while keeping scheduled delegation off", async () => {
    const runs: ScheduleRunRecord[] = [];
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), autoCompactTokens: 1_000_000, subagentsEnabled: true, subagentEngine: "native" as const, nativeSubagentOptions: { codex: { autoCompactTokens: 100_000 } } };
    codex.rpc.mockImplementation(async (method: string) => method.startsWith("thread/") ? { thread: { id: "scheduled-parent" } } : {});
    const onThreadCreated = vi.fn();
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run }), runs, { onThreadCreated, settings: { ...DEFAULT_SETTINGS, autoCompactTokens: 100_000 } })));
    await act(async () => { await flushMicrotasks(30); });
    const start = codex.rpc.mock.calls.find(([method]) => method === "thread/start")!;
    expect(start[1].config.model_auto_compact_token_limit).toBe(1_000_000);
    expect(start[1].config.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(onThreadCreated).toHaveBeenCalledWith("scheduled-parent", expect.anything(), { autoCompactTokens: 1_000_000 });
    expect(runs.at(-1)?.status).toBe("started");
  });

  it.each([0, 100_000.5, 1_000_001])("rejects malformed scheduled parent compaction %s before preparation or fallback", async (autoCompactTokens) => {
    const runs: ScheduleRunRecord[] = [];
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), autoCompactTokens };
    const deps = testSchedulerDeps(testSchedule({ run, threadMode: "reuse", lastThreadId: "missing" }), runs);
    renderHook(() => useScheduler(deps));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("whole number") });
  });

  it("refreshes a warm scheduled parent when its compaction window changes while delegation remains off", async () => {
    const runs: ScheduleRunRecord[] = [];
    const restartRuntimeForCapabilities = vi.fn(async () => "replacement-runtime");
    codex.runtimeThreadState.mockResolvedValue({ instance: "schedule-runtime", loaded: true });
    recordSubagentCapabilities("thread-existing", "schedule-runtime", subagentCapabilitySignature({ subagentsEnabled: false, subagentMax: 1, autoCompactTokens: 100_000 }));
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), autoCompactTokens: 1_000_000 };
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run, threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { restartRuntimeForCapabilities })));
    await act(async () => { await flushMicrotasks(40); });
    expect(restartRuntimeForCapabilities).toHaveBeenCalledExactlyOnceWith("thread-existing", true);
    const resume = codex.rpc.mock.calls.find(([method]) => method === "thread/resume")!;
    expect(resume[1].config.model_auto_compact_token_limit).toBe(1_000_000);
    expect(runs.at(-1)?.status).toBe("started");
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

  it("keeps native delegation disabled when a saved enabled schedule reuses its thread", async () => {
    const runs: ScheduleRunRecord[] = [];
    const onThreadDelegationDisabled = vi.fn();
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), subagentsEnabled: true, subagentEngine: "native" as const, nativeSubagentMax: 4 };
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run, threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { onThreadDelegationDisabled })));
    await act(async () => { await flushMicrotasks(30); });
    const resume = codex.rpc.mock.calls.find(([method]) => method === "thread/resume")!;
    expect(resume[1].config.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(run.subagentsEnabled).toBe(true);
    expect(onThreadDelegationDisabled).toHaveBeenCalledExactlyOnceWith("thread-existing", { autoCompactTokens: undefined });
    expect(onThreadDelegationDisabled.mock.invocationCallOrder[0]).toBeLessThan(codex.rpc.mock.invocationCallOrder.at(-1)!);
    expect(runs.at(-1)?.status).toBe("started");
  });

  it.each([100_000, 1_000_000, undefined])("persists a reused schedule's admitted own window %j before dispatch", async (autoCompactTokens) => {
    const runs: ScheduleRunRecord[] = [];
    const onThreadDelegationDisabled = vi.fn();
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), autoCompactTokens };
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run, threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { onThreadDelegationDisabled })));
    await act(async () => { await flushMicrotasks(30); });
    expect(onThreadDelegationDisabled).toHaveBeenCalledExactlyOnceWith("thread-existing", { autoCompactTokens });
    expect(onThreadDelegationDisabled.mock.invocationCallOrder[0]).toBeLessThan(codex.rpc.mock.invocationCallOrder.at(-1)!);
    expect(runs.at(-1)?.status).toBe("started");
  });

  it("refreshes a warm native thread before a scheduled off-policy resume", async () => {
    const runs: ScheduleRunRecord[] = [];
    const restartRuntimeForCapabilities = vi.fn(async () => "replacement-runtime");
    codex.runtimeThreadState.mockResolvedValue({ instance: "schedule-runtime", loaded: true });
    recordSubagentCapabilities("thread-existing", "schedule-runtime", subagentCapabilitySignature({ subagentsEnabled: true, subagentEngine: "native", nativeSubagentMax: 4, subagentMax: 1 }));
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { restartRuntimeForCapabilities })));
    await act(async () => { await flushMicrotasks(40); });
    expect(restartRuntimeForCapabilities).toHaveBeenCalledExactlyOnceWith("thread-existing", true);
    const resume = codex.rpc.mock.calls.find(([method]) => method === "thread/resume")!;
    expect(resume[1].config.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(runs.at(-1)?.status).toBe("started");
  });

  it("refuses a warm unknown thread when safe refresh is unavailable, without fallback dispatch", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.runtimeThreadState.mockResolvedValue({ instance: "schedule-runtime", loaded: true });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs)));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("safe runtime refresh") });
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toEqual([]);
  });

  it("does not send or create a replacement when shared-runtime refresh rejects active other work", async () => {
    const runs: ScheduleRunRecord[] = [];
    const restartRuntimeForCapabilities = vi.fn(async () => { throw new Error("Another native worker has unknown status."); });
    codex.runtimeThreadState.mockResolvedValue({ instance: "schedule-runtime", loaded: true });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { restartRuntimeForCapabilities })));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("unknown status") });
  });

  it("waits while durable native evidence says a reusable thread still owns unresolved work", async () => {
    const runs: ScheduleRunRecord[] = [];
    const updateSchedule = vi.fn();
    const threadBusyReason = vi.fn(() => "Native child status remains unknown.");
    useTaskStore.getState().ensureTask("thread-existing", "/tmp/project");
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { threadBusyReason, updateSchedule })));
    await act(async () => { await flushMicrotasks(); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(codex.runtimeThreadState).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
    expect(updateSchedule).toHaveBeenCalled();
  });

  it("rechecks native children after checkpoint preparation and leaves the prompt unsent", async () => {
    const runs: ScheduleRunRecord[] = [];
    const onThreadDelegationDisabled = vi.fn();
    let unresolved = false;
    const threadBusyReason = vi.fn(() => unresolved ? "A native child started during preparation." : null);
    const beginRunCheckpoint = vi.fn(async () => { unresolved = true; return "native-guard-checkpoint"; });
    const discardRunCheckpoint = vi.fn();
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { threadBusyReason, beginRunCheckpoint, discardRunCheckpoint, onThreadDelegationDisabled })));
    await act(async () => { await flushMicrotasks(40); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-existing", "native-guard-checkpoint");
    expect(onThreadDelegationDisabled).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toEqual([]);
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("does not overwrite another turn that becomes running during preparation", async () => {
    const runs: ScheduleRunRecord[] = [];
    const beginRunCheckpoint = vi.fn(async () => {
      useTaskStore.getState().setActiveTurn("thread-existing", "other-turn");
      useTaskStore.getState().setTaskStatus("thread-existing", "running");
      return undefined;
    });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { beginRunCheckpoint })));
    await act(async () => { await flushMicrotasks(40); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("running");
    expect(useTaskStore.getState().tasks["thread-existing"].activeTurnId).toBe("other-turn");
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toEqual([]);
  });

  it("does not create a replacement thread after a non-missing resume failure", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockRejectedValue(new Error("Resume was denied while another turn started."));
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs)));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("preserves a competing turn when a missing-thread resume fallback arrives late", async () => {
    const runs: ScheduleRunRecord[] = [];
    codex.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/resume") {
        useTaskStore.getState().setActiveTurn("thread-existing", "other-turn");
        useTaskStore.getState().setTaskStatus("thread-existing", "running");
        throw new Error("thread not found");
      }
      return {};
    });
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs)));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalledWith("thread/start", expect.anything());
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("running");
    expect(useTaskStore.getState().tasks["thread-existing"].activeTurnId).toBe("other-turn");
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("does not clear another starting turn's claim after preparation fails", async () => {
    const runs: ScheduleRunRecord[] = [];
    const beginRunCheckpoint = vi.fn(async () => {
      useTaskStore.getState().appendUserMessage("thread-existing", { id: "competing-user", role: "user", text: "Other turn" });
      useTaskStore.getState().setTaskStatus("thread-existing", "starting");
      return undefined;
    });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { beginRunCheckpoint })));
    await act(async () => { await flushMicrotasks(40); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("starting");
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toMatchObject([{ id: "competing-user" }]);
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("does not dispatch if persisting the admitted off policy fails", async () => {
    const runs: ScheduleRunRecord[] = [];
    const discardRunCheckpoint = vi.fn();
    const onThreadDelegationDisabled = vi.fn(() => { throw new Error("Off policy persistence failed"); });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    const beginRunCheckpoint = vi.fn(async () => "off-policy-checkpoint");
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { onThreadDelegationDisabled, discardRunCheckpoint, beginRunCheckpoint })));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toEqual([]);
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("error");
    expect(discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("thread-existing", "off-policy-checkpoint");
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("Off policy persistence failed") });
  });

  it("preserves a competing claim that appears during off-policy admission", async () => {
    const runs: ScheduleRunRecord[] = [];
    const onThreadDelegationDisabled = vi.fn(() => {
      useTaskStore.getState().appendUserMessage("thread-existing", { id: "other-claim", role: "user", text: "Another prompt" });
      useTaskStore.getState().setTaskStatus("thread-existing", "starting");
    });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { onThreadDelegationDisabled })));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("starting");
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toMatchObject([{ id: "other-claim" }]);
    expect(runs.at(-1)?.status).toBe("failed");
  });

  it("keeps the disabled route on the next warm recurrence without another refresh", async () => {
    const runs: ScheduleRunRecord[] = [];
    const restartRuntimeForCapabilities = vi.fn(async () => "schedule-runtime");
    const run = { ...scheduleRunSnapshot(DEFAULT_SETTINGS), subagentsEnabled: true, subagentEngine: "native" as const };
    codex.runtimeThreadState.mockResolvedValue({ instance: "schedule-runtime", loaded: true });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ run, threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { restartRuntimeForCapabilities })));
    await act(async () => { await flushMicrotasks(40); });
    useTaskStore.getState().completeTurn("thread-existing", undefined, "completed");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await flushMicrotasks(40); });
    expect(runs.map(({ status, error }) => ({ status, error }))).toEqual([{ status: "started", error: undefined }, { status: "started", error: undefined }]);
    const resumes = codex.rpc.mock.calls.filter(([method]) => method === "thread/resume");
    expect(resumes).toHaveLength(2);
    for (const [, params] of resumes) expect(params.config.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(restartRuntimeForCapabilities).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(2);
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

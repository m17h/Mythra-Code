import { act, renderHook } from "@testing-library/react";
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
const preferences = vi.hoisted(() => ({ scopes: {} as Record<string, Partial<{ enabled: boolean; markdown: string }>> }));
vi.mock("../lib/preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => true,
  loadPreferenceLearning: async () => {},
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
    const beginRunCheckpoint = vi.fn(async () => { unresolved = true; return undefined; });
    const discardRunCheckpoint = vi.fn();
    codex.rpc.mockImplementation(async (method: string) => method === "thread/resume" ? { thread: { id: "thread-existing" } } : {});
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { threadBusyReason, beginRunCheckpoint, discardRunCheckpoint, onThreadDelegationDisabled })));
    await act(async () => { await flushMicrotasks(40); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(discardRunCheckpoint).toHaveBeenCalledWith("thread-existing");
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
    renderHook(() => useScheduler(testSchedulerDeps(testSchedule({ threadMode: "reuse", lastThreadId: "thread-existing" }), runs, { onThreadDelegationDisabled, discardRunCheckpoint })));
    await act(async () => { await flushMicrotasks(30); });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(useTaskStore.getState().tasks["thread-existing"].messages).toEqual([]);
    expect(useTaskStore.getState().statuses["thread-existing"]).toBe("error");
    expect(discardRunCheckpoint).toHaveBeenCalledWith("thread-existing");
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

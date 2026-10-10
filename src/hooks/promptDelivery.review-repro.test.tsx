import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { SKILL_DEPENDENCY_LIMITS } from "../lib/skillDependencies";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition } from "../lib/workflows";
import type { Provider, SkillDependencyReport } from "../types";

const runtime = vi.hoisted(() => ({
  rpc: vi.fn(), auditEvent: vi.fn(async () => {}),
  claude: vi.fn(), cursor: vi.fn(),
  saveClaude: vi.fn<(value: { messages: Array<{ role: string }> }) => Promise<void>>(async () => {}),
  saveCursor: vi.fn<(value: { messages: Array<{ role: string }> }) => Promise<void>>(async () => {}),
  killClaude: vi.fn(async () => {}), killCursor: vi.fn(async () => {}),
}));
vi.mock("../lib/codex", () => ({
  rpc: runtime.rpc,
  auditEvent: runtime.auditEvent,
  runtimeInstanceId: async () => "prompt-delivery-fixture-runtime",
  runtimeThreadState: async () => ({ instance: "prompt-delivery-fixture-runtime", loaded: false }),
}));
vi.mock("../lib/preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => true,
  loadPreferenceLearning: async () => {},
  getPreferenceLearningScope: (scopeKey: string) => ({ scopeKey, enabled: false, markdown: "" }),
}));
vi.mock("../lib/claude", () => ({ startClaudeTurn: runtime.claude, saveClaudeTranscript: runtime.saveClaude, killClaudeTurn: runtime.killClaude }));
vi.mock("../lib/cursor", () => ({ startCursorTurn: runtime.cursor, saveCursorTranscript: runtime.saveCursor, killCursorTurn: runtime.killCursor }));
import { useWorkflowEngine } from "./useWorkflowEngine";
import { useScheduler } from "./useScheduler";

const graph: SkillDependencyReport = {
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS },
  roots: [{ nodeId: "policy", channel: "system", name: "policy" }],
  nodes: [{ id: "policy", kind: "skill", name: "policy", path: "/skills/policy.md", status: "loaded", characterCount: 12, depth: 0 }],
  edges: [], issues: [],
};
const projects = [{ id: "p", name: "Project", path: "/tmp/prompt-review-project" }];
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
type WorkflowDeps = Parameters<typeof useWorkflowEngine>[0];
type SchedulerDeps = Parameters<typeof useScheduler>[0];

function workflowDeps(provider: Provider, overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  const workflow: WorkflowDefinition = {
    id: "review-workflow", name: "Review", projectId: "p", description: "", enabled: false,
    trigger: { type: "manual" }, skillNames: [], createdAt: 1, updatedAt: 1,
    run: scheduleRunSnapshot({ ...DEFAULT_SETTINGS, provider, model: "chosen-model" }),
    steps: [{ id: "step", name: "Review", type: "agent", prompt: "Inspect this", continueOnError: false }],
  };
  return {
    workflows: [workflow], projects, runtimeAvailable: true, chatGptConnected: true,
    claudeReady: true, cursorReady: true, openRouterReady: true, lmStudioReady: true, customAgents: [],
    ensureSkillRoots: async () => {}, resolveSkillPrompt: async (message) => message,
    resolveSkillPrompts: async (message, systemPrompt) => ({ prompt: message, systemPrompt, skillDependencies: graph }),
    bindThreadToProject: vi.fn(), beginRunCheckpoint: async () => undefined,
    finalizeRunCheckpoint: async () => {}, discardRunCheckpoint: vi.fn(), updateWorkflow: vi.fn(),
    recordRun: vi.fn(), onThreadStarted: vi.fn(), onError: vi.fn(), ...overrides,
  };
}

function schedulerDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    schedules: [{ id: "review-schedule", name: "Review", projectId: "p", prompt: "Inspect this", intervalMinutes: 60,
      enabled: true, nextRunAt: 0, run: scheduleRunSnapshot(DEFAULT_SETTINGS) }],
    projects, settings: DEFAULT_SETTINGS, runtimeAvailable: true, chatGptConnected: true, openRouterReady: false,
    ensureSkillRoots: async () => {}, resolveSkillPrompt: async (message) => message,
    resolveSkillPrompts: async (message, systemPrompt) => ({ prompt: message, systemPrompt, skillDependencies: graph }),
    bindThreadToProject: vi.fn(), beginRunCheckpoint: async () => undefined,
    discardRunCheckpoint: vi.fn(), updateSchedule: vi.fn(), recordRun: vi.fn(), onThreadStarted: vi.fn(), ...overrides,
  };
}

function completeImmediately(threadId: string, prompt: string, turnId: string): void {
  const store = useTaskStore.getState();
  store.setActiveTurn(threadId, turnId);
  store.completeMessage(threadId, { id: `${turnId}-user`, role: "user", text: prompt, turnId });
  store.completeMessage(threadId, { id: `${turnId}-assistant`, role: "assistant", text: "Completed result", turnId });
  store.completeTurn(threadId, turnId, "completed");
}

describe("review reproductions: undelivered automatic prompt provenance", () => {
  beforeEach(() => {
    resetTaskStore(); vi.resetAllMocks(); vi.useFakeTimers();
    runtime.rpc.mockImplementation(async (method: string) => method === "thread/start"
      ? { thread: { id: "review-thread" }, model: "chosen-model" } : {});
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("does not retain a %s workflow prompt stopped during checkpoint preparation", async (provider) => {
    let release!: () => void;
    const checkpoint = new Promise<void>((resolve) => { release = resolve; });
    const deps = workflowDeps(provider, { beginRunCheckpoint: async () => { await checkpoint; return undefined; } });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.runWorkflow("review-workflow"); await flush(); });
    await act(async () => { await result.current.stopWorkflow("review-workflow"); release(); await pending; });
    expect(runtime.claude).not.toHaveBeenCalled();
    expect(runtime.cursor).not.toHaveBeenCalled();
    expect(runtime.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    const task = Object.values(useTaskStore.getState().tasks)[0];
    expect(task.status).toBe("interrupted");
    // The provider never received this prompt or graph. Its history must not claim delivery.
    expect.soft(task.messages.filter((message) => message.role === "user")).toHaveLength(0);
    const save = provider === "claude" ? runtime.saveClaude : runtime.saveCursor;
    expect.soft(save.mock.calls.every(([value]) => !value.messages.some((message) => message.role === "user"))).toBe(true);
    expect(deps.discardRunCheckpoint).toHaveBeenCalledWith(task.threadId);
  });

  it("does not retain a scheduled prompt when its checkpoint fails before turn/start", async () => {
    const deps = schedulerDeps({ beginRunCheckpoint: async () => { throw new Error("Checkpoint failed"); } });
    renderHook(() => useScheduler(deps));
    await act(flush);
    expect(runtime.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    const task = useTaskStore.getState().tasks["review-thread"];
    expect(task.status).toBe("error");
    expect(task.messages.filter((message) => message.role === "user")).toHaveLength(0);
    // Creation failed before returning an owned ID. Thread-wide cleanup could
    // discard a checkpoint created by another run while preparation awaited.
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
  });

  it.each(["claude", "cursor"] as const)("does not persist a %s prompt stopped while saving prior history", async (provider) => {
    let release!: () => void;
    const priorSave = new Promise<void>((resolve) => { release = resolve; });
    const save = provider === "claude" ? runtime.saveClaude : runtime.saveCursor;
    // The first save owns the new empty thread; the second prepares its first turn.
    save.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await priorSave; });
    const { result } = renderHook(() => useWorkflowEngine(workflowDeps(provider)));
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.runWorkflow("review-workflow"); await flush(); });
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => { await result.current.stopWorkflow("review-workflow"); release(); await pending; });
    expect(runtime.claude).not.toHaveBeenCalled();
    expect(runtime.cursor).not.toHaveBeenCalled();
    const task = Object.values(useTaskStore.getState().tasks)[0];
    expect(task.messages).toHaveLength(0);
    expect(save.mock.calls.every(([value]) => value.messages.length === 0)).toBe(true);
  });

  it.each(["claude", "cursor"] as const)("does not retain a %s prompt when saving prior history fails", async (provider) => {
    const save = provider === "claude" ? runtime.saveClaude : runtime.saveCursor;
    save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Save failed"));
    const deps = workflowDeps(provider);
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("review-workflow"); });
    expect(runtime.claude).not.toHaveBeenCalled();
    expect(runtime.cursor).not.toHaveBeenCalled();
    const task = Object.values(useTaskStore.getState().tasks)[0];
    expect(task.status).toBe("error");
    expect(task.messages).toHaveLength(0);
    expect(save.mock.calls.every(([value]) => value.messages.length === 0)).toBe(true);
    expect(deps.discardRunCheckpoint).toHaveBeenCalledWith(task.threadId);
  });

  it("does not retain workflow or schedule prompts when local turn parameter validation fails", async () => {
    runtime.rpc.mockImplementation(async (method: string) => method === "thread/start" ? { thread: { id: "review-thread" } } : {});
    const deps = workflowDeps("openai");
    deps.workflows[0].run.model = "";
    const workflow = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await workflow.result.current.runWorkflow("review-workflow"); });
    expect(useTaskStore.getState().tasks["review-thread"].messages).toHaveLength(0);
    expect(deps.discardRunCheckpoint).toHaveBeenCalledWith("review-thread");
    workflow.unmount();
    resetTaskStore();
    const scheduled = schedulerDeps({ beginRunCheckpoint: async () => "owned-checkpoint" });
    scheduled.schedules[0].run!.model = "";
    renderHook(() => useScheduler(scheduled));
    await act(flush);
    expect(useTaskStore.getState().tasks["review-thread"].messages).toHaveLength(0);
    expect(runtime.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(scheduled.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("review-thread", "owned-checkpoint");
  });

  it.each(["openai", "claude", "cursor"] as const)("keeps %s history and skill provenance when completion beats the start response", async (provider) => {
    runtime.rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "review-thread" }, model: "chosen-model" };
      if (method === "turn/start") {
        completeImmediately(String(params.threadId), (params.input as Array<{ text: string }>)[0].text, "turn");
        return { turn: { id: "turn" } };
      }
      return {};
    });
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    start.mockImplementation(async ({ threadId, prompt }: { threadId: string; prompt: string }) => {
      completeImmediately(threadId, prompt, "turn");
      return { turnId: "turn", cursorSessionId: "session" };
    });
    const { result } = renderHook(() => useWorkflowEngine(workflowDeps(provider)));
    await act(async () => { await result.current.runWorkflow("review-workflow"); });
    const task = Object.values(useTaskStore.getState().tasks)[0];
    expect(task.status).toBe("completed");
    expect(task.activeTurnId).toBeUndefined();
    expect(task.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(task.messages.find((message) => message.role === "user")?.skillDependencies).toEqual(graph);
    expect(task.messages.find((message) => message.role === "assistant")?.text).toBe("Completed result");
  });

  it("preserves attempted workflow prompts and the successful retry after a dispatched request rejects", async () => {
    let attempts = 0;
    runtime.rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/start") return { thread: { id: "review-thread" }, model: "chosen-model" };
      if (method === "turn/start") {
        attempts += 1;
        if (attempts === 1) throw new Error("Transport failed after dispatch");
        completeImmediately(String(params.threadId), (params.input as Array<{ text: string }>)[0].text, "retry-turn");
        return { turn: { id: "retry-turn" } };
      }
      return {};
    });
    const deps = workflowDeps("openai");
    deps.workflows[0].steps[0].retryCount = 1;
    deps.workflows[0].steps[0].retryDelaySeconds = 0;
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("review-workflow"); });
    const task = useTaskStore.getState().tasks["review-thread"];
    const users = task.messages.filter((message) => message.role === "user");
    expect(attempts).toBe(2);
    expect(task.status).toBe("completed");
    expect(users).toHaveLength(2);
    expect(new Set(users.map((message) => message.clientMessageId ?? message.id)).size).toBe(2);
    expect(users.every((message) => message.skillDependencies?.roots[0].name === "policy")).toBe(true);
    expect(task.messages.some((message) => message.text === "Completed result")).toBe(true);
  });

  it("removes undelivered scheduled provenance on a definitive turn rejection", async () => {
    runtime.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "review-thread" }, model: "chosen-model" };
      if (method === "turn/start") throw new Error("Model unavailable");
      return {};
    });
    const deps = schedulerDeps({ beginRunCheckpoint: async () => "owned-checkpoint" });
    renderHook(() => useScheduler(deps));
    await act(flush);
    const task = useTaskStore.getState().tasks["review-thread"];
    expect(task.status).toBe("error");
    expect(task.messages).toHaveLength(0);
    expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith("review-thread", "owned-checkpoint");
    expect(deps.recordRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "failed" }));
  });

  it("preserves scheduled provenance and its checkpoint when native acknowledgement times out", async () => {
    runtime.rpc.mockImplementation(async (method: string) => {
      if (method === "thread/start") return { thread: { id: "review-thread" }, model: "chosen-model" };
      if (method === "turn/start") throw new Error("Codex App Server timed out while handling turn/start");
      return {};
    });
    const deps = schedulerDeps({ beginRunCheckpoint: async () => "owned-checkpoint" });
    renderHook(() => useScheduler(deps));
    await act(flush);
    const task = useTaskStore.getState().tasks["review-thread"];
    expect(task.status).toBe("error");
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0].skillDependencies).toEqual(graph);
    expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
    expect(deps.recordRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "failed", error: expect.stringContaining("delivery could not be confirmed"),
    }));
  });
});

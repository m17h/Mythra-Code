import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";

const runtime = vi.hoisted(() => ({ rpc: vi.fn(), auditEvent: vi.fn(async () => {}), claude: vi.fn(), cursor: vi.fn(), saveClaude: vi.fn(async () => {}), saveCursor: vi.fn(async () => {}), killClaude: vi.fn(async () => {}), killCursor: vi.fn(async () => {}) }));
vi.mock("../lib/codex", () => ({ rpc: runtime.rpc, auditEvent: runtime.auditEvent }));
vi.mock("../lib/claude", () => ({ startClaudeTurn: runtime.claude, saveClaudeTranscript: runtime.saveClaude, killClaudeTurn: runtime.killClaude }));
vi.mock("../lib/cursor", () => ({ startCursorTurn: runtime.cursor, saveCursorTranscript: runtime.saveCursor, killCursorTurn: runtime.killCursor }));
import { useWorkflowEngine } from "./useWorkflowEngine";

type Deps = Parameters<typeof useWorkflowEngine>[0];
function setup(provider: "claude" | "cursor", overrides: Partial<Deps> = {}) {
  const workflow: WorkflowDefinition = {
    id: "recipe", name: "Review", projectId: "p", description: "", enabled: false,
    trigger: { type: "manual" }, skillNames: [], createdAt: 1, updatedAt: 1,
    run: scheduleRunSnapshot({ ...DEFAULT_SETTINGS, provider, model: provider === "claude" ? "haiku" : "auto", permission: "read-only" }),
    steps: [1, 2].map((n) => ({ id: `step-${n}`, name: `Step ${n}`, type: "agent" as const, prompt: `Review ${n}`, continueOnError: false })),
  };
  const runs: WorkflowRunRecord[] = [];
  const deps: Deps = {
    workflows: [workflow], projects: [{ id: "p", name: "Project", path: "/tmp/project" }],
    runtimeAvailable: false, chatGptConnected: false, claudeReady: true, cursorReady: true, openRouterReady: false,
    customAgents: [], ensureSkillRoots: vi.fn(async () => {}), getSkillsPluginPath: () => "/tmp/skills",
    resolveSkillPrompt: vi.fn(async (message) => message), bindThreadToProject: vi.fn(),
    beginRunCheckpoint: vi.fn(async () => undefined), finalizeRunCheckpoint: vi.fn(async () => {}), discardRunCheckpoint: vi.fn(),
    onLocalThreadUpdated: vi.fn(), onThreadStarted: vi.fn(), onError: vi.fn(), updateWorkflow: vi.fn(),
    recordRun: (run) => { runs.push(run); }, ...overrides,
  };
  return { workflow, deps, runs };
}
function finish(threadId: string, turnId: string, status: "completed" | "error" = "completed") {
  const store = useTaskStore.getState();
  store.setActiveTurn(threadId, turnId);
  store.queueAssistantDelta(threadId, `${turnId}-reply`, `Result ${turnId}`);
  store.flushDeltas();
  store.completeTurn(threadId, turnId, status);
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

describe.each(["claude", "cursor"] as const)("%s saved workflows", (provider) => {
  beforeEach(() => { resetTaskStore(); vi.clearAllMocks(); runtime.claude.mockReset(); runtime.cursor.mockReset(); runtime.rpc.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });
  it("uses the native provider without Codex, reuses sessions, persists history, and handles completion before start returns", async () => {
    const { deps, runs } = setup(provider);
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    let sequence = 0;
    start.mockImplementation(async ({ threadId }: { threadId: string }) => {
      expect(deps.onLocalThreadUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: threadId, modelProvider: provider, cwd: "/tmp/project" }), undefined, expect.anything());
      const turnId = `turn-${++sequence}`;
      finish(threadId, turnId);
      return { turnId, cursorSessionId: "cursor-session" };
    });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe"); });
    expect(runs.at(-1)).toMatchObject({ status: "completed", currentStep: 2 });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: "/tmp/project", permission: "read-only", interactive: true });
    expect(start.mock.calls[1][0]).toMatchObject(provider === "claude" ? { resume: true } : { resumeSessionId: "cursor-session" });
    expect(runtime.rpc).not.toHaveBeenCalled();
    const save = provider === "claude" ? runtime.saveClaude : runtime.saveCursor;
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "Result turn-2" })]) }));
    if (provider === "cursor") expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ cursorSessionId: "cursor-session" }));
    expect(useTaskStore.getState().tasks[runs.at(-1)!.threadId!].status).toBe("completed");
  });
  it("runs a shared recipe in the requested project without changing its saved default", async () => {
    const { deps, workflow, runs } = setup(provider);
    deps.projects.push({ id: "other", name: "Other", path: "/tmp/other" });
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    let sequence = 0;
    start.mockImplementation(async ({ threadId }: { threadId: string }) => {
      const turnId = `shared-${++sequence}`;
      finish(threadId, turnId);
      return { turnId, cursorSessionId: "shared-session" };
    });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe", "manual", {}, "other"); });
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: "/tmp/other" });
    expect(runs.at(-1)).toMatchObject({ projectId: "other", status: "completed" });
    expect(workflow.projectId).toBe("p");
    expect(deps.onThreadStarted).toHaveBeenCalledWith(deps.projects[1], expect.any(String), "manual");
  });
  it("accepts a manual launch once a valid thread exists, before its agent turn finishes", async () => {
    const { deps, workflow, runs } = setup(provider);
    workflow.steps = [workflow.steps[0]];
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    const save = provider === "claude" ? runtime.saveClaude : runtime.saveCursor;
    let release!: (value: { turnId: string; cursorSessionId: string }) => void;
    start.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const onStarted = vi.fn((threadId: string) => {
      expect(useTaskStore.getState().tasks[threadId]).toBeDefined();
      expect(deps.bindThreadToProject).toHaveBeenCalledWith(threadId, "/tmp/project");
      expect(save).toHaveBeenCalled();
    });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let pending!: Promise<string | undefined>;
    await act(async () => {
      pending = result.current.runWorkflow("recipe", "manual", {}, undefined, { onStarted });
      await flush();
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    const threadId = onStarted.mock.calls[0][0];
    expect(runs.at(-1)).toMatchObject({ threadId, status: "running" });
    await act(async () => {
      release({ turnId: "accepted-turn", cursorSessionId: "s" });
      finish(threadId, "accepted-turn");
      await pending;
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
  it("never accepts a launch that fails preflight", async () => {
    const { deps, runs } = setup(provider, { claudeReady: false, cursorReady: false });
    const onStarted = vi.fn();
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let accepted: string | undefined;
    await act(async () => {
      accepted = await result.current.runWorkflow("recipe", "manual", {}, undefined, { onStarted });
    });
    expect(accepted).toBeUndefined();
    expect(onStarted).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });
  it("sends the optional note to agent steps without modifying the saved recipe", async () => {
    const { deps, workflow, runs } = setup(provider);
    const originalRecipe = structuredClone(workflow);
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    let sequence = 0;
    start.mockImplementation(async ({ threadId }: { threadId: string }) => {
      const turnId = `note-${++sequence}`;
      finish(threadId, turnId);
      return { turnId, cursorSessionId: "s" };
    });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => {
      await result.current.runWorkflow("recipe", "manual", {}, undefined, { userPrompt: "  Check the retry path.  " });
    });
    expect(runs.at(-1)?.status).toBe("completed");
    expect(start).toHaveBeenCalledTimes(2);
    for (const call of start.mock.calls) {
      expect(call[0].prompt).toContain("Additional instructions for this run:\nCheck the retry path.");
    }
    expect(workflow).toEqual(originalRecipe);
    const update = vi.mocked(deps.updateWorkflow);
    expect(update).toHaveBeenCalledTimes(1);
    const saved = update.mock.calls[0][1](structuredClone(originalRecipe));
    expect(saved.steps).toEqual(originalRecipe.steps);
    expect(saved.run).toEqual(originalRecipe.run);
    expect(saved.description).toBe(originalRecipe.description);
  });
  it("rejects a note for a command-only recipe before creating a run", async () => {
    const { deps, workflow, runs } = setup(provider, { runtimeAvailable: true });
    workflow.steps = [{ id: "command", name: "Check", type: "command", command: "npm test", continueOnError: false }];
    const onStarted = vi.fn();
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let accepted: string | undefined;
    await act(async () => {
      accepted = await result.current.runWorkflow("recipe", "manual", {}, undefined, { userPrompt: "Extra note", onStarted });
    });
    expect(accepted).toBeUndefined();
    expect(onStarted).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("only runs commands"));
    expect(runtime.rpc).not.toHaveBeenCalled();
  });
  it("reports disconnected provider without creating a run", async () => {
    const { deps, runs } = setup(provider, { claudeReady: false, cursorReady: false });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe"); });
    expect(runs).toHaveLength(0);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("sign in"));
  });
  it("requires the command runtime only when the recipe contains shell steps", async () => {
    const { deps, workflow, runs } = setup(provider);
    workflow.steps.push({ id: "shell", type: "command", name: "Check", command: "npm test", continueOnError: false });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe"); });
    expect(runs).toHaveLength(0);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining("shell-command steps"));
  });
  it("stops a pending start at the provider and never starts the next step", async () => {
    const { deps, runs } = setup(provider);
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    let release!: (value: { turnId: string; cursorSessionId: string }) => void;
    start.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.runWorkflow("recipe"); await flush(); });
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.stopWorkflow("recipe"); });
    await act(async () => { release({ turnId: "slow-start", cursorSessionId: "s" }); await pending; });
    expect(provider === "claude" ? runtime.killClaude : runtime.killCursor).toHaveBeenCalled();
    expect(runs.at(-1)).toMatchObject({ status: "interrupted" });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("stops an active wait with one provider kill and finishes checkpoint cleanup", async () => {
    const { deps, runs } = setup(provider);
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    const kill = provider === "claude" ? runtime.killClaude : runtime.killCursor;
    start.mockResolvedValue({ turnId: "working", cursorSessionId: "s" });
    let release!: () => void;
    kill.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.runWorkflow("recipe"); await flush(); });
    let stopping!: Promise<boolean>;
    await act(async () => { stopping = result.current.stopWorkflow("recipe"); await flush(); });
    expect(kill).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await stopping; await pending; });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(deps.finalizeRunCheckpoint).toHaveBeenCalledWith(expect.any(String), "working");
    expect(runs.at(-1)?.status).toBe("interrupted");
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("retries a failed start without reusing an uncreated session or duplicate prompt id", async () => {
    const { deps, workflow, runs } = setup(provider);
    workflow.steps = [{ ...workflow.steps[0], retryCount: 1 }];
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    start.mockRejectedValueOnce(new Error("startup failed")).mockImplementationOnce(async ({ threadId }: { threadId: string }) => {
      finish(threadId, "retry"); return { turnId: "retry", cursorSessionId: "s" };
    });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe"); });
    expect(runs.at(-1)?.status).toBe("completed");
    expect(deps.discardRunCheckpoint).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[1][0]).toMatchObject(provider === "claude" ? { resume: false } : { resumeSessionId: undefined });
    const prompts = useTaskStore.getState().tasks[runs.at(-1)!.threadId!].messages.filter((m) => m.role === "user");
    expect(new Set(prompts.map((m) => m.id)).size).toBe(prompts.length);
  });
  it("kills a timed out agent without retrying", async () => {
    vi.useFakeTimers();
    const { deps, workflow, runs } = setup(provider, { turnTimeoutMs: 100 });
    workflow.steps[0].retryCount = 2;
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    start.mockResolvedValue({ turnId: "timeout", cursorSessionId: "s" });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.runWorkflow("recipe"); await flush(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await pending; });
    expect(provider === "claude" ? runtime.killClaude : runtime.killCursor).toHaveBeenCalledTimes(1);
    expect(runs.at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("too long") });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("starts an app-start workflow when its own provider becomes ready", async () => {
    const { deps, workflow, runs } = setup(provider, { claudeReady: false, cursorReady: false });
    workflow.enabled = true;
    workflow.trigger = { type: "app-start" };
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    start.mockImplementation(async ({ threadId }: { threadId: string }) => { const turnId = crypto.randomUUID(); finish(threadId, turnId); return { turnId, cursorSessionId: "s" }; });
    const { rerender } = renderHook((ready: boolean) => useWorkflowEngine({ ...deps, claudeReady: ready, cursorReady: ready }), { initialProps: false });
    expect(start).not.toHaveBeenCalled();
    await act(async () => { rerender(true); });
    await act(async () => { await flush(); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(runs.at(-1)).toMatchObject({ source: "app-start", status: "completed" });
  });
  it("passes unattended mode without broadening saved permissions", async () => {
    const { deps, runs } = setup(provider);
    const start = provider === "claude" ? runtime.claude : runtime.cursor;
    start.mockImplementation(async ({ threadId }: { threadId: string }) => { const turnId = crypto.randomUUID(); finish(threadId, turnId); return { turnId, cursorSessionId: "s" }; });
    const { result } = renderHook(() => useWorkflowEngine(deps));
    await act(async () => { await result.current.runWorkflow("recipe", "interval"); });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ interactive: false, permission: "read-only" }));
    expect(runs.at(-1)?.status).toBe("completed");
  });
});

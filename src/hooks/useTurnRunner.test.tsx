import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { PendingTurnStarts } from "../lib/pendingTurnStarts";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { Thread } from "../types";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  // Identity of the app-server that will serve the next RPC; a restart makes
  // this change, which is how a turn knows nothing is loaded any more.
  runtimeInstanceId: vi.fn(async () => "runtime-1"),
}));
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
const childSessions = vi.hoisted(() => ({
  // `unknown` so a test can resolve a real bridge result as easily as null.
  ensureChildAgentBridge: vi.fn(async (): Promise<unknown> => null),
  cacheChildAgentPolicy: vi.fn(),
  releaseChildAgentSession: vi.fn(),
}));

vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", () => claude);
vi.mock("../lib/cursor", () => cursor);
vi.mock("../lib/worktrees", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/worktrees")>(),
  ...worktrees,
}));
vi.mock("../lib/childAgentSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/childAgentSessions")>(),
  ...childSessions,
}));

import { forgetSubagentCapabilities } from "../lib/threadCapabilities";
import { forgetQueuedDeliveries, useTurnRunner, type TurnRunnerContext } from "./useTurnRunner";

const OPENAI_THREAD: Thread = {
  id: "thread-openai",
  name: null,
  preview: "OpenAI thread",
  cwd: "/tmp/project",
  updatedAt: 1,
  modelProvider: "openai",
};

const BRIDGE_LAUNCH = {
  name: "openkiwi",
  command: "/Applications/OpenKiwi.app/Contents/MacOS/openkiwi",
  args: ["--openkiwi-agent-bridge", "/data/child-agents/abc/session.json"],
  configPath: "/data/child-agents/abc/mcp.json",
  toolNames: ["spawn_agent", "agent_status", "collect_agent", "cancel_agent"],
};

/** What `ensureChildAgentBridge` hands back once a policy is captured. */
function bridgeResult(overrides: { captured?: boolean; rootThreadId?: string; maxConcurrent?: number } = {}) {
  return {
    policy: {
      sessionId: "session-1",
      rootThreadId: overrides.rootThreadId ?? OPENAI_THREAD.id,
      maxConcurrent: overrides.maxConcurrent ?? 4,
      permission: "ask" as const,
      systemPrompt: "",
      projectInstructionsEnabled: false,
      reasoningEffort: "medium" as const,
      serviceTier: null,
      targets: [],
      capturedAt: 1,
    },
    launch: BRIDGE_LAUNCH,
    captured: overrides.captured ?? true,
  };
}

const CURSOR_THREAD: Thread = {
  id: "thread-cursor",
  name: null,
  preview: "Cursor thread",
  cwd: "/tmp/project",
  updatedAt: 1,
  modelProvider: "cursor",
};

const CLAUDE_THREAD: Thread = {
  id: "thread-claude",
  name: null,
  preview: "Claude thread",
  cwd: "/tmp/project",
  updatedAt: 1,
  modelProvider: "claude",
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
    subscriptionSystemPrompts: { openai: "Codex instructions", claude: "Claude instructions" },
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
    childAgentPolicies: {},
    childAgentLinks: {},
    childAgentReadiness: {
      codexRuntimeAvailable: false,
      openAiSignedIn: false,
      openRouterReady: false,
      claudeReady: false,
      cursorReady: false,
    },
    persistChildAgentPolicies: vi.fn(),
    threadWorktreesRef: { current: {} },
    threadProjectBindingsRef: { current: { [CURSOR_THREAD.id]: "/tmp/project" } },
    activeWorkspacePathRef: { current: "/tmp/project" },
    pendingTurnStartsRef: { current: pendingTurnStarts },
    skillRuntimeRootRef: { current: "" },
    cursorSessionIdsRef: { current: {} },
    executionPathFor: (_threadId, path) => path,
    bindThreadToProject: vi.fn(),
    rememberThread: vi.fn(),
    onThreadCreated: vi.fn(),
    persistThreadModel: vi.fn(),
    persistThreadReasoning: vi.fn(),
    persistThreadWorktrees: vi.fn(),
    restartRuntimeForCapabilities: vi.fn(async () => "runtime-2"),
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

function claudeContext(overrides: Partial<TurnRunnerContext> = {}): TurnRunnerContext {
  return context({
    activeThread: CLAUDE_THREAD,
    running: true,
    effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5" },
    claudeStatus: {
      available: true,
      loggedIn: true,
      version: "test",
      path: "/usr/local/bin/claude",
      authMethod: "subscription",
      email: "test@example.com",
      subscriptionType: "max",
      warning: null,
    },
    threadProjectBindingsRef: { current: { [CLAUDE_THREAD.id]: "/tmp/project" } },
    ...overrides,
  });
}

describe("useTurnRunner", () => {
  it("preserves the draft and opens settings when LM Studio is not ready", async () => {
    const setError = vi.fn();
    const openSettings = vi.fn();
    const deps = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "lmstudio", model: "local-model" },
      runtimeStatus: { available: true, source: "Codex CLI", path: "codex", version: "test", compatible: true, warning: null },
      lmStudioReady: false,
      setError,
      openSettings,
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.sendMessage("work locally"); });

    expect(delivered).toBe(false);
    expect(openSettings).toHaveBeenCalledWith("models");
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("Start the LM Studio local server"));
    expect(codex.rpc).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    resetTaskStore();
    forgetQueuedDeliveries();
    forgetSubagentCapabilities();
    vi.clearAllMocks();
    cursor.killCursorTurn.mockResolvedValue(undefined);
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-new", cursorSessionId: "session-new" });
    cursor.steerCursorTurn.mockResolvedValue(undefined);
    claude.killClaudeTurn.mockResolvedValue(undefined);
    claude.saveClaudeTranscript.mockResolvedValue(undefined);
    claude.startClaudeTurn.mockResolvedValue({ turnId: "turn-new" });
    claude.steerClaudeTurn.mockResolvedValue(undefined);
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
  });

  it("uses the effective project sub-agent policy when preparing the bridge", async () => {
    const effectiveSettings = {
      ...DEFAULT_SETTINGS,
      provider: "cursor" as const,
      model: "grok-4.5",
      subagentsEnabled: true,
      subagentMax: 7,
      childAgents: { enabled: true, targets: [] },
    };
    const deps = context({ effectiveSettings });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("build it"); });

    expect(childSessions.ensureChildAgentBridge).toHaveBeenCalledWith(expect.objectContaining({ settings: effectiveSettings }));
  });

  it("captures the selected reasoning level when a draft becomes a thread", async () => {
    const deps = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", reasoningEffort: "high", ultra: false },
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("build it"); });

    expect(deps.persistThreadReasoning).toHaveBeenCalledWith(expect.any(String), { reasoningEffort: "high", ultra: false });
  });

  it("hard-stops the active provider turn and records the stopped state", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => result.current.stopTurn());

    expect(cursor.killCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.activeTurnId).toBeUndefined();
    expect(useTaskStore.getState().statuses[CURSOR_THREAD.id]).toBe("interrupted");
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Stopped");
  });

  it("cuts off a draft send that Stop reaches before its first turn starts", async () => {
    let releaseBridge!: (value: unknown) => void;
    childSessions.ensureChildAgentBridge.mockImplementationOnce(
      () => new Promise((resolve) => { releaseBridge = resolve; }),
    );
    const deps = context({ activeThread: null, running: false });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered: boolean | undefined;
    await act(async () => {
      const sent = result.current.sendMessage("build it").then((value) => { delivered = value; });
      await Promise.resolve();
      // What `setStartingDraftTurn(true)` does in the app: the composer now
      // reports a running draft turn, which is the state Stop reads.
      deps.running = true;
      await result.current.stopTurn();
      releaseBridge(null);
      await sent;
    });

    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    // Undelivered, so the composer hands the user their prompt back.
    expect(delivered).toBe(false);
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Stopped");
  });

  it("records cancellation only for a start that is actually in flight", async () => {
    const deps = context({ running: true });
    const pending = deps.pendingTurnStartsRef.current.begin(CURSOR_THREAD.id);
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => result.current.stopTurn());

    expect(deps.setStatus).toHaveBeenCalledWith("Stopping");
    expect(cursor.killCursorTurn).not.toHaveBeenCalled();
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
    expect(cursor.killCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id);
  });

  it("queues a running-task message by default without steering", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = false;
    await act(async () => { delivered = await result.current.sendMessage("do this next"); });

    expect(delivered).toBe(true);
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({ text: "do this next", status: "queued" }),
    ]);
  });

  it("refuses a second send until the first thread has an id", async () => {
    const deps = context({ activeThread: null, running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.sendMessage("do this after startup"); });

    expect(delivered).toBe(false);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it("starts the oldest queued message after the active turn completes", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("do this next"); });

    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "do this next" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("starts a queue restored from an earlier app session when the task is opened", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    // A durable entry with no in-memory delivery context and an idle task is
    // exactly the state an app restart leaves behind.
    useTaskStore.getState().enqueueTurn(CURSOR_THREAD.id, "finish the migration", []);
    const deps = context({ running: false });

    renderHook(() => useTurnRunner(deps));
    await act(async () => { await Promise.resolve(); });

    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "finish the migration" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("holds the queue at a failed head instead of starting later follow-ups", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("first follow-up"); });
    await act(async () => { await result.current.sendMessage("second follow-up"); });

    cursor.startCursorTurn.mockRejectedValueOnce(new Error("cursor is already working"));
    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    const failed = useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns ?? [];
    expect(failed.map((entry) => [entry.text, entry.status])).toEqual([
      ["first follow-up", "failed"],
      ["second follow-up", "queued"],
    ]);

    // A later completion must not let the second follow-up jump the failed one.
    await act(async () => {
      useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "completed");
      await Promise.resolve();
    });
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.retryQueuedMessage(failed[0].id);
      await Promise.resolve();
    });
    expect(cursor.startCursorTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "first follow-up" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns.map((entry) => entry.text)).toEqual(["second follow-up"]);
  });

  it("holds the queued turn without a modal when another shared-folder run overlaps", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("do this next"); });

    // A second conversation starts working in the same shared folder before the
    // queued follow-up gets its turn.
    useTaskStore.getState().ensureTask("thread-other", "/tmp/project");
    useTaskStore.getState().setTaskStatus("thread-other", "running");
    await act(async () => {
      useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]).toMatchObject({
      text: "do this next",
      status: "failed",
      error: expect.stringContaining("another conversation is working"),
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.activities).toContainEqual(
      expect.objectContaining({ kind: "warning", title: "Another thread is working in this project folder" }),
    );
    confirmSpy.mockRestore();
  });

  it("removes an optimistic steering message when explicit Cursor steering fails", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("steer failed"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.steerMessage("change direction"); });

    expect(delivered).toBe(false);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toEqual([]);
    expect(deps.setError).toHaveBeenLastCalledWith("steer failed");
  });

  it("sends Cursor steering attachments instead of silently discarding them", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({
      running: true,
      attachments: [{ path: "/tmp/reference.png", name: "reference.png", kind: "image" }],
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.steerMessage("match this reference"); });

    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(
      CURSOR_THREAD.id,
      "match this reference",
      [{ path: "/tmp/reference.png", kind: "image" }],
    );
    expect(deps.setAttachments).toHaveBeenCalled();
  });

  it("turns a stale steer into a queued follow-up as soon as assistant output starts", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    store.queueAssistantDelta(CURSOR_THREAD.id, "answer", "Final answer");
    const deps = context({
      running: true,
      attachments: [{ path: "/tmp/reference.png", name: "reference.png", kind: "image" }],
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = false;
    await act(async () => { delivered = await result.current.steerMessage("one more thing"); });

    expect(delivered).toBe(true);
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({
        text: "one more thing",
        status: "queued",
        attachments: [{ path: "/tmp/reference.png", name: "reference.png", kind: "image" }],
      }),
    ]);
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Message queued for the next turn");
  });

  it("queues a direct steer when the provider finishes before receiving it", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("Cursor is not currently running in this thread"));
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let accepted = false;
    await act(async () => { accepted = await result.current.steerMessage("do this next"); });

    expect(accepted).toBe(true);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({ text: "do this next", status: "queued" }),
    ]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]?.error).toBeUndefined();
    expect(deps.setError).not.toHaveBeenCalledWith(expect.stringContaining("not currently running"));
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Message queued for the next turn");
  });

  it("keeps a queued Claude steer for the next turn when the provider just finished", async () => {
    claude.steerClaudeTurn.mockRejectedValueOnce(new Error("Claude is not currently running in this thread"));
    const store = useTaskStore.getState();
    store.ensureTask(CLAUDE_THREAD.id, CLAUDE_THREAD.cwd);
    store.setActiveTurn(CLAUDE_THREAD.id, "turn-live");
    store.setTaskStatus(CLAUDE_THREAD.id, "running");
    const deps = claudeContext();
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("do this next"); });
    const queuedTurn = useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns[0];

    await act(async () => { await result.current.steerQueuedMessage(queuedTurn!.id); });

    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns[0]).toMatchObject({
      id: queuedTurn!.id,
      text: "do this next",
      status: "queued",
      error: undefined,
    });
    expect(deps.setError).not.toHaveBeenCalledWith(expect.stringContaining("not currently running"));
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Steering was unavailable; message kept for the next turn");

    await act(async () => {
      useTaskStore.getState().completeTurn(CLAUDE_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
    });

    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "do this next" }));
    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("keeps and starts a Claude steer when completion races a closed input pipe", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CLAUDE_THREAD.id, CLAUDE_THREAD.cwd);
    store.setActiveTurn(CLAUDE_THREAD.id, "turn-live");
    store.setTaskStatus(CLAUDE_THREAD.id, "running");
    claude.steerClaudeTurn.mockImplementationOnce(async () => {
      // The terminal event reaches the renderer while the failed write is
      // returning across Tauri — the narrowest version of the reported race.
      useTaskStore.getState().completeTurn(CLAUDE_THREAD.id, "turn-live", "completed");
      throw new Error("Could not write to Claude Code: Broken pipe");
    });
    const deps = claudeContext();
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("continue after this"); });
    const queuedTurn = useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns[0];

    await act(async () => {
      await result.current.steerQueuedMessage(queuedTurn!.id);
      await Promise.resolve();
    });

    expect(deps.setError).not.toHaveBeenCalledWith(expect.stringContaining("connection stopped"));
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "continue after this" }));
    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("still exposes a genuine queued steering failure for retry", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("The attached reference could not be read"));
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("use this reference"); });
    const queuedTurn = useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0];

    await act(async () => { await result.current.steerQueuedMessage(queuedTurn!.id); });

    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]).toMatchObject({
      id: queuedTurn!.id,
      status: "failed",
      error: "The message could not be steered into the active turn.",
    });
    expect(deps.setError).toHaveBeenCalledWith("The attached reference could not be read");
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

  it("does not resurrect a turn whose result beat the start response", async () => {
    cursor.startCursorTurn.mockImplementationOnce(async () => {
      const store = useTaskStore.getState();
      store.setActiveTurn(CURSOR_THREAD.id, "turn-fast");
      store.setTaskStatus(CURSOR_THREAD.id, "running");
      store.completeTurn(CURSOR_THREAD.id, "turn-fast", "completed");
      return { turnId: "turn-fast", cursorSessionId: "session-fast" };
    });
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const deps = context();
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = false;
    await act(async () => { delivered = await result.current.sendMessage("answer quickly"); });

    const task = useTaskStore.getState().tasks[CURSOR_THREAD.id];
    expect(delivered).toBe(true);
    expect(task.activeTurnId).toBeUndefined();
    expect(task.status).toBe("completed");
    expect(task.lastCompletedTurnId).toBe("turn-fast");
    expect(cursor.killCursorTurn).not.toHaveBeenCalled();
  });
});

/**
 * The exact bug 1.5.0 shipped: sub-agents configured partway through a
 * conversation had to reach the very next turn, on every provider, and
 * switching them back off had to take the powers away just as promptly.
 */
describe("useTurnRunner activating sub-agents mid-conversation", () => {
  function openAiContext(overrides: Partial<TurnRunnerContext> = {}): TurnRunnerContext {
    return context({
      activeThread: OPENAI_THREAD,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-terra" },
      runtimeStatus: { available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "1", compatible: true, warning: null },
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
      threadProjectBindingsRef: { current: { [OPENAI_THREAD.id]: "/tmp/project" } },
      ...overrides,
    });
  }

  function resumeCall() {
    return codex.rpc.mock.calls.find(([method]) => method === "thread/resume");
  }

  /** Settings for a conversation whose user has just switched sub-agents on. */
  const ENABLED = { ...DEFAULT_SETTINGS, provider: "openai" as const, model: "gpt-5.6-terra", subagentsEnabled: true, subagentMax: 4 };

  beforeEach(() => {
    resetTaskStore();
    forgetQueuedDeliveries();
    forgetSubagentCapabilities();
    vi.clearAllMocks();
    codex.rpc.mockResolvedValue({ turn: { id: "turn-1" } });
    codex.runtimeInstanceId.mockResolvedValue("runtime-1");
    claude.saveClaudeTranscript.mockResolvedValue(undefined);
    claude.startClaudeTurn.mockResolvedValue({ turnId: "turn-claude" });
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-new", cursorSessionId: "session-new" });
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
  });

  it("reattaches the bridge to an existing OpenAI thread on the very next turn", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const deps = openAiContext({ effectiveSettings: ENABLED });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("split this up"); });

    const [, params] = resumeCall() ?? [];
    expect(params).toMatchObject({
      threadId: OPENAI_THREAD.id,
      config: {
        mcp_servers: { openkiwi: { command: BRIDGE_LAUNCH.command, args: BRIDGE_LAUNCH.args } },
        features: { multi_agent: false },
      },
    });
  });

  it("never exposes native Codex sub-agents when no managed destination is available", async () => {
    const deps = openAiContext({ effectiveSettings: ENABLED });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("split this up"); });

    expect(resumeCall()).toBeUndefined();
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
  });

  it("refreshes the runtime that is already holding this thread with other capabilities", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    // First turn teaches this app-server what the thread is configured with.
    const restartRuntimeForCapabilities = vi.fn(async () => "runtime-2");
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), {
      initialProps: { deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: ENABLED }) },
    });
    await act(async () => { await result.current.sendMessage("split this up"); });
    expect(restartRuntimeForCapabilities).toHaveBeenCalledExactlyOnceWith(OPENAI_THREAD.id);

    // Only a fresh app-server can replace startup-only config on a thread it
    // has already loaded, so raising the limit has to go through one.
    codex.rpc.mockClear();
    restartRuntimeForCapabilities.mockClear();
    codex.runtimeInstanceId.mockResolvedValue("runtime-2");
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ maxConcurrent: 6 }));
    rerender({ deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: { ...ENABLED, subagentMax: 6 } }) });
    await act(async () => { await result.current.sendMessage("more of them"); });

    expect(restartRuntimeForCapabilities).toHaveBeenCalledExactlyOnceWith(OPENAI_THREAD.id);
    // The raised limit belongs to the OpenKiwi bridge, which enforces it per
    // spawn. It is deliberately not mirrored into Codex's own agent runtime,
    // which would otherwise get a second budget stacked on the bridge's.
    expect(resumeCall()?.[1]).toMatchObject({ config: { agents: { max_threads: 1, max_depth: 1 } } });
    expect(childSessions.ensureChildAgentBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ subagentMax: 6 }) }),
    );
  });

  it("does not interrupt a runtime that has restarted since it was told anything", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const restartRuntimeForCapabilities = vi.fn(async () => "runtime-3");
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), {
      initialProps: { deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: ENABLED }) },
    });
    await act(async () => { await result.current.sendMessage("split this up"); });

    // Whatever replaced that app-server has nothing loaded, so the resume
    // below applies the new config on its own.
    codex.rpc.mockClear();
    restartRuntimeForCapabilities.mockClear();
    codex.runtimeInstanceId.mockResolvedValue("runtime-4");
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ maxConcurrent: 6 }));
    rerender({ deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: { ...ENABLED, subagentMax: 6 } }) });
    await act(async () => { await result.current.sendMessage("more of them"); });

    expect(restartRuntimeForCapabilities).not.toHaveBeenCalled();
    expect(resumeCall()?.[1]).toMatchObject({ config: { agents: { max_threads: 1, max_depth: 1 } } });
    expect(childSessions.ensureChildAgentBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: expect.objectContaining({ subagentMax: 6 }) }),
    );
  });

  it("re-applies unchanged capabilities to an app-server that replaced the one told about them", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), {
      initialProps: { deps: openAiContext({ effectiveSettings: ENABLED }) },
    });
    await act(async () => { await result.current.sendMessage("split this up"); });

    codex.rpc.mockClear();
    codex.runtimeInstanceId.mockResolvedValue("runtime-3");
    rerender({ deps: openAiContext({ effectiveSettings: ENABLED }) });
    await act(async () => { await result.current.sendMessage("keep going"); });

    // The bridge this thread believes it has is not registered anywhere in the
    // new runtime until it is resumed into it.
    expect(resumeCall()?.[1]).toMatchObject({
      config: { mcp_servers: { openkiwi: { args: BRIDGE_LAUNCH.args } } },
    });
  });

  it("reloads a disabled thread into a replacement app-server before starting its turn", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValueOnce(bridgeResult());
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), {
      initialProps: { deps: openAiContext({ effectiveSettings: ENABLED }) },
    });
    await act(async () => { await result.current.sendMessage("split this up"); });

    // A different conversation can replace the shared app-server. This thread
    // still needs a resume even though its next run wants the neutral config;
    // otherwise turn/start targets a thread the replacement process has not loaded.
    codex.rpc.mockClear();
    codex.runtimeInstanceId.mockResolvedValue("runtime-2");
    rerender({ deps: openAiContext() });
    await act(async () => { await result.current.sendMessage("continue without agents"); });

    expect(resumeCall()?.[1]).toMatchObject({
      threadId: OPENAI_THREAD.id,
      config: { features: { multi_agent: false } },
    });
  });

  it("takes the powers away again when sub-agents are switched off", async () => {
    const bridged = openAiContext({ effectiveSettings: ENABLED });
    childSessions.ensureChildAgentBridge.mockResolvedValueOnce(bridgeResult());
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), { initialProps: { deps: bridged } });
    await act(async () => { await result.current.sendMessage("split this up"); });

    codex.rpc.mockClear();
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
    rerender({ deps: openAiContext() });
    await act(async () => { await result.current.sendMessage("actually, do it yourself"); });

    const [, params] = resumeCall() ?? [];
    expect(params).toMatchObject({ config: { features: { multi_agent: false } } });
    expect(params).not.toHaveProperty("config.mcp_servers");
  });

  it("leaves an unknown pre-feature disabled thread alone", async () => {
    const restartRuntimeForCapabilities = vi.fn(async () => "runtime-2");
    const deps = openAiContext({ restartRuntimeForCapabilities });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("just answer"); });

    expect(resumeCall()).toBeUndefined();
    expect(restartRuntimeForCapabilities).not.toHaveBeenCalled();
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
  });

  it("does not send when another Codex task prevents a safe capability refresh", async () => {
    const restartRuntimeForCapabilities = vi.fn(async (): Promise<string> => {
      throw new Error("another OpenAI task is still running");
    });
    // Configure the thread once so this app-server is known to be holding it.
    const { result, rerender } = renderHook(({ deps }) => useTurnRunner(deps), {
      initialProps: { deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: ENABLED }) },
    });
    await act(async () => { await result.current.sendMessage("split this up"); });

    codex.rpc.mockClear();
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ captured: true }));
    const deps = openAiContext({ restartRuntimeForCapabilities, effectiveSettings: ENABLED });
    rerender({ deps });
    await act(async () => { expect(await result.current.sendMessage("now delegate")).toBe(false); });

    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(childSessions.releaseChildAgentSession).toHaveBeenCalledWith("session-1");
    expect(deps.setError).toHaveBeenCalledWith("another OpenAI task is still running");
  });

  it("never gives the native agent runtime a budget of its own, whatever the user picked", async () => {
    // The bridge is the only spawning authority, so a high managed limit must
    // not turn into native parallelism the bridge cannot see or count.
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const deps = openAiContext({
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-terra", subagentsEnabled: true, subagentMax: 12 },
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("split this up"); });

    expect(resumeCall()?.[1]).toMatchObject({
      config: {
        agents: { max_threads: 1, max_depth: 1 },
        features: { multi_agent: false, multi_agent_v2: false },
      },
    });
  });

  it("does not revive a native route from an old captured policy when managed delegation is off", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
    const captured = bridgeResult().policy;
    const deps = openAiContext({
      childAgentPolicies: { [captured.sessionId]: captured },
      effectiveSettings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-5.6-terra",
        subagentsEnabled: true,
        subagentMax: 12,
        childAgents: { enabled: false, targets: [] },
      },
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("stay with native agents"); });

    expect(resumeCall()).toBeUndefined();
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
  });

  it("hands a follow-up Claude turn the bridge its process needs", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ rootThreadId: "thread-claude" }));
    const claudeThread: Thread = { ...OPENAI_THREAD, id: "thread-claude", modelProvider: "claude" };
    const deps = openAiContext({
      activeThread: claudeThread,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-fable-5", subagentsEnabled: true, subagentMax: 4 },
      claudeStatus: { available: true, loggedIn: true, version: "1", path: "/usr/local/bin/claude", email: null, authMethod: null, subscriptionType: null, warning: null },
      threadProjectBindingsRef: { current: { "thread-claude": "/tmp/project" } },
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("review this"); });

    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({
      childAgentBridgeConfig: BRIDGE_LAUNCH.configPath,
      systemPrompt: expect.stringContaining("OpenKiwi-managed sub-agent delegation is active"),
    }));
    expect(claude.startClaudeTurn.mock.calls[0][0]).not.toHaveProperty("subagentsEnabled");
  });

  it("hands a follow-up Cursor turn the bridge its process needs", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ rootThreadId: CURSOR_THREAD.id }));
    const deps = context();
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("patch this"); });

    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({
      childAgentBridge: { name: BRIDGE_LAUNCH.name, command: BRIDGE_LAUNCH.command, args: BRIDGE_LAUNCH.args },
      systemPrompt: expect.stringContaining("OpenKiwi-managed sub-agent delegation is active"),
    }));
  });

  it("releases a policy captured for an existing thread whose turn never started", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ captured: true }));
    codex.rpc.mockRejectedValue(new Error("runtime unavailable"));
    const deps = openAiContext();
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("split this up"); });

    expect(childSessions.releaseChildAgentSession).toHaveBeenCalledWith("session-1");
  });
});

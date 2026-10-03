import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { PendingTurnStarts } from "../lib/pendingTurnStarts";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import { resetNewThreadTimedPromptsForTests, useNewThreadTimedPrompts } from "../lib/newThreadTimedPrompts";
import type { Thread } from "../types";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  respond: vi.fn(async () => {}),
  runtimeInstanceId: vi.fn(async () => "runtime-1"),
  runtimeThreadState: vi.fn(async () => ({ instance: "runtime-1", loaded: true })),
}));
const claude = vi.hoisted(() => ({
  isClaudeThreadBusyError: vi.fn((_reason?: unknown) => false),
  killClaudeTurn: vi.fn(async () => undefined),
  saveClaudeTranscript: vi.fn(async () => undefined),
  startClaudeTurn: vi.fn(async () => ({ turnId: "claude-turn" })),
  steerClaudeTurn: vi.fn(async () => undefined),
}));
const cursor = vi.hoisted(() => ({
  killCursorTurn: vi.fn(async () => undefined),
  saveCursorTranscript: vi.fn(async () => undefined),
  startCursorTurn: vi.fn(async () => ({ turnId: "turn-new", cursorSessionId: "session-new" })),
  steerCursorTurn: vi.fn(async () => undefined),
}));
const childSessions = vi.hoisted(() => ({
  ensureChildAgentBridge: vi.fn(async (): Promise<unknown> => null),
  cacheChildAgentPolicy: vi.fn(),
  releaseChildAgentSession: vi.fn(),
}));
const worktrees = vi.hoisted(() => ({
  createThreadWorktree: vi.fn(async () => ({ path: "/tmp/new-isolated-worktree", branch: "new", baseCommit: "base", gitDir: "/tmp/project/.git/worktrees/new" })),
}));

vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", () => claude);
vi.mock("../lib/cursor", () => cursor);
vi.mock("../lib/childAgentSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/childAgentSessions")>(),
  ...childSessions,
}));
vi.mock("../lib/worktrees", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/worktrees")>(),
  ...worktrees,
}));

import { forgetQueuedDeliveries, useTurnRunner, type TurnRunnerContext } from "./useTurnRunner";

const NOW = Date.UTC(2026, 9, 3, 12);
const MINUTE = 60_000;
const THREAD: Thread = { id: "thread-cursor", name: null, preview: "Cursor thread", cwd: "/tmp/project", updatedAt: 1, modelProvider: "cursor" };
const CLAUDE_STATUS = { available: true, loggedIn: true, version: "test", path: "/usr/local/bin/claude", authMethod: "subscription", email: "test@example.com", subscriptionType: "max", warning: null };

function context(overrides: Partial<TurnRunnerContext> = {}): TurnRunnerContext {
  return {
    activeThread: THREAD,
    activeWorkspace: { id: "project-1", name: "Project", path: "/tmp/project" },
    activeProject: { id: "project-1", name: "Project", path: "/tmp/project" },
    running: false,
    attachments: [],
    effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "grok-4.5" },
    subscriptionSystemPrompts: { openai: "", claude: "" },
    customAgents: [],
    openRouterModels: [],
    runtimeStatus: null,
    claudeStatus: CLAUDE_STATUS as TurnRunnerContext["claudeStatus"],
    cursorStatus: { available: true, loggedIn: true, version: "test", path: "/usr/local/bin/agent", email: "test@example.com", subscriptionType: "pro", warning: null },
    account: null,
    openRouterReady: false,
    workspaceGitInfo: null,
    draftThreadIsolated: false,
    worktreeBusy: false,
    skillsFolder: "",
    resolveSkillPrompt: vi.fn(async (message: string) => message),
    childAgentPolicies: {},
    childAgentLinks: {},
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: true, cursorReady: true },
    persistChildAgentPolicies: vi.fn(),
    threadWorktreesRef: { current: {} },
    threadProjectBindingsRef: { current: { [THREAD.id]: "/tmp/project" } },
    activeWorkspacePathRef: { current: "/tmp/project" },
    pendingTurnStartsRef: { current: new PendingTurnStarts() },
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
    waitForThreadPreparation: vi.fn(async () => undefined),
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

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function queue() {
  return useTaskStore.getState().tasks[THREAD.id].queuedTurns;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetTaskStore();
  resetNewThreadTimedPromptsForTests();
  forgetQueuedDeliveries();
  vi.clearAllMocks();
  useTaskStore.getState().ensureTask(THREAD.id, "/tmp/project");
  useTaskStore.getState().setActiveThread(THREAD.id);
});
afterEach(() => { vi.useRealTimers(); });

describe("timed prompts in a thread", () => {
  it("lets a regular prompt start immediately instead of waiting behind a future timed prompt", async () => {
    const { result } = renderHook(() => useTurnRunner(context()));
    await act(async () => { expect(await result.current.scheduleMessage("tomorrow's check", NOW + 24 * 60 * MINUTE)).toBe(true); });
    await act(async () => { expect(await result.current.sendMessage("do this now")).toBe(true); });
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "do this now" }));
    expect(queue()).toEqual([expect.objectContaining({ text: "tomorrow's check", deliverAt: NOW + 24 * 60 * MINUTE })]);
  });

  it("never starts early, then starts on time with its attachments while continuously awake", async () => {
    const attachments = [{ path: "/tmp/spec.md", name: "spec.md", kind: "file" as const }];
    const setAttachments = vi.fn();
    const { result } = renderHook(() => useTurnRunner(context({ attachments, setAttachments })));
    await act(async () => { await result.current.scheduleMessage("run the report", NOW + 5 * MINUTE); });
    expect(setAttachments).toHaveBeenCalled();
    await advance(5 * MINUTE - 1_000);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    await advance(1_100);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "run the report",
      attachments: [{ path: "/tmp/spec.md", kind: "file" }],
    }));
    expect(queue()).toEqual([]);
  });

  it("joins the FIFO as an ordinary queued message while busy, without steering, and runs after completion", async () => {
    useTaskStore.getState().setActiveTurn(THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(context({ running: true })));
    await act(async () => { await result.current.scheduleMessage("timed follow-up", NOW + 2 * MINUTE); });
    await advance(2 * MINUTE + 10);
    expect(queue()).toEqual([expect.objectContaining({ text: "timed follow-up", status: "queued", releasedAt: NOW + 2 * MINUTE })]);
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    await act(async () => { useTaskStore.getState().completeTurn(THREAD.id, "turn-live", "completed"); });
    await advance(0);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "timed follow-up" }));
  });

  it("keeps a failed head holding the queue when a timed prompt becomes due behind it", async () => {
    const failed = useTaskStore.getState().enqueueTurn(THREAD.id, "earlier failure", []);
    useTaskStore.getState().setQueuedTurnStatus(THREAD.id, failed.id, "failed", "boom");
    const { result } = renderHook(() => useTurnRunner(context()));
    await act(async () => { await result.current.scheduleMessage("timed", NOW + MINUTE); });
    await advance(MINUTE + 10);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(queue().map((entry) => [entry.text, entry.status, entry.releasedAt !== undefined])).toEqual([
      ["earlier failure", "failed", false],
      ["timed", "queued", true],
    ]);
  });

  it("marks a prompt missed on reopen even when only seconds late, and never sends it", async () => {
    useTaskStore.getState().enqueueTurn(THREAD.id, "deploy at nine", [], { deliverAt: NOW + 10_000 });
    // The app was closed: the new session's first clock check is after the time.
    vi.setSystemTime(NOW + 15_000);
    renderHook(() => useTurnRunner(context()));
    await advance(0);
    expect(queue()[0]).toMatchObject({ text: "deploy at nine", missedAt: NOW + 15_000 });
    await advance(10 * MINUTE);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it("marks a prompt missed after sleep instead of sending it late, then sends only on explicit request", async () => {
    const { result } = renderHook(() => useTurnRunner(context()));
    await act(async () => { await result.current.scheduleMessage("morning summary", NOW + 3 * MINUTE); });
    await advance(MINUTE);
    // The machine sleeps for two hours: wall time jumps, timers did not run.
    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await advance(0);
    const entry = queue()[0];
    expect(entry.missedAt).toBeDefined();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    await act(async () => { expect(result.current.queueTimedMessageNow(entry.id)).toBe(true); });
    await advance(0);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "morning summary" }));
  });

  it("holds a prompt when a twenty-second sleep crosses its deadline", async () => {
    const { result } = renderHook(() => useTurnRunner(context()));
    await act(async () => { await result.current.scheduleMessage("short sleep", NOW + 10_000); });
    vi.setSystemTime(NOW + 20_000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await advance(0);
    expect(queue()[0]).toMatchObject({ missedAt: NOW + 20_000 });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it("reports background sign-in failure on its row without opening settings", async () => {
    const ctx = context({ cursorStatus: { ...context().cursorStatus!, loggedIn: false } });
    const { result } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { await result.current.scheduleMessage("needs login", NOW + 10_000); });
    await advance(10_010);
    expect(queue()[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Sign in to Cursor") });
    expect(ctx.openSettings).not.toHaveBeenCalled();
    expect(ctx.setRuntimeSetupOpen).not.toHaveBeenCalled();
    expect(ctx.setAuthRequiredOpen).not.toHaveBeenCalled();
  });

  it("still opens sign-in settings for an ordinary explicit send", async () => {
    const ctx = context({ cursorStatus: { ...context().cursorStatus!, loggedIn: false } });
    const { result } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { expect(await result.current.sendMessage("explicit send")).toBe(false); });
    expect(ctx.openSettings).toHaveBeenCalledWith("models");
  });

  it.each([
    ["openai", "runtime", "Set up the model runtime"],
    ["openai", "account", "Sign in to ChatGPT"],
    ["openrouter", "key", "Add an OpenRouter API key"],
    ["lmstudio", "server", "Start the LM Studio"],
    ["claude", "login", "Sign in to Claude Code"],
  ] as const)("holds unattended %s %s failures without opening a modal", async (provider, reason, message) => {
    const ctx = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "test-model" },
      runtimeStatus: reason === "runtime" ? null : { available: true } as TurnRunnerContext["runtimeStatus"],
      claudeStatus: { ...CLAUDE_STATUS, loggedIn: false } as TurnRunnerContext["claudeStatus"],
    });
    const { result } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { await result.current.scheduleMessage("needs setup", NOW + 10_000); });
    await advance(10_010);
    expect(useNewThreadTimedPrompts.getState().prompts["/tmp/project"][0]).toMatchObject({ status: "failed", error: expect.stringContaining(message) });
    expect(ctx.openSettings).not.toHaveBeenCalled();
    expect(ctx.setRuntimeSetupOpen).not.toHaveBeenCalled();
    expect(ctx.setAuthRequiredOpen).not.toHaveBeenCalled();
  });

  it("uses live provider readiness after navigating away from the scheduled thread", async () => {
    let ctx = context({ cursorStatus: { ...context().cursorStatus!, loggedIn: false } });
    const { result, rerender } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { await result.current.scheduleMessage("signed in later", NOW + 10_000); });
    const otherThread = { ...THREAD, id: "another-thread", cwd: "/tmp/other-project" };
    useTaskStore.getState().setActiveThread(otherThread.id);
    ctx = { ...ctx, activeThread: otherThread, activeWorkspace: { id: "other", name: "Other", path: "/tmp/other-project" }, cursorStatus: context().cursorStatus };
    rerender();
    await advance(10_010);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD.id, cwd: "/tmp/project", prompt: "signed in later" }));
    expect(queue()).toEqual([]);
  });

  it("refuses past times and supports rescheduling a missed prompt into the future", async () => {
    const setError = vi.fn();
    const { result, rerender } = renderHook(() => useTurnRunner(context({ setError })));
    await act(async () => { expect(await result.current.scheduleMessage("too late", NOW - 1)).toBe(false); });
    expect(setError).toHaveBeenCalledWith("Choose a delivery time in the future.");
    useTaskStore.getState().enqueueTurn(THREAD.id, "missed", [], { deliverAt: NOW + 1_000 });
    useTaskStore.getState().markTimedTurnsMissed(THREAD.id, [queue()[0].id]);
    await act(async () => { expect(result.current.rescheduleQueuedMessage(queue()[0].id, NOW + 10 * MINUTE)).toBe(true); });
    expect(queue()[0].missedAt).toBeUndefined();
    // App re-renders on queue changes, attaching the open thread's live context.
    rerender();
    await advance(10 * MINUTE + 10);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "missed" }));
  });
});

describe("timed first prompt of a new thread", () => {
  it("starts a restored missed new conversation from an existing thread view using its project root", async () => {
    const prompt = useNewThreadTimedPrompts.getState().add({
      workspacePath: "/tmp/project", workspaceName: "Project", text: "restored isolated prompt", attachments: [], deliverAt: NOW - 1_000,
      snapshot: { provider: "claude", model: "claude-opus-5", reasoningEffort: "high", ultra: false, permission: "ask", serviceTier: null, subagentsEnabled: false, isolated: true },
    });
    const ctx = context({
      activeThreadIsChild: true,
      workspaceGitInfo: { isRepo: true, isRoot: true, hasCommit: true },
      executionPathFor: (threadId, path) => threadId === THREAD.id ? "/tmp/existing-child-worktree" : path,
    });
    const { result } = renderHook(() => useTurnRunner(ctx));
    await advance(0);
    expect(useNewThreadTimedPrompts.getState().prompts["/tmp/project"][0].missedAt).toBeDefined();
    await act(async () => { expect(result.current.sendNewThreadPromptNow(prompt.id)).toBe(true); });
    await advance(0);
    expect(worktrees.createThreadWorktree).toHaveBeenCalledWith("/tmp/project", "restored isolated prompt");
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/new-isolated-worktree" }));
    expect(childSessions.ensureChildAgentBridge).toHaveBeenCalledWith(expect.objectContaining({ isChildThread: false }));
    expect(useTaskStore.getState().activeThreadId).toBe(THREAD.id);
  });

  it("keeps a refused manual start's reason on its own row", async () => {
    const prompt = useNewThreadTimedPrompts.getState().add({
      workspacePath: "/tmp/other", workspaceName: "Other", text: "other workspace", attachments: [], deliverAt: NOW - 1_000,
      snapshot: { provider: "claude", model: "claude-opus-5", reasoningEffort: "high", ultra: false, permission: "ask", serviceTier: null, subagentsEnabled: false, isolated: false },
    });
    const ctx = context();
    const { result } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { expect(result.current.sendNewThreadPromptNow(prompt.id)).toBe(false); });
    expect(useNewThreadTimedPrompts.getState().prompts["/tmp/other"][0]).toMatchObject({ status: "failed", error: expect.stringContaining("workspace") });
    expect(ctx.setError).not.toHaveBeenCalled();
  });

  it("selects the scheduled provider's system policy after the visible draft switches provider", async () => {
    useTaskStore.getState().setActiveThread(null);
    let ctx = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5", systemPrompt: "Claude project policy" },
      subscriptionSystemPrompts: { claude: "Claude project policy", openai: "Codex project policy", cursor: "Cursor project policy" },
    });
    const { result, rerender } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { await result.current.scheduleMessage("provider policy", NOW + 10_000); });
    ctx = { ...ctx, effectiveSettings: { ...ctx.effectiveSettings, provider: "openai", systemPrompt: "Codex project policy" } };
    rerender();
    await advance(10_010);
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Claude project policy") }));
    expect(claude.startClaudeTurn).not.toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Codex project policy") }));
  });

  it("starts a new thread from the scheduling snapshot without hijacking the visible draft", async () => {
    useTaskStore.getState().setActiveThread(null);
    let ctx = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5" },
      threadProjectBindingsRef: { current: {} },
    });
    const { result, rerender } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { expect(await result.current.scheduleMessage("first prompt", NOW + 2 * MINUTE)).toBe(true); });
    expect(useNewThreadTimedPrompts.getState().prompts["/tmp/project"]).toEqual([
      expect.objectContaining({ text: "first prompt", snapshot: expect.objectContaining({ provider: "claude", model: "claude-opus-5" }) }),
    ]);
    // The user switches the draft picker to another provider afterwards.
    ctx = { ...ctx, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "grok-4.5" } };
    rerender();
    await advance(2 * MINUTE + 10);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first prompt", model: "claude-opus-5" }));
    expect(ctx.setStartingDraftTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(ctx.onThreadCreated).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ deferred: true }));
    expect(useNewThreadTimedPrompts.getState().prompts).toEqual({});
  });

  it("marks a restored first prompt missed at launch and starts it only when the user asks", async () => {
    useTaskStore.getState().setActiveThread(null);
    const ctx = context({ activeThread: null, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5" } });
    const { result, unmount } = renderHook(() => useTurnRunner(ctx));
    await act(async () => { await result.current.scheduleMessage("first prompt", NOW + MINUTE); });
    unmount();
    // Relaunch two seconds after the time.
    forgetQueuedDeliveries();
    vi.setSystemTime(NOW + MINUTE + 2_000);
    const relaunched = renderHook(() => useTurnRunner(ctx));
    await advance(0);
    const [prompt] = useNewThreadTimedPrompts.getState().prompts["/tmp/project"];
    expect(prompt.missedAt).toBeDefined();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    await act(async () => { expect(relaunched.result.current.sendNewThreadPromptNow(prompt.id)).toBe(true); });
    await advance(0);
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "first prompt" }));
  });
});

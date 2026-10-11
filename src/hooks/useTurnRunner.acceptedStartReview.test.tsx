import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { PendingTurnStarts } from "../lib/pendingTurnStarts";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(), respond: vi.fn(),
  runtimeInstanceId: vi.fn(async () => "review-runtime"),
  runtimeThreadState: vi.fn(async () => ({ instance: "review-runtime", loaded: true })),
}));
const claude = vi.hoisted(() => ({
  startClaudeTurn: vi.fn(), killClaudeTurn: vi.fn(), saveClaudeTranscript: vi.fn(async () => {}),
  steerClaudeTurn: vi.fn(), isClaudeThreadBusyError: vi.fn(() => false),
}));
const worktrees = vi.hoisted(() => ({ createThreadWorktree: vi.fn(async () => ({ path: "/tmp/review-isolated", gitDir: "/tmp/review-project/.git/worktrees/review", branch: "review", baseCommit: "base" })) }));
vi.mock("../lib/codex", () => codex);
vi.mock("../lib/claude", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/claude")>(), ...claude }));
vi.mock("../lib/worktrees", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/worktrees")>(), ...worktrees }));
vi.mock("../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../lib/childAgentSessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/childAgentSessions")>(),
  ensureChildAgentBridge: vi.fn(async () => null),
}));
vi.mock("../lib/preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => true,
  loadPreferenceLearning: async () => {},
  getPreferenceLearningScope: (scopeKey: string) => ({ scopeKey, enabled: false, markdown: "" }),
}));

import { forgetQueuedDeliveries, useTurnRunner, type TurnRunnerContext } from "./useTurnRunner";

function context(): TurnRunnerContext {
  return {
    activeThread: null, activeWorkspace: { id: "review", name: "Review", path: "/tmp/review-project" },
    activeProject: null, running: false, attachments: [],
    effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai" },
    subscriptionSystemPrompts: { openai: "", claude: "" }, customAgents: [], openRouterModels: [],
    runtimeStatus: { available: true, source: "Codex CLI", path: "/fixture/codex", version: "99.0.0", compatible: true, warning: null },
    claudeStatus: null, cursorStatus: null, account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" },
    openRouterReady: false, workspaceGitInfo: null, draftThreadIsolated: false, worktreeBusy: false, skillsFolder: "",
    resolveSkillPrompt: vi.fn(async (text: string) => text), childAgentPolicies: {}, childAgentLinks: {},
    childAgentReadiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: false, claudeReady: false, cursorReady: false },
    persistChildAgentPolicies: vi.fn(), threadWorktreesRef: { current: {} }, threadProjectBindingsRef: { current: {} },
    activeWorkspacePathRef: { current: "/tmp/review-project" }, pendingTurnStartsRef: { current: new PendingTurnStarts() },
    skillRuntimeRootRef: { current: "" }, cursorSessionIdsRef: { current: {} }, executionPathFor: (_id, path) => path,
    bindThreadToProject: vi.fn(), rememberThread: vi.fn(), onThreadCreated: vi.fn(), persistThreadModel: vi.fn(),
    persistThreadReasoning: vi.fn(), persistThreadWorktrees: vi.fn(), restartRuntimeForCapabilities: vi.fn(async () => "review-runtime"),
    waitForThreadPreparation: vi.fn(async () => {}), beginRunCheckpoint: vi.fn(async () => "checkpoint"), discardRunCheckpoint: vi.fn(),
    refreshLocalSkills: vi.fn(async () => {}), ensureSkillRoots: vi.fn(async () => {}), scheduleClaudeThreadSave: vi.fn(),
    scheduleCursorThreadSave: vi.fn(), setThreads: vi.fn(), setActiveThread: vi.fn(), setAttachments: vi.fn(),
    setDraftThreadIsolated: vi.fn(), setStartingDraftTurn: vi.fn(), setError: vi.fn(), setStatus: vi.fn(),
    setTransientStatus: vi.fn(), setRuntimeSetupOpen: vi.fn(), setAuthRequiredOpen: vi.fn(), openSettings: vi.fn(),
  };
}

beforeEach(() => {
  resetTaskStore(); forgetQueuedDeliveries(); vi.clearAllMocks();
  claude.killClaudeTurn.mockResolvedValue(undefined);
});

it("keeps a provider-accepted first prompt delivered when the requested interrupt fails", async () => {
  let releaseStart!: () => void;
  const start = new Promise<{ turn: { id: string } }>((resolve) => { releaseStart = () => resolve({ turn: { id: "accepted-turn" } }); });
  codex.rpc.mockImplementation(async (method: string) => {
    if (method === "thread/start") return { thread: { id: "accepted-thread", name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } };
    if (method === "turn/start") return start;
    if (method === "turn/interrupt") throw new Error("Fixture interrupt failed");
    return {};
  });
  const deps = context();
  const authoredAccepted = vi.fn(); deps.onAuthoredPromptAccepted = authoredAccepted;
  const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
  let delivered!: Promise<boolean>;
  await act(async () => { delivered = result.current.sendMessage("Already accepted by the provider"); });
  await waitFor(() => expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.anything()));
  const createdThread = { id: "accepted-thread", name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" };
  rerender({ value: { ...deps, activeThread: createdThread, running: true } });
  await act(async () => { await result.current.stopTurn(); });
  await act(async () => { releaseStart(); expect(await delivered).toBe(true); });
  expect(authoredAccepted).toHaveBeenCalledOnce();
  expect(useTaskStore.getState().tasks["accepted-thread"].messages).toEqual([
    expect.objectContaining({ text: "Already accepted by the provider" }),
  ]);
  expect(useTaskStore.getState().activeThreadId).toBe("accepted-thread");
});

it("keeps an accepted Claude first prompt delivered when its requested hard Stop fails", async () => {
  let releaseStart!: () => void;
  const start = new Promise<{ turnId: string }>((resolve) => { releaseStart = () => resolve({ turnId: "accepted-claude-turn" }); });
  claude.startClaudeTurn.mockReturnValue(start);
  claude.killClaudeTurn.mockRejectedValue(new Error("Fixture Claude hard Stop failed"));
  const deps = context();
  deps.effectiveSettings = { ...DEFAULT_SETTINGS, provider: "claude" };
  deps.claudeStatus = { available: true, loggedIn: true, path: "/fixture/claude", version: "99.0.0", authMethod: null, email: null, subscriptionType: null, warning: null };
  const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
  let delivered!: Promise<boolean>;
  await act(async () => { delivered = result.current.sendMessage("Accepted Claude prompt"); });
  await waitFor(() => expect(claude.startClaudeTurn).toHaveBeenCalledOnce());
  const threadId = useTaskStore.getState().activeThreadId!;
  rerender({ value: { ...deps, activeThread: { id: threadId, name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "claude" }, running: true } });
  await act(async () => { await result.current.stopTurn(); });
  await act(async () => { releaseStart(); expect(await delivered).toBe(true); });
  expect(claude.killClaudeTurn).toHaveBeenCalledExactlyOnceWith(threadId);
  expect(useTaskStore.getState().tasks[threadId].messages).toEqual([expect.objectContaining({ text: "Accepted Claude prompt" })]);
  expect(useTaskStore.getState().activeThreadId).toBe(threadId);
  expect(deps.discardRunCheckpoint).not.toHaveBeenCalled();
});

it("keeps provider, model, permissions, folder, and durable attachments captured before background navigation", async () => {
  const deps = context(); const selected = { current: null as string | null };
  deps.activeFirstPromptIdRef = selected;
  deps.onFirstPromptStarted = (prompt) => { selected.current = prompt.id; };
  deps.effectiveSettings = { ...DEFAULT_SETTINGS, provider: "openai", model: "captured-model", permission: "read-only" };
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: "captured-thread", name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "captured-turn" } });
  const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
  let attempt!: string;
  await act(async () => { attempt = result.current.beginFirstPrompt("Captured first prompt")!; });
  selected.current = null;
  deps.activeWorkspacePathRef.current = "/tmp/unrelated-project";
  rerender({ value: { ...context(), activeThread: { id: "unrelated-thread", name: null, preview: "", cwd: "/tmp/unrelated-project", updatedAt: 1, modelProvider: "claude" },
    activeWorkspace: { id: "other", name: "Other", path: "/tmp/unrelated-project" }, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "claude", model: "other-model", permission: "full" },
    attachments: [{ name: "wrong.png", path: "/tmp/wrong.png", kind: "image" }], activeFirstPromptIdRef: selected } });
  useTaskStore.getState().setActiveThread("unrelated-thread");
  await act(async () => { expect(await result.current.sendMessage("Captured first prompt", { firstPromptAttemptId: attempt, attachments: [{ name: "original.png", path: "/tmp/original.png", kind: "image" }] })).toBe(true); });
  expect(codex.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: "/tmp/review-project", model: "captured-model", sandbox: "read-only" }));
  expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ sandboxPolicy: expect.objectContaining({ type: "readOnly" }), input: expect.arrayContaining([expect.objectContaining({ type: "localImage", path: "/tmp/original.png" })]) }));
  expect(JSON.stringify(codex.rpc.mock.calls)).not.toContain("wrong.png");
  expect(claude.startClaudeTurn).not.toHaveBeenCalled();
  expect(useTaskStore.getState().activeThreadId).toBe("unrelated-thread");
});

it("guards a duplicate begin while the acknowledged draft is selected", async () => {
  const deps = context(); const selected = { current: null as string | null };
  deps.activeFirstPromptIdRef = selected;
  deps.onFirstPromptStarted = (prompt) => { selected.current = prompt.id; };
  const { result } = renderHook(() => useTurnRunner(deps));
  let first!: string; let duplicate: string | undefined;
  await act(async () => { first = result.current.beginFirstPrompt("First acknowledgement")!; duplicate = result.current.beginFirstPrompt("Duplicate acknowledgement"); });
  expect(duplicate).toBeUndefined();
  expect(result.current.pendingFirstPrompts).toHaveLength(1);
  expect(result.current.pendingFirstPrompts[0].id).toBe(first);
  await act(async () => { result.current.finishFirstPrompt(first); });
});

it("dispatches an acknowledged first prompt once despite duplicate delivery calls", async () => {
  const deps = context(); let release!: (text: string) => void;
  deps.resolveSkillPrompt = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: "single-thread", name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "single-turn" } });
  const { result } = renderHook(() => useTurnRunner(deps));
  let attempt!: string; let delivered!: Promise<boolean>;
  await act(async () => {
    attempt = result.current.beginFirstPrompt("Send only once")!;
    delivered = result.current.sendMessage("Send only once", { firstPromptAttemptId: attempt });
    expect(await result.current.sendMessage("Send only once", { firstPromptAttemptId: attempt })).toBe(false);
  });
  await act(async () => { release("Send only once"); expect(await delivered).toBe(true); });
  expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
});

it("rejects a changed prompt for an earlier acknowledgement without consuming the original", async () => {
  const deps = context();
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: "original-thread", name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "original-turn" } });
  const { result } = renderHook(() => useTurnRunner(deps));
  let attempt!: string;
  await act(async () => { attempt = result.current.beginFirstPrompt("Original acknowledged prompt")!; });
  await act(async () => { expect(await result.current.sendMessage("Changed prompt", { firstPromptAttemptId: attempt })).toBe(false); });
  expect(codex.rpc).not.toHaveBeenCalled();
  expect(result.current.pendingFirstPrompts).toHaveLength(1);
  await act(async () => { expect(await result.current.sendMessage("Original acknowledged prompt", { firstPromptAttemptId: attempt })).toBe(true); });
});

it("does not clear a newer draft's isolation preference when a background isolated first prompt is created", async () => {
  const deps = context(); const selected = { current: null as string | null };
  deps.activeFirstPromptIdRef = selected; deps.onFirstPromptStarted = (prompt) => { selected.current = prompt.id; };
  deps.activeProject = { id: "review", name: "Review", path: "/tmp/review-project" };
  deps.workspaceGitInfo = { isRepo: true, isRoot: true, hasCommit: true };
  deps.draftThreadIsolated = true;
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: "isolated-thread", name: null, preview: "", cwd: "/tmp/review-isolated", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "isolated-turn" } });
  const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
  let attempt!: string;
  await act(async () => { attempt = result.current.beginFirstPrompt("Isolated original first prompt")!; });
  selected.current = null;
  rerender({ value: { ...deps, draftThreadIsolated: true } });
  await act(async () => { expect(await result.current.sendMessage("Isolated original first prompt", { firstPromptAttemptId: attempt, attachments: [] })).toBe(true); });
  expect(deps.setDraftThreadIsolated).not.toHaveBeenCalled();
});

it("stops only the selected first prompt while another first prompt prepares in the same workspace", async () => {
  const releases = new Map<string, (text: string) => void>();
  const deps = context();
  const selected = { current: null as string | null };
  deps.activeFirstPromptIdRef = selected;
  deps.onFirstPromptStarted = (prompt) => { selected.current = prompt.id; };
  deps.onFirstPromptFinished = (id) => { if (selected.current === id) selected.current = null; };
  deps.resolveSkillPrompt = vi.fn((text: string) => new Promise<string>((resolve) => { releases.set(text, resolve); }));
  let threadCount = 0;
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: `review-thread-${++threadCount}`, name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "review-turn" } });
  const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
  let first!: Promise<boolean>; let second!: Promise<boolean>; let firstId!: string; let secondId!: string;
  await act(async () => { firstId = result.current.beginFirstPrompt("First prompt")!; first = result.current.sendMessage("First prompt", { firstPromptAttemptId: firstId }); });
  selected.current = null;
  rerender({ value: { ...deps, running: false } });
  await act(async () => { secondId = result.current.beginFirstPrompt("Second prompt")!; second = result.current.sendMessage("Second prompt", { firstPromptAttemptId: secondId }); });
  rerender({ value: { ...deps, running: true } });
  await act(async () => { await result.current.stopTurn(); });
  expect(result.current.pendingFirstPrompts.find((prompt) => prompt.id === firstId)?.status).toBe("starting");
  expect(result.current.pendingFirstPrompts.find((prompt) => prompt.id === secondId)?.status).toBe("stopping");
  await act(async () => { releases.get("Second prompt")!("Second prompt"); expect(await second).toBe(false); });
  await act(async () => { releases.get("First prompt")!("First prompt"); expect(await first).toBe(true); });
  expect(codex.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  expect(useTaskStore.getState().activeThreadId).toBeNull();
});

it("keeps the selected first prompt starting when an earlier background first prompt finishes", async () => {
  const releases = new Map<string, (text: string) => void>();
  const deps = context(); const selected = { current: null as string | null };
  let starting = false;
  deps.activeFirstPromptIdRef = selected;
  deps.setStartingDraftTurn = vi.fn((value: boolean) => { starting = value; });
  deps.onFirstPromptStarted = (prompt) => { selected.current = prompt.id; };
  deps.onFirstPromptFinished = (id) => { if (selected.current === id) selected.current = null; };
  deps.resolveSkillPrompt = vi.fn((text: string) => new Promise<string>((resolve) => { releases.set(text, resolve); }));
  let threadCount = 0;
  codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
    ? { thread: { id: `review-thread-${++threadCount}`, name: null, preview: "", cwd: "/tmp/review-project", updatedAt: 1, modelProvider: "openai" } }
    : { turn: { id: "review-turn" } });
  const { result } = renderHook(() => useTurnRunner(deps));
  let first!: Promise<boolean>; let second!: Promise<boolean>;
  await act(async () => { const id = result.current.beginFirstPrompt("First prompt")!; first = result.current.sendMessage("First prompt", { firstPromptAttemptId: id }); });
  selected.current = null;
  await act(async () => { const id = result.current.beginFirstPrompt("Second prompt")!; second = result.current.sendMessage("Second prompt", { firstPromptAttemptId: id }); });
  await act(async () => { releases.get("First prompt")!("First prompt"); expect(await first).toBe(true); });
  const retainedStartingState = starting;
  await act(async () => { releases.get("Second prompt")!("Second prompt"); expect(await second).toBe(true); });
  expect(retainedStartingState).toBe(true);
});

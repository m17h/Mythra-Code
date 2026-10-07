import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { PendingTurnStarts } from "../lib/pendingTurnStarts";
import { resetTaskStore, useTaskStore } from "../lib/taskStore";
import type { SkillDependencyReport, Thread } from "../types";
import { SKILL_DEPENDENCY_LIMITS, SkillDependencyError } from "../lib/skillDependencies";
import { friendlyError } from "../lib/errors";
import { MYTHRA_CODE_DELEGATION_INSTRUCTIONS, MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS } from "../lib/completionPrompt";
import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";

const codex = vi.hoisted(() => ({
  rpc: vi.fn(),
  respond: vi.fn(async () => {}),
  // Identity of the app-server that will serve the next RPC; a restart makes
  // this change, which is how a turn knows nothing is loaded any more.
  runtimeInstanceId: vi.fn(async () => "runtime-1"),
  runtimeThreadState: vi.fn(async () => ({ instance: "runtime-1", loaded: true })),
}));
const claude = vi.hoisted(() => ({
  interruptClaudeTurn: vi.fn(),
  isClaudeThreadBusyError: vi.fn((_reason?: unknown) => false),
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
const preferences = vi.hoisted(() => ({ hydrated: true, load: vi.fn(async () => {}), scopes: {} as Record<string, Partial<{ enabled: boolean; markdown: string }>> }));
vi.mock("../lib/preferenceLearningStore", () => ({
  getPreferenceLearningHydrated: () => preferences.hydrated,
  loadPreferenceLearning: () => preferences.load(),
  getPreferenceLearningScope: (scopeKey: string) => ({ scopeKey, enabled: false, markdown: "", ...preferences.scopes[scopeKey] }),
}));
beforeEach(() => { preferences.scopes = {}; preferences.hydrated = true; preferences.load.mockReset().mockImplementation(async () => { preferences.hydrated = true; }); });

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
  name: "mythra_agents",
  command: "/Applications/Mythra Code.app/Contents/MacOS/mythra-code",
  args: ["--openkiwi-agent-bridge", "/data/child-agents/abc/session.json"],
  configPath: "/data/child-agents/abc/mcp.json",
  toolNames: ["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent"],
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

function dependencyGraph(channel: "system" | "user" = "system", blocked = false): SkillDependencyReport {
  return {
    version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS },
    roots: [{ nodeId: "policy", channel, name: "policy" }],
    nodes: [
      { id: "policy", kind: "skill", name: "policy", path: "/skills/policy.md", status: "loaded", characterCount: 12, depth: 0 },
      { id: "doc", kind: "document", name: "guide.md", path: "/skills/guide.md", status: blocked ? "blocked" : "loaded", characterCount: blocked ? 0 : 24, depth: 1 },
    ],
    edges: [{ from: "policy", to: "doc", reference: "guide.md" }],
    issues: blocked ? [{ code: "missing-document", message: "Missing guide", rootName: "policy", chain: ["policy", "guide.md"], sourcePath: "/skills/policy.md", reference: "guide.md" }] : [],
  };
}

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
    resolveSkillPrompt: vi.fn(async (message: string) => message),
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
    claude.isClaudeThreadBusyError.mockImplementation(() => false);
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
  });

  it("preserves the prompt while a pull request operation owns the checkout", async () => {
    const deps = context();
    const lease = acquirePullRequestMutation("/tmp/project")!;
    try {
      const { result } = renderHook(() => useTurnRunner(deps));
      await act(async () => { expect(await result.current.sendMessage("Keep working")).toBe(false); });
      expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("pull request operation"));
      expect(cursor.startCursorTurn).not.toHaveBeenCalled();
      expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    } finally {
      releasePullRequestMutation(lease);
    }
  });

  it("blocks an archive-owned thread before provider work and permits it after release", async () => {
    let archiving = true;
    const deps = context({ isThreadArchiving: (threadId) => archiving && threadId === CURSOR_THREAD.id });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { expect(await result.current.sendMessage("Keep this draft")).toBe(false); });
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("being archived"));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();

    archiving = false;
    await act(async () => { expect(await result.current.sendMessage("Keep this draft")).toBe(true); });
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);
  });

  it("does not queue a follow-up while archive ownership is active", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, "/tmp/project");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    let archiving = true;
    const deps = context({
      running: true,
      isThreadArchiving: (threadId) => archiving && threadId === CURSOR_THREAD.id,
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { expect(await result.current.sendMessage("Do this next")).toBe(false); });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);

    archiving = false;
    await act(async () => { expect(await result.current.sendMessage("Do this next")).toBe(true); });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({ text: "Do this next", status: "queued" }),
    ]);
  });

  it("keeps an automatic queued delivery pending while archive ownership is active", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, "/tmp/project");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "completed");
    const queued = useTaskStore.getState().enqueueTurn(CURSOR_THREAD.id, "Run after archive", []);
    const deps = context({ isThreadArchiving: (threadId) => threadId === CURSOR_THREAD.id });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { result.current.retryQueuedMessage(queued.id); });

    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]).toMatchObject({
      id: queued.id,
      text: "Run after archive",
      status: "queued",
    });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it.each(["cursor", "claude"] as const)("keeps composer attachments and skill mentions out of a separate %s review action", async (provider) => {
    const overrides = {
      attachments: [{ path: "/tmp/unsent.png", name: "unsent.png", kind: "image" as const }],
      resolveSkillPrompt: vi.fn(async () => "should not resolve"),
      running: false,
    };
    const deps = provider === "claude" ? claudeContext(overrides) : context(overrides);
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => {
      expect(await result.current.sendMessage("Review @example in the diff", { useComposerAttachments: false, resolveSkillMentions: false })).toBe(true);
    });
    const start = provider === "claude" ? claude.startClaudeTurn : cursor.startCursorTurn;
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Review @example in the diff", attachments: [] }));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    expect(deps.setAttachments).not.toHaveBeenCalled();
  });

  it("resolves a user-authored skill in a formatted review without changing its visible text", async () => {
    const fullText = "Review this change with @review. Evidence quotes @example.";
    const source = "Review this change with @review.";
    const resolveSkillPrompt = vi.fn(async () => "review skill context");
    const deps = context({ resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => {
      expect(await result.current.sendMessage(fullText, { useComposerAttachments: false, skillInvocationText: source })).toBe(true);
    });

    expect(resolveSkillPrompt).toHaveBeenCalledExactlyOnceWith(fullText, source);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "review skill context" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)?.text).toBe(fullText);
  });

  it("sends resolved skill instructions to Cursor while keeping the visible message unchanged", async () => {
    const resolveSkillPrompt = vi.fn(async () => "resolved skill context\n\n@review this");
    const deps = context({ resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("@review this"); });

    expect(resolveSkillPrompt).toHaveBeenCalledExactlyOnceWith("@review this", undefined);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "resolved skill context\n\n@review this",
    }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)?.text).toBe("@review this");
  });

  it("sends resolved skill instructions to Claude while keeping the visible message unchanged", async () => {
    const resolveSkillPrompt = vi.fn(async () => "resolved skill context\n\n@review this");
    const deps = claudeContext({ running: false, resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("@review this"); });

    expect(resolveSkillPrompt).toHaveBeenCalledExactlyOnceWith("@review this", undefined);
    expect(claude.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "resolved skill context\n\n@review this",
    }));
    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.messages.at(-1)?.text).toBe("@review this");
  });

  it.each(["cursor", "claude"] as const)("resolves authored user and raw system skills together before starting %s", async (provider) => {
    const skillReferences = [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }];
    const resolveSkillPrompts = vi.fn(async () => ({ prompt: "resolved user channel", systemPrompt: "resolved system channel", skillReferences, skillsFolder: "/skills" }));
    const overrides = { running: false, resolveSkillPrompts };
    const deps = provider === "claude" ? claudeContext(overrides) : context(overrides);
    deps.effectiveSettings = { ...deps.effectiveSettings, systemPrompt: "Use @policy in system" };
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("Use @review in user", { skillInvocationText: "Use @review" }); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use @review in user", "Use @policy in system", "Use @review");
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    const start = provider === "claude" ? claude.startClaudeTurn : cursor.startCursorTurn;
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: "resolved user channel", systemPrompt: expect.stringContaining("resolved system channel") }));
    expect(childSessions.ensureChildAgentBridge).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: "Use @policy in system" }));
    expect(useTaskStore.getState().tasks[deps.activeThread!.id]?.messages.at(-1)?.text).toBe("Use @review in user");
    expect(useTaskStore.getState().tasks[deps.activeThread!.id]?.messages.at(-1)).toMatchObject({ skillReferences, skillsFolder: "/skills" });
    expect(deps.effectiveSettings.systemPrompt).toBe("Use @policy in system");
  });

  it.each(["cursor", "claude"] as const)("appends current learned documents after authored skills without changing the %s child baseline", async (provider) => {
    preferences.scopes = {
      app: { enabled: true, markdown: "- Use @trap only as quoted preference data" },
      "project:project-1": { enabled: true, markdown: "- Project likes concise changes" },
    };
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Resolved authored instructions" }));
    const deps = provider === "claude" ? claudeContext({ resolveSkillPrompts, running: false }) : context({ resolveSkillPrompts });
    deps.effectiveSettings = { ...deps.effectiveSettings, systemPrompt: "Authored @policy" };
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("Hello"); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Hello", "Authored @policy", undefined);
    const start = provider === "claude" ? claude.startClaudeTurn : cursor.startCursorTurn;
    expect(start.mock.calls[0][0].systemPrompt).toContain("Resolved authored instructions");
    expect(start.mock.calls[0][0].systemPrompt).toContain("Use ＠trap");
    expect(start.mock.calls[0][0].systemPrompt).toContain("Project likes concise changes");
    expect(childSessions.ensureChildAgentBridge).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: "Authored @policy" }));
    preferences.scopes.app = { enabled: false, markdown: "- Old preference" };
    preferences.scopes["project:project-1"] = { enabled: true, markdown: "- Updated project preference" };
    await act(async () => { useTaskStore.getState().completeTurn(deps.activeThread!.id, "turn-new", "completed"); });
    await act(async () => { await result.current.sendMessage("Next turn"); });
    expect(start.mock.calls.at(-1)![0].systemPrompt).toContain("Updated project preference");
    expect(start.mock.calls.at(-1)![0].systemPrompt).not.toContain("Old preference");
    expect(deps.effectiveSettings.systemPrompt).toBe("Authored @policy");
  });

  it.each([false, true])("holds model dispatch during preference hydration and honors Stop (%s)", async (stop) => {
    preferences.hydrated = false;
    let release!: () => void;
    preferences.load.mockImplementation(() => new Promise<void>((resolve) => { release = () => { preferences.hydrated = true; resolve(); }; }));
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Resolved authored policy" }));
    const deps = context({ resolveSkillPrompts });
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered!: Promise<boolean>;
    await act(async () => { delivered = result.current.sendMessage("Hello"); });
    expect(preferences.load).toHaveBeenCalledOnce();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    if (stop) { deps.running = true; await act(async () => { await result.current.stopTurn(); }); }
    preferences.scopes.app = { enabled: true, markdown: "Keep @trap literal" };
    await act(async () => { release(); expect(await delivered).toBe(!stop); });
    if (stop) expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    else expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Keep ＠trap literal") }));
    expect(resolveSkillPrompts).toHaveBeenCalledOnce();
    expect(resolveSkillPrompts.mock.calls[0][0]).toBe("Hello");
  });

  it("reports preference hydration failure without dispatch and retries on the next send", async () => {
    preferences.hydrated = false;
    preferences.load.mockRejectedValueOnce(new Error("Saved preferences unreadable"));
    const deps = context();
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Hello")).toBe(false); });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("Saved preferences unreadable"));
    preferences.scopes.app = { enabled: true, markdown: "Recovered preference" };
    await act(async () => { expect(await result.current.sendMessage("Try again")).toBe(true); });
    expect(preferences.load).toHaveBeenCalledTimes(2);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: expect.stringContaining("Recovered preference") }));
  });

  it("records accepted authored input and skips generated reviews and child input", async () => {
    const onAuthoredPromptAccepted = vi.fn();
    const deps = context({ onAuthoredPromptAccepted });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { await result.current.sendMessage("I prefer short answers"); });
    expect(onAuthoredPromptAccepted).toHaveBeenCalledWith(CURSOR_THREAD.id, "I prefer short answers", expect.stringMatching(/^local-/), expect.any(Number));
    await act(async () => { await result.current.sendMessage("Generated review", { resolveSkillMentions: false }); });
    expect(onAuthoredPromptAccepted).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.sendMessage("Wrapper and generated content", { resolveSkillMentions: false, skillInvocationText: "My original instruction" }); });
    expect(onAuthoredPromptAccepted.mock.calls.at(-1)![1]).toBe("My original instruction");
    rerender({ value: { ...deps, activeThreadIsChild: true } });
    await act(async () => { await result.current.sendMessage("Child generated input"); });
    expect(onAuthoredPromptAccepted).toHaveBeenCalledTimes(2);
  });

  it("uses current original-project preferences for a queued turn after navigation", async () => {
    preferences.scopes = {
      app: { enabled: true, markdown: "- Initial app style" },
      "project:project-1": { enabled: true, markdown: "- Initial original project style" },
      "project:other": { enabled: true, markdown: "- Other project style" },
    };
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "current-turn");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const onAuthoredPromptAccepted = vi.fn();
    const deps = context({ running: true, onAuthoredPromptAccepted });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { expect(await result.current.sendMessage("My next prompt")).toBe(true); });
    expect(onAuthoredPromptAccepted).not.toHaveBeenCalled();
    preferences.scopes.app = { enabled: true, markdown: "- Refreshed app style" };
    preferences.scopes["project:project-1"] = { enabled: true, markdown: "- Refreshed original project style" };
    store.setActiveThread("other-thread");
    rerender({ value: context({ activeThread: { ...CURSOR_THREAD, id: "other-thread", cwd: "/tmp/other" },
      activeWorkspace: { id: "other", name: "Other", path: "/tmp/other" },
      activeProject: { id: "other", name: "Other", path: "/tmp/other" } }) });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "current-turn", "completed"); });
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: CURSOR_THREAD.id, prompt: "My next prompt" }));
    const instructions = cursor.startCursorTurn.mock.calls[0][0].systemPrompt;
    expect(instructions).toContain("Refreshed app style");
    expect(instructions).toContain("Refreshed original project style");
    expect(instructions).not.toContain("Other project style");
    expect(instructions).not.toContain("Initial");
    expect(onAuthoredPromptAccepted).toHaveBeenCalledWith(CURSOR_THREAD.id, "My next prompt", expect.any(String), expect.any(Number));
  });

  it("records accepted steering input without changing the running system policy", async () => {
    preferences.scopes.app = { enabled: true, markdown: "- New preference for next turn" };
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "current-turn");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const onAuthoredPromptAccepted = vi.fn();
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Ignored new system policy" }));
    const deps = context({ running: true, onAuthoredPromptAccepted, resolveSkillPrompts });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.steerMessage("I prefer shorter answers")).toBe(true); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("I prefer shorter answers", "", undefined);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "I prefer shorter answers", []);
    expect(onAuthoredPromptAccepted).toHaveBeenCalledWith(CURSOR_THREAD.id, "I prefer shorter answers", expect.any(String), expect.any(Number));
  });

  it("does not record a failed provider send as accepted learning evidence", async () => {
    const onAuthoredPromptAccepted = vi.fn();
    cursor.startCursorTurn.mockRejectedValueOnce(new Error("Provider rejected send"));
    const { result } = renderHook(() => useTurnRunner(context({ onAuthoredPromptAccepted })));
    await act(async () => { expect(await result.current.sendMessage("I prefer short answers")).toBe(false); });
    expect(onAuthoredPromptAccepted).not.toHaveBeenCalled();
  });

  it("keeps a provider-accepted send accepted when optional learning capture fails", async () => {
    const deps = context({ onAuthoredPromptAccepted: () => { throw new Error("Learning capture unavailable"); } });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Keep this accepted message")).toBe(true); });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].messages.at(-1)?.text).toBe("Keep this accepted message");
    expect(deps.setError).not.toHaveBeenCalledWith("Learning capture unavailable");
  });

  it("keeps an asynchronous steer's authored receipt on its original thread after navigation", async () => {
    let accept!: () => void;
    cursor.steerCursorTurn.mockImplementationOnce(() => new Promise<void>((resolve) => { accept = resolve; }));
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "current-turn");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const originalAccepted = vi.fn();
    const unrelatedAccepted = vi.fn();
    const deps = context({ running: true, onAuthoredPromptAccepted: originalAccepted });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    let delivery!: Promise<boolean>;
    await act(async () => {
      delivery = result.current.steerMessage("Generated wrapper", { resolveSkillMentions: false, skillInvocationText: "Keep my answers concise" });
      await Promise.resolve();
    });
    store.setActiveThread("other-thread");
    rerender({ value: context({ activeThread: { ...CURSOR_THREAD, id: "other-thread", cwd: "/tmp/other" },
      activeWorkspace: { id: "other", name: "Other", path: "/tmp/other" },
      activeProject: { id: "other", name: "Other", path: "/tmp/other" }, onAuthoredPromptAccepted: unrelatedAccepted }) });
    expect(originalAccepted).not.toHaveBeenCalled();
    await act(async () => { accept(); expect(await delivery).toBe(true); });
    expect(originalAccepted).toHaveBeenCalledExactlyOnceWith(CURSOR_THREAD.id, "Keep my answers concise", expect.any(String), expect.any(Number));
    expect(unrelatedAccepted).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
  });

  it("captures a rejected steer only once when its preserved follow-up is accepted", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("No active turn to steer"));
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "current-turn");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const onAuthoredPromptAccepted = vi.fn();
    const deps = context({ running: true, onAuthoredPromptAccepted });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.steerMessage("Use concise replies")).toBe(true); });
    expect(onAuthoredPromptAccepted).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toHaveLength(1);
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "current-turn", "completed"); });
    expect(onAuthoredPromptAccepted).toHaveBeenCalledExactlyOnceWith(CURSOR_THREAD.id, "Use concise replies", expect.any(String), expect.any(Number));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toHaveLength(0);
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);
  });

  it("refreshes preferences and records only the accepted attempt when a queued turn is retried", async () => {
    preferences.scopes = { app: { enabled: true, markdown: "- Old preference" },
      "project:project-1": { enabled: true, markdown: "- Old project preference" } };
    cursor.startCursorTurn.mockRejectedValueOnce(new Error("Provider rejected send"));
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "current-turn");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const onAuthoredPromptAccepted = vi.fn();
    const deps = context({ running: true, onAuthoredPromptAccepted });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("Keep this authored request"); });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "current-turn", "completed"); });
    const queued = useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0];
    expect(queued.status).toBe("failed");
    expect(onAuthoredPromptAccepted).not.toHaveBeenCalled();
    preferences.scopes.app = { enabled: false, markdown: "- Old preference" };
    preferences.scopes["project:project-1"] = { enabled: true, markdown: "- Current project preference @trap" };
    await act(async () => { result.current.retryQueuedMessage(queued.id); });
    const instructions = cursor.startCursorTurn.mock.calls.at(-1)![0].systemPrompt;
    expect(instructions).toContain("Current project preference ＠trap");
    expect(instructions).not.toContain("Old preference");
    expect(instructions).not.toContain("Old project preference");
    expect(onAuthoredPromptAccepted).toHaveBeenCalledExactlyOnceWith(CURSOR_THREAD.id, "Keep this authored request", expect.any(String), expect.any(Number));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toHaveLength(0);
  });

  it("reads cleared and disabled scopes after async skill preparation while preserving authored policy", async () => {
    preferences.scopes = { app: { enabled: true, markdown: "- App preference to clear" },
      "project:project-1": { enabled: true, markdown: "- Project preference to disable" } };
    let resolve!: (value: { prompt: string; systemPrompt: string }) => void;
    const resolveSkillPrompts = vi.fn(() => new Promise<{ prompt: string; systemPrompt: string }>((done) => { resolve = done; }));
    const deps = context({ resolveSkillPrompts, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", systemPrompt: "Authored policy" } });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => {
      const delivered = result.current.sendMessage("Use the existing policy");
      await Promise.resolve();
      preferences.scopes.app = { enabled: true, markdown: "" };
      preferences.scopes["project:project-1"] = { enabled: false, markdown: "- Project preference to disable" };
      resolve({ prompt: "Use the existing policy", systemPrompt: "Resolved authored policy" });
      expect(await delivered).toBe(true);
    });
    const instructions = cursor.startCursorTurn.mock.calls[0][0].systemPrompt;
    expect(instructions).toContain("Resolved authored policy");
    expect(instructions).not.toContain("preference to");
    expect(instructions).not.toContain("<learned-preferences>");
    expect(deps.effectiveSettings.systemPrompt).toBe("Authored policy");
  });

  it("resolves actual system skills for generated feedback while user mentions stay literal", async () => {
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved system policy", skillReferences: [{ start: 16, end: 23, name: "policy", path: "/skills/policy/SKILL.md" }], skillsFolder: "/skills" }));
    const deps = context({ resolveSkillPrompts, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", systemPrompt: "Use @policy" } });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("Reviewer quoted @policy", { resolveSkillMentions: false }); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Reviewer quoted @policy", "Use @policy", "");
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Reviewer quoted @policy", systemPrompt: expect.stringContaining("resolved system policy") }));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)?.skillReferences).toEqual([]);
  });

  it.each(["running", "idle"] as const)("keeps question-answer user mentions literal while respecting the %s system-policy boundary", async (status) => {
    const resolveSkillPrompts = vi.fn(async (prompt: string, systemPrompt: string) => ({ prompt, systemPrompt: systemPrompt ? "resolved actual policy" : "", skillReferences: [], skillsFolder: "/skills" }));
    const deps = context({ resolveSkillPrompts, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", systemPrompt: "Use @policy" } });
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    if (status === "running") { store.setActiveTurn(CURSOR_THREAD.id, "turn-live"); store.setTaskStatus(CURSOR_THREAD.id, "running"); }
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.answerQuestions(CURSOR_THREAD.id, "Use @review literally")).toBe(true); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use @review literally", status === "running" ? "" : "Use @policy", "");
    if (status === "running") expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "Use @review literally", []);
    else expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Use @review literally", systemPrompt: expect.stringContaining("resolved actual policy") }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)).toMatchObject({ text: "Use @review literally", skillReferences: [], skillsFolder: "/skills" });
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("keeps a running turn's system frozen when steering with paired resolution available", async () => {
    const skillDependencies = dependencyGraph("user");
    const skillReferences = [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }];
    const resolveSkillPrompts = vi.fn(async () => ({ prompt: "resolved steering user", systemPrompt: "must not resend the frozen policy", skillReferences, skillsFolder: "/skills", skillDependencies }));
    const resolveSkillPrompt = vi.fn(async () => "unexpected legacy expansion");
    const getSkillReferences = vi.fn(() => ({ skillReferences, skillsFolder: "/skills" }));
    const deps = context({ running: true, resolveSkillPrompts, resolveSkillPrompt, getSkillReferences });
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.steerMessage("Use @review"); });
    expect(resolveSkillPrompt).not.toHaveBeenCalled();
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use @review", "", undefined);
    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "resolved steering user", []);
    expect(getSkillReferences).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)).toMatchObject({ skillReferences, skillsFolder: "/skills", skillDependencies });
  });

  it("rejects a steering dependency issue while leaving the active turn and system policy intact", async () => {
    const resolveSkillPrompts = vi.fn(async () => { throw new SkillDependencyError(dependencyGraph("user", true)); });
    const deps = context({ running: true, resolveSkillPrompts, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", systemPrompt: "Frozen @policy" } });
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.steerMessage("Use @policy")).toBe(false); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use @policy", "", undefined);
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(deps.effectiveSettings.systemPrompt).toBe("Frozen @policy");
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]).toMatchObject({ activeTurnId: "turn-live", status: "running", messages: [] });
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("policy → guide.md: Missing guide"));
  });

  it.each(["Folder permission denied", "The skill dependency report was invalid"])("keeps a steering resolver error visible without queuing: %s", async (message) => {
    const deps = context({ running: true, resolveSkillPrompts: async () => { throw new Error(message); } });
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.steerMessage("Use @policy")).toBe(false); });
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toHaveLength(0);
    expect(deps.setError).toHaveBeenLastCalledWith(friendlyError(new Error(message)));
  });

  it("keeps a queued steering source failed with its dependency error and preserves the active turn", async () => {
    const deps = context({ running: true, resolveSkillPrompts: async () => { throw new SkillDependencyError(dependencyGraph("user", true)); } });
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Use @policy")).toBe(true); });
    const queuedId = useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0].id;
    await act(async () => { await result.current.steerQueuedMessage(queuedId); });
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]).toMatchObject({ activeTurnId: "turn-live", status: "running", queuedTurns: [expect.objectContaining({ status: "failed", error: expect.stringContaining("policy → guide.md: Missing guide") })] });
    expect(deps.setError).toHaveBeenLastCalledWith(expect.stringContaining("policy → guide.md: Missing guide"));
  });

  it.each([true, false])("honors Stop while paired system skill resolution is pending (existing thread: %s)", async (existing) => {
    let release!: (value: { prompt: string; systemPrompt: string }) => void;
    const resolveSkillPrompts = vi.fn(() => new Promise<{ prompt: string; systemPrompt: string }>((resolve) => { release = resolve; }));
    const deps = context({ activeThread: existing ? CURSOR_THREAD : null, resolveSkillPrompts });
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered: boolean | undefined;
    await act(async () => {
      const sent = result.current.sendMessage("Use @review").then((value) => { delivered = value; });
      await Promise.resolve();
      deps.running = true;
      await result.current.stopTurn();
      release({ prompt: "resolved user", systemPrompt: "resolved policy" });
      await sent;
    });
    expect(delivered).toBe(false);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(childSessions.ensureChildAgentBridge).not.toHaveBeenCalled();
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("resolves queued feedback's system policy without expanding quoted user skills", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved queued policy", skillReferences: [], skillsFolder: "/skills" }));
    const deps = context({ running: true, resolveSkillPrompts, effectiveSettings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto", systemPrompt: "Use @policy" } });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { await result.current.sendMessage("Feedback quotes @review", { resolveSkillMentions: false }); });
    expect(resolveSkillPrompts).not.toHaveBeenCalled();
    rerender({ value: { ...deps, running: false } });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Feedback quotes @review", "Use @policy", "");
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Feedback quotes @review", systemPrompt: expect.stringContaining("resolved queued policy") }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages.at(-1)).toMatchObject({ text: "Feedback quotes @review", skillReferences: [], skillsFolder: "/skills" });
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it.each(["cursor", "openai"] as const)("does not reactivate an existing %s thread after the user selects another thread", async (provider) => {
    let releaseSkill!: (message: string) => void;
    const resolveSkillPrompt = vi.fn(() => new Promise<string>((resolve) => { releaseSkill = resolve; }));
    const thread = provider === "cursor" ? CURSOR_THREAD : OPENAI_THREAD;
    const deps = provider === "cursor"
      ? context({ resolveSkillPrompt })
      : context({
          activeThread: OPENAI_THREAD,
          resolveSkillPrompt,
          effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-sol" },
          runtimeStatus: { available: true, source: "Codex CLI", path: "codex", version: "test", compatible: true, warning: null },
          account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
          threadProjectBindingsRef: { current: { [OPENAI_THREAD.id]: "/tmp/project" } },
        });
    codex.rpc.mockResolvedValue({ turn: { id: "turn-new" } });
    useTaskStore.getState().setActiveThread(thread.id);
    const { result } = renderHook(() => useTurnRunner(deps));

    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("keep working"); });
    expect(resolveSkillPrompt).toHaveBeenCalled();
    act(() => { useTaskStore.getState().setActiveThread("thread-selected-later"); });
    await act(async () => {
      releaseSkill("keep working");
      expect(await sending).toBe(true);
    });

    expect(useTaskStore.getState().activeThreadId).toBe("thread-selected-later");
    expect(deps.setActiveThread).not.toHaveBeenCalled();
    expect(deps.setThreads).toHaveBeenCalled();
    if (provider === "cursor") {
      expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: CURSOR_THREAD.id }));
    } else {
      expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
    }
  });

  it("still activates a newly created local thread", async () => {
    const deps = context({ activeThread: null });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { expect(await result.current.sendMessage("start something new")).toBe(true); });

    const createdThreadId = vi.mocked(deps.onThreadCreated).mock.calls[0]?.[0];
    expect(createdThreadId).toEqual(expect.any(String));
    expect(deps.setActiveThread).toHaveBeenCalledWith(expect.objectContaining({ id: createdThreadId }));
    expect(useTaskStore.getState().activeThreadId).toBe(createdThreadId);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: createdThreadId }));
  });

  it("does not activate a new local thread after the user navigates away during preparation", async () => {
    let releaseSkill!: (message: string) => void;
    const resolveSkillPrompt = vi.fn(() => new Promise<string>((resolve) => { releaseSkill = resolve; }));
    const deps = context({ activeThread: null, resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("start in the background"); });
    expect(resolveSkillPrompt).toHaveBeenCalled();
    act(() => { useTaskStore.getState().setActiveThread("thread-selected-later"); });
    await act(async () => {
      releaseSkill("start in the background");
      expect(await sending).toBe(true);
    });

    const createdThreadId = vi.mocked(deps.onThreadCreated).mock.calls[0]?.[0];
    expect(useTaskStore.getState().activeThreadId).toBe("thread-selected-later");
    expect(deps.setActiveThread).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: createdThreadId }));
  });

  it("does not activate a new Codex thread whose thread/start returns after navigation", async () => {
    const startedThread: Thread = {
      id: "thread-created-late",
      name: null,
      preview: "",
      cwd: "/tmp/project",
      updatedAt: 2,
      modelProvider: "openai",
    };
    let threadStartReached!: () => void;
    const reachedThreadStart = new Promise<void>((resolve) => { threadStartReached = resolve; });
    let releaseThreadStart!: (value: { thread: Thread }) => void;
    codex.rpc.mockImplementation((method) => {
      if (method === "thread/start") {
        threadStartReached();
        return new Promise((resolve) => { releaseThreadStart = resolve; });
      }
      return Promise.resolve({ turn: { id: "turn-new" } });
    });
    const deps = context({
      activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-sol" },
      runtimeStatus: { available: true, source: "Codex CLI", path: "codex", version: "test", compatible: true, warning: null },
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    let sending!: Promise<boolean>;
    act(() => { sending = result.current.sendMessage("start in the background"); });
    await act(async () => { await reachedThreadStart; });
    act(() => { useTaskStore.getState().setActiveThread("thread-selected-later"); });
    await act(async () => {
      releaseThreadStart({ thread: startedThread });
      expect(await sending).toBe(true);
    });

    expect(useTaskStore.getState().activeThreadId).toBe("thread-selected-later");
    expect(deps.setActiveThread).not.toHaveBeenCalled();
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: startedThread.id }));
  });

  it("uses resolved skill instructions for an active Claude steer", async () => {
    const resolveSkillPrompt = vi.fn(async () => "resolved skill context\n\n@review this");
    const store = useTaskStore.getState();
    store.ensureTask(CLAUDE_THREAD.id, CLAUDE_THREAD.cwd);
    store.setActiveTurn(CLAUDE_THREAD.id, "turn-live");
    store.setTaskStatus(CLAUDE_THREAD.id, "running");
    const deps = claudeContext({ resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.steerMessage("@review this"); });

    expect(claude.steerClaudeTurn).toHaveBeenCalledWith(
      CLAUDE_THREAD.id,
      "resolved skill context\n\n@review this",
      [],
    );
    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.messages.at(-1)?.text).toBe("@review this");
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

  it("keeps sent image metadata on the user message for the timeline preview", async () => {
    const deps = context({
      attachments: [
        { path: "/tmp/pasted-reference.png", name: "pasted-reference.png", kind: "image" },
        { path: "/tmp/notes.md", name: "notes.md", kind: "file" },
      ],
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("Match this reference"); });

    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages[0]).toMatchObject({
      role: "user",
      text: "Match this reference",
      attachments: [{ path: "/tmp/pasted-reference.png", name: "pasted-reference.png", kind: "image" }],
    });
  });

  it.each(["cursor", "openai"] as const)("rejects a stale unsupported image before an optimistic %s send", async (provider) => {
    const attachments = [{ path: "/tmp/old-draft.HEIC", name: "old-draft.HEIC", kind: "image" as const }];
    const deps = provider === "cursor"
      ? context({ attachments })
      : context({
          activeThread: OPENAI_THREAD,
          attachments,
          effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-sol" },
          runtimeStatus: { available: true, source: "Codex CLI", path: "codex", version: "test", compatible: true, warning: null },
          account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
          threadProjectBindingsRef: { current: { [OPENAI_THREAD.id]: "/tmp/project" } },
        });
    const thread = provider === "cursor" ? CURSOR_THREAD : OPENAI_THREAD;
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { expect(await result.current.sendMessage("keep this draft")).toBe(false); });

    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("HEIC/HEIF images are not supported"));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    expect(deps.setAttachments).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[thread.id]?.messages ?? []).toEqual([]);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(codex.rpc).not.toHaveBeenCalled();
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
      await waitFor(() => expect(childSessions.ensureChildAgentBridge).toHaveBeenCalledOnce());
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

  it.each([true, false])("allows Stop during skill loading (existing thread: %s)", async (existing) => {
    let resolve!: (value: string) => void;
    const deps = context({
      activeThread: existing ? CURSOR_THREAD : null,
      running: false,
      resolveSkillPrompt: vi.fn(() => new Promise<string>((done) => { resolve = done; })),
    });
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered: boolean | undefined;
    await act(async () => {
      const sent = result.current.sendMessage("@review this").then((value) => { delivered = value; });
      await Promise.resolve();
      if (existing) expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.status).toBe("starting");
      else expect(deps.setStartingDraftTurn).toHaveBeenCalledWith(true);
      deps.running = true;
      await result.current.stopTurn();
      resolve("resolved instructions");
      await sent;
    });
    expect(delivered).toBe(false);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(childSessions.ensureChildAgentBridge).not.toHaveBeenCalled();
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Stopped");
    if (existing) expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.status).toBe("interrupted");
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

    await waitFor(() => expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "do this next" })));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
  });

  it("holds a queued follow-up across workflow step completion until the workflow releases its thread", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setWorkflowOwner(CURSOR_THREAD.id, { workflowId: "recipe", runId: "run-1" });
    store.setActiveTurn(CURSOR_THREAD.id, "workflow-step-1");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(context({ running: true })));
    await act(async () => { expect(await result.current.sendMessage("after the entire recipe")).toBe(true); });

    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "workflow-step-1", "completed"); });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({ status: "queued" });

    await act(async () => { store.setWorkflowOwner(CURSOR_THREAD.id, null); });
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "after the entire recipe" }));
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toEqual([]);
  });

  it("keeps workflow follow-ups queued after Stop and routes steering into the queue", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setWorkflowOwner(CURSOR_THREAD.id, { workflowId: "recipe", runId: "run-1" });
    store.setActiveTurn(CURSOR_THREAD.id, "workflow-step-1");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const { result } = renderHook(() => useTurnRunner(context({ running: true })));

    await act(async () => { expect(await result.current.steerMessage("later guidance")).toBe(true); });
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({ text: "later guidance", status: "queued" });

    await act(async () => {
      store.completeTurn(CURSOR_THREAD.id, "workflow-step-1", "interrupted");
      store.setWorkflowOwner(CURSOR_THREAD.id, null);
    });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({ status: "queued" });
  });

  it("keeps a queued review literal after rerender and turn completion", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async () => "unexpected skill expansion");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => {
      expect(await result.current.sendMessage("Review @example in diff", { useComposerAttachments: false, resolveSkillMentions: false })).toBe(true);
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({ resolveSkillMentions: false });
    rerender({ value: { ...deps, running: false } });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Review @example in diff", attachments: [] }));
    expect(resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("preserves authored skill source when a formatted review is queued and later delivered", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const fullText = "Review with @review. Diff quotes @example.";
    const source = "Review with @review.";
    const resolveSkillPrompt = vi.fn(async () => "resolved authored skill");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });

    await act(async () => {
      expect(await result.current.sendMessage(fullText, { skillInvocationText: source })).toBe(true);
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0].skillInvocationText).toBe(source);
    rerender({ value: { ...deps, running: false } });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(resolveSkillPrompt).toHaveBeenCalledWith(fullText, source);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "resolved authored skill" }));
  });

  it("still resolves skills in an ordinary queued prompt after rerender", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async () => "expanded skill instructions");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { expect(await result.current.sendMessage("Use @example")).toBe(true); });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).not.toHaveProperty("resolveSkillMentions");
    rerender({ value: { ...deps, running: false } });
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(resolveSkillPrompt).toHaveBeenCalledWith("Use @example", undefined);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "expanded skill instructions" }));
  });

  it("keeps a queued review literal when steered into the active turn", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async () => "unexpected skill expansion");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.sendMessage("Review @example", { resolveSkillMentions: false }); });
    const queued = useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0];
    await act(async () => { await result.current.steerQueuedMessage(queued.id); });
    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "Review @example", []);
    expect(resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("holds FIFO delivery during editing, then sends only the saved text and original attachments", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const attachment = { name: "notes.md", path: "/tmp/notes.md", kind: "file" as const };
    const deps = context({ running: true, attachments: [attachment] });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { await result.current.sendMessage("original"); await result.current.sendMessage("second"); });
    const entry = useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0];
    act(() => { expect(result.current.beginEditQueuedMessage(entry.id)).toBe(true); });
    await act(async () => { await result.current.steerQueuedMessage(entry.id); });
    expect(cursor.steerCursorTurn).not.toHaveBeenCalled();
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    await act(async () => { result.current.retryQueuedMessage(entry.id); });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns).toHaveLength(2);
    rerender({ value: { ...deps, running: false } });
    await act(async () => { await result.current.sendMessage("third, typed after completion"); });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    await act(async () => { expect(result.current.finishEditQueuedMessage(entry.id, "revised")).toBe(true); });
    expect(cursor.startCursorTurn).toHaveBeenCalledTimes(1);
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("revised") }));
    expect(cursor.startCursorTurn.mock.calls[0][0].attachments).toEqual([{ path: "/tmp/notes.md", kind: "file" }]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns.map((item) => item.text)).toEqual(["second", "third, typed after completion"]);
  });

  it("does not reuse authored skill mentions after the queued review text is edited", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setActiveTurn(CURSOR_THREAD.id, "turn-live");
    store.setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async (message: string) => message);
    const deps = context({ running: true, resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => {
      await result.current.sendMessage("Review with @review. Evidence quotes @example.", { skillInvocationText: "Use @review" });
    });
    const entry = useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0];
    act(() => { expect(result.current.beginEditQueuedMessage(entry.id)).toBe(true); });
    await act(async () => {
      expect(result.current.finishEditQueuedMessage(entry.id, "Review changed evidence that quotes @example.")).toBe(true);
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0].skillInvocationText).toBe("");
    await act(async () => { store.completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(resolveSkillPrompt).toHaveBeenCalledWith("Review changed evidence that quotes @example.", "");
  });

  it.each(["steer", "answer"] as const)("queues a late %s behind an unfinished edit after completion", async (action) => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    const entry = store.enqueueTurn(CURSOR_THREAD.id, "first", []);
    store.beginQueuedTurnEdit(CURSOR_THREAD.id, entry.id);
    store.setTaskStatus(CURSOR_THREAD.id, "completed");
    const { result } = renderHook(() => useTurnRunner(context()));
    await act(async () => {
      if (action === "steer") await result.current.steerMessage("later");
      else await result.current.answerQuestions(CURSOR_THREAD.id, "later");
    });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns.map((item) => item.text)).toEqual(["first", "later"]);
    if (action === "answer") expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[1]).toMatchObject({ resolveSkillMentions: false });
  });

  it("does not restart a failed queue when its text is edited", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.setTaskStatus(CURSOR_THREAD.id, "error");
    const entry = store.enqueueTurn(CURSOR_THREAD.id, "original", []);
    store.setQueuedTurnStatus(CURSOR_THREAD.id, entry.id, "failed", "Try again");
    const { result } = renderHook(() => useTurnRunner(context()));
    act(() => { result.current.beginEditQueuedMessage(entry.id); });
    await act(async () => { result.current.finishEditQueuedMessage(entry.id, "revised"); });
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({ text: "revised", status: "failed" });
    await act(async () => { result.current.retryQueuedMessage(entry.id); });
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "revised" }));
  });

  it("releases and retries a queued Claude turn when Windows cleanup briefly holds the old slot", async () => {
    claude.isClaudeThreadBusyError.mockImplementation((reason?: unknown) =>
      String(reason).includes("Claude is already working in this thread"),
    );
    claude.startClaudeTurn
      .mockRejectedValueOnce(new Error("Claude is already working in this thread"))
      .mockResolvedValueOnce({ turnId: "turn-retried" });
    const store = useTaskStore.getState();
    store.ensureTask(CLAUDE_THREAD.id, CLAUDE_THREAD.cwd);
    store.setActiveTurn(CLAUDE_THREAD.id, "turn-live");
    store.setTaskStatus(CLAUDE_THREAD.id, "running");
    const deps = claudeContext();
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("continue next"); });
    await act(async () => {
      store.completeTurn(CLAUDE_THREAD.id, "turn-live", "completed");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(claude.killClaudeTurn).toHaveBeenCalledWith(CLAUDE_THREAD.id);
    expect(claude.startClaudeTurn).toHaveBeenCalledTimes(2);
    expect(claude.startClaudeTurn).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "continue next" }));
    expect(useTaskStore.getState().tasks[CLAUDE_THREAD.id]?.queuedTurns).toEqual([]);
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

  it("rejects an unsupported image restored in a queued turn before provider delivery", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    store.enqueueTurn(CURSOR_THREAD.id, "keep this queued prompt", [
      { path: "/tmp/restored-image.heif", name: "restored-image.heif", kind: "image" },
    ]);
    store.setActiveThread(CURSOR_THREAD.id);
    const deps = context({ running: false });

    renderHook(() => useTurnRunner(deps));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toEqual([]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns[0]).toMatchObject({
      text: "keep this queued prompt",
      status: "failed",
    });
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("HEIC/HEIF images are not supported"));
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

  it("keeps an explicitly rejected steer as the next queued turn", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("steer failed"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({ running: true });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivered = true;
    await act(async () => { delivered = await result.current.steerMessage("change direction"); });

    expect(delivered).toBe(true);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toEqual([]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([
      expect.objectContaining({ text: "change direction", status: "queued" }),
    ]);
    expect(deps.setError).toHaveBeenLastCalledWith(null);
  });

  it("sends Cursor steering attachments instead of silently discarding them", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const deps = context({
      running: true,
      attachments: [{ path: "/tmp/reference.png", name: "reference.png", kind: "image" }],
      resolveSkillPrompt: vi.fn(async () => "resolved steer skill context"),
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.steerMessage("@review match this reference"); });

    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(
      CURSOR_THREAD.id,
      "resolved steer skill context",
      [{ path: "/tmp/reference.png", kind: "image" }],
    );
    expect(deps.setAttachments).toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages[0]?.attachments).toEqual([
      { path: "/tmp/reference.png", name: "reference.png", kind: "image" },
    ]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages[0]?.steerStatus).toBe("accepted");
  });

  it("keeps an app-generated steer literal even when it quotes a skill mention", async () => {
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async () => "unexpected skill expansion");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => {
      expect(await result.current.steerMessage("Reviewer quoted @example", { resolveSkillMentions: false })).toBe(true);
    });

    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "Reviewer quoted @example", []);
    expect(resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("keeps an app-generated steer literal if the provider rejects steering", async () => {
    cursor.steerCursorTurn.mockRejectedValueOnce(new Error("steer failed"));
    useTaskStore.getState().ensureTask(CURSOR_THREAD.id, CURSOR_THREAD.cwd);
    useTaskStore.getState().setActiveTurn(CURSOR_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(CURSOR_THREAD.id, "running");
    const resolveSkillPrompt = vi.fn(async () => "unexpected skill expansion");
    const deps = context({ running: true, resolveSkillPrompt });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });

    await act(async () => {
      expect(await result.current.steerMessage("Reviewer quoted @example", { resolveSkillMentions: false })).toBe(true);
    });
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id].queuedTurns[0]).toMatchObject({
      text: "Reviewer quoted @example",
      resolveSkillMentions: false,
    });

    rerender({ value: { ...deps, running: false } });
    await act(async () => { useTaskStore.getState().completeTurn(CURSOR_THREAD.id, "turn-live", "completed"); });
    expect(cursor.startCursorTurn).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Reviewer quoted @example" }));
    expect(resolveSkillPrompt).not.toHaveBeenCalled();
  });

  it("sends Codex the active turn identity and marks the steer accepted", async () => {
    const store = useTaskStore.getState();
    store.ensureTask(OPENAI_THREAD.id, OPENAI_THREAD.cwd);
    store.setActiveTurn(OPENAI_THREAD.id, "turn-live");
    store.setTaskStatus(OPENAI_THREAD.id, "running");
    const deps = context({
      activeThread: OPENAI_THREAD,
      running: true,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-5.6-sol" },
      runtimeStatus: { available: true, source: "Codex CLI", path: "/usr/local/bin/codex", version: "test", compatible: true, warning: null },
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
      threadProjectBindingsRef: { current: { [OPENAI_THREAD.id]: "/tmp/project" } },
      resolveSkillPrompt: vi.fn(async () => "resolved Codex steer skill context"),
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.steerMessage("@review spin up Opus now"); });

    expect(codex.rpc).toHaveBeenCalledWith("turn/steer", expect.objectContaining({
      threadId: OPENAI_THREAD.id,
      expectedTurnId: "turn-live",
      input: [expect.objectContaining({ text: "resolved Codex steer skill context" })],
    }));
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id]?.messages).toContainEqual(
      expect.objectContaining({ text: "@review spin up Opus now", turnId: "turn-live", steerStatus: "accepted" }),
    );
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Steer accepted by the active turn");
  });

  it("still attempts to steer while assistant output is arriving", async () => {
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
    expect(cursor.steerCursorTurn).toHaveBeenCalledWith(CURSOR_THREAD.id, "one more thing", [
      { path: "/tmp/reference.png", kind: "image" },
    ]);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.queuedTurns).toEqual([]);
    expect(useTaskStore.getState().tasks[CURSOR_THREAD.id]?.messages).toContainEqual(
      expect.objectContaining({ text: "one more thing", steerStatus: "accepted" }),
    );
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

  it("keeps a queued steering failure durable for the next turn", async () => {
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
      status: "queued",
      error: undefined,
    });
    expect(deps.setError).toHaveBeenLastCalledWith(null);
    expect(deps.setTransientStatus).toHaveBeenCalledWith("Steer could not be inserted; message kept for the next turn");
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

  it.each(["running", "completed"] as const)("delivers question answers when the turn is %s without consuming the draft or attachments", async (status) => {
    codex.rpc.mockResolvedValue({ turn: { id: "turn-answered" } });
    const deps = openAiContext({ attachments: [{ path: "/draft.png", name: "Draft", kind: "image" }] });
    useTaskStore.getState().setActiveTurn(OPENAI_THREAD.id, "turn-live");
    useTaskStore.getState().setTaskStatus(OPENAI_THREAD.id, status);
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.answerQuestions(OPENAI_THREAD.id, "Use @compact" )).toBe(true); });
    expect(codex.rpc).toHaveBeenCalledWith(status === "running" ? "turn/steer" : "turn/start", expect.objectContaining({
      threadId: OPENAI_THREAD.id, input: [expect.objectContaining({ type: "text", text: "Use @compact" })],
    }));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    const attachmentUpdater = (deps.setAttachments as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    if (attachmentUpdater) expect(attachmentUpdater(deps.attachments)).toEqual(deps.attachments);
  });

  it("keeps a late workflow question answer literal while queued for the recipe to finish", async () => {
    const deps = openAiContext({ attachments: [{ path: "/draft.png", name: "Draft", kind: "image" }] });
    const store = useTaskStore.getState();
    store.ensureTask(OPENAI_THREAD.id, OPENAI_THREAD.cwd);
    store.setTaskStatus(OPENAI_THREAD.id, "completed");
    store.setWorkflowOwner(OPENAI_THREAD.id, { workflowId: "recipe", runId: "run-1" });
    codex.rpc.mockResolvedValue({ turn: { id: "turn-after-recipe" } });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { expect(await result.current.answerQuestions(OPENAI_THREAD.id, "Use @compact literally")).toBe(true); });
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].queuedTurns[0]).toMatchObject({
      text: "Use @compact literally", status: "queued", resolveSkillMentions: false, attachments: [],
    });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());

    await act(async () => { store.setWorkflowOwner(OPENAI_THREAD.id, null); });
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [expect.objectContaining({ text: "Use @compact literally" })],
    }));
    expect(deps.resolveSkillPrompt).not.toHaveBeenCalled();
    const attachmentUpdater = (deps.setAttachments as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    if (attachmentUpdater) expect(attachmentUpdater(deps.attachments)).toEqual(deps.attachments);
  });

  it("continues with answers if the active turn finishes during submission", async () => {
    const deps = openAiContext();
    const store = useTaskStore.getState();
    store.setActiveTurn(OPENAI_THREAD.id, "turn-live");
    store.setTaskStatus(OPENAI_THREAD.id, "running");
    codex.rpc.mockImplementation(async (method) => {
      if (method === "turn/steer") {
        store.completeTurn(OPENAI_THREAD.id, "turn-live", "completed");
        throw new Error("No active turn to steer");
      }
      return { turn: { id: "turn-answers" } };
    });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.answerQuestions(OPENAI_THREAD.id, "Use compact")).toBe(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ input: [expect.objectContaining({ text: "Use compact" })] }));
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("answers a still-open nonblocking RPC through its native response channel", async () => {
    const deps = openAiContext();
    useTaskStore.getState().enqueueApproval({ id: 42, method: "item/tool/requestUserInput", params: { isBlocking: false, turnId: "turn", itemId: "item" }, threadId: OPENAI_THREAD.id, receivedAt: 1 });
    useTaskStore.getState().setWorkflowOwner(OPENAI_THREAD.id, { workflowId: "recipe", runId: "run-1" });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.answerQuestions(OPENAI_THREAD.id, "Compact", {
      message: { id: "questions", role: "assistant", text: "", questionRequestId: 42, turnId: "turn", questionRequestItemId: "item" }, answers: { layout: ["Compact"] },
    })).toBe(true); });
    expect(codex.respond).toHaveBeenCalledExactlyOnceWith(42, { answers: { layout: { answers: ["Compact"] } } }, { method: "item/tool/requestUserInput", threadId: OPENAI_THREAD.id, turnId: "turn", itemId: "item" });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].approvals).toEqual([]);
  });

  it("does not clear a replacement request when an earlier response finishes", async () => {
    const deps = openAiContext();
    const store = useTaskStore.getState();
    const request = { id: 42, method: "item/tool/requestUserInput", params: { isBlocking: false, turnId: "turn", itemId: "item" }, threadId: OPENAI_THREAD.id, receivedAt: 1 };
    store.enqueueApproval(request);
    let finish!: () => void;
    codex.respond.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useTurnRunner(deps));
    let sending!: Promise<boolean>;
    act(() => { sending = result.current.answerQuestions(OPENAI_THREAD.id, "Compact", {
      message: { id: "questions", role: "assistant", text: "", questionRequestId: 42, turnId: "turn", questionRequestItemId: "item" }, answers: { layout: ["Compact"] },
    }); });
    act(() => { store.resolveApproval(OPENAI_THREAD.id, 42); store.enqueueApproval({ ...request, receivedAt: 2, params: { ...request.params, turnId: "new-turn", itemId: "new-item" } }); });
    await act(async () => { finish(); expect(await sending).toBe(true); });
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].approvals).toEqual([expect.objectContaining({ receivedAt: 2 })]);
  });

  it("does not send an old answer to a reused runtime request ID", async () => {
    const deps = openAiContext();
    const store = useTaskStore.getState();
    store.setActiveTurn(OPENAI_THREAD.id, "new-turn");
    store.setTaskStatus(OPENAI_THREAD.id, "running");
    store.enqueueApproval({ id: 42, method: "item/tool/requestUserInput", params: { isBlocking: false, turnId: "new-turn", itemId: "new-item" }, threadId: OPENAI_THREAD.id, receivedAt: 1 });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { await result.current.answerQuestions(OPENAI_THREAD.id, "An answer to the old question", {
      message: { id: "old-question", role: "assistant", text: "", turnId: "old-turn", questionRequestId: 42 }, answers: { old: ["Answer"] },
    }); });
    expect(codex.respond).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].approvals).toHaveLength(1);
    expect(codex.rpc).toHaveBeenCalledWith("turn/steer", expect.objectContaining({ expectedTurnId: "new-turn" }));
  });

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
    codex.runtimeThreadState.mockResolvedValue({ instance: "runtime-1", loaded: true });
    claude.saveClaudeTranscript.mockResolvedValue(undefined);
    claude.startClaudeTurn.mockResolvedValue({ turnId: "turn-claude" });
    cursor.saveCursorTranscript.mockResolvedValue(undefined);
    cursor.startCursorTurn.mockResolvedValue({ turnId: "turn-new", cursorSessionId: "session-new" });
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
  });

  it("passes resolved skill instructions through the Codex-family turn input", async () => {
    const resolveSkillPrompt = vi.fn(async () => "resolved skill context\n\n@review this");
    const deps = openAiContext({ resolveSkillPrompt });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("@review this"); });

    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [expect.objectContaining({ text: "resolved skill context\n\n@review this" })],
    }));
  });

  it.each(["openai", "openrouter", "lmstudio"] as const)("sends current learned preferences through the %s per-turn instruction snapshot", async (provider) => {
    preferences.scopes = {
      app: { enabled: true, markdown: "- Application preference @trap" },
      "project:project-1": { enabled: true, markdown: "- Project preference" },
    };
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "Resolved authored instructions" }));
    const onAuthoredPromptAccepted = vi.fn();
    const deps = openAiContext({ resolveSkillPrompts, onAuthoredPromptAccepted, openRouterReady: true, lmStudioReady: true,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "selected/model", systemPrompt: "Authored @policy" } });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Use my usual style")).toBe(true); });
    const instructions = codex.rpc.mock.calls.find(([method]) => method === "turn/start")![1].collaborationMode.settings.developer_instructions;
    expect(instructions).toContain("Resolved authored instructions");
    expect(instructions).toContain("Application preference ＠trap");
    expect(instructions).toContain("Project preference");
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Use my usual style", "Authored @policy", undefined);
    expect(onAuthoredPromptAccepted).toHaveBeenCalledWith(OPENAI_THREAD.id, "Use my usual style", expect.any(String), expect.any(Number));
  });

  it.each(["openai", "openrouter", "lmstudio"] as const)("clears learned preferences from the next %s turn while keeping authored instructions", async (provider) => {
    preferences.scopes = { app: { enabled: true, markdown: "- Old app preference" },
      "project:project-1": { enabled: true, markdown: "- Old project preference" } };
    const deps = openAiContext({ openRouterReady: true, lmStudioReady: true,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "selected/model", systemPrompt: "Keep authored instructions" } });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("First request")).toBe(true); });
    const firstTurn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")![1];
    expect(firstTurn.collaborationMode.settings.developer_instructions).toContain("Old app preference");
    preferences.scopes.app = { enabled: true, markdown: "" };
    preferences.scopes["project:project-1"] = { enabled: false, markdown: "- Old project preference" };
    await act(async () => { useTaskStore.getState().completeTurn(OPENAI_THREAD.id, "turn-new", "completed"); });
    await act(async () => { expect(await result.current.sendMessage("Second request")).toBe(true); });
    const turns = codex.rpc.mock.calls.filter(([method]) => method === "turn/start");
    expect(turns).toHaveLength(2);
    const instructions = turns[1][1].collaborationMode.settings.developer_instructions;
    expect(instructions).toContain("Keep authored instructions");
    expect(instructions).not.toContain("Old app preference");
    expect(instructions).not.toContain("Old project preference");
    expect(instructions).not.toContain("<learned-preferences>");
    expect(deps.effectiveSettings.systemPrompt).toBe("Keep authored instructions");
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("persists the complete system-only dependency graph for %s turns", async (provider) => {
    const skillDependencies = dependencyGraph();
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved system dependency", skillDependencies }));
    const deps = provider === "claude" ? claudeContext({ resolveSkillPrompts }) : provider === "cursor" ? context({ resolveSkillPrompts }) : openAiContext({
      resolveSkillPrompts, openRouterReady: true, lmStudioReady: true,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "selected/model" },
    });
    deps.effectiveSettings = { ...deps.effectiveSettings, systemPrompt: "Use @policy" };
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Continue")).toBe(true); });
    expect(resolveSkillPrompts).toHaveBeenCalledExactlyOnceWith("Continue", "Use @policy", undefined);
    expect(useTaskStore.getState().tasks[deps.activeThread!.id].messages.at(-1)).toMatchObject({ text: "Continue", skillDependencies });
    expect(deps.effectiveSettings.systemPrompt).toBe("Use @policy");
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("blocks %s dependency failures before bridges, provider calls, or checkpoints", async (provider) => {
    const resolveSkillPrompts = vi.fn(async () => { throw new SkillDependencyError(dependencyGraph("system", true)); });
    const deps = provider === "claude" ? claudeContext({ activeThread: null, running: false, resolveSkillPrompts }) : provider === "cursor" ? context({ activeThread: null, resolveSkillPrompts }) : openAiContext({
      activeThread: null, resolveSkillPrompts, openRouterReady: true, lmStudioReady: true,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "selected/model" },
    });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Continue")).toBe(false); });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(childSessions.ensureChildAgentBridge).not.toHaveBeenCalled();
    expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("policy → guide.md: Missing guide"));
  });

  it("sends current resolved system instructions and an explicit clear on every loaded Codex turn", async () => {
    const skillReferences = [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }];
    const resolveSkillPrompts = vi.fn(async (prompt: string, systemPrompt: string) => ({ prompt: `resolved ${prompt}`, systemPrompt: systemPrompt ? `resolved ${systemPrompt}` : "", skillReferences, skillsFolder: "/skills" }));
    const deps = openAiContext({ resolveSkillPrompts, effectiveSettings: { ...ENABLED, systemPrompt: "Use @policy" } });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { await result.current.sendMessage("Use @review"); });
    const first = codex.rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)!;
    expect(first[1].collaborationMode.settings.developer_instructions).toContain("resolved Use @policy");
    expect(first[1].input[0].text).toBe("resolved Use @review");
    expect(useTaskStore.getState().tasks[OPENAI_THREAD.id].messages.at(-1)).toMatchObject({ text: "Use @review", skillReferences, skillsFolder: "/skills" });
    rerender({ value: { ...deps, effectiveSettings: { ...deps.effectiveSettings, systemPrompt: "" } } });
    await act(async () => { await result.current.sendMessage("Continue"); });
    const last = codex.rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)!;
    expect(last[1].collaborationMode.settings.developer_instructions).toContain("Current effective app system prompt: none");
    expect(last[1].collaborationMode.settings.developer_instructions).not.toContain("resolved Use @policy");
    expect(resolveSkillPrompts).toHaveBeenLastCalledWith("Continue", "", undefined);
    expect(deps.restartRuntimeForCapabilities).not.toHaveBeenCalled();
  });

  it("uses the actual top-level model for a newly started default-model Codex thread", async () => {
    codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
      ? { thread: { ...OPENAI_THREAD, id: "fresh-default" }, model: "actual-runtime-default" }
      : { turn: { id: "turn-1" } });
    const deps = openAiContext({ activeThread: null, effectiveSettings: { ...ENABLED, model: "", systemPrompt: "Use @policy" }, resolveSkillPrompts: vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved policy" })) });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Build it")).toBe(true); });
    const turn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")!;
    expect(turn[1].collaborationMode.settings.model).toBe("actual-runtime-default");
    expect(deps.persistThreadModel).toHaveBeenCalledWith("fresh-default", "actual-runtime-default");
    const start = codex.rpc.mock.calls.find(([method]) => method === "thread/start")!;
    expect(start[1].baseInstructions).toBe("");
    expect(turn[1].collaborationMode.settings.developer_instructions).toContain("resolved policy");
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
        mcp_servers: { mythra_agents: { command: BRIDGE_LAUNCH.command, args: BRIDGE_LAUNCH.args } },
        features: { multi_agent: false },
      },
    });
  });

  it.each(["openrouter", "lmstudio"] as const)("passes the saved Checks command and bridge into a %s turn", async (provider) => {
    const launch = { ...BRIDGE_LAUNCH, toolNames: ["propose_agent_settings", "set_project_run_command", "set_project_check_command"] };
    childSessions.ensureChildAgentBridge.mockResolvedValue({ ...bridgeResult(), launch });
    const deps = openAiContext({
      activeProject: { id: "project-1", name: "Project", path: "/tmp/project", overrides: { check: { command: "npm run verify", updatedAt: 1 } } },
      effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: provider === "openrouter" ? "x-ai/grok-4.5" : "local-model" },
      openRouterReady: true,
      lmStudioReady: true,
    });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("check this project"); });

    const [, params] = resumeCall() ?? [];
    expect(params).toMatchObject({
      developerInstructions: expect.stringContaining("set_project_check_command"),
      config: {
        developer_instructions: expect.stringContaining("`npm run verify`"),
        mcp_servers: { mythra_agents: { command: launch.command, args: launch.args } },
      },
    });
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
    const turn = codex.rpc.mock.calls.find(([method]) => method === "turn/start")!;
    const guide = turn[1].collaborationMode.settings.developer_instructions;
    expect(guide).toContain("set_project_run_command");
    expect(guide).toContain("set_project_check_command");
    expect(guide).toContain("`npm run verify`");
    expect(guide).toContain(MYTHRA_CODE_SUBAGENT_SETTINGS_INSTRUCTIONS);
    expect(guide).not.toContain(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
  });

  it("replaces the per-turn delegation guide when the managed bridge is removed", async () => {
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const deps = openAiContext({ effectiveSettings: ENABLED });
    const { result, rerender } = renderHook(({ value }) => useTurnRunner(value), { initialProps: { value: deps } });
    await act(async () => { await result.current.sendMessage("split this up"); });
    let turn = codex.rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)!;
    expect(turn[1].collaborationMode.settings.developer_instructions).toContain(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
    childSessions.ensureChildAgentBridge.mockResolvedValue(null);
    rerender({ value: openAiContext() });
    await act(async () => { await result.current.sendMessage("work alone"); });
    turn = codex.rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)!;
    expect(turn[1].collaborationMode.settings.developer_instructions).not.toContain(MYTHRA_CODE_DELEGATION_INSTRUCTIONS);
  });

  it("never exposes native Codex sub-agents when no managed destination is available", async () => {
    const deps = openAiContext({ effectiveSettings: ENABLED });
    const { result } = renderHook(() => useTurnRunner(deps));

    await act(async () => { await result.current.sendMessage("split this up"); });

    expect(resumeCall()).toBeUndefined();
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
  });

  it("waits for view-first runtime preparation before sending", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const waitForThreadPreparation = vi.fn(() => preparation);
    const deps = openAiContext({ waitForThreadPreparation });
    const { result } = renderHook(() => useTurnRunner(deps));

    let delivery!: Promise<boolean>;
    await act(async () => {
      delivery = result.current.sendMessage("wait for preparation");
      await Promise.resolve();
    });

    expect(waitForThreadPreparation).toHaveBeenCalledExactlyOnceWith(OPENAI_THREAD.id);
    expect(childSessions.ensureChildAgentBridge).not.toHaveBeenCalled();
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());

    releasePreparation();
    await act(async () => { await delivery; });
    expect(codex.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: OPENAI_THREAD.id }));
  });

  it.each([true, false])("honors Stop during skill-root preparation without starting a provider (existing thread: %s)", async (existing) => {
    let releaseRoots!: () => void;
    const roots = new Promise<void>((resolve) => { releaseRoots = resolve; });
    const ensureSkillRoots = vi.fn(() => roots);
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult());
    const deps = openAiContext({ activeThread: existing ? OPENAI_THREAD : null, ensureSkillRoots });
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered!: Promise<boolean>;
    await act(async () => {
      delivered = result.current.sendMessage("use prepared skills");
      for (let step = 0; step < 8; step++) await Promise.resolve();
    });
    expect(ensureSkillRoots).toHaveBeenCalledOnce();
    deps.running = true;
    await act(async () => { await result.current.stopTurn(); });
    await act(async () => {
      releaseRoots();
      expect(await delivered).toBe(false);
    });
    expect(codex.rpc).not.toHaveBeenCalled();
    expect(deps.beginRunCheckpoint).not.toHaveBeenCalled();
    expect(childSessions.releaseChildAgentSession).toHaveBeenCalledExactlyOnceWith("session-1");
    expect(deps.setError).not.toHaveBeenCalledWith(expect.any(String));
    if (existing) expect(useTaskStore.getState().statuses[OPENAI_THREAD.id]).toBe("interrupted");
  });

  it.each(["openai", "openrouter", "lmstudio", "claude", "cursor"] as const)("does not start a %s model turn stopped during its checkpoint", async (provider) => {
    let releaseCheckpoint!: (checkpointId?: string) => void;
    const checkpoint = new Promise<string | undefined>((resolve) => { releaseCheckpoint = resolve; });
    const beginRunCheckpoint = vi.fn(() => checkpoint);
    const deps = provider === "claude" ? claudeContext({ running: false, beginRunCheckpoint })
      : provider === "cursor" ? context({ beginRunCheckpoint })
        : openAiContext({ beginRunCheckpoint, openRouterReady: true, lmStudioReady: true, effectiveSettings: { ...DEFAULT_SETTINGS, provider, model: "selected/model" } });
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered!: Promise<boolean>;
    await act(async () => {
      delivered = result.current.sendMessage("Stop this pending checkpoint");
      for (let step = 0; step < 12; step++) await Promise.resolve();
    });
    expect(beginRunCheckpoint).toHaveBeenCalledOnce();
    deps.running = true;
    await act(async () => { await result.current.stopTurn(); });
    await act(async () => {
      releaseCheckpoint();
      expect(await delivered).toBe(false);
    });
    expect(codex.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(deps.discardRunCheckpoint).toHaveBeenCalledExactlyOnceWith(deps.activeThread!.id);
    expect(useTaskStore.getState().tasks[deps.activeThread!.id]).toMatchObject({ status: "interrupted", messages: [] });
    expect(deps.setError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it.each(["claude", "cursor"] as const)("does not persist an undelivered skill graph in %s while Stop lands during saving", async (provider) => {
    let releaseSave!: () => void;
    const saved = new Promise<void>((resolve) => { releaseSave = resolve; });
    const saveTranscript = provider === "claude" ? claude.saveClaudeTranscript : cursor.saveCursorTranscript;
    saveTranscript.mockImplementationOnce(() => saved);
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved policy", skillDependencies: dependencyGraph() }));
    const deps = provider === "claude" ? claudeContext({ running: false, resolveSkillPrompts }) : context({ resolveSkillPrompts });
    const prior = { id: "prior-user", role: "user" as const, text: "Prior instructions", turnId: "prior-turn", turnStatus: "completed" as const };
    useTaskStore.getState().appendUserMessage(deps.activeThread!.id, prior);
    const { result } = renderHook(() => useTurnRunner(deps));
    let delivered!: Promise<boolean>;
    await act(async () => {
      delivered = result.current.sendMessage("Use @policy");
      for (let step = 0; step < 12; step++) await Promise.resolve();
    });
    expect(saveTranscript).toHaveBeenCalledOnce();
    expect(saveTranscript.mock.calls[0][0].messages).toEqual([expect.objectContaining(prior)]);
    expect(useTaskStore.getState().tasks[deps.activeThread!.id].messages).toEqual([expect.objectContaining(prior)]);
    deps.running = true;
    await act(async () => { await result.current.stopTurn(); });
    await act(async () => {
      releaseSave();
      expect(await delivered).toBe(false);
    });
    expect(saveTranscript).toHaveBeenCalledOnce();
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks[deps.activeThread!.id].messages).toEqual([expect.objectContaining(prior)]);
  });

  it.each(["claude", "cursor"] as const)("does not append a new skill graph if prior %s transcript preparation rejects", async (provider) => {
    const saveTranscript = provider === "claude" ? claude.saveClaudeTranscript : cursor.saveCursorTranscript;
    saveTranscript.mockRejectedValueOnce(new Error("Transcript save failed"));
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved policy", skillDependencies: dependencyGraph() }));
    const deps = provider === "claude" ? claudeContext({ running: false, resolveSkillPrompts }) : context({ resolveSkillPrompts });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Use @policy")).toBe(false); });
    expect(saveTranscript.mock.calls[0][0].messages).toEqual([]);
    expect(useTaskStore.getState().tasks[deps.activeThread!.id].messages).toEqual([]);
    expect(cursor.startCursorTurn).not.toHaveBeenCalled();
    expect(claude.startClaudeTurn).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(expect.stringContaining("Transcript save failed"));
  });

  it.each(["claude", "cursor"] as const)("adds current skill provenance immediately before %s dispatch and schedules durable on-start saving", async (provider) => {
    const resolveSkillPrompts = vi.fn(async (prompt: string) => ({ prompt, systemPrompt: "resolved policy", skillDependencies: dependencyGraph() }));
    const deps = provider === "claude" ? claudeContext({ running: false, resolveSkillPrompts }) : context({ resolveSkillPrompts });
    const start = provider === "claude" ? claude.startClaudeTurn : cursor.startCursorTurn;
    start.mockImplementation(async () => {
      expect(useTaskStore.getState().tasks[deps.activeThread!.id].messages).toEqual([expect.objectContaining({ text: "Use @policy", skillDependencies: dependencyGraph() })]);
      return { turnId: "new-turn", cursorSessionId: "cursor-new" };
    });
    const { result } = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await result.current.sendMessage("Use @policy")).toBe(true); });
    const saveTranscript = provider === "claude" ? claude.saveClaudeTranscript : cursor.saveCursorTranscript;
    expect(saveTranscript.mock.calls[0][0].messages).toEqual([]);
    const scheduleSave = provider === "claude" ? deps.scheduleClaudeThreadSave : deps.scheduleCursorThreadSave;
    expect(scheduleSave).toHaveBeenCalledExactlyOnceWith(deps.activeThread!.id);
    expect(useTaskStore.getState().tasks[deps.activeThread!.id]).toMatchObject({ activeTurnId: "new-turn", status: "running" });
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
    codex.runtimeThreadState.mockResolvedValue({ instance: "runtime-2", loaded: true });
    childSessions.ensureChildAgentBridge.mockResolvedValue(bridgeResult({ maxConcurrent: 6 }));
    rerender({ deps: openAiContext({ restartRuntimeForCapabilities, effectiveSettings: { ...ENABLED, subagentMax: 6 } }) });
    await act(async () => { await result.current.sendMessage("more of them"); });

    expect(restartRuntimeForCapabilities).toHaveBeenCalledExactlyOnceWith(OPENAI_THREAD.id);
    // The raised limit belongs to the Mythra Code bridge, which enforces it per
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
    codex.runtimeThreadState.mockResolvedValue({ instance: "runtime-4", loaded: false });
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
    codex.runtimeThreadState.mockResolvedValue({ instance: "runtime-3", loaded: false });
    rerender({ deps: openAiContext({ effectiveSettings: ENABLED }) });
    await act(async () => { await result.current.sendMessage("keep going"); });

    // The bridge this thread believes it has is not registered anywhere in the
    // new runtime until it is resumed into it.
    expect(resumeCall()?.[1]).toMatchObject({
      config: { mcp_servers: { mythra_agents: { args: BRIDGE_LAUNCH.args } } },
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
    codex.runtimeThreadState.mockResolvedValue({ instance: "runtime-2", loaded: false });
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
      systemPrompt: expect.stringContaining("Mythra Code-managed sub-agent delegation is active"),
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
      systemPrompt: expect.stringContaining("Mythra Code-managed sub-agent delegation is active"),
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


describe("new-thread title scheduling", () => {
  beforeEach(() => {
    resetTaskStore();
    vi.clearAllMocks();
    cursor.startCursorTurn.mockResolvedValue({ turnId: "title-turn", cursorSessionId: "session" });
  });
  it("marks a new Codex thread pending before a slow checkpoint exposes its prompt", async () => {
    let release!: () => void;
    const checkpoint = new Promise<void>((resolve) => { release = resolve; });
    const pending = vi.fn(), requested = vi.fn();
    const deps = context({ activeThread: null,
      effectiveSettings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-6-luna" },
      runtimeStatus: { available: true, source: "Codex CLI", path: "codex", version: "1", compatible: true, warning: null },
      account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
      beginRunCheckpoint: vi.fn(async () => { await checkpoint; return "checkpoint"; }),
      onThreadTitlePending: pending, onThreadTitleRequested: requested,
    });
    codex.rpc.mockImplementation(async (method: string) => method === "thread/start"
      ? { thread: { ...OPENAI_THREAD, id: "title-new-codex" } } : { turn: { id: "title-turn" } });
    const view = renderHook(() => useTurnRunner(deps));
    let sending!: Promise<boolean>;
    await act(async () => { sending = view.result.current.sendMessage("Fix scrolling"); });
    expect(pending).toHaveBeenCalledExactlyOnceWith("title-new-codex", "Fix scrolling");
    expect(pending.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.setThreads).mock.invocationCallOrder[0]);
    expect(requested).not.toHaveBeenCalled();
    await act(async () => { release(); expect(await sending).toBe(true); });
    expect(requested).toHaveBeenCalledExactlyOnceWith("title-new-codex", "Fix scrolling");
  });
  it("requests a title only after a new local prompt is accepted", async () => {
    const onThreadTitleRequested = vi.fn();
    const onThreadTitlePending = vi.fn();
    const onThreadTitleCancelled = vi.fn();
    const deps = context({ activeThread: null, onThreadTitleRequested, onThreadTitlePending, onThreadTitleCancelled });
    const view = renderHook(() => useTurnRunner(deps));
    await act(async () => { expect(await view.result.current.sendMessage("Fix the sidebar scrolling")).toBe(true); });
    const id = vi.mocked(deps.onThreadCreated).mock.calls[0][0];
    expect(onThreadTitlePending).toHaveBeenCalledExactlyOnceWith(id, "Fix the sidebar scrolling");
    expect(onThreadTitlePending.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.setThreads).mock.invocationCallOrder[0]);
    expect(onThreadTitleRequested).toHaveBeenCalledExactlyOnceWith(id, "Fix the sidebar scrolling");
  });
  it("does not spend a title call on failed sends or an existing thread", async () => {
    const onThreadTitleRequested = vi.fn();
    const onThreadTitlePending = vi.fn();
    const onThreadTitleCancelled = vi.fn();
    cursor.startCursorTurn.mockRejectedValueOnce(new Error("not signed in"));
    const view = renderHook((props) => useTurnRunner(props), { initialProps: context({ activeThread: null, onThreadTitleRequested, onThreadTitlePending, onThreadTitleCancelled }) });
    await act(async () => { expect(await view.result.current.sendMessage("Fix scrolling")).toBe(false); });
    expect(onThreadTitleRequested).not.toHaveBeenCalled();
    expect(onThreadTitleCancelled).toHaveBeenCalledWith(expect.any(String));
    cursor.startCursorTurn.mockResolvedValue({ turnId: "next", cursorSessionId: "session" });
    view.rerender(context({ onThreadTitleRequested }));
    await act(async () => { await view.result.current.sendMessage("Now fix another thing"); });
    expect(onThreadTitleRequested).not.toHaveBeenCalled();
  });
});

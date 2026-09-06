import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { Thread } from "./types";

/**
 * Integration harness for App-level lifecycle regressions. Mocks the Tauri
 * bridge and drives the real sidebar/selection flows.
 */

const invokeMock = vi.fn();
const settingsPrewarm = vi.hoisted(() => ({ schedule: vi.fn<(preload: () => void) => () => void>(() => () => {}) }));
vi.mock("./lib/settingsPreload", () => ({ scheduleSettingsPreload: settingsPrewarm.schedule }));
const tauriEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauriEvents.handlers.set(name, handler);
    return () => tauriEvents.handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.0.0-test"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));

const PROJECT_A = { id: "project-a", name: "Alpha", path: "/projects/alpha" };
const PROJECT_B = { id: "project-b", name: "Beta", path: "/projects/beta" };

const THREAD_A: Thread = {
  id: "thread-a",
  name: "Alpha thread",
  preview: "work in alpha",
  cwd: PROJECT_A.path,
  updatedAt: 1_700_000_000,
  modelProvider: "openai",
};

const THREAD_B: Thread = {
  id: "thread-b",
  name: "Beta thread",
  preview: "second thread in alpha",
  cwd: PROJECT_A.path,
  updatedAt: 1_700_000_100,
  modelProvider: "openai",
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let pendingResume: Deferred<{ thread: Thread }>;
let resumeImpl: (params: Record<string, unknown>) => unknown;
let threadReadImpl: (params: Record<string, unknown>) => unknown;
let threadListImpl: (params: Record<string, unknown>) => unknown;
let threadTurnsListImpl: (params: Record<string, unknown>) => unknown;
let turnStartImpl: (params: Record<string, unknown>) => unknown;
let accountReadImpl: (params: Record<string, unknown>) => unknown;
let accountLogoutImpl: () => unknown;
let rateLimitsImpl: () => unknown;
let openRouterReadyImpl: () => boolean;
let openRouterCreditsImpl: () => unknown;
let commandExecImpl: (params: Record<string, unknown>) => unknown;
let claudeRuntimeStatusImpl: () => unknown;
let claudeModelsImpl: () => unknown;
let modelListImpl: (params: Record<string, unknown>) => unknown;
let cursorModelsImpl: () => unknown;
/** Bumped by every managed app-server restart, real or simulated. */
let runtimeGeneration: number;
let runtimeLoadedThreads: Set<string>;
let workspaceGitInfoImpl: () => unknown;
let workspaceGitInitializeImpl: () => unknown;
let lmStudioModelsImpl: (baseUrl: string) => unknown;
/** Throwing here is how a runtime without the review diff behaves. */
let gitDiffToRemoteImpl: () => unknown;

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  if (command === "codex_runtime_status") {
    return {
      available: true,
      source: "Codex CLI",
      path: "/usr/local/bin/codex",
      dataHome: "/profiles/localdev/codex-home",
      version: "99.0.0",
      compatible: true,
      warning: null,
    };
  }
  if (command === "claude_runtime_status") {
    return claudeRuntimeStatusImpl();
  }
  if (command === "claude_models") return claudeModelsImpl();
  if (command === "cursor_models") return cursorModelsImpl();
  if (command === "github_status") {
    return {
      available: true,
      authenticated: true,
      path: "/opt/homebrew/bin/gh",
      version: "gh version test",
      login: "test-user",
      name: "Test User",
      email: null,
      avatarUrl: null,
      profileUrl: null,
      error: null,
    };
  }
  if (command === "github_repo_status") {
    return {
      isRepo: true,
      remoteUrl: "https://github.com/test-user/alpha.git",
      repository: "test-user/alpha",
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    };
  }
  if (command === "state_read") return null;
  if (command === "local_transcript_list") return [];
  if (command === "audit_recent") return [];
  // Every app-server restart hands back a different identity, which is how the
  // app knows the threads that process had loaded are gone with it.
  if (command === "runtime_instance") return `runtime-${runtimeGeneration}`;
  if (command === "runtime_thread_state") {
    const threadId = String(args?.threadId ?? "");
    return { instance: `runtime-${runtimeGeneration}`, loaded: runtimeLoadedThreads.has(threadId) };
  }
  if (command === "restart_runtime") {
    runtimeGeneration += 1;
    runtimeLoadedThreads.clear();
    return null;
  }
  if (command === "normal_chat_workspace") return "/chats";
  if (command === "workspace_git_info") {
    return workspaceGitInfoImpl();
  }
  if (command === "workspace_git_initialize") {
    return workspaceGitInitializeImpl();
  }
  if (command === "worktree_create") {
    return {
      path: "/managed/worktrees/isolated-thread",
      branch: "openkiwi/isolated-thread",
      baseCommit: "head",
      gitDir: "/projects/alpha/.git",
    };
  }
  if (command === "worktree_status") {
    if (String(args?.worktreePath).includes("missing")) {
      return {
        exists: false,
        registered: false,
        branch: null,
        baseCommit: null,
        changedFiles: 0,
        untrackedFiles: 0,
        ignoredFileCount: 0,
        ahead: 0,
        behind: 0,
        clean: false,
      };
    }
    return {
      exists: true,
      registered: true,
      branch: "openkiwi/isolated-thread",
      baseCommit: "head",
      changedFiles: 0,
      untrackedFiles: 0,
      ignoredFileCount: 0,
      ahead: 0,
      behind: 0,
      clean: true,
    };
  }
  if (command === "worktree_remove") return null;
  if (command === "checkpoint_create") {
    return {
      commit: `before-${String(args?.id)}`,
      repoRoot: String(args?.cwd),
      fileCount: 4,
      branch: "main",
      head: "head",
    };
  }
  if (command === "checkpoint_complete") {
    return {
      snapshot: {
        commit: `after-${String(args?.id)}`,
        repoRoot: String(args?.cwd),
        fileCount: 5,
        branch: "main",
        head: "head",
      },
      changedFiles: 1,
      additions: 2,
      deletions: 0,
    };
  }
  if (command === "checkpoint_delete") return null;
  if (command === "child_agent_session_start") {
    const options = (args?.options ?? {}) as { targets?: unknown[]; sessionId?: string };
    const delegation = Boolean(options.targets?.length);
    return {
      name: "mythra_agents",
      command: "/Applications/Mythra Code.app/Contents/MacOS/mythra-code",
      args: ["--openkiwi-agent-bridge", `/tmp/${options.sessionId ?? "session"}.json`],
      configPath: `/tmp/${options.sessionId ?? "session"}.mcp.json`,
      toolNames: delegation
        ? ["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent", "propose_agent_settings"]
        : ["propose_agent_settings"],
    };
  }
  if (command === "child_agent_session_end" || command === "child_agent_finished" || command === "child_agent_respond") return null;
  if (command === "has_openrouter_key") return openRouterReadyImpl();
  if (command === "openrouter_credits") return openRouterCreditsImpl();
  if (command === "list_lmstudio_models") return lmStudioModelsImpl(String(args?.baseUrl ?? ""));
  if (command === "codex_rpc") {
    const method = args?.method as string;
    const params = (args?.params ?? {}) as Record<string, unknown>;
    if (method === "thread/list") return threadListImpl(params);
    if (method === "thread/start") {
      runtimeLoadedThreads.add("isolated-thread");
      return {
        thread: {
          ...THREAD_A,
          id: "isolated-thread",
          cwd: String(params.cwd),
          turns: [],
        },
      };
    }
    if (method === "command/exec") return commandExecImpl(params);
    if (method === "gitDiffToRemote") return gitDiffToRemoteImpl();
    if (method === "fs/readDirectory") {
      return { entries: [
        { fileName: "diagram.PNG", isDirectory: false, isFile: true },
        { fileName: "notes.md", isDirectory: false, isFile: true },
      ] };
    }
    if (method === "fs/readFile") return { dataBase64: btoa("preview") };
    if (method === "fuzzyFileSearch") return { files: [] };
    if (method === "thread/read") {
      return threadReadImpl(params);
    }
    if (method === "thread/turns/list") return threadTurnsListImpl(params);
    if (method === "thread/resume") {
      return Promise.resolve(resumeImpl(params)).then((result) => {
        runtimeLoadedThreads.add(String(params.threadId));
        return result;
      });
    }
    if (method === "turn/start") return turnStartImpl(params);
    if (method === "account/read") {
      return accountReadImpl(params);
    }
    if (method === "account/logout") {
      const result = accountLogoutImpl();
      queueMicrotask(() => tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } }));
      return result;
    }
    if (method === "account/rateLimits/read") return rateLimitsImpl();
    if (method === "model/list") return modelListImpl(params);
    return {};
  }
  return null;
}

async function renderApp() {
  // App reads persisted projects at module scope, so the module registry must
  // be reset after seeding storage for each test.
  vi.resetModules();
  const { default: App } = await import("./App");
  const view = render(<App />);
  await screen.findByRole("button", { name: PROJECT_B.name });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  tauriEvents.handlers.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  pendingResume = deferred<{ thread: Thread }>();
  resumeImpl = () => pendingResume.promise;
  threadReadImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
  threadListImpl = (params) => ({
    data: params.cwd === PROJECT_A.path ? [THREAD_A, THREAD_B] : [],
    nextCursor: null,
  });
  threadTurnsListImpl = () => ({ data: [], nextCursor: null, backwardsCursor: null });
  turnStartImpl = (params) => ({ turn: { id: `turn-${String(params.threadId)}` } });
  accountReadImpl = () => ({ account: { type: "chatgpt", email: "test@example.com", planType: "pro" }, requiresOpenaiAuth: true });
  accountLogoutImpl = () => ({});
  rateLimitsImpl = () => ({ rateLimits: {} });
  openRouterReadyImpl = () => false;
  openRouterCreditsImpl = () => ({ remaining: 0, used: null, source: "account" });
  commandExecImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
  claudeRuntimeStatusImpl = () => ({
    available: false,
    path: null,
    version: null,
    loggedIn: false,
    authMethod: null,
    email: null,
    subscriptionType: null,
    warning: null,
  });
  claudeModelsImpl = () => ({ models: [] });
  modelListImpl = () => ({ data: [] });
  cursorModelsImpl = () => [];
  runtimeGeneration = 1;
  runtimeLoadedThreads = new Set();
  workspaceGitInfoImpl = () => ({ isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "head" });
  workspaceGitInitializeImpl = () => ({
    info: { isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "new-head" },
    initialized: true,
    createdCommit: true,
    trackedFiles: 2,
  });
  lmStudioModelsImpl = () => ({ models: [] });
  gitDiffToRemoteImpl = () => ({ diff: "" });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    stubInvoke(command, args),
  );
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
});

afterEach(async () => {
  // vi.resetModules() does not cancel timers owned by the previous Composer
  // module. Its debounced save must not overwrite the next test's seeded
  // storage while a slower runner is importing a fresh App instance.
  const { resetDraftStoreForTests } = await import("./components/Composer");
  resetDraftStoreForTests();
  vi.doUnmock("./components/SettingsModal");
});

describe("Codex cold startup", () => {
  it.each(["button", "Escape"])("dismisses a failed Settings load with %s and permits a fresh open", async how => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("./components/SettingsModal", () => { throw new Error("Settings chunk unavailable"); });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const reload = await screen.findByRole("button", { name: "Reload view" });
    expect(reload).toHaveFocus();
    if (how === "Escape") fireEvent.keyDown(reload, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Close settings error" }));
    expect(screen.queryByText("The settings view hit a problem")).not.toBeInTheDocument();
    expect(document.querySelector(".sidebar")).not.toHaveAttribute("inert");
    vi.doMock("./components/SettingsModal", () => ({ SettingsModal: () => <div role="dialog" aria-label="Reopened settings" /> }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Reopened settings" })).toBeInTheDocument();
  });
  it("mounts cold-loaded Settings once and retains the same instance on reopening", async () => {
    const loaded = deferred<void>();
    const mounted = vi.fn();
    function TestSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
      useEffect(() => { mounted(); }, []);
      return <div role="dialog" aria-label="Loaded settings" hidden={!open}><button onClick={onClose}>Close test settings</button></div>;
    }
    vi.doMock("./components/SettingsModal", async () => { await loaded.promise; return { SettingsModal: TestSettings }; });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => {
      loaded.resolve();
      // Resolving the mock gate does not finish Vitest's dynamic-import chain.
      // Await that boundary before checking the mount, rather than racing the
      // test runner's cold module loading against findBy's default timeout.
      await vi.dynamicImportSettled();
    });
    const dialog = screen.getByRole("dialog", { name: "Loaded settings" });
    expect(mounted).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close test settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Loaded settings" })).toBe(dialog);
    expect(mounted).toHaveBeenCalledOnce();
  });
  it("surfaces a Settings import failure and reloads successfully through the existing boundary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("./components/SettingsModal", () => { throw new Error("Settings chunk unavailable"); });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("The settings view hit a problem")).toBeInTheDocument();
    vi.doMock("./components/SettingsModal", () => ({ SettingsModal: () => <div role="dialog" aria-label="Recovered settings" /> }));
    fireEvent.click(screen.getByRole("button", { name: "Reload view" }));
    expect(await screen.findByRole("dialog", { name: "Recovered settings" })).toBeInTheDocument();
  });
  it("opens preloaded Settings synchronously without mounting it during prewarm", async () => {
    await renderApp();
    const preload = settingsPrewarm.schedule.mock.calls.at(-1)?.[0] as (() => Promise<unknown>) | undefined;
    expect(preload).toBeTypeOf("function");
    await act(async () => { await preload!(); });
    expect(document.querySelector(".settings-backdrop")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    // No findBy/waitFor: a fulfilled preload must bypass React.lazy's initial
    // Suspense retry, not merely make its promise resolve a little faster.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });
  it.each(["main", "sub-agent"])("keeps the topbar Ready or Working and reports %s bulk actions outside it", async (kind) => {
    const user = userEvent.setup();
    const threads = [THREAD_A, THREAD_B].map(thread => kind === "sub-agent" ? { ...thread, parentThreadId: "root", threadSource: "subagent" } : thread);
    threadListImpl = (params) => ({ data: params.cwd === PROJECT_A.path ? threads : [], nextCursor: null });
    resumeImpl = () => ({ thread: { ...threads[0], turns: [] } });
    await renderApp();
    if (kind === "sub-agent") await user.click(within(screen.getByRole("group", { name: "Thread type" })).getByRole("button", { name: /^Sub-agents/ }));
    const status = document.querySelector(".runtime-status")!;
    expect(status.textContent).toBe("Ready");
    await user.click(await screen.findByText("Alpha thread"));
    const { useTaskStore } = await import("./lib/taskStore");
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "running"));
    expect(status.textContent).toBe("Working");
    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "completed"));
    expect(status.textContent).toBe("Ready");
    const { save } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(save).mockResolvedValueOnce("/tmp/transcript-test.md");
    await user.click(screen.getByRole("button", { name: "Export conversation as Markdown" }));
    const exported = await screen.findByText("Transcript exported");
    expect(exported.closest(".app-toast")).toHaveClass("info");
    expect(status.textContent).toBe("Ready");
    await user.click(screen.getByRole("button", { name: "Archive all" }));
    expect(await screen.findByText(`Archived 2 ${kind} threads`)).toBeInTheDocument();
    expect(status.textContent).toBe("Ready");
    expect(status).not.toHaveTextContent("Archived");
  });
  it("keeps the app visible while the Settings chunk loads for the first time", { timeout: 15_000 }, async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.queryByRole("dialog", { name: "Loading settings…" })).not.toBeInTheDocument();
    expect(document.querySelector(".settings-backdrop.open .runtime-setup-modal")).not.toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toBeInTheDocument();
    // A cold Windows CI runner can take more than Testing Library's one-second
    // default to transform the lazy Settings chunk while the full suite runs.
    // The immediate assertions above are the regression guard; this longer
    // wait only proves the chunk eventually resolves instead of hiding an
    // actual import failure.
    expect(await screen.findByRole("dialog", { name: "Settings" }, { timeout: 10_000 })).toBeInTheDocument();
  });

  it("loads local threads without waiting for a forced token refresh", async () => {
    const auth = deferred<{ account: { type: "chatgpt"; email: string; planType: string }; requiresOpenaiAuth: boolean }>();
    accountReadImpl = () => auth.promise;
    await renderApp();

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([, args]) => args?.method === "account/read");
      expect(call?.[1]?.params).toEqual({ refreshToken: false });
    });
    const methodsBeforeAuth = invokeMock.mock.calls
      .filter(([command]) => command === "codex_rpc")
      .map(([, args]) => args?.method);
    expect(methodsBeforeAuth).toContain("thread/list");
    expect(methodsBeforeAuth).not.toContain("model/list");
    expect(methodsBeforeAuth).toContain("skills/list");

    await act(async () => {
      auth.resolve({
        account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      });
      await auth.promise;
    });

    await waitFor(() => {
      const methods = invokeMock.mock.calls
        .filter(([command]) => command === "codex_rpc")
        .map(([, args]) => args?.method);
      expect(methods).toContain("thread/list");
      expect(methods).toContain("model/list");
      expect(methods).toContain("skills/list");
    });
  });

  it("recovers a durable local thread when the browser sidebar index is missing", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "durable-claude",
      name: "Recovered Claude thread",
      preview: "recover me from SQLite",
      modelProvider: "claude",
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [claudeThread];
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) {
        return {
          thread: claudeThread,
          messages: [{ id: "recovered-message", role: "assistant", text: "durable history is visible", timelineOrder: 1 }],
          activities: [],
          nextCursor: null,
          headSeq: 0,
          tailSeq: 1,
          generation: 3,
          byteLen: 512,
        };
      }
      return stubInvoke(command, args);
    });

    await renderApp();
    await user.click(await screen.findByText("Recovered Claude thread"));

    // This is a persistence assertion, not a cold-module latency benchmark.
    // Await the real lazy timeline import before starting findBy's 1s clock.
    await act(async () => { await import("./components/ChatTimeline"); });

    expect(await screen.findByText("durable history is visible")).toBeInTheDocument();
    const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
    expect(remembered[claudeThread.id]).toMatchObject({ id: claudeThread.id, modelProvider: "claude" });
  });

  it("keeps durable local threads available when OpenAI listing fails", async () => {
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "offline-claude",
      name: "Offline Claude thread",
      modelProvider: "claude",
    };
    threadListImpl = () => {
      throw new Error("OpenAI runtime is temporarily unavailable");
    };
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [claudeThread];
      return stubInvoke(command, args);
    });

    await renderApp();

    expect(await screen.findByText("Offline Claude thread")).toBeInTheDocument();
    expect(screen.getByText("OpenAI runtime is temporarily unavailable")).toBeInTheDocument();
  });

  it("does not resurrect an archived local transcript during durable discovery", async () => {
    const archivedClaude: Thread = {
      ...THREAD_A,
      id: "archived-claude",
      name: "Archived Claude thread",
      modelProvider: "claude",
    };
    localStorage.setItem("kiwi.archivedThreads", JSON.stringify([{
      id: archivedClaude.id,
      label: archivedClaude.name,
      path: PROJECT_A.path,
      archivedAt: Date.now(),
      provider: "claude",
    }]));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_list") return [archivedClaude];
      return stubInvoke(command, args);
    });

    await renderApp();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_transcript_list", {
      knownThreadIds: [archivedClaude.id],
    }));
    expect(screen.queryByText("Archived Claude thread")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Archived\s*1/i })).toBeInTheDocument();
  });

  it("renders the newest thread page while older sidebar pages are still loading", async () => {
    const olderPage = deferred<{ data: Thread[]; nextCursor: null }>();
    threadListImpl = (params) => {
      if (params.cwd !== PROJECT_A.path) return { data: [], nextCursor: null };
      if (params.cursor === "older-threads") return olderPage.promise;
      return { data: [THREAD_A], nextCursor: "older-threads" };
    };
    await renderApp();

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/list",
      params: { cwd: PROJECT_A.path, limit: 100, cursor: "older-threads" },
    })));
    expect(await screen.findByText("Alpha thread", {}, { timeout: 500 })).toBeInTheDocument();
    expect(screen.queryByText("Beta thread")).not.toBeInTheDocument();

    await act(async () => {
      olderPage.resolve({ data: [THREAD_B], nextCursor: null });
      await olderPage.promise;
    });
    expect(await screen.findByText("Beta thread")).toBeInTheDocument();
  });

  it("refreshes models and usage when a signed-in account update arrives", async () => {
    let loggedIn = false;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    await renderApp();
    await waitFor(() => expect(tauriEvents.handlers.has("codex-event")).toBe(true));
    expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "model/list")).toHaveLength(0);

    loggedIn = true;
    await act(async () => {
      tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } });
    });

    await waitFor(() => {
      expect(invokeMock.mock.calls.some(([, args]) => args?.method === "model/list")).toBe(true);
      expect(invokeMock.mock.calls.some(([, args]) => args?.method === "account/rateLimits/read")).toBe(true);
    });
  });
});

describe("chat header provider usage", () => {
  it("revalidates the saved OpenAI session when Settings opens", async () => {
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription/ });
    accountReadImpl = ({ refreshToken }) => {
      if (refreshToken) throw new Error("refresh_token_expired");
      return { account: { type: "chatgpt", email: "old@example.com", planType: "pro" } };
    };
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({ method: "account/read", params: { refreshToken: true } })));
    await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/ });
  });

  it("clears stale OpenAI identity on auth failure and ignores an older account response", async () => {
    await renderApp();
    await screen.findByRole("button", { name: /OpenAI subscription/ });
    const stale = deferred<{ account: { type: string; email: string; planType: string } }>();
    accountReadImpl = () => stale.promise;
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } }); });
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { stream: "stderr", line: "401 Unauthorized" } }); });
    expect(screen.getByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).toBeInTheDocument();
    await act(async () => {
      stale.resolve({ account: { type: "chatgpt", email: "stale@example.com", planType: "pro" } });
      await stale.promise;
    });
    expect(screen.getByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).toBeInTheDocument();
  });

  it.each([true, false])("only clears identity for authentication failures during usage refresh (%s)", async (authFailure) => {
    const user = userEvent.setup();
    await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription/ });
    rateLimitsImpl = () => { throw new Error(authFailure ? "refresh_token_reused" : "500 Internal Server Error"); };
    await user.click(trigger);
    await waitFor(() => expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read").length).toBeGreaterThan(1));
    if (authFailure) await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/ });
    else expect(screen.queryByRole("button", { name: /OpenAI subscription.*Sign in for usage/ })).not.toBeInTheDocument();
  });

  it("persists the chosen OpenAI window separately from Claude and restores it after reopening", async () => {
    const user = userEvent.setup();
    rateLimitsImpl = () => ({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 }, secondary: { usedPercent: 10, windowMinutes: 10080 } } });
    localStorage.setItem("kiwi.headerUsageWindows", JSON.stringify({ claude: "Weekly Fable" }));
    const view = await renderApp();
    const trigger = await screen.findByRole("button", { name: /OpenAI subscription: 5h 58% left/ });
    const reads = invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read").length;
    await user.click(trigger);
    await user.click(screen.getByRole("radio", { name: "Show Weekly in top bar" }));
    expect(trigger).toHaveTextContent("Weekly 90% left");
    // Opening asks for one fresh reading; picking a window inside the same
    // panel is a display choice and must not ask the provider again.
    expect(invokeMock.mock.calls.filter(([, args]) => args?.method === "account/rateLimits/read")).toHaveLength(reads + 1);
    expect(JSON.parse(localStorage.getItem("kiwi.headerUsageWindows")!)).toEqual({ openai: "Weekly", claude: "Weekly Fable" });
    view.unmount();
    await renderApp();
    expect(await screen.findByRole("button", { name: /OpenAI subscription: Weekly 90% left/ })).not.toHaveTextContent("5h");
  });

  it("keeps the control visible when Local Dev is signed out and opens account settings", async () => {
    const user = userEvent.setup();
    accountReadImpl = () => ({ account: null, requiresOpenaiAuth: true });
    await renderApp();

    const signInUsage = await screen.findByRole("button", {
      name: /OpenAI subscription.*Sign in for usage.*Open usage details/i,
    });
    expect(signInUsage).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /^Models & accounts/ })).not.toBeInTheDocument();
    await user.click(signInUsage);
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(await screen.findByText("Official ChatGPT subscription sign-in")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByText("Official ChatGPT subscription sign-in")).toBeInTheDocument();
    await user.click(signInUsage);
    await user.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(screen.getByText("Official ChatGPT subscription sign-in")).toBeInTheDocument();
  });

  it("shows live OpenRouter credits and opens the detailed usage surface", async () => {
    const user = userEvent.setup();
    openRouterReadyImpl = () => true;
    openRouterCreditsImpl = () => ({ remaining: 74.75, used: 25.75, source: "account" });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4.5" }));
    await renderApp();

    const credits = await screen.findByRole("button", { name: /OpenRouter account.*74\.75 credits left.*Open usage details/i });
    expect(credits).toHaveTextContent("$74.75 credits left");
    await user.click(credits);
    expect(await screen.findByText(/Usage & audit|Provider quota display/)).toBeInTheDocument();
  });

  it("refreshes OpenRouter credits when an existing API key is replaced", async () => {
    const user = userEvent.setup();
    let requests = 0;
    openRouterReadyImpl = () => true;
    openRouterCreditsImpl = () => ({ remaining: requests++ === 0 ? 10 : 20, used: 1, source: "account" });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openrouter", model: "x-ai/grok-4.5" }));
    await renderApp();

    expect(await screen.findByRole("button", { name: /\$10\.00 credits left/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(screen.getByRole("button", { name: /OpenRouter.*Responses-compatible model routing/ }));
    await user.type(screen.getByPlaceholderText("sk-or-v1-…"), "sk-or-v1-new");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    expect(await screen.findByRole("button", { name: /\$20\.00 credits left/i })).toBeInTheDocument();
    expect(requests).toBeGreaterThanOrEqual(2);
  });

  it("clears the previous OpenAI quota immediately after sign-out", async () => {
    const user = userEvent.setup();
    let loggedIn = true;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    accountLogoutImpl = () => {
      loggedIn = false;
      return {};
    };
    rateLimitsImpl = () => ({
      rateLimits: { primary: { usedPercent: 42, windowMinutes: 300, resetsAt: null } },
    });
    await renderApp();

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*58% left/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/i })).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /OpenAI subscription.*58% left/i })).not.toBeInTheDocument();
  });

  it("ignores an old quota request that completes after sign-out", async () => {
    const user = userEvent.setup();
    const pendingUsage = deferred<{ rateLimits: { primary: { usedPercent: number; windowMinutes: number } } }>();
    let loggedIn = true;
    accountReadImpl = () => ({
      account: loggedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null,
      requiresOpenaiAuth: true,
    });
    accountLogoutImpl = () => {
      loggedIn = false;
      return {};
    };
    rateLimitsImpl = () => pendingUsage.promise;
    await renderApp();
    await waitFor(() => expect(invokeMock.mock.calls.some(([, args]) => args?.method === "account/rateLimits/read")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await act(async () => {
      pendingUsage.resolve({ rateLimits: { primary: { usedPercent: 42, windowMinutes: 300 } } });
      await pendingUsage.promise;
    });

    expect(await screen.findByRole("button", { name: /OpenAI subscription.*Sign in for usage/i })).toHaveTextContent("Sign in for usage");
    expect(screen.queryByRole("button", { name: /OpenAI subscription.*58% left/i })).not.toBeInTheDocument();
  });
});

describe("GitHub clone parent-folder flow", () => {
  it("clones to the previewed subfolder and preserves projects added while the clone is running", async () => {
    const user = userEvent.setup();
    const pendingClone = deferred<null>();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "github_clone_repository" ? pendingClone.promise : stubInvoke(command, args));
    await renderApp();
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValueOnce("/projects").mockResolvedValueOnce("/projects/added-during-clone");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /^GitHub/ }));
    await user.type(screen.getByRole("textbox", { name: "Repository URL" }), "https://github.com/owner/cloned.git?tab=readme");
    await user.click(screen.getByRole("button", { name: "Choose parent folder…" }));
    expect(await screen.findByText("/projects/cloned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("github_clone_repository", { url: "https://github.com/owner/cloned.git", destination: "/projects/cloned" }));
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("button", { name: "added-during-clone" })).toBeInTheDocument();
    await act(async () => { pendingClone.resolve(null); await pendingClone.promise; });
    expect(await screen.findByRole("button", { name: "cloned" })).toBeInTheDocument();
    const paths = JSON.parse(localStorage.getItem("kiwi.projects")!).map((project: { path: string }) => project.path);
    expect(paths).toEqual([PROJECT_A.path, PROJECT_B.path, "/projects/added-during-clone", "/projects/cloned"]);
  });
});

describe("project defaults", () => {
  it("automatically applies project provider, model, theme, effort-slider, and chat-font defaults", async () => {
    localStorage.setItem("kiwi.projects", JSON.stringify([
      {
        ...PROJECT_A,
        overrides: {
          defaults: {
            provider: "claude",
            model: "claude-opus-5",
            theme: "synthwave",
            effortSlider: "coil",
            chatFont: "humanist",
          },
        },
      },
      PROJECT_B,
    ]));

    const user = userEvent.setup();
    await renderApp();
    const shell = document.querySelector(".app-shell");

    expect(shell).toHaveAttribute("data-theme", "synthwave");
    expect(shell).toHaveAttribute("data-effort-slider", "coil");
    expect(shell).toHaveAttribute("data-chat-font", "humanist");
    expect(screen.getByRole("button", { name: "New thread provider: Claude" })).toHaveTextContent("Claude");
    expect(screen.getByRole("button", { name: /Claude model:/ })).toHaveTextContent("Opus");

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    expect(shell).toHaveAttribute("data-theme", "mythra");
    expect(shell).toHaveAttribute("data-effort-slider", "aurora");
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(screen.getByRole("button", { name: "New thread provider: OpenAI" })).toBeInTheDocument();
  });
});

describe("Claude model updates", () => {
  it("routes an update-required successor to Settings without selecting its sentinel id", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "claude", model: "sonnet" }));
    claudeRuntimeStatusImpl = () => ({
      available: true,
      path: "/usr/local/bin/claude",
      version: "2.1.250",
      loggedIn: true,
      authMethod: "claude.ai",
      email: "test@example.com",
      subscriptionType: "max",
      warning: null,
    });
    claudeModelsImpl = () => ({
      models: [
        { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
        { value: "claude-fable-5[1m]", displayName: "Fable", description: "Fable 5 · Most capable", resolvedModel: "claude-fable-5[1m]" },
        { value: "cc-update-required-1", displayName: "Fable 5.1 (disabled)", description: "Update to 2.1.255+ to use Fable 5.1", resolvedModel: "cc-update-required-1", isDisabled: true },
      ],
    });

    try {
      const user = userEvent.setup();
      await renderApp();
      await user.click(await screen.findByRole("button", { name: /Claude model: Sonnet/i }));
      expect(screen.queryByRole("menuitemradio", { name: /^Fable$/ })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("menuitem", { name: /Fable 5\.1 \(Claude Code update required\)/ }));
      expect(localStorage.getItem("kiwi.settings")).toContain('"model":"sonnet"');
      await user.click(await screen.findByRole("button", { name: "Go to Updates" }));
      const settings = await screen.findByRole("dialog", { name: "Settings" });
      expect(within(settings).getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});

describe("chat typeface", () => {
  it("publishes a saved chat font on the shell for the scoped chat styles to read", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ chatFont: "serif" }));

    await renderApp();

    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "serif");
  });

  it("falls back to the interface default for settings saved before the selector", async () => {
    // A settings blob from an older build has no chatFont at all, and a
    // hand-edited one can hold anything; both must render as the default.
    localStorage.setItem("kiwi.settings", JSON.stringify({ theme: "midnight", chatFont: "Papyrus" }));

    await renderApp();

    const shell = document.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(shell).toHaveAttribute("data-theme", "midnight");
  });

  it("previews live and restores the saved typeface when Settings is cancelled", async () => {
    const user = userEvent.setup();
    await renderApp();
    const shell = document.querySelector(".app-shell");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Reading serif/ }));
    expect(shell).toHaveAttribute("data-chat-font", "serif");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(shell).toHaveAttribute("data-chat-font", "system");
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").chatFont).toBeUndefined();
  });

  it("persists a saved typeface through the real app settings store", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Monospace/ }));
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").chatFont).toBe("mono"));
    expect(document.querySelector(".app-shell")).toHaveAttribute("data-chat-font", "mono");
  });
});

describe("model catalog request ordering", () => {
  const catalogModel = (id: string) => ({ id, model: id, displayName: id, description: "Account model", supportedReasoningEfforts: [], defaultReasoningEffort: "high", isDefault: false });

  it("keeps Cursor refresh failures inside the picker and clears them on retry", async () => {
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "cursor", model: "auto" }));
    cursorModelsImpl = () => [{ id: "auto", name: "Auto", configOptions: [] }];
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^Cursor model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh Cursor model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    cursorModelsImpl = () => { throw new Error("Cursor catalog offline"); };
    await user.click(refresh);
    expect(await screen.findByRole("status")).toHaveTextContent("Cursor catalog offline");
    expect(screen.getAllByText(/Cursor catalog offline/)).toHaveLength(1);
    cursorModelsImpl = () => [{ id: "auto", name: "Auto", configOptions: [] }];
    await user.click(refresh);
    expect(screen.queryByText(/Cursor catalog offline/)).not.toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^Auto,/ })).toBeInTheDocument();
  });

  it("ignores an older OpenAI refresh that completes after a newer account refresh", async () => {
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const oldRequest = deferred<{ data: unknown[] }>();
    const newRequest = deferred<{ data: unknown[] }>();
    let calls = 0;
    modelListImpl = () => ++calls === 1 ? oldRequest.promise : newRequest.promise;
    await user.click(refresh);
    await act(async () => { tauriEvents.handlers.get("codex-event")?.({ payload: { method: "account/updated", params: {} } }); });
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => { newRequest.resolve({ data: [catalogModel("newest-model")] }); });
    expect(await screen.findByRole("menuitemradio", { name: /^newest-model:/ })).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    await act(async () => { oldRequest.resolve({ data: [] }); });
    expect(screen.getByRole("menuitemradio", { name: /^newest-model:/ })).toBeInTheDocument();
    expect(screen.queryByText(/empty model catalog/)).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  it("refreshes OpenAI pages from the picker without replacing the chosen model or restarting the runtime", async () => {
    const user = userEvent.setup();
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const nextPage = deferred<{ data: unknown[] }>();
    modelListImpl = (params) => params.cursor === "page-2" ? nextPage.promise : { data: [catalogModel("new-model")], nextCursor: "page-2" };
    const requestsBefore = invokeMock.mock.calls.length;
    await user.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.queryByRole("menuitemradio", { name: /^new-model:/ })).not.toBeInTheDocument();
    await act(async () => { nextPage.resolve({ data: [catalogModel("new-model-two")] }); });
    expect(await screen.findByRole("menuitemradio", { name: /^new-model-two:/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: /^new-model:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^OpenAI model: gpt-5.6-sol/ })).toHaveAttribute("aria-expanded", "true");
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveFocus();
    const calls = invokeMock.mock.calls.slice(requestsBefore);
    expect(calls.filter(([, args]) => args?.method === "model/list").map(([, args]) => args?.params.cursor)).toEqual([null, "page-2"]);
    expect(calls.some(([command, args]) => command === "restart_runtime" || ["turn/start", "thread/start", "account/read"].includes(args?.method))).toBe(false);
  });

  it.each(["failed page", "empty catalog", "endless pages"])("keeps the last complete OpenAI catalog on %s and offers a working retry", async (failure) => {
    const user = userEvent.setup();
    modelListImpl = () => ({ data: [catalogModel("gpt-5.6-sol")] });
    await renderApp();
    await user.click(screen.getByRole("button", { name: /^OpenAI model:/ }));
    const refresh = screen.getByRole("button", { name: "Refresh OpenAI model catalog" });
    await waitFor(() => expect(refresh).toBeEnabled());
    modelListImpl = (params) => {
      if (failure === "empty catalog") return { data: [] };
      if (params.cursor && failure === "failed page") throw new Error("Network unavailable");
      return { data: [catalogModel("partial-model")], nextCursor: "more" };
    };
    await user.click(refresh);
    expect(await screen.findByRole("status")).toHaveTextContent("Showing the last loaded catalog");
    expect(screen.getByRole("menuitemradio", { name: /^gpt-5.6-sol:/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio", { name: /^partial-model:/ })).not.toBeInTheDocument();
    expect(refresh).toBeEnabled();
    modelListImpl = () => ({ data: [catalogModel("recovered-model")] });
    await user.click(refresh);
    expect(await screen.findByRole("menuitemradio", { name: /^recovered-model:/ })).toBeInTheDocument();
    expect(screen.queryByText(/Showing the last loaded catalog/)).not.toBeInTheDocument();
  });
  it("does not let a slow LM Studio startup probe overwrite a newer manual refresh", { timeout: 15_000 }, async () => {
    const startup = deferred<{ models: unknown[] }>();
    const manual = deferred<{ models: unknown[] }>();
    let requests = 0;
    const urls: string[] = [];
    lmStudioModelsImpl = (baseUrl) => {
      urls.push(baseUrl);
      return requests++ === 0 ? startup.promise : manual.promise;
    };

    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: /Models & accounts/ }));
    await user.click(screen.getByRole("button", { name: /LM Studio.*Local models/ }));
    fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:1234/v1"), { target: { value: "http://10.0.0.2:1234/v1" } });
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(urls).toEqual(["http://127.0.0.1:1234/v1", "http://10.0.0.2:1234/v1"]);

    await act(async () => {
      manual.resolve({ models: [{
        type: "llm",
        key: "new/model",
        display_name: "New model",
        capabilities: { trained_for_tool_use: true },
      }] });
      await manual.promise;
    });
    expect(await screen.findByText("1 model available")).toBeInTheDocument();

    await act(async () => {
      startup.resolve({ models: [
        { type: "llm", key: "old/one", display_name: "Old one" },
        { type: "llm", key: "old/two", display_name: "Old two" },
      ] });
      await startup.promise;
    });
    expect(screen.getByText("1 model available")).toBeInTheDocument();
    expect(screen.queryByText("2 models available")).not.toBeInTheDocument();
  });
});

describe("workspace switching during thread selection", () => {
  it("does not offer a runtime thread remembered from another isolated Codex home", async () => {
    const foreign: Thread = {
      ...THREAD_A,
      id: "foreign-thread",
      name: "Foreign runtime thread",
      path: "/profiles/production/codex-home/sessions/foreign-thread.jsonl",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [foreign.id]: foreign }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [foreign.id]: PROJECT_A.path }));

    await renderApp();

    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    expect(screen.queryByText("Foreign runtime thread")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}")).toHaveProperty(foreign.id);
  });

  it("shows Windows shortcut labels for new threads and search", async () => {
    const user = userEvent.setup();
    await renderApp();

    expect(screen.getByText("Ctrl+N").closest("button")).toHaveClass("new-thread-button");
    const searchButton = screen.getByRole("button", { name: "Open command palette" });
    expect(searchButton).toHaveTextContent("Ctrl+K");
    expect(searchButton.querySelector(".lucide-command")).toBeNull();
    expect(searchButton.querySelector(".lucide-search")).not.toBeNull();
    expect(screen.queryByText(/⌘/)).not.toBeInTheDocument();
    await user.click(searchButton);
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("keeps a persisted native Codex child in the Sub-agents inbox and depth-limits it", async () => {
    const user = userEvent.setup();
    const nativeChild: Thread = {
      id: "native-child",
      name: "Native child",
      preview: "Review the implementation",
      cwd: PROJECT_A.path,
      updatedAt: THREAD_B.updatedAt + 1,
      modelProvider: "openai",
      parentThreadId: THREAD_A.id,
      threadSource: "subagent",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [nativeChild.id]: nativeChild }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [nativeChild.id]: PROJECT_A.path }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [nativeChild.id]: {
        childThreadId: nativeChild.id,
        rootThreadId: THREAD_A.id,
        title: nativeChild.preview,
        createdAt: nativeChild.updatedAt * 1000,
      },
    }));
    resumeImpl = (params) => ({ thread: { ...nativeChild, id: String(params.threadId), turns: [] } });

    await renderApp();
    expect(screen.queryByText("Native child")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Sub-agents \d+$/ }));
    await user.click(await screen.findByText("Native child"));

    await waitFor(() => {
      const resumeCalls = invokeMock.mock.calls
        .filter(([command, args]) => command === "codex_rpc" && args?.method === "thread/resume")
        .map(([, args]) => args?.params as Record<string, unknown>);
      expect(resumeCalls.at(-1)).toMatchObject({
        threadId: nativeChild.id,
        config: { features: { multi_agent: false } },
      });
    });
    expect(invokeMock.mock.calls.some(([command]) => command === "child_agent_session_start")).toBe(false);
  });

  it("keeps the root conversation in the main inbox when storage claims it is its own child's child", async () => {
    // A reversed ownership record plus the matching thread metadata is exactly
    // the durable state that used to move the user's main conversation into the
    // Sub-agents inbox and keep it there across reloads.
    const user = userEvent.setup();
    const poisonedRoot: Thread = {
      ...THREAD_A,
      parentThreadId: "native-child",
      threadSource: "subagent",
    };
    const nativeChild: Thread = {
      id: "native-child",
      name: "Native child",
      preview: "Review the implementation",
      cwd: PROJECT_A.path,
      updatedAt: THREAD_B.updatedAt + 1,
      modelProvider: "openai",
      parentThreadId: THREAD_A.id,
      threadSource: "subagent",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({
      [poisonedRoot.id]: poisonedRoot,
      [nativeChild.id]: nativeChild,
    }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({
      [poisonedRoot.id]: PROJECT_A.path,
      [nativeChild.id]: PROJECT_A.path,
    }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [nativeChild.id]: {
        childThreadId: nativeChild.id,
        rootThreadId: THREAD_A.id,
        title: nativeChild.preview,
        createdAt: nativeChild.updatedAt * 1000,
      },
      [poisonedRoot.id]: {
        childThreadId: poisonedRoot.id,
        rootThreadId: nativeChild.id,
        title: "Reversed",
        createdAt: nativeChild.updatedAt * 1000,
      },
    }));

    await renderApp();
    // The root owns a child, so it is a root however its own record reads.
    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    expect(screen.queryByText("Native child")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Sub-agents \d+$/ }));
    expect(await screen.findByText("Native child")).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();

    await waitFor(() => {
      const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
      expect(remembered[THREAD_A.id]).not.toHaveProperty("parentThreadId");
      expect(remembered[THREAD_A.id]).not.toHaveProperty("threadSource");
    });
  });

  it("drops a stale native child claim when thread/list identifies that thread as a root", async () => {
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({
      [THREAD_A.id]: { ...THREAD_A, parentThreadId: "missing-child", threadSource: "subagent" },
    }));
    localStorage.setItem("kiwi.nativeAgentLinks", JSON.stringify({
      [THREAD_A.id]: {
        childThreadId: THREAD_A.id,
        rootThreadId: "missing-child",
        title: "Stale reversed claim",
        createdAt: 1,
      },
    }));

    await renderApp();
    expect(await screen.findByText("Alpha thread")).toBeInTheDocument();
    await waitFor(() => {
      const links = JSON.parse(localStorage.getItem("kiwi.nativeAgentLinks") ?? "{}") as Record<string, unknown>;
      expect(links).not.toHaveProperty(THREAD_A.id);
    });
  });

  it("initializes a plain project before offering an isolated worktree", async () => {
    workspaceGitInfoImpl = () => ({
      isRepo: false,
      isRoot: false,
      hasCommit: false,
      branch: null,
      head: null,
      error: null,
    });
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByRole("button", { name: /Initialize Git repository/i }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("workspace_git_initialize", {
        cwd: PROJECT_A.path,
      });
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Git repository created for Alpha. Isolated worktrees are ready.",
    );
    const isolatedChoice = await screen.findByRole("button", { name: /Isolated worktree/i });
    expect(isolatedChoice).toBeEnabled();
  });

  it("reorders projects by dragging and persists the exact order", async () => {
    const user = userEvent.setup();
    await renderApp();
    const alphaRow = screen.getByRole("button", { name: PROJECT_A.name }).closest(".workspace-row-wrap");
    const betaRow = screen.getByRole("button", { name: PROJECT_B.name }).closest(".workspace-row-wrap");
    const workspaceList = alphaRow?.closest(".workspace-list");
    expect(alphaRow).not.toBeNull();
    expect(betaRow).not.toBeNull();
    expect(workspaceList).not.toBeNull();
    vi.spyOn(workspaceList!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 200,
      height: 200,
    } as DOMRect);
    vi.spyOn(betaRow!, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 34,
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => betaRow),
    });

    await user.pointer([
      { keys: "[MouseLeft>]", target: alphaRow!, coords: { clientX: 10, clientY: 10 } },
      { target: betaRow!, coords: { clientX: 10, clientY: 30 } },
    ]);
    expect(alphaRow).toHaveClass("dragging");
    await user.pointer({ keys: "[/MouseLeft]", target: betaRow!, coords: { clientX: 10, clientY: 30 } });

    const renderedOrder = [...document.querySelectorAll(".workspace-row-wrap .workspace-name")]
      .map((node) => node.textContent);
    expect(renderedOrder).toEqual([PROJECT_B.name, PROJECT_A.name]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string }>;
      expect(stored.map((project) => project.id)).toEqual([PROJECT_B.id, PROJECT_A.id]);
    });
  });

  it("refuses to drag an unpinned project above a pinned one", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([{ ...PROJECT_A, pinned: true }, PROJECT_B]));
    await renderApp();
    const alphaRow = screen.getByRole("button", { name: PROJECT_A.name }).closest(".workspace-row-wrap");
    const betaRow = screen.getByRole("button", { name: PROJECT_B.name }).closest(".workspace-row-wrap");
    const workspaceList = betaRow?.closest(".workspace-list");
    vi.spyOn(workspaceList!, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 200, height: 200 } as DOMRect);
    vi.spyOn(alphaRow!, "getBoundingClientRect").mockReturnValue({ top: 0, height: 34 } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => alphaRow) });

    await user.pointer([
      { keys: "[MouseLeft>]", target: betaRow!, coords: { clientX: 10, clientY: 40 } },
      { target: alphaRow!, coords: { clientX: 10, clientY: 4 } },
    ]);
    expect(betaRow).toHaveClass("dragging");
    // The pinned row is not a legal target, so nothing is marked as a drop.
    expect(document.querySelector(".workspace-row-wrap.drop-before")).toBeNull();
    expect(document.querySelector(".workspace-row-wrap.drop-after")).toBeNull();
    await user.pointer({ keys: "[/MouseLeft]", target: alphaRow!, coords: { clientX: 10, clientY: 4 } });

    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_A.name, PROJECT_B.name]);
  });

  it("keeps a newly pinned project above the unpinned ones, wherever it was dragged", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
    await renderApp();
    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_A.name, PROJECT_B.name]);

    await user.click(screen.getByRole("button", { name: `Options for ${PROJECT_B.name}` }));
    await user.click(await screen.findByRole("menuitem", { name: "Pin project" }));

    expect([...document.querySelectorAll(".workspace-row-wrap .workspace-name")].map((node) => node.textContent))
      .toEqual([PROJECT_B.name, PROJECT_A.name]);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ id: string; pinned?: boolean }>;
      expect(stored.map((project) => [project.id, Boolean(project.pinned)]))
        .toEqual([[PROJECT_B.id, true], [PROJECT_A.id, false]]);
    });
  });

  it("collapses the pinned group and remembers it across reopens", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.projects", JSON.stringify([{ ...PROJECT_A, pinned: true }, PROJECT_B]));
    const view = await renderApp();

    const toggle = screen.getByRole("button", { name: /Pinned/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: PROJECT_A.name })).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByRole("button", { name: PROJECT_A.name })).toBeNull();
    // The unpinned list keeps the sidebar to itself, and the count is the only
    // trace of what was hidden.
    expect(screen.getByRole("button", { name: PROJECT_B.name })).toBeInTheDocument();
    expect(toggle).toHaveTextContent("1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    view.unmount();
    await renderApp();
    expect(screen.queryByRole("button", { name: PROJECT_A.name })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Pinned/ }));
    expect(screen.getByRole("button", { name: PROJECT_A.name })).toBeInTheDocument();
  });

  it("tracks the pointer live while dragging the sidebar edge", async () => {
    await renderApp();
    const shell = document.querySelector(".app-shell") as HTMLElement;
    const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("260px");
    // The pane must not be sized by an inline style, or a render landing
    // mid-drag would snap it back to the last committed width.
    expect(sidebar.getAttribute("style")).toBeNull();

    fireEvent.pointerDown(separator, { clientX: 260, button: 0 });
    fireEvent.pointerMove(window, { clientX: 300 });
    // The edge has already moved, before anything reached React or storage.
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("300px");
    expect(document.body).toHaveAttribute("data-pane-resizing", "sidebar");
    expect(localStorage.getItem("kiwi.paneSizes")).toBeNull();

    fireEvent.pointerUp(window);
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(document.body).not.toHaveAttribute("data-pane-resizing");
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}").sidebar).toBe(300);
  });

  it("resizes the sidebar from the keyboard", async () => {
    await renderApp();
    const shell = document.querySelector(".app-shell") as HTMLElement;
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    separator.focus();
    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("276px");
    expect(separator).toHaveAttribute("aria-valuenow", "276");
    expect(JSON.parse(localStorage.getItem("kiwi.paneSizes") ?? "{}").sidebar).toBe(276);
  });

  it("resizes and persists the Projects/Threads divider", async () => {
    await renderApp();
    const separator = screen.getByRole("separator", { name: "Resize projects and threads" });
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 600,
    } as DOMRect);

    const sections = document.querySelector(".sidebar-sections") as HTMLElement;
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("30%");

    fireEvent.pointerDown(separator, { clientY: 280 });
    fireEvent.pointerMove(window, { clientY: 500 });
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("66.67%");
    fireEvent.pointerUp(window);

    expect(separator).toHaveAttribute("aria-valuenow", "67");
    expect(sections.style.getPropertyValue("--sidebar-split")).toBe("66.67%");
    expect(JSON.parse(localStorage.getItem("kiwi.sidebarSplitRatio") ?? "0")).toBeCloseTo(2 / 3);
  });

  it("shows only actively working thread counts beside projects", async () => {
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    expect(screen.queryByText("0", { selector: ".workspace-thread-count" })).not.toBeInTheDocument();
    act(() => {
      useTaskStore.getState().ensureTask(THREAD_A.id, PROJECT_A.path);
      useTaskStore.getState().ensureTask(THREAD_B.id, PROJECT_A.path);
      useTaskStore.getState().setTaskStatus(THREAD_A.id, "running");
      useTaskStore.getState().setTaskStatus(THREAD_B.id, "completed");
    });

    expect(await screen.findByRole("button", { name: `${PROJECT_A.name}, 1 thread working` })).toBeInTheDocument();
    expect(screen.queryAllByText("1", { selector: ".workspace-thread-count" })).toHaveLength(1);
  });

  it("shows a successful push immediately, then explains uncommitted entries", async () => {
    const user = userEvent.setup();
    const pendingStatus = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command.join(" ") === "git push") {
        return { exitCode: 0, stdout: "", stderr: "Everything up-to-date\n" };
      }
      if (command.join(" ") === "git status --porcelain -uall") return pendingStatus.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Push commits" }));

    expect(await screen.findByText(/Everything up-to-date/)).toBeInTheDocument();
    expect(screen.queryByText(/uncommitted entr/)).not.toBeInTheDocument();

    await act(async () => {
      pendingStatus.resolve({ exitCode: 0, stdout: " M src/App.tsx\n?? src/new.ts\n", stderr: "" });
      await pendingStatus.promise;
    });
    expect(await screen.findByText(/2 uncommitted entries remain local/)).toBeInTheDocument();
  });

  it("stages and commits locally with either the default or an optional custom message", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command[1] === "commit") {
        return { exitCode: 0, stdout: `[main abc1234] ${command.at(-1)}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    const commitButton = await screen.findByRole("button", { name: "Commit all changes locally" });
    await user.click(commitButton);

    await waitFor(() => {
      expect(commands.slice(0, 2)).toEqual([
        ["git", "add", "--all"],
        ["git", "commit", "-m", "Update project files"],
      ]);
    });
    expect(await screen.findByText("Committed successfully")).toBeInTheDocument();
    expect(screen.getByText(/“Update project files” was saved/)).toBeInTheDocument();
    expect(screen.getByText("Changes committed locally")).toBeInTheDocument();

    const message = screen.getByLabelText(/Commit message/i);
    await user.type(message, "Polish the Git panel");
    await user.click(commitButton);
    await waitFor(() => {
      expect(commands.slice(-2)).toEqual([
        ["git", "add", "--all"],
        ["git", "commit", "-m", "Polish the Git panel"],
      ]);
    });
    expect(await screen.findByText(/“Polish the Git panel” was saved/)).toBeInTheDocument();
  });

  it("does not show a finished commit under a project selected while it was running", async () => {
    const user = userEvent.setup();
    const pendingCommit = deferred<{ exitCode: number; stdout: string; stderr: string }>();
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command[1] === "commit") return pendingCommit.promise;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.type(screen.getByLabelText(/Commit message/i), "Commit Alpha changes");
    await user.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
        method: "command/exec",
        params: expect.objectContaining({ command: ["git", "commit", "-m", "Commit Alpha changes"] }),
      }));
    });

    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");

    await act(async () => {
      pendingCommit.resolve({ exitCode: 0, stdout: "[main abc1234] Commit Alpha changes\n", stderr: "" });
      await pendingCommit.promise;
    });

    expect(screen.queryByText("Committed successfully")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes committed locally")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");
  });

  it("does not install a thread whose resume settles after switching workspaces", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    // Project Alpha is active by default; open its thread while the resume
    // RPC is still in flight.
    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/resume",
        ),
      ).toBe(true);
    });

    // Switch to project Beta before the resume resolves.
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    // The stale resume from Alpha settles late. It must not leak Alpha's
    // thread into Beta's workspace.
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.queryByText("work in alpha")).not.toBeInTheDocument();
  });

  it("does not reopen a preparing thread after the user starts a new one", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/resume",
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /^New thread/ }));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.queryByText("work in alpha")).not.toBeInTheDocument();
  });

  it("removes a stale sidebar row when its OpenAI rollout is definitively missing", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [THREAD_A.id]: THREAD_A }));
    threadReadImpl = (params) => {
      if (String(params.threadId) === THREAD_A.id) {
        throw new Error(`no rollout found for thread id ${THREAD_A.id}`);
      }
      return { thread: { ...THREAD_B, id: String(params.threadId), turns: [] } };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    expect(await screen.findByText(/removed its stale sidebar entry/i)).toBeInTheDocument();
    expect(screen.queryByText("Alpha thread")).not.toBeInTheDocument();
    const remembered = JSON.parse(localStorage.getItem("kiwi.knownThreads") ?? "{}") as Record<string, Thread>;
    expect(remembered).not.toHaveProperty(THREAD_A.id);
    const { useTaskStore } = await import("./lib/taskStore");
    expect(useTaskStore.getState().activeThreadId).toBeNull();
  });

  it("paints OpenAI history before live-runtime preparation finishes", async () => {
    const user = userEvent.setup();
    threadTurnsListImpl = () => ({
      data: [{
        id: "recent-turn",
        status: "completed",
        items: [{
          id: "recent-message",
          type: "userMessage",
          content: [{ type: "text", text: "visible before Windows runtime preparation" }],
        }],
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    expect(await screen.findByText("visible before Windows runtime preparation")).toBeInTheDocument();
    const methods = invokeMock.mock.calls
      .filter(([command]) => command === "codex_rpc")
      .map(([, args]) => args?.method);
    expect(methods.indexOf("thread/read")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("thread/read")).toBeLessThan(methods.indexOf("thread/resume"));

    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
      await pendingResume.promise;
    });
  });

  it("requests OpenAI metadata and recent history concurrently", async () => {
    const user = userEvent.setup();
    const metadata = deferred<{ thread: Thread }>();
    threadReadImpl = (params) => params.includeTurns
      ? { thread: { ...THREAD_A, id: String(params.threadId), turns: [] } }
      : metadata.promise;
    threadTurnsListImpl = () => ({
      data: [{
        id: "recent-turn",
        status: "completed",
        items: [{
          id: "recent-message",
          type: "userMessage",
          content: [{ type: "text", text: "parallel history" }],
        }],
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/turns/list",
      params: expect.objectContaining({ threadId: THREAD_A.id }),
    })));
    expect(screen.queryByText("parallel history")).not.toBeInTheDocument();

    await act(async () => {
      metadata.resolve({ thread: { ...THREAD_A, turns: [] } });
      await metadata.promise;
    });
    expect(await screen.findByText("parallel history")).toBeInTheDocument();
    // Settle the independent runtime-preparation work before test cleanup.
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
      await pendingResume.promise;
    });
  });

  it("falls back safely when paging is rejected before metadata resolves", async () => {
    const user = userEvent.setup();
    const metadata = deferred<{ thread: Thread }>();
    let metadataReadPending = true;
    threadReadImpl = (params) => {
      const thread = String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A;
      if (!params.includeTurns && metadataReadPending && thread.id === THREAD_A.id) {
        metadataReadPending = false;
        return metadata.promise;
      }
      return {
        thread: {
          ...thread,
          turns: params.includeTurns && thread.id === THREAD_A.id
            ? [{
                id: "fallback-turn",
                status: "completed",
                items: [{
                  id: "fallback-message",
                  type: "userMessage",
                  content: [{ type: "text", text: "history from compatibility fallback" }],
                }],
              }]
            : [],
        },
      };
    };
    threadTurnsListImpl = () => {
      throw new Error("unknown field `itemsView`");
    };
    resumeImpl = (params) => ({
      thread: { ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");
    const turnsListCalls = () => invokeMock.mock.calls.filter(([command, args]) => (
      command === "codex_rpc" && args?.method === "thread/turns/list"
    ));

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(turnsListCalls()).toHaveLength(1));
    expect(screen.queryByText("history from compatibility fallback")).not.toBeInTheDocument();

    await act(async () => {
      metadata.resolve({ thread: { ...THREAD_A, turns: [] } });
      await metadata.promise;
    });
    expect(await screen.findByText("history from compatibility fallback")).toBeInTheDocument();

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));
    expect(turnsListCalls()).toHaveLength(1);
  });

  it("opens a local-provider thread from a bounded page and recovers stale backward paging", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "claude-thread",
      name: "Paged Claude thread",
      preview: "newest local message",
      modelProvider: "claude",
    };
    let staleCursorOnce = true;
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read") {
        if (args?.cursor) {
          if (staleCursorOnce) {
            staleCursorOnce = false;
            throw new Error("Local transcript cursor is stale");
          }
          return {
            thread: claudeThread,
            messages: [{ id: "older-local", role: "user", text: "older local message", turnId: "older-turn", turnStatus: "completed", timelineOrder: 1 }],
            activities: [],
            nextCursor: null,
            headSeq: 2,
            tailSeq: 3,
            generation: 7,
            byteLen: 1_024,
          };
        }
        return {
          thread: claudeThread,
          messages: [{ id: "newest-local", role: "assistant", text: "newest local message", turnId: "newest-turn", turnStatus: "completed", timelineOrder: 2 }],
          activities: [],
          nextCursor: "7:1",
          headSeq: 2,
          tailSeq: 3,
          generation: 7,
          byteLen: 8_192,
        };
      }
      if (command === "local_transcript_write_state_read") {
        return { generation: 7, headSeq: 2, tailSeq: 3 };
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Paged Claude thread"));

    expect(await screen.findByText("newest local message")).toBeInTheDocument();
    expect(screen.queryByText("older local message")).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", {
      provider: "claude",
      threadId: claudeThread.id,
      cursor: null,
      byteBudget: 40 * 1024,
    });
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      paginated: true,
      hasMore: true,
      nextCursor: "7:1",
    });

    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));

    expect(await screen.findByText("older local message")).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      paginated: true,
      hasMore: false,
      nextCursor: null,
    });
    expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", {
      provider: "claude",
      threadId: claudeThread.id,
      cursor: "7:1",
      byteBudget: 40 * 1024,
    });
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    ))).toHaveLength(4);

    const readsAfterPaging = invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    )).length;
    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));
    await user.click(await screen.findByText("Paged Claude thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(claudeThread.id));
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    ))).toHaveLength(readsAfterPaging);
  });

  it("clears an older-page loading latch when the user leaves the thread", async () => {
    const user = userEvent.setup();
    const olderPage = deferred<unknown>();
    resumeImpl = () => ({ thread: { ...THREAD_A, turns: [] } });
    threadTurnsListImpl = (params) => params.cursor
      ? olderPage.promise
      : { data: [], nextCursor: "older-a", backwardsCursor: null };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("older-a"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(true));
    await user.click(screen.getByRole("button", { name: PROJECT_B.name }));

    await act(async () => {
      olderPage.resolve({ data: [], nextCursor: null, backwardsCursor: null });
      await olderPage.promise;
    });
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(false));
  });

  it("recovers a stale local cursor at the first page not already in memory", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "deep-claude-thread",
      name: "Deep Claude thread",
      modelProvider: "claude",
    };
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    const localPage = (id: string, text: string, nextCursor: string | null, generation: number) => ({
      thread: claudeThread,
      messages: [{ id, role: "assistant", text, turnId: id, turnStatus: "completed", timelineOrder: generation }],
      activities: [],
      nextCursor,
      headSeq: 3,
      tailSeq: 4,
      generation,
      byteLen: 1_024,
    });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) {
        if (args.cursor === null) {
          const recovering = invokeMock.mock.calls.some(([calledCommand, calledArgs]) => (
            calledCommand === "local_transcript_page_read" && calledArgs?.cursor === "7:1"
          ));
          return localPage("newest", "newest page", recovering ? "8:2" : "7:2", recovering ? 8 : 7);
        }
        if (args.cursor === "7:2") return localPage("middle", "middle page", "7:1", 7);
        if (args.cursor === "7:1") throw new Error("Local transcript cursor is stale");
        if (args.cursor === "8:2") return localPage("middle", "middle page", "8:1", 8);
        if (args.cursor === "8:1") return localPage("oldest", "genuinely older page", null, 8);
      }
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Deep Claude thread"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText("middle page")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));

    expect(await screen.findByText("genuinely older page")).toBeInTheDocument();
    expect(useTaskStore.getState().tasks[claudeThread.id]?.history).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
    expect(invokeMock.mock.calls.filter(([command, args]) => (
      command === "local_transcript_page_read" && args?.threadId === claudeThread.id
    )).map(([, args]) => args?.cursor)).toEqual([null, "7:2", "7:1", null, "8:2", "8:1"]);
  });

  it("keeps a local history cursor when live events arrive during first hydration", async () => {
    const user = userEvent.setup();
    const claudeThread: Thread = {
      ...THREAD_A,
      id: "hydration-race-claude",
      name: "Hydration race Claude thread",
      modelProvider: "claude",
    };
    const pendingPage = deferred<unknown>();
    localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [claudeThread.id]: claudeThread }));
    localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [claudeThread.id]: PROJECT_A.path }));
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "local_transcript_page_read" && args?.threadId === claudeThread.id) return pendingPage.promise;
      return stubInvoke(command, args);
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Hydration race Claude thread"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("local_transcript_page_read", expect.objectContaining({
      threadId: claudeThread.id,
    })));
    act(() => {
      useTaskStore.getState().appendUserMessage(claudeThread.id, { id: "live", role: "user", text: "arrived while loading" });
    });
    await act(async () => {
      pendingPage.resolve({
        thread: claudeThread,
        messages: [{ id: "disk", role: "assistant", text: "durable page", timelineOrder: 1 }],
        activities: [],
        nextCursor: "5:1",
        headSeq: 2,
        tailSeq: 3,
        generation: 5,
        byteLen: 1_024,
      });
      await pendingPage.promise;
    });

    expect(useTaskStore.getState().tasks[claudeThread.id]).toMatchObject({
      history: { paginated: true, hasMore: true, nextCursor: "5:1" },
      messages: [expect.objectContaining({ id: "live" })],
    });
    expect(await screen.findByRole("button", { name: "Load earlier messages" })).toBeInTheDocument();
  });

  it("rejects an older page whose cursor was replaced by a same-thread rehydrate", async () => {
    const user = userEvent.setup();
    const stalePage = deferred<unknown>();
    let initialPageCount = 0;
    resumeImpl = () => ({ thread: { ...THREAD_A, turns: [] } });
    threadTurnsListImpl = (params) => params.cursor
      ? stalePage.promise
      : {
          data: [],
          nextCursor: initialPageCount++ === 0 ? "cursor-before-refresh" : "cursor-after-refresh",
          backwardsCursor: null,
        };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    const threadRow = await screen.findByText("Alpha thread");
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("cursor-before-refresh"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.loading).toBe(true));
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.nextCursor).toBe("cursor-after-refresh"));

    await act(async () => {
      stalePage.resolve({
        data: [{
          id: "stale-old-turn",
          status: "completed",
          items: [{ id: "stale-old-message", type: "userMessage", content: [{ type: "text", text: "must not appear" }] }],
        }],
        nextCursor: "stale-next",
        backwardsCursor: null,
      });
      await stalePage.promise;
    });

    const task = useTaskStore.getState().tasks[THREAD_A.id];
    expect(task.history.nextCursor).toBe("cursor-after-refresh");
    expect(task.messages.some((message) => message.id === "stale-old-message")).toBe(false);
  });

  it("falls back for a malformed older page without disabling pagination globally", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({
      thread: { ...(params.threadId === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    threadTurnsListImpl = (params) => params.cursor
      ? {
          data: [{ id: "malformed-turn", status: "completed", items: null }],
          nextCursor: null,
          backwardsCursor: null,
        }
      : { data: [], nextCursor: `older-${String(params.threadId)}`, backwardsCursor: null };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.paginated).toBe(false));
    expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/read",
      params: { threadId: THREAD_A.id, includeTurns: true },
    }));

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_B.id]?.history).toMatchObject({
      paginated: true,
      nextCursor: `older-${THREAD_B.id}`,
    }));
  });

  it("falls back with a read instead of resuming twice when turn summaries are unsupported", async () => {
    const user = userEvent.setup();
    let resumeCalls = 0;
    resumeImpl = () => {
      resumeCalls += 1;
      return { thread: { ...THREAD_A, turns: [] } };
    };
    threadTurnsListImpl = () => {
      throw new Error("unknown field `itemsView`");
    };
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history.paginated).toBe(false));
    expect(resumeCalls).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("codex_rpc", expect.objectContaining({
      method: "thread/read",
      params: { threadId: THREAD_A.id, includeTurns: true },
    }));
  });

  it("does not disable pagination after an unrelated unsupported resume error", async () => {
    const user = userEvent.setup();
    let resumeCalls = 0;
    resumeImpl = () => {
      resumeCalls += 1;
      if (resumeCalls === 1) throw new Error("unsupported model selection");
      return { thread: { ...THREAD_A, turns: [] } };
    };
    threadTurnsListImpl = () => ({ data: [], nextCursor: "older-after-retry", backwardsCursor: null });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    const threadRow = await screen.findByText("Alpha thread");
    await user.click(threadRow);
    await screen.findByText("unsupported model selection");
    await user.click(threadRow);
    await waitFor(() => expect(useTaskStore.getState().tasks[THREAD_A.id]?.history).toMatchObject({
      paginated: true,
      nextCursor: "older-after-retry",
    }));
    expect(resumeCalls).toBe(2);
  });

  it("does not mark an idle thread as running/steering while another thread's start is in flight", async () => {
    const user = userEvent.setup();
    // Thread A's turn/start never resolves; any other thread starts normally.
    turnStartImpl = (params) =>
      params.threadId === THREAD_A.id
        ? new Promise(() => undefined)
        : { turn: { id: `turn-${String(params.threadId)}` } };
    resumeImpl = (params) => ({
      thread: { ...(params.threadId === THREAD_B.id ? THREAD_B : THREAD_A), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    // Prime both durable threads before one becomes busy. This mirrors a user
    // revisiting established conversations and keeps this test focused on
    // per-thread run state rather than the one-time capability migration.
    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id));

    // Open thread A and send — its turn/start stays in flight.
    await user.click(await screen.findByText("Alpha thread"));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "start something in alpha{Enter}");
    await waitFor(() => {
      expect(useTaskStore.getState().statuses[THREAD_A.id]).toBe("starting");
    });
    const checkpointCall = invokeMock.mock.calls.findIndex(
      ([command]) => command === "checkpoint_create",
    );
    const turnStartCall = invokeMock.mock.calls.findIndex(
      ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
    );
    expect(checkpointCall).toBeGreaterThanOrEqual(0);
    expect(turnStartCall).toBeGreaterThan(checkpointCall);
    expect(screen.getByText("Enter queues")).toBeInTheDocument();

    // Navigate to idle thread B while A's start is still pending.
    await user.click(screen.getByText("Beta thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id);
    });

    // B must not present as running or queueing just because A is starting.
    expect(screen.queryByText("Enter queues")).not.toBeInTheDocument();
    const idleComposer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    expect(idleComposer).not.toHaveAttribute("placeholder", "Queue a follow-up for after this run…");

    // A send from B must start a new turn for B — never steer.
    await user.type(idleComposer, "hello from beta{Enter}");
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "codex_rpc"
            && args?.method === "turn/start"
            && (args?.params as Record<string, unknown>)?.threadId === THREAD_B.id,
        ),
      ).toBe(true);
    });
    expect(
      invokeMock.mock.calls.some(([command, args]) => command === "codex_rpc" && args?.method === "turn/steer"),
    ).toBe(false);
    // Thread A is still starting, untouched by any of this.
    expect(useTaskStore.getState().statuses[THREAD_A.id]).toBe("starting");
  });

  it("keeps steering available while final output is arriving", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));

    act(() => {
      const store = useTaskStore.getState();
      store.setActiveTurn(THREAD_A.id, "turn-final");
      store.setTaskStatus(THREAD_A.id, "running");
      // Do not flush: the steering lock must beat the frame-batched text.
      store.queueAssistantDelta(THREAD_A.id, "answer", "Finishing the response");
    });

    expect(await screen.findByText("Enter queues")).toBeInTheDocument();

    const composer = screen.getByPlaceholderText(/Queue a follow-up for after this run/);
    await user.type(composer, "change direction now");
    expect(screen.getByRole("button", { name: "Steer" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => {
      expect(useTaskStore.getState().tasks[THREAD_A.id]?.messages).toContainEqual(
        expect.objectContaining({ text: "change direction now", steerStatus: "accepted", turnId: "turn-final" }),
      );
    });
    expect(invokeMock.mock.calls).toContainEqual(["codex_rpc", expect.objectContaining({
      method: "turn/steer",
      params: expect.objectContaining({ threadId: THREAD_A.id, expectedTurnId: "turn-final" }),
    })]);
    expect(await screen.findByText("Steer accepted by active turn")).toBeInTheDocument();
  });

  it("still opens the selected thread when no workspace switch happens", async () => {
    const user = userEvent.setup();
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });
  });

  it("completes performance diagnostics for an empty thread", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await act(async () => {
      pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } as Thread });
      await pendingResume.promise;
    });

    await waitFor(() => {
      expect(invokeMock.mock.calls).toContainEqual([
        "audit_append",
        expect.objectContaining({
          kind: "performance.threadOpen",
          payload: expect.objectContaining({
            outcome: "completed",
            render: expect.objectContaining({ rows: 0 }),
          }),
        }),
      ]);
    });
  });

  it("restores each thread's remembered reasoning level when switching conversations", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadReasoning", JSON.stringify({
      [THREAD_A.id]: { reasoningEffort: "low", ultra: false },
      [THREAD_B.id]: { reasoningEffort: "high", ultra: false },
    }));
    resumeImpl = (params) => ({
      thread: {
        ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A),
        id: String(params.threadId),
        turns: [],
      },
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("0"));

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("2"));

    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("kiwi.threadReasoning") ?? "{}")[THREAD_B.id])
        .toEqual({ reasoningEffort: "xhigh", ultra: false });
    });
    await user.click(screen.getByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("0"));
    await user.click(screen.getByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("3"));
  });

  it("explains that a reasoning change during a run applies to the next prompt", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({
      thread: { ...THREAD_A, id: String(params.threadId), turns: [] },
    });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    expect(screen.queryByText("Reasoning change will apply to the next prompt.")).not.toBeInTheDocument();

    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "running"));
    fireEvent.change(screen.getByRole("slider", { name: "Reasoning effort" }), { target: { value: "3" } });

    expect(await screen.findByText("Reasoning change will apply to the next prompt.")).toBeInTheDocument();

    act(() => useTaskStore.getState().setTaskStatus(THREAD_A.id, "idle"));
    await waitFor(() => {
      expect(screen.queryByText("Reasoning change will apply to the next prompt.")).not.toBeInTheDocument();
    });
  });

  it("recovers safely from malformed and legacy Ultra reasoning storage", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ reasoningEffort: "not-a-level", ultra: true }));
    localStorage.setItem("kiwi.threadReasoning", JSON.stringify({
      [THREAD_A.id]: null,
      [THREAD_B.id]: { reasoningEffort: "ultra", ultra: true },
      broken: { reasoningEffort: 42, ultra: true },
    }));
    resumeImpl = (params) => ({
      thread: {
        ...(String(params.threadId) === THREAD_B.id ? THREAD_B : THREAD_A),
        id: String(params.threadId),
        turns: [],
      },
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("1"));
    expect(screen.queryByRole("switch", { name: /Ultra/i })).not.toBeInTheDocument();

    await user.click(await screen.findByText("Beta thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("4"));
  });

  it("defaults safely when the entire saved reasoning map is null", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadReasoning", "null");
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveValue("1"));
  });

  it("creates an editable provider handoff draft without changing the source thread", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });
    act(() => {
      useTaskStore.getState().appendUserMessage(THREAD_A.id, {
        id: "handoff-goal",
        role: "user",
        text: "Preserve the current API and finish the queue UI.",
      });
    });

    await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/);
    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toContain("Continue “Alpha thread”");
    });
    expect((composer as HTMLTextAreaElement).value).toContain("Preserve the current API and finish the queue UI.");
    expect(screen.getByText(/review the visible context below/)).toBeInTheDocument();
    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/^Hand off the current thread to Claude\?/));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining("Alpha thread"));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining("Preserve the current API"));
    expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toMatchObject({
      sourceThreadId: THREAD_A.id,
      targetProvider: "claude",
      workspacePath: PROJECT_A.path,
    });

    // Abandoning the handoff must clear its persisted new-thread draft so it
    // cannot reappear later without the target-provider/provenance state.
    await user.click(screen.getByText("Alpha thread"));
    await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id));
    await user.click(screen.getByRole("button", { name: /New thread/ }));
    expect(await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/)).toHaveValue("");
    expect(JSON.parse(localStorage.getItem("kiwi.pendingHandoff") ?? "null")).toBeNull();
  });

  it("restores an unfinished provider handoff with its destination after restart", async () => {
    localStorage.setItem("kiwi.pendingHandoff", JSON.stringify({
      sourceThreadId: THREAD_A.id,
      sourceTitle: "Alpha thread",
      sourceProvider: "openai",
      sourceModel: "gpt-5.6-sol",
      workspacePath: PROJECT_A.path,
      targetProvider: "claude",
      createdAt: 1,
    }));
    localStorage.setItem("kiwi.drafts", JSON.stringify({
      [`new:${PROJECT_A.path}`]: "Continue the restored handoff.",
    }));

    await renderApp();

    expect(await screen.findByText("Provider handoff ready")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "New thread provider: Claude" })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText(/Ask Mythra Code to work in Alpha/)).toHaveValue("Continue the restored handoff.");
  });

  it("refuses a provider handoff while the source thread owns an isolated worktree", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/alpha",
        branch: "kiwi/alpha",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: 1,
        status: "active",
      },
    }));
    await renderApp();
    const { useTaskStore } = await import("./lib/taskStore");

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
    });

    await user.click(screen.getByRole("button", { name: "Thread provider: OpenAI" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Hand off to Claude/ }));

    // The handed-off copy would run in the shared project folder, so the
    // isolated conversation must be resolved before it can be handed off.
    expect(await screen.findByText(/owns an isolated worktree/)).toBeInTheDocument();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(useTaskStore.getState().activeThreadId).toBe(THREAD_A.id);
  });

  it("starts an isolated thread in its worktree while keeping it grouped under the project", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByRole("button", { name: /Isolated worktree/i }));
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "build this in isolation{Enter}");

    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "codex_rpc"
            && args?.method === "thread/start"
            && (args?.params as Record<string, unknown>)?.cwd === "/managed/worktrees/isolated-thread",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) =>
            command === "checkpoint_create"
            && args?.cwd === "/managed/worktrees/isolated-thread",
        ),
      ).toBe(true);
    });
    const storedBindings = JSON.parse(localStorage.getItem("kiwi.threadProjects") ?? "{}") as Record<string, string>;
    expect(Object.values(storedBindings)).toContain(PROJECT_A.path);
    const storedWorktrees = JSON.parse(localStorage.getItem("kiwi.threadWorktrees") ?? "{}") as Record<string, { path: string; projectPath: string }>;
    expect(Object.values(storedWorktrees)).toContainEqual(expect.objectContaining({
      path: "/managed/worktrees/isolated-thread",
      projectPath: PROJECT_A.path,
    }));
  });

  it("resumes an isolated thread with its execution cwd and shared Git metadata root", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/thread-a",
        branch: "openkiwi/thread-a",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: Date.now(),
        status: "active",
      },
    }));
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => {
            if (command !== "codex_rpc" || args?.method !== "thread/resume") return false;
            const params = args.params as Record<string, unknown>;
            const roots = params.runtimeWorkspaceRoots as string[] | undefined;
            return params.cwd === "/managed/worktrees/thread-a"
              && roots?.includes("/projects/alpha/.git");
          },
        ),
      ).toBe(true);
    });
  });

  it("loads a missing isolated transcript read-only and blocks model sends", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.threadWorktrees", JSON.stringify({
      [THREAD_A.id]: {
        threadId: THREAD_A.id,
        projectId: PROJECT_A.id,
        projectPath: PROJECT_A.path,
        path: "/managed/worktrees/missing-thread-a",
        branch: "openkiwi/thread-a",
        baseCommit: "head",
        gitDir: "/projects/alpha/.git",
        createdAt: Date.now(),
        status: "missing",
      },
    }));
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(
          ([command, args]) => command === "codex_rpc" && args?.method === "thread/read",
        ),
      ).toBe(true);
    });
    const turnsBefore = invokeMock.mock.calls.filter(
      ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
    ).length;
    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "do not run this{Enter}");
    expect(
      invokeMock.mock.calls.filter(
        ([command, args]) => command === "codex_rpc" && args?.method === "turn/start",
      ),
    ).toHaveLength(turnsBefore);
    expect(await screen.findByText(/isolated worktree is unavailable/i)).toBeInTheDocument();
  });
});

describe("composer sub-agent command center", () => {
  async function openCrew(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ }));
    return screen.getByRole("dialog", { name: "Sub-agent command center" });
  }

  /** Params of every app-server call made with one JSON-RPC method. */
  function codexCalls(method: string): Record<string, unknown>[] {
    return invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && args?.method === method)
      .map(([, args]) => (args?.params ?? {}) as Record<string, unknown>);
  }

  /** The sub-agent policy a project actually persisted for its own threads. */
  function projectSubagents(projectId: string): unknown {
    const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{
      id: string;
      overrides?: { subagents?: unknown };
    }>;
    return stored.find((project) => project.id === projectId)?.overrides?.subagents;
  }

  it("writes a project's edits into that project's own sub-agent override", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: PROJECT_A.name }));

    await openCrew(user);
    expect(screen.getByText(`Editing ${PROJECT_A.name}`)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{
        id: string;
        overrides?: { subagents?: { enabled: boolean; maxConcurrent: number } };
      }>;
      expect(stored.find((project) => project.id === PROJECT_A.id)?.overrides?.subagents)
        .toMatchObject({ enabled: true, maxConcurrent: 1 });
      // The sibling project keeps inheriting the global defaults.
      expect(stored.find((project) => project.id === PROJECT_B.id)?.overrides).toBeUndefined();
    });
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").subagentsEnabled ?? false).toBe(false);
    expect(await screen.findByText("project")).toBeInTheDocument();
  });

  it("writes edits made in Chats to the global defaults", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: /Chats/ }));

    await openCrew(user);
    expect(screen.getByText("Editing Chats & project defaults")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.click(screen.getByRole("button", { name: "More concurrent sub-agents" }));
    await user.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
      expect(stored.subagentsEnabled).toBe(true);
      expect(stored.subagentMax).toBe(1);
      expect(stored.childAgents).toMatchObject({
        enabled: true,
        targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
      });
    });
    const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ overrides?: unknown }>;
    expect(stored.every((project) => project.overrides === undefined)).toBe(true);
  });

  it("lets a conversation already in progress configure sub-agents for its next turn", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: false, subagentMax: 5 }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));

    const control = await screen.findByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ });
    expect(control).toBeEnabled();
    await openCrew(user);

    // Nothing was frozen because this thread has never run with a
    // cross-provider roster available.
    expect(screen.queryByText(/froze its destinations/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.click(screen.getByRole("button", { name: "Add Claude sub-agent" }));

    // This thread lives in a project, so the edit lands on that project's own
    // sub-agent policy — the one its next turn will read.
    await waitFor(() => {
      expect(projectSubagents(PROJECT_A.id)).toMatchObject({
        enabled: true,
        childAgents: {
          enabled: true,
          targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
        },
      });
    });
  });

  it("stages idle captured-crew edits on the thread without rewriting defaults", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: true,
      subagentMax: 5,
      childAgents: { enabled: true, targets: [{ id: "cursor", provider: "cursor", model: "auto", label: "Cursor", description: "", enabled: true }] },
    }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-a": {
        rootThreadId: THREAD_A.id,
        maxConcurrent: 2,
        permission: "ask",
        systemPrompt: "",
        projectInstructionsEnabled: false,
        reasoningEffort: "medium",
        serviceTier: null,
        targets: [{ id: "frozen", provider: "claude", model: "claude-fable-5", label: "Frozen reviewer", description: "", enabled: true }],
        capturedAt: 1,
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    const crew = await openCrew(user);

    expect(screen.getByText("Editing this thread")).toBeInTheDocument();
    expect(screen.getByText(/Sub-agent and limit changes stay in this thread/)).toBeInTheDocument();
    expect(within(crew).getByText("Frozen reviewer")).toBeInTheDocument();
    // The destination configured since is not one this thread may reach.
    expect(within(crew).queryByText("Cursor")).not.toBeInTheDocument();
    await user.click(within(crew).getByRole("button", { name: "Add OpenAI sub-agent" }));

    await waitFor(() => {
      const policies = JSON.parse(localStorage.getItem("kiwi.childAgentPolicies") ?? "{}");
      expect(policies["session-a"].pendingRecapture).toMatchObject({
        targets: [
          expect.objectContaining({ id: "frozen", provider: "claude" }),
          expect.objectContaining({ id: "openai", provider: "openai" }),
        ],
      });
    });
    // This edit belongs to THREAD_A only. New chats and other project threads
    // continue to inherit the defaults they had before the click.
    const storedSettings = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
    expect(storedSettings.subagentMax).toBe(5);
    expect(storedSettings.childAgents.targets).toEqual([expect.objectContaining({ id: "cursor" })]);
    expect(projectSubagents(PROJECT_A.id)).toBeUndefined();
  });

  it("clears an idle captured crew without rewriting defaults", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: true,
      subagentMax: 5,
      childAgents: { enabled: true, targets: [{ id: "cursor", provider: "cursor", model: "auto", label: "Cursor", description: "", enabled: true }] },
    }));
    localStorage.setItem("kiwi.childAgentPolicies", JSON.stringify({
      "session-a": {
        rootThreadId: THREAD_A.id,
        maxConcurrent: 2,
        permission: "ask",
        systemPrompt: "",
        projectInstructionsEnabled: false,
        reasoningEffort: "medium",
        serviceTier: null,
        targets: [{ id: "frozen", provider: "claude", model: "claude-fable-5", label: "Frozen reviewer", description: "", enabled: true }],
        capturedAt: 1,
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    const crew = await openCrew(user);

    expect(screen.getByText("Editing this thread")).toBeInTheDocument();
    expect(screen.getByText(/Sub-agent and limit changes stay in this thread/)).toBeInTheDocument();
    expect(within(crew).getByText("Frozen reviewer")).toBeInTheDocument();
    // The destination configured since is not one this thread may reach.
    expect(within(crew).queryByText("Cursor")).not.toBeInTheDocument();
    await user.click(within(crew).getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(within(crew).queryByText("Frozen reviewer")).not.toBeInTheDocument());

    await waitFor(() => {
      const policies = JSON.parse(localStorage.getItem("kiwi.childAgentPolicies") ?? "{}");
      expect(policies["session-a"].pendingRecapture).toMatchObject({
        targets: [],
      });
    });
    // This edit belongs to THREAD_A only. New chats and other project threads
    // continue to inherit the defaults they had before the click.
    const storedSettings = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
    expect(storedSettings.subagentMax).toBe(5);
    expect(storedSettings.childAgents.targets).toEqual([expect.objectContaining({ id: "cursor" })]);
    expect(projectSubagents(PROJECT_A.id)).toBeUndefined();
  });

  /**
   * The whole point of the fix, end to end: a conversation that has already
   * been running gets sub-agents switched on, and its very next message runs
   * with them — through a runtime that had the thread loaded without them.
   */
  it("gives a running conversation the sub-agents it just switched on, on its next message", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({
      subagentsEnabled: false,
      subagentMax: 5,
      childAgents: {
        enabled: true,
        targets: [{ id: "managed-openai", provider: "openai", model: "gpt-5.6-terra", label: "Managed OpenAI", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "medium", reasoningMaxEffort: "high" }],
      },
    }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));

    // Opening the thread loaded it into this app-server with sub-agents off.
    await waitFor(() => {
      expect(codexCalls("thread/resume").at(-1)).toMatchObject({
        threadId: THREAD_A.id,
        config: { features: { multi_agent: false } },
      });
    });
    const restartsAfterOpen = invokeMock.mock.calls.filter(([command]) => command === "restart_runtime").length;

    await openCrew(user);
    await user.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(projectSubagents(PROJECT_A.id)).toMatchObject({ enabled: true }));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "now split this up{Enter}");

    await waitFor(() => {
      expect(codexCalls("turn/start").at(-1)).toMatchObject({ threadId: THREAD_A.id });
    });
    // Startup-only config is ignored for a thread the app-server already holds,
    // so the switch is only real if the runtime was replaced first.
    expect(invokeMock.mock.calls.filter(([command]) => command === "restart_runtime")).toHaveLength(restartsAfterOpen + 1);
    expect(codexCalls("thread/resume").at(-1)).toMatchObject({
      threadId: THREAD_A.id,
      config: {
        features: { multi_agent: false, multi_agent_v2: false },
        // The user's limit of five rides on the Mythra Code bridge below, never on
        // Codex's own agent runtime, which stays pinned so the bridge remains
        // the only spawning authority.
        agents: { max_threads: 1, max_depth: 1 },
        mcp_servers: { mythra_agents: expect.anything() },
      },
    });
  });

  it("does not disturb the runtime for an ordinary follow-up message", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: true, subagentMax: 5 }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));
    await waitFor(() => expect(codexCalls("thread/resume")).not.toHaveLength(0));
    expect(codexCalls("thread/resume")[0]).toMatchObject({ excludeTurns: true });
    expect(codexCalls("thread/resume")[0]).not.toHaveProperty("initialTurnsPage");
    expect(codexCalls("thread/turns/list")[0]).toMatchObject({
      threadId: THREAD_A.id,
      limit: 10,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const restartsAfterOpen = invokeMock.mock.calls.filter(([command]) => command === "restart_runtime").length;

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "carry on{Enter}");

    await waitFor(() => {
      expect(codexCalls("turn/start").at(-1)).toMatchObject({ threadId: THREAD_A.id });
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === "restart_runtime")).toHaveLength(restartsAfterOpen);
    expect(codexCalls("thread/resume")).toHaveLength(1);
  });
});

describe("workspace attachments", () => {
  function codexCalls(method: string): Record<string, unknown>[] {
    return invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && args?.method === method)
      .map(([, args]) => (args?.params ?? {}) as Record<string, unknown>);
  }

  /** The sidebar row, not the header title that repeats the open thread. */
  function threadRow(name: string): HTMLElement {
    const rows = screen.getAllByText(name).filter((node) => node.closest(".thread-row-wrap"));
    return rows[0] ?? screen.getByText(name);
  }

  it("keeps attachment selections inside the thread they were made for", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Files workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "notes.md" }));
    await user.click(await screen.findByRole("button", { name: "Attach notes.md" }));
    expect(await screen.findByRole("button", { name: "Remove attachment notes.md" })).toBeInTheDocument();

    // Switching conversations must not carry the file into the other thread.
    await user.click(threadRow("Beta thread"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove attachment notes.md" })).not.toBeInTheDocument());

    // Returning to the original thread finds the file still chosen for it.
    await user.click(threadRow("Alpha thread"));
    expect(await screen.findByRole("button", { name: "Remove attachment notes.md" })).toBeInTheDocument();
  });

  it("sends a Files-tab image as a native image input", async () => {
    const user = userEvent.setup();
    const persisted = deferred<string>();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "persist_image_attachment") return persisted.promise;
      return stubInvoke(command, args);
    });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Files workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "diagram.PNG" }));
    await user.click(await screen.findByRole("button", { name: "Attach diagram.PNG" }));

    const composer = await screen.findByPlaceholderText(/Ask Mythra Code to work in/);
    await user.type(composer, "look at this{Enter}");
    expect(codexCalls("turn/start")).toHaveLength(0);

    await act(async () => {
      persisted.resolve("/app-data/message-images/durable/diagram.PNG");
      await persisted.promise;
    });

    await waitFor(() => expect(codexCalls("turn/start")).not.toHaveLength(0));
    const started = codexCalls("turn/start").at(-1) as { input?: Array<Record<string, unknown>> };
    // The Files surface classifies extensions exactly like the picker, so the
    // screenshot arrives as an image rather than as a bare path.
    expect(started.input).toContainEqual(expect.objectContaining({
      type: "localImage",
      path: "/app-data/message-images/durable/diagram.PNG",
    }));
  });
});

describe("workspace review diff", () => {
  const STAGED_DIFF = [
    'diff --git "a/src/caf\\303\\251 note.ts" "b/src/caf\\303\\251 note.ts"',
    '--- "a/src/caf\\303\\251 note.ts"',
    '+++ "b/src/caf\\303\\251 note.ts"',
    "@@ -0,0 +1 @@",
    "+staged change",
  ].join("\n");

  it("does not surface a post-run spawn error when Git is unavailable on Windows", async () => {
    const user = userEvent.setup();
    workspaceGitInfoImpl = () => ({
      isRepo: false,
      isRoot: false,
      hasCommit: false,
      branch: null,
      head: null,
      error: null,
    });
    gitDiffToRemoteImpl = () => { throw new Error("failed to spawn command: program not found"); };
    commandExecImpl = () => { throw new Error("failed to spawn command: program not found"); };
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("workspace_git_info", { cwd: PROJECT_A.path }));
    const attemptedDiffCommands = invokeMock.mock.calls
      .filter(([command, args]) => command === "codex_rpc" && ["gitDiffToRemote", "command/exec"].includes(String(args?.method)))
      .map(([, args]) => args?.method);
    expect(attemptedDiffCommands).toEqual([]);
    expect(screen.queryByText(/failed to spawn command|program not found/i)).not.toBeInTheDocument();
  });

  it("falls back to staged and unstaged changes and names untracked files", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => { throw new Error("gitDiffToRemote is not available"); };
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      if (command.join(" ") === "git diff --no-ext-diff HEAD --") {
        return { exitCode: 0, stdout: STAGED_DIFF, stderr: "" };
      }
      if (command.join(" ") === "git ls-files --others --exclude-standard") {
        return { exitCode: 0, stdout: "src/brand new.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    // `git diff` alone would have hidden the staged change entirely.
    await waitFor(() => expect(commands).toContainEqual(["git", "diff", "--no-ext-diff", "HEAD", "--"]));
    expect(await screen.findByText("Repository changes")).toBeInTheDocument();
    expect(screen.getByText("1 file changed · against HEAD")).toBeInTheDocument();
    // A quoted non-ASCII path is decoded, so its per-file actions are real.
    expect(screen.getByText("src/café note.ts")).toBeInTheDocument();
    // Untracked files cannot appear in a diff, so they are named rather than
    // silently implied not to exist.
    expect(screen.getByText(/src\/brand new\.ts/)).toBeInTheDocument();
  });

  it("includes staged files when a repository has no first commit yet", async () => {
    const user = userEvent.setup();
    const commands: string[][] = [];
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    gitDiffToRemoteImpl = () => { throw new Error("gitDiffToRemote is not available"); };
    commandExecImpl = (params) => {
      const command = params.command as string[];
      commands.push(command);
      const joined = command.join(" ");
      if (joined === "git diff --no-ext-diff HEAD --") {
        return { exitCode: 128, stdout: "", stderr: "fatal: bad revision 'HEAD'" };
      }
      if (joined === "git diff --no-ext-diff --cached --") {
        return { exitCode: 0, stdout: STAGED_DIFF, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Review workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(commands).toContainEqual(["git", "diff", "--no-ext-diff", "--cached", "--"]));
    expect(screen.getByText("1 file changed · against the empty repository")).toBeInTheDocument();
    expect(screen.getByText("src/café note.ts")).toBeInTheDocument();
  });

  it("keeps the Git console's own diff out of the Review panel", async () => {
    const user = userEvent.setup();
    resumeImpl = (params) => ({ thread: { ...THREAD_A, id: String(params.threadId), turns: [] } });
    commandExecImpl = (params) => {
      const command = params.command as string[];
      if (command.join(" ") === "git diff --stat --patch") {
        return { exitCode: 0, stdout: "diff --git a/console.ts b/console.ts\n+++ b/console.ts\n+console only", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await renderApp();

    await user.click(await screen.findByText("Alpha thread"));
    await user.click(screen.getByRole("button", { name: "Open workspace tools" }));
    await user.click(await screen.findByRole("tab", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Diff" }));
    await waitFor(() => expect(screen.getByText(/console only/)).toBeInTheDocument());

    await user.click(screen.getByRole("tab", { name: "Review workspace tool" }));
    expect(await screen.findByText("No changes loaded · against the tracked remote branch")).toBeInTheDocument();
    expect(screen.queryByText("console.ts")).not.toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "./types";

/**
 * Integration harness for App-level lifecycle regressions. Mocks the Tauri
 * bridge and drives the real sidebar/selection flows.
 */

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
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
let turnStartImpl: (params: Record<string, unknown>) => unknown;
let commandExecImpl: (params: Record<string, unknown>) => unknown;
let workspaceGitInfoImpl: () => unknown;
let workspaceGitInitializeImpl: () => unknown;

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  if (command === "codex_runtime_status") {
    return {
      available: true,
      source: "Codex CLI",
      path: "/usr/local/bin/codex",
      version: "99.0.0",
      compatible: true,
      warning: null,
    };
  }
  if (command === "claude_runtime_status") {
    return {
      available: false,
      path: null,
      version: null,
      loggedIn: false,
      authMethod: null,
      email: null,
      subscriptionType: null,
      warning: null,
    };
  }
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
        ignoredFiles: [],
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
      ignoredFiles: [],
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
  if (command === "has_openrouter_key") return false;
  if (command === "codex_rpc") {
    const method = args?.method as string;
    const params = (args?.params ?? {}) as Record<string, unknown>;
    if (method === "thread/list") {
      return {
        data: params.cwd === PROJECT_A.path ? [THREAD_A, THREAD_B] : [],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
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
    if (method === "thread/read") {
      return { thread: { ...THREAD_A, id: String(params.threadId), turns: [] } };
    }
    if (method === "thread/resume") return resumeImpl(params);
    if (method === "turn/start") return turnStartImpl(params);
    if (method === "account/read") {
      return { account: { type: "chatgpt", email: "test@example.com", planType: "pro" } };
    }
    if (method === "model/list") return { data: [] };
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
  pendingResume = deferred<{ thread: Thread }>();
  resumeImpl = () => pendingResume.promise;
  turnStartImpl = (params) => ({ turn: { id: `turn-${String(params.threadId)}` } });
  commandExecImpl = () => ({ exitCode: 0, stdout: "", stderr: "" });
  workspaceGitInfoImpl = () => ({ isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "head" });
  workspaceGitInitializeImpl = () => ({
    info: { isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "new-head" },
    initialized: true,
    createdCommit: true,
    trackedFiles: 2,
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    stubInvoke(command, args),
  );
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
});

describe("workspace switching during thread selection", () => {
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

  it("resizes and persists the Projects/Threads divider", async () => {
    await renderApp();
    const separator = screen.getByRole("separator", { name: "Resize projects and threads" });
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      top: 100,
      height: 600,
    } as DOMRect);

    fireEvent.pointerDown(separator, { clientY: 280 });
    fireEvent.pointerMove(window, { clientY: 500 });
    fireEvent.pointerUp(window);

    expect(separator).toHaveAttribute("aria-valuenow", "67");
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
    await user.click(await screen.findByRole("button", { name: "Git workspace tool" }));
    await user.click(await screen.findByRole("button", { name: "Push commits" }));

    expect(await screen.findByText(/Everything up-to-date/)).toBeInTheDocument();
    expect(screen.queryByText(/uncommitted entr/)).not.toBeInTheDocument();

    await act(async () => {
      pendingStatus.resolve({ exitCode: 0, stdout: " M src/App.tsx\n?? src/new.ts\n", stderr: "" });
      await pendingStatus.promise;
    });
    expect(await screen.findByText(/2 uncommitted entries remain local/)).toBeInTheDocument();
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

    // Open thread A and send — its turn/start stays in flight.
    await user.click(await screen.findByText("Alpha thread"));
    const composer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in/);
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
    const idleComposer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in/);
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

    const composer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in Alpha/);
    await waitFor(() => {
      expect((composer as HTMLTextAreaElement).value).toContain("Continue “Alpha thread”");
    });
    expect((composer as HTMLTextAreaElement).value).toContain("Preserve the current API and finish the queue UI.");
    expect(screen.getByText(/review the visible context below/)).toBeInTheDocument();
    expect(useTaskStore.getState().activeThreadId).toBeNull();
    expect(screen.getByText("Alpha thread")).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("from OpenAI to Claude"));
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
    expect(await screen.findByPlaceholderText(/Ask OpenKiwi to work in Alpha/)).toHaveValue("");
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
    expect(await screen.findByPlaceholderText(/Ask OpenKiwi to work in Alpha/)).toHaveValue("Continue the restored handoff.");
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
    const composer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in/);
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
    const composer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in/);
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
    await user.click(await screen.findByRole("button", { name: /Agents/ }));
    return screen.getByRole("dialog", { name: "Sub-agent command center" });
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
        .toMatchObject({ enabled: true, maxConcurrent: 3 });
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
    await user.click(screen.getByRole("button", { name: "Add Claude destination" }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}");
      expect(stored.subagentsEnabled).toBe(true);
      expect(stored.subagentMax).toBe(4);
      expect(stored.childAgents).toMatchObject({
        enabled: true,
        targets: [expect.objectContaining({ id: "claude", provider: "claude" })],
      });
    });
    const stored = JSON.parse(localStorage.getItem("kiwi.projects") ?? "[]") as Array<{ overrides?: unknown }>;
    expect(stored.every((project) => project.overrides === undefined)).toBe(true);
  });

  it("keeps the control usable on a started thread but locks its policy", async () => {
    const user = userEvent.setup();
    localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: true, subagentMax: 5 }));
    await renderApp();
    pendingResume.resolve({ thread: { ...THREAD_A, turns: [] } });
    await user.click(await screen.findByText("Alpha thread"));

    const control = await screen.findByRole("button", { name: /Agents/ });
    expect(control).toBeEnabled();
    await openCrew(user);

    expect(screen.getByText("Locked for this thread")).toBeInTheDocument();
    expect(screen.getByText(/froze its sub-agent powers when it started/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More concurrent sub-agents" })).not.toBeInTheDocument();
    expect(screen.getByText("This thread captured no cross-provider destinations.")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kiwi.settings") ?? "{}").subagentMax).toBe(5);
  });
});

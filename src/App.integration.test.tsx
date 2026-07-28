import { act, render, screen, waitFor } from "@testing-library/react";
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
  if (command === "state_read") return null;
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
  pendingResume = deferred<{ thread: Thread }>();
  resumeImpl = () => pendingResume.promise;
  turnStartImpl = (params) => ({ turn: { id: `turn-${String(params.threadId)}` } });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    stubInvoke(command, args),
  );
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT_A, PROJECT_B]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
});

describe("workspace switching during thread selection", () => {
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
    expect(screen.getByText("Steering active task")).toBeInTheDocument();

    // Navigate to idle thread B while A's start is still pending.
    await user.click(screen.getByText("Beta thread"));
    await waitFor(() => {
      expect(useTaskStore.getState().activeThreadId).toBe(THREAD_B.id);
    });

    // B must not present as running or steering just because A is starting.
    expect(screen.queryByText("Steering active task")).not.toBeInTheDocument();
    const idleComposer = await screen.findByPlaceholderText(/Ask OpenKiwi to work in/);
    expect(idleComposer).not.toHaveAttribute("placeholder", "Add direction to the running task…");

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
});

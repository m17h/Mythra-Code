import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { resetTaskStore, useTaskStore } from "./lib/taskStore";
import { resetChildAgentLaunches } from "./lib/childAgentSessions";
import { preferenceLearningFixture } from "./test/preferenceLearningFixture";
import type { AppSettings } from "./types";
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
let commandFinish: ((result: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
const WORKTREE = "/projects/start-fixture/.worktrees/first-thread";

// Real App and browser rendering; native commands are isolated fixtures. These
// cases exercise first-turn bridge registration, terminal event routing, queues,
// and persisted Settings together without provider inference or native processes.
const PROJECT = { id: "start-project", name: "Start fixture", path: "/projects/start-fixture", overrides: { run: { command: "printf fixture", label: "Fixture", updatedAt: 1 } } };
const OTHER = { id: "other-project", name: "Other fixture", path: "/projects/other-fixture" };
type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];
let releaseBridge: (() => void) | undefined;
let bridge: Promise<unknown> | undefined;
let appInstance = 0;
const learned = preferenceLearningFixture();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => Promise.resolve(stubInvoke(command, args)), isTauri: () => false, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", async (original) => ({ ...(await original<object>()), listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
  const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set);
  return () => { set.delete(listener); };
}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.0-test") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(async () => false), requestPermission: vi.fn(async () => "denied"), sendNotification: vi.fn() }));
vi.mock("./components/XtermPanel", () => ({ XtermPanel: () => null }));

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  calls.push({ command, args });
  switch (command) {
    case "preference_learning_list":
    case "preference_learning_forget":
    case "preference_learning_save": return learned.invoke(command, args);
    case "codex_runtime_status":
    case "codex_runtime_status_refresh": return { available: true, source: "Codex CLI", path: "/fixture/codex", runningPath: "/fixture/codex", dataHome: "/fixture/codex-home", version: "99.0.0", runningVersion: "99.0.0", runningCommands: 0, runtimeChanged: false, compatible: true, warning: null };
    case "claude_runtime_status": return { available: true, path: "/fixture/claude", version: "9.9.9", loggedIn: true, authMethod: "subscription", email: "fixture@example.com", subscriptionType: "max", warning: null };
    case "cursor_runtime_status": return null;
    case "normal_chat_workspace": return "/chats";
    case "runtime_instance": return "start-runtime";
    case "runtime_thread_state": return { instance: "start-runtime", loaded: false };
    case "local_skills_scan":
    case "local_transcript_list":
    case "audit_recent":
    case "github_pr_list":
    case "cursor_models": return [];
    case "local_skills_sync": return "/fixture/skills";
    case "persist_image_attachment":
    case "save_pasted_image": return "/fixture/image.png";
    case "claude_models": return { models: [] };
    case "list_lmstudio_models": return { models: [] };
    case "claude_turn_start": {
      return { turnId: "fixture-claude-turn" };
    }
    case "local_transcript_snapshot_write":
    case "local_transcript_tail_write":
    case "local_transcript_metadata_write": return { generation: 1, headSeq: 1, tailSeq: 2 };
    case "checkpoint_create": return { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) };
    case "has_openrouter_key": return false;
    case "github_status": return { available: false, authenticated: false };
    case "github_repo_status": return { isRepo: false };
    case "workspace_git_info": return { isRepo: true, isRoot: true, hasCommit: true };
    case "worktree_create": return { path: WORKTREE, branch: "fixture-only", baseCommit: "a".repeat(40), gitDir: "/fixture/git" };
    case "git_project_diff": return { text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
    case "git_project_changes": return { rootPath: PROJECT.path, rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    case "git_project_history": return { entries: [], hasMore: false, nextOffset: 0, headOid: "a".repeat(40), truncated: false };
    case "child_agent_session_start": return bridge;
    case "codex_rpc": {
      switch (args?.method) {
        case "account/read": return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
        case "account/rateLimits/read": return { rateLimits: {} };
        case "model/list": return { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", displayName: "Fixture Sol", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: true }] };
        case "thread/list": return { data: [], nextCursor: null };
        case "thread/start": return { thread: { id: `started-codex-${calls.filter((call) => call.command === "codex_rpc" && call.args?.method === "thread/start").length}`, name: null, preview: "", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai", turns: [] } };
        case "command/exec": return new Promise((resolve) => { commandFinish = resolve; });
        case "turn/start": {
          return { turn: { id: "fixture-codex-turn", status: "inProgress", items: [] } };
        }
        case "fs/readDirectory": return { entries: [] };
        case "fuzzyFileSearch": return { files: [] };
        case "gitDiffToRemote": return { diff: "" };
        default: return {};
      }
    }
    default: return null;
  }
}

function dispatches() { return calls.filter(({ command, args }) => command === "claude_turn_start" || (command === "codex_rpc" && args?.method === "turn/start")); }
function composer() { return screen.getByPlaceholderText(/^(?:Ask Mythra Code to work in|Queue a follow-up for after this run)/); }
function expectSelectedPending(text: string, provider: "openai" | "claude") {
  const row = screen.getByRole("button", { name: `Open ${text}` });
  expect(row).toBeVisible();
  expect(row).toHaveClass(`provider-${provider}`);
  expect(row.closest(".thread-row-wrap")).toHaveClass("active");
  expect(row.querySelector(".thread-card-status")).toHaveTextContent("Starting");
  expect(document.querySelector(".topbar .thread-title")).toHaveTextContent(text);
  expect(document.querySelector(".topbar .thread-title")).toBeVisible();
  expect(screen.getByRole("article", { name: "Your pending prompt" })).toHaveTextContent(text);
  expect(screen.getByRole("article", { name: "Your pending prompt" })).toBeVisible();
}
async function send(text: string) {
  await userEvent.type(composer(), text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(calls.some(({ command }) => command === "child_agent_session_start")).toBe(true));
}
async function renderApp(provider: "openai" | "claude", settings: Partial<AppSettings> = {}, initialize = true) {
  if (initialize) {
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT, OTHER]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
  localStorage.setItem("kiwi.onboardingVersion", "99");
  localStorage.setItem("kiwi.settings", JSON.stringify({ provider, model: provider === "claude" ? "claude-opus-5" : "gpt-6-sol", theme: "mythra", subagentsEnabled: false, ...settings }));
  }
  const { default: App } = await import(/* @vite-ignore */ `./App.tsx?start-case=${++appInstance}`) as typeof import("./App");
  const mount = document.createElement("div"); mount.id = "root"; document.body.append(mount);
  const view = render(<App />, { container: mount });
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
  return view;
}

beforeEach(async () => {
  localStorage.clear(); listeners.clear(); commandFinish = undefined; resetTaskStore(); resetChildAgentLaunches(); learned.reset(); calls = [];
  const { resetDraftStoreForTests } = await import("./components/Composer"); resetDraftStoreForTests();
  bridge = new Promise((resolve) => {
    releaseBridge = () => resolve({ name: "fixture_tools", command: "/fixture/bridge", args: [], configPath: "/fixture/bridge.json", toolNames: ["set_project_run_command", "set_project_check_command", "read_project_terminal"] });
  });
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => {
  releaseBridge?.(); bridge = undefined; resetTaskStore(); resetChildAgentLaunches(); localStorage.clear();
  await commands.setStreamTestReducedMotion(false);
});


async function emit(name: string, payload: unknown) {
  await act(async () => { for (const listener of listeners.get(name) ?? []) listener({ payload }); });
}
function commandCalls() { return calls.filter(({ command, args }) => command === "codex_rpc" && args?.method === "command/exec"); }
function startOptions() { return calls.find(({ command }) => command === "child_agent_session_start")!.args!.options as Record<string, unknown>; }
async function readTerminal(id: string, scope: string) {
  await emit("child-agent-request", { requestId: id, sessionId: startOptions().sessionId, tool: "read_project_terminal", terminalScope: scope, arguments: { maxCharacters: 200 } });
  await waitFor(() => expect(calls.some(({ command, args }) => command === "child_agent_respond" && args?.requestId === id)).toBe(true));
  return calls.find(({ command, args }) => command === "child_agent_respond" && args?.requestId === id)!.args!;
}

it.each([
  ["openai", false, false], ["claude", false, false],
  ["openai", true, false], ["claude", true, true],
] as const)("reads terminal on the first %s turn with native delegation %s and isolation %s after navigating away", async (provider, native, isolated) => {
  await renderApp(provider, { subagentsEnabled: native, subagentEngine: native ? "native" : "mythra", terminalTimeoutMinutes: 11 });
  if (native) {
    await userEvent.click(screen.getByRole("button", { name: "Sub-agents off" }));
    await userEvent.click(screen.getByRole("radio", { name: /Native/ }));
    await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    await userEvent.click(screen.getByRole("button", { name: /^Close.*sub-agent/i }));
  }
  if (isolated) await userEvent.click(await screen.findByRole("button", { name: /Isolated worktree/ }));
  const text = "First prompt can inspect its own retained terminal";
  await send(text);
  expectSelectedPending(text, provider);
  const scope = isolated ? WORKTREE : PROJECT.path;
  expect(startOptions()).toMatchObject({ projectPath: scope, provider, ...(native ? { nativeDelegation: true } : {}) });
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  const firstThread = useTaskStore.getState().activeThreadId!;
  expect(firstThread).toBeTruthy();
  await userEvent.type(composer(), "Queued follow-up while terminal output is read");
  await userEvent.click(screen.getByRole("button", { name: "Queue" }));
  await userEvent.type(composer(), "Scheduled follow-up while terminal output is read");
  await userEvent.click(screen.getByRole("button", { name: "Schedule this prompt" }));
  await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(useTaskStore.getState().tasks[firstThread].queuedTurns).toHaveLength(2));
  expect(dispatches()).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Run: ready" }));
  await waitFor(() => expect(commandCalls()).toHaveLength(1));
  const launched = commandCalls()[0].args!.params as Record<string, unknown>;
  expect(launched).toMatchObject({ cwd: scope, timeoutMs: 11 * 60_000 });
  await emit("codex-event", { method: "command/exec/outputDelta", params: { processId: launched.processId, deltaBase64: btoa("\u001b[32mfirst-turn ready\u001b[0m\n") } });
  if (isolated) {
    await openRuntimeSettings();
    await userEvent.click(screen.getByRole("switch", { name: "Automatically stop terminal commands" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(JSON.parse(localStorage.getItem("kiwi.settings")!).terminalTimeoutMinutes).toBe(0);
    expect(launched).toMatchObject({ timeoutMs: 11 * 60_000 });
  }
  await userEvent.click(screen.getAllByRole("button", { name: "Close workspace tools" })[0]);
  await userEvent.click(screen.getByRole("button", { name: "Other fixture" }));
  await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBeNull());
  const before = useTaskStore.getState().tasks[firstThread];
  const response = await readTerminal("first-read", scope);
  expect(response.error).toBeNull();
  expect(response.result).toMatchObject({ scope, running: true, command: "printf fixture", text: "$ printf fixture\nfirst-turn ready\n", lifetime: "app-session" });
  expect(document.querySelector(".studio-dock")).toHaveClass("closed");
  expect(useTaskStore.getState().tasks[firstThread]).toBe(before);
  expect(commandCalls()).toHaveLength(1);
  const foreign = await readTerminal("foreign-read", OTHER.path);
  expect(foreign.result).toBeNull();
  expect(foreign.error).toMatch(/captured execution folder/);
  await act(async () => { commandFinish!({ exitCode: 0, stdout: "", stderr: "" }); });
  expect((await readTerminal("completed-read", scope)).result).toMatchObject({ running: false, text: expect.stringContaining("[exit 0]") });
});

async function openRuntimeSettings() {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(screen.getByRole("button", { name: "Runtime" }));
}

it("persists timeout through actual App Save and remount and applies edits only to subsequent terminal commands", async () => {
  const view = await renderApp("openai", { terminalTimeoutMinutes: 13 });
  await userEvent.click(screen.getByRole("button", { name: "Run: ready" }));
  await waitFor(() => expect(commandCalls()).toHaveLength(1));
  await openRuntimeSettings();
  await userEvent.clear(screen.getByRole("spinbutton", { name: "Timeout minutes" }));
  await userEvent.type(screen.getByRole("spinbutton", { name: "Timeout minutes" }), "31");
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).terminalTimeoutMinutes).toBe(31);
  expect(commandCalls()[0].args!.params).toMatchObject({ timeoutMs: 13 * 60_000 });
  await act(async () => { commandFinish!({ exitCode: 0, stdout: "", stderr: "" }); });
  await openRuntimeSettings();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(31);
  await userEvent.click(screen.getByRole("switch", { name: "Automatically stop terminal commands" }));
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).terminalTimeoutMinutes).toBe(0);
  view.unmount();
  resetTaskStore(); resetChildAgentLaunches();
  await renderApp("openai", {}, false);
  await openRuntimeSettings();
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).not.toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Run: ready" }));
  await waitFor(() => expect(commandCalls()).toHaveLength(2));
  expect(commandCalls()[1].args!.params).toMatchObject({ disableTimeout: true });
  expect(commandCalls()[1].args!.params).not.toHaveProperty("timeoutMs");
  await act(async () => { commandFinish!({ exitCode: 0, stdout: "", stderr: "" }); });
});

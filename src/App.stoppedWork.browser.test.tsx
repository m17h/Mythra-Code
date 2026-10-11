import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { resetTaskStore, useTaskStore } from "./lib/taskStore";
import { resetChildAgentLaunches } from "./lib/childAgentSessions";
import { resetDraftStoreForTests } from "./components/Composer";
import { preferenceLearningFixture } from "./test/preferenceLearningFixture";
import type { Activity, AppSettings } from "./types";

// Exercise the shipped App, Stop button, native browser dialog, navigation and
// persisted settings. Native/provider commands are synthetic fixtures; no paid
// inference, native processes or personal profiles are used.
const PROJECT = { id: "stop-project", name: "Stopped work fixture", path: "/projects/stop-fixture" };
const OTHER = { id: "other-project", name: "Other fixture", path: "/projects/other-fixture" };
const PROMPT = "Inspect changes before I stop the work";
const UPDATE = "I found a partial implementation worth retaining.";
const PARTIAL = "An unfinished answer must stay in work history.";
type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];
let instance = 0;
const learned = preferenceLearningFixture();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: Record<string, unknown>) => Promise.resolve(stubInvoke(command, args)), isTauri: () => false, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", async (original) => ({ ...(await original<object>()), listen: vi.fn(async () => () => {}) }));
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
    case "runtime_instance": return "stop-runtime";
    case "runtime_thread_state": return { instance: "stop-runtime", loaded: false };
    case "local_skills_scan":
    case "local_transcript_list":
    case "audit_recent":
    case "github_pr_list":
    case "cursor_models": return [];
    case "local_skills_sync": return "/fixture/skills";
    case "claude_models": return { models: [] };
    case "list_lmstudio_models": return { models: [] };
    case "local_transcript_snapshot_write":
    case "local_transcript_tail_write":
    case "local_transcript_metadata_write": return { generation: 1, headSeq: 1, tailSeq: 2 };
    case "checkpoint_create": return { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) };
    case "checkpoint_complete": return { snapshot: { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3 }, changedFiles: 0, additions: 0, deletions: 0 };
    case "has_openrouter_key": return false;
    case "github_status": return { available: false, authenticated: false };
    case "github_repo_status":
    case "workspace_git_info": return { isRepo: false };
    case "git_project_diff": return { text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
    case "git_project_changes": return { rootPath: PROJECT.path, rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    case "git_project_history": return { entries: [], hasMore: false, nextOffset: 0, headOid: "a".repeat(40), truncated: false };
    case "child_agent_session_start": return { name: "fixture_tools", command: "/fixture/bridge", args: [], configPath: "/fixture/bridge.json", toolNames: ["set_project_run_command", "set_project_check_command"] };
    case "codex_rpc": {
      switch (args?.method) {
        case "account/read": return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
        case "account/rateLimits/read": return { rateLimits: {} };
        case "model/list": return { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", displayName: "Fixture Sol", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: true }] };
        case "thread/list": return { data: [], nextCursor: null };
        case "thread/start": return { thread: { id: "stop-thread", name: null, preview: "", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai", turns: [] } };
        case "turn/start": return { turn: { id: `stop-turn-${calls.filter((call) => call.command === "codex_rpc" && call.args?.method === "turn/start").length}`, status: "inProgress", items: [] } };
        case "fs/readDirectory": return { entries: [] };
        case "fuzzyFileSearch": return { files: [] };
        case "gitDiffToRemote": return { diff: "" };
        default: return {};
      }
    }
    default: return null;
  }
}

const interrupts = () => calls.filter((call) => call.command === "codex_rpc" && call.args?.method === "turn/interrupt");
const composer = () => screen.getByPlaceholderText(/^(?:Ask Mythra Code to work in|Queue a follow-up for after this run)/);
async function renderApp(settings: Partial<AppSettings> = {}, initialize = true) {
  if (initialize) {
    localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT, OTHER]));
    localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
    localStorage.setItem("kiwi.onboardingVersion", "99");
    localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openai", model: "gpt-6-sol", theme: "mythra", subagentsEnabled: false, ...settings }));
  }
  const { default: App } = await import(/* @vite-ignore */ `./App.tsx?stopped-case=${++instance}`) as typeof import("./App");
  const mount = document.createElement("div"); mount.id = "root"; document.body.append(mount);
  render(<App />, { container: mount });
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
}
async function send(text: string) {
  await userEvent.type(composer(), text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(useTaskStore.getState().tasks["stop-thread"]?.activeTurnId).toBeTruthy());
}
async function seedRunningHistory() {
  const turnId = useTaskStore.getState().tasks["stop-thread"].activeTurnId!;
  const activities: Activity[] = [
    { id: "reason", kind: "reasoning", title: "Thinking", detail: "Retained analysis before cancellation", status: "completed" },
    { id: "command", kind: "command", title: "git diff --stat", detail: "src/example.ts | 4 ++--", status: "completed" },
    { id: "file", kind: "file", title: "src/example.ts", detail: "A failed file operation remains available", status: "failed" },
    { id: "native", kind: "agent", title: "Native review", status: "completed", agent: { action: "spawn", provider: "openai", task: "Native review task", model: "gpt-6-sol", threadIds: ["native-worker"] } },
    { id: "managed", kind: "agent", title: "Managed review", status: "completed", agent: { action: "spawn", provider: "claude", task: "Managed review task", model: "claude-opus-5", threadIds: ["managed-worker"] } },
    { id: "warning", kind: "warning", title: "Check the remaining edit before publishing", status: "completed" },
    { id: "compaction", kind: "compaction", title: "Context compacted", status: "completed" },
  ];
  await act(async () => {
    const store = useTaskStore.getState();
    store.setTaskStatus("stop-thread", "running");
    store.completeMessage("stop-thread", { id: "update", role: "assistant", text: UPDATE, phase: "commentary", turnId });
    for (const activity of activities) store.upsertActivity("stop-thread", { ...activity, turnId });
    store.startAssistantMessage("stop-thread", { id: "partial", role: "assistant", text: PARTIAL, phase: "final", streaming: true, turnId });
  });
  await screen.findByRole("button", { name: /View activity/ });
  return turnId;
}
function assertStoppedChat() {
  const timeline = document.querySelector(".flow-timeline")!;
  expect(timeline).toHaveTextContent(PROMPT);
  expect(timeline).not.toHaveTextContent(UPDATE);
  expect(timeline).not.toHaveTextContent(PARTIAL);
  expect(timeline.querySelectorAll(".activity-status")).toHaveLength(1);
  const button = screen.getByRole("button", { name: /^Work Stopped\. View activity/ });
  expect(button).toBeVisible();
  expect(button.querySelector(".activity-status-mark svg")).toHaveClass("lucide-x");
  const [red, green, blue] = getComputedStyle(button.querySelector(".activity-status-mark")!).color.match(/[\d.]+/g)!.map(Number);
  expect(red).toBeGreaterThan(green);
  expect(red).toBeGreaterThan(blue);
  return button;
}
async function assertHistory() {
  await userEvent.click(assertStoppedChat());
  const dialog = await screen.findByRole("dialog", { name: "Activity" });
  expect(dialog).toBeInstanceOf(HTMLDialogElement);
  expect((dialog as HTMLDialogElement).open).toBe(true);
  for (const text of [PROMPT, UPDATE, PARTIAL, "Retained analysis before cancellation", "git diff --stat", "src/example.ts", "Native review task", "Managed review task", "Check the remaining edit before publishing", "Context compacted"]) {
    await waitFor(() => expect(dialog).toHaveTextContent(text));
  }
  await userEvent.click(within(dialog).getByRole("button", { name: "Show output: git diff --stat" }));
  expect(within(dialog).getByText("src/example.ts | 4 ++--")).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Show details: src/example.ts" }));
  expect(within(dialog).getByText("A failed file operation remains available")).toBeVisible();
  return dialog;
}
async function capture(name: string) {
  const stamp = document.createElement("div");
  stamp.textContent = "Development App UI · Synthetic history · No provider calls";
  Object.assign(stamp.style, { position: "fixed", top: "8px", right: "12px", zIndex: "2147483647", padding: "5px 9px", background: "#252a30", color: "#fff", border: "1px solid #708095", borderRadius: "6px", font: "11px system-ui" });
  document.body.append(stamp);
  const engine = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  try { await page.screenshot({ path: `../test-results/stopped-work-${name}-${engine}.png` }); }
  finally { stamp.remove(); }
}

beforeEach(async () => { localStorage.clear(); resetTaskStore(); resetChildAgentLaunches(); resetDraftStoreForTests(); learned.reset(); calls = []; await commands.setStreamTestReducedMotion(true); });
afterEach(async () => { cleanup(); resetTaskStore(); resetChildAgentLaunches(); resetDraftStoreForTests(); localStorage.clear(); await commands.setStreamTestReducedMotion(false); });

it("collapses a user-stopped App run and preserves the full history through reopening and the next completed turn", async () => {
  await renderApp();
  await send(PROMPT);
  const turnId = await seedRunningHistory();
  await userEvent.click(screen.getByRole("button", { name: "Stop the active task and its sub-agents" }));
  await waitFor(() => expect(useTaskStore.getState().statuses["stop-thread"]).toBe("interrupted"));
  expect(interrupts()).toHaveLength(1);
  expect(interrupts()[0].args?.params).toEqual({ threadId: "stop-thread", turnId });
  await waitFor(assertStoppedChat);
  await capture("collapsed");
  const dialog = await assertHistory();
  await capture("history");
  await userEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
  await userEvent.click(screen.getByRole("button", { name: "Other fixture" }));
  await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: PROJECT.name }));
  await userEvent.click(await screen.findByRole("button", { name: `Open ${PROMPT}` }));
  await assertHistory();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
  await send("Complete the next independent task");
  const nextTurnId = useTaskStore.getState().tasks["stop-thread"].activeTurnId!;
  expect(nextTurnId).not.toBe(turnId);
  await act(async () => {
    useTaskStore.getState().completeMessage("stop-thread", { id: "next-answer", role: "assistant", text: "The next task completed normally.", phase: "final", turnId: nextTurnId });
    useTaskStore.getState().completeTurn("stop-thread", nextTurnId, "completed");
  });
  await screen.findByText("The next task completed normally.");
  expect(screen.getAllByRole("button", { name: /^Work Stopped\. View activity/ })).toHaveLength(1);
  expect(document.querySelector(".flow-timeline")).not.toHaveTextContent(PARTIAL);
  const earlier = await assertHistory();
  expect(earlier).not.toHaveTextContent("The next task completed normally.");
});

it("persists disabled Escape in actual App settings, still dismisses history, and keeps the Stop button working", async () => {
  await renderApp();
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(screen.getByRole("button", { name: "Interface" }));
  const toggle = screen.getByRole("switch", { name: "Escape stops the active run" });
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).escapeStopsRun).toBe(false);
  cleanup();
  await renderApp({}, false);
  await send(PROMPT);
  await seedRunningHistory();
  // Focus a neutral App control: global Escape intentionally ignores text input.
  screen.getByRole("button", { name: "Open workspace tools" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(interrupts()).toHaveLength(0);
  expect(useTaskStore.getState().statuses["stop-thread"]).toBe("running");
  await userEvent.click(screen.getByRole("button", { name: /View activity/ }));
  const history = await screen.findByRole("dialog", { name: "Activity" });
  expect(history).toHaveTextContent(UPDATE);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
  expect(interrupts()).toHaveLength(0);
  expect(useTaskStore.getState().statuses["stop-thread"]).toBe("running");
  await userEvent.click(screen.getByRole("button", { name: "Stop the active task and its sub-agents" }));
  await waitFor(() => expect(useTaskStore.getState().statuses["stop-thread"]).toBe("interrupted"));
  await waitFor(assertStoppedChat);
  expect(interrupts()).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(screen.getByRole("button", { name: "Interface" }));
  expect(screen.getByRole("switch", { name: "Escape stops the active run" })).not.toBeChecked();
});

it("stops the active App run from a neutral control with Escape enabled by default", async () => {
  await renderApp();
  await send(PROMPT);
  await seedRunningHistory();
  screen.getByRole("button", { name: "Open workspace tools" }).focus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(useTaskStore.getState().statuses["stop-thread"]).toBe("interrupted"));
  await waitFor(assertStoppedChat);
  expect(interrupts()).toHaveLength(1);
});

it("keeps a live approval actionable outside work history and retains earlier questions after Stop", async () => {
  await renderApp();
  await send(PROMPT);
  const turnId = await seedRunningHistory();
  const question = "Which part should be inspected next?";
  await act(async () => {
    useTaskStore.getState().completeMessage("stop-thread", { id: "retained-question", role: "assistant", text: "Choose the next inspection", questions: [{ id: "direction", title: question, options: ["Frontend", "Backend"] }], turnId });
  });
  await screen.findByText(question);
  await userEvent.click(screen.getByRole("button", { name: /View activity/ }));
  await screen.findByRole("dialog", { name: "Activity" });
  await act(async () => {
    useTaskStore.getState().enqueueApproval({ id: "pending-command", threadId: "stop-thread", receivedAt: Date.now(), method: "item/commandExecution/requestApproval", params: { command: "printf inspect-approval", cwd: PROJECT.path, turnId } });
  });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Activity" })).toBeNull());
  const approval = document.querySelector(".timeline-entry-approval")!;
  await waitFor(() => expect(approval).toBeVisible());
  expect(approval).toHaveTextContent("printf inspect-approval");
  expect(within(approval as HTMLElement).getAllByRole("button").length).toBeGreaterThan(0);
  // Resolve the fixture request before a deliberate user Stop. Stopping the
  // owning provider run may retire its runtime approvals, but never erase the
  // archived question or warnings from the retained transcript.
  await act(async () => { useTaskStore.getState().resolveApproval("stop-thread", "pending-command"); });
  await userEvent.click(screen.getByRole("button", { name: "Stop the active task and its sub-agents" }));
  await waitFor(assertStoppedChat);
  const dialog = await assertHistory();
  expect(dialog).toHaveTextContent(question);
  expect(dialog).toHaveTextContent("Frontend");
  expect(dialog).toHaveTextContent("Backend");
  expect(within(dialog).queryByRole("button", { name: "Answer in chat" })).toBeNull();
});

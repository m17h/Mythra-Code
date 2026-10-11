import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { resetTaskStore, useTaskStore } from "./lib/taskStore";
import { resetChildAgentLaunches } from "./lib/childAgentSessions";
import { preferenceLearningFixture } from "./test/preferenceLearningFixture";
import type { ComponentProps } from "react";

// Real App and browser rendering; native commands are isolated fixtures. These
// cases verify send feedback and ownership, never provider speed or completion.
const PROJECT = { id: "start-project", name: "Start fixture", path: "/projects/start-fixture" };
const OTHER = { id: "other-project", name: "Other fixture", path: "/projects/other-fixture" };
type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];
let releaseBridge: (() => void) | undefined;
let rejectBridge: ((error: Error) => void) | undefined;
let bridge: Promise<unknown> | undefined;
let checkpoint: Promise<unknown> | undefined;
let releaseCheckpoint: (() => void) | undefined;
let startFailure = false;
let imageCopy: Promise<string> | undefined;
let releaseImageCopy: (() => void) | undefined;
let appInstance = 0;
let completeBeforeStartReturns = false;
let timelineGate: Promise<void> | undefined;
let releaseTimelineGate: (() => void) | undefined;
let historyPage: Promise<unknown> | undefined;
let releaseHistoryPage: (() => void) | undefined;
let historySnapshotThread: Record<string, unknown> | undefined;
const learned = preferenceLearningFixture();

// Hold the real conversation's Suspense boundary independently of module-cache
// warmth, so early completion cannot accidentally make this case pass.
vi.mock("./components/ChatTimeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/ChatTimeline")>();
  return { ...actual, ChatTimeline: function DelayedTimeline(props: ComponentProps<typeof actual.ChatTimeline>) {
    if (timelineGate) throw timelineGate;
    return <actual.ChatTimeline {...props} />;
  } };
});

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
    case "runtime_instance": return "start-runtime";
    case "runtime_thread_state": return { instance: "start-runtime", loaded: false };
    case "local_skills_scan":
    case "local_transcript_list":
    case "audit_recent":
    case "github_pr_list":
    case "cursor_models": return [];
    case "local_skills_sync": return "/fixture/skills";
    case "persist_image_attachment":
    case "save_pasted_image": return imageCopy ?? "/fixture/image.png";
    case "claude_models": return { models: [] };
    case "list_lmstudio_models": return { models: [] };
    case "claude_turn_start": {
      if (completeBeforeStartReturns) useTaskStore.getState().completeTurn((args!.options as { threadId: string }).threadId, "fixture-claude-turn", "completed");
      return startFailure ? Promise.reject(new Error("Fixture runtime start failed")) : { turnId: "fixture-claude-turn" };
    }
    case "local_transcript_snapshot_write":
    case "local_transcript_tail_write":
    case "local_transcript_metadata_write": return { generation: 1, headSeq: 1, tailSeq: 2 };
    case "checkpoint_create": return checkpoint ?? { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) };
    case "has_openrouter_key": return false;
    case "github_status": return { available: false, authenticated: false };
    case "github_repo_status": return { isRepo: false };
    case "workspace_git_info": return { isRepo: false, isRoot: false, hasCommit: false };
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
        case "thread/read":
        case "thread/resume": return historySnapshotThread ? { thread: historySnapshotThread } : {};
        case "thread/turns/list": return historyPage ?? {};
        case "thread/start": return { thread: { id: `started-codex-${calls.filter((call) => call.command === "codex_rpc" && call.args?.method === "thread/start").length}`, name: null, preview: "", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai", turns: [] } };
        case "turn/start": {
          if (completeBeforeStartReturns) useTaskStore.getState().completeTurn((args!.params as { threadId: string }).threadId, "fixture-codex-turn", "completed");
          return startFailure ? Promise.reject(new Error("Fixture runtime start failed")) : { turn: { id: "fixture-codex-turn", status: "inProgress", items: [] } };
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
async function capturePending(provider: string) {
  const stamp = document.createElement("div");
  stamp.textContent = "Development UI · Fixture commands · No provider calls";
  Object.assign(stamp.style, { position: "fixed", right: "16px", top: "52px", zIndex: "2147483647", padding: "5px 9px", background: "#252a30", color: "#fff", border: "1px solid #708095", borderRadius: "6px", font: "11px system-ui" });
  document.body.append(stamp);
  const engine = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  try { await page.screenshot({ path: `../test-results/new-thread-pending-${provider}-${engine}.png` }); }
  finally { stamp.remove(); }
}
function composer() { return screen.getByPlaceholderText(/^(?:Ask Mythra Code to work in|Queue a follow-up for after this run|Add a message \(optional\))/); }
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
async function renderApp(provider: "openai" | "claude") {
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT, OTHER]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
  localStorage.setItem("kiwi.onboardingVersion", "99");
  localStorage.setItem("kiwi.settings", JSON.stringify({ provider, model: provider === "claude" ? "claude-opus-5" : "gpt-6-sol", theme: "mythra", subagentsEnabled: false }));
  const { default: App } = await import(/* @vite-ignore */ `./App.tsx?start-case=${++appInstance}`) as typeof import("./App");
  const mount = document.createElement("div"); mount.id = "root"; document.body.append(mount);
  const view = render(<App />, { container: mount });
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
  return view;
}

beforeEach(async () => {
  localStorage.clear(); resetTaskStore(); resetChildAgentLaunches(); learned.reset(); calls = []; checkpoint = undefined; releaseCheckpoint = undefined; startFailure = false; imageCopy = undefined; releaseImageCopy = undefined;
  completeBeforeStartReturns = false; timelineGate = undefined; releaseTimelineGate = undefined;
  historyPage = undefined; releaseHistoryPage = undefined; historySnapshotThread = undefined;
  const { resetDraftStoreForTests } = await import("./components/Composer"); resetDraftStoreForTests();
  bridge = new Promise((resolve, reject) => {
    releaseBridge = () => resolve({ name: "fixture_tools", command: "/fixture/bridge", args: [], configPath: "/fixture/bridge.json", toolNames: ["set_project_run_command", "set_project_check_command"] });
    rejectBridge = reject;
  });
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => {
  releaseBridge?.(); releaseCheckpoint?.(); releaseImageCopy?.(); releaseTimelineGate?.(); releaseHistoryPage?.(); timelineGate = undefined; bridge = undefined; resetTaskStore(); resetChildAgentLaunches(); localStorage.clear();
  await commands.setStreamTestReducedMotion(false);
});

it.each(["openai", "claude"] as const)("keeps an accepted %s prompt visible when the turn completes before startup returns and the timeline is cold", async (provider) => {
  completeBeforeStartReturns = true;
  timelineGate = new Promise<void>((resolve) => { releaseTimelineGate = () => { timelineGate = undefined; resolve(); }; });
  await renderApp(provider);
  const text = `Accepted completed ${provider} prompt during a cold timeline`;
  await send(text);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => {
    const state = useTaskStore.getState();
    expect(state.activeThreadId).not.toBeNull();
    expect(state.tasks[state.activeThreadId!]?.lastCompletedTurnId).toBe(provider === "claude" ? "fixture-claude-turn" : "fixture-codex-turn");
    expect(state.statuses[state.activeThreadId!]).toBe("completed");
  });
  await waitFor(() => expect(screen.queryByText("Starting…")).toBeNull());
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
  expect(document.querySelector("article.message.user")).toBeVisible();
  await act(async () => { releaseTimelineGate!(); });
  await waitFor(() => expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull());
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
});

it.each(["openai", "claude"] as const)("shows a pending %s first prompt during delayed preparation and sends it exactly once", async (provider) => {
  await renderApp(provider);
  const text = `Visible ${provider} prompt waiting for preparation`;
  await send(text);
  expectSelectedPending(text, provider);
  expect(screen.getByRole("button", { name: /^Stop/ })).toBeVisible();
  expect(dispatches()).toHaveLength(0);
  expect(calls.some(({ command, args }) => command === "codex_rpc" && args?.method === "thread/start")).toBe(false);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
  await capturePending(provider);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  // Dispatch can settle before the real timeline chunk loads. The user's
  // prompt must remain visible at that exact transition, including fallback.
  expect(document.querySelectorAll("article.message.user")).toHaveLength(1);
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
  expect(document.querySelector("article.message.user")).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull());
  expect(document.querySelectorAll("article.message.user")).toHaveLength(1);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages).filter((message) => message.text === text)).toHaveLength(1);
});

it.each(["openai", "claude"] as const)("leaves a new %s draft selected when the earlier pending thread finishes preparing", async (provider) => {
  await renderApp(provider);
  const text = `Background ${provider} first prompt after New`;
  await send(text);
  expectSelectedPending(text, provider);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  const nextDraft = `Independent ${provider} next draft`;
  await userEvent.type(composer(), nextDraft);
  expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull();
  expect(screen.getByRole("button", { name: `Open ${text}` }).closest(".thread-row-wrap")).not.toHaveClass("active");
  expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  expect(useTaskStore.getState().activeThreadId).toBeNull();
  expect(composer()).toHaveValue(nextDraft);
  expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull();
  expect(document.querySelector(".thread-row-wrap.active")).toBeNull();
  expect(document.querySelector(".topbar .thread-title")).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: `Open ${text}` }));
  await waitFor(() => expect(document.querySelector("article.message.user")).toHaveTextContent(text));
});

it.each(["openai", "claude"] as const)("can reselect a preparing %s thread without losing the newer unsent draft", async (provider) => {
  await renderApp(provider);
  const text = `Reselect pending ${provider} startup`;
  await send(text);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  const newer = `Retain the newer unsent ${provider} draft after reselection`;
  await userEvent.type(composer(), newer);
  await userEvent.click(screen.getByRole("button", { name: `Open ${text}` }));
  expectSelectedPending(text, provider);
  expect(screen.getByRole("button", { name: /^Stop/ })).toBeVisible();
  expect(Object.values(useTaskStore.getState().tasks)).toHaveLength(0);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull());
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
  expect(screen.getByRole("button", { name: `Open ${text}` }).closest(".thread-row-wrap")).toHaveClass("active");
  expect(useTaskStore.getState().activeThreadId).not.toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  if ((composer() as HTMLTextAreaElement).value !== newer) {
    await userEvent.click(await screen.findByRole("button", { name: `Open saved draft: ${newer}` }));
  }
  await waitFor(() => expect(composer()).toHaveValue(newer));
  expect(useTaskStore.getState().activeThreadId).toBeNull();
  expect(dispatches()).toHaveLength(1);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages).filter((message) => message.text === newer)).toHaveLength(0);
});

it.each(["openai", "claude"] as const)("stops only the selected %s pending attempt when two first sends are preparing", async (provider) => {
  // Accept the real shared-folder concurrency warning for this isolated
  // workspace, so both fixture-owned preparations can exist together.
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
  await renderApp(provider);
  const first = `Stop the reselected first ${provider} attempt`;
  const second = `Continue the second ${provider} attempt`;
  await send(first);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  await send(second);
  expect(confirmation).toHaveBeenCalledWith(expect.stringContaining("Another thread is already working"));
  expectSelectedPending(second, provider);
  expect(screen.getByRole("button", { name: `Open ${first}` }).closest(".thread-row-wrap")).not.toHaveClass("active");
  // Reselect the older attempt: cancelling the last-started preparation would
  // stop the wrong thread here even though a simple one-attempt Stop passes.
  await userEvent.click(screen.getByRole("button", { name: `Open ${first}` }));
  expectSelectedPending(first, provider);
  await userEvent.click(screen.getByRole("button", { name: /^Stop/ }));
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => expect(composer()).toHaveValue(first));
  const messages = Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages);
  expect(messages.filter((message) => message.text === first)).toHaveLength(0);
  expect(messages.filter((message) => message.text === second)).toHaveLength(1);
  expect(screen.queryByRole("button", { name: `Open ${first}` })).toBeNull();
  expect(document.querySelector(".thread-row-wrap.active")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: `Open ${second}` }));
  await waitFor(() => expect(document.querySelector("article.message.user")).toHaveTextContent(second));
});

it.each(["openai", "claude"] as const)("delivers the acknowledged %s image prompt once in the background after New selects a fresh draft", async (provider) => {
  imageCopy = new Promise((resolve) => { releaseImageCopy = () => resolve("/fixture/image.png"); });
  await renderApp(provider);
  const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { items: [{ type: file.type, getAsFile: () => file }] } });
  fireEvent(composer(), paste);
  await waitFor(() => expect(calls.some(({ command }) => command === "save_pasted_image")).toBe(true));
  const original = `Original ${provider} draft waiting on image`;
  await userEvent.type(composer(), original);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expectSelectedPending(original, provider);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  const nextDraft = `Only this ${provider} next draft`;
  await userEvent.type(composer(), nextDraft);
  await act(async () => { releaseImageCopy!(); });
  await waitFor(() => expect(calls.some(({ command }) => command === "child_agent_session_start")).toBe(true));
  expect(screen.getByRole("button", { name: `Open ${original}` })).toBeVisible();
  expect(screen.getByRole("button", { name: `Open ${original}` }).closest(".thread-row-wrap")).not.toHaveClass("active");
  expect(composer()).toHaveValue(nextDraft);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  const request = dispatches()[0].args!;
  if (provider === "claude") {
    expect(request.options).toMatchObject({ prompt: original, cwd: PROJECT.path, attachments: [{ path: "/fixture/image.png", kind: "image" }] });
  } else {
    expect(request.params).toMatchObject({ cwd: PROJECT.path, input: expect.arrayContaining([{ type: "localImage", path: "/fixture/image.png", detail: "auto" }]) });
  }
  expect(composer()).toHaveValue(nextDraft);
  expect(useTaskStore.getState().activeThreadId).toBeNull();
  expect(document.querySelector(".thread-row-wrap.active")).toBeNull();
  expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull();
  const messages = Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages);
  expect(messages.filter((message) => message.text === original)).toHaveLength(1);
  expect(messages.find((message) => message.text === original)?.attachments).toEqual([{ path: "/fixture/image.png", name: "image.png", kind: "image" }]);
  await userEvent.click(screen.getByRole("button", { name: `Open ${original}` }));
  await waitFor(() => expect(document.querySelector("article.message.user")).toHaveTextContent(original));
});

it.each(["openai", "claude"] as const)("retains the %s pending prompt after thread creation and honors Stop during its checkpoint", async (provider) => {
  checkpoint = new Promise((resolve) => {
    releaseCheckpoint = () => resolve({ commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) });
  });
  await renderApp(provider);
  const text = `Stop ${provider} after its thread is created`;
  await send(text);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(calls.some(({ command }) => command === "checkpoint_create")).toBe(true));
  expect(screen.getByRole("article", { name: "Your pending prompt" })).toHaveTextContent(text);
  expect(screen.getByRole("article", { name: "Your pending prompt" })).toBeVisible();
  expect(dispatches()).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: /^Stop/ }));
  await act(async () => { releaseCheckpoint!(); });
  await waitFor(() => expect(composer()).toHaveValue(text));
  expect(dispatches()).toHaveLength(0);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
});

it.each(["openai", "claude"] as const)("can reselect the created %s thread while its first checkpoint is pending", async (provider) => {
  checkpoint = new Promise((resolve) => {
    releaseCheckpoint = () => resolve({ commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) });
  });
  await renderApp(provider);
  const text = `Reselect created ${provider} thread during its checkpoint`;
  await send(text);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(calls.some(({ command }) => command === "checkpoint_create")).toBe(true));
  const threadId = useTaskStore.getState().activeThreadId;
  expect(threadId).not.toBeNull();
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  await userEvent.click(screen.getByRole("button", { name: `Open ${text}` }));
  await waitFor(() => expect(useTaskStore.getState().activeThreadId).toBe(threadId));
  expectSelectedPending(text, provider);
  expect(screen.getByRole("button", { name: /^Stop/ })).toBeVisible();
  expect(dispatches()).toHaveLength(0);
  await act(async () => { releaseCheckpoint!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull());
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages).filter((message) => message.text === text)).toHaveLength(1);
});

it.each(["openai", "claude"] as const)("keeps a failed background %s prompt recoverable without overwriting the newer draft", async (provider) => {
  await renderApp(provider);
  const original = `Recover the original background ${provider} prompt`;
  const nextDraft = `Preserve the independent newer ${provider} draft`;
  await send(original);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  await userEvent.type(composer(), nextDraft);
  await act(async () => { rejectBridge!(new Error("Fixture background preparation failed")); });
  const recovered = await screen.findByRole("button", { name: `Open saved draft: ${original}` });
  expect(composer()).toHaveValue(nextDraft);
  expect(useTaskStore.getState().activeThreadId).toBeNull();
  expect(dispatches()).toHaveLength(0);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
  await userEvent.click(recovered);
  await waitFor(() => expect(composer()).toHaveValue(original));
  await userEvent.click(await screen.findByRole("button", { name: `Open saved draft: ${nextDraft}` }));
  await waitFor(() => expect(composer()).toHaveValue(nextDraft));
  expect(dispatches()).toHaveLength(0);
});

it("recovers a feedback-only first send after background preparation fails", async () => {
  const comment = "Please correct this reviewed change";
  const scope = JSON.stringify([`new:${PROJECT.path}`, PROJECT.path]);
  localStorage.setItem("kiwi.reviewFeedback", JSON.stringify({ [scope]: [{
    id: "feedback-only-review", createdAt: Date.now(), comment,
    anchor: { kind: "diff", path: "src/review.ts", baseline: "HEAD", source: "repository", side: "new", newLine: 1, quote: "changed line", fileFingerprint: "fixture" },
  }] }));
  await renderApp("openai");
  expect(composer()).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
  await waitFor(() => expect(calls.some(({ command }) => command === "child_agent_session_start")).toBe(true));
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  await userEvent.type(composer(), "Keep this independent draft");
  await act(async () => { rejectBridge!(new Error("Fixture feedback preparation failed")); });
  const recovered = await screen.findByRole("button", { name: "Open saved draft: Review feedback" });
  expect(composer()).toHaveValue("Keep this independent draft");
  expect(dispatches()).toHaveLength(0);
  await userEvent.click(recovered);
  expect(composer()).toHaveValue("");
  expect(screen.getByRole("list", { name: "Staged feedback notes" })).toHaveTextContent(comment);
  bridge = Promise.resolve({ name: "fixture_tools", command: "/fixture/bridge", args: [], configPath: "/fixture/bridge.json", toolNames: ["set_project_run_command", "set_project_check_command"] });
  await userEvent.click(screen.getByRole("button", { name: "Send feedback and optional prompt" }));
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  const prompt = (dispatches()[0].args!.params as { input: { type: string; text?: string }[] }).input.find((entry) => entry.type === "text")!.text!;
  expect(prompt.split(comment)).toHaveLength(2);
});

it("keeps an images-only next draft reachable after reselecting the preparing first thread", async () => {
  await renderApp("openai");
  const original = "Preparing first thread before an images-only next draft";
  await send(original);
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { items: [{ type: file.type, getAsFile: () => file }] } });
  fireEvent(composer(), paste);
  await screen.findByRole("button", { name: "Remove attachment image.png" });
  expect(composer()).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: `Open ${original}` }));
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull());
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  const recovered = await screen.findByRole("button", { name: "Open saved draft: Image attachments" });
  await userEvent.click(recovered);
  expect(composer()).toHaveValue("");
  expect(screen.getByRole("button", { name: "Remove attachment image.png" })).toBeVisible();
  expect(dispatches()).toHaveLength(1);
});

it("keeps an accepted first prompt after completion when an earlier empty history read finishes", async () => {
  const text = "Retain accepted first prompt after a stale history read";
  historySnapshotThread = { id: "started-codex-1", name: null, preview: text, cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai", turns: [] };
  historyPage = new Promise((resolve) => { releaseHistoryPage = () => resolve({ data: [], nextCursor: null }); });
  checkpoint = new Promise((resolve) => { releaseCheckpoint = () => resolve({ commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) }); });
  await renderApp("openai");
  await send(text);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(calls.some(({ command }) => command === "checkpoint_create")).toBe(true));
  await userEvent.click(document.querySelector<HTMLButtonElement>("button.new-thread-button")!);
  await userEvent.click(screen.getByRole("button", { name: `Open ${text}` }));
  await waitFor(() => expect(calls.some(({ command, args }) => command === "codex_rpc" && args?.method === "thread/turns/list")).toBe(true));
  await act(async () => { releaseCheckpoint!(); });
  await waitFor(() => expect(useTaskStore.getState().tasks["started-codex-1"].messages[0]?.turnId).toBe("fixture-codex-turn"));
  await act(async () => {
    useTaskStore.getState().completeMessage("started-codex-1", { id: "history-review-answer", role: "assistant", text: "Completed fixture answer", turnId: "fixture-codex-turn" });
    useTaskStore.getState().completeTurn("started-codex-1", "fixture-codex-turn", "completed");
  });
  await waitFor(() => expect(document.querySelector("article.message.user")).toHaveTextContent(text));
  await act(async () => { releaseHistoryPage!(); });
  await waitFor(() => expect(calls.some(({ command, args }) => command === "codex_rpc" && args?.method === "thread/resume")).toBe(true));
  expect(useTaskStore.getState().tasks["started-codex-1"].messages.map((message) => message.text)).toEqual([text, "Completed fixture answer"]);
  expect(document.querySelector("article.message.user")).toHaveTextContent(text);
  expect(dispatches()).toHaveLength(1);
  await screen.findByText("Completed fixture answer");
});

it.each(["openai", "claude"] as const)("stops a preparing %s first prompt without delivering it and restores the draft", async (provider) => {
  await renderApp(provider);
  const text = `Stop pending ${provider} preparation`;
  await send(text);
  await userEvent.click(screen.getByRole("button", { name: /^Stop/ }));
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(composer()).toHaveValue(text));
  expect(dispatches()).toHaveLength(0);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
});

it.each(["openai", "claude"] as const)("restores a %s draft after preparation fails without claiming delivery", async (provider) => {
  await renderApp(provider);
  const text = `Recover pending ${provider} preparation`;
  await send(text);
  await act(async () => { rejectBridge!(new Error("Fixture bridge preparation failed")); });
  await waitFor(() => expect(composer()).toHaveValue(text));
  expect(screen.getByText(/Fixture bridge preparation failed/)).toBeVisible();
  expect(dispatches()).toHaveLength(0);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
});

it.each(["openai", "claude"] as const)("keeps pending %s feedback in its originating workspace", async (provider) => {
  await renderApp(provider);
  const text = `Scoped pending ${provider} prompt`;
  await send(text);
  await userEvent.click(screen.getByRole("button", { name: OTHER.name }));
  expect(screen.queryByText(text)).toBeNull();
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  expect(screen.queryByText(text)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Start fixture(?:,|$)/ }));
  await userEvent.click(await screen.findByRole("button", { name: `Open ${text}` }));
  await waitFor(() => expect(document.querySelector("article.message.user")).toHaveTextContent(text));
});

it.each(["openai", "claude"] as const)("shows the %s prompt while a pasted image is copied and honors Stop before provider preparation", async (provider) => {
  imageCopy = new Promise((resolve) => { releaseImageCopy = () => resolve("/fixture/image.png"); });
  await renderApp(provider);
  const text = `Stop ${provider} while its image is copied`;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
  // Supply fixture file handles on a real bubbling event; the browser runner
  // does not grant native system clipboard access to synthetic paste events.
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { items: [{ type: file.type, getAsFile: () => file }] } });
  fireEvent(composer(), paste);
  await waitFor(() => expect(calls.some(({ command }) => command === "save_pasted_image")).toBe(true));
  await userEvent.type(composer(), text);
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  expectSelectedPending(text, provider);
  expect(calls.some(({ command }) => command === "child_agent_session_start")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: /^Stop/ }));
  await act(async () => { releaseImageCopy!(); });
  await waitFor(() => expect(composer()).toHaveValue(text));
  expect(dispatches()).toHaveLength(0);
  expect(calls.some(({ command }) => command === "child_agent_session_start")).toBe(false);
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
});

it.each(["openai", "claude"] as const)("restores the %s original draft if runtime startup fails after thread creation", async (provider) => {
  startFailure = true;
  await renderApp(provider);
  const text = `Restore ${provider} runtime startup failure`;
  await send(text);
  await act(async () => { releaseBridge!(); });
  await waitFor(() => expect(dispatches()).toHaveLength(1));
  await waitFor(() => expect(composer()).toHaveValue(text));
  expect(screen.getByText(/Fixture runtime start failed/)).toBeVisible();
  expect(Object.values(useTaskStore.getState().tasks).flatMap((task) => task.messages)).toHaveLength(0);
  expect(screen.queryByRole("article", { name: "Your pending prompt" })).toBeNull();
});

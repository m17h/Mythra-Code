import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page, userEvent as browserUserEvent } from "vitest/browser";
import { sanitizeTheme } from "./lib/appConfig";
import type { Project } from "./types";
import { preferenceLearningFixture } from "./test/preferenceLearningFixture";

/*
 * Real-App header regression for the Lumen experiment.
 *
 * Morgan's renderer screenshot (1500x1000, navigator and workspace dock both
 * open) showed the topbar's project chips (GitHub / prompt / Run) running under
 * the right-hand instrument tray. That only happens with the real App topbar,
 * whose controls are what collide, so this spec renders the actual <App /> with
 * the Tauri bridge stubbed (no native process, no provider requests, browser
 * localStorage only, cleared after every test) and measures the header at the
 * chat column widths that the dock and navigator really produce.
 */

const PROJECT = { id: "project-header", name: "Mythra Code", path: "/projects/mythra-code" };
const LONG_PROJECT = { id: "project-long", name: "An Extremely Long Project Name For The Header Collapse Regression", path: "/projects/an-extremely-long-project-name" };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => Promise.resolve(stubInvoke(command, args)),
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({ ...(await importOriginal<object>()), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.0-test") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "denied"),
  sendNotification: vi.fn(),
}));
vi.mock("./components/XtermPanel", () => ({ XtermPanel: () => null }));

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  const runtime = { available: true, source: "Codex CLI", path: "/usr/local/bin/codex", runningPath: "/usr/local/bin/codex", dataHome: "/tmp/codex-home", version: "99.0.0", runningVersion: "99.0.0", runningCommands: 0, runtimeChanged: false, compatible: true, warning: null };
  switch (command) {
    case "preference_learning_list":
    case "preference_learning_forget":
    case "preference_learning_save": return learnedFixture.invoke(command, args);
    case "open_workspace_folder": return folderOpen(args?.path);
    case "codex_runtime_status":
    case "codex_runtime_status_refresh": return runtime;
    case "claude_runtime_status": return claudeSignedIn
      ? { available: true, path: "/usr/local/bin/claude", version: "9.9.9", loggedIn: true, authMethod: "subscription", email: "fixture@example.com", subscriptionType: "max", warning: null }
      : { available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null };
    case "cursor_runtime_status": return null;
    case "local_skills_scan": return [];
    case "local_skills_sync": return "/tmp/skills";
    case "claude_models": return { models: [] };
    case "cursor_models": return [];
    case "list_lmstudio_models": return { models: [] };
    case "has_openrouter_key": return false;
    case "github_status": return { available: true, authenticated: true, path: "/usr/bin/gh", version: "gh test", login: "fixture", name: "Fixture", email: null, avatarUrl: null, profileUrl: null, error: null };
    case "github_repo_status": return { isRepo: true, remoteUrl: "https://github.com/fixture/mythra.git", repository: "fixture/mythra", branch: "main", upstream: "origin/main", ahead: 0, behind: 0 };
    case "github_pr_list": return [];
    case "github_pr_find": return null;
    case "workspace_git_info": return { isRepo: true, isRoot: true, hasCommit: true, branch: "main", head: "head" };
    case "git_project_diff": return { text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
    case "git_project_changes": return { rootPath: String(args?.cwd ?? PROJECT.path), rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    case "git_project_history": return { entries: [], hasMore: false, nextOffset: 0, headOid: "a".repeat(40), truncated: false };
    case "git_workspace_snapshot": return { branch: "main", headOid: "a".repeat(40), branches: [], stagedFiles: 0, unstagedFiles: 0, changedFiles: 0, stagedPaths: [], rootPath: String(args?.cwd ?? PROJECT.path) };
    case "state_read": return null;
    case "local_transcript_list": return [];
    case "audit_recent": return [];
    case "runtime_instance": return "runtime-1";
    case "runtime_thread_state": return { instance: "runtime-1", loaded: false };
    case "normal_chat_workspace": return "/chats";
    case "codex_rpc": {
      const method = String(args?.method);
      if (method === "thread/list") return { data: inboxThreads.filter((thread) => thread.cwd === (args?.params as Record<string, unknown>)?.cwd), nextCursor: null };
      if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
      if (method === "account/rateLimits/read") return { rateLimits: {} };
      if (method === "model/list") return { data: liveModels };
      if (method === "fs/readDirectory") return { entries: [] };
      if (method === "fuzzyFileSearch") return { files: [] };
      if (method === "gitDiffToRemote") return { diff: "" };
      return {};
    }
    default: return null;
  }
}

let appInstance = 0;
let claudeSignedIn = false;
let inboxThreads: { id: string; name: string; preview: string; cwd: string; updatedAt: number; modelProvider: string }[] = [];
const folderOpen = vi.fn<(path: unknown) => unknown>(() => null);
const learnedFixture = preferenceLearningFixture();
let liveModels: Record<string, unknown>[] = [];

beforeEach(() => {
  localStorage.clear();
  claudeSignedIn = false;
  inboxThreads = [];
  folderOpen.mockReset().mockReturnValue(null);
  learnedFixture.reset();
  liveModels = [];
});

it("wires learned preference settings to live models and exact project scopes in the real App", async () => {
  await commands.setStreamTestReducedMotion(true);
  liveModels = [{ id: "gpt-6.1-luna", model: "gpt-6.1-luna", displayName: "GPT-6.1 Luna", description: "", supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: false }];
  const view = await renderApp({ theme: "mythra", provider: "openai" });
  await browserUserEvent.click(screen.getByRole("button", { name: "Settings" }));
  await browserUserEvent.click(await screen.findByRole("button", { name: /^Prompts/ }));
  const toggle = await screen.findByRole("switch", { name: "Automatically learn preferences" });
  await waitFor(() => expect(toggle).not.toBeDisabled());
  const authoredField = screen.getByRole("textbox", { name: "Global Mythra Code prompt" });
  authoredField.focus();
  await browserUserEvent.hover(screen.getByRole("button", { name: "About experimental preference learning" }));
  expect(screen.getByRole("tooltip")).toBeVisible();
  await browserUserEvent.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(authoredField).toHaveFocus();
  await browserUserEvent.click(screen.getByRole("button", { name: "Preference learning model" }));
  expect(await screen.findByRole("menuitemradio", { name: /Automatic/ })).toHaveTextContent("gpt-6.1-luna");
  await browserUserEvent.keyboard("{Escape}");
  await browserUserEvent.click(screen.getByRole("button", { name: "Preference learning scope" }));
  await browserUserEvent.click(screen.getByRole("menuitemradio", { name: /Mythra Code/ }));
  await browserUserEvent.click(screen.getByRole("switch", { name: "Automatically learn preferences" }));
  await waitFor(() => expect(learnedFixture.states.get(`project:${PROJECT.id}`)?.enabled).toBe(true));
  await browserUserEvent.fill(screen.getByRole("textbox", { name: "Learned instructions for Mythra Code" }), "- Prefer concise progress updates");
  await browserUserEvent.click(screen.getByRole("button", { name: "Save learned instructions" }));
  await waitFor(() => expect(learnedFixture.states.get(`project:${PROJECT.id}`)?.markdown).toBe("- Prefer concise progress updates"));
  expect(learnedFixture.states.get("app")?.markdown).toBe("");
  expect(learnedFixture.calls.filter((call) => call.command === "preference_learning_save").every((call) => call.args?.scopeKey === `project:${PROJECT.id}`)).toBe(true);
  await page.screenshot({ path: "../test-results/preference-learning-real-app.png" });
  view.unmount();
});

afterEach(async () => {
  localStorage.clear();
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

async function renderApp({ project = PROJECT, theme = "atari", uiScale = 100, provider = "claude", model, pinned = false, effortSlider }: { project?: Project; theme?: string; uiScale?: number; provider?: string; model?: string; pinned?: boolean; effortSlider?: string } = {}) {
  localStorage.setItem("kiwi.projects", JSON.stringify([{ ...project, pinned }]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
  localStorage.setItem("kiwi.onboardingVersion", "99");
  localStorage.setItem("kiwi.settings", JSON.stringify({ provider, theme, uiScale, ...(model ? { model } : {}), ...(effortSlider ? { effortSlider } : {}) }));
  // App reads persisted settings and projects at module scope, and browser
  // mode does not re-evaluate modules after vi.resetModules(). A unique query
  // gives every scenario a fresh App module (fresh theme, scale and projects).
  const url = `./App.tsx?header-case=${++appInstance}`;
  const { default: App } = await import(/* @vite-ignore */ url) as typeof import("./App");
  const view = render(<App />);
  expect(view.container.querySelector(".app-shell")).toHaveAttribute("data-theme", sanitizeTheme(project.overrides?.defaults?.theme ?? theme));
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
  await waitFor(() => expect(view.container.querySelector(".project-run-control")).not.toBeNull(), { timeout: 10_000 });
  return view;
}

it("shows scheduled counts for project and Chats workspaces and updates thread cards when a schedule joins the queue", async () => {
  await commands.setStreamTestReducedMotion(true);
  const { useTaskStore, resetTaskStore } = await import("./lib/taskStore");
  const { useNewThreadTimedPrompts, resetNewThreadTimedPromptsForTests, newThreadSnapshot } = await import("./lib/newThreadTimedPrompts");
  const { DEFAULT_SETTINGS } = await import("./lib/appConfig");
  resetTaskStore();
  resetNewThreadTimedPromptsForTests();
  const thread = { id: "scheduled-card", name: "Follow up later", preview: "Review later", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai" };
  inboxThreads = [thread];
  localStorage.setItem("kiwi.knownThreads", JSON.stringify({ [thread.id]: thread }));
  localStorage.setItem("kiwi.threadProjects", JSON.stringify({ [thread.id]: PROJECT.path, "scheduled-chat": "/chats" }));
  const task = useTaskStore.getState();
  task.ensureTask(thread.id, PROJECT.path);
  const pending = task.enqueueTurn(thread.id, "Check in later", [], { deliverAt: Date.now() + 86_400_000 });
  task.enqueueTurn(thread.id, "Missed reminder", [], { deliverAt: Date.now() + 86_400_000 });
  task.markTimedTurnsMissed(thread.id, [pending.id]);
  task.enqueueTurn(thread.id, "Ordinary follow up", []);
  task.ensureTask("scheduled-chat", "/chats");
  task.enqueueTurn("scheduled-chat", "Chat reminder", [], { deliverAt: Date.now() + 86_400_000 });
  const firstPrompts = useNewThreadTimedPrompts.getState();
  firstPrompts.add({ workspacePath: PROJECT.path, workspaceName: PROJECT.name, text: "New project conversation", attachments: [], deliverAt: Date.now() + 86_400_000, snapshot: newThreadSnapshot(DEFAULT_SETTINGS, false) });
  firstPrompts.add({ workspacePath: "/chats", workspaceName: "Chats", text: "New chat conversation", attachments: [], deliverAt: Date.now() + 86_400_000, snapshot: newThreadSnapshot(DEFAULT_SETTINGS, false) });
  const view = await renderApp({ provider: "openai" });
  try {
    const projectRow = await screen.findByRole("button", { name: "Mythra Code, 1 scheduled new conversation, 2 scheduled prompts in existing threads" });
    expect(screen.getByRole("button", { name: "Chats, 1 scheduled new conversation, 1 scheduled prompt in existing threads" })).toBeVisible();
    const card = await screen.findByRole("button", { name: "Open Follow up later · 2 scheduled prompts in this thread" });
    await waitFor(() => expect(card.querySelector(".scheduled-counts")).toBeVisible());
    expect(projectRow.scrollWidth).toBeLessThanOrEqual(projectRow.clientWidth);
    await act(async () => { useTaskStore.getState().releaseTimedTurnNow(thread.id, pending.id); });
    expect(await screen.findByRole("button", { name: "Mythra Code, 1 scheduled new conversation, 1 scheduled prompt in existing threads" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Follow up later · 1 scheduled prompt in this thread" })).toBeVisible();
    // Releasing to the FIFO changes the count immediately, before any send.
    expect(useTaskStore.getState().tasks[thread.id].queuedTurns.find((entry) => entry.id === pending.id)?.releasedAt).toBeDefined();
  } finally {
    view.unmount();
    resetTaskStore();
    resetNewThreadTimedPromptsForTests();
  }
});

it.each([ [false, "dart"], [true, "dart"], [false, "filament"], [true, "filament"] ] as const)("migrates retired selection in the real app (project override: %s, style: %s)", async (projectOverride, retired) => {
  const project = projectOverride ? { ...PROJECT, overrides: { defaults: { provider: "openai", model: "gpt-6-sol", effortSlider: retired } } } as unknown as Project : PROJECT;
  const view = await renderApp({ theme: "mythra", provider: "openai", effortSlider: projectOverride ? "classic" : retired, project });
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  expect(shell).toHaveAttribute("data-effort-slider", "comet");
  const slider = screen.getByRole("slider", { name: "Reasoning effort" });
  slider.focus();
  await browserUserEvent.keyboard("{End}");
  await waitFor(() => expect(slider).toHaveAttribute("aria-valuetext", "Maximum"));
  await browserUserEvent.keyboard("{Home}");
  await waitFor(() => expect(slider).toHaveAttribute("aria-valuetext", "Light"));
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  expect(screen.queryByRole("button", { name: /^Dart/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Filament/ })).toBeNull();
  expect(screen.getByRole("button", { name: /^Comet/ })).toBeTruthy();
});

/** Every rendered, visible interactive control in the header. */
function headerControls(topbar: HTMLElement) {
  return [...topbar.querySelectorAll<HTMLElement>("button, [role='button'], a[href], input")].filter((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0 && !element.closest("[aria-hidden='true'], [hidden], .project-prompt-popover, .usage-popover, .project-run-popover");
  });
}

function accessibleName(element: HTMLElement) {
  return (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").trim();
}

function expectHeaderUsable(container: HTMLElement, label: string) {
  const topbar = container.querySelector<HTMLElement>(".topbar")!;
  const bar = topbar.getBoundingClientRect();
  const left = topbar.querySelector<HTMLElement>(".topbar-left")!;
  const right = topbar.querySelector<HTMLElement>(".topbar-right")!;
  const controls = headerControls(topbar);
  expect(controls.length, `${label}: header controls`).toBeGreaterThan(3);
  const leftControls = controls.filter((element) => left.contains(element));
  const rightControls = controls.filter((element) => right.contains(element));
  // No left-group item intersects any tray item: either the left group ends
  // before the tray starts, or (narrowest columns) the tray sits on its own row.
  const leftItems = [...leftControls, left.querySelector<HTMLElement>(".project-heading")!].map((element) => element.getBoundingClientRect());
  const rightItems = rightControls.map((element) => element.getBoundingClientRect());
  for (const a of leftItems) {
    for (const b of rightItems) {
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(overlapX > .5 && overlapY > .5, `${label}: left group runs under the tray (${Math.round(a.right)} > ${Math.round(b.left)})`).toBe(false);
    }
  }
  // Codex's renderer audit (/tmp/mythra-lumen-header-audit.mjs): no two header
  // buttons may intersect by more than 2px in both axes, wherever they live.
  const buttons = controls.filter((element) => element.matches("button"));
  for (let i = 0; i < buttons.length; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      const a = buttons[i], b = buttons[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const x = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
      const y = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
      expect(x > 2 && y > 2, `${label}: "${accessibleName(a)}" overlaps "${accessibleName(b)}" by ${Math.round(x)}px`).toBe(false);
    }
  }
  for (const element of controls) {
    const box = element.getBoundingClientRect();
    const name = accessibleName(element);
    expect(name, `${label}: control without an accessible name`).not.toBe("");
    // Nothing is pushed out of the header or clipped by its edges.
    expect(box.left, `${label}: ${name} starts outside the header`).toBeGreaterThanOrEqual(bar.left - .5);
    expect(box.right, `${label}: ${name} ends outside the header`).toBeLessThanOrEqual(bar.right + .5);
    // Usable hit areas.
    expect(box.width, `${label}: ${name} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${label}: ${name} height`).toBeGreaterThanOrEqual(24);
    // The control is what receives a click at its centre (not a neighbour on top).
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(element.contains(hit), `${label}: ${name} is covered at its centre`).toBe(true);
  }
  // The project stays identifiable.
  const heading = topbar.querySelector<HTMLElement>(".project-heading > span")!;
  expect(heading.getBoundingClientRect().width, `${label}: project name collapsed`).toBeGreaterThanOrEqual(48);
  expect(heading.textContent!.length).toBeGreaterThan(0);
}

async function openDock() {
  await userEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
  await screen.findByRole("tablist", { name: "Workspace tools" });
}

it.each([false, true])("opens the project folder from its sidebar menu (pinned: %s) without leaving Chats", async (pinned) => {
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ pinned, theme: "mythra" });
  await userEvent.click(screen.getByRole("button", { name: /^Chats$/ }));
  await screen.findByRole("heading", { name: "Start a normal chat." });
  await browserUserEvent.hover(view.container.querySelector(".workspace-row-wrap")!);
  await userEvent.click(screen.getByRole("button", { name: `Options for ${PROJECT.name}` }));
  const action = screen.getByRole("menuitem", { name: "Open folder" });
  await waitFor(() => expect(action).toBeVisible());
  const rect = action.getBoundingClientRect();
  expect(action.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))).toBe(true);
  await userEvent.click(action);
  expect(folderOpen).toHaveBeenCalledExactlyOnceWith(PROJECT.path);
  expect(screen.queryByRole("menu", { name: `Options for ${PROJECT.name}` })).toBeNull();
  expect(screen.getByRole("heading", { name: "Start a normal chat." })).toBeVisible();
  expect(view.container.querySelector(".workspace-row.chat.active")).not.toBeNull();
});

it("passes Windows project paths unchanged and shows native folder failures", async () => {
  const project = { ...PROJECT, path: "C:\\Users\\Morgan\\Projects\\A project" };
  const view = await renderApp({ project });
  folderOpen.mockImplementationOnce(() => { throw new Error("The project folder is no longer available."); });
  await browserUserEvent.hover(view.container.querySelector(".workspace-row-wrap")!);
  await userEvent.click(screen.getByRole("button", { name: `Options for ${project.name}` }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Open folder" }));
  expect(folderOpen).toHaveBeenCalledExactlyOnceWith(project.path);
  await waitFor(() => expect(screen.getByText("The project folder is no longer available.")).toBeVisible());
  expect(view.container.querySelector(".workspace-row-wrap.active")).not.toBeNull();
});

it.each([false, true])("hides Open folder for normal chats while preserving project thread actions (pinned chat: %s)", async (pinned) => {
  await commands.setStreamTestReducedMotion(true);
  inboxThreads = [
    { id: "chat-menu", name: "Normal conversation", preview: "Hello", cwd: "/chats", updatedAt: 2, modelProvider: "openai" },
    { id: "project-menu", name: "Project conversation", preview: "Build", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai" },
  ];
  if (pinned) localStorage.setItem("kiwi.pinnedThreads", JSON.stringify(["chat-menu"]));
  await renderApp({ theme: "mythra", provider: "openai" });
  const projectMenu = await screen.findByRole("button", { name: "Options for Project conversation" });
  await browserUserEvent.hover(projectMenu.closest(".thread-row-wrap")!);
  await userEvent.click(projectMenu);
  await userEvent.click(screen.getByRole("menuitem", { name: "Open folder" }));
  expect(folderOpen).toHaveBeenCalledExactlyOnceWith(PROJECT.path);
  folderOpen.mockClear();

  await userEvent.click(screen.getByRole("button", { name: /^Chats$/ }));
  const chatMenu = await screen.findByRole("button", { name: "Options for Normal conversation" });
  await browserUserEvent.hover(chatMenu.closest(".thread-row-wrap")!);
  await userEvent.click(chatMenu);
  await waitFor(() => expect(screen.getByRole("menu", { name: "Options for Normal conversation" })).toBeVisible());
  expect(screen.queryByRole("menuitem", { name: "Open folder" })).toBeNull();
  for (const name of [pinned ? "Unpin" : "Pin", "Rename", "Archive", "Delete forever"]) {
    expect(screen.getByRole("menuitem", { name })).toBeVisible();
  }
  expect(folderOpen).not.toHaveBeenCalled();
});

it.each(["mythra", "atari", "light-mythra"])("does not add a bright composer hairline when switching providers in %s", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  claudeSignedIn = true;
  const view = await renderApp({ theme, provider: "claude" });
  await userEvent.click(screen.getByRole("button", { name: "New thread provider: Claude" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^OpenAI/ }));
  await screen.findByRole("button", { name: "New thread provider: OpenAI" });
  const input = view.container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  input.focus();
  expect(input).toHaveFocus();
  const composer = view.container.querySelector<HTMLElement>(".composer")!;
  const decoration = getComputedStyle(composer, "::before");
  expect(["none", "normal"]).toContain(decoration.content);
  expect(decoration.backgroundImage).toBe("none");
});

it.each([{ theme: "mythra", uiScale: 100 }, { theme: "atari", uiScale: 100 }, { theme: "mythra", uiScale: 150 }])("uses squircle controls instead of oval outlines in the real app and Settings ($theme, $uiScale%)", async ({ theme, uiScale }) => {
  await page.viewport(1500, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme, uiScale });
  const expectSquircle = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    for (const corner of [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]) {
      expect(corner, `${element.className}: percentage radius makes a capsule`).not.toContain("%");
      const radius = parseFloat(corner);
      expect(radius, `${element.className}: rounded corners`).toBeGreaterThan(0);
      expect(radius, `${element.className}: modest control corners`).toBeLessThanOrEqual(13);
      expect(radius, `${element.className}: not fully rounded ends`).toBeLessThan(Math.min(element.offsetHeight, element.offsetWidth) / 2);
    }
  };
  for (const selector of [".provider-pill", ".thread-kind-switch", ".thread-search", ".empty-state-actions button", ".send-button"]) {
    const controls = [...view.container.querySelectorAll<HTMLElement>(selector)];
    expect(controls.length, selector).toBeGreaterThan(0);
    controls.forEach(expectSquircle);
  }
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  for (const selector of [".settings-nav button.active", ".settings-search", ".settings-close", ".modal-footer button"]) {
    const controls = [...view.container.querySelectorAll<HTMLElement>(selector)];
    expect(controls.length, selector).toBeGreaterThan(0);
    controls.forEach(expectSquircle);
  }
  const scale = screen.getByRole("button", { name: "Interface size" });
  expectSquircle(scale);
  scale.scrollIntoView({ block: "center" });
  await browserUserEvent.click(scale);
  const option = screen.getByRole("menuitemradio", { name: /125%/ });
  const box = option.getBoundingClientRect();
  expect(option.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  await browserUserEvent.keyboard("{Escape}");
  expectSquircle(scale);
});

it.each([{ theme: "mythra", uiScale: 100, width: 1500 }, { theme: "atari", uiScale: 100, width: 1500 }, { theme: "mythra", uiScale: 150, width: 1500 }, { theme: "atari", uiScale: 100, width: 700 }])("does not crop the four outer card corners in Settings ($theme, $uiScale%, $width px)", async ({ theme, uiScale, width }) => {
  await page.viewport(width, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme, uiScale });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  for (const selector of [".theme-grid", ".chat-font-grid", ".slider-style-grid", ".provider-mark-grid"]) {
    const grid = view.container.querySelector<HTMLElement>(selector)!;
    expect(grid, selector).not.toBeNull();
    const wrapper = grid.closest<HTMLElement>(".set-card.bare")!;
    expect(wrapper, selector).not.toBeNull();
    const style = getComputedStyle(wrapper);
    expect(style.borderRadius, `${selector}: bare wrapper must not cut independent card corners`).toBe("0px");
    expect(style.overflowX, `${selector}: focus and hover must not be clipped`).toBe("visible");
    expect(style.overflowY).toBe("visible");
  }
  const cards = [...view.container.querySelectorAll<HTMLElement>(".chat-font-card")];
  if (theme === "mythra" && uiScale === 100) {
    // Replay the exact pre-fix clip after Opus's live CSS edit. WebKit hit
    // testing doesn't consistently exclude rounded overflow corners, even
    // when native pixels are cropped, so verify the clip geometry directly.
    const oldClip = document.createElement("style");
    oldClip.textContent = ".app-shell[data-theme][data-color-scheme] .set-card.bare { overflow: hidden; border-radius: 20px; }";
    document.head.appendChild(oldClip);
    try {
      cards[0].scrollIntoView({ block: "center" });
      const box = cards[0].getBoundingClientRect();
      const wrapper = cards[0].closest<HTMLElement>(".set-card.bare")!;
      const clip = getComputedStyle(wrapper);
      const wrapperBox = wrapper.getBoundingClientRect();
      expect(clip.overflowX).toBe("hidden");
      const radius = parseFloat(clip.borderTopLeftRadius);
      const x = box.left + 8 - wrapperBox.left;
      const y = box.top + 2 - wrapperBox.top;
      expect((x - radius) ** 2 + (y - radius) ** 2, "card arc falls outside old wrapper clip").toBeGreaterThan(radius ** 2);
    } finally {
      oldClip.remove();
    }
  }
  // Points just inside each card's own arc, but outside the old wrapper's
  // larger 20px arc. Check pointer reachability after removing that clip.
  const corners = width <= 760
    ? [[0, false, false], [0, true, false], [3, false, true], [3, true, true]] as const
    : [[0, false, false], [1, true, false], [2, false, true], [3, true, true]] as const;
  for (const [index, right, bottom] of corners) {
    const card = cards[index];
    card.scrollIntoView({ block: "center" });
    const box = card.getBoundingClientRect();
    const zoom = uiScale / 100;
    const x = right ? box.right - 8 * zoom : box.left + 8 * zoom;
    const y = bottom ? box.bottom - 2 * zoom : box.top + 2 * zoom;
    expect(card.contains(document.elementFromPoint(x, y)), `card ${index}: outer corner receives pointer`).toBe(true);
  }
  // Ordinary row cards still clip their joined surfaces to rounded edges.
  const ordinary = view.container.querySelector<HTMLElement>(".set-card:not(.bare)")!;
  expect(getComputedStyle(ordinary).overflowX).toBe("hidden");
  expect(parseFloat(getComputedStyle(ordinary).borderTopLeftRadius)).toBeGreaterThan(0);
  await browserUserEvent.click(cards[2]);
  expect(cards[2]).toHaveAttribute("aria-pressed", "true");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
});

it("fits every Settings section without scrolling in a roomy window and stays vertically centered", async () => {
  await page.viewport(1800, 1040);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "mythra" });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  const nav = view.container.querySelector<HTMLElement>(".settings-nav-scroll")!;
  await waitFor(() => expect(nav.clientHeight).toBeGreaterThan(0));
  expect(nav.scrollHeight).toBeLessThanOrEqual(nav.clientHeight + 1);
  const modal = view.container.querySelector<HTMLElement>(".settings-modal")!.getBoundingClientRect();
  const backdrop = view.container.querySelector<HTMLElement>(".settings-backdrop")!.getBoundingClientRect();
  expect(Math.abs((modal.top - backdrop.top) - (backdrop.bottom - modal.bottom))).toBeLessThanOrEqual(1);
  expect(modal.height).toBeGreaterThan(720);
  expect(modal.height).toBeLessThanOrEqual(800);
});

it.each([100, 150])("shows the default model menu above cards and scroll clipping at %s%%", async (uiScale) => {
  await page.viewport(1400, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "mythra", provider: "openai", uiScale });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  await userEvent.click(screen.getByRole("button", { name: "Models & accounts" }));
  const trigger = screen.getByRole("button", { name: "Default OpenAI model" });
  trigger.scrollIntoView({ block: "center" });
  await browserUserEvent.click(trigger);
  const option = screen.getByRole("menuitemradio", { name: /Astra/ });
  const menu = screen.getByRole("menu", { name: "Default OpenAI model choices" });
  await waitFor(() => {
    expect(menu.closest("[popover]")?.matches(":popover-open")).toBe(true);
    const box = option.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(option.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  });
  await browserUserEvent.click(option);
  expect(trigger).toHaveTextContent("Astra");
  expect(view.container.querySelector(".provider-card.selected strong")).toHaveTextContent("OpenAI");
  const provider = screen.getByRole("button", { name: "Default provider" });
  await browserUserEvent.click(provider);
  const claude = screen.getByRole("menuitemradio", { name: /Claude Code subscription/ });
  await waitFor(() => {
    const box = claude.getBoundingClientRect();
    expect(claude.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  });
  await browserUserEvent.click(claude);
  expect(screen.getByRole("button", { name: "Default Claude model" })).toHaveTextContent("Fable");
  expect(view.container.querySelector(".provider-card.selected strong")).toHaveTextContent("OpenAI");
});

it.each([100, 150])("keeps the Interface size popup above neighboring settings at %s%%", async (uiScale) => {
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "mythra", uiScale });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  const trigger = screen.getByRole("button", { name: "Interface size" });
  trigger.scrollIntoView({ block: "center" });
  await browserUserEvent.click(trigger);
  const menu = screen.getByRole("menu", { name: "Interface size choices" });
  const option = screen.getByRole("menuitemradio", { name: /125%/ });
  await waitFor(() => {
    expect(menu.closest("[popover]")?.matches(":popover-open")).toBe(true);
    const box = option.getBoundingClientRect();
    expect(option.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  });
  await browserUserEvent.click(option);
  expect(trigger).toHaveTextContent("125%");
  expect(view.container.querySelector<HTMLElement>(".app-shell")!.style.zoom).toBe("1.25");
  expect(screen.queryByRole("menu", { name: "Interface size choices" })).not.toBeInTheDocument();
  // Cancel must restore the saved scale instead of saving our test preview.
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await browserUserEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
  expect(view.container.querySelector<HTMLElement>(".app-shell")!.style.zoom).toBe(String(uiScale / 100));
});

it.each([
  { uiScale: 100, popover: false }, { uiScale: 150, popover: false },
  { uiScale: 100, popover: true }, { uiScale: 150, popover: true },
])("keeps Settings selects reachable with or without the Popover API ($uiScale%, API: $popover)", async ({ uiScale, popover }) => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover")!;
  if (!popover) Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: undefined });
  try {
    await page.viewport(1400, 1000);
    await commands.setStreamTestReducedMotion(true);
    const view = await renderApp({ theme: "mythra", provider: "openai", uiScale });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("button", { name: "Close settings" });
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await userEvent.click(screen.getByRole("button", { name: "Models & accounts" }));
    const trigger = screen.getByRole("button", { name: "Default OpenAI model" });
    trigger.scrollIntoView({ block: "center" });
    await browserUserEvent.click(trigger);
    const astra = screen.getByRole("menuitemradio", { name: /Astra/ });
    const expectReachable = async (option: HTMLElement) => waitFor(() => {
      const box = option.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(option.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
    });
    await expectReachable(astra);
    astra.focus();
    await new Promise(requestAnimationFrame);
    expect(astra).toHaveFocus();
    await browserUserEvent.keyboard("{Tab}");
    expect(screen.getByRole("button", { name: "Star Astra" })).toHaveFocus();
    await browserUserEvent.keyboard(" ");
    expect(screen.getByRole("button", { name: "Unstar Astra" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("menu", { name: "Default OpenAI model choices" })).toBeVisible();
    expect(trigger).not.toHaveTextContent("Astra");
    await browserUserEvent.click(astra);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent("Astra");
    const provider = screen.getByRole("button", { name: "Default provider" });
    await browserUserEvent.click(provider);
    const claude = screen.getByRole("menuitemradio", { name: /Claude Code subscription/ });
    await expectReachable(claude);
    // Menu opening moves focus asynchronously. Assert that transition before
    // testing Tab from the selected row, rather than racing one animation frame.
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /ChatGPT subscription/ })).toHaveFocus());
    await browserUserEvent.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(claude).toHaveFocus();
    const middle = screen.getByRole("menuitemradio", { name: /Claude Code subscription/ });
    middle.focus();
    await new Promise(requestAnimationFrame);
    expect(middle).toHaveFocus();
    await browserUserEvent.keyboard("{Tab}");
    expect(screen.getByRole("menuitemradio", { name: /^Cursor/ })).toHaveFocus();
    const last = screen.getAllByRole("menuitemradio").at(-1)!;
    last.focus();
    await new Promise(requestAnimationFrame);
    expect(last).toHaveFocus();
    await browserUserEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("menuitemradio", { name: /^OpenRouter/ })).toHaveFocus();
    last.focus();
    await browserUserEvent.keyboard("{Tab}");
    expect(screen.queryByRole("menu", { name: "Default provider choices" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await browserUserEvent.click(provider);
    screen.getAllByRole("menuitemradio")[0].focus();
    await new Promise(requestAnimationFrame);
    await browserUserEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(provider).not.toHaveFocus();
    await browserUserEvent.click(provider);
    await browserUserEvent.keyboard("{Escape}");
    expect(provider).toHaveFocus();
    expect(dialog).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Interface" }));
    const scale = screen.getByRole("button", { name: "Interface size" });
    scale.scrollIntoView({ block: "center" });
    await browserUserEvent.click(scale);
    const larger = screen.getByRole("menuitemradio", { name: /125%/ });
    await expectReachable(larger);
    await browserUserEvent.click(larger);
    expect(view.container.querySelector<HTMLElement>(".app-shell")!.style.zoom).toBe("1.25");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await browserUserEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(view.container.querySelector<HTMLElement>(".app-shell")!.style.zoom).toBe(String(uiScale / 100));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("button", { name: "Close settings" });
    await userEvent.click(screen.getByRole("button", { name: "Models & accounts" }));
    expect(screen.getByRole("button", { name: "Default OpenAI model" })).not.toHaveTextContent("Astra");
    const reopened = screen.getByRole("button", { name: "Default OpenAI model" });
    reopened.scrollIntoView({ block: "center" });
    await browserUserEvent.click(reopened);
    await expectReachable(screen.getByRole("menuitemradio", { name: /Astra/ }));
    await browserUserEvent.click(screen.getByRole("menuitemradio", { name: /Astra/ }));
    await browserUserEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("kiwi.settings")!).model).toMatch(/astra/);
  } finally {
    Object.defineProperty(HTMLElement.prototype, "showPopover", descriptor);
  }
});

it.each([
  { retired: "midnight", projectOverride: false },
  { retired: "monochrome", projectOverride: false },
  { retired: "midnight", projectOverride: true },
  { retired: "monochrome", projectOverride: true },
])("opens a saved retired $retired theme as a fully styled Mythra shell (project override: $projectOverride)", async ({ retired, projectOverride }) => {
  await commands.setStreamTestReducedMotion(true);
  // A project override keeps overriding (on Mythra) instead of falling back to
  // the different global theme, which here is the light Atari palette.
  const project = projectOverride ? { ...PROJECT, overrides: { defaults: { provider: "openai", model: "gpt-6-sol", theme: retired } } } as unknown as Project : PROJECT;
  const view = await renderApp({ theme: projectOverride ? "atari" : retired, provider: "openai", project });
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  expect(shell).toHaveAttribute("data-theme", "mythra");
  expect(shell).toHaveAttribute("data-color-scheme", "dark");
  expect(getComputedStyle(shell).backgroundColor).toBe("rgb(22, 24, 27)");
  expect(getComputedStyle(view.container.querySelector(".sidebar")!).backgroundColor).toBe("rgb(34, 37, 42)");
  for (const root of [view.container.querySelector(".brand-mark svg.mythra-mark")!, view.container.querySelector(".mythra-logo")!]) {
    expect(getComputedStyle(root.querySelector(".mythra-mark-stop--cyan-a")!).stopColor).toBe("rgb(53, 231, 242)");
  }
  if (projectOverride) {
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("button", { name: "Close settings" });
    expect(screen.getByRole("button", { name: /Atari Warm tan/ })).toHaveAttribute("aria-pressed", "true");
  }
});

it.each([false, true])("applies and saves the onboarding theme without overwriting project overrides (override=%s)", async (projectOverride) => {
  await commands.setStreamTestReducedMotion(true);
  const project: Project = { ...PROJECT, ...(projectOverride ? { overrides: { defaults: { provider: "openai", model: "gpt-6-sol", theme: "synthwave" } } } : {}) };
  const view = await renderApp({ theme: "mythra", project });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  await userEvent.click(screen.getByRole("button", { name: "Runtime" }));
  await userEvent.click(screen.getByRole("button", { name: "Run onboarding" }));
  await screen.findByRole("dialog", { name: "Mythra Code onboarding" });
  await userEvent.click(screen.getByRole("button", { name: "Make it yours" }));
  await browserUserEvent.click(screen.getByRole("radio", { name: "Atari" }));
  expect(view.container.querySelector(".app-shell")).toHaveAttribute("data-theme", "atari");
  expect(view.container.querySelector(".app-shell")).toHaveAttribute("data-color-scheme", "light");
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).theme).toBe("atari");
  await browserUserEvent.click(screen.getByRole("button", { name: "Skip tour" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mythra Code onboarding" })).not.toBeInTheDocument());
  expect(view.container.querySelector(".app-shell")).toHaveAttribute("data-theme", projectOverride ? "synthwave" : "atari");
  if (projectOverride) expect(JSON.parse(localStorage.getItem("kiwi.projects")!)[0].overrides.defaults.theme).toBe("synthwave");
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  expect(screen.getByRole("button", { name: /Atari Warm tan/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
});

it.each([100, 125, 150])("keeps taller Settings contained and its navigation reachable in a small window at %s%%", async (uiScale) => {
  await page.viewport(980, 680);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "atari", uiScale });
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("button", { name: "Close settings" });
  const modal = view.container.querySelector<HTMLElement>(".settings-modal")!.getBoundingClientRect();
  expect(modal.top).toBeGreaterThanOrEqual(0);
  expect(modal.bottom).toBeLessThanOrEqual(681);
  const nav = view.container.querySelector<HTMLElement>(".settings-nav-scroll")!;
  const updates = screen.getByRole("button", { name: /^Updates$/ });
  updates.scrollIntoView({ block: "nearest", inline: "nearest" });
  await browserUserEvent.click(updates);
  expect(updates).toHaveClass("active");
  expect(getComputedStyle(nav).overflowY).toBe("auto");
});

it.each([
  { theme: "atari", uiScale: 100 },
  { theme: "mythra", uiScale: 100 },
  { theme: "atari", uiScale: 125 },
  { theme: "mythra", uiScale: 150 },
])("keeps the real header usable at 1500x1000 with navigator and dock open ($theme, $uiScale%)", async ({ theme, uiScale }) => {
  await page.viewport(1500, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme, uiScale });
  // The real new-thread landing renders the animated logo with no added
  // halo/ring decoration behind it (Morgan reported those as a visual bug).
  expect(view.container.querySelector(".thread-empty-state > .mythra-logo")).not.toBeNull();
  expect(view.container.querySelector(".landing-halo, .landing-hero, .landing-eyebrow")).toBeNull();
  // Both in-app marks (sidebar brand, animated landing logo) take the active
  // theme's mark palette: Atari's brick, Mythra's original brand cyan.
  const shell = view.container.querySelector<HTMLElement>(".app-shell")!;
  const expected = theme === "mythra" ? "rgb(53, 231, 242)" :
    (() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--mythra-mark-cyan-a)";
      shell.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    })();
  for (const root of [view.container.querySelector(".brand-mark svg.mythra-mark")!, view.container.querySelector(".mythra-logo")!]) {
    expect(getComputedStyle(root.querySelector(".mythra-mark-stop--cyan-a")!).stopColor, `${theme} mark`).toBe(expected);
  }
  expectHeaderUsable(view.container, `${theme} ${uiScale}% dock closed`);
  await openDock();
  expectHeaderUsable(view.container, `${theme} ${uiScale}% dock open`);
  // Visual record for review (git-ignored test-results/); not an assertion.
  await page.screenshot({ path: `../test-results/lumen/header-${theme}-${uiScale}-dock-open.png` });
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expectHeaderUsable(view.container, `${theme} ${uiScale}% navigator hidden`);
});

it("keeps project and normal-chat landings free of the redundant outlined context chip", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "mythra", pinned: true });
  expect(view.container.querySelector(".landing-eyebrow")).toBeNull();
  expect(screen.getByRole("heading", { name: "What should we build?" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^Chats$/ }));
  expect(await screen.findByRole("heading", { name: "Start a normal chat." })).toBeVisible();
  expect(view.container.querySelector(".landing-eyebrow")).toBeNull();
  const logo = view.container.querySelector<HTMLElement>(".thread-empty-state > .mythra-logo")!;
  expect(logo.nextElementSibling?.tagName).toBe("H1");
  for (const icon of view.container.querySelectorAll(".sidebar .workspace-icon")) {
    expect(getComputedStyle(icon).backgroundImage).toBe("none");
    expect(getComputedStyle(icon).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(icon).boxShadow).toBe("none");
  }
});

it("conveys workspace selection without redundant circles and keeps keyboard switching working", async () => {
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ theme: "mythra" });
  const shared = screen.getByRole("button", { name: /^Shared project/ });
  const isolated = screen.getByRole("button", { name: /Isolated worktree/ });
  expect(shared).toHaveAttribute("aria-pressed", "true");
  expect(isolated).toHaveAttribute("aria-pressed", "false");
  for (const button of [shared, isolated]) {
    expect(["none", "normal"]).toContain(getComputedStyle(button, "::after").content);
  }
  isolated.focus();
  await userEvent.keyboard("{Enter}");
  expect(isolated).toHaveFocus();
  expect(isolated).toHaveAttribute("aria-pressed", "true");
  expect(shared).toHaveAttribute("aria-pressed", "false");
  expect(isolated).toHaveClass("active");
  expect(shared).not.toHaveClass("active");
  await userEvent.click(shared);
  expect(shared).toHaveAttribute("aria-pressed", "true");
  expect(isolated).toHaveAttribute("aria-pressed", "false");
  expect(view.container.querySelectorAll(".isolation-choice > button.active")).toHaveLength(1);
});

it.each([
  { width: 1250, height: 800 },
  { width: 1180, height: 760 },
  { width: 980, height: 680 },
])("keeps the real header usable with a long project name at $width x $height", async ({ width, height }) => {
  await page.viewport(width, height);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ project: LONG_PROJECT, theme: "mythra", provider: "openai" });
  expectHeaderUsable(view.container, `${width} dock closed`);
  await openDock();
  expectHeaderUsable(view.container, `${width} dock open`);
});

// The exact matrix of Codex's renderer audit, which reported intersections at
// 1500 / 100% dock open (Run edit over Search by 12px), 1500 / 125% dock closed
// (Run over Search by 58px) and 1500 / 150% dock open (Run and edit over the
// subscription usage chip).
it.each([
  { width: 1500, uiScale: 100 }, { width: 1380, uiScale: 100 }, { width: 1180, uiScale: 100 },
  { width: 980, uiScale: 100 }, { width: 1500, uiScale: 125 }, { width: 1500, uiScale: 150 },
])("replays the header audit at $width px wide, $uiScale percent scale, long pinned project", async ({ width, uiScale }) => {
  await page.viewport(width, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ project: { id: "preview", name: "Mythra Code experimental workspace with a long project name", path: "/preview/Mythra-Code" }, theme: "mythra", provider: "claude", model: "claude-opus-5-5", uiScale, pinned: true });
  expectHeaderUsable(view.container, `audit ${width}/${uiScale} dock closed`);
  await openDock();
  expectHeaderUsable(view.container, `audit ${width}/${uiScale} dock open`);
});

/* ---- Composer provider/model triggers (Morgan: the provider outline looked
   wrong next to the model button). Real App composer, every provider. ---- */

/** Settles any running transition (legacy triggers transition their border
 *  even under reduced motion), then reads the trigger's resolved treatment. */
async function triggerStyle(element: HTMLElement) {
  await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  const style = getComputedStyle(element);
  return {
    height: Math.round(element.getBoundingClientRect().height),
    radius: style.borderTopLeftRadius,
    borderWidth: style.borderTopWidth,
    borderStyle: style.borderTopStyle,
    borderColor: style.borderTopColor,
    background: style.backgroundColor,
    boxShadow: style.boxShadow,
  };
}

function composerTriggers(container: HTMLElement) {
  const provider = container.querySelector<HTMLElement>(".composer .provider-pill")!;
  const model = container.querySelector<HTMLElement>(".composer .model-picker-trigger, .composer .openrouter-trigger:not(.provider-pill)")!;
  expect(provider, "provider trigger").not.toBeNull();
  expect(model, "model trigger").not.toBeNull();
  return { provider, model };
}

it.each([
  { provider: "claude", theme: "mythra", signedIn: true }, { provider: "openai", theme: "mythra", signedIn: true },
  { provider: "cursor", theme: "atari", signedIn: true }, { provider: "openrouter", theme: "daylight", signedIn: true },
  { provider: "lmstudio", theme: "atari", signedIn: true }, { provider: "claude", theme: "daylight", signedIn: false },
])("matches the provider and model triggers in the real composer ($provider, $theme, signed in $signedIn)", async ({ provider, theme, signedIn }) => {
  await page.viewport(1500, 1000);
  await commands.setStreamTestReducedMotion(true);
  claudeSignedIn = signedIn;
  const view = await renderApp({ theme, provider });
  const { provider: providerButton, model } = composerTriggers(view.container);
  if (provider === "claude") await waitFor(() => expect(view.container.querySelector(".composer .openrouter-picker.unavailable") === null).toBe(signedIn));
  const idle = { provider: await triggerStyle(providerButton), model: await triggerStyle(model) };
  // Same corner geometry, border width, height and fill when idle.
  for (const key of ["height", "radius", "borderWidth", "background"] as const) {
    expect(idle.provider[key], `${provider}/${theme} idle ${key}`).toBe(idle.model[key]);
  }
  if (!signedIn) {
    // Sign-in required: the same shape, deliberately dashed, and clicking it
    // explains what to do instead of opening an empty catalog.
    expect(idle.model.borderStyle).toBe("dashed");
    await userEvent.click(model);
    expect(await screen.findByText(/Sign in to Claude Code/)).toBeInTheDocument();
    return;
  }
  expect(idle.provider.borderStyle).toBe(idle.model.borderStyle);
  // No nested-border artifact: the wrappers around each trigger draw nothing.
  for (const wrapper of [providerButton.parentElement!, model.parentElement!]) {
    const style = getComputedStyle(wrapper);
    expect(style.borderTopWidth, `${provider}/${theme} wrapper border`).toBe("0px");
    expect(style.boxShadow, `${provider}/${theme} wrapper shadow`).toBe("none");
  }
  // Hover resolves to the same treatment on both.
  await userEvent.hover(providerButton);
  const providerHover = await triggerStyle(providerButton);
  await userEvent.hover(model);
  const modelHover = await triggerStyle(model);
  expect(providerHover.background, `${provider}/${theme} hover fill`).toBe(modelHover.background);
  expect(providerHover.radius).toBe(modelHover.radius);
  await userEvent.unhover(model);
  // Keyboard focus draws one outline that follows the same corners.
  for (const element of [providerButton, model]) {
    // :focus-visible is a keyboard affordance. Earlier cases use real pointer
    // input, so establish keyboard modality rather than assuming .focus()
    // after a mouse interaction will display a keyboard outline.
    await browserUserEvent.keyboard("{Tab}");
    element.focus();
    expect(element).toHaveFocus();
    expect(element.matches(":focus-visible")).toBe(true);
    const style = getComputedStyle(element);
    expect(style.outlineStyle, `${provider}/${theme} focus outline`).toBe("solid");
    expect(style.borderTopLeftRadius).toBe(idle.provider.radius);
  }
  // Expanded: both get the same accent edge and ring.
  await userEvent.click(providerButton);
  await waitFor(() => expect(providerButton).toHaveAttribute("aria-expanded", "true"));
  const providerOpen = await triggerStyle(providerButton);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(document.body);
  await userEvent.click(model);
  await waitFor(() => expect(view.container.querySelector(".composer .openrouter-picker.open, .composer .model-power-control.menu-open")).not.toBeNull());
  const modelOpen = await triggerStyle(model);
  expect(providerOpen.borderColor, `${provider}/${theme} expanded edge`).toBe(modelOpen.borderColor);
  expect(providerOpen.boxShadow, `${provider}/${theme} expanded ring`).toBe(modelOpen.boxShadow);
  expect(providerOpen.boxShadow).not.toBe("none");
  if (theme === "mythra" && provider === "claude") await page.screenshot({ path: "../test-results/lumen/composer-claude-mythra-open.png" });
});

it("keeps the dock-open header usable after the navigator is widened", async () => {
  await page.viewport(1500, 1000);
  await commands.setStreamTestReducedMotion(true);
  localStorage.setItem("kiwi.paneSizes", JSON.stringify({ sidebar: 360, dock: 520 }));
  const view = await renderApp({ theme: "atari" });
  await openDock();
  expectHeaderUsable(view.container, "wide navigator and dock");
});

/** Model a renderer without container queries, while retaining the rest of
 * its real stylesheet. Modern Playwright is not an actual Safari 13 runtime. */
function withoutContainerQueries() {
  const restore: (() => void)[] = [];
  function visit(parent: CSSStyleSheet | CSSGroupingRule) {
    for (let index = parent.cssRules.length - 1; index >= 0; index--) {
      const rule = parent.cssRules[index];
      if (rule.cssText.startsWith("@container")) {
        const text = rule.cssText;
        parent.deleteRule(index);
        restore.push(() => parent.insertRule(text, index));
      } else if (rule instanceof CSSSupportsRule && /not\s*\(container-type:/.test(rule.conditionText)) {
        // Activate the production fallback as an old renderer would do.
        const fallback = rule.cssText.replace(/^@supports[^\{]+/, "@supports (display: block) ");
        parent.insertRule(fallback, index + 1);
        restore.push(() => parent.deleteRule(index + 1));
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        visit(rule);
      }
    }
  }
  for (const sheet of document.styleSheets) visit(sheet);
  return () => restore.reverse().forEach((undo) => undo());
}

it.each([
  { width: 1500, uiScale: 100 }, { width: 1500, uiScale: 125 },
  { width: 1500, uiScale: 150 }, { width: 980, uiScale: 150 },
])("keeps every header action reachable without container queries ($width px, $uiScale%)", async ({ width, uiScale }) => {
  await page.viewport(width, 1000);
  await commands.setStreamTestReducedMotion(true);
  const view = await renderApp({ project: LONG_PROJECT, theme: "mythra", provider: "claude", uiScale });
  const actions = headerControls(view.container.querySelector(".topbar")!).map(accessibleName).sort();
  const restore = withoutContainerQueries();
  try {
    expectHeaderUsable(view.container, "without container queries, dock closed");
    expect(headerControls(view.container.querySelector(".topbar")!).map(accessibleName).sort()).toEqual(actions);
    await openDock();
    expectHeaderUsable(view.container, "without container queries, dock open");
    for (const name of ["Open command palette", "Close workspace tools"]) {
      expect(headerControls(view.container.querySelector(".topbar")!).some((control) => accessibleName(control).includes(name)), name).toBe(true);
    }
  } finally {
    restore();
  }
});

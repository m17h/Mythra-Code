import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import type { Project } from "./types";

// Actual App in a browser; native APIs are stubbed and no provider runs occur.

const PROJECT = { id: "project-header", name: "Mythra Code", path: "/projects/mythra-code" };


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
      if (method === "thread/list") return { data: [], nextCursor: null };
      if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
      if (method === "account/rateLimits/read") return { rateLimits: {} };
      if (method === "model/list") return { data: [] };
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
const folderOpen = vi.fn<(path: unknown) => unknown>(() => null);

beforeEach(() => {
  localStorage.clear();
  claudeSignedIn = false;
  folderOpen.mockReset().mockReturnValue(null);
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
  localStorage.setItem("kiwi.settings", JSON.stringify({ subagentsEnabled: true, childAgents: { enabled: true, targets: [{ id: "sol", provider: "openai", model: "gpt-6-sol", label: "Sol", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "high", reasoningMaxEffort: "max" }] }, provider, theme, uiScale, ...(model ? { model } : {}), ...(effortSlider ? { effortSlider } : {}) }));
  // App reads persisted settings and projects at module scope, and browser
  // mode does not re-evaluate modules after vi.resetModules(). A unique query
  // gives every scenario a fresh App module (fresh theme, scale and projects).
  const url = `./App.tsx?subagents-case=${++appInstance}`;
  const { default: App } = await import(/* @vite-ignore */ url) as typeof import("./App");
  const view = render(<App />);
  expect(view.container.querySelector(".app-shell")).toHaveAttribute("data-theme", project.overrides?.defaults?.theme ?? theme);
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
  await waitFor(() => expect(view.container.querySelector(".project-run-control")).not.toBeNull(), { timeout: 10_000 });
  return view;
}

it.each(["openai", "claude", "cursor", "openrouter", "lmstudio"])("starts new %s drafts off despite enabled app defaults", async (provider) => {
  await renderApp({ provider });
  expect(await screen.findByRole("button", { name: "Sub-agents off" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Sub-agents off" }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByTitle("Start a thread in Mythra Code"));
  expect(await screen.findByRole("button", { name: "Sub-agents off" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Sub-agents off" }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  await waitFor(() => expect(screen.getByText(/^1 configured ·/)).toBeVisible());
});

it("starts off despite a project's enabled override and resets when switching to Chats", async () => {
  const childAgents = { enabled: true, targets: [{ id: "sol", provider: "openai" as const, model: "gpt-6-sol", label: "Sol", description: "", enabled: true, reasoningMode: "inherit" as const, reasoningEffort: "high" as const, reasoningMaxEffort: "max" as const }] };
  await renderApp({ provider: "openai", project: { ...PROJECT, overrides: { subagents: { enabled: true, maxConcurrent: 1, childAgents } } } });
  await userEvent.click(await screen.findByRole("button", { name: "Sub-agents off" }));
  await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: /Chats/ }));
  expect(await screen.findByRole("button", { name: "Sub-agents off" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Mythra Code" }));
  expect(await screen.findByRole("button", { name: "Sub-agents off" })).toBeVisible();
});

it("keeps newly configured agents for the next thread without carrying over its opt-in", async () => {
  await renderApp({ provider: "openai" });
  await userEvent.click(await screen.findByRole("button", { name: "Sub-agents off" }));
  await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(screen.getByRole("button", { name: "Add OpenAI sub-agent" }));
  await waitFor(() => expect(screen.getByText(/^2 configured ·/)).toBeVisible());
  await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByTitle("Start a thread in Mythra Code"));
  await userEvent.click(await screen.findByRole("button", { name: "Sub-agents off" }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  await waitFor(() => expect(screen.getByText(/^2 configured ·/)).toBeVisible());
});

it("does not rewrite legacy app-wide enablement when switching only this draft on and off", async () => {
  await renderApp({ provider: "openai" });
  await userEvent.click(await screen.findByRole("button", { name: "Sub-agents off" }));
  const toggle = screen.getByRole("switch", { name: "Allow sub-agent spawning" });
  await userEvent.click(toggle);
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).subagentsEnabled).toBe(true);
});

it("keeps the user's deliberate opt-in when choosing another provider for the same unsent prompt", async () => {
  claudeSignedIn = true;
  await renderApp({ provider: "openai" });
  await userEvent.click(await screen.findByRole("button", { name: "Sub-agents off" }));
  await userEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(screen.getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^Claude/ }));
  await screen.findByRole("button", { name: "New thread provider: Claude" });
  expect(screen.queryByRole("button", { name: "Sub-agents off" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ }));
  expect(screen.getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import type { OfficialSkill } from "./lib/skills";

const entry: OfficialSkill = { id: "anthropic-design", publisher: "anthropic", title: "Frontend design", description: "Build interfaces", repository: "anthropics/skills", path: "skills/frontend-design", revision: "a".repeat(40), license: "Apache-2.0", notes: "Requires file editing tools." };
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => false, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({ ...(await importOriginal<object>()), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => () => {}) }) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.0.0-test") }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: vi.fn(async () => false), requestPermission: vi.fn(async () => "denied"), sendNotification: vi.fn() }));
vi.mock("./components/XtermPanel", () => ({ XtermPanel: () => null }));

function stubInvoke(command: string, args?: Record<string, unknown>): unknown {
  if (command === "codex_runtime_status" || command === "codex_runtime_status_refresh") return { available: true, source: "Codex CLI", path: "/fixture/codex", runningPath: "/fixture/codex", dataHome: "/fixture/profile", version: "99.0.0", runningVersion: "99.0.0", runningCommands: 0, runtimeChanged: false, compatible: true, warning: null };
  if (command === "local_skills_catalog") return [entry];
  if (command === "local_skills_scan" || command === "cursor_models" || command === "github_pr_list" || command === "local_transcript_list" || command === "audit_recent") return [];
  if (command === "local_skills_sync") return "/fixture/runtime-skills";
  if (command === "claude_models" || command === "list_lmstudio_models") return { models: [] };
  if (command === "has_openrouter_key") return false;
  if (command === "preference_learning_list") return { scopes: [], creationRevision: 0 };
  if (command === "normal_chat_workspace") return "/fixture/chats";
  if (command === "runtime_instance") return "fixture-runtime";
  if (command === "runtime_thread_state") return { instance: "fixture-runtime", loaded: false };
  if (command === "codex_rpc") {
    const method = args?.method;
    if (method === "thread/list" || method === "model/list") return { data: [], nextCursor: null };
    if (method === "account/read") return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
    if (method === "account/rateLimits/read") return { rateLimits: {} };
    if (method === "fs/readDirectory") return { entries: [] };
    if (method === "fuzzyFileSearch") return { files: [] };
    if (method === "gitDiffToRemote") return { diff: "" };
    return {};
  }
  return null;
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem("kiwi.skillsFolder", JSON.stringify("/fixture/skills"));
  localStorage.setItem("kiwi.onboardingVersion", "99");
  localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openai", theme: "mythra" }));
  invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => stubInvoke(command, args));
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => {
  const { resetDraftStoreForTests } = await import("./components/Composer");
  resetDraftStoreForTests();
  localStorage.clear();
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it("retains download progress and a closed-section failure through actual Settings reopening", async () => {
  await page.viewport(900, 900);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "local_skills_install_official") { await pending; throw new Error("Fixture download disconnected"); }
    return stubInvoke(command, args);
  });
  const { default: App } = await import("./App");
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Settings" }));
  let settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(within(settings).getByRole("button", { name: "Skills" }));
  let summary = within(settings).getByText("Download Anthropic & OpenAI skills");
  summary.focus();
  await userEvent.keyboard("{Enter}");
  await userEvent.click(await within(settings).findByRole("button", { name: "Install Frontend design" }));
  await userEvent.click(summary);
  await userEvent.click(summary);
  expect(await within(settings).findByRole("button", { name: "Installing Frontend design" })).toBeDisabled();
  expect(within(settings).getByText("Installing…").closest("li")).toHaveAttribute("aria-busy", "true");
  await userEvent.click(within(settings).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(within(settings).getByRole("button", { name: "Skills" }));
  summary = within(settings).getByText("Download Anthropic & OpenAI skills");
  if (!summary.closest("details")!.open) await userEvent.click(summary);
  expect(await within(settings).findByRole("button", { name: "Installing Frontend design" })).toBeDisabled();
  await userEvent.click(summary);
  await act(async () => finish());
  expect(await within(settings).findByRole("alert")).toHaveTextContent("Fixture download disconnected");
  await userEvent.click(summary);
  expect(await within(settings).findByRole("alert")).toHaveTextContent("Fixture download disconnected");
  expect(within(settings).getAllByRole("alert")).toHaveLength(1);
  expect(within(settings).getByRole("button", { name: "Install Frontend design" })).toBeEnabled();
  expect(invoke.mock.calls.filter(([command]) => command === "local_skills_install_official")).toHaveLength(1);
  const engine = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ path: `../test-results/official-skills/${engine}-app-download-lifecycle.png` });
});

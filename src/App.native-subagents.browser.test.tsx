import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import type { Thread } from "./types";
import type { AgentRecord } from "./components/StudioDock";
import type { NativeAgentLink } from "./lib/nativeAgentLinks";
import { resetTaskStore, useTaskStore } from "./lib/taskStore";
import { forgetSubagentCapabilities } from "./lib/threadCapabilities";
import { resetNewThreadTimedPromptsForTests, useNewThreadTimedPrompts } from "./lib/newThreadTimedPrompts";
import { dateInputValue } from "./lib/timedPrompts";
import { preferenceLearningFixture } from "./test/preferenceLearningFixture";
import { officialPricingSnapshot, recordOfficialPricingResult, refreshOfficialPricing } from "./lib/officialPricing";
import { OFFICIAL_PRICING_KEY, resetUsageLedgerCache } from "./lib/usageLedger";

// Actual App and composer in browser engines. Native commands and provider RPCs
// are explicit fixtures: this verifies App wiring, never CLI capability or quota.
const PROJECT = { id: "native-project", name: "Native fixture", path: "/projects/native-fixture" };
const ROOT: Thread = { id: "native-root", name: "Native root", preview: "Existing conversation", cwd: PROJECT.path, updatedAt: 1, modelProvider: "openai", turns: [] };
const TARGET = { id: "sol", provider: "openai", model: "gpt-6-sol", label: "Retained Sol", description: "", enabled: true, reasoningMode: "inherit", reasoningEffort: "high", reasoningMaxEffort: "max" };
type Call = { command: string; args?: Record<string, unknown> };
let calls: Call[] = [];
let inbox: Thread[] = [];
let instance = "runtime-native-1";
let loaded = false;
let runtimeVersion = "99.0.0";
let claudeVersion = "2.1.267";
let runtimeEpoch = 1;
let restartReservation: string | null = null;
let appInstance = 0;
let refreshedCodexModelAvailable = false;
let publishedClaudeModelsAvailable = false;
const learnedFixture = preferenceLearningFixture();
const capturedPricing = import.meta.glob<string>("../node_modules/.cache/pricing/*.md", { query: "?raw", import: "default", eager: true });
const capturedPricingPage = (source: string) => Object.entries(capturedPricing).find(([path]) => path.endsWith(`/${source}.md`))?.[1];

async function seedCompactionPricing() {
  if (capturedPricingPage("openai") && capturedPricingPage("anthropic")) {
    await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)! });
    return;
  }
  // CI has no private capture cache. This explicitly synthetic positive-rate
  // catalog verifies a published-band shape, never real provider prices.
  recordOfficialPricingResult("anthropic", { ok: true, models: {
    "claude-haiku-5-5": { name: "Fixture Haiku 5.5", input: 1, output: 1, asOf: "2026-10-09", longContext: { input: 2, output: 2, asOf: "2026-10-09" }, longContextThresholdTokens: 100_000 },
  } });
}

async function captureDevelopmentUi(name: string) {
  const stamp = document.createElement("div");
  stamp.textContent = "Development UI · Demonstration data · No paid provider calls";
  Object.assign(stamp.style, { position: "fixed", top: "8px", right: "12px", zIndex: "2147483647", padding: "5px 9px", background: "#252a30", color: "#ffffff", border: "1px solid #708095", borderRadius: "6px", font: "11px system-ui", pointerEvents: "none" });
  document.body.append(stamp);
  try {
    const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
    await page.screenshot({ path: `../test-results/development-ui-${name}-${browser}.png` });
  } finally { stamp.remove(); }
}

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
    case "fetch_pricing_document": return capturedPricingPage(String(args?.source));
    case "preference_learning_list":
    case "preference_learning_forget":
    case "preference_learning_save": return learnedFixture.invoke(command, args);
    case "codex_runtime_status":
    case "codex_runtime_status_refresh": return { available: true, source: "Codex CLI", path: "/fixture/codex", runningPath: "/fixture/codex", dataHome: "/fixture/codex-home", version: runtimeVersion, runningVersion: runtimeVersion, runningCommands: 0, runtimeChanged: false, compatible: true, warning: null };
    case "claude_runtime_status": return { available: true, path: "/fixture/claude", version: claudeVersion, loggedIn: true, authMethod: "subscription", email: "fixture@example.com", subscriptionType: "max", warning: null };
    case "cursor_runtime_status": return null;
    case "normal_chat_workspace": return "/chats";
    case "runtime_instance": return instance;
    case "runtime_thread_state": return { instance, loaded };
    case "reserve_runtime_restart": restartReservation = `fixture-reservation-${runtimeEpoch}`; return restartReservation;
    case "restart_runtime_reserved":
      expect(args?.token).toBe(restartReservation);
      expect(restartReservation).not.toBeNull();
      instance = `runtime-native-${++runtimeEpoch}`; loaded = false; return null;
    case "release_runtime_restart":
      expect(args?.token).toBe(restartReservation);
      restartReservation = null; return null;
    case "restart_runtime": instance = `runtime-native-${++runtimeEpoch}`; loaded = false; return null;
    case "local_skills_scan":
    case "local_transcript_list":
    case "audit_recent":
    case "github_pr_list":
    case "cursor_models": return [];
    case "local_skills_sync": return "/fixture/skills";
    case "claude_models": return { models: publishedClaudeModelsAvailable ? [
      { value: "claude-opus-5-5", displayName: "Fixture Opus 5.5", resolvedModel: "claude-opus-5-5", description: "Demonstration Opus model" },
      { value: "claude-haiku-5-5", displayName: "Fixture Haiku 5.5", resolvedModel: "claude-haiku-5-5", description: "Demonstration Haiku model" },
    ] : [] };
    case "list_lmstudio_models": return { models: [] };
    case "claude_turn_start": return { turnId: "fixture-claude-turn" };
    case "local_transcript_snapshot_write":
    case "local_transcript_tail_write":
    case "local_transcript_metadata_write": return { generation: 1, headSeq: 1, tailSeq: 2 };
    case "checkpoint_create": return { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3, branch: "fixture-only", head: "a".repeat(40) };
    case "checkpoint_complete": return { snapshot: { commit: "b".repeat(40), repoRoot: PROJECT.path, fileCount: 3 }, changedFiles: 0, additions: 0, deletions: 0 };
    case "has_openrouter_key": return false;
    case "github_status": return { available: false, authenticated: false };
    case "github_repo_status": return { isRepo: false };
    case "workspace_git_info": return { isRepo: false, isRoot: false, hasCommit: false };
    case "git_project_diff": return { text: "", source: "repository", baseline: "HEAD", untrackedPaths: [], truncated: false };
    case "git_project_changes": return { rootPath: PROJECT.path, rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    case "git_project_history": return { entries: [], hasMore: false, nextOffset: 0, headOid: "a".repeat(40), truncated: false };
    case "child_agent_session_start": {
      const options = args?.options as Record<string, unknown>;
      const native = options.nativeDelegation === true;
      const targets = options.targets as unknown[];
      return { name: "fixture_project_tools", command: "/fixture/bridge", args: [], configPath: `/fixture/${native ? "native" : "mythra"}-bridge.json`, toolNames: ["set_project_run_command", "set_project_check_command", ...(native ? [] : ["propose_agent_settings", ...(targets?.length ? ["spawn_mythra_agent"] : [])])] };
    }
    case "codex_rpc": {
      const params = (args?.params ?? {}) as Record<string, unknown>;
      switch (args?.method) {
        case "account/read": return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
        case "account/rateLimits/read": return { rateLimits: {} };
        case "model/list": return { data: [{ id: "gpt-6-sol", model: "gpt-6-sol", displayName: "Fixture Sol", description: "Fixture parent model", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }, { reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "medium", isDefault: true }, { id: "gpt-6.1-luna", model: "gpt-6.1-luna", displayName: "Fixture Luna", description: "Fixture child model", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", isDefault: false }, ...(refreshedCodexModelAvailable ? [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Refreshed fixture Sol", description: "Demonstration newly discovered model", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", isDefault: false }] : [])] };
        case "thread/list": return { data: inbox, nextCursor: null };
        case "thread/start": inbox = [ROOT]; loaded = true; return { thread: ROOT };
        case "thread/read": return { thread: { ...ROOT, id: String(params.threadId), turns: [] } };
        case "thread/turns/list": return { data: [], nextCursor: null };
        case "thread/resume": loaded = true; return { thread: { ...ROOT, id: String(params.threadId) } };
        case "thread/fork": return { thread: { ...ROOT, id: "native-fork", name: "Forked root" } };
        case "turn/start": return { turn: { id: `fixture-turn-${rpcCalls("turn/start").length}`, status: "inProgress", items: [] } };
        case "fs/readDirectory": return { entries: [] };
        case "fuzzyFileSearch": return { files: [] };
        case "gitDiffToRemote": return { diff: "" };
        default: return {};
      }
    }
    default: return null;
  }
}

function rpcCalls(method: string): Record<string, unknown>[] {
  return calls.filter((call) => call.command === "codex_rpc" && call.args?.method === method).map((call) => call.args?.params as Record<string, unknown>);
}

function runtimeRestarts(): Call[] {
  return calls.filter((call) => call.command === "restart_runtime" || call.command === "restart_runtime_reserved");
}

function expectReservedRestart(): void {
  expect(runtimeRestarts()).toHaveLength(1);
  const reservation = calls.findIndex((call) => call.command === "reserve_runtime_restart");
  const restart = calls.findIndex((call) => call.command === "restart_runtime_reserved");
  const release = calls.findIndex((call) => call.command === "release_runtime_restart");
  expect(reservation).toBeGreaterThan(-1);
  expect(restart).toBeGreaterThan(reservation);
  expect(release).toBeGreaterThan(restart);
  expect(calls[restart].args?.token).toEqual(expect.any(String));
  expect(calls[release].args?.token).toBe(calls[restart].args?.token);
  expect(calls.findIndex((call, index) => index > restart && call.command === "codex_rpc" && call.args?.method === "thread/resume")).toBeGreaterThan(release);
}

beforeEach(async () => {
  localStorage.clear();
  resetTaskStore();
  resetNewThreadTimedPromptsForTests();
  forgetSubagentCapabilities();
  learnedFixture.reset();
  const { resetDraftStoreForTests } = await import("./components/Composer");
  resetDraftStoreForTests();
  calls = []; inbox = []; instance = "runtime-native-1"; loaded = false; runtimeVersion = "99.0.0"; claudeVersion = "2.1.267"; runtimeEpoch = 1; restartReservation = null;
  refreshedCodexModelAvailable = false;
  publishedClaudeModelsAvailable = false;
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => { resetTaskStore(); resetNewThreadTimedPromptsForTests(); forgetSubagentCapabilities(); localStorage.clear(); await commands.setStreamTestReducedMotion(false); await page.viewport(1400, 900); });

async function renderApp(stored: Record<string, unknown> = {}, theme = "mythra", uiScale = 100) {
  localStorage.setItem("kiwi.projects", JSON.stringify([PROJECT]));
  localStorage.setItem("kiwi.workspaceMode", JSON.stringify("project"));
  localStorage.setItem("kiwi.onboardingVersion", "99");
  localStorage.setItem("kiwi.settings", JSON.stringify({ provider: "openai", model: "gpt-6-sol", theme, uiScale, subagentsEnabled: true, subagentEngine: "native", nativeSubagentMax: 9, childAgents: { enabled: true, targets: [TARGET] } }));
  for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, JSON.stringify(value));
  const { default: App } = await import(/* @vite-ignore */ `./App.tsx?native-case=${++appInstance}`) as typeof import("./App");
  // Production main.tsx mounts in #root; its stylesheet supplies the full
  // viewport height. An anonymous auto-height test container is not equivalent.
  const mount = document.createElement("div");
  mount.id = "root";
  document.body.append(mount);
  const view = render(<App />, { container: mount });
  await screen.findByRole("button", { name: "Open workspace tools" }, { timeout: 10_000 });
  await screen.findByRole("button", { name: "Sub-agents off" });
  return view;
}

async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ }));
  return screen.findByRole("dialog", { name: "Sub-agent command center" });
}
async function enableNative(max = 6) {
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Codex/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  for (let count = 6; count < max; count++) await userEvent.click(within(panel).getByRole("button", { name: "More concurrent native agents" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
}
function composer() { return screen.getByPlaceholderText(/^(?:Ask Mythra Code to work in|Queue a follow-up for after this run)/); }
async function send(text: string) { await userEvent.type(composer(), text); await userEvent.click(screen.getByRole("button", { name: "Send" })); }
async function finishRoot() { await act(async () => { useTaskStore.getState().setActiveTurn(ROOT.id, undefined); useTaskStore.getState().setTaskStatus(ROOT.id, "completed"); }); }
function expectNativeConfig(params: Record<string, unknown>, max: number) {
  const config = params.config as Record<string, unknown>;
  // Codex V2's session budget includes its primary agent; the user's native
  // limit and canonical agents settings describe admitted child agents.
  expect(config).toMatchObject({ model_provider: "openai", agents: { enabled: true, max_threads: max, max_concurrent_threads_per_session: max }, features: { multi_agent: true, multi_agent_v2: { enabled: true, expose_spawn_agent_model_overrides: true, max_concurrent_threads_per_session: max + 1 } } });
  // The native instruction explicitly prohibits the Mythra spawn tool; naming
  // that prohibition is not evidence of exposing the tool.
  expect(params.developerInstructions).toContain("mixed-provider crew is not active: do not use spawn_mythra_agent");
  expect(JSON.stringify(params)).not.toContain("propose_agent_settings");
}

async function chooseNativeOption(label: string, choice: RegExp) {
  await userEvent.click(screen.getByRole("button", { name: label }));
  const menu = await screen.findByRole("menu", { name: `${label} choices` });
  await userEvent.click(within(menu).getByRole("menuitemradio", { name: choice }));
}
async function configureCodexOptions() {
  await chooseNativeOption("Default child model", /^Fixture Luna/);
  await chooseNativeOption("Default child reasoning", /^High/);
  await chooseNativeOption("Conversation compaction", /^200K tokens$/);
}
function expectNoNativeOverrides(params: Record<string, unknown>, parentWindow?: number) {
  const config = params.config as Record<string, unknown>;
  if (parentWindow === undefined) {
    expect(config).not.toHaveProperty("model_auto_compact_token_limit");
    expect(config).not.toHaveProperty("model_auto_compact_token_limit_scope");
  } else {
    expect(config).toMatchObject({ model_auto_compact_token_limit: parentWindow, model_auto_compact_token_limit_scope: "total" });
  }
  expect(config.agents).not.toHaveProperty("default_subagent_model");
  expect(config.agents).not.toHaveProperty("default_subagent_reasoning_effort");
}

function nativeReadoutValue(row: HTMLElement, label: string): HTMLElement {
  return within(row).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

function expectNativePanelBounds(panel: HTMLElement): DOMRect {
  const panelRect = panel.getBoundingClientRect();
  const geometry = JSON.stringify({ panel: panelRect.toJSON(), viewport: { width: window.innerWidth, height: window.innerHeight }, placement: panel.dataset.placement, fittedMaxHeight: panel.style.getPropertyValue("--sa-panel-max-height"), zoom: getComputedStyle(panel).zoom });
  expect(panelRect.left, geometry).toBeGreaterThanOrEqual(0);
  expect(panelRect.right, geometry).toBeLessThanOrEqual(window.innerWidth);
  expect(panelRect.top, geometry).toBeGreaterThanOrEqual(0);
  expect(panelRect.bottom, geometry).toBeLessThanOrEqual(window.innerHeight);
  for (const control of panel.querySelectorAll<HTMLElement>("button, label, strong, small")) {
    // Select menus intentionally float outside the pane; their viewport and
    // item/text containment are checked separately in the menu regressions.
    if (control.closest("[role='menu']")) continue;
    const rect = control.getBoundingClientRect();
    if (!rect.width) continue;
    expect(rect.left, `${control.textContent}: ${geometry}`).toBeGreaterThanOrEqual(panelRect.left);
    expect(rect.right, `${control.textContent}: ${geometry}`).toBeLessThanOrEqual(panelRect.right);
  }
  return panelRect;
}

async function revealNativeReadout(panel: HTMLElement, row: HTMLElement): Promise<void> {
  row.querySelector<HTMLElement>(".sa-worker-details")!.scrollIntoView({ block: "nearest" });
  await commands.setStreamTestReducedMotion(true);
  const panelRect = expectNativePanelBounds(panel);
  for (const field of row.querySelectorAll<HTMLElement>("dd")) {
    const rect = field.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(panelRect.top);
    expect(rect.bottom).toBeLessThanOrEqual(panelRect.bottom);
    expect(rect.left).toBeGreaterThanOrEqual(panelRect.left);
    expect(rect.right).toBeLessThanOrEqual(panelRect.right);
  }
}

it("starts off with Mythra selected despite native app defaults, and retains the crew across mode switches", async () => {
  await renderApp();
  let panel = await openPanel();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(within(panel).getByText("Retained Sol")).toBeVisible();
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/native-real-app-mythra-pane-${browser}.png` });
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Codex/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(within(panel).queryByText("Retained Sol")).toBeNull();
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "More concurrent native agents" }));
  await userEvent.click(within(panel).getByRole("radio", { name: /Mythra Code/ }));
  expect(within(panel).getByText("Retained Sol")).toBeVisible();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  expect(within(panel).getByLabelText("Maximum concurrent native agents")).toHaveTextContent("7");
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/native-real-app-native-pane-${browser}.png` });
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByTitle("Start a thread in Native fixture"));
  panel = await openPanel();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(JSON.parse(localStorage.getItem("kiwi.settings")!).nativeSubagentMax).toBe(9);
});

it("dispatches native-only startup config and persists the choice on the created thread", async () => {
  await renderApp(); await enableNative(7); await send("Delegate the fixture task");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expectNativeConfig(rpcCalls("thread/start")[0], 7);
  const bridges = calls.filter((call) => call.command === "child_agent_session_start");
  expect(bridges).toHaveLength(1);
  expect(bridges[0].args?.options).toMatchObject({ nativeDelegation: true, targets: [] });
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id]).toEqual({ enabled: true, engine: "native", nativeMaxConcurrent: 7 });
  await finishRoot();
  await userEvent.click(screen.getByTitle("Start a thread in Native fixture"));
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  expectNativeConfig(rpcCalls("thread/resume")[0], 7);
  const panel = await openPanel();
  expect(within(panel).getByRole("radio", { name: /Native Codex/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeChecked();
});

it("preserves a captured Mythra crew while native turns run and restores it when switching back", async () => {
  await renderApp();
  let panel = await openPanel();
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Capture the Mythra fixture crew");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  const captured = Object.values(JSON.parse(localStorage.getItem("kiwi.childAgentPolicies")!)) as { targets: unknown[] }[];
  expect(captured).toHaveLength(1);
  expect(captured[0].targets).toEqual([TARGET]);
  await finishRoot();
  panel = await openPanel();
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Run the native fixture turn");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(2));
  expectNativeConfig(rpcCalls("thread/resume").at(-1)!, 6);
  expect(Object.values(JSON.parse(localStorage.getItem("kiwi.childAgentPolicies")!))).toEqual(captured);
  await finishRoot();
  panel = await openPanel();
  await userEvent.click(within(panel).getByRole("radio", { name: /Mythra Code/ }));
  expect(within(panel).getByText("Retained Sol")).toBeVisible();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Restore the Mythra fixture crew");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(3));
  const restoredBridge = calls.filter((call) => call.command === "child_agent_session_start").at(-1)!;
  expect(restoredBridge.args?.options).toMatchObject({ targets: [{ id: TARGET.id, provider: TARGET.provider, model: TARGET.model, label: TARGET.label, reasoningMode: TARGET.reasoningMode, reasoningEffort: TARGET.reasoningEffort, reasoningMaxEffort: TARGET.reasoningMaxEffort }] });
  expect((restoredBridge.args?.options as Record<string, unknown>).nativeDelegation).toBeUndefined();
  expect(rpcCalls("thread/resume").at(-1)!.config).toMatchObject({ agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: false } });
});

it.each(["mythra", "atari"])("keeps both engine controls inside the narrow %s composer", async (theme) => {
  await page.viewport(900, 760);
  await renderApp({}, theme);
  await enableNative();
  const panel = await openPanel();
  const rect = panel.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(within(panel).getByRole("radio", { name: /Native Codex/ }).closest("label")).toBeVisible();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ }).closest("label")).toBeVisible();
  expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
});

it("locks the parent's native controls while its native child is still working", async () => {
  inbox = [ROOT];
  await renderApp({ "kiwi.nativeAgentLinks": { child: { childThreadId: "child", rootThreadId: ROOT.id, title: "Busy fixture child", path: PROJECT.path, createdAt: 1, provider: "openai", runtime: "codex", status: "running" } }, "kiwi.threadSubagentSettings": { [ROOT.id]: { enabled: true, engine: "native", nativeMaxConcurrent: 4 } } });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  const panel = await openPanel();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeDisabled();
  expect(within(panel).getByRole("radio", { name: /Native Codex/ })).toBeDisabled();
  expect(within(panel).queryByRole("button", { name: "More concurrent native agents" })).toBeNull();
  expect(within(panel).getByLabelText("Native agent limit 4")).toBeVisible();
  expect(within(panel).getByText("Busy fixture child")).toBeVisible();
});

it("defers a changed loaded runtime while another thread runs and preserves the unsent prompt", async () => {
  await renderApp(); await enableNative(); await send("First fixture prompt");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1)); await finishRoot();
  const panel = await openPanel();
  await userEvent.click(within(panel).getByRole("button", { name: "More concurrent native agents" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await act(async () => { useTaskStore.getState().ensureTask("other-runtime-root", "/projects/other"); useTaskStore.getState().setTaskStatus("other-runtime-root", "running"); });
  await send("Keep this prompt until the other thread finishes");
  await screen.findByText(/Your message was not sent;/);
  expect(composer()).toHaveValue("Keep this prompt until the other thread finishes");
  expect(rpcCalls("turn/start")).toHaveLength(1);
  expect(runtimeRestarts()).toHaveLength(0);
  await act(async () => { useTaskStore.getState().setTaskStatus("other-runtime-root", "completed"); });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(2));
  expectReservedRestart();
  expectNativeConfig(rpcCalls("thread/resume").at(-1)!, 7);
  expect(composer()).toHaveValue("");
});

it("delivers a scheduled first prompt with its captured native authority after the new draft resets off", async () => {
  await renderApp(); await enableNative(7);
  const optionsPanel = await openPanel();
  await configureCodexOptions();
  await userEvent.click(within(optionsPanel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.type(composer(), "Deferred native fixture task");
  await userEvent.click(screen.getByRole("button", { name: "Schedule this prompt" }));
  const dialog = await screen.findByRole("dialog", { name: "Schedule prompt" });
  await userEvent.clear(within(dialog).getByLabelText("Date"));
  await userEvent.type(within(dialog).getByLabelText("Date"), dateInputValue(Date.now() + 86_400_000));
  await userEvent.click(within(dialog).getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(Object.values(useNewThreadTimedPrompts.getState().prompts).flat()).toHaveLength(1));
  const entry = Object.values(useNewThreadTimedPrompts.getState().prompts).flat()[0];
  expect(entry.snapshot).toMatchObject({ subagentsEnabled: true, subagentEngine: "native", nativeSubagentMax: 7, autoCompactTokens: 200_000, nativeSubagentOptions: { codex: { model: "gpt-6.1-luna", reasoningEffort: "high" } } });
  await userEvent.click(screen.getByTitle("Start a thread in Native fixture"));
  const panel = await openPanel();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(rpcCalls("thread/start")).toHaveLength(0);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: /Scheduled · new conversations/ }));
  await userEvent.click(screen.getByRole("button", { name: "Start now new conversation 1" }));
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expectNativeConfig(rpcCalls("thread/start")[0], 7);
  expect(rpcCalls("thread/start")[0].config).toMatchObject({ model_auto_compact_token_limit: 200_000, agents: { default_subagent_model: "gpt-6.1-luna", default_subagent_reasoning_effort: "high" } });
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id]).toEqual({ enabled: true, engine: "native", nativeMaxConcurrent: 7, autoCompactTokens: 200_000, nativeOptions: { codex: { model: "gpt-6.1-luna", reasoningEffort: "high" } } });
});

it("forks a native conversation with native tools disabled and a fresh off composer", async () => {
  inbox = [ROOT];
  await renderApp({ "kiwi.threadSubagentSettings": { [ROOT.id]: { enabled: true, engine: "native", nativeMaxConcurrent: 7 } } });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Open workspace tools" }));
  await userEvent.click(await screen.findByRole("tab", { name: "Checkpoints workspace tool" }));
  await userEvent.click(screen.getByRole("button", { name: "Fork thread" }));
  await waitFor(() => expect(rpcCalls("thread/fork")).toHaveLength(1));
  expect(rpcCalls("thread/fork")[0].config).toMatchObject({ agents: { enabled: false, max_threads: 1 }, features: { multi_agent: false, multi_agent_v2: false } });
  await screen.findByRole("button", { name: "Sub-agents off" });
  const panel = await openPanel();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)["native-fork"]).toEqual({ enabled: false, engine: "mythra", nativeMaxConcurrent: 6 });
});

it("explains an unsupported Codex runtime without changing the draft's selected engine", async () => {
  runtimeVersion = "0.160.0";
  await renderApp();
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByText(/require Codex 0\.161\.0 or newer/)).toBeVisible());
  expect(within(panel).getByRole("radio", { name: /Native Codex/ })).toBeDisabled();
  expect(within(panel).getByRole("radio", { name: /Mythra Code/ })).toBeChecked();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expect(rpcCalls("thread/start")).toHaveLength(0);
});

it("dispatches the Claude native limit to its own provider without creating a Codex thread", async () => {
  await renderApp({ "kiwi.settings": { provider: "claude", model: "claude-haiku-4-5", theme: "mythra", childAgents: { enabled: true, targets: [TARGET] } } });
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "More concurrent native agents" }));
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/native-real-app-claude-pane-${browser}.png` });
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Delegate using the fixture Claude runtime");
  await waitFor(() => expect(calls.filter((call) => call.command === "claude_turn_start")).toHaveLength(1));
  const options = calls.find((call) => call.command === "claude_turn_start")!.args?.options as Record<string, unknown>;
  expect(options).toMatchObject({ model: "claude-haiku-4-5", nativeSubagents: true, nativeSubagentMax: 7, subagentMax: 7, childAgentBridgeConfig: "/fixture/native-bridge.json" });
  expect(options.systemPrompt).toContain("Provider-native sub-agent delegation is enabled");
  expect(options.systemPrompt).not.toContain("propose_agent_settings");
  expect(rpcCalls("thread/start")).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[String(options.threadId)]).toEqual({ enabled: true, engine: "native", nativeMaxConcurrent: 7 });
});

it("dispatches an Opus 1M parent and independent native Haiku 100K child window", async () => {
  claudeVersion = "2.1.293";
  await seedCompactionPricing();
  await renderApp({ "kiwi.settings": { provider: "claude", model: "claude-opus-5-5", theme: "mythra", childAgents: { enabled: true, targets: [TARGET] } } });
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await chooseNativeOption("Child model", /^Haiku 5\.5/);
  await chooseNativeOption("Conversation compaction", /^1M tokens/);
  await chooseNativeOption("Child model compaction", /^100K tokens/);
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("1M tokens");
  expect(within(panel).getByRole("button", { name: "Child model compaction" })).toHaveTextContent("100K tokens");
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/compaction-opus-1m-haiku-100k-${browser}.png` });
  await captureDevelopmentUi("claude-opus-1m-haiku-100k");
  expect(within(panel).queryByRole("button", { name: "Default child reasoning" })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Use the selected native Claude fixture options");
  await waitFor(() => expect(calls.filter((call) => call.command === "claude_turn_start")).toHaveLength(1));
  const options = calls.find((call) => call.command === "claude_turn_start")!.args?.options as Record<string, unknown>;
  expect(options).toMatchObject({ model: "claude-opus-5-5", autoCompactTokens: 1_000_000, nativeSubagents: true, nativeSubagentModel: "claude-haiku-5-5", nativeAutoCompactTokens: 100_000, nativeSubagentMax: 6 });
  expect(options).not.toHaveProperty("nativeSubagentReasoningEffort");
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[String(options.threadId)].nativeOptions).toEqual({ claude: { model: "claude-haiku-5-5", autoCompactTokens: 100_000 } });
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[String(options.threadId)].autoCompactTokens).toBe(1_000_000);
  expect(rpcCalls("thread/start")).toHaveLength(0);
});

it("gates Haiku 5.5 on the installed Claude runtime without selecting a substitute model", async () => {
  await renderApp({ "kiwi.settings": { provider: "claude", model: "claude-sonnet-5", theme: "mythra" } });
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Child model" }));
  const menu = await screen.findByRole("menu", { name: "Child model choices" });
  expect(within(menu).getByRole("menuitemradio", { name: /^Haiku 5\.5/ })).toHaveAttribute("aria-disabled", "true");
  expect(within(menu).getByRole("menuitemradio", { name: /^Provider chooses/ })).toHaveAttribute("aria-checked", "true");
  expect(within(panel).getByRole("button", { name: "Child model" })).toHaveTextContent("Provider chooses");
});

it("retains parent 200K compaction after reloading an off conversation at 125% scale", async () => {
  await page.viewport(1050, 760);
  let view = await renderApp({}, "mythra", 125);
  let panel = await openPanel();
  await chooseNativeOption("Conversation compaction", /^200K tokens$/);
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expectNativePanelBounds(panel);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Create an off conversation with its own fixture compaction");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expect(rpcCalls("thread/start")[0].config).toMatchObject({ model_auto_compact_token_limit: 200_000 });
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id]).toMatchObject({ enabled: false, autoCompactTokens: 200_000 });
  await finishRoot();
  const stored = Object.fromEntries(Object.keys(localStorage).map((key) => [key, JSON.parse(localStorage.getItem(key)!)]));
  view.unmount(); view.container.remove();
  view = await renderApp(stored, "mythra", 125);
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("200K tokens");
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeChecked();
  expectNativePanelBounds(panel);
});

it("keeps a Sol 1M parent independent of its Mythra Haiku 100K worker", async () => {
  claudeVersion = "2.1.293";
  await seedCompactionPricing();
  const haiku = { ...TARGET, id: "haiku", provider: "claude", model: "claude-haiku-5-5", label: "Fixture Haiku" };
  await renderApp({ "kiwi.settings": { provider: "openai", model: "gpt-6-sol", theme: "mythra", childAgents: { enabled: true, targets: [haiku] } } });
  let panel = await openPanel();
  await chooseNativeOption("Conversation compaction", /^1M tokens/);
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await captureDevelopmentUi("mythra-sol-1m-haiku-crew-upper");
  await userEvent.click(within(panel).getByRole("button", { name: "Configure Fixture Haiku" }));
  await chooseNativeOption("Compaction for haiku", /^100K tokens/);
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("1M tokens");
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/compaction-sol-1m-mythra-haiku-100k-${browser}.png` });
  await captureDevelopmentUi("mythra-sol-1m-haiku-100k");
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Use the mixed-provider fixture compaction choices");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expect(rpcCalls("thread/start")[0].config).toMatchObject({ model_auto_compact_token_limit: 1_000_000 });
  expect(calls.find((call) => call.command === "child_agent_session_start")!.args?.options).toMatchObject({ targets: [{ id: "haiku", model: "claude-haiku-5-5", autoCompactTokens: 100_000 }] });
  await finishRoot();
  panel = await openPanel();
  await userEvent.click(within(panel).getByRole("button", { name: "Configure Fixture Haiku" }));
  expect(within(panel).getByRole("button", { name: "Compaction for haiku" })).toHaveTextContent("100K tokens");
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("1M tokens");
});

it("applies Codex child defaults and clears them through the guarded runtime refresh", async () => {
  await renderApp(); await enableNative();
  let panel = await openPanel();
  await configureCodexOptions();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Use native Codex fixture preferences");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expect(rpcCalls("thread/start")[0]).toMatchObject({ model: "gpt-6-sol", config: { model_auto_compact_token_limit: 200_000, model_auto_compact_token_limit_scope: "total", agents: { default_subagent_model: "gpt-6.1-luna", default_subagent_reasoning_effort: "high" } } });
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id].nativeOptions).toEqual({ codex: { model: "gpt-6.1-luna", reasoningEffort: "high" } });
  await finishRoot();
  await userEvent.click(screen.getByTitle("Start a thread in Native fixture"));
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  expect(rpcCalls("thread/resume")[0].config).toMatchObject({ model_auto_compact_token_limit: 200_000, agents: { default_subagent_model: "gpt-6.1-luna", default_subagent_reasoning_effort: "high" } });
  panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Default child model" })).toHaveTextContent("Fixture Luna");
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("200K tokens");
  expect(within(panel).getByText("Parent: 200K tokens")).toBeVisible();
  await chooseNativeOption("Default child model", /^Provider chooses/);
  await chooseNativeOption("Default child reasoning", /^Provider default/);
  await chooseNativeOption("Conversation compaction", /^Provider default/);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await act(async () => { useTaskStore.getState().ensureTask("other-runtime-root", "/projects/other"); useTaskStore.getState().setTaskStatus("other-runtime-root", "running"); });
  await send("Preserve this clear-options prompt");
  await screen.findByText(/Your message was not sent;/);
  expect(composer()).toHaveValue("Preserve this clear-options prompt");
  expect(rpcCalls("turn/start")).toHaveLength(1);
  expect(runtimeRestarts()).toHaveLength(0);
  await act(async () => { useTaskStore.getState().setTaskStatus("other-runtime-root", "completed"); });
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(2));
  expectReservedRestart();
  expectNativeConfig(rpcCalls("thread/resume").at(-1)!, 6);
  expectNoNativeOverrides(rpcCalls("thread/resume").at(-1)!);
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id]).not.toHaveProperty("nativeOptions");
});

it("opens the saved thread while a changed native setup waits for another runtime task", async () => {
  await renderApp(); await enableNative(); await send("Create the native fixture thread");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1)); await finishRoot();
  let panel = await openPanel();
  await configureCodexOptions();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByTitle("Start a thread in Native fixture"));
  await act(async () => { useTaskStore.getState().ensureTask("other-runtime-root", "/projects/other"); useTaskStore.getState().setTaskStatus("other-runtime-root", "running"); });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  // Native calls in this fixture resolve immediately. Two rendered frames
  // settle the async selection and its refusal before checking the open view.
  await commands.setStreamTestReducedMotion(true);
  expect(useTaskStore.getState().activeThreadId).toBe(ROOT.id);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(rpcCalls("thread/resume")).toHaveLength(0);
  panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Default child model" })).toHaveTextContent("Fixture Luna");
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Keep this reopened thread's prompt until the shared runtime is idle");
  await screen.findByText(/Your message was not sent;/);
  expect(composer()).toHaveValue("Keep this reopened thread's prompt until the shared runtime is idle");
  expect(rpcCalls("turn/start")).toHaveLength(1);
  expect(runtimeRestarts()).toHaveLength(0);
});

it("applies parent compaction while retaining dormant child preferences in off and Mythra turns", async () => {
  await renderApp(); await enableNative();
  let panel = await openPanel(); await configureCodexOptions();
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  expect(within(panel).getByRole("button", { name: "Default child model" })).toBeDisabled();
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).not.toBeDisabled();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Native options are dormant while off");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expectNoNativeOverrides(rpcCalls("thread/start")[0], 200_000);
  await finishRoot(); panel = await openPanel();
  await userEvent.click(within(panel).getByRole("radio", { name: /Mythra Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Native options are dormant with the Mythra crew");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(2));
  expectNoNativeOverrides(rpcCalls("thread/resume").at(-1)!, 200_000);
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id].nativeOptions).toEqual({ codex: { model: "gpt-6.1-luna", reasoningEffort: "high" } });
});

it("preserves each provider's native choices when switching the unsent draft and clearing only the Claude model", async () => {
  claudeVersion = "2.1.293";
  await renderApp(); await enableNative();
  let panel = await openPanel(); await configureCodexOptions();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^Claude/ }));
  panel = await openPanel();
  await chooseNativeOption("Child model", /^Haiku 5\.5/);
  await chooseNativeOption("Child model compaction", /^200K tokens$/);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: "New thread provider: Claude" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^OpenAI/ }));
  panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Default child model" })).toHaveTextContent("Fixture Luna");
  expect(within(panel).getByRole("button", { name: "Default child reasoning" })).toHaveTextContent("High");
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("200K tokens");
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: "New thread provider: OpenAI" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: /^Claude/ }));
  panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Child model" })).toHaveTextContent("Haiku 5.5");
  expect(within(panel).getByRole("button", { name: "Child model compaction" })).toHaveTextContent("200K tokens");
  await chooseNativeOption("Child model compaction", /^Provider default/);
  await chooseNativeOption("Child model", /^Provider chooses/);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Use Claude defaults without losing saved Codex choices");
  await waitFor(() => expect(calls.filter((call) => call.command === "claude_turn_start")).toHaveLength(1));
  const options = calls.find((call) => call.command === "claude_turn_start")!.args?.options as Record<string, unknown>;
  expect(options.nativeSubagentModel).toBeUndefined();
  expect(options.nativeAutoCompactTokens).toBeUndefined();
  expect(options.autoCompactTokens).toBe(200_000);
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[String(options.threadId)].nativeOptions).toEqual({ codex: { model: "gpt-6.1-luna", reasoningEffort: "high" } });
});

it("locks saved native child preferences while a linked native child is active", async () => {
  inbox = [ROOT];
  await renderApp({ "kiwi.nativeAgentLinks": { child: { childThreadId: "child", rootThreadId: ROOT.id, title: "Busy fixture child", path: PROJECT.path, createdAt: 1, provider: "openai", runtime: "codex", status: "running" } }, "kiwi.threadSubagentSettings": { [ROOT.id]: { enabled: true, engine: "native", nativeMaxConcurrent: 4, nativeOptions: { codex: { model: "gpt-6.1-luna", reasoningEffort: "high", autoCompactTokens: 100_000 } } } } });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  const panel = await openPanel();
  for (const name of ["Default child model", "Default child reasoning", "Conversation compaction"]) expect(within(panel).getByRole("button", { name })).toBeDisabled();
  expect(within(panel).getByRole("button", { name: "Default child model" })).toHaveTextContent("Fixture Luna");
  expect(within(panel).getByText(/A saved child window \(100K tokens\) is not used by Codex/)).toBeVisible();
});

it.each(["openai", "claude"] as const)("keeps the %s native options menu inside a small 125% App surface", async (provider) => {
  claudeVersion = "2.1.293";
  await page.viewport(1050, 900);
  await renderApp({ "kiwi.settings": { provider, model: provider === "openai" ? "gpt-6-sol" : "claude-sonnet-5", theme: "mythra", uiScale: 125, childAgents: { enabled: true, targets: [TARGET] } } });
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: provider === "openai" ? /Native Codex/ : /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: provider === "openai" ? /Native Codex/ : /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await chooseNativeOption(provider === "openai" ? "Default child model" : "Child model", provider === "openai" ? /^Fixture Luna/ : /^Haiku 5\.5/);
  await userEvent.click(within(panel).getByRole("button", { name: "Conversation compaction" }));
  const menu = await screen.findByRole("menu", { name: "Conversation compaction choices" });
  for (const name of [/^200K tokens$/, /^500K tokens$/, /^1M tokens/, /^Provider default/]) expect(within(menu).getByRole("menuitemradio", { name })).toBeVisible();
  const rect = menu.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  const sampleGeometry = () => ({ pane: panel.getBoundingClientRect().toJSON(), anchor: panel.parentElement!.getBoundingClientRect().toJSON(), innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight, scrollX: window.scrollX, scrollY: window.scrollY });
  const beforeScreenshot = sampleGeometry();
  await page.screenshot({ element: document.querySelector<HTMLElement>(".app-shell")!, path: `../test-results/native-options-${provider}-125-menu-${browser}.png` });
  const afterElementScreenshot = sampleGeometry();
  await page.screenshot({ path: `../test-results/native-options-${provider}-125-surface-${browser}.png` });
  expect(afterElementScreenshot).toEqual(beforeScreenshot);
  expect(sampleGeometry()).toEqual(beforeScreenshot);
  expectNativePanelBounds(panel);
  // At 125%, WebKit rounds integer scrollWidth/clientWidth differently (307
  // versus 306) even with every item fully inside. Check physical item/text
  // boundaries so a rounding artifact cannot hide real clipping or fail QA.
  for (const item of within(menu).getAllByRole("menuitemradio")) {
    const itemRect = item.getBoundingClientRect();
    expect(itemRect.left).toBeGreaterThanOrEqual(rect.left);
    expect(itemRect.right).toBeLessThanOrEqual(rect.right);
    for (const text of item.querySelectorAll("strong, small")) {
      const textRect = text.getBoundingClientRect();
      expect(textRect.left).toBeGreaterThanOrEqual(itemRect.left);
      expect(textRect.right).toBeLessThanOrEqual(itemRect.right);
    }
  }
  await userEvent.click(within(menu).getByRole("menuitemradio", { name: /^200K tokens$/ }));
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("200K tokens");
});

it("reads Codex native worker assignments, model evidence and results without losing active counts", async () => {
  inbox = [ROOT];
  const createdAt = Date.now();
  // Explicit provider evidence fixtures; none of these workers run a CLI.
  const records: AgentRecord[] = [
    { id: "codex-fixture-a", prompt: "Inspect fixture routes", task: "Inspect fixture routes\nCheck every public route for stale redirects.", status: "running", provider: "openai", runtime: "codex", model: "gpt-6.1-luna", modelSource: "configured", progress: "Read three fixture routes; checking redirect targets.", createdAt },
    { id: "codex-fixture-b", prompt: "Inspect fixture rendering", task: "Inspect fixture rendering\nCompare the narrow and wide layouts.", status: "running", provider: "openai", runtime: "codex", progress: "Captured the narrow fixture layout.", createdAt },
    { id: "codex-fixture-c", prompt: "Audit fixture tests", task: "Audit fixture tests\nReport which assertions cover the provider boundary.", status: "completed", provider: "openai", runtime: "codex", model: "gpt-6.1-luna", modelSource: "execution", progress: "Completed the fixture-only review.", result: "All three provider-boundary assertions are present.", activationId: "fixture-review-1", createdAt },
  ];
  const links = Object.fromEntries(records.map(({ id, prompt, ...record }) => [id, { ...record, createdAt, childThreadId: id, rootThreadId: ROOT.id, title: prompt, path: PROJECT.path, ...(record.status === "completed" ? { finishedAt: createdAt + 1 } : {}) } satisfies NativeAgentLink]));
  await renderApp({ "kiwi.nativeAgentLinks": links, "kiwi.threadSubagentSettings": { [ROOT.id]: { enabled: true, engine: "native", nativeMaxConcurrent: 4 } } });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  await waitFor(() => expect(rpcCalls("thread/resume")).toHaveLength(1));
  await act(async () => { for (const record of records) useTaskStore.getState().upsertAgent(ROOT.id, record); });
  const panel = await openPanel();
  expect(within(panel).getByText("2 working · 1 done")).toBeVisible();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
  const rows = panel.querySelectorAll<HTMLElement>(".sa-worker");
  expect(rows).toHaveLength(3);
  const unknownRow = within(panel).getByText("Inspect fixture rendering").closest("li")!;
  expect(unknownRow).toHaveTextContent("model not reported");
  expect(unknownRow).not.toHaveTextContent("gpt-6-sol");
  const configuredRow = within(panel).getByText("Inspect fixture routes").closest("li")!;
  expect(configuredRow).toHaveTextContent("gpt-6.1-luna requested, unconfirmed");
  await userEvent.click(within(configuredRow).getByRole("button", { name: "Details for Inspect fixture routes" }));
  expect(nativeReadoutValue(configuredRow, "Assignment").textContent).toBe(records[0].task);
  expect(nativeReadoutValue(configuredRow, "Assignment")).toBeVisible();
  expect(within(configuredRow).getByText(records[0].progress!)).toBeVisible();
  const terminalRow = within(panel).getByText("Audit fixture tests").closest("li")!;
  await userEvent.click(within(terminalRow).getByRole("button", { name: "Details for Audit fixture tests" }));
  expect(nativeReadoutValue(terminalRow, "Assignment").textContent).toBe(records[2].task);
  expect(nativeReadoutValue(terminalRow, "Assignment")).toBeVisible();
  expect(within(terminalRow).getByText("gpt-6.1-luna · reported by the run")).toBeVisible();
  expect(within(terminalRow).getByText(records[2].progress!)).toBeVisible();
  expect(within(terminalRow).getByText(records[2].result!)).toBeVisible();
  expect(within(terminalRow).queryByRole("button", { name: /^Stop / })).toBeNull();
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await revealNativeReadout(panel, terminalRow);
  await page.screenshot({ path: `../test-results/native-workers-codex-100-${browser}.png` });
  await captureDevelopmentUi("codex-worker-details");
  await page.viewport(1100, 720);
  await revealNativeReadout(panel, terminalRow);
  await page.screenshot({ path: `../test-results/native-workers-codex-short-${browser}.png` });
  await act(async () => { useTaskStore.getState().upsertAgent(ROOT.id, { ...records[2], activationId: "fixture-review-2", result: "A separate fixture activation reported this result." }); });
  expect(within(terminalRow).getByRole("button", { name: "Details for Audit fixture tests" })).toHaveAttribute("aria-expanded", "false");
  expect(within(terminalRow).queryByText(records[2].result!)).toBeNull();
  await act(async () => { useTaskStore.getState().upsertAgent(ROOT.id, { ...records[0], status: "completed", result: "Fixture route review finished." }); });
  expect(within(panel).getByText("1 working · 2 done")).toBeVisible();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
});

it("reads Claude native worker requested versus reported models without inventing individual controls", async () => {
  claudeVersion = "2.1.293";
  await renderApp({ "kiwi.settings": { provider: "claude", model: "claude-sonnet-5", theme: "mythra", uiScale: 100, childAgents: { enabled: true, targets: [TARGET] } } });
  let panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await chooseNativeOption("Child model", /^Haiku 5\.5/);
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Create the fixture-only Claude parent");
  await waitFor(() => expect(calls.filter((call) => call.command === "claude_turn_start")).toHaveLength(1));
  const rootId = useTaskStore.getState().activeThreadId!;
  const records: AgentRecord[] = [
    { id: "claude-fixture-a", prompt: "Explore fixture sources", task: "Explore fixture sources\nFind the owner of the fixture metadata.", status: "running", runtime: "claude", provider: "claude", requestedModel: "claude-haiku-5-5", model: "claude-sonnet-4-6", modelSource: "execution", progress: "Found the metadata owner in the fixture source tree.", result: "The fixture metadata is owned by its root thread.", createdAt: Date.now() },
    { id: "claude-fixture-b", prompt: "Check fixture permissions", task: "Check fixture permissions\nConfirm that no live provider is invoked.", status: "running", runtime: "claude", provider: "claude", requestedModel: "claude-haiku-5-5", progress: "Reviewing the explicit command stubs.", createdAt: Date.now() },
  ];
  await act(async () => {
    const state = useTaskStore.getState();
    state.setActiveTurn(rootId, undefined); state.setTaskStatus(rootId, "completed");
    for (const record of records) state.upsertAgent(rootId, record);
  });
  panel = await openPanel();
  expect(within(panel).getByText("2 working")).toBeVisible();
  expect(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" })).toBeDisabled();
  let reportedRow = within(panel).getByText("Explore fixture sources").closest("li")!;
  const unconfirmedRow = within(panel).getByText("Check fixture permissions").closest("li")!;
  expect(reportedRow).toHaveTextContent("claude-sonnet-4-6");
  expect(unconfirmedRow).toHaveTextContent("claude-haiku-5-5 requested, unconfirmed");
  expect(unconfirmedRow).not.toHaveTextContent("claude-sonnet-5");
  for (const row of [reportedRow, unconfirmedRow]) {
    expect(within(row).queryByRole("button", { name: /^Open / })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^Stop / })).toBeNull();
  }
  await userEvent.click(within(reportedRow).getByRole("button", { name: "Details for Explore fixture sources" }));
  expect(nativeReadoutValue(reportedRow, "Assignment").textContent).toBe(records[0].task);
  expect(nativeReadoutValue(reportedRow, "Assignment")).toBeVisible();
  expect(within(reportedRow).getByText(/claude-sonnet-4-6 · reported by the run/)).toHaveTextContent("claude-haiku-5-5 · requested");
  expect(within(reportedRow).getByText(records[0].progress!)).toBeVisible();
  expect(within(reportedRow).getByText(records[0].result!)).toBeVisible();
  expect(rpcCalls("thread/start")).toHaveLength(0);
  expect(rpcCalls("turn/start")).toHaveLength(0);
  const browser = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await revealNativeReadout(panel, reportedRow);
  await page.screenshot({ path: `../test-results/native-workers-claude-100-${browser}.png` });
  await captureDevelopmentUi("claude-worker-details");
  const anchor = screen.getByRole("button", { name: /^Sub-agents(?: off|:| \d+\/)/ });
  const beforeQueuedAnchor = anchor.getBoundingClientRect().top;
  await act(async () => {
    for (let index = 0; index < 4; index++) useTaskStore.getState().enqueueTurn(rootId, `Fixture scheduled follow-up ${index + 1}`, [], { deliverAt: Date.now() + 60_000 });
  });
  await commands.setStreamTestReducedMotion(true);
  expect(useTaskStore.getState().tasks[rootId].queuedTurns).toHaveLength(4);
  expect(anchor.getBoundingClientRect().top).toBe(beforeQueuedAnchor);
  // Production #root pins this footer while its actual queue grows. The
  // anonymous auto-height harness moved it and was not production evidence.
  expectNativePanelBounds(panel);
  await page.screenshot({ path: `../test-results/native-workers-claude-reflow-${browser}.png` });
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  panel = await openPanel();
  reportedRow = within(panel).getByText("Explore fixture sources").closest("li")!;
  const details = within(reportedRow).getByRole("button", { name: "Details for Explore fixture sources" });
  if (details.getAttribute("aria-expanded") !== "true") await userEvent.click(details);
  await revealNativeReadout(panel, reportedRow);
  const beforeRemovedAnchor = anchor.getBoundingClientRect().top;
  await act(async () => {
    const queued = useTaskStore.getState().tasks[rootId].queuedTurns;
    for (const entry of queued) useTaskStore.getState().removeQueuedTurn(rootId, entry.id);
  });
  await commands.setStreamTestReducedMotion(true);
  expect(useTaskStore.getState().tasks[rootId].queuedTurns).toHaveLength(0);
  expect(anchor.getBoundingClientRect().top).toBe(beforeRemovedAnchor);
  // Queue removal must not upset the already-open production-mounted pane.
  await page.screenshot({ path: `../test-results/native-workers-claude-reflow-shrink-${browser}.png` });
  expectNativePanelBounds(panel);
  await page.viewport(1100, 720);
  await revealNativeReadout(panel, reportedRow);
  await page.screenshot({ path: `../test-results/native-workers-claude-short-${browser}.png` });
});

it.each([
  { provider: "openai", scale: 90, theme: "mythra" },
  { provider: "openai", scale: 100, theme: "atari" },
  { provider: "openai", scale: 125, theme: "mythra" },
  { provider: "claude", scale: 90, theme: "atari" },
  { provider: "claude", scale: 100, theme: "mythra" },
  { provider: "claude", scale: 125, theme: "atari" },
] as const)("keeps $provider keyboard menus and focus inside a short $theme App at $scale%", async ({ provider, scale, theme }) => {
  claudeVersion = "2.1.293";
  await page.viewport(1050, 650);
  await renderApp({ "kiwi.settings": { provider, model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5", theme, uiScale: scale, childAgents: { enabled: true, targets: [TARGET] } } });
  const panel = await openPanel();
  const nativeRadio = within(panel).getByRole("radio", { name: provider === "openai" ? /Native Codex/ : /Native Claude Code/ });
  await waitFor(() => expect(nativeRadio).toBeEnabled());
  await userEvent.click(nativeRadio);
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  expectNativePanelBounds(panel);
  const compaction = within(panel).getByRole("button", { name: "Conversation compaction" });
  await userEvent.click(compaction);
  const menu = await screen.findByRole("menu", { name: "Conversation compaction choices" });
  const selected = within(menu).getByRole("menuitemradio", { name: /^Provider default/ });
  await waitFor(() => expect(selected).toHaveFocus());
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(compaction).toHaveTextContent("200K tokens");
  expect(compaction).toHaveFocus();
  await userEvent.click(compaction);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu", { name: "Conversation compaction choices" })).toBeNull();
  expect(panel).toBeVisible();
  expect(compaction).toHaveFocus();
  const last = within(panel).getByRole("button", { name: "Advanced sub-agent settings" });
  last.focus();
  await userEvent.tab();
  expect(within(panel).getByRole("button", { name: "Close sub-agent command center" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sub-agent command center" })).toBeNull());
  expect(screen.getByRole("button", { name: /^Sub-agents: Native/ })).toHaveFocus();
});

it("captures Codex defaults and inherited parent compaction in the complete development App", async () => {
  await renderApp(); await enableNative();
  const panel = await openPanel();
  await configureCodexOptions();
  expect(within(panel).getByText("Parent: 200K tokens")).toBeVisible();
  expectNativePanelBounds(panel);
  await captureDevelopmentUi("codex-native-defaults-inheritance");
  within(panel).getByText("Parent: 200K tokens").scrollIntoView({ block: "nearest" });
  await commands.setStreamTestReducedMotion(true);
  await captureDevelopmentUi("codex-native-defaults-inheritance-lower");
});

it("repairs malformed stored parent compaction and unsupported native Codex child compaction through the App", async () => {
  inbox = [ROOT];
  await renderApp({ "kiwi.threadSubagentSettings": { [ROOT.id]: { enabled: true, engine: "native", nativeMaxConcurrent: 6, autoCompactTokens: 0, nativeOptions: { codex: { model: "gpt-6.1-luna", autoCompactTokens: 100_000 } } } } });
  await userEvent.click(await screen.findByRole("button", { name: "Open Native root" }));
  const panel = await openPanel();
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("Invalid saved value");
  expect(within(panel).getByText(/The saved compaction window is not valid/)).toBeVisible();
  await chooseNativeOption("Conversation compaction", /^Provider default/);
  const reset = within(panel).getByRole("button", { name: "Reset" });
  expect(reset).toBeEnabled();
  await userEvent.click(reset);
  expect(within(panel).queryByText(/A saved child window/)).toBeNull();
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("Provider default");
  const stored = JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id];
  expect(stored).not.toHaveProperty("autoCompactTokens");
  expect(stored.nativeOptions.codex).toEqual({ model: "gpt-6.1-luna" });
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("shows captured public pricing through the complete App Settings and preserves keyboard search escape", async () => {
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)!, now: () => Date.parse("2026-10-09T12:00:00Z") });
  await renderApp();
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Model pricing$/ }));
  await userEvent.click(within(dialog).getByRole("radio", { name: /^OpenAI$/ }));
  const search = within(dialog).getByRole("textbox", { name: "Search models" });
  await userEvent.type(search, "gpt-6.1");
  expect(within(dialog).getByRole("table", { name: "OpenAI" })).toHaveTextContent("gpt-6.1-sol");
  await captureDevelopmentUi("settings-openai-published-pricing");
  await userEvent.keyboard("{Escape}");
  expect(search).toHaveValue("");
  expect(dialog).toBeVisible();
  await userEvent.click(within(dialog).getByRole("radio", { name: /^Anthropic$/ }));
  await userEvent.type(search, "5.5");
  const haiku = within(dialog).getByText("Claude Haiku 5.5", { exact: true }).closest("tbody")!;
  expect(haiku).toHaveTextContent("Prompts over 100K tokens");
  expect(haiku).toHaveTextContent("5m $0.125");
  expect(haiku).toHaveTextContent("1h $0.20");
  await captureDevelopmentUi("settings-anthropic-published-pricing-cache-bands");
  await userEvent.click(within(dialog).getByRole("button", { name: "Clear model search" }));
  await userEvent.type(search, "haiku");
  const retired = within(dialog).getByText("Claude Haiku 3.5", { exact: true }).closest("tbody")!;
  expect(retired).toHaveTextContent("Retired");
  expect(retired).toHaveTextContent("$0.80");
  expect(retired).toHaveTextContent("5m $1.00");
  expect(retired).toHaveTextContent("1h $1.60");
  await captureDevelopmentUi("settings-anthropic-published-pricing-retired");
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("warns about future cached verification in complete App Settings and corrects it through refresh", async () => {
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)!, now: () => Date.parse("2026-10-09T12:00:00Z") });
  const cached = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
  for (const source of Object.values(cached.sources) as Array<{ checkedAt: number; verifiedAt: number }>) {
    source.checkedAt = Date.UTC(2099, 0, 1, 12);
    source.verifiedAt = Date.UTC(2099, 0, 1, 12);
  }
  localStorage.setItem(OFFICIAL_PRICING_KEY, JSON.stringify(cached));
  resetUsageLedgerCache();
  await renderApp();
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^Model pricing$/ }));
  expect(within(dialog).getAllByText("Saved rates · verification time is uncertain. Refresh to check the official page.")).toHaveLength(2);
  expect(within(dialog).queryByText(/2099/)).toBeNull();
  await userEvent.click(within(dialog).getByRole("radio", { name: /^OpenAI$/ }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Search models" }), "gpt-6.1");
  expect(within(dialog).getByRole("table", { name: "OpenAI" })).toHaveTextContent("$2.00");
  await captureDevelopmentUi("settings-future-clock-warning");
  const modelReadsBeforeRefresh = rpcCalls("model/list").length;
  refreshedCodexModelAvailable = true;
  await userEvent.click(within(dialog).getByRole("button", { name: "Refresh prices" }));
  await waitFor(() => expect(within(dialog).queryByText(/verification time is uncertain/)).toBeNull());
  expect(within(dialog).getByText(/models verified/)).toBeVisible();
  expect(within(dialog).getByRole("table", { name: "OpenAI" })).toHaveTextContent("$2.00");
  await waitFor(() => expect(rpcCalls("model/list").length).toBeGreaterThan(modelReadsBeforeRefresh));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Refresh prices" })).toBeEnabled());
  const partialModelWarning = within(dialog).getByText(/^Available models could not be refreshed/);
  expect(partialModelWarning).toHaveTextContent("Claude");
  expect(within(dialog).queryByText("Couldn’t refresh pricing. Previously verified rates are still shown.")).toBeNull();
  await captureDevelopmentUi("settings-partial-model-refresh");
  await userEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  const panel = await openPanel();
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Default child model" }));
  const models = await screen.findByRole("menu", { name: "Default child model choices" });
  expect(within(models).getByRole("menuitemradio", { name: /^Refreshed fixture Sol/ })).toBeVisible();
  expect(within(panel).getByRole("button", { name: "Default child model" })).toHaveTextContent("Provider chooses");
  await captureDevelopmentUi("pricing-refresh-available-models");
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("uses the selected OpenAI model's published 272K compaction boundary without changing saved numeric choices", async () => {
  refreshedCodexModelAvailable = true;
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)! });
  const boundaryWorker = { ...TARGET, model: "gpt-6.1-sol", label: "Boundary fixture", autoCompactTokens: 200_000 };
  await renderApp({ "kiwi.settings": { provider: "openai", model: "gpt-6.1-sol", theme: "mythra", childAgents: { enabled: true, targets: [boundaryWorker] } } });
  const panel = await openPanel();
  await userEvent.click(within(panel).getByRole("button", { name: "Conversation compaction" }));
  let menu = await screen.findByRole("menu", { name: "Conversation compaction choices" });
  const parentBoundary = within(menu).getByRole("menuitemradio", { name: /^272K tokens/ });
  expect(parentBoundary).toBeVisible();
  expect(parentBoundary).toHaveTextContent(/price boundary/i);
  await userEvent.click(parentBoundary);
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Configure Boundary fixture" }));
  expect(within(panel).getByRole("button", { name: "Compaction for sol" })).toHaveTextContent("200K tokens");
  await chooseNativeOption("Compaction for sol", /^272K tokens/);
  await chooseNativeOption("Model for sol", /^Fixture Luna/);
  expect(within(panel).getByRole("button", { name: "Compaction for sol" })).toHaveTextContent("272K tokens");
  await userEvent.click(within(panel).getByRole("button", { name: "Compaction for sol" }));
  menu = await screen.findByRole("menu", { name: "Compaction for sol choices" });
  const retainedBoundary = within(menu).getByRole("menuitemradio", { name: /^272K tokens/ });
  expect(retainedBoundary).toHaveAttribute("aria-checked", "true");
  expect(retainedBoundary).toHaveTextContent("Previously configured");
  await userEvent.keyboard("{Escape}");
  expect(within(panel).getByRole("button", { name: "Conversation compaction" })).toHaveTextContent("272K tokens");
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Preserve these explicit demonstration windows after changing the worker model");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  expect(rpcCalls("thread/start")[0].config).toMatchObject({ model_auto_compact_token_limit: 272_000 });
  expect(calls.find((call) => call.command === "child_agent_session_start")!.args?.options).toMatchObject({ targets: [{ model: "gpt-6.1-luna", autoCompactTokens: 272_000 }] });
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("limits the native Claude 100K pricing compaction hint to selected Haiku instead of Opus", async () => {
  claudeVersion = "2.1.293";
  publishedClaudeModelsAvailable = true;
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)! });
  await renderApp({ "kiwi.settings": { provider: "claude", model: "claude-opus-5-5", theme: "mythra" } });
  const panel = await openPanel();
  await waitFor(() => expect(within(panel).getByRole("radio", { name: /Native Claude Code/ })).not.toBeDisabled());
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Claude Code/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await chooseNativeOption("Child model", /^Fixture Haiku 5\.5/);
  await userEvent.click(within(panel).getByRole("button", { name: "Child model compaction" }));
  let menu = await screen.findByRole("menu", { name: "Child model compaction choices" });
  const haikuBoundary = within(menu).getByRole("menuitemradio", { name: /^100K tokens/ });
  expect(haikuBoundary).toHaveTextContent(/price boundary/i);
  await userEvent.click(haikuBoundary);
  const usageInfoButton = within(panel).getByRole("button", { name: "About child compaction and usage" });
  await userEvent.click(usageInfoButton);
  const usageInfo = document.getElementById(usageInfoButton.getAttribute("aria-controls")!)!;
  expect(usageInfo).toBeVisible();
  expect(usageInfo).toHaveTextContent("Claude Haiku 5.5: published API pricing changes above 100K input tokens, including cached input.");
  expect(usageInfo).toHaveTextContent("Subscription allowances are separate.");
  await chooseNativeOption("Child model", /^Fixture Opus 5\.5/);
  expect(within(panel).getByRole("button", { name: "Child model compaction" })).toHaveTextContent("100K tokens");
  expect(usageInfo).toBeVisible();
  expect(usageInfo).toHaveTextContent("Claude Opus 5.5: the published API table does not list a long-context price increase.");
  expect(usageInfo).not.toHaveTextContent(/100K|Haiku/);
  await userEvent.click(within(panel).getByRole("button", { name: "Child model compaction" }));
  menu = await screen.findByRole("menu", { name: "Child model compaction choices" });
  expect(within(menu).getByRole("menuitemradio", { name: /^100K tokens/ })).not.toHaveTextContent(/price boundary/i);
  await userEvent.keyboard("{Escape}");
  expect(within(panel).queryByText(/Haiku.*published API pricing changes/)).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Conversation compaction" }));
  menu = await screen.findByRole("menu", { name: "Conversation compaction choices" });
  expect(within(menu).queryByRole("menuitemradio", { name: /^100K tokens/ })).toBeNull();
  expect(within(menu).queryByText(/272K/)).toBeNull();
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("refreshes the published model-specific compaction boundary through Settings without replacing a numeric choice", async () => {
  refreshedCodexModelAvailable = true;
  publishedClaudeModelsAvailable = true;
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)! });
  const oldCatalog = officialPricingSnapshot("openai");
  expect(oldCatalog["gpt-6.1-sol"].longContextThresholdTokens).toBe(272_000);
  delete oldCatalog["gpt-6.1-sol"].longContext;
  delete oldCatalog["gpt-6.1-sol"].longContextThresholdTokens;
  recordOfficialPricingResult("openai", { ok: true, models: oldCatalog });
  const boundaryWorker = { ...TARGET, model: "gpt-6.1-sol", label: "Boundary refresh fixture", autoCompactTokens: 200_000 };
  await renderApp({ "kiwi.settings": { provider: "openai", model: "gpt-6.1-sol", theme: "mythra", childAgents: { enabled: true, targets: [boundaryWorker] } } });
  let panel = await openPanel();
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Configure Boundary refresh fixture" }));
  await userEvent.click(within(panel).getByRole("button", { name: "Compaction for sol" }));
  let menu = await screen.findByRole("menu", { name: "Compaction for sol choices" });
  expect(within(menu).queryByRole("menuitemradio", { name: /^272K tokens/ })).toBeNull();
  expect(within(menu).getByRole("menuitemradio", { name: /^200K tokens/ })).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await userEvent.click(within(settings).getByRole("button", { name: /^Model pricing$/ }));
  await userEvent.click(within(settings).getByRole("button", { name: "Refresh prices" }));
  await waitFor(() => expect(within(settings).getByRole("button", { name: "Refresh prices" })).toBeEnabled());
  expect(officialPricingSnapshot("openai")["gpt-6.1-sol"].longContextThresholdTokens).toBe(272_000);
  await userEvent.click(within(settings).getByRole("button", { name: "Close settings" }));
  panel = await openPanel();
  await userEvent.click(within(panel).getByRole("button", { name: "Configure Boundary refresh fixture" }));
  expect(within(panel).getByRole("button", { name: "Compaction for sol" })).toHaveTextContent("200K tokens");
  await userEvent.click(within(panel).getByRole("button", { name: "Compaction for sol" }));
  menu = await screen.findByRole("menu", { name: "Compaction for sol choices" });
  expect(within(menu).getByRole("menuitemradio", { name: /^272K tokens/ })).toHaveTextContent(/price boundary/i);
  expect(within(menu).getByRole("menuitemradio", { name: /^200K tokens/ })).toHaveAttribute("aria-checked", "true");
  await captureDevelopmentUi("model-specific-compaction-pricing-boundary");
});

it.skipIf(!capturedPricingPage("openai") || !capturedPricingPage("anthropic"))("keeps native Codex child compaction inherited when a published model-specific parent boundary is selected", async () => {
  refreshedCodexModelAvailable = true;
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => capturedPricingPage(source)! });
  await renderApp({ "kiwi.settings": { provider: "openai", model: "gpt-6.1-sol", theme: "mythra" } });
  const panel = await openPanel();
  await chooseNativeOption("Conversation compaction", /^272K tokens/);
  await userEvent.click(within(panel).getByRole("radio", { name: /Native Codex/ }));
  await userEvent.click(within(panel).getByRole("switch", { name: "Allow sub-agent spawning" }));
  await chooseNativeOption("Default child model", /^Fixture Luna/);
  expect(within(panel).getByText("Parent: 272K tokens")).toBeVisible();
  expect(within(panel).queryByRole("button", { name: "Child model compaction" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Child compaction" })).toBeNull();
  await userEvent.click(within(panel).getByRole("button", { name: "Close sub-agent command center" }));
  await send("Use the explicit parent window with inherited native Codex worker compaction");
  await waitFor(() => expect(rpcCalls("turn/start")).toHaveLength(1));
  const config = rpcCalls("thread/start")[0].config as Record<string, unknown>;
  expect(config).toMatchObject({ model_auto_compact_token_limit: 272_000 });
  expect(config.agents).not.toHaveProperty("auto_compact_tokens");
  expect(config.agents).not.toHaveProperty("model_auto_compact_token_limit");
  expect(JSON.parse(localStorage.getItem("kiwi.threadSubagentSettings")!)[ROOT.id].nativeOptions.codex).not.toHaveProperty("autoCompactTokens");
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { refreshOfficialPricing } from "../lib/officialPricing";
import { resetStorageMemoryForTests } from "../lib/storage";
import { resetUsageLedgerCache } from "../lib/usageLedger";
import { ANTHROPIC_PRICING_PAGE, CURSOR_PRICING_PAGE, OPENAI_PRICING_PAGE } from "../test/pricingPages";
import { SettingsModal } from "./SettingsModal";

// Actual Settings, hook, parser, cache and production CSS; only native API
// document fetching is a deterministic fixture. This never claims live prices.
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl, revealItemInDir: vi.fn() }));
const pages = {
  // The provider's explicit threshold narrative accompanies its rate table.
  openai: `${OPENAI_PRICING_PAGE}\n\nShort context: ≤272K input tokens. Long context: >272K input tokens.\n`,
  anthropic: ANTHROPIC_PRICING_PAGE.replace("| Claude Haiku 4.5", `| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 4.5`),
  cursor: CURSOR_PRICING_PAGE,
};
const noop = () => {};
const asyncNoop = async () => {};

function props(): Parameters<typeof SettingsModal>[0] {
  return {
    open: true, initialSection: "general", settings: { ...DEFAULT_SETTINGS },
    appUpdater: { phase: "idle", currentVersion: "0.0.0-test", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, openRouterReady: false, githubStatus: null,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    onClose: noop, onSave: noop, onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
    onGitHubSignIn: asyncNoop, onGitHubRefresh: asyncNoop, onGitHubClone: async () => true, onError: noop,
    profiles: [], agents: [], actions: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    skillsFolder: "", skills: [], removedSkills: [], skillsBusy: false, skillsError: "", workspaceToolsAvailable: false,
    onProfiles: noop, onAgents: noop, onActions: noop, onSchedules: noop, onWorkflows: noop,
    onRunWorkflow: noop, onStopWorkflow: async () => true, onProjects: noop,
    onChooseSkillsFolder: noop, onRefreshSkills: noop, onImportSkills: noop, onCreateSkill: async () => true,
    onReadSkill: async () => "", onUpdateSkill: asyncNoop, onRenameSkill: () => true,
    onToggleSkill: noop, onRemoveSkill: async () => true, onRestoreSkill: async () => true, onOpenOnboarding: noop,
  };
}

beforeEach(async () => {
  localStorage.clear(); resetStorageMemoryForTests(); resetUsageLedgerCache();
  mocks.invoke.mockReset(); mocks.openUrl.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { source: keyof typeof pages }) => command === "fetch_pricing_document" ? pages[args.source] : null);
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => { localStorage.clear(); resetStorageMemoryForTests(); resetUsageLedgerCache(); await commands.setStreamTestReducedMotion(false); await page.viewport(1400, 900); });

async function openPricing(scale = 1) {
  const mount = document.createElement("div"); mount.id = "root"; document.body.append(mount);
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}><SettingsModal {...props()} /></div>, { container: mount });
  await userEvent.click(screen.getByRole("button", { name: /^Model pricing$/ }));
  return screen.getByRole("dialog", { name: "Settings" });
}

async function seed() {
  await refreshOfficialPricing({ force: true, fetchDocument: async (source) => pages[source], now: () => Date.parse("2026-10-09T12:00:00Z") });
}

it.each([0.9, 1, 1.25])("contains the pricing Settings surface and labelled rates at %s scale", async (scale) => {
  await seed(); await page.viewport(980, 760);
  const dialog = await openPricing(scale);
  const pricing = dialog.querySelector<HTMLElement>(".frontier-pricing")!;
  expect(within(dialog).getByRole("table", { name: "OpenAI" })).toBeVisible();
  const opus = within(dialog).getByText("Claude Opus 5.5", { exact: true }).closest("tbody")!;
  expect(opus).toHaveTextContent("5m $5.00"); expect(opus).toHaveTextContent("1h $8.00");
  const legacy = within(dialog).getByText("gpt-5.5", { exact: true }).closest("tbody")!;
  expect(within(legacy).getAllByText("Not published")).toHaveLength(2);
  expect(legacy).toHaveTextContent("Long context");
  expect(legacy).toHaveTextContent("Prompts over 272K tokens");
  const haiku = within(dialog).getByText("Claude Haiku 5.5", { exact: true }).closest("tbody")!;
  expect(haiku).toHaveTextContent("Prompts over 100K tokens");
  expect(haiku).toHaveTextContent("$0.10"); expect(haiku).toHaveTextContent("$0.50");
  expect(within(dialog).getByText(/not Claude or ChatGPT subscription allowances/)).toBeVisible();
  expect(within(dialog).getAllByText(/models verified/)).toHaveLength(2);
  const modal = dialog.getBoundingClientRect();
  expect(modal.left).toBeGreaterThanOrEqual(0); expect(modal.right).toBeLessThanOrEqual(window.innerWidth);
  expect(modal.top).toBeGreaterThanOrEqual(0); expect(modal.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(pricing.scrollWidth).toBeLessThanOrEqual(pricing.clientWidth + 1);
  for (const control of pricing.querySelectorAll<HTMLElement>("button, input, .frontier-pricing-table-wrap, .frontier-pricing-rate, .frontier-pricing-missing")) {
    const rect = control.getBoundingClientRect();
    expect(rect.left, control.textContent ?? "input").toBeGreaterThanOrEqual(modal.left);
    expect(rect.right, control.textContent ?? "input").toBeLessThanOrEqual(modal.right);
  }
  const engine = navigator.userAgent.includes("Chrome") ? "chromium" : "webkit";
  await page.screenshot({ element: dialog, path: `../../test-results/frontier-pricing-settings-${scale}-${engine}.png` });
});

it("filters, links to the official source and refreshes without losing cached rates on partial failure", async () => {
  await seed(); const dialog = await openPricing();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "fetch_pricing_document")).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole("radio", { name: /^Anthropic$/ }));
  expect(within(dialog).queryByRole("table", { name: "OpenAI" })).toBeNull();
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Search models" }), "opus");
  expect(within(dialog).queryByText("Claude Sonnet 5", { exact: true })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Anthropic pricing page" }));
  expect(mocks.openUrl).toHaveBeenCalledWith("https://platform.claude.com/docs/en/about-claude/pricing");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  mocks.invoke.mockImplementation(async (command: string, args: { source: keyof typeof pages }) => {
    if (command !== "fetch_pricing_document") return null;
    await pending;
    if (args.source === "anthropic") throw new Error("Fixture offline failure");
    return pages[args.source];
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Refresh prices" }));
  expect(within(dialog).getByRole("button", { name: "Checking…" })).toBeDisabled();
  expect(within(dialog).getByText("Claude Opus 5.5", { exact: true })).toBeVisible();
  await act(async () => release());
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Refresh prices" })).toBeEnabled());
  expect(within(dialog).getByText(/Couldn’t verify.*showing rates verified/)).toBeVisible();
  expect(within(dialog).getByText("Fixture offline failure")).toBeVisible();
  expect(within(dialog).getByText("Claude Opus 5.5", { exact: true })).toBeVisible();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "fetch_pricing_document")).toHaveLength(3);
});

it("starts without inventing verified prices and populates both companies through manual refresh", async () => {
  const dialog = await openPricing();
  expect(within(dialog).queryByRole("table")).toBeNull();
  expect(within(dialog).getAllByText("Not checked yet")).toHaveLength(2);
  await userEvent.click(within(dialog).getByRole("button", { name: "Refresh prices" }));
  await within(dialog).findByText("Claude Opus 5.5", { exact: true });
  expect(within(dialog).getByRole("table", { name: "OpenAI" })).toBeVisible();
  expect(within(dialog).getByRole("table", { name: "Anthropic" })).toBeVisible();
});

it("uses radio-group arrow navigation to select companies", async () => {
  await seed(); const dialog = await openPricing();
  const all = within(dialog).getByRole("radio", { name: /^All$/ });
  const openai = within(dialog).getByRole("radio", { name: /^OpenAI$/ });
  const anthropic = within(dialog).getByRole("radio", { name: /^Anthropic$/ });
  all.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(openai).toHaveFocus();
  expect(openai).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{ArrowRight}");
  expect(anthropic).toHaveFocus();
  expect(anthropic).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{ArrowRight}");
  expect(all).toHaveFocus();
  await userEvent.keyboard("{End}");
  expect(anthropic).toHaveFocus();
  await userEvent.keyboard("{Home}");
  expect(all).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(anthropic).toHaveFocus();
  expect(all.tabIndex).toBe(-1);
  expect(openai.tabIndex).toBe(-1);
  expect(anthropic.tabIndex).toBe(0);
});

it("returns search focus after clearing a model query", async () => {
  await seed(); const dialog = await openPricing();
  const search = within(dialog).getByRole("textbox", { name: "Search models" });
  await userEvent.type(search, "Haiku");
  await userEvent.click(within(dialog).getByRole("button", { name: "Clear model search" }));
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
});

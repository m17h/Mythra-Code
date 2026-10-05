import type { CSSProperties } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { seedUsageDashboard } from "../test/usageFixture";
import { resetUsageLedgerCache, USAGE_LEDGER_KEY } from "../lib/usageLedger";
import { localDayKey, shiftDayKey, USAGE_HISTORY_KEY } from "../lib/usageHistory";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const noop = () => {};
const asyncNoop = async () => {};

/** Near the persisted history cap, seeded only inside the disposable browser. */
function seedLargeHistory() {
  seedUsageDashboard();
  const history = JSON.parse(localStorage.getItem(USAGE_HISTORY_KEY)!);
  const template = history.buckets[0].slice(0, 19) as Array<string | number>;
  const today = localDayKey();
  const records = new Map<string, { threadId: string; provider: string; model: string; usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number; contextWindow: null }; estimatedCost: number; pricedTokens: number; unpricedTokens: number; updatedAt: number }>();
  history.buckets = Array.from({ length: 4_000 }, (_, index) => {
    const provider = index % 2 ? "claude" : "openai";
    const model = `synthetic/model-${index % 10}`;
    const bucket = [shiftDayKey(today, -Math.floor(index / 10)), provider, model, ...template.slice(3)];
    const key = `${provider}/${model}`;
    const record = records.get(key) ?? { threadId: key, provider, model, usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, contextWindow: null }, estimatedCost: 0, pricedTokens: 0, unpricedTokens: 0, updatedAt: Date.now() };
    record.usage.inputTokens += Number(bucket[3]) + Number(bucket[4]) + Number(bucket[5]);
    record.usage.cachedInputTokens += Number(bucket[4]);
    record.usage.cacheWriteInputTokens += Number(bucket[5]);
    record.usage.outputTokens += Number(bucket[6]);
    record.usage.reasoningOutputTokens += Number(bucket[7]);
    record.usage.totalTokens += Number(bucket[8]);
    record.estimatedCost += Number(bucket[9]) + Number(bucket[10]) + Number(bucket[11]) + Number(bucket[12]);
    record.pricedTokens += Number(bucket[13]);
    record.unpricedTokens += Number(bucket[14]);
    records.set(key, record);
    return bucket;
  });
  history.startedAt = new Date(`${shiftDayKey(today, -399)}T12:00:00`).getTime();
  delete history.bucketEvidence;
  delete history.cohortEvidence;
  localStorage.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
  localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify([...records.values()]));
  resetUsageLedgerCache();
}

function mount(scale = 1, largeHistory = false) {
  if (largeHistory) seedLargeHistory();
  else seedUsageDashboard();
  return render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <SettingsModal
      open initialSection="general" settings={DEFAULT_SETTINGS}
      appUpdater={{ phase: "idle", currentVersion: "1.22.1", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop }}
      developerRuntimeUpdater={{ status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop }}
      account={null} runtimeStatus={null} openRouterReady={false} githubStatus={null}
      childAgentReadiness={{ codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: true, cursorReady: false }}
      onClose={noop} onSave={noop} onThemePreview={noop} onEffortSliderPreview={noop} onChatFontPreview={noop}
      onSignIn={asyncNoop} onRuntimeRequired={noop} onWorkspaceTools={noop} onOpenRouterChange={noop}
      onGitHubSignIn={asyncNoop} onGitHubRefresh={asyncNoop} onGitHubClone={async () => true} onError={noop}
      profiles={[]} agents={[]} actions={[]} schedules={[]} workflows={[]} workflowRuns={[]} projects={[]}
      skillsFolder="" skills={[]} removedSkills={[]} skillsBusy={false} skillsError="" workspaceToolsAvailable={false}
      onProfiles={noop} onAgents={noop} onActions={noop} onSchedules={noop} onWorkflows={noop}
      onRunWorkflow={noop} onStopWorkflow={async () => true} onProjects={noop}
      onChooseSkillsFolder={noop} onRefreshSkills={noop} onImportSkills={noop} onCreateSkill={async () => true}
      onReadSkill={async () => ""} onUpdateSkill={asyncNoop} onRenameSkill={() => true}
      onToggleSkill={noop} onRemoveSkill={async () => true} onRestoreSkill={async () => true} onOpenOnboarding={noop}
    />
  </div>);
}

async function sampleTransition(dialog: HTMLElement, button: HTMLElement) {
  const content = dialog.querySelector<HTMLElement>(".settings-content")!;
  // Read the starting style so the browser establishes a real transition.
  const startWidth = dialog.clientWidth;
  const frames: Array<{ sheet: number; layout: number; gap: number }> = [];
  let previous = performance.now();
  fireEvent.click(button);
  for (let index = 0; index < 24; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const now = performance.now();
    frames.push({ sheet: dialog.clientWidth, layout: content.clientWidth, gap: now - previous });
    const bounds = dialog.getBoundingClientRect();
    for (const button of within(dialog).getAllByRole("button", { name: /^(Close settings|Cancel|Save settings)$/ })) {
      const rect = button.getBoundingClientRect();
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(button);
    }
    previous = now;
  }
  return { startWidth, frames };
}

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it("reserves the destination content width while preserving both directions of the sheet resize", async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 1000);
  const view = mount(1, true);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog.getAnimations()).toHaveLength(0));
  const nav = within(view.getByRole("navigation", { name: "Settings categories" }));

  for (const label of ["Usage", "Interface", "Usage", "Interface"]) {
    const { startWidth, frames } = await sampleTransition(dialog, nav.getByRole("button", { name: new RegExp(`^${label}$`) }));
    const layoutWidths = new Set(frames.map((frame) => frame.layout));
    expect(frames[0].sheet).not.toBe(frames.at(-1)!.sheet);
    expect(startWidth).not.toBe(frames.at(-1)!.sheet);
    expect(new Set(frames.map((frame) => frame.sheet)).size).toBeGreaterThan(3);
    expect(frames.at(-1)!.sheet).toBe(label === "Usage" ? 1198 : 918);
    // Charts and text lay out at their destination width once; the sheet still animates.
    expect(layoutWidths.size).toBe(1);
    if (label === "Usage") {
      expect(view.getByRole("region", { name: "Local usage" })).toBeVisible();
      expect(view.getByRole("grid", { name: /^Tokens per day/ }).querySelectorAll("[data-day]").length).toBeGreaterThan(350);
      expect(view.getByRole("radiogroup", { name: "Provider quota display" })).toBeInTheDocument();
    }
  }
});

it.each([[980, 680, 1.5], [650, 780, 1]] as const)("keeps the reserved layout and controls inside a %sx%s window at %s scale", async (width, height, scale) => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(width, height);
  const view = mount(scale);
  const dialog = view.getByRole("dialog", { name: "Settings" });
  const nav = within(view.getByRole("navigation", { name: "Settings categories" }));
  for (const name of ["Usage", "Interface", "Usage"]) {
    fireEvent.click(nav.getByRole("button", { name: new RegExp(`^${name}$`) }));
    // Integer client widths can round opposite ways at fractional UI zoom.
    await waitFor(() => expect(Math.abs(dialog.querySelector<HTMLElement>(".settings-content")!.clientWidth - dialog.querySelector<HTMLElement>(".settings-pane")!.clientWidth)).toBeLessThanOrEqual(1));
    const bounds = dialog.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(width);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(height);
    for (const button of [view.getByRole("button", { name: "Close settings" }), view.getByRole("button", { name: "Cancel" })]) {
      const rect = button.getBoundingClientRect();
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button")).toBe(button);
    }
    expect(dialog.getAnimations()).toHaveLength(0);
  }
  const dashboard = view.getByRole("region", { name: "Local usage" });
  await page.viewport(width + 100, height);
  await waitFor(() => expect(Math.abs(dialog.querySelector<HTMLElement>(".settings-content")!.clientWidth - dialog.querySelector<HTMLElement>(".settings-pane")!.clientWidth)).toBeLessThanOrEqual(1));
  expect(view.getByRole("region", { name: "Local usage" })).toBe(dashboard);
});

it("honors the final section through a rapid resize reversal", async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 1000);
  const view = mount();
  const dialog = view.getByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog.getAnimations()).toHaveLength(0));
  const nav = within(view.getByRole("navigation", { name: "Settings categories" }));
  fireEvent.click(nav.getByRole("button", { name: /^Usage$/ }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  fireEvent.click(nav.getByRole("button", { name: /^Interface$/ }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  fireEvent.click(nav.getByRole("button", { name: /^Usage$/ }));
  await waitFor(() => expect(dialog.clientWidth).toBe(1198));
  expect(dialog.querySelector<HTMLElement>(".settings-content")!.clientWidth).toBe(950);
  expect(view.getByRole("region", { name: "Local usage" })).toBeVisible();
  expect(nav.getByRole("button", { name: /^Usage$/ })).toHaveAttribute("aria-current", "page");
});

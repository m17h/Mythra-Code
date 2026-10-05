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

type TransitionFrame = ReturnType<typeof captureTransitionFrame>;

function transitionControls(dialog: HTMLElement) {
  return within(dialog).getAllByRole("button", { name: /^(Close settings|Cancel|Save settings)$/ });
}

function captureTransitionFrame(dialog: HTMLElement, controls: HTMLElement[]) {
  return {
    sheet: dialog.clientWidth,
    height: dialog.clientHeight,
    layout: dialog.querySelector<HTMLElement>(".settings-content")!.clientWidth,
    bounds: dialog.getBoundingClientRect(),
    controls: controls.map((button) => {
      const rect = button.getBoundingClientRect();
      return { button, rect, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("button") };
    }),
  };
}

function expectReachableControls(frame: TransitionFrame) {
  for (const { button, rect, hit } of frame.controls) {
    expect(rect.left).toBeGreaterThanOrEqual(frame.bounds.left);
    expect(rect.top).toBeGreaterThanOrEqual(frame.bounds.top);
    expect(rect.right).toBeLessThanOrEqual(frame.bounds.right);
    expect(rect.bottom).toBeLessThanOrEqual(frame.bounds.bottom);
    expect(hit).toBe(button);
  }
}

async function sampleTransition(dialog: HTMLElement, button: HTMLElement) {
  const controls = transitionControls(dialog);
  // Establish the starting layout, then capture and pause the actual CSS
  // transitions before yielding. Slow runner scheduling must not skip the
  // intermediate geometry this contract verifies.
  const startWidth = dialog.clientWidth;
  const startHeight = dialog.clientHeight;
  fireEvent.click(button);
  void dialog.offsetWidth;
  const resize = dialog.getAnimations().filter((animation): animation is CSSTransition =>
    animation instanceof CSSTransition && ["width", "height"].includes(animation.transitionProperty));
  resize.forEach((animation) => { animation.pause(); animation.currentTime = 0; });
  expect(resize.map((animation) => animation.transitionProperty).sort()).toEqual(["height", "width"]);
  for (const animation of resize) expect(animation.effect!.getTiming().duration).toBe(320);

  const frames: TransitionFrame[] = [];
  for (const time of [0, 40, 80, 160, 240, 320]) {
    resize.forEach((animation) => { animation.currentTime = time; });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const frame = captureTransitionFrame(dialog, controls);
    expectReachableControls(frame);
    frames.push(frame);
  }
  resize.forEach((animation) => animation.finish());
  return { startWidth, startHeight, frames };
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
    const { startWidth, startHeight, frames } = await sampleTransition(dialog, nav.getByRole("button", { name: new RegExp(`^${label}$`) }));
    const layoutWidths = new Set(frames.map((frame) => frame.layout));
    expect(frames[0].sheet).toBe(startWidth);
    expect(frames[0].height).toBe(startHeight);
    expect(frames[0].sheet).not.toBe(frames.at(-1)!.sheet);
    expect(startWidth).not.toBe(frames.at(-1)!.sheet);
    expect(new Set(frames.map((frame) => frame.sheet)).size).toBeGreaterThan(3);
    expect(frames.at(-1)!.sheet).toBe(label === "Usage" ? 1198 : 918);
    expect(frames.at(-1)!.height).toBe(label === "Usage" ? 878 : 758);
    const direction = label === "Usage" ? 1 : -1;
    for (let index = 1; index < frames.length; index += 1) {
      expect(direction * (frames[index].sheet - frames[index - 1].sheet)).toBeGreaterThan(0);
      expect(direction * (frames[index].height - frames[index - 1].height)).toBeGreaterThan(0);
    }
    // Charts and text lay out at their destination width once; the sheet still animates.
    expect(layoutWidths.size).toBe(1);
    if (label === "Usage") {
      expect(view.getByRole("region", { name: "Local usage" })).toBeVisible();
      expect(view.getByRole("grid", { name: /^Tokens per day/ }).querySelectorAll("[data-day]").length).toBeGreaterThan(350);
      expect(view.getByRole("radiogroup", { name: "Provider quota display" })).toBeInTheDocument();
    }
  }
});

it("keeps controls hit-testable during natural playback with trusted navigation clicks", async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 1000);
  const view = mount(1, true);
  const dialog = view.getByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog.getAnimations()).toHaveLength(0));
  const controls = transitionControls(dialog);
  for (const label of ["Usage", "Interface"]) {
    void dialog.offsetWidth;
    await page.getByRole("button", { name: label, exact: true }).click();
    const frames: TransitionFrame[] = [];
    // Collect real unpaused frames first, without role queries/assertions in
    // the sampling loop. Frame count is not an animation/performance promise.
    for (let index = 0; index < 24; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(captureTransitionFrame(dialog, controls));
    }
    frames.forEach(expectReachableControls);
    expect(new Set(frames.map((frame) => frame.layout)).size).toBe(1);
    await waitFor(() => expect(dialog.clientWidth).toBe(label === "Usage" ? 1198 : 918));
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

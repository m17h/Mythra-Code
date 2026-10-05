import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { seedUsageDashboard } from "../test/usageFixture";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const noop = () => {};
const asyncNoop = async () => {};

afterEach(async () => { await page.viewport(1400, 900); });

it("keeps Close, Cancel and Save painted throughout both section resize directions", async () => {
  seedUsageDashboard();
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 1000);
  const view = render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <SettingsModal open initialSection="general" settings={DEFAULT_SETTINGS}
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
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog.getAnimations()).toHaveLength(0));
  const nav = within(view.getByRole("navigation", { name: "Settings categories" }));
  for (const section of ["Usage", "Interface"]) {
    dialog.getBoundingClientRect();
    fireEvent.click(nav.getByRole("button", { name: new RegExp(`^${section}$`) }));
    dialog.getBoundingClientRect();
    const animations = dialog.getAnimations();
    expect(animations.length).toBeGreaterThan(0);
    for (const animation of animations) animation.pause();
    for (const time of [0, 80, 160, 320]) {
      for (const animation of animations) animation.currentTime = time;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const footer = dialog.querySelector<HTMLElement>(".modal-footer")!;
      const bounds = dialog.getBoundingClientRect();
      for (const button of [...footer.querySelectorAll<HTMLButtonElement>("button"), view.getByRole("button", { name: "Close settings" })]) {
        const box = button.getBoundingClientRect();
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.left).toBeGreaterThanOrEqual(bounds.left);
        expect(box.right).toBeLessThanOrEqual(bounds.right);
        expect(box.top).toBeGreaterThanOrEqual(bounds.top);
        expect(box.bottom).toBeLessThanOrEqual(bounds.bottom);
        expect(button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)), `${section} at ${time}ms: ${button.textContent || button.getAttribute("aria-label")}`).toBe(true);
      }
    }
    for (const animation of animations) animation.finish();
  }
});

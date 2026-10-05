import type { CSSProperties } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { SettingsModal } from "./SettingsModal";
import "../styles.css";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const noop = () => {};
const asyncNoop = async () => {};
const warning = "Included wrap-up support requires Claude Code 2.1.277 or newer. Update Claude Code in Updates; normal Claude conversations remain available.";

beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it.each([[1400, 900, 1], [980, 680, 1.5]] as const)("keeps the connected Claude runtime warning and Updates action usable at %sx%s and scale %s", async (width, height, scale) => {
  await page.viewport(width, height);
  const onSave = vi.fn();
  const updateRuntime = vi.fn(asyncNoop);
  render(<div className="app-shell" data-theme="mythra" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <SettingsModal
      open initialSection="models" settings={{ ...DEFAULT_SETTINGS, provider: "claude" }}
      appUpdater={{ phase: "idle", currentVersion: "1.22.1", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop }}
      developerRuntimeUpdater={{ status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime }}
      claudeStatus={{ available: true, path: "C:\\Users\\fixture\\.local\\bin\\claude.exe", version: "2.1.276 (Claude Code)", loggedIn: true, authMethod: "claude.ai", email: "fixture@example.com", subscriptionType: "max", warning }}
      account={null} runtimeStatus={null} openRouterReady={false} githubStatus={null}
      childAgentReadiness={{ codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: true, cursorReady: false }}
      onClose={noop} onSave={onSave} onThemePreview={noop} onEffortSliderPreview={noop} onChatFontPreview={noop}
      onSignIn={asyncNoop} onClaudeRefresh={vi.fn()} onRuntimeRequired={noop} onWorkspaceTools={noop} onOpenRouterChange={noop}
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
  expect(within(dialog).getByText("Connected", { selector: ".connected-badge" })).toBeVisible();
  const notice = within(dialog).getByText(warning).closest<HTMLElement>(".settings-notice")!;
  expect(notice).toHaveAttribute("role", "status");
  const button = within(notice).getByRole("button", { name: "Open Updates" });
  button.scrollIntoView({ block: "center" });
  await waitFor(() => {
    expect(notice).toBeVisible();
    const bounds = dialog.getBoundingClientRect();
    const rect = notice.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth + 1);
  });
  await page.getByRole("button", { name: "Open Updates" }).click();
  expect(await screen.findByRole("heading", { name: "Developer runtimes" })).toBeVisible();
  expect(onSave).not.toHaveBeenCalled();
  expect(updateRuntime).not.toHaveBeenCalled();
});

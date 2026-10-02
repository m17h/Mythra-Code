import type { CSSProperties } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { DEFAULT_SETTINGS, themeColorScheme } from "../lib/appConfig";
import { SettingsModal } from "./SettingsModal";
import "../styles.css";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined), revealItemInDir: vi.fn(async () => undefined) }));

type ModalProps = Parameters<typeof SettingsModal>[0];
const noop = () => {};
const asyncNoop = async () => {};
function settingsProps(overrides: Partial<ModalProps> = {}): ModalProps {
  return {
    open: true, initialSection: "github", settings: { ...DEFAULT_SETTINGS },
    appUpdater: { phase: "idle", currentVersion: "1.19.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, openRouterReady: false,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    githubStatus: { available: true, authenticated: false },
    onClose: noop, onSave: noop, onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
    onGitHubSignIn: asyncNoop, onGitHubRefresh: asyncNoop, onGitHubClone: async () => true, onError: noop,
    profiles: [], agents: [], actions: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    skillsFolder: "", skills: [], removedSkills: [], skillsBusy: false, skillsError: "", workspaceToolsAvailable: false,
    onProfiles: noop, onAgents: noop, onActions: noop, onSchedules: noop, onWorkflows: noop,
    onRunWorkflow: noop, onStopWorkflow: async () => true, onProjects: noop,
    onChooseSkillsFolder: noop, onRefreshSkills: noop, onImportSkills: noop, onCreateSkill: async () => true,
    onReadSkill: async () => "", onUpdateSkill: asyncNoop, onRenameSkill: () => true,
    onToggleSkill: noop, onRemoveSkill: async () => true, onRestoreSkill: async () => true,
    onOpenOnboarding: noop, ...overrides,
  };
}

beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it("retains native clone recovery details instead of replacing them with model-runtime advice", async () => {
  vi.mocked(openFolderDialog).mockResolvedValueOnce("/projects");
  const failure = "Clone failed: SSH permission denied (publickey). Verify access to owner/repo before retrying. No existing folder was overwritten.";
  const onGitHubClone = vi.fn().mockRejectedValue(new Error(failure));
  render(<div className="app-shell" data-theme="mythra"><SettingsModal {...settingsProps({
    githubStatus: { available: true, authenticated: true }, onGitHubClone,
  })} /></div>);
  await page.getByRole("textbox", { name: "Repository URL" }).fill("https://github.com/owner/repo");
  await page.getByRole("button", { name: "Choose parent folder…" }).click();
  await page.getByRole("button", { name: "Clone repository" }).click();
  expect(await screen.findByRole("alert")).toHaveTextContent(failure);
  expect(screen.getByRole("textbox", { name: "Repository URL" })).toHaveValue("https://github.com/owner/repo");
});

it.each([["mythra", 1], ["atari", 1.5]] as const)("keeps rejected sign-in recovery inside real %s Settings at scale %s", async (theme, scale) => {
  await page.viewport(scale === 1 ? 1400 : 980, scale === 1 ? 900 : 680);
  // This is the actual non-macOS native rejection contract, not a pre-rendered
  // error fixture. Neither this callback nor Refresh performs real auth writes.
  const failure = "Run `gh auth login` in a terminal, then refresh GitHub settings.";
  const onGitHubSignIn = vi.fn().mockRejectedValue(new Error(failure));
  const onGitHubRefresh = vi.fn(asyncNoop);
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <SettingsModal {...settingsProps({ onGitHubSignIn, onGitHubRefresh })} />
  </div>);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(failure);
  expect(onGitHubSignIn).toHaveBeenCalledOnce();
  const copy = within(dialog).getByRole("button", { name: "Copy GitHub login command" });
  copy.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("gh auth login --hostname github.com"));
  expect(await within(dialog).findByText("Command copied")).toBeVisible();
  const previousRefreshes = onGitHubRefresh.mock.calls.length;
  await page.getByRole("button", { name: "Refresh GitHub status" }).click();
  expect(onGitHubRefresh).toHaveBeenCalledTimes(previousRefreshes + 1);
  const content = dialog.querySelector<HTMLElement>(".settings-content")!;
  expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
  const alert = within(dialog).getByRole("alert").getBoundingClientRect();
  const bounds = dialog.getBoundingClientRect();
  expect(alert.left).toBeGreaterThanOrEqual(bounds.left);
  expect(alert.right).toBeLessThanOrEqual(bounds.right + 1);
});

it.each([[360, 400, 1], [980, 480, 1.5]] as const)("keeps real Settings usable at %sx%s and scale %s across wide-pane transitions", async (width, height, scale) => {
  await page.viewport(width, height);
  render(<div className="app-shell" data-theme="atari" data-color-scheme="light" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <SettingsModal {...settingsProps({ initialSection: "general" })} />
  </div>);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const assertContained = async () => {
    await waitFor(() => {
      const bounds = dialog.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width + 1);
      expect(bounds.bottom).toBeLessThanOrEqual(height + 1);
    });
    const content = dialog.querySelector<HTMLElement>(".settings-content")!;
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth + 1);
    expect(content.clientHeight).toBeGreaterThan(0);
    // The chooser's preview and check must leave a readable text column even
    // when zoom narrows the pane without crossing a viewport media breakpoint.
    for (const card of content.querySelectorAll<HTMLElement>(".theme-card, .slider-style-card, .chat-font-card, .provider-logo-options > button")) {
      const label = card.querySelector<HTMLElement>("span:nth-child(2)")!;
      expect(label.clientWidth, card.textContent ?? "chooser label").toBeGreaterThanOrEqual(70);
      expect(card.scrollWidth, card.textContent ?? "chooser card").toBeLessThanOrEqual(card.clientWidth + 1);
    }
    const save = within(dialog).getByRole("button", { name: /^Save settings$/ });
    expect(save.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    save.focus();
    await userEvent.keyboard("{Tab}");
    expect(within(dialog).getByRole("textbox", { name: "Search settings" })).toHaveFocus();
  };
  await assertContained();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await assertContained();
  await page.getByRole("button", { name: "Interface", exact: true }).click();
  await assertContained();
});

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { DEFAULT_SETTINGS, MAX_TERMINAL_TIMEOUT_MINUTES } from "../lib/appConfig";
import { SettingsModal } from "./SettingsModal";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    wheelOverTerminalTimeout(deltaY: number): Promise<void>;
  }
}

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
const noop = () => undefined;
const asyncNoop = async () => undefined;
function timeoutReviewProps() {
  return {
    open: true, initialSection: "system" as const, settings: DEFAULT_SETTINGS,
    appUpdater: { phase: "idle" as const, currentVersion: "1.25.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, claudeStatus: null, openRouterReady: false, githubStatus: null,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    onClose: vi.fn(), onSave: vi.fn(), onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onClaudeRefresh: vi.fn(), onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
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

beforeEach(async () => { await commands.setStreamTestReducedMotion(true); });
afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

it("scrolls the Runtime pane with a trusted wheel without editing or blurring the focused timeout", async () => {
  await page.viewport(960, 600);
  const modalProps = timeoutReviewProps();
  render(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} /></div>);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.getByRole("spinbutton", { name: "Timeout minutes" }).click();
    const input = screen.getByRole("spinbutton", { name: "Timeout minutes" });
    const pane = input.closest<HTMLElement>(".settings-content")!;
    expect(pane.scrollTop).toBeGreaterThan(0);
    for (const delta of [-100, 100]) {
      const beforeScroll = pane.scrollTop;
      await commands.wheelOverTerminalTimeout(delta);
      expect(input).toHaveValue(5);
      await waitFor(() => delta < 0
        ? expect(pane.scrollTop).toBeLessThan(beforeScroll)
        : expect(pane.scrollTop).toBeGreaterThan(beforeScroll));
      expect(input).toHaveFocus();
    }
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowUp}");
    expect(input).toHaveValue(6);
    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveValue(5);
    // The newly mounted field must keep the same behavior after toggling off/on.
    await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
    await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
  }
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(modalProps.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTimeoutMinutes: 5 }));
});

it("steps with the real keyboard, respects bounds, and keeps focus and an accessible error during invalid edits", async () => {
  const modalProps = timeoutReviewProps();
  render(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} /></div>);
  const input = screen.getByRole("spinbutton", { name: "Timeout minutes" });
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).click();
  await userEvent.keyboard("{ArrowUp}");
  expect(input).toHaveValue(6);
  expect(input).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  expect(input).toHaveValue(5);
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("1");
  await userEvent.keyboard("{ArrowDown}");
  expect(input).toHaveValue(1);
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill(String(MAX_TERMINAL_TIMEOUT_MINUTES));
  await userEvent.keyboard("{ArrowUp}");
  expect(input).toHaveValue(MAX_TERMINAL_TIMEOUT_MINUTES);
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("");
  expect(input).toHaveFocus();
  expect(input).toHaveAccessibleDescription("Enter a whole number of minutes, 1 or more.");
  await userEvent.keyboard("{Tab}");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(modalProps.onSave).not.toHaveBeenCalled();
});

it("adopts untouched external limits and protects a focused invalid draft across repeated external changes", async () => {
  const modalProps = timeoutReviewProps();
  const view = render(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} /></div>);
  const next = { ...DEFAULT_SETTINGS, terminalTimeoutMinutes: 23 };
  view.rerender(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} settings={next} /></div>);
  await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(23));
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("");
  for (const minutes of [0, 45]) {
    view.rerender(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} settings={{ ...DEFAULT_SETTINGS, terminalTimeoutMinutes: minutes }} /></div>);
    expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  }
  // Safari's system keyboard-navigation preference may skip buttons on Tab.
  // Focus directly, then exercise the button with trusted keyboard input.
  screen.getByRole("switch", { name: "Automatically stop terminal commands" }).focus();
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).toHaveFocus();
  await userEvent.keyboard(" ");
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).not.toBeChecked();
  await userEvent.keyboard(" ");
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(23);
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(modalProps.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTimeoutMinutes: 23 }));
});

it("reseeds a canceled invalid draft from updated persisted settings on reopening", async () => {
  const modalProps = timeoutReviewProps();
  const view = render(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} /></div>);
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("1e2");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitFor(() => expect(modalProps.onClose).toHaveBeenCalledOnce());
  const next = { ...DEFAULT_SETTINGS, terminalTimeoutMinutes: 0 };
  view.rerender(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} open={false} settings={next} /></div>);
  view.rerender(<div className="app-shell" data-theme="mythra"><SettingsModal {...modalProps} settings={next} /></div>);
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  expect(modalProps.onSave).not.toHaveBeenCalled();
});

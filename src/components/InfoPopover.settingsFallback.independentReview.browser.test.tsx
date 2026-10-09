import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { SettingsModal } from "./SettingsModal";

vi.mock("../lib/floatingLayer", async (original) => ({
  ...await original<typeof import("../lib/floatingLayer")>(), supportsTopLayer: () => false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<object>(), invoke: vi.fn(async (command: string) => command === "local_skills_catalog" ? [{
  id: "testing", publisher: "anthropic", title: "Web app testing", description: "Test apps", repository: "anthropics/skills",
  path: "skills/webapp-testing", revision: "a".repeat(40), license: "Apache-2.0", notes: "", requirements: "Python and Playwright.",
}] : null) }));

const noop = () => {};
const asyncNoop = async () => {};
function fixture(onClose: () => void) {
  const props: Parameters<typeof SettingsModal>[0] = {
    open: true, initialSection: "skills", settings: { ...DEFAULT_SETTINGS },
    appUpdater: { phase: "idle", currentVersion: "1.19.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop },
    developerRuntimeUpdater: { status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop },
    account: null, runtimeStatus: null, openRouterReady: false,
    childAgentReadiness: { codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false },
    githubStatus: null, onClose, onSave: noop, onThemePreview: noop, onEffortSliderPreview: noop, onChatFontPreview: noop,
    onSignIn: asyncNoop, onRuntimeRequired: noop, onWorkspaceTools: noop, onOpenRouterChange: noop,
    onGitHubSignIn: asyncNoop, onGitHubRefresh: asyncNoop, onGitHubClone: async () => true, onError: noop,
    profiles: [], agents: [], actions: [], schedules: [], workflows: [], workflowRuns: [], projects: [],
    skillsFolder: "/fixture/skills", skills: [], removedSkills: [], skillsBusy: false, skillsError: "", workspaceToolsAvailable: false,
    onProfiles: noop, onAgents: noop, onActions: noop, onSchedules: noop, onWorkflows: noop,
    onRunWorkflow: noop, onStopWorkflow: async () => true, onProjects: noop,
    onChooseSkillsFolder: noop, onRefreshSkills: noop, onImportSkills: noop, onCreateSkill: async () => true,
    onReadSkill: async () => "", onUpdateSkill: asyncNoop, onRenameSkill: () => true,
    onToggleSkill: noop, onRemoveSkill: async () => true, onRestoreSkill: async () => true,
    onInstallOfficialSkill: async () => "/fixture/skills/testing/SKILL.md",
    onOpenOnboarding: noop,
  };
  return <><button type="button">Outside before Settings</button><div className="app-shell" data-theme="mythra" data-color-scheme="dark"><SettingsModal {...props} /></div><button type="button">Outside after Settings</button></>;
}

async function openRequirements(onClose: () => void) {
  render(fixture(onClose));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await userEvent.click(within(dialog).getByText("Download Anthropic & OpenAI skills"));
  const trigger = await within(dialog).findByRole("button", { name: "Requirements for Web app testing" });
  await userEvent.click(trigger);
  const panel = screen.getByRole("tooltip");
  expect(dialog.contains(panel)).toBe(false);
  return { dialog, trigger, panel };
}

it("keeps a mouse-focused fallback requirements panel's Tab inside actual Settings", async () => {
  const onClose = vi.fn();
  const { dialog, panel } = await openRequirements(onClose);
  await userEvent.click(within(panel).getByText("Python and Playwright."));
  expect(onClose).not.toHaveBeenCalled();
  expect(panel).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  expect(dialog.contains(document.activeElement)).toBe(true);
});

it("returns focus to the requirements trigger when Escape hides a focused fallback panel", async () => {
  const onClose = vi.fn();
  const { trigger, panel } = await openRequirements(onClose);
  await userEvent.click(within(panel).getByText("Python and Playwright."));
  expect(panel).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  expect(trigger).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
});

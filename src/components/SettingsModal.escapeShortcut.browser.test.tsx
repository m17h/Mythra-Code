import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { AppSelectMenu } from "./AppSelectMenu";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
const noop = () => undefined;
const asyncNoop = async () => undefined;

function Harness({ stopTurn }: { stopTurn: () => void }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [open, setOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  useAppShortcuts({
    modalOpen: open, commandPaletteOpen: false, threadOpen: true, running: true,
    escapeStopsRun: settings.escapeStopsRun, workspaceOpen, workspaceAvailable: true,
    toggleCommandPalette: noop, openConversationSearch: noop, newThread: noop,
    openSettings: () => setOpen(true), toggleWorkspace: () => setWorkspaceOpen(!workspaceOpen),
    closeWorkspace: () => setWorkspaceOpen(false), stopTurn,
  });
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <button onClick={() => setOpen(true)}>Open settings</button>
    <button>Run surface</button>
    <textarea aria-label="Composer" />
    <output aria-label="Workspace state">{workspaceOpen ? "Open" : "Closed"}</output>
    <AppSelectMenu ariaLabel="Choose model" value="one" options={[{ value: "one", label: "First" }, { value: "two", label: "Second" }]} onChange={noop} />
    <SettingsModal
      open={open} initialSection="general" settings={settings}
      appUpdater={{ phase: "idle", currentVersion: "1.25.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop }}
      developerRuntimeUpdater={{ status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop }}
      account={null} runtimeStatus={null} openRouterReady={false} githubStatus={null}
      childAgentReadiness={{ codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false }}
      onClose={() => setOpen(false)} onSave={(next) => { setSettings(next); setOpen(false); }}
      onThemePreview={noop} onEffortSliderPreview={noop} onChatFontPreview={noop}
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
  </div>;
}

afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it("saves the Escape preference while retaining real menu, dialog and editable-field behavior", async () => {
  await commands.setStreamTestReducedMotion(true);
  const stopTurn = vi.fn();
  render(<Harness stopTurn={stopTurn} />);
  const toggle = screen.getByRole("switch", { name: "Escape stops the active run" });
  expect(toggle).toBeChecked();
  const bounds = toggle.getBoundingClientRect();
  expect(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.closest("button")).toBe(toggle);
  // A Settings dialog owns Escape even with stopping enabled.
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
  expect(stopTurn).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.getByRole("switch", { name: "Escape stops the active run" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByRole("button", { name: "Run surface" }).click();
  await userEvent.keyboard("{Escape}");
  expect(stopTurn).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Workspace state")).toHaveTextContent("Closed");
  await page.getByRole("button", { name: "Choose model" }).click();
  expect(screen.getByRole("menu", { name: "Choose model choices" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu", { name: "Choose model choices" })).not.toBeInTheDocument();
  expect(stopTurn).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  expect(screen.getByRole("switch", { name: "Escape stops the active run" })).not.toBeChecked();
  await page.getByRole("switch", { name: "Escape stops the active run" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByRole("textbox", { name: "Composer" }).click();
  await userEvent.keyboard("{Escape}");
  expect(stopTurn).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Choose model" }).click();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu", { name: "Choose model choices" })).not.toBeInTheDocument();
  expect(stopTurn).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Run surface" }).click();
  await userEvent.keyboard("{Escape}");
  expect(stopTurn).toHaveBeenCalledOnce();
});

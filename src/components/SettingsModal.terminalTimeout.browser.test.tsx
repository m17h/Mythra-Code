import { useState, type CSSProperties } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { DEFAULT_SETTINGS, MAX_TERMINAL_TIMEOUT_MINUTES } from "../lib/appConfig";
import { confirmDialog } from "../lib/confirmDialog";
import type { AppSettings } from "../types";
import { SettingsModal } from "./SettingsModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
const noop = () => undefined;
const asyncNoop = async () => undefined;

function Harness({ initial = DEFAULT_SETTINGS, onSave = noop, scale = 1 }: {
  initial?: AppSettings; onSave?: (settings: AppSettings) => void; scale?: number;
}) {
  const [settings, setSettings] = useState(initial);
  const [open, setOpen] = useState(true);
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ zoom: scale, "--ui-scale": scale } as CSSProperties}>
    <button onClick={() => setOpen(true)}>Reopen settings</button>
    <output aria-label="Saved terminal timeout">{settings.terminalTimeoutMinutes}</output>
    <SettingsModal
      open={open} initialSection="system" settings={settings}
      appUpdater={{ phase: "idle", currentVersion: "1.25.0", availableVersion: null, notes: null, publishedAt: null, downloadedBytes: 0, totalBytes: null, error: null, checkForUpdates: asyncNoop, downloadAndRestart: asyncNoop }}
      developerRuntimeUpdater={{ status: null, checking: false, updating: null, error: null, message: null, checkForUpdates: asyncNoop, updateRuntime: asyncNoop }}
      account={null} runtimeStatus={null} claudeStatus={null} openRouterReady={false} githubStatus={null}
      childAgentReadiness={{ codexRuntimeAvailable: false, openAiSignedIn: false, openRouterReady: false, claudeReady: false, cursorReady: false }}
      onClose={() => setOpen(false)} onSave={(next) => { onSave(next); setSettings(next); setOpen(false); }}
      onThemePreview={noop} onEffortSliderPreview={noop} onChatFontPreview={noop}
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
  </div>;
}

beforeEach(async () => {
  vi.mocked(confirmDialog).mockClear();
  await commands.setStreamTestReducedMotion(true);
});
afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

async function reopen() {
  await page.getByRole("button", { name: "Reopen settings" }).click();
  await waitFor(() => expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible());
}

it("starts at five minutes, saves a custom limit and saves no automatic timeout across reopening", async () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).toBeChecked();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(5);
  expect(screen.getByText(/commands already running keep the limit they launched with/)).toBeVisible();
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("37");
  expect(onSave).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTimeoutMinutes: 37 }));
  await reopen();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(37);
  await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
  expect(screen.getByText("No automatic timeout")).toBeVisible();
  expect(screen.queryByRole("spinbutton", { name: "Timeout minutes" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTimeoutMinutes: 0 }));
  await reopen();
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).not.toBeChecked();
  expect(screen.getByText("No automatic timeout")).toBeVisible();
  // An off setting carries no hidden lifetime-specific custom value after it
  // is saved and reopened; enabling it again uses the documented default.
  await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(5);
});

it("discards a custom edit on Cancel and restores the saved value on reopening", async () => {
  const onSave = vi.fn();
  render(<Harness initial={{ ...DEFAULT_SETTINGS, terminalTimeoutMinutes: 23 }} onSave={onSave} />);
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("45");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitFor(() => expect(confirmDialog).toHaveBeenCalledWith("Discard unsaved settings changes?"));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Saved terminal timeout")).toHaveTextContent("23");
  await reopen();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(23);
  await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await reopen();
  expect(screen.getByRole("switch", { name: "Automatically stop terminal commands" })).toBeChecked();
  expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveValue(23);
  expect(onSave).not.toHaveBeenCalled();
});

it("blocks empty, non-whole, negative, zero and excessive limits until the user corrects the input", async () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  for (const text of ["", "0", "-1", "1.5", "1e3", String(MAX_TERMINAL_TIMEOUT_MINUTES + 1)]) {
    await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill(text);
    expect(screen.getByRole("spinbutton", { name: "Timeout minutes" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  }
  await page.getByRole("button", { name: "Interface", exact: true }).click();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(screen.getByText(/Fix the terminal timeout in Runtime to save/)).toBeVisible();
  await page.getByRole("button", { name: "Runtime", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill("19");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  await page.getByRole("button", { name: "Save settings" }).click();
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ terminalTimeoutMinutes: 19 }));
});

it.each([[1280, 900, 1], [960, 680, 1], [980, 680, 1.5]] as const)("keeps the timeout switch to the right and all content inside its card at %sx%s and scale %s", async (width, height, scale) => {
  await page.viewport(width, height);
  render(<Harness scale={scale} />);
  const input = screen.getByRole("spinbutton", { name: "Timeout minutes" });
  const row = input.closest<HTMLElement>(".terminal-timeout-row")!;
  const card = row.closest<HTMLElement>(".set-card")!;
  const assertFits = async () => {
    row.scrollIntoView({ block: "center" });
    await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "Settings" }).getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      const copy = row.querySelector<HTMLElement>(".set-copy")!.getBoundingClientRect();
      const toggle = screen.getByRole("switch", { name: "Automatically stop terminal commands" }).getBoundingClientRect();
      expect(toggle.left).toBeGreaterThanOrEqual(copy.right - 1);
      expect(toggle.top).toBeLessThan(copy.bottom);
      for (const element of row.querySelectorAll<HTMLElement>(".set-copy, .toggle-switch, .terminal-timeout-detail, input, .terminal-timeout-error")) {
        const bounds = element.getBoundingClientRect();
        expect(bounds.left).toBeGreaterThanOrEqual(cardBounds.left);
        expect(bounds.right).toBeLessThanOrEqual(cardBounds.right + 1);
        expect(bounds.left).toBeGreaterThanOrEqual(dialog.left);
        expect(bounds.right).toBeLessThanOrEqual(dialog.right + 1);
        // Native inputs scroll their text internally for deliberately oversized
        // invalid values; their outer box must still fit the card. Containers
        // and validation copy must not acquire horizontal overflow.
        if (!(element instanceof HTMLInputElement)) expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      }
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    });
  };
  await assertFits();
  await page.getByRole("spinbutton", { name: "Timeout minutes" }).fill(String(MAX_TERMINAL_TIMEOUT_MINUTES + 1));
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await assertFits();
  await page.getByRole("switch", { name: "Automatically stop terminal commands" }).click();
  expect(screen.getByText("No automatic timeout")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  await assertFits();
});

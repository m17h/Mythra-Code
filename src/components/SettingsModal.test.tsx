import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import type { AppUpdater } from "../lib/appUpdater";
import { SettingsModal } from "./SettingsModal";

const updater: AppUpdater = {
  phase: "idle",
  currentVersion: "0.4.1",
  availableVersion: null,
  notes: null,
  publishedAt: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  checkForUpdates: vi.fn(async () => undefined),
  downloadAndRestart: vi.fn(async () => undefined),
};

function modalProps(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}): Parameters<typeof SettingsModal>[0] {
  return {
    open: true,
    initialSection: "general",
    appUpdater: updater,
    settings: { ...DEFAULT_SETTINGS },
    account: null,
    runtimeStatus: null,
    openRouterReady: false,
    onClose: vi.fn(),
    onSave: vi.fn(),
    onThemePreview: vi.fn(),
    onAccountChange: vi.fn(async () => undefined),
    onSignIn: vi.fn(async () => undefined),
    onRuntimeRequired: vi.fn(),
    onWorkspaceTools: vi.fn(),
    onOpenRouterChange: vi.fn(),
    onError: vi.fn(),
    profiles: [],
    agents: [],
    actions: [],
    schedules: [],
    workflows: [],
    workflowRuns: [],
    projects: [],
    skillsFolder: "",
    skills: [],
    skillsBusy: false,
    skillsError: "",
    workspaceToolsAvailable: false,
    onProfiles: vi.fn(),
    onAgents: vi.fn(),
    onActions: vi.fn(),
    onSchedules: vi.fn(),
    onWorkflows: vi.fn(),
    onRunWorkflow: vi.fn(),
    onStopWorkflow: vi.fn(),
    onChooseSkillsFolder: vi.fn(),
    onRefreshSkills: vi.fn(),
    onImportSkills: vi.fn(),
    onCreateSkill: vi.fn(async () => true),
    onRenameSkill: vi.fn(() => true),
    onToggleSkill: vi.fn(),
    onProjects: vi.fn(),
    onOpenOnboarding: vi.fn(),
    ...overrides,
  };
}

describe("SettingsModal", () => {
  it("organizes every settings destination into a labeled navigation group", () => {
    render(<SettingsModal {...modalProps()} />);

    expect(within(screen.getByRole("group", { name: "Workspace" })).getByRole("button", { name: /Projects/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Intelligence" })).getByRole("button", { name: /Models & accounts/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Automation" })).getByRole("button", { name: /Tools & MCP/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "System" })).getByRole("button", { name: /Updates/ })).toBeInTheDocument();
  });

  it("opens directly to the requested settings section", () => {
    render(<SettingsModal {...modalProps({ initialSection: "models" })} />);

    expect(screen.getByRole("button", { name: /Models & accounts/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Model provider" })).toBeInTheDocument();
  });

  it("shows a connected state instead of prompting an authenticated Claude user to sign in again", () => {
    render(<SettingsModal
      {...modalProps({
        initialSection: "models",
        settings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-sonnet-4-6" },
        claudeStatus: {
          available: true,
          path: "/usr/local/bin/claude",
          version: "2.1.0",
          loggedIn: true,
          authMethod: "claude.ai",
          email: "morgan@example.com",
          subscriptionType: "max",
          warning: null,
        },
      })}
    />);

    expect(screen.getByText("Connected", { selector: ".connected-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument();
  });

  it("previews a theme immediately but does not save it when cancelled", () => {
    const onThemePreview = vi.fn();
    const onClose = vi.fn();
    const onSave = vi.fn();
    // Cancelling with unsaved changes now asks for confirmation first.
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SettingsModal {...modalProps({ onThemePreview, onClose, onSave })} />);

    fireEvent.click(screen.getByRole("button", { name: /Midnight/ }));
    expect(onThemePreview).toHaveBeenLastCalledWith("midnight");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps the modal open when the user declines to discard changes", () => {
    const onClose = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<SettingsModal {...modalProps({ onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: /Midnight/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("offers the onboarding guide again from General settings", () => {
    const onOpenOnboarding = vi.fn();
    render(<SettingsModal {...modalProps({ onOpenOnboarding })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run onboarding" }));
    expect(onOpenOnboarding).toHaveBeenCalledOnce();
  });
});

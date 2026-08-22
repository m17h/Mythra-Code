import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    childAgentReadiness: { codexRuntimeAvailable: true, openAiSignedIn: true, openRouterReady: false, claudeReady: true, cursorReady: false },
    githubStatus: null,
    usageTotals: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
      threads: 0,
    },
    onClose: vi.fn(),
    onSave: vi.fn(),
    onThemePreview: vi.fn(),
    onAccountChange: vi.fn(async () => undefined),
    onSignIn: vi.fn(async () => undefined),
    onRuntimeRequired: vi.fn(),
    onWorkspaceTools: vi.fn(),
    onOpenRouterChange: vi.fn(),
    onGitHubSignIn: vi.fn(async () => undefined),
    onGitHubRefresh: vi.fn(async () => undefined),
    onGitHubClone: vi.fn(async () => true),
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
    removedSkills: [],
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
    onRemoveSkill: vi.fn(async () => true),
    onRestoreSkill: vi.fn(async () => true),
    onProjects: vi.fn(),
    onOpenOnboarding: vi.fn(),
    ...overrides,
  };
}

describe("SettingsModal", () => {
  it("uses the official OpenRouter glyph in provider settings", () => {
    const { container } = render(<SettingsModal {...modalProps({ initialSection: "models" })} />);
    expect(container.querySelector(".provider-logo.openrouter svg")).toHaveAttribute("viewBox", "0 0 401.4 293.7");
  });

  it("offers LM Studio as a local model provider", () => {
    render(<SettingsModal {...modalProps({ initialSection: "models" })} />);

    expect(screen.getByRole("button", { name: /LM Studio/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /LM Studio/ }));
    expect(screen.getByText("LM Studio local server")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://127.0.0.1:1234/v1")).toBeInTheDocument();
  });

  it("organizes every settings destination into a labeled navigation group", () => {
    render(<SettingsModal {...modalProps()} />);

    expect(within(screen.getByRole("group", { name: "Workspace" })).getByRole("button", { name: /Projects/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Intelligence" })).getByRole("button", { name: /Models & accounts/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Automation" })).getByRole("button", { name: /Tools & MCP/ })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "System" })).getByRole("button", { name: /Updates/ })).toBeInTheDocument();
  });

  it("offers only the OpenKiwi and Daylight themes", () => {
    render(<SettingsModal {...modalProps()} />);

    expect(screen.getByRole("button", { name: /OpenKiwi.*Deep graphite/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Daylight.*Paper white/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Midnight|Ember|Violet/ })).not.toBeInTheDocument();
  });

  it("opens directly to the requested settings section", () => {
    render(<SettingsModal {...modalProps({ initialSection: "models" })} />);

    expect(screen.getByRole("button", { name: /Models & accounts/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Default model provider" })).toBeInTheDocument();
    expect(screen.getByText(/Each thread keeps its own provider/)).toBeInTheDocument();
  });

  it("saves the chosen logo for OpenAI models", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "models", onSave })} />);

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(screen.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ openAiLogo: "codex" }));
  });

  it("saves the chosen logo for Claude models", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "models", onSave })} />);

    fireEvent.click(screen.getByRole("radio", { name: "Anthropic" }));
    expect(screen.getByRole("radio", { name: "Anthropic" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ claudeLogo: "anthropic" }));
  });

  it("saves the official dark app icon for Cursor models", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "models", onSave })} />);

    fireEvent.click(screen.getByRole("radio", { name: /Cursor Dark/ }));
    expect(screen.getByRole("radio", { name: /Cursor Dark/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ cursorLogo: "app-dark" }));
  });

  it("shows GitHub connection and repository cloning in their own settings pane", () => {
    const onGitHubRefresh = vi.fn(async () => undefined);
    render(<SettingsModal {...modalProps({
      initialSection: "github",
      onGitHubRefresh,
      githubStatus: {
        available: true,
        authenticated: true,
        login: "morgan",
        name: "Morgan",
      },
    })} />);

    expect(screen.getByRole("heading", { name: "GitHub account" })).toBeInTheDocument();
    expect(screen.getByText("@morgan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clone a repository" })).toBeInTheDocument();
    expect(onGitHubRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows LM Studio connection status and refreshes its local catalog", () => {
    const onLMStudioRefresh = vi.fn(async () => []);
    render(<SettingsModal {...modalProps({
      initialSection: "models",
      lmStudioReady: true,
      lmStudioModels: [
        { id: "local/a", displayName: "A", publisher: "local", trainedForToolUse: true, reasoningEfforts: [] },
        { id: "local/b", displayName: "B", publisher: "local", trainedForToolUse: true, reasoningEfforts: [] },
      ],
      onLMStudioRefresh,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: /LM Studio.*Local models through your LM Studio server/ }));
    expect(screen.getByText("2 models available")).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".connected-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
    expect(onLMStudioRefresh).toHaveBeenCalledOnce();
  });

  it("rescans skills when the pane opens and when the app regains focus", async () => {
    const onRefreshSkills = vi.fn(async () => undefined);
    const props = modalProps({
      initialSection: "skills",
      skillsFolder: "C:\\Users\\Morgan\\Skills",
      onRefreshSkills,
    });
    const { rerender } = render(<SettingsModal {...props} />);

    await waitFor(() => expect(onRefreshSkills).toHaveBeenCalledWith(false));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(onRefreshSkills).toHaveBeenCalledWith(true));

    const callsBeforeClose = onRefreshSkills.mock.calls.length;
    rerender(<SettingsModal {...props} open={false} />);
    window.dispatchEvent(new Event("focus"));
    expect(onRefreshSkills).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("defaults the quota display to percentage remaining and explains its reach", () => {
    render(<SettingsModal {...modalProps({ initialSection: "usage" })} />);

    const group = screen.getByRole("radiogroup", { name: "Provider quota display" });
    expect(within(group).getByRole("radio", { name: /Percentage remaining/ })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: /Percentage consumed/ })).toHaveAttribute("aria-checked", "false");
    expect(within(group).queryByText(/Counts down what is still available/)).not.toBeInTheDocument();
    expect(within(group).queryByText(/Counts up what has already been used/)).not.toBeInTheDocument();
    expect(screen.getByText(/OpenAI\/Codex rate limits, and Claude Code rate limits/)).toBeInTheDocument();
    expect(screen.getByText(/reset time/)).toBeInTheDocument();
    expect(screen.getByText("Example · 5h window 58% left")).toBeInTheDocument();
  });

  it("saves the consumed direction and previews it before saving", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "usage", onSave })} />);

    fireEvent.click(screen.getByRole("radio", { name: /Percentage consumed/ }));
    expect(screen.getByRole("radio", { name: /Percentage consumed/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Percentage remaining/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Example · 5h window 42% used")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ usageDisplay: "consumed" }));
  });

  it("preselects a previously saved consumed preference", () => {
    render(<SettingsModal {...modalProps({
      initialSection: "usage",
      settings: { ...DEFAULT_SETTINGS, usageDisplay: "consumed" },
    })} />);

    expect(screen.getByRole("radio", { name: /Percentage consumed/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Example · 5h window 42% used")).toBeInTheDocument();
  });

  it("shows cumulative all-time token and API-equivalent usage", () => {
    render(<SettingsModal {...modalProps({
      initialSection: "usage",
      usageTotals: {
        inputTokens: 12_000,
        cachedInputTokens: 2_000,
        cacheWriteInputTokens: 0,
        outputTokens: 3_000,
        reasoningOutputTokens: 1_000,
        totalTokens: 15_000,
        estimatedCost: 1.25,
        pricedTokens: 15_000,
        unpricedTokens: 0,
        threads: 4,
      },
    })} />);

    expect(screen.getByText("$1.25")).toBeInTheDocument();
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getByText("3,000")).toBeInTheDocument();
    expect(screen.getByText("4 tracked threads")).toBeInTheDocument();
  });

  it("keeps project prompts out of Settings and points to the chat header", () => {
    render(<SettingsModal {...modalProps({
      initialSection: "projects",
      projects: [{ id: "kiwi", name: "OpenKiwi", path: "/code/kiwi", overrides: { systemPrompt: "Existing project prompt" } }],
    })} />);

    expect(screen.getByText(/Project instructions now live beside the project name/)).toBeInTheDocument();
    expect(screen.queryByText("Instruction prompt override")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Existing project prompt")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /Daylight/ }));
    expect(onThemePreview).toHaveBeenLastCalledWith("daylight");

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

    fireEvent.click(screen.getByRole("button", { name: /Daylight/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("moves focus into the dialog on open and keeps Tab inside it", async () => {
    const { rerender } = render(<SettingsModal {...modalProps({ open: false })} />);
    rerender(<SettingsModal {...modalProps()} />);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    const focusable = dialog.querySelectorAll<HTMLElement>("button, input, select, textarea");
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("offers the onboarding guide again from General settings", () => {
    const onOpenOnboarding = vi.fn();
    render(<SettingsModal {...modalProps({ onOpenOnboarding })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run onboarding" }));
    expect(onOpenOnboarding).toHaveBeenCalledOnce();
  });

  it("opens the skill creation editor on demand and closes it again after a successful create", async () => {
    const onCreateSkill = vi.fn(async () => true);
    render(<SettingsModal {...modalProps({
      initialSection: "skills",
      skillsFolder: "/skills",
      onCreateSkill,
    })} />);

    expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a new skill" }));

    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "release-check" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Verify the release notes." } });
    fireEvent.click(screen.getByRole("button", { name: /Create skill/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Add a new skill" })).toBeInTheDocument());
    expect(onCreateSkill).toHaveBeenCalledWith("release-check", "Verify the release notes.");
    expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
  });

  it("lets Escape dismiss the open skill editor before it can close Settings", () => {
    const onClose = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "skills", skillsFolder: "/skills", onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: "Add a new skill" }));
    fireEvent.change(screen.getByLabelText("Skill name"), { target: { value: "half-typed" } });
    fireEvent.keyDown(screen.getByLabelText("Skill name"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add a new skill" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates and saves a project-specific sub-agent policy", () => {
    const onProjects = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      activeProjectId: "project-1",
      projects: [{ id: "project-1", name: "Kiwi", path: "/tmp/kiwi" }],
      onProjects,
    })} />);

    expect(screen.getByLabelText("Policy for")).toHaveValue("project-1");
    expect(screen.getByText(/currently inherits the Chats & project defaults policy/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Customize/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onProjects).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "project-1",
        overrides: expect.objectContaining({ subagents: expect.objectContaining({ enabled: true, maxConcurrent: 1 }) }),
      }),
    ]);
  });

  it("keeps unsaved drafts and shows a newly cloned project when projects change while open", () => {
    const props = modalProps({ initialSection: "prompts" });
    const { rerender } = render(<SettingsModal {...props} />);

    fireEvent.change(screen.getByPlaceholderText("Empty — add your own instructions here"), { target: { value: "Always ship with release notes." } });
    rerender(<SettingsModal {...props} projects={[{ id: "cloned", name: "Cloned repo", path: "/tmp/cloned" }]} />);

    expect(screen.getByDisplayValue("Always ship with release notes.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Workspace" })).getByRole("button", { name: /Projects/ }));
    expect(screen.getByText("Cloned repo")).toBeInTheDocument();
  });

  it("saves separate global, Codex subscription, and Claude subscription prompts", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "prompts", onSave })} />);

    fireEvent.change(screen.getByPlaceholderText("Empty — add your own instructions here"), { target: { value: "Global rules" } });
    fireEvent.change(screen.getByPlaceholderText("Optional Codex-specific instructions"), { target: { value: "Codex rules" } });
    fireEvent.change(screen.getByPlaceholderText("Optional Claude-specific instructions"), { target: { value: "Claude rules" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: "Global rules",
      codexSystemPrompt: "Codex rules",
      claudeSystemPrompt: "Claude rules",
    }));
  });

  it("explains that global provider instruction files are not inherited", () => {
    render(<SettingsModal {...modalProps({ initialSection: "prompts" })} />);

    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("Global instruction files are not inherited");
    expect(notice).toHaveTextContent("CLAUDE.md");
    expect(notice).toHaveTextContent("AGENTS.md");
    expect(notice).toHaveTextContent("do not affect OpenKiwi");
    expect(notice).toHaveTextContent("Project-level AGENTS.md files can still be discovered");
  });

  it("controls project AGENTS.md discovery from Prompt settings", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "prompts", onSave })} />);

    const toggle = screen.getByRole("switch", { name: "Project AGENTS.md discovery" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ projectInstructionsEnabled: true }));
  });

  it("starts with no built-in prompt profiles", () => {
    render(<SettingsModal {...modalProps({ initialSection: "prompts", profiles: [] })} />);

    expect(screen.getByText("No prompt profiles yet")).toBeInTheDocument();
    expect(screen.queryByText("Concise builder")).not.toBeInTheDocument();
    expect(screen.queryByText("Careful reviewer")).not.toBeInTheDocument();
  });

  it("applies all three layers from a user-created prompt profile", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "prompts",
      onSave,
      profiles: [{ id: "mine", name: "My profile", prompt: "Global saved", codexPrompt: "Codex saved", claudePrompt: "Claude saved" }],
    })} />);

    fireEvent.click(screen.getByRole("button", { name: /^My profile/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      promptProfileId: "mine",
      systemPrompt: "Global saved",
      codexSystemPrompt: "Codex saved",
      claudeSystemPrompt: "Claude saved",
    }));
  });

  it("keeps unsaved drafts when the saved settings change externally while open", () => {
    const props = modalProps({ initialSection: "prompts" });
    const { rerender } = render(<SettingsModal {...props} />);

    fireEvent.change(screen.getByPlaceholderText("Empty — add your own instructions here"), { target: { value: "Draft in progress" } });
    rerender(<SettingsModal {...props} settings={{ ...DEFAULT_SETTINGS, notificationsEnabled: false }} />);

    expect(screen.getByDisplayValue("Draft in progress")).toBeInTheDocument();
  });

  it("resets drafts to the incoming props after closing and reopening", () => {
    const props = modalProps({ initialSection: "prompts" });
    const { rerender } = render(<SettingsModal {...props} />);

    fireEvent.change(screen.getByPlaceholderText("Empty — add your own instructions here"), { target: { value: "Abandoned draft" } });
    rerender(<SettingsModal {...props} open={false} />);
    rerender(<SettingsModal {...props} />);

    expect(screen.queryByDisplayValue("Abandoned draft")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Empty — add your own instructions here")).toHaveValue(DEFAULT_SETTINGS.systemPrompt);
  });
});

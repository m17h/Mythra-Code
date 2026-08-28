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

/** A saved crew, as it comes back out of persisted settings. */
function preset() {
  return {
    id: "review-crew",
    name: "Review sub-agents",
    policy: {
      enabled: true,
      maxConcurrent: 2,
      childAgents: {
        enabled: true,
        targets: [
          { id: "reviewer", provider: "claude" as const, model: "claude-fable-5", label: "Reviewer", description: "", enabled: true, reasoningMode: "inherit" as const, reasoningEffort: "medium" as const, reasoningMaxEffort: "high" as const },
          { id: "builder", provider: "openai" as const, model: "gpt-5.6-terra", label: "Builder", description: "", enabled: true, reasoningMode: "inherit" as const, reasoningEffort: "medium" as const, reasoningMaxEffort: "high" as const },
        ],
      },
    },
  };
}

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
    onEffortSliderPreview: vi.fn(),
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
    onReadSkill: vi.fn(async () => "# Review\n\nReview carefully.\n"),
    onUpdateSkill: vi.fn(async () => undefined),
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
  it("orders model providers by the primary subscription choices", () => {
    const { container } = render(<SettingsModal {...modalProps({ initialSection: "models" })} />);
    const providers = [...container.querySelectorAll(".provider-card strong")].map((node) => node.textContent);

    expect(providers).toEqual(["OpenAI", "Anthropic", "Cursor", "OpenRouter", "LM Studio"]);
  });

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

  it("offers every registered theme and effort-slider style", () => {
    const { container } = render(<SettingsModal {...modalProps()} />);

    expect(screen.getByRole("button", { name: /Mythra.*Deep graphite/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Light Mythra.*Paper white/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Kiwi.*electric green/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Light Kiwi.*Paper white/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Midnight.*ocean blue/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Synthwave.*magenta/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ember.*amber/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Terminal.*Phosphor/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spectrum.*Heat colors/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Classic.*original/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Neon.*model's accent/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pixel.*VU meter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aurora.*northern-light/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ink.*monochrome/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sonar.*pings/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Vital.*heartbeat/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dune.*desert sand/ })).toBeInTheDocument();

    const themeCards = container.querySelectorAll<HTMLButtonElement>(".theme-card");
    const sliderCards = container.querySelectorAll<HTMLButtonElement>(".slider-style-card");
    expect(themeCards[0]).toHaveTextContent("Mythra");
    expect(themeCards[0]).toHaveAttribute("aria-pressed", "true");
    expect(themeCards[1]).toHaveTextContent("Light Mythra");
    expect(themeCards[2]).toHaveTextContent("Kiwi");
    expect(themeCards[3]).toHaveTextContent("Light Kiwi");
    expect(sliderCards[0]).toHaveTextContent("Aurora");
    expect(sliderCards[0]).toHaveAttribute("aria-pressed", "true");
    expect(DEFAULT_SETTINGS).toMatchObject({ theme: "mythra", effortSlider: "aurora" });
  });

  it("previews an effort-slider style immediately", () => {
    const onEffortSliderPreview = vi.fn();
    render(<SettingsModal {...modalProps({ onEffortSliderPreview })} />);

    fireEvent.click(screen.getByRole("button", { name: /Classic.*original/ }));
    expect(onEffortSliderPreview).toHaveBeenLastCalledWith("classic");
  });

  it.each([
    [/Sonar.*pings/, "sonar", "slider-style-preview sonar"],
    [/Vital.*heartbeat/, "vital", "slider-style-preview vital"],
    [/Dune.*desert sand/, "dune", "slider-style-preview dune"],
  ])("previews and selects the %s effort-slider style", (name, id, previewClass) => {
    const onEffortSliderPreview = vi.fn();
    render(<SettingsModal {...modalProps({ onEffortSliderPreview })} />);

    const card = screen.getByRole("button", { name });
    // Each card carries its own preview class, so the swatch matches the style.
    expect(card.querySelector(".slider-style-preview")).toHaveClass(...previewClass.split(" "));
    fireEvent.click(card);
    expect(onEffortSliderPreview).toHaveBeenLastCalledWith(id);
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens directly to the requested settings section", () => {
    render(<SettingsModal {...modalProps({ initialSection: "models" })} />);

    expect(screen.getByRole("button", { name: /Models & accounts/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Default model provider" })).toBeInTheDocument();
    expect(screen.getByText(/Each thread keeps its own provider/)).toBeInTheDocument();
  });

  it("creates a simple schedule with explicit units, model, and thread behavior", () => {
    const onSchedules = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "workflows",
      projects: [{ id: "project-1", name: "My project", path: "/tmp/my-project" }],
      onSchedules,
    })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Schedule name" }), { target: { value: "Review twice daily" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule location" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /My project/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Schedule interval" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule interval unit" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Terra/ }));
    fireEvent.click(screen.getByRole("button", { name: "Schedule thread behavior" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Continue the same thread/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule prompt" }), { target: { value: "Review the current changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    const created = onSchedules.mock.calls[0][0][0];
    expect(created).toMatchObject({
      name: "Review twice daily",
      prompt: "Review the current changes",
      projectId: "project-1",
      intervalValue: 12,
      intervalUnit: "hours",
      intervalMinutes: 720,
      threadMode: "reuse",
      enabled: true,
      run: expect.objectContaining({ provider: "openai", model: "gpt-5.6-terra" }),
    });
    expect(created.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("creates a simple schedule in Chats without requiring a project", () => {
    const onSchedules = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "workflows",
      projects: [],
      onSchedules,
    })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Schedule name" }), { target: { value: "Morning brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule location" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Chats/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule prompt" }), { target: { value: "Summarize my priorities" } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));

    expect(onSchedules.mock.calls[0][0][0]).toMatchObject({
      name: "Morning brief",
      projectId: null,
      intervalValue: 60,
      intervalUnit: "minutes",
      threadMode: "new",
    });
  });

  it("chooses and saves a default model from an app-owned provider menu", () => {
    const onSave = vi.fn();
    const { container } = render(<SettingsModal {...modalProps({
      initialSection: "models",
      settings: { ...DEFAULT_SETTINGS, provider: "claude", model: "claude-opus-5" },
      onSave,
    })} />);

    const trigger = screen.getByRole("button", { name: "Default Claude model" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveTextContent("Opus 5");
    expect(container.querySelector(".default-model-picker select")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(container.querySelector(".default-model-picker .app-select")).toHaveClass("opens-up");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Sonnet 5/ }));
    expect(trigger).toHaveTextContent("Sonnet 5");

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
      model: "claude-sonnet-5",
    }));
  });

  it("uses each provider's live model catalog in the default picker", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "models",
      settings: { ...DEFAULT_SETTINGS, provider: "cursor", model: "auto" },
      cursorModels: [
        { id: "auto", name: "Auto", configOptions: [] },
        { id: "grok-4.5", name: "Grok 4.5", configOptions: [] },
      ],
      onSave,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Default Cursor model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Grok 4.5/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      provider: "cursor",
      model: "grok-4.5",
    }));
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
      projects: [{ id: "kiwi", name: "Mythra Code", path: "/code/kiwi", overrides: { systemPrompt: "Existing project prompt" } }],
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

  it("previews a theme immediately but does not save it when cancelled", async () => {
    const onThemePreview = vi.fn();
    const onClose = vi.fn();
    const onSave = vi.fn();
    // Cancelling with unsaved changes now asks for confirmation first.
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<SettingsModal {...modalProps({ onThemePreview, onClose, onSave })} />);

    fireEvent.click(screen.getByRole("button", { name: /Light Kiwi/ }));
    expect(onThemePreview).toHaveBeenLastCalledWith("daylight");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The confirmation now resolves through the async dialog helper.
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps the modal open when the user declines to discard changes", () => {
    const onClose = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<SettingsModal {...modalProps({ onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: /Light Kiwi/ }));
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

  it("applies a preset as a project-specific sub-agent setup", () => {
    const onProjects = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      activeProjectId: "project-1",
      projects: [{ id: "project-1", name: "Kiwi", path: "/tmp/kiwi" }],
      settings: { ...DEFAULT_SETTINGS, childAgentPresets: [preset()] },
      onProjects,
    })} />);

    expect(screen.queryByLabelText("Apply presets to")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply Review sub-agents" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Kiwi/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onProjects).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "project-1",
        overrides: expect.objectContaining({ subagents: expect.objectContaining({ enabled: true, maxConcurrent: 2 }) }),
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
    expect(notice).toHaveTextContent("do not affect Mythra Code");
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

  it("saves the automatic sub-agent archive preference", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "agents", onSave })} />);

    const toggle = screen.getByRole("switch", { name: "Archive sub-agent threads automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ autoArchiveSubagentThreads: false }));
  });

  it("shows one preset workflow without exposing a separate policy editor", () => {
    render(<SettingsModal {...modalProps({ initialSection: "agents" })} />);

    const archiveToggle = screen.getByRole("switch", { name: "Archive sub-agent threads automatically" });
    const presetsHeading = screen.getByRole("heading", { name: "Sub-agent presets" });
    expect(archiveToggle.compareDocumentPosition(presetsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByLabelText("Apply presets to")).not.toBeInTheDocument();
    expect(screen.queryByText(/inherited defaults/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create preset" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Allow sub-agent spawning" })).not.toBeInTheDocument();
  });

  it("keeps optional custom agent profiles out of the primary setup flow", () => {
    render(<SettingsModal {...modalProps({ initialSection: "agents" })} />);

    const summary = screen.getByText("Custom agent profiles").closest("summary");
    const details = summary?.closest("details");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(summary as HTMLElement);
    expect(details).toHaveAttribute("open");
  });

  it("creates a preset with an explicit name and starting point", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "agents", onSave })} />);

    fireEvent.click(screen.getByRole("button", { name: "Create preset" }));

    const name = screen.getByLabelText("New preset name");
    expect(name).toHaveFocus();
    expect(screen.getByText(/Starts as a copy of/)).toHaveTextContent("Chats & project defaults");
    fireEvent.change(name, { target: { value: "Review sub-agents" } });
    fireEvent.click(screen.getByRole("button", { name: "Create and configure" }));

    expect(screen.getByRole("button", { name: "Collapse Review sub-agents" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Allow sub-agent spawning" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      childAgentPresets: [expect.objectContaining({
        id: "review-sub-agents",
        name: "Review sub-agents",
        policy: expect.objectContaining({ enabled: true }),
      })],
    }));
  });

  it("can return to edit the first preset after creating a second one", () => {
    render(<SettingsModal {...modalProps({ initialSection: "agents" })} />);

    const create = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
      fireEvent.change(screen.getByLabelText("New preset name"), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "Create and configure" }));
    };

    create("Review sub-agents");
    create("Build sub-agents");

    expect(screen.getByRole("button", { name: "Collapse Build sub-agents" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Expand Review sub-agents" }));

    expect(screen.getByRole("button", { name: "Collapse Review sub-agents" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Expand Build sub-agents" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Review sub-agents")).toBeInTheDocument();
  });

  it("edits one preset at a time with every sub-agent control available", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "agents", onSave, settings: { ...DEFAULT_SETTINGS, childAgentPresets: [preset()] } })} />);

    const edit = screen.getByRole("button", { name: "Expand Review sub-agents" });
    const body = document.getElementById(edit.getAttribute("aria-controls") ?? "");
    expect(body).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(edit);
    expect(body).not.toHaveAttribute("aria-hidden");
    fireEvent.click(within(body as HTMLElement).getByRole("switch", { name: "Allow sub-agent spawning" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      childAgentPresets: [expect.objectContaining({ id: "review-crew", policy: expect.objectContaining({ enabled: false }) })],
    }));
  });

  it("uses the preset roster directly without a separate cross-provider switch", () => {
    const legacyPreset = preset();
    legacyPreset.policy.childAgents.enabled = false;
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      settings: { ...DEFAULT_SETTINGS, childAgentPresets: [legacyPreset] },
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand Review sub-agents" }));

    expect(screen.queryByRole("switch", { name: "Allow cross-provider sub-agents" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("New destination name")).toBeEnabled();
  });

  it("distinguishes configured choices from the simultaneous running cap", () => {
    const limitedPreset = preset();
    limitedPreset.policy.maxConcurrent = 1;
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      settings: { ...DEFAULT_SETTINGS, childAgentPresets: [limitedPreset] },
    })} />);

    expect(screen.getByText(/2 configured · 1 at a time/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Review sub-agents" }));
    expect(screen.getByText("Max running at once")).toBeInTheDocument();

    const increase = screen.getByRole("button", { name: "More concurrent sub-agents" });
    fireEvent.click(increase);
    expect(within(screen.getByLabelText("Maximum concurrent sub-agents")).getByText("2")).toBeInTheDocument();
    expect(increase).toBeDisabled();
  });

  it("renames a preset only after the pencil action is used", () => {
    render(<SettingsModal {...modalProps({ initialSection: "agents", settings: { ...DEFAULT_SETTINGS, childAgentPresets: [preset()] } })} />);

    expect(screen.queryByLabelText("Name for preset 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename Review sub-agents" }));
    const name = screen.getByLabelText("Name for preset 1");
    fireEvent.change(name, { target: { value: "Build sub-agents" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish renaming Build sub-agents" }));

    expect(screen.queryByLabelText("Name for preset 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand Build sub-agents" })).toBeInTheDocument();
  });

  it("applies a preset to a destination chosen from its compact menu", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      onSave,
      settings: { ...DEFAULT_SETTINGS, subagentsEnabled: false, childAgentPresets: [preset()] },
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Review sub-agents" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Chats & project defaults/ }));

    expect(screen.getByRole("status")).toHaveTextContent("Review sub-agents is now the sub-agent setup for Chats & project defaults.");

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ subagentsEnabled: true, subagentMax: 2 }));
  });

  it("offers a plainly named action to reset a project's custom setup", () => {
    const onProjects = vi.fn();
    render(<SettingsModal {...modalProps({
      initialSection: "agents",
      projects: [{
        id: "project-1",
        name: "Kiwi",
        path: "/tmp/kiwi",
        overrides: { subagents: preset().policy },
      }],
      settings: { ...DEFAULT_SETTINGS, childAgentPresets: [preset()] },
      onProjects,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Apply Review sub-agents" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^Reset Kiwi to chat defaults/ }));

    expect(screen.getByRole("status")).toHaveTextContent("Kiwi now uses Chats & project defaults.");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onProjects).toHaveBeenCalledWith([
      expect.objectContaining({ id: "project-1", overrides: undefined }),
    ]);
  });

  it("deletes a saved sub-agent preset", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...modalProps({ initialSection: "agents", onSave, settings: { ...DEFAULT_SETTINGS, childAgentPresets: [preset()] } })} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Review sub-agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ childAgentPresets: [] }));
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

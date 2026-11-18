import "./SettingsModal.base.css";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openFolderDialog, save } from "@tauri-apps/plugin-dialog";
import { ChatFontSettings, chatFontName, chatFontOptions } from "./ChatFontPicker";
import { useCustomFontFaces, useCustomFonts } from "../lib/customFonts";
import { isTauri } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/confirmDialog";
import { skillMentionRanges } from "../lib/skillMentions";
import { mergePromptProfileDrafts } from "../lib/instructionFiles";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BookOpenCheck,
  Keyboard,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderCog,
  Gauge,
  GitFork,
  Info,
  LoaderCircle,
  Palette,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
  CornerDownRight,
} from "lucide-react";
import { formatShortcut } from "../lib/shortcuts";
import { orderSettingsResults, searchWords } from "../lib/searchMatch";
import { exportDiagnostics, recentAuditRows, rpc, saveLmStudioKey, saveOpenRouterKey, type AuditRow, type CodexRuntimeStatus } from "../lib/codex";
import { cancelClaudeLogin, isClaudeDefaultModel, isClaudeModelSuperseded, visibleClaudeModels, type ClaudeRuntimeStatus } from "../lib/claude";
import { claudeUsesApiKey, codexAccountReady } from "../lib/providerAuth";
import { ClaudeBillingPanel, OpenAiApiKeyPanel, useProviderAuthOperation } from "./ProviderApiKeyPanel";
import type { CursorModel, CursorRuntimeStatus } from "../lib/cursor";
import { DEFAULT_CURSOR_MODEL, DEFAULT_LM_STUDIO_BASE_URL, DEFAULT_OPENAI_MODEL, DEFAULT_PARENT_FOLLOW_UP_LIMIT, DEFAULT_SETTINGS, DEFAULT_TERMINAL_TIMEOUT_MINUTES, EFFORT_SLIDER_STYLES, MAX_PARENT_FOLLOW_UP_LIMIT, MAX_TERMINAL_TIMEOUT_MINUTES, RELEASE_NOTES_URL, THEMES, sanitizeParentFollowUpLimit, sanitizeTerminalTimeoutMinutes } from "../lib/appConfig";
import { latestSolModel } from "../lib/threadProvider";
import { resolveThreadTitleModel } from "../lib/threadTitles";
import { formatGitError, friendlyError } from "../lib/errors";
import { resolveProviderSystemPrompt } from "../lib/systemPrompt";
import { useModalFocus } from "../hooks/useModalFocus";
import { useSettingsSheetResize } from "../hooks/useSettingsSheetResize";
import { SETTINGS_PANE_ICONS } from "./settingsPaneIcons";
import { AnthropicLogo, ClaudeLogo, CodexLogo, CursorDarkAppIcon, CursorLogo, LmStudioLogo, OpenAILogo, OpenRouterLogo, ProviderLogo } from "./BrandLogos";
import type { LMStudioModel } from "../lib/lmStudio";
import { updateProgress, type AppUpdater } from "../lib/appUpdater";
import {
  projectSubagentSettingsFromApp,
  providerDisplayName,
  sanitizeChildAgentPresetPolicy,
  sanitizeChildAgentPresets,
  sanitizeProjectSubagentOverrides,
  sanitizeSubagentModelGuidance,
  uniqueChildAgentPresetId,
  MAX_CHILD_AGENT_PRESETS,
  MAX_SUBAGENT_MODEL_GUIDANCE,
  type ChildAgentReadiness,
} from "../lib/childAgents";
import type { LocalSkill } from "../lib/skills";
import type { InstructionFileDescriptor } from "../lib/instructionFiles";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { SubagentPolicyEditor } from "./SubagentPolicyEditor";
import { SubagentModelGuidanceEditor, subagentModelGuidanceDraftChanged, type SubagentModelGuidanceDraft } from "./SubagentModelGuidanceEditor";
import { CustomAgentsSettings, EMPTY_HARNESS_DRAFTS, McpServerSettings, QuickActionsSettings, type HarnessDrafts } from "./HarnessSettings";
import { EmptyState, rovingChoiceKeyDown, SettingInfo, SettingsJumpList, Switch } from "./SettingsBits";
import { WorkflowManager } from "./WorkflowManager";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { PreferenceLearningSettings } from "./PreferenceLearningSettings";
import { LanguageToolsSettings } from "./LanguageToolsSettings";
import { DevicesSettings } from "./remote/DevicesSettings";
import { LOCAL_MACHINE, useActiveMachine } from "../lib/remote/activeMachine";
import { localMachineLabel, useRemoteDevices } from "../lib/remote/devices";
import type { PreferenceHistoryProgress } from "../hooks/usePreferenceLearning";
import { SkillLibrary } from "./SkillLibrary";
import { PromptsSettings, type PromptLayer } from "./PromptsSettings";
import { setPerformanceOverlayEnabled, usePerformanceOverlayEnabled } from "../lib/performanceOverlay";
import { setTrayStatusEnabled, useTrayStatusEnabled } from "../lib/trayStatus";
import { clearTurnContextReceipts, setTurnContextRecordingEnabled, useTurnContextReceiptCount, useTurnContextRecordingEnabled } from "../lib/turnContextReceipts";
import { flushPendingStateWrites } from "../lib/storage";
import type { McpView } from "./StudioDock";
import { parseGitHubCloneTarget, type GitHubAccountStatus } from "../lib/github";
import { joinPath } from "../lib/paths";
import { UsageDashboard } from "./UsageDashboard";
import { FrontierPricingSettings } from "./FrontierPricingSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import type {
  Account,
  AppSettings,
  ChatFont,
  ChildAgentPreset,
  CustomAgentProfile,
  EffortSliderStyle,
  Project,
  ProjectAction,
  ProjectDefaults,
  PromptProfile,
  Provider,
  ScheduledTask,
  ScheduleRunRecord,
  ThemeName,
  SettingsSection,
  SkillDependencyReport,
  UsageDisplayMode,
} from "../types";
import { usagePercentLabel } from "../lib/providerUsage";
import { isWindowsPlatform } from "../lib/platform";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { ProjectProfiles } from "./ProjectProfiles";
import "./SettingsModal.css";
import { CLAUDE_FALLBACK_MODELS } from "./ClaudeModelControl";
import { openAiModelOptions, type RuntimeModel } from "./ModelPowerControl";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import type { ChildAgentModelCatalogs } from "./subAgentModelOptions";
import type { ClaudeModel } from "../lib/claude";
import type { OpenRouterModel } from "./OpenRouterModelControl";
import { sanitizeProjectDefaultOverrides } from "../lib/projectDefaults";
import { SmoothDisclosure } from "./SmoothDisclosure";
import { onboardingHandoff, settingsWithAppearance, settingsWithDefaultProvider, type OnboardingAppearance, type OnboardingSettingsDraft } from "../lib/onboardingSettings";
import { cachedDeveloperRuntimeUpdates, checkDeveloperRuntimeUpdates, updateDeveloperRuntime, type DeveloperRuntimeTarget, type DeveloperRuntimeTargetStatus, type DeveloperRuntimeUpdater } from "../lib/runtimeUpdates";

/**
 * Single source of truth for the settings navigation: the rail, the pane
 * heading, and its supporting line all read from here, so a label can never
 * drift between the button and the pane it opens.
 */
/**
 * The settings map, in the order a person actually sets one up: how it looks,
 * what it thinks with, what it does on its own, then the machine underneath.
 *
 * `keywords` is what makes the sidebar's search worth having. People look for
 * the *setting* ("api key", "dark mode", "mcp"), not the section it was filed
 * under, so every pane carries the vocabulary of the settings inside it.
 */
/** Panes the app can open directly, plus reference panes reached only from
 * the rail. A superset, so it keeps compiling once App can link to them too. */
type SettingsPane = SettingsSection | "pricing";

type SettingsNavItem = {
  id: SettingsPane; label: string; icon: typeof Palette; detail: string; keywords: string;
  /** Shown as a tab of this pane; listed in the sidebar only while searching. */
  parent?: SettingsPane;
};

// Grouped by what someone is trying to do, not by implementation. The
// "Connections" group name and the Devices, Models & accounts, Voice input and
// Updates labels are quoted by Rust and remote strings ("Settings → Connections
// → Devices"); keep them exactly as they are.
const SETTINGS_NAV: ReadonlyArray<{ group: string; items: ReadonlyArray<SettingsNavItem> }> = [
  {
    group: "App",
    items: [
      { id: "general", label: "General", icon: SETTINGS_PANE_ICONS["general"], detail: "How Mythra Code behaves day to day.", keywords: "general behavior behaviour keyboard shortcut escape esc stop cancel active run notification notifications alert menu bar tray status thread title titles naming rename luna onboarding guided setup getting started help tour" },
      { id: "appearance", label: "Appearance", icon: SETTINGS_PANE_ICONS["appearance"], detail: "Theme, size and fonts.", keywords: "appearance theme dark light colour color scheme font typeface text size scale zoom density effort slider logo logos icon mark marks look custom fonts" },
      { id: "voice", label: "Voice input", icon: SETTINGS_PANE_ICONS["voice"], detail: "Dictate into the message box with its own transcription key.", keywords: "voice input dictation dictate microphone mic speech to text speech-to-text transcription transcribe whisper audio record recording api key openai openrouter model" },
    ],
  },
  {
    group: "AI",
    items: [
      { id: "models", label: "Models & accounts", icon: SETTINGS_PANE_ICONS["models"], detail: "Connect your accounts and choose the default provider and model.", keywords: "model provider account accounts sign in login api key openai chatgpt codex anthropic claude cursor openrouter lm studio subscription credentials token default service tier speed fast priority max reasoning warning" },
      { id: "prompts", label: "Instructions", icon: SETTINGS_PANE_ICONS["prompts"], detail: "What every agent is told before your message.", keywords: "prompt prompts system instructions agents.md claude.md guidance context profile profiles preset global codex claude layer" },
      { id: "memory", label: "Memory", icon: SETTINGS_PANE_ICONS["memory"], detail: "Optionally learn how you like to work from your conversations.", keywords: "memory learning learned preferences history personalize personalization remember experimental" },
    ],
  },
  {
    group: "Agents",
    items: [
      { id: "agents", label: "Sub-agents", icon: SETTINGS_PANE_ICONS["agents"], detail: "How agents split work across helper agents.", keywords: "sub-agent subagent child agent delegate parallel concurrency preset presets archive cleanup crew mythra v2 preview conversation steering review model guidance notes follow-up custom agents specialist" },
      { id: "skills", label: "Skills", icon: SETTINGS_PANE_ICONS["skills"], detail: "Markdown skills in a local folder that models can call by name.", keywords: "skill skills markdown folder library import capability" },
      { id: "tools", label: "MCP & language servers", icon: SETTINGS_PANE_ICONS["tools"], detail: "Local MCP servers and language tools.", keywords: "mcp tool tools server servers stdio model context protocol integration workspace language languages lsp install automatic setup" },
    ],
  },
  {
    group: "Projects & automation",
    items: [
      { id: "projects", label: "Projects", icon: SETTINGS_PANE_ICONS["projects"], detail: "Git setup and per-project overrides.", keywords: "profile export import copy share project folder workspace default override overrides per-project repository repo git init initialize initialization" },
      { id: "workflows", label: "Workflows", icon: SETTINGS_PANE_ICONS["workflows"], detail: "Multi-step agent workflows and one-click quick actions.", keywords: "workflow automation recipe steps pipeline action actions quick command run trigger" },
      { id: "scheduled-tasks", label: "Scheduled tasks", icon: SETTINGS_PANE_ICONS["scheduled-tasks"], detail: "Prompts that run on their own in a chat or a project.", keywords: "schedule scheduled cron timer interval recurring unattended background task reminder" },
    ],
  },
  {
    group: "Connections",
    items: [
      { id: "github", label: "GitHub", icon: SETTINGS_PANE_ICONS["github"], detail: "Connect your GitHub account and clone repositories into new projects.", keywords: "github git clone repository repo account sign in gh cli remote" },
      { id: "devices", label: "Devices", icon: SETTINGS_PANE_ICONS["devices"], detail: "Use this computer from your others on the same network, or the other way round.", keywords: "device devices remote nearby pair pairing paired lan local network host viewer machine switcher another computer pc mac access revoke invitation" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "usage", label: "Usage", icon: SETTINGS_PANE_ICONS["usage"], detail: "Everything this device has used, and how quotas are shown.", keywords: "usage spending quota limit tokens cost price pricing spend billing rate percentage remaining consumed" },
      { id: "pricing", label: "Model pricing", icon: SETTINGS_PANE_ICONS["pricing"], parent: "usage", detail: "Official API list prices per 1M tokens, for reference.", keywords: "pricing price prices rate rates cost api list per million mtok token tokens input output cache read write cached long context openai anthropic claude gpt opus sonnet haiku" },
      { id: "updates", label: "Updates", icon: SETTINGS_PANE_ICONS["updates"], detail: "Mythra Code, Claude Code and the Codex CLI.", keywords: "update upgrade version release install download changelog notes" },
      { id: "system", label: "Advanced", icon: SETTINGS_PANE_ICONS["system"], detail: "Terminal limits, privacy records and diagnostics.", keywords: "advanced runtime terminal scrollback history memory timeout time limit stop kill command local server dev server long-running minutes privacy instruction records receipts diagnostics logs errors performance overlay" },
    ],
  },
];

type SettingsRow = {
  /** Stable id: never derived from the label at runtime, so renaming a label
   * can't break links. Markup may carry it as `data-settings-row`. */
  id: string;
  pane: SettingsPane;
  label: string;
  keywords?: string;
  /** Stable target for controls outside the shared setting-row markup. */
  target?: "openrouter-key" | "lmstudio-server" | "transcription-key" | "openai-api-key" | "claude-billing" | "general-shortcuts";
  accountProvider?: Provider;
};

/** Individual settings that search can jump to. Most use the visible title
 * (an `h4`, a `.set-row strong` or a `summary`, matched on its exact text), so
 * a renamed label must be renamed here too. Provider-specific controls also
 * name their disclosure and stable target. */
const SETTINGS_ROWS: ReadonlyArray<SettingsRow> = [
  { id: "general.escape-stops-the-active-run", pane: "general", label: "Escape stops the active run", keywords: "esc keyboard shortcut cancel" },
  { id: "general.desktop-notifications", pane: "general", label: "Desktop notifications", keywords: "notify alert" },
  { id: "general.status-in-the-menu-bar", pane: "general", label: "Status in the menu bar", keywords: "tray menu bar notification area icon running" },
  { id: "general.automatic-thread-titles", pane: "general", label: "Automatic thread titles", keywords: "name rename title luna" },
  { id: "general.guided-setup", pane: "general", label: "Guided setup", keywords: "onboarding tour getting started help" },
  { id: "general.keyboard-shortcuts", pane: "general", label: "Keyboard shortcuts", keywords: "keys hotkeys keyboard cheat sheet help", target: "general-shortcuts" },
  { id: "appearance.theme", pane: "appearance", label: "Theme", keywords: "dark light colour color appearance" },
  { id: "appearance.app-scale", pane: "appearance", label: "App scale", keywords: "zoom size interface text bigger smaller" },
  { id: "appearance.chat-font", pane: "appearance", label: "Chat font", keywords: "font typeface serif mono" },
  { id: "appearance.custom-fonts", pane: "appearance", label: "Custom fonts", keywords: "font file installed typeface add" },
  { id: "appearance.effort-slider", pane: "appearance", label: "Effort slider", keywords: "reasoning slider style" },
  { id: "appearance.provider-logos", pane: "appearance", label: "Provider logos", keywords: "logo icon mark openai claude cursor" },
  { id: "voice.transcription-provider", pane: "voice", label: "Transcription provider", keywords: "voice dictation speech openai openrouter" },
  { id: "voice.transcription-api-key", pane: "voice", label: "Transcription API key", keywords: "voice dictation speech key token credential", target: "transcription-key" },
  { id: "voice.transcription-model", pane: "voice", label: "Transcription model", keywords: "voice dictation speech whisper gpt transcribe" },
  { id: "models.accounts", pane: "models", label: "Accounts", keywords: "sign in login account connections" },
  { id: "models.openai-api-key-and-billing", pane: "models", label: "OpenAI API key and billing", keywords: "openai api key billing subscription chatgpt codex pay as you go", target: "openai-api-key", accountProvider: "openai" },
  { id: "models.claude-api-key-and-billing", pane: "models", label: "Claude API key and billing", keywords: "anthropic claude api key billing subscription console", target: "claude-billing", accountProvider: "claude" },
  { id: "models.openrouter-api-key", pane: "models", label: "OpenRouter API key", keywords: "key token openrouter", target: "openrouter-key", accountProvider: "openrouter" },
  { id: "models.lm-studio-local-server", pane: "models", label: "LM Studio local server", keywords: "lm studio local url token", target: "lmstudio-server", accountProvider: "lmstudio" },
  { id: "models.defaults-for-new-threads", pane: "models", label: "Defaults for new threads", keywords: "default provider model" },
  { id: "models.openai-speed", pane: "models", label: "OpenAI speed", keywords: "service tier fast priority standard" },
  { id: "models.warn-before-using-max-reasoning", pane: "models", label: "Warn before using Max reasoning", keywords: "reasoning effort warning" },
  { id: "prompts.your-instructions", pane: "prompts", label: "Your instructions", keywords: "system prompt global codex claude profile" },
  { id: "prompts.project-files", pane: "prompts", label: "Project files", keywords: "agents.md claude.md discovery" },
  { id: "prompts.what-the-agent-receives", pane: "prompts", label: "What the agent receives", keywords: "preview combined layers" },
  { id: "memory.learned-preferences", pane: "memory", label: "Learned preferences", keywords: "learning history scope provider model" },
  { id: "agents.default-sub-agent-setup", pane: "agents", label: "Default sub-agent setup", keywords: "defaults concurrency parallel delegate" },
  { id: "agents.presets", pane: "agents", label: "Presets", keywords: "preset crew setup" },
  { id: "agents.when-to-use-each-model", pane: "agents", label: "When to use each model", keywords: "model guidance notes parent preferences" },
  { id: "agents.automatic-follow-ups", pane: "agents", label: "Automatic follow-ups", keywords: "follow-up follow up followup limit unlimited continue resume review parent turns budget" },
  { id: "agents.archive-sub-agent-threads-automatically", pane: "agents", label: "Archive sub-agent threads automatically", keywords: "cleanup archive" },
  { id: "agents.custom-agents", pane: "agents", label: "Custom agents", keywords: "specialist instructions profiles" },
  { id: "agents.preview-features", pane: "agents", label: "Preview features", keywords: "mythra code sub-agents v2 preview conversation steering messaging" },
  { id: "skills.your-skills", pane: "skills", label: "Your skills", keywords: "skill list enable disable edit rename" },
  { id: "tools.mcp-servers", pane: "tools", label: "MCP servers", keywords: "mcp server stdio" },
  { id: "tools.language-tools", pane: "tools", label: "Language tools", keywords: "lsp language server install automatic setup" },
  { id: "tools.skills-mcp-in-workspace", pane: "tools", label: "Tools → Skills & MCP", keywords: "in this thread live tools thread tools panel workspace dock skills mcp" },
  { id: "workflows.agent-workflows", pane: "workflows", label: "Agent workflows", keywords: "workflow recipe steps" },
  { id: "workflows.quick-actions", pane: "workflows", label: "Quick actions", keywords: "action command button project" },
  { id: "scheduled-tasks.scheduled-tasks", pane: "scheduled-tasks", label: "Your tasks", keywords: "scheduled tasks schedule task new add recurring" },
  { id: "projects.set-up-git-automatically", pane: "projects", label: "Set up Git automatically", keywords: "git init initialize repository" },
  { id: "projects.project-overrides", pane: "projects", label: "Project overrides", keywords: "per-project defaults provider model theme font" },
  { id: "projects.copy-and-share", pane: "projects", label: "Copy and share", keywords: "export import copy share project settings profile profiles differs defaults" },
  { id: "github.github-account", pane: "github", label: "GitHub account", keywords: "sign in login gh cli" },
  { id: "github.clone-a-repository", pane: "github", label: "Clone a repository", keywords: "clone repo download" },
  { id: "devices.let-my-other-computers-use-this-one", pane: "devices", label: "Let my other computers use this one", keywords: "remote host lan local network turn on allow access nearby" },
  { id: "devices.use-another-computer", pane: "devices", label: "Use another computer", keywords: "request access pair nearby code approve allow decline" },
  { id: "devices.show-this-name-to-nearby-computers", pane: "devices", label: "Show this name to nearby computers", keywords: "privacy device name announcement" },
  { id: "usage.read-limits-as", pane: "usage", label: "Read limits as", keywords: "quota display remaining consumed percentage" },
  { id: "updates.developer-runtimes", pane: "updates", label: "Developer runtimes", keywords: "claude code codex update install" },
  { id: "system.terminal-history", pane: "system", label: "Terminal history", keywords: "terminal scrollback memory buffer" },
  { id: "system.stop-long-running-commands-after", pane: "system", label: "Stop long-running commands after", keywords: "terminal timeout minutes dev server local server" },
  { id: "system.record-last-turn-instructions", pane: "system", label: "Record last-turn instructions", keywords: "privacy instruction records receipts context history" },
  { id: "system.delete-instruction-records", pane: "system", label: "Delete instruction records", keywords: "privacy instruction records delete remove" },
  { id: "system.export-a-diagnostic-bundle", pane: "system", label: "Export a diagnostic bundle", keywords: "diagnostics logs support" },
  { id: "system.performance-overlay", pane: "system", label: "Performance overlay", keywords: "fps frame rate memory heap debug" },
];


/** Does a pane match what someone typed into the sidebar's search field? */
function settingsNavMatches(item: { label: string; detail: string; keywords: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.detail} ${item.keywords}`.toLowerCase();
  // Every word has to land somewhere, so "claude key" reaches Models & accounts
  // without dragging in every pane that merely mentions Claude.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/** "general" used to be the appearance page. Links that still open it with an
 * onboarding appearance draft land on Appearance, where that draft is shown. */
function resolveInitialSection(section: SettingsSection, draft?: OnboardingSettingsDraft): SettingsPane {
  return section === "general" && draft?.appearance ? "appearance" : section;
}

const SETTINGS_PANES = new Map(SETTINGS_NAV.flatMap((section) => section.items.map((item) => [item.id, item] as const)));

/** Typed timeout minutes, or null while the text is not a whole number in range. */
function parseTerminalTimeoutMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= MAX_TERMINAL_TIMEOUT_MINUTES ? minutes : null;
}

/** A typed follow-up limit, or null while the text is not a whole number in range. */
function parseParentFollowUpLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const limit = Number(trimmed);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_PARENT_FOLLOW_UP_LIMIT ? limit : null;
}

const INTERFACE_SIZE_OPTIONS: AppSelectOption[] = [
  { value: "90", label: "Compact", detail: "90% · fit more on screen" },
  { value: "100", label: "Default", detail: "100% · recommended" },
  { value: "110", label: "Comfortable", detail: "110% · easier to read" },
  { value: "125", label: "Large", detail: "125% · maximum size" },
];

const SERVICE_TIER_OPTIONS: AppSelectOption[] = [
  { value: "", label: "Standard", detail: "Regular processing" },
  { value: "priority", label: "Fast · Priority processing", detail: "Faster replies when supported · may cost more or use limits faster" },
];

const TERMINAL_SCROLLBACK_OPTIONS: AppSelectOption[] = [
  { value: "25000", label: "25k characters", detail: "Lightest on memory" },
  { value: "100000", label: "100k characters", detail: "Recommended" },
  { value: "500000", label: "500k characters", detail: "Keeps long build logs" },
];

const PROJECT_PROVIDER_OPTIONS: AppSelectOption[] = [
  { value: "openai", label: "OpenAI", detail: "ChatGPT plan or API key", icon: <ProviderLogo provider="openai" size={15} /> },
  { value: "claude", label: "Claude", detail: "Claude Code · subscription or API key", icon: <ProviderLogo provider="claude" size={15} /> },
  { value: "cursor", label: "Cursor", detail: "Cursor subscription", icon: <ProviderLogo provider="cursor" size={15} /> },
  { value: "openrouter", label: "OpenRouter", detail: "API model routing", icon: <ProviderLogo provider="openrouter" size={15} /> },
  { value: "lmstudio", label: "LM Studio", detail: "Local models", icon: <ProviderLogo provider="lmstudio" size={15} /> },
];

type ModelCatalogs = {
  runtimeModels: RuntimeModel[];
  claudeModels: ClaudeModel[];
  cursorModels: CursorModel[];
  openRouterModels: OpenRouterModel[];
  lmStudioModels: LMStudioModel[];
};

function savedClaudeModelDisplay(provider: Provider, selectedModel: string, catalogs: ModelCatalogs): Omit<AppSelectOption, "value"> | undefined {
  if (provider === "claude" && isClaudeDefaultModel(selectedModel, catalogs.claudeModels.find((entry) => entry.id === selectedModel)?.displayName)) {
    return { label: "Provider default (saved)", detail: "Choose a named Claude model", icon: <ProviderLogo provider="claude" size={15} /> };
  }
  if (provider !== "claude" || !isClaudeModelSuperseded(catalogs.claudeModels, selectedModel)) return undefined;
  return {
    label: "Superseded Claude model",
    detail: "Choose a current model",
    icon: <ProviderLogo provider="claude" size={15} />,
  };
}

function modelOptionsForProvider(provider: Provider, selectedModel: string, catalogs: ModelCatalogs): AppSelectOption[] {
  let options: AppSelectOption[];
  if (provider === "openai") {
    options = openAiModelOptions(catalogs.runtimeModels).map((entry) => ({ value: entry.id, label: entry.name, detail: entry.tagline }));
  } else if (provider === "claude") {
    const source = catalogs.claudeModels.length ? catalogs.claudeModels : CLAUDE_FALLBACK_MODELS;
    options = visibleClaudeModels(source).map((entry) => ({
      value: entry.id,
      label: entry.displayName,
      detail: entry.description || entry.resolvedModel,
      keywords: entry.resolvedModel,
      disabled: entry.disabled,
    }));
  } else if (provider === "cursor") {
    options = (catalogs.cursorModels.length ? catalogs.cursorModels : [{ id: DEFAULT_CURSOR_MODEL, name: "Auto", configOptions: [] }])
      .map((entry) => ({ value: entry.id, label: entry.name || entry.id, detail: entry.id }));
  } else if (provider === "lmstudio") {
    options = catalogs.lmStudioModels.map((entry) => ({
      value: entry.id,
      label: entry.displayName || entry.id,
      detail: `${entry.publisher}${entry.trainedForToolUse ? " · tool use" : ""}`,
    }));
  } else {
    options = catalogs.openRouterModels.map((entry) => ({
      value: entry.id,
      label: entry.name || entry.id,
      detail: entry.id,
      keywords: entry.description,
    }));
  }
  const selectedClaudeModelIsHidden = provider === "claude"
    && (isClaudeDefaultModel(selectedModel, catalogs.claudeModels.find((entry) => entry.id === selectedModel)?.displayName)
      || isClaudeModelSuperseded(catalogs.claudeModels, selectedModel));
  if (selectedModel && !selectedClaudeModelIsHidden && !options.some((entry) => entry.value === selectedModel)) {
    const savedClaudeModel = provider === "claude"
      ? catalogs.claudeModels.find((entry) => entry.id === selectedModel)
      : undefined;
    options = [{
      value: selectedModel,
      label: savedClaudeModel?.displayName ?? selectedModel,
      detail: savedClaudeModel
        ? `${savedClaudeModel.description || savedClaudeModel.resolvedModel} · Current saved model`
        : "Current saved model",
    }, ...options];
  }
  return options.map((option) => ({ ...option, icon: <ProviderLogo provider={provider} size={15} /> }));
}

/** The Sub-agents pane's sections, in page order, for its jump list. */
const SUBAGENT_SECTIONS = [
  { id: "subagents-defaults", label: "Defaults" },
  { id: "subagents-presets", label: "Presets" },
  { id: "subagents-guidance", label: "Model guidance" },
  { id: "subagents-behavior", label: "Behavior" },
  { id: "subagents-custom", label: "Custom agents" },
  { id: "subagents-preview", label: "Preview" },
] as const;

const TOOLS_SECTIONS = [
  { id: "tools-mcp", label: "MCP servers" },
  { id: "tools-language", label: "Language tools" },
  { id: "tools-live", label: "In this thread" },
] as const;

/** An ordinary account read reports Codex's local sign-in, not service health. */
const OPENAI_SIGNED_IN_NOTE = "Connected through the Codex CLI on this device. OpenAI’s service status isn’t checked.";

/** "max" → "Max": plan names arrive as lowercase ids. */
function sentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** One status vocabulary for every account: Connected, Needs sign-in,
 * Not set up, Couldn’t verify, plus the two transient states. */
function accountConnectionLabel(check: string | undefined, connected: boolean, available: boolean): string {
  if (check === "Checking connection…") return "Checking…";
  if (check === "Waiting for sign-in…") return "Signing in…";
  if (check && check !== "Needs sign-in") return "Couldn’t verify";
  return connected ? "Connected" : available ? "Needs sign-in" : "Not set up";
}

export function useDeveloperRuntimeUpdater(
  onClaudeRefresh: (() => Promise<ClaudeRuntimeStatus | null>) | undefined,
  enabled: boolean,
): DeveloperRuntimeUpdater {
  const [status, setStatus] = useState(() => cachedDeveloperRuntimeUpdates());
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<DeveloperRuntimeTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);
  const operationRef = useRef<"check" | "update" | null>(null);

  const checkForUpdates = async () => {
    if (!enabled || !isTauri() || operationRef.current) return;
    operationRef.current = "check";
    const request = ++requestRef.current;
    setChecking(true);
    setError(null);
    setMessage(null);
    try {
      const next = await checkDeveloperRuntimeUpdates();
      if (requestRef.current === request) setStatus(next);
    } catch (reason) {
      if (requestRef.current === request) setError(friendlyError(reason));
    } finally {
      operationRef.current = null;
      if (requestRef.current === request) setChecking(false);
    }
  };

  const updateRuntime = async (target: DeveloperRuntimeTarget) => {
    if (!enabled || !isTauri() || operationRef.current) return;
    operationRef.current = "update";
    const request = ++requestRef.current;
    setUpdating(target);
    setError(null);
    setMessage(null);
    try {
      const result = await updateDeveloperRuntime(target);
      if (requestRef.current !== request) return;
      setStatus(result.status);
      setMessage(result.restartRequired
        ? `${result.message}\n\nRestart Mythra Code when convenient to use the updated Codex CLI.`
        : result.message);
      if (target === "claude" && onClaudeRefresh) {
        try {
          await onClaudeRefresh();
        } catch (reason) {
          if (requestRef.current === request) {
            setMessage(`${result.message}\n\nClaude Code updated, but Mythra Code could not refresh its account and model catalog yet: ${friendlyError(reason)}. Reopen the app or refresh the Claude catalog to try again.`);
          }
        }
      }
    } catch (reason) {
      if (requestRef.current === request) {
        setError(friendlyError(reason));
        setStatus(cachedDeveloperRuntimeUpdates());
      }
    } finally {
      operationRef.current = null;
      setUpdating((current) => current === target ? null : current);
    }
  };

  return { status, checking, updating, error, message, checkForUpdates, updateRuntime };
}

export function SettingsModal({
  open,
  initialSection,
  promptFocusRequest,
  onPromptFocusHandled,
  initialDraft,
  appUpdater,
  developerRuntimeUpdater: injectedDeveloperRuntimeUpdater,
  settings,
  account,
  accountChecks = {},
  onRefreshAccounts,
  runtimeStatus,
  claudeStatus = null,
  openAiLoginStarting = false,
  claudeLoginStarting = false,
  cursorStatus = null,
  cursorLoginStarting = false,
  openRouterReady,
  lmStudioReady = false,
  lmStudioTokenStored = false,
  lmStudioModels = [],
  lmStudioModelsError = "",
  runtimeModels = [],
  openRouterModels = [],
  cursorModels = [],
  claudeModels = [],
  subAgentModelUnavailable,
  modelFavorites = {},
  onToggleModelFavorite,
  onDiscoverOpenRouterModels,
  childAgentReadiness,
  managedSubagentV2LockedReason,
  githubStatus,
  githubBusy = false,
  githubLoginPending = false,
  githubSignInError = "",
  onRefreshUsagePricing,
  onRefreshAvailableModels,
  openRouterPricingError,
  onClose,
  onSave,
  onBeforeSave,
  onThemePreview,
  onEffortSliderPreview,
  onChatFontPreview,
  onUiScalePreview = () => {},
  onSignIn,
  onSignOut = async () => {
    await rpc("account/logout");
  },
  onOpenAiRefresh = async () => {},
  onClaudeSignIn = async () => {},
  onClaudeRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null }),
  onOpenAiBillingChanged = async () => {},
  onClaudeBillingChanged,
  onCursorSignIn = async () => {},
  onCursorRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, email: null, subscriptionType: null, warning: null }),
  onRuntimeRequired,
  onWorkspaceTools,
  onOpenRouterChange,
  onLMStudioRefresh = async () => [],
  onLMStudioTokenChange = () => {},
  onGitHubSignIn,
  onGitHubRefresh,
  onGitHubClone,
  onError,
  profiles,
  globalInstructionFiles = [],
  globalInstructionDiscoveryBusy = false,
  globalInstructionDiscoveryError = "",
  onRefreshGlobalInstructionFiles,
  onGlobalInstructionFileSaved,
  agents,
  actions,
  schedules,
  workflows,
  workflowRuns,
  projects,
  activeProjectId = null,
  skillsFolder,
  skills,
  onAnalyzeSkillDependencies,
  onAnalyzeSkill,
  openSkillRequest,
  onOpenSkillRequestConsumed,
  removedSkills,
  skillsBusy,
  skillsError,
  officialSkillInstallFailure,
  officialSkillInstallingId,
  mcpServers,
  onMcpChanged,
  workspaceToolsAvailable,
  onProfiles,
  onAgents,
  onActions,
  onSchedules,
  onWorkflows,
  onRunWorkflow,
  onStopWorkflow,
  onProjects,
  scheduleRuns = [],
  onOpenRun,
  onChooseSkillsFolder,
  onRefreshSkills,
  onSkillsWatchChange,
  onImportSkills,
  onCreateSkill,
  onInstallOfficialSkill,
  onReadSkill,
  onUpdateSkill,
  onRenameSkill,
  onToggleSkill,
  onRemoveSkill,
  onRestoreSkill,
  onOpenOnboarding,
  onOpenShortcuts,
  projectInstructionsTarget,
  onLearnPastConversations,
  onCancelPreferenceLearning,
  preferenceHistoryProgress,
  onPreferenceLearningChanged,
}: {
  open: boolean;
  initialSection: SettingsSection;
  promptFocusRequest?: { target: "global" | "codex" | "claude"; name: string; nonce: number } | null;
  onPromptFocusHandled?: (nonce: number) => void;
  initialDraft?: OnboardingSettingsDraft;
  appUpdater: AppUpdater;
  developerRuntimeUpdater?: DeveloperRuntimeUpdater;
  settings: AppSettings;
  account: Account | null;
  accountChecks?: Partial<Record<Provider, string>>;
  /** Passive connection check whenever Models & accounts becomes visible. */
  onRefreshAccounts?: () => Promise<void>;
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus?: ClaudeRuntimeStatus | null;
  openAiLoginStarting?: boolean;
  claudeLoginStarting?: boolean;
  cursorStatus?: CursorRuntimeStatus | null;
  cursorLoginStarting?: boolean;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  lmStudioTokenStored?: boolean;
  lmStudioModels?: LMStudioModel[];
  lmStudioModelsError?: string;
  runtimeModels?: RuntimeModel[];
  openRouterModels?: OpenRouterModel[];
  cursorModels?: CursorModel[];
  /** Live Claude Code catalog; empty falls back to the labelled built-ins. */
  claudeModels?: ClaudeModel[];
  /** Live catalog load/failure state for new managed sub-agent defaults. */
  subAgentModelUnavailable?: ChildAgentModelCatalogs["unavailableProviders"];
  /** Starred models, shared with the composer and sub-agent pickers. */
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  /** Resolves an OpenRouter slug typed into the app-native model search. */
  onDiscoverOpenRouterModels?: (query: string) => void;
  /** Which providers a cross-provider child could be started on right now. */
  childAgentReadiness: ChildAgentReadiness;
  /** Live workflow-change lock; a V2 switch waits while it is set. */
  managedSubagentV2LockedReason?: string;
  githubStatus: GitHubAccountStatus | null;
  githubBusy?: boolean;
  githubLoginPending?: boolean;
  githubSignInError?: string;
  onRefreshUsagePricing?: () => Promise<void>;
  onRefreshAvailableModels?: () => Promise<void>;
  openRouterPricingError?: string;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  /** Reject a stale workflow draft before persisting any settings sections. */
  onBeforeSave?: (settings: AppSettings) => boolean;
  onThemePreview: (theme: ThemeName) => void;
  onEffortSliderPreview: (style: EffortSliderStyle) => void;
  onChatFontPreview: (font: ChatFont) => void;
  /** Interface size applies at once, like the other appearance choices. */
  onUiScalePreview?: (scale: number) => void;
  onSignIn: () => Promise<void>;
  /** Signs the ChatGPT account out; defaults to a bare `account/logout`. */
  onSignOut?: () => Promise<void>;
  /** Renews the ChatGPT session, unlike the read made on each page visit. */
  onOpenAiRefresh?: () => Promise<unknown>;
  onClaudeSignIn?: () => Promise<void>;
  onClaudeRefresh?: () => Promise<ClaudeRuntimeStatus | null>;
  /** Codex's sign-in changed between ChatGPT and an OpenAI API key. */
  onOpenAiBillingChanged?: () => Promise<void>;
  /** Claude's billing choice or Anthropic API key changed. */
  onClaudeBillingChanged?: () => Promise<unknown>;
  onCursorSignIn?: () => Promise<void>;
  onCursorRefresh?: () => Promise<CursorRuntimeStatus | null>;
  onRuntimeRequired: () => void;
  onWorkspaceTools: () => void;
  onOpenRouterChange: (ready: boolean) => void;
  onLMStudioRefresh?: (baseUrl: string) => Promise<LMStudioModel[]>;
  onLMStudioTokenChange?: (stored: boolean) => void;
  onGitHubSignIn: () => Promise<void>;
  onGitHubRefresh: () => Promise<void>;
  onGitHubClone: (url: string, parentFolder: string) => Promise<boolean>;
  onError: (error: string | null) => void;
  profiles: PromptProfile[];
  globalInstructionFiles?: InstructionFileDescriptor[];
  globalInstructionDiscoveryBusy?: boolean;
  globalInstructionDiscoveryError?: string;
  onRefreshGlobalInstructionFiles?: () => Promise<void> | void;
  onGlobalInstructionFileSaved?: (file: InstructionFileDescriptor) => void;
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  activeProjectId?: string | null;
  skillsFolder: string;
  skills: LocalSkill[];
  onAnalyzeSkillDependencies?: (message: string, systemPrompt: string) => Promise<SkillDependencyReport>;
  onAnalyzeSkill?: (path: string, content: string) => Promise<SkillDependencyReport>;
  openSkillRequest?: { path: string; nonce: number } | null;
  onOpenSkillRequestConsumed?: (nonce: number) => void;
  removedSkills: LocalSkill[];
  skillsBusy: boolean;
  skillsError: string;
  officialSkillInstallFailure?: import("../lib/skills").OfficialSkillInstallFailure | null;
  officialSkillInstallingId?: string;
  mcpServers?: McpView[];
  onMcpChanged?: () => void;
  workspaceToolsAvailable: boolean;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[] | ((current: ScheduledTask[]) => ScheduledTask[])) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>, projectId?: string) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  onProjects: (value: Project[]) => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
  onChooseSkillsFolder: () => void;
  onRefreshSkills: (silent?: boolean) => Promise<void> | void;
  /** Report relevant surfaces to the app's single skill watcher. */
  onSkillsWatchChange?: (pollMs: number | null) => void;
  onImportSkills: () => void;
  onCreateSkill: (name: string, instructions: string) => Promise<boolean>;
  onInstallOfficialSkill?: (id: string, folder: string) => Promise<string>;
  onReadSkill: (path: string) => Promise<string>;
  onUpdateSkill: (path: string, content: string, original: string) => Promise<void>;
  onRenameSkill: (path: string, name: string) => boolean;
  onToggleSkill: (path: string) => void;
  onRemoveSkill: (path: string, deleteSource: boolean) => Promise<boolean>;
  onRestoreSkill: (path: string) => Promise<boolean>;
  onOpenOnboarding: () => void;
  /** Closes Settings and opens the keyboard shortcuts sheet. */
  onOpenShortcuts?: () => void;
  /** Closes Settings and opens the open project's instructions editor. */
  projectInstructionsTarget?: { name: string; open: () => void };
  onLearnPastConversations?: (scopeKey: string) => Promise<void>;
  onCancelPreferenceLearning?: (scopeKey: string) => void;
  preferenceHistoryProgress?: PreferenceHistoryProgress | null;
  onPreferenceLearningChanged?: (message: string) => void;
}) {
  const remoteMachineActive = useActiveMachine((state) => state.machine !== LOCAL_MACHINE);
  const localMachine = useRemoteDevices((state) => localMachineLabel(state.snapshot));
  const cursorAccountCheck = accountChecks.cursor || (cursorStatus?.loggedIn && cursorStatus.authVerified === false ? "Connection unverified" : "");
  const managedDeveloperRuntimeUpdater = useDeveloperRuntimeUpdater(onClaudeRefresh, !injectedDeveloperRuntimeUpdater);
  const developerRuntimeUpdater = injectedDeveloperRuntimeUpdater ?? managedDeveloperRuntimeUpdater;
  const [local, setLocal] = useState(settings);
  // Browsing credentials is not an edit to the defaults for new threads.
  const [accountProvider, setAccountProvider] = useState<Provider>(settings.provider);
  // Accounts list: one provider row is expanded inline at a time; rows start collapsed.
  const [accountExpanded, setAccountExpanded] = useState(false);
  // Clicking a row animates it open or shut. A search result or the tour's
  // hand-off lands straight on the open panel, so its target is already in
  // place when the pane scrolls to it.
  const [accountMotion, setAccountMotion] = useState(false);
  // Keep visited panels mounted while browsing this pane, so collapsing a row
  // preserves a pasted key and the result of an in-flight account operation.
  const [mountedAccounts, setMountedAccounts] = useState<Provider[]>([]);
  const appCustomFonts = useCustomFonts();
  /** A look carried from the tour, previewed but not saved until applied. */
  const [appearanceOffer, setAppearanceOffer] = useState<OnboardingAppearance | null>(null);
  const [openAiBilling, setOpenAiBilling] = useState<"subscription" | "apiKey" | null>(null);
  const openAiAuthOperation = useProviderAuthOperation();
  const claudeAuthOperation = useProviderAuthOperation();
  const analyzeGlobalPrompt = useCallback((text: string) => onAnalyzeSkillDependencies!("", text), [onAnalyzeSkillDependencies]);
  const analyzeCodexPrompt = useCallback((text: string) => onAnalyzeSkillDependencies!("", resolveProviderSystemPrompt(local.systemPrompt, "openai", text, "")), [local.systemPrompt, onAnalyzeSkillDependencies]);
  const analyzeClaudePrompt = useCallback((text: string) => onAnalyzeSkillDependencies!("", resolveProviderSystemPrompt(local.systemPrompt, "claude", "", text)), [local.systemPrompt, onAnalyzeSkillDependencies]);
  const [localProjects, setLocalProjects] = useState(projects);
  const [localProfiles, setLocalProfiles] = useState(profiles);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [presetDraftName, setPresetDraftName] = useState("");
  const [policyNotice, setPolicyNotice] = useState("");
  // The open model guidance entry, kept here so leaving the Sub-agents pane
  // does not drop it. Only its Save writes `local`.
  const [guidanceDraft, setGuidanceDraft] = useState<SubagentModelGuidanceDraft | null>(null);
  const guidanceAddRef = useRef<(() => void) | null>(null);
  const guidanceDraftChanged = subagentModelGuidanceDraftChanged(guidanceDraft);
  // Minutes as typed. null mirrors the draft setting; while disabled it keeps
  // the last limit so switching back on restores it.
  const [terminalTimeoutText, setTerminalTimeoutText] = useState<string | null>(null);
  // Same convention for the follow-up limit: while Unlimited, keeps the last limit.
  const [followUpLimitText, setFollowUpLimitText] = useState<string | null>(null);
  const followUpLimitId = useId();
  const subagentPanelId = useId();
  const managedSubagentV2Id = useId();
  // Set when the app turned down a V2 switch (a run is still preparing); the
  // switch keeps showing the choice until it can be applied or is undone.
  const [v2Held, setV2Held] = useState(false);
  const managedSubagentV2DraftLocked = (Boolean(managedSubagentV2LockedReason) || v2Held)
    && (local.managedSubagentV2 === true) !== (settings.managedSubagentV2 === true);
  const terminalTimeoutId = useId();
  const escapeStopsRunId = useId();
  const usageTabsId = useId();
  const maxReasoningWarningId = useId();
  const automaticGitInitializationId = useId();
  const [apiKey, setApiKey] = useState("");
  const [lmStudioToken, setLmStudioToken] = useState("");
  const [lmStudioConnectionMessage, setLmStudioConnectionMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsPane>(() => resolveInitialSection(initialSection, initialDraft));
  const [harnessDrafts, setHarnessDrafts] = useState<HarnessDrafts>(EMPTY_HARNESS_DRAFTS);
  const globalPromptRef = useRef<HTMLTextAreaElement>(null);
  const codexPromptRef = useRef<HTMLTextAreaElement>(null);
  const claudePromptRef = useRef<HTMLTextAreaElement>(null);
  const promptRefs = useMemo(() => ({ global: globalPromptRef, codex: codexPromptRef, claude: claudePromptRef }), []);
  const promptAnalyzers = useMemo(() => ({ global: analyzeGlobalPrompt, codex: analyzeCodexPrompt, claude: analyzeClaudePrompt }), [analyzeClaudePrompt, analyzeCodexPrompt, analyzeGlobalPrompt]);
  const [promptLayer, setPromptLayer] = useState<PromptLayer>("global");
  const performanceOverlay = usePerformanceOverlayEnabled();
  const trayStatus = useTrayStatusEnabled();
  const instructionRecording = useTurnContextRecordingEnabled();
  const instructionRecordCount = useTurnContextReceiptCount();
  const [instructionRecordBusy, setInstructionRecordBusy] = useState(false);
  const [instructionRecordError, setInstructionRecordError] = useState("");
  const [instructionRecordStatus, setInstructionRecordStatus] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneParent, setCloneParent] = useState("");
  const githubRefreshRequestedRef = useRef(false);
  const refreshAccountsRef = useRef(onRefreshAccounts);
  refreshAccountsRef.current = onRefreshAccounts;
  const settingsEntryRef = useRef({ open: false, section: resolveInitialSection(initialSection, initialDraft) });
  const updatesRef = useRef({ appUpdater, developerRuntimeUpdater });
  updatesRef.current = { appUpdater, developerRuntimeUpdater };

  const modelCatalogs = useMemo<ModelCatalogs>(() => ({
    runtimeModels,
    claudeModels,
    cursorModels,
    openRouterModels,
    lmStudioModels,
  }), [claudeModels, cursorModels, lmStudioModels, openRouterModels, runtimeModels]);

  // Show the same implicit OpenAI default as a fresh thread without turning
  // a catalog refresh or opening Settings into a saved model selection.
  const displayedDefaultModel = local.provider === "openai" && !local.defaultModelExplicit
    && (!local.model || local.model === DEFAULT_OPENAI_MODEL)
    ? latestSolModel(runtimeModels) : local.model;
  const defaultModelOptions = useMemo<AppSelectOption[]>(
    () => modelOptionsForProvider(local.provider, displayedDefaultModel, modelCatalogs),
    [displayedDefaultModel, local.provider, modelCatalogs],
  );
  const defaultModelSelectedDisplay = savedClaudeModelDisplay(local.provider, displayedDefaultModel, modelCatalogs);

  const subAgentModelCatalogs = useMemo<ChildAgentModelCatalogs>(() => ({
    hiddenClaudeModelIds: claudeModels.filter((entry) => isClaudeDefaultModel(entry.id, entry.displayName)).map((entry) => entry.id),
    unavailableProviders: {
      ...(!runtimeModels.length ? { openai: "Load the OpenAI model catalog before adding an OpenAI sub-agent." } : {}),
      ...(!claudeModels.some((entry) => !entry.disabled && !isClaudeDefaultModel(entry.id, entry.displayName))
        ? { claude: "No available Claude models are listed. Refresh the model catalog before adding a Claude sub-agent." } : {}),
      ...subAgentModelUnavailable,
    },
    openai: runtimeModels.length ? openAiModelOptions(runtimeModels).map((entry) => ({
        id: entry.id,
        label: entry.name,
        detail: entry.tagline,
      })) : [],
    claude: visibleClaudeModels(claudeModels.filter((entry) => !entry.disabled)).map((entry) => ({
        id: entry.id,
        label: entry.displayName,
        detail: entry.description || entry.resolvedModel,
        keywords: entry.resolvedModel,
        resolvedModel: entry.resolvedModel,
      })),
    ...(cursorModels.length ? {
      cursor: cursorModels.map((entry) => ({ id: entry.id, label: entry.name || entry.id, detail: entry.id })),
    } : {}),
    openrouter: openRouterModels.map((entry) => ({
      id: entry.id,
      label: entry.name || entry.id,
      detail: entry.id,
      keywords: entry.description,
    })),
    lmstudio: lmStudioModels.map((entry) => ({
      id: entry.id,
      label: entry.displayName || entry.id,
      detail: `${entry.publisher}${entry.trainedForToolUse ? " · tool use" : ""}`,
    })),
  }), [claudeModels, cursorModels, lmStudioModels, openRouterModels, runtimeModels, subAgentModelUnavailable]);

  // Learning's automatic default must use the live catalog, never the picker fallback.
  const learningModelCatalogs = useMemo(() => ({
    ...subAgentModelCatalogs,
    openai: runtimeModels.map((entry) => ({ id: entry.model || entry.id, label: entry.displayName || entry.model, detail: entry.description || entry.model })),
  }), [runtimeModels, subAgentModelCatalogs]);

  const defaultModelHelp = local.provider === "openrouter"
    ? "Search the live OpenRouter catalog. New threads will start with this model."
    : local.provider === "lmstudio"
      ? "Choose from the models reported by the configured LM Studio server."
      : local.provider === "claude"
        ? "Live catalog from your Claude Code CLI."
        : local.provider === "cursor"
          ? "Choose from the live catalog associated with your Cursor subscription."
          : "Availability follows the selected OpenAI account.";
  const developerUpdateAvailable = Boolean(
    developerRuntimeUpdater.status?.claude.updateAvailable
    || developerRuntimeUpdater.status?.codex.updateAvailable,
  );
  const anyUpdateAvailable = appUpdater.phase === "available" || developerUpdateAvailable;

  // Settings save as you go: each edit is written a moment after it is made
  // (see `commitDrafts`). Only input that cannot be saved yet (a half-typed
  // number, a project override without a model) is held back, shown inline,
  // and asked about on close; nothing is ever dropped silently.
  // Settings saved before the timeout existed read as the five-minute default.
  const terminalTimeoutMinutes = sanitizeTerminalTimeoutMinutes(local.terminalTimeoutMinutes);
  const terminalTimeoutEnabled = terminalTimeoutMinutes > 0;
  const terminalTimeoutTyped = terminalTimeoutEnabled && terminalTimeoutText !== null
    ? parseTerminalTimeoutMinutes(terminalTimeoutText) : terminalTimeoutMinutes;
  // Invalid text never reaches the draft, so it is held back instead of being
  // silently replaced by the previous limit or read as "disabled".
  const terminalTimeoutInvalid = terminalTimeoutTyped === null;
  // Null is Unlimited. Missing or malformed saved values read as the default.
  const followUpLimit = sanitizeParentFollowUpLimit(local.parentFollowUpLimit);
  const followUpLimited = followUpLimit !== null;
  // Like the timeout, an unparsable limit is held back rather than read as Unlimited.
  const followUpLimitInvalid = followUpLimited && followUpLimitText !== null && parseParentFollowUpLimit(followUpLimitText) === null;
  // Keep unrelated drafts out of each keystroke's comparison. In particular,
  // editing a prompt must not serialize every project and profile again.
  const settingsDraftChanged = useMemo(() => open && local !== settings && JSON.stringify(local) !== JSON.stringify(settings), [open, local, settings]);
  const projectsDraftChanged = useMemo(() => open && localProjects !== projects && JSON.stringify(localProjects) !== JSON.stringify(projects), [open, localProjects, projects]);
  const profilesDraftChanged = useMemo(() => open && localProfiles !== profiles && JSON.stringify(localProfiles) !== JSON.stringify(profiles), [open, localProfiles, profiles]);
  const pendingChanges = open && (settingsDraftChanged || projectsDraftChanged || profilesDraftChanged || terminalTimeoutInvalid || followUpLimitInvalid);
  const activeProjectAppearance = localProjects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
  const activeProjectHasAppearanceOverride = Boolean(activeProjectAppearance?.theme || activeProjectAppearance?.chatFont || activeProjectAppearance?.effortSlider);
  const projectDefaultsComplete = localProjects.every((project) => !project.overrides?.defaults || Boolean(project.overrides.defaults.model.trim()));
  /** Where the first edit that can't be saved yet lives, with why. */
  const heldBack: { pane: SettingsPane; reason: string } | null = terminalTimeoutInvalid
    ? { pane: "system", reason: "The command time limit in Advanced isn’t a valid number of minutes." }
    : followUpLimitInvalid
      ? { pane: "agents", reason: "The automatic follow-up limit in Sub-agents isn’t a valid number." }
      : !projectDefaultsComplete
        ? { pane: "projects", reason: "A project override in Projects has no model selected." }
        : null;
  /** Saves what can be saved, then asks before anything is left behind.
   * Resolves false when the person chose to keep editing. */
  const settleBeforeLeaving = async (): Promise<boolean> => {
    if (guidanceDraftChanged) {
      if (!await confirmDialog("Discard your model guidance note?\n\nYou started a note in Sub-agents but haven’t added it.", { confirmLabel: "Discard note", cancelLabel: "Keep editing" })) {
        const guidanceRow = SETTINGS_ROWS.find((row) => row.id === "agents.when-to-use-each-model");
        if (guidanceRow) goToRow(guidanceRow);
        else setSettingsSection("agents");
        return false;
      }
    }
    if (pendingChanges) {
      const { heldV2 } = commitDrafts();
      if (heldV2 && !await confirmDialog(`Close without switching Sub-agents V2 ${local.managedSubagentV2 === true ? "on" : "off"}?\n\nIt can’t change right now${managedSubagentV2LockedReason ? `: ${managedSubagentV2LockedReason}` : "."} Everything else is saved.`, { confirmLabel: "Close without switching", cancelLabel: "Keep editing" })) {
        setSettingsSection("agents");
        return false;
      }
    }
    if (pendingChanges && heldBack) {
      if (!await confirmDialog(`Close without this change?\n\n${heldBack.reason} Everything else is saved.`, { confirmLabel: "Discard change", cancelLabel: "Keep editing" })) {
        setSettingsSection(heldBack.pane);
        return false;
      }
    }
    return true;
  };
  const requestClose = async () => {
    if (!await settleBeforeLeaving()) return;
    onClose();
  };
  const requestOnboarding = async () => {
    if (!await settleBeforeLeaving()) return;
    onOpenOnboarding();
  };
  const requestShortcuts = async () => {
    if (!onOpenShortcuts || !await settleBeforeLeaving()) return;
    onOpenShortcuts();
  };

  // Snapshot of the props the current drafts were seeded from, so external
  // updates while the modal is open can tell "user edited this" apart from
  // "still the value we started with".
  const draftBaselineRef = useRef({ settings, projects, profiles });
  const wasOpenRef = useRef(false);
  /** The drafts as last written, so the echo of our own save is adopted. */
  const committedRef = useRef<{ local: string; projects: string; profiles: string } | null>(null);
  /** Fingerprint of the last write; an identical payload is never resent. */
  const lastWrittenRef = useRef("");
  const flushOnCloseRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!open) {
      // Closed from outside Settings (a workflow run, Tools, onboarding):
      // write what was still waiting for its autosave.
      if (wasOpenRef.current) flushOnCloseRef.current?.();
      flushOnCloseRef.current = null;
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      committedRef.current = null;
      lastWrittenRef.current = "";
      setV2Held(false);
      // Seed drafts only on the closed→open transition — reseeding on every
      // prop change wiped in-progress edits (e.g. cloning a repo from the
      // GitHub pane updates `projects` and used to discard a drafted prompt).
      wasOpenRef.current = true;
      draftBaselineRef.current = { settings, projects, profiles };
      // The tour only opens things: the saved settings stay the draft, so
      // entering and leaving without an explicit action writes nothing.
      const handoff = onboardingHandoff(settings, initialDraft);
      const seeded = handoff.local;
      setLocal(seeded);
      setAccountProvider(handoff.accountProvider);
      setAccountExpanded(handoff.accountExpanded);
      setAccountMotion(false);
      setMountedAccounts(handoff.accountExpanded ? [handoff.accountProvider] : []);
      setAppearanceOffer(handoff.appearancePreview);
      setOpenAiBilling(null);
      setLocalProjects(projects);
      setLocalProfiles(profiles);
      setExpandedPresetId(null);
      setRenamingPresetId(null);
      setCreatingPreset(false);
      setPresetDraftName("");
      setPolicyNotice("");
      setGuidanceDraft(null);
      setTerminalTimeoutText(null);
      setFollowUpLimitText(null);
      const activeDefaults = projects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
      const shown = handoff.appearancePreview;
      onThemePreview(shown ? shown.theme : activeDefaults?.theme ?? seeded.theme);
      onEffortSliderPreview(shown ? shown.effortSlider : activeDefaults?.effortSlider ?? seeded.effortSlider);
      onChatFontPreview(shown ? shown.chatFont : activeDefaults?.chatFont ?? seeded.chatFont);
      onUiScalePreview(settings.uiScale ?? 100);
      setSettingsSection(resolveInitialSection(initialSection, initialDraft));
      return;
    }
    const baseline = draftBaselineRef.current;
    if (settings !== baseline.settings) {
      // Adopt external settings changes only when the draft is untouched, so
      // the dirty check keeps meaning "you have unsaved edits". Invalid number
      // input is still an edit even though it does not reach the draft.
      // A write of our own comes back here too: adopt it when nothing was
      // edited since, keeping a Sub-agents V2 change that is still waiting.
      const localJson = JSON.stringify(local);
      if (committedRef.current && localJson === committedRef.current.local) {
        setLocal((local.managedSubagentV2 === true) !== (settings.managedSubagentV2 === true) ? { ...settings, managedSubagentV2: local.managedSubagentV2 } : settings);
      } else if (terminalTimeoutTyped === terminalTimeoutMinutes && !followUpLimitInvalid && localJson === JSON.stringify(baseline.settings)) {
        setLocal(settings);
        setTerminalTimeoutText(null);
        setFollowUpLimitText(null);
      }
    }
    if (projects !== baseline.projects) {
      // Merge external project changes: new projects appear, removed ones
      // disappear, and per-project drafts survive only where the user
      // actually diverged from the snapshot they started editing.
      const baselineById = new Map(baseline.projects.map((project) => [project.id, project]));
      if (committedRef.current && JSON.stringify(localProjects) === committedRef.current.projects) setLocalProjects(projects);
      else setLocalProjects((current) => {
        const draftsById = new Map(current.map((project) => [project.id, project]));
        return projects.map((incoming) => {
          const draft = draftsById.get(incoming.id);
          const base = baselineById.get(incoming.id);
          return draft && base && JSON.stringify(draft) !== JSON.stringify(base) ? draft : incoming;
        });
      });
    }
    if (profiles !== baseline.profiles) {
      if (committedRef.current && JSON.stringify(localProfiles) === committedRef.current.profiles) setLocalProfiles(profiles);
      else setLocalProfiles((current) => mergePromptProfileDrafts(baseline.profiles, current, profiles));
    }
    draftBaselineRef.current = { settings, projects, profiles };
  }, [activeProjectId, followUpLimitInvalid, initialDraft, initialSection, lmStudioModels, onChatFontPreview, onEffortSliderPreview, onThemePreview, onUiScalePreview, local, localProfiles, localProjects, open, projects, profiles, settings, terminalTimeoutMinutes, terminalTimeoutTyped]);

  useEffect(() => {
    const previous = settingsEntryRef.current;
    // On reopening, the old pane is retained until the draft-seeding effect
    // updates it. Use the requested pane to avoid a spurious or double check.
    let section = open && !previous.open ? resolveInitialSection(initialSection, initialDraft) : settingsSection;
    if (open && !previous.open && section === "general" && !initialDraft?.appearance
      && updatesRef.current.appUpdater.phase === "available") {
      section = "updates";
      setSettingsSection(section);
    }
    settingsEntryRef.current = { open, section };
    if (open && section === "models" && (!previous.open || previous.section !== "models")) {
      const refresh = refreshAccountsRef.current;
      // Refresh failures are represented by the provider's connection state.
      void Promise.resolve().then(() => refresh?.()).catch(() => undefined);
    }
    if (open && section === "updates" && (!previous.open || previous.section !== "updates")) {
      const { appUpdater: app, developerRuntimeUpdater: runtimes } = updatesRef.current;
      // Independent checks start together. Never disturb an installation or
      // replace its updater handle just because the user revisits this pane.
      if (!["downloading", "installing", "restarting"].includes(app.phase)) {
        void Promise.resolve().then(() => app.checkForUpdates()).catch(() => undefined);
      }
      if (!runtimes.updating) {
        void Promise.resolve().then(() => runtimes.checkForUpdates()).catch(() => undefined);
      }
    }
  }, [initialDraft, initialSection, open, settingsSection]);

  useEffect(() => {
    if (!open) {
      githubRefreshRequestedRef.current = false;
      return;
    }
    if (settingsSection === "github" && !githubRefreshRequestedRef.current) {
      githubRefreshRequestedRef.current = true;
      void onGitHubRefresh();
    }
  }, [onGitHubRefresh, open, settingsSection]);

  useEffect(() => {
    const pollMs = !open || !skillsFolder ? null
      : settingsSection === "skills" ? 2_000
        : settingsSection === "prompts" || settingsSection === "tools" ? 5_000 : null;
    onSkillsWatchChange?.(pollMs);
    return () => onSkillsWatchChange?.(null);
  }, [open, settingsSection, skillsFolder, onSkillsWatchChange]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);

  // Reserve the pane's destination width before a section switch paints.
  // The sheet still resizes, but charts and wrapped text no longer reflow at
  // every intermediate animation frame. Measuring the backdrop's content box
  // keeps the destination inside the window at every UI scale.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    if (!dialog || !backdrop || !open) return;
    const reserveWidth = (width: number) => {
      if (width <= 0) return;
      const frameStyle = getComputedStyle(dialog);
      // Zoom can snap a 1px border to a fractional CSS pixel.
      const borderWidth = parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.borderRightWidth);
      dialog.style.setProperty("--settings-frame-border", `${borderWidth}px`);
      dialog.style.setProperty("--settings-available-width", `${width}px`);
    };
    const style = getComputedStyle(backdrop);
    reserveWidth(backdrop.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) reserveWidth(entry.contentRect.width);
    });
    observer?.observe(backdrop);
    return () => observer?.disconnect();
  }, [open, local.uiScale]);

  // The modal's generic initial focus runs first; a repair link then brings
  // the exact authored prompt into view and selects the failed @reference.
  useEffect(() => {
    if (!open || settingsSection !== "prompts" || !promptFocusRequest) return;
    // Show the layer's tab first; this runs again once it is visible.
    if (promptLayer !== promptFocusRequest.target) {
      setPromptLayer(promptFocusRequest.target);
      return;
    }
    const field = { global: globalPromptRef, codex: codexPromptRef, claude: claudePromptRef }[promptFocusRequest.target].current;
    if (!field) return;
    field.focus();
    field.scrollIntoView?.({ block: "center" });
    const mention = skillMentionRanges(field.value, [{ name: promptFocusRequest.name }])[0];
    if (mention) field.setSelectionRange(mention.start, mention.end);
    onPromptFocusHandled?.(promptFocusRequest.nonce);
  }, [onPromptFocusHandled, open, promptFocusRequest, promptLayer, settingsSection]);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An approval modal stacked above Settings owns Escape while present.
      if (document.querySelector("[data-approval-modal], [data-skill-remove-modal]")) return;
      requestCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const signIn = async () => {
    if (!runtimeStatus?.available) {
      onRuntimeRequired();
      return;
    }
    if (openAiLoginStarting) return;
    const finish = openAiAuthOperation.begin("signingIn");
    if (!finish) return;
    setBusy(true);
    onError(null);
    try {
      await onSignIn();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
      finish();
    }
  };

  const signOut = async () => {
    if (openAiLoginStarting) return;
    const finish = openAiAuthOperation.begin("signingOut");
    if (!finish) return;
    setBusy(true);
    try {
      await onSignOut();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
      finish();
    }
  };

  const signInClaude = async () => {
    if (claudeLoginStarting) return;
    const finish = claudeAuthOperation.begin("signingIn");
    if (!finish) return;
    try {
      await (claudeStatus?.available ? onClaudeSignIn() : openUrl("https://docs.anthropic.com/en/docs/claude-code/setup"));
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      // Sign-in resolves once the browser flow finishes, is cancelled or
      // times out; the card offers Cancel while it waits.
      finish();
    }
  };

  // Manual account reads share the provider's operation lock with mutations.
  // Routine background checks remain managed by the account refresh owner.
  const [openAiRefreshing, setOpenAiRefreshing] = useState(0);
  const refreshOpenAi = () => {
    if (openAiLoginStarting || openAiAuthOperation.busy) return;
    const finish = openAiAuthOperation.begin("refreshing");
    if (!finish) return;
    setOpenAiRefreshing((count) => count + 1);
    void onOpenAiRefresh().catch(() => undefined).finally(() => {
      setOpenAiRefreshing((count) => count - 1);
      finish();
    });
  };

  const refreshClaude = async () => {
    if (claudeLoginStarting) return;
    const finish = claudeAuthOperation.begin("refreshing");
    if (!finish) return;
    try {
      await onClaudeRefresh();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      finish();
    }
  };

  const storeKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await saveOpenRouterKey(apiKey);
      setApiKey("");
      onOpenRouterChange(true);
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const storeLmStudioToken = async (remove = false) => {
    if (!remove && !lmStudioToken.trim()) return;
    setBusy(true);
    setLmStudioConnectionMessage("");
    try {
      await saveLmStudioKey(remove ? "" : lmStudioToken);
      setLmStudioToken("");
      onLMStudioTokenChange(!remove);
      setLmStudioConnectionMessage(remove ? "API token removed." : "API token stored securely.");
      await onLMStudioRefresh(local.lmStudioBaseUrl);
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const testLmStudioConnection = async () => {
    setBusy(true);
    setLmStudioConnectionMessage("");
    try {
      const models = await onLMStudioRefresh(local.lmStudioBaseUrl);
      setLmStudioConnectionMessage(models.length
        ? `Connected · ${models.length} model${models.length === 1 ? "" : "s"} available.`
        : "No models were returned. Load a model or enable Just-in-Time loading in LM Studio.");
    } catch (reason) {
      setLmStudioConnectionMessage(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  /** Applying or dismissing the tour's look puts every preview back on the draft. */
  const endAppearanceOffer = (next: AppSettings) => {
    setAppearanceOffer(null);
    const defaults = localProjects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
    onThemePreview(defaults?.theme ?? next.theme);
    onEffortSliderPreview(defaults?.effortSlider ?? next.effortSlider);
    onChatFontPreview(defaults?.chatFont ?? next.chatFont);
  };
  const applyAppearanceOffer = () => {
    if (!appearanceOffer) return;
    const next = settingsWithAppearance(local, appearanceOffer);
    setLocal(next);
    endAppearanceOffer(next);
  };
  // Choosing a look by hand replaces the tour preview: keep showing the parts
  // not chosen here as they are saved, not as the tour left them.
  const dropOfferFor = (kind: "theme" | "effortSlider" | "chatFont") => {
    if (!appearanceOffer) return;
    setAppearanceOffer(null);
    if (kind !== "theme") onThemePreview(local.theme);
    if (kind !== "effortSlider") onEffortSliderPreview(local.effortSlider);
    if (kind !== "chatFont") onChatFontPreview(local.chatFont);
  };

  const previewTheme = (theme: ThemeName) => {
    dropOfferFor("theme");
    setLocal((current) => ({ ...current, theme }));
    onThemePreview(theme);
  };

  const previewEffortSlider = (style: EffortSliderStyle) => {
    dropOfferFor("effortSlider");
    setLocal((current) => ({ ...current, effortSlider: style }));
    onEffortSliderPreview(style);
  };

  const previewChatFont = (chatFont: ChatFont) => {
    dropOfferFor("chatFont");
    setLocal((current) => ({ ...current, chatFont }));
    onChatFontPreview(chatFont);
  };

  const previewUiScale = (uiScale: number) => {
    setLocal((current) => ({ ...current, uiScale }));
    onUiScalePreview(uiScale);
  };

  const exportDiagnosticBundle = async () => {
    try {
      const path = await save({ title: "Export Mythra Code diagnostics", defaultPath: `mythra-code-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) await exportDiagnostics(path);
    } catch (reason) { onError(friendlyError(reason)); }
  };

  const [agentDefaultsOpen, setAgentDefaultsOpen] = useState(false);
  // M08 (round 6): optional logo presets sit behind one row so they don't
  // compete with theme, scale and font; every choice is still one click away.
  const [providerLogosOpen, setProviderLogosOpen] = useState(false);
  const providerLogosId = useId();
  const [agentEditScope, setAgentEditScope] = useState("global");
  const editedAgentProject = localProjects.find((project) => project.id === agentEditScope);
  const editedAgentPolicy = editedAgentProject?.overrides?.subagents ?? projectSubagentSettingsFromApp(local);
  const activeAgentProject = activeProjectId
    ? localProjects.find((project) => project.id === activeProjectId) ?? null
    : null;
  const agentPolicy = activeAgentProject?.overrides?.subagents ?? projectSubagentSettingsFromApp(local);
  const presetSourceName = activeAgentProject?.name ?? "Chats & project defaults";
  const presetDestinationOptions = useMemo<AppSelectOption[]>(() => [
    {
      value: "apply:global",
      label: "Chats & project defaults",
      detail: "Use this preset for chats and projects without their own setup",
      icon: <UsersRound size={13} aria-hidden="true" />,
    },
    ...localProjects.map((project) => ({
      value: `apply:${project.id}`,
      label: project.name,
      detail: project.overrides?.subagents
        ? "Replace this project's custom sub-agent setup"
        : "Give this project its own sub-agent setup",
      icon: <FolderCog size={13} aria-hidden="true" />,
    })),
    ...localProjects
      .filter((project) => project.overrides?.subagents)
      .map((project) => ({
        value: `reset:${project.id}`,
        label: `Reset ${project.name} to chat defaults`,
        detail: "Remove its custom sub-agent setup",
        icon: <RotateCcw size={13} aria-hidden="true" />,
      })),
  ], [localProjects]);
  const updateAgentPolicy = (next: ReturnType<typeof projectSubagentSettingsFromApp>, scopeId: string) => {
    if (scopeId === "global") {
      setLocal((current) => ({ ...current, subagentsEnabled: next.enabled, subagentMax: next.maxConcurrent, childAgents: next.childAgents }));
      return;
    }
    setLocalProjects((current) => current.map((project) => project.id === scopeId
      ? { ...project, overrides: { ...(project.overrides ?? {}), subagents: next } }
      : project));
  };
  const clearProjectAgentPolicy = (projectId: string) => {
    const projectName = localProjects.find((project) => project.id === projectId)?.name;
    if (!projectName) return;
    setLocalProjects((current) => current.map((project) => {
      if (project.id !== projectId || !project.overrides?.subagents) return project;
      const overrides = { ...(project.overrides ?? {}) };
      delete overrides.subagents;
      return { ...project, overrides: Object.keys(overrides).length ? overrides : undefined };
    }));
    setCreatingPreset(false);
    setPolicyNotice(`${projectName} now uses Chats & project defaults.`);
  };
  const presetsFull = local.childAgentPresets.length >= MAX_CHILD_AGENT_PRESETS;
  const updatePreset = (presetId: string, patch: Partial<ChildAgentPreset>) => {
    setLocal((current) => ({
      ...current,
      childAgentPresets: current.childAgentPresets.map((preset) => preset.id === presetId ? { ...preset, ...patch } : preset),
    }));
  };
  const createPreset = () => {
    const name = presetDraftName.trim();
    if (presetsFull || !name) return;
    const id = uniqueChildAgentPresetId(name, local.childAgentPresets);
    const policy = sanitizeChildAgentPresetPolicy(agentPolicy);
    if (!policy) return;
    setLocal((current) => ({
      ...current,
      childAgentPresets: [...current.childAgentPresets, { id, name, policy }],
    }));
    setExpandedPresetId(id);
    setCreatingPreset(false);
    setPresetDraftName("");
    setPolicyNotice("");
  };
  const removePreset = (presetId: string) => {
    setLocal((current) => ({ ...current, childAgentPresets: current.childAgentPresets.filter((preset) => preset.id !== presetId) }));
    setExpandedPresetId((current) => current === presetId ? null : current);
    setRenamingPresetId((current) => current === presetId ? null : current);
  };
  const applyPresetToScope = (preset: ChildAgentPreset, scopeId: string) => {
    const next = sanitizeChildAgentPresetPolicy(preset.policy);
    if (!next) return;
    const scopeName = scopeId === "global"
      ? "Chats & project defaults"
      : localProjects.find((project) => project.id === scopeId)?.name;
    if (!scopeName) return;
    updateAgentPolicy(next, scopeId);
    setCreatingPreset(false);
    setPolicyNotice(`${preset.name.trim() || "Preset"} is now the sub-agent setup for ${scopeName}.`);
  };
  const runPresetDestinationAction = (preset: ChildAgentPreset, action: string) => {
    if (action.startsWith("reset:")) {
      clearProjectAgentPolicy(action.slice("reset:".length));
      return;
    }
    if (action.startsWith("apply:")) applyPresetToScope(preset, action.slice("apply:".length));
  };
  // Seventeen panes is more than anyone scans reliably, so the sidebar can be
  // searched. Filtering only hides nav rows: the pane in front of you is never
  // swapped out mid-edit just because you started typing.
  const [navQuery, setNavQuery] = useState("");
  const navGroups = useMemo(() => SETTINGS_NAV
    .map((section) => ({ ...section, items: section.items.filter((item) => (navQuery.trim() || !item.parent) && settingsNavMatches(item, navQuery)) }))
    .filter((section) => section.items.length > 0), [navQuery]);
  const navMatches = useMemo(() => navGroups.flatMap((section) => section.items), [navGroups]);
  // Individual settings, so "scrollback" lands on the row, not just Advanced.
  const rowMatches = useMemo(() => navQuery.trim()
    ? SETTINGS_ROWS.filter((row) => settingsNavMatches({ label: row.label, detail: SETTINGS_PANES.get(row.pane)?.label ?? "", keywords: row.keywords ?? "" }, navQuery)).slice(0, 8)
    : [], [navQuery]);
  // M10: while searching, panes and individual settings share one explicit
  // order: a setting whose own name answers the query comes before the pane
  // that merely contains it, and ↑/↓/Enter follow exactly this order.
  const orderedResults = useMemo(() => navQuery.trim()
    ? orderSettingsResults(navMatches, rowMatches.map((row) => ({ ...row, paneLabel: SETTINGS_PANES.get(row.pane)?.label ?? "" })), searchWords(navQuery))
    : [], [navMatches, navQuery, rowMatches]);
  const [rowFocus, setRowFocus] = useState<(SettingsRow & { nonce: number }) | null>(null);
  /** Spoken once a search result lands on its setting. */
  const [searchArrival, setSearchArrival] = useState("");
  const searchResultCount = orderedResults.length;
  useEffect(() => { setSearchArrival(""); }, [navQuery]);
  const goToRow = (row: SettingsRow) => {
    // Reveal the account panel without editing the default provider/model.
    if (row.accountProvider) {
      setAccountMotion(false);
      setAccountProvider(row.accountProvider);
      setAccountExpanded(true);
      const provider = row.accountProvider;
      setMountedAccounts((current) => current.includes(provider) ? current : [...current, provider]);
    }
    setSettingsSection(row.pane);
    setRowFocus((current) => ({ ...row, nonce: (current?.nonce ?? 0) + 1 }));
  };
  // A link from elsewhere in the app (e.g. Tools → Actions) can name a
  // row to land on when Settings opens; it uses the same arrival as search.
  const initialRow = initialDraft?.row;
  useEffect(() => {
    if (!open || !initialRow) return;
    const row = SETTINGS_ROWS.find((entry) => entry.id === initialRow);
    if (row) goToRow(row);
    // goToRow only sets state; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialRow]);
  // A search result names a row; once its pane renders, bring that row into
  // view and mark it briefly. Lazy panes can take a few frames to mount.
  useEffect(() => {
    if (!open || !rowFocus || settingsSection !== rowFocus.pane) return;
    let frame = 0;
    let attempts = 0;
    let marked: HTMLElement | null = null;
    let timer: number | undefined;
    const find = () => {
      const content = contentRef.current;
      const label = rowFocus.label.toLowerCase();
      // Stable ids first (`data-settings-row`), then the visible title.
      const byId = content?.querySelector<HTMLElement>(`[data-settings-row="${rowFocus.target ?? rowFocus.id}"]`);
      const match = byId ?? (rowFocus.target ? null : content && [...content.querySelectorAll<HTMLElement>("h4, .set-row strong, summary")]
        .find((element) => element.textContent?.trim().toLowerCase() === label));
      if (!match) {
        if (++attempts < 30) frame = requestAnimationFrame(find);
        return;
      }
      marked = byId ? match : match.closest<HTMLElement>(".set-row, .set-group") ?? match;
      marked.scrollIntoView?.({ block: "center" });
      marked.classList.add("settings-row-highlight");
      // Arrive on the setting itself (its first control), not just near it,
      // and say where focus went. The search keeps its text for going back.
      const control = marked.querySelector<HTMLElement>("input:not([type='hidden']):not(:disabled), textarea:not(:disabled), button:not(:disabled), [role='switch'], [tabindex='0']");
      if (control) control.focus({ preventScroll: true });
      else {
        if (!marked.hasAttribute("tabindex")) marked.tabIndex = -1;
        marked.focus({ preventScroll: true });
      }
      setSearchArrival(`${rowFocus.label}, in ${SETTINGS_PANES.get(rowFocus.pane)?.label ?? "Settings"}`);
      timer = window.setTimeout(() => marked?.classList.remove("settings-row-highlight"), 1_600);
    };
    frame = requestAnimationFrame(find);
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
      marked?.classList.remove("settings-row-highlight");
    };
  }, [open, rowFocus, settingsSection]);


  // A soft fade at the bottom of the pane says "there is more" without
  // adding chrome; it disappears once the pane is scrolled to its end.
  const contentRef = useRef<HTMLDivElement>(null);
  // One sheet size for every pane: wide tables scroll inside the content
  // column, so moving between panes never makes the window jump.
  const usageTabs = settingsSection === "usage" || settingsSection === "pricing";
  useSettingsSheetResize(dialogRef, contentRef, "sheet", open);
  const scrollableNumberInputRef = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      const pane = input.closest<HTMLElement>(".settings-content");
      if (!pane || input.ownerDocument.activeElement !== input || event.ctrlKey) return;
      // Chromium steps a focused number input on wheel. Keep the edit and
      // keyboard focus intact, and scroll its pane as an ordinary wheel would.
      event.preventDefault();
      const lineHeight = Number.parseFloat(getComputedStyle(pane).lineHeight) || 16;
      const xScale = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? pane.clientWidth : 1;
      const yScale = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? pane.clientHeight : 1;
      pane.scrollBy({ left: event.deltaX * xScale, top: event.deltaY * yScale, behavior: "instant" });
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => input.removeEventListener("wheel", onWheel);
  }, []);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const node = contentRef.current;
    if (!node || !open) return;
    const update = () => setMoreBelow(node.scrollHeight - node.scrollTop - node.clientHeight > 8);
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [open, settingsSection]);

  // Pane actions live with the section they act on, never beside Close.
  const updatesChecking = appUpdater.phase === "checking" || developerRuntimeUpdater.checking;
  const updatesBusy = ["checking", "downloading", "installing", "restarting"].includes(appUpdater.phase) || developerRuntimeUpdater.checking || developerRuntimeUpdater.updating !== null;
  const checkAllUpdates = <button type="button" className="secondary-button" disabled={updatesBusy} onClick={() => void Promise.all([appUpdater.checkForUpdates(), developerRuntimeUpdater.checkForUpdates()])}>{updatesChecking ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Check for updates</button>;

  // ---- Saving: everything a person edits is written a moment later ----
  const [savedFlash, setSavedFlash] = useState(0);
  /** Writes every draft that differs from what is stored. A Sub-agents V2
   * switch the app can't apply yet is held back (and reported) while the
   * rest is saved. Never sends the same payload twice. */
  const commitDrafts = (): { heldV2: boolean } => {
    // Half-typed numbers never reach the draft, so the settings draft always
    // holds the last valid values. Only project overrides without a model
    // are held back, and only they wait.
    const v2Changed = (local.managedSubagentV2 === true) !== (settings.managedSubagentV2 === true);
    const normalizedSubagents = projectSubagentSettingsFromApp(local);
    let next: AppSettings = {
      ...local,
      childAgents: normalizedSubagents.childAgents,
      childAgentPresets: sanitizeChildAgentPresets(local.childAgentPresets),
      subagentModelGuidance: sanitizeSubagentModelGuidance(local.subagentModelGuidance),
      subagentMax: normalizedSubagents.maxConcurrent,
      terminalTimeoutMinutes,
      parentFollowUpLimit: followUpLimit,
    };
    let heldV2 = false;
    if (v2Changed && (managedSubagentV2LockedReason || v2Held || onBeforeSave?.(next) === false)) {
      heldV2 = true;
      next = { ...next, managedSubagentV2: settings.managedSubagentV2 };
    }
    if (heldV2 !== v2Held) setV2Held(heldV2);
    const nextProjects = projectDefaultsComplete ? sanitizeProjectDefaultOverrides(sanitizeProjectSubagentOverrides(localProjects)) : projects;
    const nextProfiles = mergePromptProfileDrafts(draftBaselineRef.current.profiles, localProfiles, profiles);
    const settingsJson = JSON.stringify(next);
    const projectsJson = JSON.stringify(nextProjects);
    const profilesJson = JSON.stringify(nextProfiles);
    const fingerprint = `${settingsJson}\u0000${projectsJson}\u0000${profilesJson}`;
    // Held-back projects aren't "committed", so a later external change can't
    // be mistaken for the echo of our own write and replace them.
    committedRef.current = { local: JSON.stringify(local), projects: projectDefaultsComplete ? JSON.stringify(localProjects) : "", profiles: JSON.stringify(localProfiles) };
    if (fingerprint === lastWrittenRef.current) return { heldV2 };
    lastWrittenRef.current = fingerprint;
    let wrote = false;
    if (projectsJson !== JSON.stringify(projects)) { onProjects(nextProjects); wrote = true; }
    if (profilesJson !== JSON.stringify(profiles)) { onProfiles(nextProfiles); wrote = true; }
    if (settingsJson !== JSON.stringify(settings)) { onSave(next); wrote = true; }
    if (wrote) setSavedFlash(Date.now());
    return { heldV2 };
  };
  const commitDraftsRef = useRef(commitDrafts);
  commitDraftsRef.current = commitDrafts;
  if (open) flushOnCloseRef.current = pendingChanges ? () => commitDraftsRef.current() : null;
  // Toggles and choices settle almost at once; typing waits for a pause.
  useEffect(() => {
    if (!open || !pendingChanges) return;
    const timer = window.setTimeout(() => commitDraftsRef.current(), 450);
    return () => window.clearTimeout(timer);
  }, [open, pendingChanges, local, localProjects, localProfiles, managedSubagentV2LockedReason]);
  // A lifted lock lets a waiting V2 switch be tried again.
  useEffect(() => { if (!managedSubagentV2LockedReason) setV2Held(false); }, [managedSubagentV2LockedReason]);
  useEffect(() => {
    if (!savedFlash) return;
    const timer = window.setTimeout(() => setSavedFlash(0), 1_800);
    return () => window.clearTimeout(timer);
  }, [savedFlash]);
  const setFollowUpLimitUnlimited = (unlimited: boolean) => {
    if (unlimited && followUpLimited) {
      // Keep the last valid count in case Limited is selected again.
      setLocal((current) => ({ ...current, parentFollowUpLimit: null }));
      setFollowUpLimitText(String(followUpLimit));
    } else if (!unlimited && !followUpLimited) {
      const restored = followUpLimitText === null ? null : parseParentFollowUpLimit(followUpLimitText);
      setLocal((current) => ({ ...current, parentFollowUpLimit: restored ?? DEFAULT_PARENT_FOLLOW_UP_LIMIT }));
      setFollowUpLimitText(null);
    }
  };
  const editFollowUpLimit = (text: string) => {
    setFollowUpLimitText(text);
    const limit = parseParentFollowUpLimit(text);
    if (limit !== null && limit !== followUpLimit) setLocal((current) => ({ ...current, parentFollowUpLimit: limit }));
  };
  const setTerminalTimeoutEnabled = (enabled: boolean) => {
    if (enabled) {
      const restored = terminalTimeoutText === null ? null : parseTerminalTimeoutMinutes(terminalTimeoutText);
      setLocal({ ...local, terminalTimeoutMinutes: restored ?? DEFAULT_TERMINAL_TIMEOUT_MINUTES });
      setTerminalTimeoutText(null);
    } else {
      // Remember the last valid limit, not half-typed text.
      setLocal({ ...local, terminalTimeoutMinutes: 0 });
      setTerminalTimeoutText(String(terminalTimeoutMinutes));
    }
  };
  const editTerminalTimeout = (text: string) => {
    setTerminalTimeoutText(text);
    const minutes = parseTerminalTimeoutMinutes(text);
    if (minutes !== null) setLocal({ ...local, terminalTimeoutMinutes: minutes });
  };

  // ---- Accounts: a compact list; sign-in lives on each row ----
  const toggleAccount = (provider: Provider) => {
    setAccountMotion(true);
    setMountedAccounts((current) => current.includes(provider) ? current : [...current, provider]);
    if (provider === accountProvider) setAccountExpanded((current) => !current);
    else { setAccountProvider(provider); setAccountExpanded(true); }
  };
  const expandAccount = (provider: Provider) => {
    setAccountMotion(true);
    setMountedAccounts((current) => current.includes(provider) ? current : [...current, provider]);
    setAccountProvider(provider);
    setAccountExpanded(true);
    // Quick actions disappear when their row opens; retain keyboard focus
    // inside Settings at the row that revealed the account controls.
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>(`#account-toggle-${provider}`)?.focus());
  };
  const openAiConnected = codexAccountReady(account);
  // The server answered but has nothing loaded: connected, just empty.
  const lmStudioNoModels = !lmStudioReady && /did not report any models/i.test(lmStudioModelsError);
  const cursorConnected = Boolean(cursorStatus?.loggedIn) && cursorStatus?.authVerified !== false;
  const accountRows: Array<{ id: Provider; name: string; detail: string; logo: ReactNode; status: ReactNode; action: ReactNode }> = [
    {
      id: "openai",
      name: "OpenAI",
      detail: account?.type === "chatgpt" && account.email ? account.email : account?.type === "apiKey" ? "API key" : "ChatGPT plan or API key",
      logo: <span className="provider-logo openai">{local.openAiLogo === "codex" ? <CodexLogo size={18} /> : <OpenAILogo size={17} />}</span>,
      status: <span className={`provider-status ${openAiConnected && !accountChecks.openai ? "on" : ""}`} title={accountChecks.openai || (openAiConnected ? OPENAI_SIGNED_IN_NOTE : undefined)} aria-live="polite">{accountChecks.openai === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{accountConnectionLabel(accountChecks.openai, openAiConnected, Boolean(runtimeStatus?.available))}</span>,
      action: openAiConnected ? null : openAiBilling === null && runtimeStatus?.available
        ? <button type="button" className="secondary-button" onClick={() => expandAccount("openai")}>Connect</button>
        : openAiBilling === "subscription" || !runtimeStatus?.available ? (
        <button type="button" className="secondary-button" onClick={() => void signIn()} disabled={busy || openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>
          {busy || openAiLoginStarting ? <LoaderCircle className="spin" size={13} /> : !runtimeStatus?.available ? <Download size={13} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex CLI"}
        </button>
      ) : <button type="button" className="secondary-button" onClick={() => expandAccount("openai")}>Add key</button>,
    },
    {
      id: "claude",
      name: "Claude (Anthropic)",
      detail: claudeStatus?.loggedIn && claudeStatus.email ? claudeStatus.email : claudeUsesApiKey(claudeStatus) ? "API key" : "Claude plan or API key",
      logo: <span className={`provider-logo claude${local.claudeLogo === "anthropic" ? " anthropic-mark" : ""}`}>{local.claudeLogo === "anthropic" ? <AnthropicLogo size={17} /> : <ClaudeLogo size={18} />}</span>,
      status: <span className={`provider-status ${claudeStatus?.loggedIn && !accountChecks.claude ? "on" : ""}`} title={accountChecks.claude} aria-live="polite">{accountChecks.claude === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{claudeUsesApiKey(claudeStatus) && !claudeStatus?.loggedIn && !accountChecks.claude ? "No key" : accountConnectionLabel(accountChecks.claude, Boolean(claudeStatus?.loggedIn), Boolean(claudeStatus?.available))}</span>,
      action: claudeStatus?.loggedIn ? null : claudeLoginStarting
        ? <button type="button" className="secondary-button" onClick={() => void cancelClaudeLogin().catch(() => undefined)} title="Finish signing in in your browser, or cancel"><LoaderCircle className="spin" size={13} /> Cancel</button>
        : claudeStatus?.available && claudeStatus.billing !== "subscription"
          ? <button type="button" className="secondary-button" onClick={() => expandAccount("claude")}>{claudeUsesApiKey(claudeStatus) ? "Add key" : "Connect"}</button>
          : <button type="button" className="secondary-button" onClick={() => void signInClaude()} disabled={Boolean(claudeAuthOperation.busy)}>{!claudeStatus?.available ? <Download size={13} /> : null}{claudeStatus?.available ? "Sign in" : "Install"}</button>,
    },
    {
      id: "cursor",
      name: "Cursor",
      detail: cursorStatus?.loggedIn && cursorStatus.email ? cursorStatus.email : "Cursor subscription",
      logo: <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>,
      status: <span className={`provider-status ${cursorStatus?.loggedIn && !cursorAccountCheck ? "on" : ""}`} title={cursorAccountCheck} aria-live="polite">{cursorAccountCheck === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{accountConnectionLabel(cursorAccountCheck, Boolean(cursorStatus?.loggedIn), Boolean(cursorStatus?.available))}</span>,
      action: cursorConnected ? null : (
        <button type="button" className="secondary-button" onClick={() => void (cursorStatus?.available ? onCursorSignIn() : openUrl("https://cursor.com/docs/cli/installation"))} disabled={cursorLoginStarting}>
          {cursorLoginStarting ? <LoaderCircle className="spin" size={13} /> : !cursorStatus?.available ? <Download size={13} /> : null}
          {cursorLoginStarting ? "Signing in…" : cursorStatus?.available ? "Sign in" : "Install"}
        </button>
      ),
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      detail: "Pay-as-you-go API key",
      logo: <span className="provider-logo openrouter"><OpenRouterLogo size={18} /></span>,
      status: <span className={`provider-status ${openRouterReady ? "on" : ""}`}>{openRouterReady ? "Connected" : "No key"}</span>,
      action: openRouterReady ? null : <button type="button" className="secondary-button" onClick={() => expandAccount("openrouter")}>Add key</button>,
    },
    {
      id: "lmstudio",
      name: "LM Studio",
      detail: lmStudioReady ? `${lmStudioModels.length} local model${lmStudioModels.length === 1 ? "" : "s"}` : lmStudioNoModels ? "No model loaded yet" : "Local models on this computer",
      logo: <span className="provider-logo lmstudio"><LmStudioLogo size={18} /></span>,
      // A reachable server with nothing loaded can't run a turn yet: amber, and it says what to do.
      status: <span className={`provider-status ${lmStudioReady ? "on" : lmStudioNoModels ? "warn" : ""}`}>{lmStudioReady ? "Connected" : lmStudioNoModels ? "Server online · load a model" : "Not set up"}</span>,
      action: lmStudioReady || lmStudioNoModels ? null : <button type="button" className="secondary-button" onClick={() => expandAccount("lmstudio")}>Set up</button>,
    },
  ];
  // Each row owns its panel instance even while another row is expanded.
  const accountDetail = (provider: Provider): ReactNode => provider === "openai" ? (
              <>
              <OpenAiApiKeyPanel visible={open} account={account} runtimeAvailable={Boolean(runtimeStatus?.available)} operation={openAiAuthOperation} disabled={openAiLoginStarting || busy} onChanged={onOpenAiBillingChanged} onBillingRead={setOpenAiBilling} />
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : openAiBilling === "apiKey" ? "OpenAI API connection" : "OpenAI connection"}</strong>
                  <small>{accountChecks.openai === "Checking connection…" ? accountChecks.openai : openAiBilling === "apiKey" && !account ? "Save or connect an API key above" : accountChecks.openai || (account?.type === "chatgpt" ? `${account.planType ? sentenceCase(account.planType) : "ChatGPT"} plan` : account?.type === "apiKey" ? "Billed per token to your OpenAI API account · signed in to Codex" : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI required")}</small>
                </div>
                {codexAccountReady(account) ? (
                  <div className="credential-actions">
                    <button className="secondary-button" onClick={() => void signOut()} disabled={busy || openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>Sign out</button>
                  </div>
                ) : openAiBilling === "subscription" || !runtimeStatus?.available ? (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy || openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>
                    {busy || openAiLoginStarting ? <LoaderCircle className="spin" size={14} /> : !runtimeStatus?.available ? <Download size={14} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex CLI"}
                  </button>
                ) : null}
                {runtimeStatus?.available && <button className="icon-button" onClick={refreshOpenAi} title="Refresh OpenAI connection" aria-label="Refresh OpenAI connection" aria-busy={openAiRefreshing > 0} disabled={openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>{openAiRefreshing ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button>}
              </div>
              </>
            ) : provider === "openrouter" ? (
              <div className="credential-panel stacked" data-settings-row="openrouter-key">
                <div className="credential-status">
                  <div><strong>OpenRouter API key</strong><small>{openRouterReady ? "Saved securely on this device" : "No key saved"}</small></div>
                </div>
                <div className="key-input-row">
                  <input type="password" aria-label="OpenRouter API key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  <button className="secondary-button" onClick={() => void storeKey()} disabled={!apiKey.trim() || busy}>Save key</button>
                </div>
              </div>
            ) : provider === "lmstudio" ? (
              <div className="credential-panel stacked" data-settings-row="lmstudio-server">
                <div className="credential-status">
                  <div>
                    <strong>LM Studio local server</strong>
                    <small>{lmStudioReady ? `${lmStudioModels.length} model${lmStudioModels.length === 1 ? "" : "s"} available` : lmStudioNoModels ? "The server is running but has no models loaded. Load one in LM Studio." : lmStudioModelsError || "Start the server from LM Studio’s Developer tab"}</small>
                  </div>
                </div>
                <label className="field-label">
                  <span>Server URL</span>
                  <input value={local.lmStudioBaseUrl} onChange={(event) => setLocal({ ...local, lmStudioBaseUrl: event.target.value })} placeholder={DEFAULT_LM_STUDIO_BASE_URL} spellCheck={false} />
                  <small>Keep the default for a server on this computer.</small>
                </label>
                <div className="key-input-row">
                  <input type="password" aria-label="LM Studio API token" autoComplete="off" spellCheck={false} value={lmStudioToken} onChange={(event) => setLmStudioToken(event.target.value)} placeholder={lmStudioTokenStored ? "Token saved securely" : "API token (optional)"} />
                  <button className="secondary-button" onClick={() => void storeLmStudioToken()} disabled={!lmStudioToken.trim() || busy}>Save token</button>
                  {lmStudioTokenStored && <button className="secondary-button" onClick={() => void storeLmStudioToken(true)} disabled={busy}>Remove</button>}
                </div>
                <div className="credential-status">
                  <small>{lmStudioConnectionMessage || "A token is only needed for servers that require one."}</small>
                  <button className="secondary-button" onClick={() => void testLmStudioConnection()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Test connection</button>
                </div>
              </div>
            ) : provider === "claude" ? (
              <>
              <ClaudeBillingPanel visible={open} claudeStatus={claudeStatus} operation={claudeAuthOperation} disabled={claudeLoginStarting} onChanged={onClaudeBillingChanged ?? onClaudeRefresh} />
              <div className="credential-panel">
                <div>
                  <strong>{claudeUsesApiKey(claudeStatus) ? "Anthropic API key" : claudeStatus?.loggedIn ? claudeStatus.email || "Claude subscription" : claudeStatus?.billing === "subscription" ? "Claude Code subscription" : "Claude connection"}</strong>
                  <small>{accountChecks.claude || (claudeUsesApiKey(claudeStatus)
                    ? claudeStatus?.loggedIn ? `Billed per token through ${claudeStatus.version || "Claude Code"}` : claudeStatus?.warning || "Add an Anthropic API key above"
                    : claudeStatus?.loggedIn
                    ? `${sentenceCase(claudeStatus.subscriptionType || "Claude")} plan · ${claudeStatus.version ? `Claude Code ${claudeStatus.version}` : "Claude Code"}`
                    : claudeStatus?.warning || (claudeStatus?.available ? claudeStatus.billing === "subscription" ? "Claude Code detected · sign in to continue" : "Choose how to bill Claude work above" : "Claude Code must be installed first"))}</small>
                </div>
                {claudeStatus?.loggedIn ? null : claudeLoginStarting ? (
                    <button className="secondary-button" onClick={() => void cancelClaudeLogin().catch(() => undefined)} title="Finish signing in in your browser, or cancel">
                      <LoaderCircle className="spin" size={14} /> Cancel sign-in
                    </button>
                  ) : !claudeStatus?.available || claudeStatus.billing === "subscription" ? (
                    <button className="secondary-button" onClick={() => void signInClaude()} disabled={Boolean(claudeAuthOperation.busy)}>
                      {!claudeStatus?.available ? <Download size={14} /> : null}
                      {claudeStatus?.available ? "Sign in" : "Install Claude Code"}
                    </button>
                  ) : null}
                <button className="icon-button" onClick={() => void refreshClaude()} title="Refresh Claude status" aria-label="Refresh Claude status" disabled={claudeLoginStarting || Boolean(claudeAuthOperation.busy)} aria-busy={claudeAuthOperation.busy === "refreshing"}>{claudeAuthOperation.busy === "refreshing" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button>
              </div>
              {claudeStatus?.loggedIn && claudeStatus.warning && <div className="settings-notice" role="status">
                <Info size={13} /><span>{claudeStatus.warning}</span>
                <button type="button" className="secondary-button" onClick={() => setSettingsSection("updates")}>Open updates</button>
              </div>}
              </>
            ) : (
              <div className="credential-panel">
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <div>
                  <strong>{cursorStatus?.loggedIn ? cursorStatus.email || "Cursor subscription" : "Cursor Agent subscription"}</strong>
                  <small>{cursorAccountCheck || (cursorStatus?.loggedIn
                    ? "Connected through Cursor Agent on this device"
                    : cursorStatus?.warning || (cursorStatus?.available ? "Cursor Agent detected · sign in to continue" : "Cursor Agent CLI must be installed first"))}</small>
                </div>
                {(!cursorStatus?.loggedIn || cursorStatus.authVerified === false) && (
                  <button className="secondary-button" onClick={() => void (cursorStatus?.available ? onCursorSignIn() : openUrl("https://cursor.com/docs/cli/installation"))} disabled={cursorLoginStarting}>
                    {cursorLoginStarting ? <LoaderCircle className="spin" size={14} /> : !cursorStatus?.available ? <Download size={14} /> : null}
                    {cursorLoginStarting ? "Signing in…" : cursorStatus?.available ? "Sign in" : "Install Cursor Agent"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onCursorRefresh()} title="Refresh Cursor status" aria-label="Refresh Cursor status"><RotateCcw size={14} /></button>
              </div>
            );

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} data-backdrop-blur={isWindowsPlatform() ? "always" : undefined} onMouseDown={requestClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div ref={dialogRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            <div className="settings-nav-head">
              <h2 id="settings-title">Settings</h2>
              {remoteMachineActive && <small className="settings-machine-label">Applies to {localMachine}, not the device you're viewing</small>}
              <div className="settings-search">
                <Search size={13} aria-hidden="true" />
                <input
                  type="text"
                  value={navQuery}
                  aria-label="Search settings"
                  placeholder="Search settings"
                  onChange={(event) => setNavQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && navQuery) { event.stopPropagation(); setNavQuery(""); }
                    // ↓ moves from the search field into the list below it.
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      event.currentTarget.closest(".settings-nav")?.querySelector<HTMLButtonElement>(".settings-nav-scroll button")?.focus();
                    }
                    // Enter opens the first result in the listed order.
                    if (event.key === "Enter" && orderedResults.length) {
                      event.preventDefault();
                      const first = orderedResults[0]!;
                      if (first.kind === "row") goToRow(first.item as SettingsRow);
                      else setSettingsSection((first.item as { id: SettingsPane }).id);
                    }
                  }}
                />
                {navQuery && <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setNavQuery("")}><X size={12} /></button>}
              </div>
              <p className="sr-only" role="status" aria-live="polite">{searchArrival || (navQuery.trim() ? (searchResultCount ? `${searchResultCount} result${searchResultCount === 1 ? "" : "s"}` : "No results") : "")}</p>
            </div>
            <div className="settings-nav-scroll" onKeyDown={(event) => {
              // ↑/↓ walk the categories (and search results); ↑ from the
              // first one returns to the search field.
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              if (event.key === "ArrowUp" && index === 0) {
                event.currentTarget.closest(".settings-nav")?.querySelector<HTMLInputElement>(".settings-search input")?.focus();
                return;
              }
              buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
            }}>
              {!navQuery.trim() && navGroups.map((section) => (
                <div className="settings-nav-group" key={section.group} role="group" aria-label={section.group}>
                  <span className="settings-nav-label" aria-hidden>{section.group}</span>
                  {section.items.map(({ id, label, icon: Icon }) => {
                    const current = settingsSection === id || (!navQuery.trim() && SETTINGS_PANES.get(settingsSection)?.parent === id);
                    const heldHere = heldBack?.pane === id;
                    return <button
                      key={id}
                      className={current ? "active" : ""}
                      onClick={() => setSettingsSection(id)}
                      aria-current={current ? "page" : undefined}
                    >
                      <Icon size={14} aria-hidden="true" /><span>{label}</span>{id === "updates" && anyUpdateAvailable && <span className="settings-update-dot" role="img" aria-label="Update available" />}{heldHere && <span className="settings-dirty-dot" role="img" aria-label="Has a change that can’t be saved yet" title="Has a change that can’t be saved yet" />}
                    </button>;
                  })}
                </div>
              ))}
              {navQuery.trim() && orderedResults.length > 0 && <div className="settings-nav-group settings-search-results" role="group" aria-label="Search results">
                <span className="settings-nav-label" aria-hidden>Results</span>
                {orderedResults.map((result) => {
                  if (result.kind === "row") {
                    const row = result.item as SettingsRow;
                    return <button key={`row:${row.id}`} type="button" className="settings-row-result-button" onClick={() => goToRow(row)}>
                      <CornerDownRight size={14} aria-hidden="true" /><span className="settings-row-result"><small>{SETTINGS_PANES.get(row.pane)?.label}</small><span>{row.label}</span></span>
                    </button>;
                  }
                  const { id, label, icon: Icon } = result.item as (typeof navMatches)[number];
                  const current = settingsSection === id;
                  return <button key={`pane:${id}`} type="button" className={current ? "active" : ""} onClick={() => setSettingsSection(id)} aria-current={current ? "page" : undefined}>
                    <Icon size={14} aria-hidden="true" /><span>{label}</span>
                  </button>;
                })}
              </div>}
              {navQuery.trim() && !orderedResults.length && <p className="settings-nav-empty">Nothing matches &ldquo;{navQuery.trim()}&rdquo;.</p>}
            </div>
          </nav>
          <div className="settings-pane">
            <header className="settings-pane-heading">
              <div className={usageTabs ? "settings-heading-stack" : undefined}>
                {usageTabs ? (["usage", "pricing"] as const).map((pane) => (
                  <div className="settings-heading-copy" key={pane} aria-hidden={settingsSection !== pane}>
                    <h3>{SETTINGS_PANES.get(pane)?.label}</h3>
                    <small>{SETTINGS_PANES.get(pane)?.detail}</small>
                  </div>
                )) : <>
                  <h3>{SETTINGS_PANES.get(settingsSection)?.label}</h3>
                  <small>{SETTINGS_PANES.get(settingsSection)?.detail}</small>
                </>}
              </div>
              {/* The one save confirmation: brief, quiet, and announced. */}
              <span className={`settings-saved${savedFlash ? " show" : ""}`} role="status" aria-live="polite">{savedFlash ? <><Check size={12} aria-hidden="true" /> Saved</> : null}</span>
              <button className="icon-button settings-close" onClick={requestClose} aria-label="Close settings" title="Close (Esc)"><X size={17} /></button>
            </header>
            <div className={`settings-content ${moreBelow ? "has-more-below" : ""}`} ref={contentRef}>
          {settingsSection === "voice" &&
          <TranscriptionSettings
            visible={open}
            value={local.transcription}
            onChange={(transcription) => setLocal((current) => ({ ...current, transcription }))}
            accountOpenRouterKeySaved={openRouterReady}
            onOpenAccounts={() => {
              expandAccount("openrouter");
              setSettingsSection("models");
            }}
          />}

          {settingsSection === "general" && <>
          <div className="set-group">
            <h4>Behavior</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Escape stops the active run</strong>
                  <small id={escapeStopsRunId}>Escape still closes menus and dialogs. Text fields keep their own Escape behavior.</small>
                </div>
                <div className="set-control">
                  <Switch checked={local.escapeStopsRun} label="Escape stops the active run" describedBy={escapeStopsRunId} onChange={() => setLocal({ ...local, escapeStopsRun: !local.escapeStopsRun })} />
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Desktop notifications</strong>
                  <small>Notify when a background task finishes.</small>
                </div>
                <div className="set-control">
                  <Switch checked={local.notificationsEnabled} label="Desktop notifications" onChange={() => setLocal({ ...local, notificationsEnabled: !local.notificationsEnabled })} />
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Status in the menu bar</strong>
                  <small>Shows thread status in the menu bar or notification area.</small>
                </div>
                <div className="set-control">
                  <Switch checked={trayStatus} label="Status in the menu bar" onChange={() => setTrayStatusEnabled(!trayStatus)} />
                </div>
              </div>
            </div>
          </div>
          <div className="set-group">
            <h4>New threads</h4>
            <div className="set-card">
              {/* Opt-in. The popover says the two things people would otherwise
                  find out afterwards: the first message leaves for whichever
                  provider is chosen here even from a thread running on another
                  one, and a name you typed is yours. The fields appear only
                  once it is on; an off switch needs no configuration. */}
              <div className="set-row">
                <div className="set-copy">
                  <strong>Automatic thread titles</strong>
                  <small>Names each new thread from your first message, using the model you choose. <SettingInfo label="How automatic thread titles work">That first message goes to the provider chosen here, even when the thread itself runs on another one, and uses that provider&rsquo;s subscription or credits. Nothing is kept as a chat, and a title you write yourself is never replaced.</SettingInfo></small>
                </div>
                <div className="set-control">
                  <Switch checked={local.automaticThreadTitles} label="Automatic thread titles" onChange={() => setLocal({ ...local, automaticThreadTitles: !local.automaticThreadTitles })} />
                </div>
              </div>
              {local.automaticThreadTitles && (
                <ThreadTitleFields
                  settings={local}
                  catalogs={modelCatalogs}
                  readiness={childAgentReadiness}
                  onChange={setLocal}
                  onAccounts={() => setSettingsSection("models")}
                />
              )}
            </div>
          </div>
          <div className="set-group">
            <h4>Help</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Guided setup</strong>
                <small>A short tour of providers, projects, sub-agents and ways to make the app your own.</small>
              </div>
              <div className="set-control">
                <button type="button" className="secondary-button" onClick={requestOnboarding}><BookOpenCheck size={13} /> Run onboarding</button>
              </div>
            </div>
            {onOpenShortcuts && <div className="set-row" data-settings-row="general-shortcuts">
              <div className="set-copy">
                <strong>Keyboard shortcuts</strong>
                <small>Every shortcut in one list, with a filter. Also opens with {formatShortcut("shortcuts")} from the main window.</small>
              </div>
              <div className="set-control">
                <button type="button" className="secondary-button" onClick={() => void requestShortcuts()}><Keyboard size={13} /> Show shortcuts</button>
              </div>
            </div>}
            </div>
          </div>
          </>}
          {settingsSection === "appearance" &&
          <section className="settings-section theme-settings-section">
            {appearanceOffer && <div className="settings-preview-offer" role="status">
              <Palette size={15} aria-hidden="true" />
              <div className="settings-preview-offer-copy">
                <strong>Previewing the look from the tour</strong>
                <small>{[
                  appearanceOffer.theme !== local.theme ? THEMES.find((theme) => theme.id === appearanceOffer.theme)?.name ?? appearanceOffer.theme : "",
                  appearanceOffer.chatFont !== local.chatFont ? `${chatFontName(appearanceOffer.chatFont, appCustomFonts)} font` : "",
                  appearanceOffer.effortSlider !== local.effortSlider ? `${EFFORT_SLIDER_STYLES.find((style) => style.id === appearanceOffer.effortSlider)?.name ?? appearanceOffer.effortSlider} slider` : "",
                ].filter(Boolean).join(" · ")}. Nothing is saved unless you apply it.</small>
              </div>
              <div className="settings-preview-offer-actions">
                <button type="button" className="secondary-button" onClick={() => endAppearanceOffer(local)}>Keep current look</button>
                <button type="button" className="primary-button" onClick={applyAppearanceOffer}>Apply this look</button>
              </div>
            </div>}
            {activeProjectHasAppearanceOverride && <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>This project has its own appearance, so changes here apply to your other projects. Edit this one in Projects.</span></p>}
            <div className="set-group">
              <div className="set-group-head"><h4>Theme</h4>{local.theme !== DEFAULT_SETTINGS.theme && <button type="button" className="secondary-button" onClick={() => previewTheme(DEFAULT_SETTINGS.theme)}><RotateCcw size={12} /> Use default theme</button>}</div>
              <div className="set-card bare"><div className="set-body">
                <div className="theme-grid" role="radiogroup" aria-label="Theme" onKeyDown={rovingChoiceKeyDown}>
                  {THEMES.map((theme) => (
                    <button
                      type="button"
                      key={theme.id}
                      className={`theme-card ${local.theme === theme.id ? "selected" : ""}`}
                      role="radio"
                      aria-checked={local.theme === theme.id}
                      tabIndex={local.theme === theme.id ? 0 : -1}
                      title={theme.description}
                      onClick={() => previewTheme(theme.id)}
                    >
                      {/* A miniature of the app itself — ground, sidebar, content,
                          and the accent doing the one job it does in the real
                          window — rather than three anonymous colour chips. */}
                      <span className="theme-preview" style={{ background: theme.swatches[0] }} aria-hidden="true">
                        <i className="theme-preview-rail" style={{ background: theme.swatches[1] }} />
                        <i className="theme-preview-body" style={{ background: theme.swatches[1] }} />
                        <i className="theme-preview-active" style={{ background: theme.swatches[2], color: theme.swatches[2] }} />
                        <i className="theme-preview-accent" style={{ background: theme.swatches[2] }} />
                      </span>
                      <span><strong>{theme.name}</strong></span>
                      {local.theme === theme.id && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Size</h4>
              <div className="set-card"><div className="set-row">
                <div className="set-copy">
                  <strong>App scale</strong>
                  <small>Scales the whole app, including chat text.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu
                    value={String(local.uiScale ?? 100)}
                    options={INTERFACE_SIZE_OPTIONS}
                    ariaLabel="App scale"
                    portal
                    onChange={(value) => previewUiScale(Number(value))}
                  />
                </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Chat font</h4>
              <ChatFontSettings value={local.chatFont} onChange={previewChatFont} active={open && settingsSection === "appearance"} />
            </div>

            <div className="set-group">
              <h4>Effort slider</h4>
              <p>How the reasoning slider looks for every provider.</p>
              <div className="set-card bare"><div className="set-body">
                    <div className="slider-style-grid" role="radiogroup" aria-label="Effort slider" onKeyDown={rovingChoiceKeyDown}>
                      {EFFORT_SLIDER_STYLES.map((style) => (
                        <button
                          type="button"
                          key={style.id}
                          className={`slider-style-card ${local.effortSlider === style.id ? "selected" : ""}`}
                          title={style.description}
                          role="radio"
                          aria-checked={local.effortSlider === style.id}
                          tabIndex={local.effortSlider === style.id ? 0 : -1}
                          onClick={() => previewEffortSlider(style.id)}
                        >
                          <span className={`slider-style-preview ${style.id}`} aria-hidden="true">
                            <i className="slider-style-rail" /><i className="slider-style-thumb" />
                          </span>
                          <span><strong>{style.name}</strong></span>
                          {local.effortSlider === style.id && <Check size={14} />}
                        </button>
                      ))}
                    </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Provider logos</h4>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong>Logos on threads and controls</strong>
                    <small>{[
                      local.openAiLogo === "codex" ? "Codex" : "OpenAI",
                      local.claudeLogo === "anthropic" ? "Anthropic" : "Claude",
                      local.cursorLogo === "app-dark" ? "Cursor Dark" : "Cursor",
                    ].join(" · ")}</small>
                  </div>
                  <div className="set-control">
                    <button type="button" className="secondary-button" aria-expanded={providerLogosOpen} aria-controls={providerLogosId} onClick={() => setProviderLogosOpen((value) => !value)}>{providerLogosOpen ? "Done" : "Change logos"}</button>
                  </div>
                </div>
              </div>
              {providerLogosOpen && <div className="set-card bare" id={providerLogosId}><div className="set-body">
                    <div className="provider-mark-grid">
                      <div className="provider-mark-group">
                        <span>OpenAI threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="OpenAI model logo" onKeyDown={rovingChoiceKeyDown}>
                          <button type="button" className={local.openAiLogo === "openai" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "openai"} tabIndex={local.openAiLogo === "openai" ? 0 : -1} onClick={() => setLocal({ ...local, openAiLogo: "openai" })}>
                            <span className="provider-logo-preview openai"><OpenAILogo size={18} /></span>
                            <span><strong>OpenAI</strong></span>
                            {local.openAiLogo === "openai" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.openAiLogo === "codex" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "codex"} tabIndex={local.openAiLogo === "codex" ? 0 : -1} onClick={() => setLocal({ ...local, openAiLogo: "codex" })}>
                            <span className="provider-logo-preview codex"><CodexLogo size={20} /></span>
                            <span><strong>Codex</strong></span>
                            {local.openAiLogo === "codex" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                      <div className="provider-mark-group">
                        <span>Claude threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="Claude model logo" onKeyDown={rovingChoiceKeyDown}>
                          <button type="button" className={local.claudeLogo === "claude" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "claude"} tabIndex={local.claudeLogo === "claude" ? 0 : -1} onClick={() => setLocal({ ...local, claudeLogo: "claude" })}>
                            <span className="provider-logo-preview claude"><ClaudeLogo size={18} /></span>
                            <span><strong>Claude</strong></span>
                            {local.claudeLogo === "claude" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.claudeLogo === "anthropic" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "anthropic"} tabIndex={local.claudeLogo === "anthropic" ? 0 : -1} onClick={() => setLocal({ ...local, claudeLogo: "anthropic" })}>
                            <span className="provider-logo-preview anthropic"><AnthropicLogo size={18} /></span>
                            <span><strong>Anthropic</strong></span>
                            {local.claudeLogo === "anthropic" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                      <div className="provider-mark-group">
                        <span>Cursor threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="Cursor model logo" onKeyDown={rovingChoiceKeyDown}>
                          <button type="button" className={local.cursorLogo === "cube" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "cube"} tabIndex={local.cursorLogo === "cube" ? 0 : -1} onClick={() => setLocal({ ...local, cursorLogo: "cube" })}>
                            <span className="provider-logo-preview cursor"><CursorLogo size={19} /></span>
                            <span><strong>Cursor</strong></span>
                            {local.cursorLogo === "cube" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.cursorLogo === "app-dark" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "app-dark"} tabIndex={local.cursorLogo === "app-dark" ? 0 : -1} onClick={() => setLocal({ ...local, cursorLogo: "app-dark" })}>
                            <span className="provider-logo-preview cursor-app-dark"><CursorDarkAppIcon size={26} /></span>
                            <span><strong>Cursor Dark</strong></span>
                            {local.cursorLogo === "app-dark" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>
              </div></div>}
            </div>
          </section>}

          <div hidden={settingsSection !== "prompts"}><section className="settings-section">
            <PromptsSettings
              active={settingsSection === "prompts"}
              visible={open}
              layer={promptLayer}
              onLayer={setPromptLayer}
              settings={local}
              onSettings={setLocal}
              profiles={localProfiles}
              onProfiles={setLocalProfiles}
              skills={skills}
              promptRefs={promptRefs}
              analyze={onAnalyzeSkillDependencies ? promptAnalyzers : undefined}
              globalInstructionFiles={globalInstructionFiles}
              globalInstructionDiscoveryBusy={globalInstructionDiscoveryBusy}
              globalInstructionDiscoveryError={globalInstructionDiscoveryError}
              onRefreshGlobalInstructionFiles={onRefreshGlobalInstructionFiles}
              onGlobalInstructionFileSaved={onGlobalInstructionFileSaved}
              onOpenMemory={() => setSettingsSection("memory")}
              projectInstructions={projectInstructionsTarget ? { name: projectInstructionsTarget.name, open: () => void (async () => { if (await settleBeforeLeaving()) projectInstructionsTarget.open(); })() } : undefined}
            />
          </section></div>

          {settingsSection === "workflows" && <>
          <WorkflowManager
            workflows={workflows}
            runs={workflowRuns}
            projects={projects}
            skills={skills}
            settings={local}
            onWorkflows={onWorkflows}
            onRun={onRunWorkflow}
            onStop={onStopWorkflow}
            onOpenRun={onOpenRun}
          />
          <QuickActionsSettings actions={actions} onActions={onActions} drafts={harnessDrafts} onDrafts={setHarnessDrafts} />
          </>}

          {settingsSection === "scheduled-tasks" && <ScheduledTasksSettings
            visible={open}
            settings={local}
            schedules={schedules}
            projects={projects}
            modelCatalogs={subAgentModelCatalogs}
            scheduleRuns={scheduleRuns}
            workflows={workflows}
            onSchedules={onSchedules}
            onWorkflows={onWorkflows}
            onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
            onOpenRun={onOpenRun}
          />}

          {settingsSection === "memory" && <section className="settings-section">
            <PreferenceLearningSettings projects={projects} modelCatalogs={learningModelCatalogs} onLearnPastConversations={onLearnPastConversations} onCancelLearning={onCancelPreferenceLearning} historyProgress={preferenceHistoryProgress} onChanged={onPreferenceLearningChanged} />
          </section>}

          {settingsSection === "devices" && <DevicesSettings projects={projects} />}

          {/* M08 (round 6): MCP setup and language tools share one long
              scroll; the same sticky jump list as Sub-agents lets either be
              reached directly. */}
          {settingsSection === "tools" && <SettingsJumpList label="MCP & language servers sections" items={TOOLS_SECTIONS} scrollRef={contentRef} />}

          {settingsSection === "tools" && <McpServerSettings mcpServers={mcpServers} onMcpChanged={onMcpChanged} onSignIn={workspaceToolsAvailable ? onWorkspaceTools : undefined} drafts={harnessDrafts} onDrafts={setHarnessDrafts} />}

          {settingsSection === "tools" && <LanguageToolsSettings />}

          {settingsSection === "tools" &&
          <div className="set-group" id="tools-live">
            <h4 tabIndex={-1}>In this thread</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Tools → Skills & MCP</strong>
                <small>{workspaceToolsAvailable ? "Inspect live skills, finish MCP sign-in and connect servers for the open project." : "Open a project first to inspect its live skills and MCP servers."}</small>
              </div>
              <div className="set-control">
                <button className="secondary-button" onClick={onWorkspaceTools} disabled={!workspaceToolsAvailable}><PanelRight size={13} /> Open Skills &amp; MCP in Tools</button>
              </div>
            </div></div>
          </div>}

          {settingsSection === "projects" && <>
          <div className="set-group">
            <h4>New project threads</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Set up Git automatically</strong>
                <small id={automaticGitInitializationId}>Creates a local Git repository when a new thread starts in a folder that has none. <SettingInfo label="What automatic Git setup does">Existing repositories are left untouched. Mythra Code doesn&rsquo;t create commits or publish anything to GitHub.</SettingInfo></small>
              </div>
              <div className="set-control">
                <Switch checked={local.automaticGitInitialization === true} label="Set up Git automatically" describedBy={automaticGitInitializationId} onChange={() => setLocal({ ...local, automaticGitInitialization: local.automaticGitInitialization !== true })} />
              </div>
            </div></div>
          </div>
          <ProjectDefaultsSettings
            active={open && settingsSection === "projects"}
            projects={localProjects}
            activeProjectId={activeProjectId}
            settings={local}
            runtimeModels={runtimeModels}
            claudeModels={claudeModels}
            cursorModels={cursorModels}
            openRouterModels={openRouterModels}
            lmStudioModels={lmStudioModels}
            modelFavorites={modelFavorites}
            onToggleModelFavorite={onToggleModelFavorite}
            onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
            onProjects={setLocalProjects}
            onThemePreview={onThemePreview}
            onEffortSliderPreview={onEffortSliderPreview}
            onChatFontPreview={onChatFontPreview}
          />
          <ProjectProfiles
            projects={localProjects}
            activeProjectId={activeProjectId}
            onProjects={setLocalProjects}
            onAppliedToActive={(project) => {
              const defaults = project.overrides?.defaults;
              onThemePreview(defaults?.theme ?? local.theme);
              onEffortSliderPreview(defaults?.effortSlider ?? local.effortSlider);
              onChatFontPreview(defaults?.chatFont ?? local.chatFont);
            }}
          /></>}

          {settingsSection === "github" &&
          <GitHubSettings
            status={githubStatus}
            busy={githubBusy}
            loginPending={githubLoginPending}
            signInError={githubSignInError}
            cloneUrl={cloneUrl}
            cloneParent={cloneParent}
            onCloneUrl={setCloneUrl}
            onCloneParent={setCloneParent}
            onSignIn={onGitHubSignIn}
            onRefresh={onGitHubRefresh}
            onClone={async () => {
              if (await onGitHubClone(cloneUrl, cloneParent)) {
                setCloneUrl("");
              }
            }}
          />}

          {usageTabs && <div className="settings-pane-tabs" role="tablist" aria-label="Usage pages" onKeyDown={rovingChoiceKeyDown}>
            <button type="button" role="tab" id={`${usageTabsId}-usage`} aria-controls={`${usageTabsId}-panel`} tabIndex={settingsSection === "usage" ? 0 : -1} aria-selected={settingsSection === "usage"} className={settingsSection === "usage" ? "selected" : ""} onClick={() => setSettingsSection("usage")}>Spending</button>
            <button type="button" role="tab" id={`${usageTabsId}-pricing`} aria-controls={`${usageTabsId}-panel`} tabIndex={settingsSection === "pricing" ? 0 : -1} aria-selected={settingsSection === "pricing"} className={settingsSection === "pricing" ? "selected" : ""} onClick={() => setSettingsSection("pricing")}>Model pricing</button>
          </div>}
          {usageTabs && <div role="tabpanel" id={`${usageTabsId}-panel`} aria-labelledby={`${usageTabsId}-${settingsSection}`} className="settings-tabpanel">
          {settingsSection === "usage" && <>
            {/* Opus R6 D4 / Sol M08: the pane leads with usage; how live
                quotas read is a display preference, so it sits below. */}
            {open && <UsageDashboard onRefreshPricing={onRefreshUsagePricing} openRouterPricingError={openRouterPricingError} />}
            <UsageDisplaySettings value={local.usageDisplay} onChange={(usageDisplay) => setLocal({ ...local, usageDisplay })} />
          </>}

          {settingsSection === "pricing" && open && <FrontierPricingSettings onRefreshAvailableModels={onRefreshAvailableModels} />}
          </div>}

          {settingsSection === "skills" && <SkillLibrary
            active={open}
            menuScale={(local.uiScale ?? 100) / 100}
            onInstallOfficial={onInstallOfficialSkill}
            officialInstallFailure={officialSkillInstallFailure}
            officialInstallingId={officialSkillInstallingId}
            openSkillRequest={openSkillRequest}
            onOpenSkillRequestConsumed={onOpenSkillRequestConsumed}
            onAnalyzeSkill={open ? onAnalyzeSkill : undefined}
            folder={skillsFolder}
            skills={skills}
            removedSkills={removedSkills}
            busy={skillsBusy}
            error={skillsError}
            onChooseFolder={onChooseSkillsFolder}
            onRefresh={onRefreshSkills}
            onImport={onImportSkills}
            onCreate={onCreateSkill}
            onRead={onReadSkill}
            onUpdate={onUpdateSkill}
            onRename={onRenameSkill}
            onToggle={onToggleSkill}
            onRemove={onRemoveSkill}
            onRestore={onRestoreSkill}
          />}

          {settingsSection === "updates" && <UpdateSettings appUpdater={appUpdater} developerRuntimeUpdater={developerRuntimeUpdater} checkAll={checkAllUpdates} />}

          {settingsSection === "system" && <>
          <div className="set-group">
            <h4>Terminal</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Terminal history</strong>
                  <small>How much output each terminal keeps in memory.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu portal value={String(local.terminalScrollback)} options={TERMINAL_SCROLLBACK_OPTIONS} ariaLabel="Terminal history" onChange={(value) => setLocal({ ...local, terminalScrollback: Number(value) })} />
                </div>
              </div>
              <div className="set-row terminal-timeout-row">
                <div className="set-copy">
                  <strong>Stop long-running commands after</strong>
                  <small id={`${terminalTimeoutId}-help`}>A time limit for new commands started from Terminal or Run. <SettingInfo label="How the command time limit works">Commands already running keep the limit they started with. With no limit, a command runs until it exits or you stop it. Provider tool runs, quick actions and project checks keep their own limits.</SettingInfo></small>
                </div>
                <div className="set-control">
                  <Switch checked={terminalTimeoutEnabled} label="Stop long-running commands" describedBy={`${terminalTimeoutId}-help`} onChange={() => setTerminalTimeoutEnabled(!terminalTimeoutEnabled)} />
                </div>
                {terminalTimeoutEnabled ? (
                  <div className="terminal-timeout-detail">
                    <label id={`${terminalTimeoutId}-label`} htmlFor={`${terminalTimeoutId}-minutes`}>Limit</label>
                    <input
                      ref={scrollableNumberInputRef}
                      id={`${terminalTimeoutId}-minutes`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_TERMINAL_TIMEOUT_MINUTES}
                      step={1}
                      autoComplete="off"
                      aria-labelledby={`${terminalTimeoutId}-label ${terminalTimeoutId}-unit`}
                      aria-describedby={terminalTimeoutInvalid ? `${terminalTimeoutId}-error` : undefined}
                      aria-invalid={terminalTimeoutInvalid}
                      value={terminalTimeoutText ?? String(terminalTimeoutMinutes)}
                      onChange={(event) => editTerminalTimeout(event.target.value)}
                      onBlur={() => { if (!terminalTimeoutInvalid) setTerminalTimeoutText(null); }}
                    />
                    <span id={`${terminalTimeoutId}-unit`}>minutes</span>
                    {terminalTimeoutInvalid && <p id={`${terminalTimeoutId}-error`} className="terminal-timeout-error" role="alert">
                      {/^\d+$/.test(terminalTimeoutText?.trim() ?? "") && Number(terminalTimeoutText) > 0
                        ? `Enter ${MAX_TERMINAL_TIMEOUT_MINUTES.toLocaleString()} minutes or fewer, or turn the limit off.`
                        : "Enter a whole number of minutes, 1 or more."}
                    </p>}
                  </div>
                ) : <p className="terminal-timeout-detail">No time limit</p>}
              </div>
            </div>
          </div>

          <div className="set-group">
            <h4>Privacy</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Record last-turn instructions</strong>
                  <small>Keeps a local copy of what the agent was told on its last turn. Off by default. <SettingInfo label="About instruction records">Keeps the last confirmed turn for up to 24 threads, with the first 32,000 instruction characters each. Records can contain private prompts, learned preferences and skill instructions, and stay on this device. View them in Tools → Usage → Request details. Turning this off stops new records; existing records remain until deleted.</SettingInfo></small>
                </div>
                <div className="set-control">
                  <Switch checked={instructionRecording} label="Record last-turn instructions" disabled={instructionRecordBusy} onChange={() => {
                    try {
                      setTurnContextRecordingEnabled(!instructionRecording);
                      setInstructionRecordError("");
                      setInstructionRecordStatus("");
                    } catch { setInstructionRecordError("Could not save this privacy preference. Please try again."); }
                  }} />
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy"><strong>Delete instruction records</strong><small>{instructionRecordCount} saved {instructionRecordCount === 1 ? "thread" : "threads"}. Also turns recording off; chats and instruction files stay.</small></div>
                <div className="set-control"><button type="button" className="secondary-button compact" disabled={instructionRecordBusy || (!instructionRecordCount && !instructionRecordError)} onClick={() => {
                  void (async () => {
                    if (!await confirmDialog("Delete all saved instruction records on this device and turn recording off? Your chats and original instructions will stay untouched.", { confirmLabel: "Delete records", inApp: true })) return;
                    setInstructionRecordBusy(true);
                    setInstructionRecordError("");
                    setInstructionRecordStatus("");
                    try {
                      clearTurnContextReceipts();
                      if (isTauri()) await flushPendingStateWrites();
                      setInstructionRecordStatus("Instruction records deleted. Recording is off.");
                    } catch { setInstructionRecordError("Recording has been stopped, but deletion could not be confirmed. Please try again."); }
                    finally { setInstructionRecordBusy(false); }
                  })();
                }}>{instructionRecordBusy ? <LoaderCircle size={12} className="spin" /> : <Trash2 size={12} />} Delete records</button></div>
              </div>
            </div>
            {instructionRecordError && <p className="set-group-message error" role="alert">{instructionRecordError}</p>}
            {instructionRecordStatus && <p className="set-group-message" role="status">{instructionRecordStatus}</p>}
          </div>

          <div className="set-group">
            <h4>Diagnostics</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Export a diagnostic bundle</strong>
                  <small>Runtime details, recent errors and performance samples as JSON, saved to a file you choose; nothing is sent. Look it over before sharing it. · {runtimeStatus?.version ?? "runtime version unavailable"}{runtimeStatus?.warning ? ` · ${runtimeStatus.warning}` : ""}</small>
                </div>
                <div className="set-control">
                  <button className="secondary-button" onClick={() => void exportDiagnosticBundle()}>Export JSON</button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Performance overlay</strong>
                  <small>Frame rate, slow frames and memory in a corner of the window.</small>
                </div>
                <div className="set-control">
                  <Switch checked={performanceOverlay} label="Performance overlay" onChange={() => setPerformanceOverlayEnabled(!performanceOverlay)} />
                </div>
              </div>
              <RecentPerformancePanel active={open && settingsSection === "system"} />
              <RecentErrorsPanel active={open && settingsSection === "system"} />
            </div>
          </div>
          </>}

          {settingsSection === "agents" &&
          <section className="settings-section subagent-settings">
            <SettingsJumpList label="Sub-agents sections" items={SUBAGENT_SECTIONS} scrollRef={contentRef} />
            <div className="set-group" id="subagents-defaults">
              <h4 tabIndex={-1}>Defaults</h4>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong>Default sub-agent setup</strong>
                    <small>The crew and limits a thread uses once you turn sub-agents on in its composer. <SettingInfo label="How sub-agent defaults apply">Every new thread starts with sub-agents off; turn them on in that thread&rsquo;s composer when needed. Saved crews and limits stay available, and existing thread opt-ins are kept.</SettingInfo></small>
                  </div>
                  <div className="set-control">
                    <button type="button" className="secondary-button" aria-expanded={agentDefaultsOpen} onClick={() => setAgentDefaultsOpen((open) => !open)}>{agentDefaultsOpen ? "Done editing" : "Edit defaults"}</button>
                  </div>
                </div>
            {agentDefaultsOpen && <div className="set-body" role="group" aria-label="Sub-agent defaults editor">
            <p className="subagent-applied-note">The saved switch below applies to older threads that still use defaults. It does not enable spawning in new threads.</p>
            <div className="field-label">
              <span>Edit defaults for</span>
              <AppSelectMenu portal ariaLabel="Sub-agent defaults scope" value={agentEditScope} options={[
                { value: "global", label: "App defaults", detail: "Chats and projects without an override" },
                ...localProjects.map((project) => ({ value: project.id, label: project.name, detail: "This project only" })),
              ]} onChange={setAgentEditScope} />
            </div>
            <SubagentPolicyEditor policy={editedAgentPolicy} readiness={childAgentReadiness} disabled={false}
              modelCatalogs={subAgentModelCatalogs} modelFavorites={modelFavorites}
              onToggleModelFavorite={onToggleModelFavorite} onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
              onChange={(policy) => updateAgentPolicy(policy, agentEditScope)} />
            {editedAgentProject?.overrides?.subagents && <button type="button" className="secondary-button" onClick={() => clearProjectAgentPolicy(editedAgentProject.id)}>Use app defaults for this project</button>}
            </div>}
              </div>
            </div>

            {policyNotice && <p className="subagent-applied-note" role="status"><Check size={13} aria-hidden="true" /> {policyNotice}</p>}

            <div className="set-group preset-panel" id="subagents-presets">
                  <div className="set-group-head">
                    <h4 tabIndex={-1}>Presets</h4>
                    {/* Limits only show once they're close. */}
                    {local.childAgentPresets.length >= MAX_CHILD_AGENT_PRESETS - 2 && <span className="set-group-note">{local.childAgentPresets.length} of {MAX_CHILD_AGENT_PRESETS}</span>}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setCreatingPreset(true)}
                      disabled={presetsFull || creatingPreset}
                    ><Plus size={12} /> Create preset</button>
                  </div>
                  {local.childAgentPresets.length > 0 && <p>Save providers, models, reasoning and concurrency as one reusable setup.</p>}
                  {creatingPreset && (
                    <div className="preset-create-card">
                      <span className="preset-create-heading"><strong>Create a preset</strong><small>Name the reusable setup before configuring it.</small></span>
                      <label>
                        <span>Preset name</span>
                        <input
                          autoFocus
                          aria-label="New preset name"
                          value={presetDraftName}
                          maxLength={60}
                          placeholder="For example, Code review sub-agents"
                          onChange={(event) => setPresetDraftName(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); createPreset(); } }}
                        />
                      </label>
                      <p><Check size={13} aria-hidden="true" /> Starts as a copy of the setup currently used by <strong>{presetSourceName}</strong>. Editing this preset will not change that setup until you apply it.</p>
                      <div className="preset-create-actions">
                        <button type="button" className="secondary-button" onClick={() => { setCreatingPreset(false); setPresetDraftName(""); }}>Cancel</button>
                        <button type="button" className="primary-button" disabled={!presetDraftName.trim()} onClick={createPreset}>Create and configure</button>
                      </div>
                    </div>
                  )}
                  {local.childAgentPresets.length ? (
                    <div className="preset-list">
                      {local.childAgentPresets.map((preset, index) => {
                        const expanded = expandedPresetId === preset.id;
                        const renaming = renamingPresetId === preset.id;
                        const subAgents = preset.policy.childAgents.targets;
                        const providers = [...new Set(subAgents.map((target) => providerDisplayName(target.provider)))];
                        const name = preset.name.trim() || `preset ${index + 1}`;
                        return (
                          <article key={preset.id} className={`preset-card ${expanded ? "expanded" : ""}`}>
                            <div className="preset-card-head">
                              {renaming ? (
                                <div className="preset-card-rename">
                                <input
                                  autoFocus
                                  aria-label={`Name for preset ${index + 1}`}
                                  value={preset.name}
                                  maxLength={60}
                                  placeholder="Name this preset"
                                  onChange={(event) => updatePreset(preset.id, { name: event.target.value })}
                                  onBlur={() => setRenamingPresetId((current) => current === preset.id ? null : current)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") event.currentTarget.blur();
                                    if (event.key === "Escape") setRenamingPresetId(null);
                                  }}
                                />
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="preset-card-disclosure"
                                  aria-expanded={expanded}
                                  aria-controls={`${subagentPanelId}-preset-${preset.id}`}
                                  aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
                                  onClick={() => setExpandedPresetId(expanded ? null : preset.id)}
                                >
                                  <span className="preset-card-copy">
                                    <strong>{preset.name || "Untitled preset"}</strong>
                                    <small>
                                      {subAgents.length} configured · {preset.policy.maxConcurrent} at a time
                                      {providers.length ? ` · ${providers.join(", ")}` : ""}
                                      {preset.policy.enabled ? "" : " · delegation off"}
                                    </small>
                                  </span>
                                  <ChevronRight className="preset-card-caret" size={15} aria-hidden="true" />
                                </button>
                              )}
                              <div className="preset-card-actions">
                                <button
                                  type="button"
                                  className="icon-button preset-rename-button"
                                  aria-label={renaming ? `Finish renaming ${name}` : `Rename ${name}`}
                                  title={renaming ? "Finish renaming" : "Rename preset"}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => setRenamingPresetId(renaming ? null : preset.id)}
                                >{renaming ? <Check size={13} /> : <Pencil size={13} />}</button>
                                <div className="preset-apply-menu">
                                  <AppSelectMenu portal
                                    value=""
                                    options={presetDestinationOptions}
                                    ariaLabel={`Apply ${name}`}
                                    placeholder="Apply"
                                    menuPlacement="top"
                                    onChange={(action) => runPresetDestinationAction(preset, action)}
                                  />
                                </div>
                                <button
                                  type="button"
                                  className="icon-button preset-delete-button"
                                  aria-label={`Delete ${name}`}
                                  onClick={() => removePreset(preset.id)}
                                ><Trash2 size={13} /></button>
                              </div>
                            </div>
                            <div
                              id={`${subagentPanelId}-preset-${preset.id}`}
                              className={`preset-card-body ${expanded ? "open" : ""}`}
                              aria-hidden={!expanded || undefined}
                              inert={!expanded ? true : undefined}
                            >
                              <div className="preset-card-editor">
                                <SubagentPolicyEditor
                                  policy={preset.policy}
                                  readiness={childAgentReadiness}
                                  disabled={false}
                                  modelCatalogs={subAgentModelCatalogs}
                                  modelFavorites={modelFavorites}
                                  onToggleModelFavorite={onToggleModelFavorite}
                                  onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
                                  onChange={(policy) => updatePreset(preset.id, { policy })}
                                />
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : !creatingPreset ? (
                    <EmptyState title="No presets yet" detail="Save a group of sub-agents once, then apply it to any thread or project." />
                  ) : null}
            </div>

            <div className="set-group" id="subagents-guidance">
              <div className="set-group-head">
                <h4 tabIndex={-1}>Model guidance</h4>
                {(local.subagentModelGuidance ?? []).length >= MAX_SUBAGENT_MODEL_GUIDANCE - 5 && <span className="set-group-note">{(local.subagentModelGuidance ?? []).length} of {MAX_SUBAGENT_MODEL_GUIDANCE}</span>}
                {/* Section actions sit at the head's right, like Create preset. */}
                <button type="button" className="secondary-button"
                  disabled={(local.subagentModelGuidance ?? []).length >= MAX_SUBAGENT_MODEL_GUIDANCE || Boolean(guidanceDraft && guidanceDraft.index === null)}
                  onClick={() => guidanceAddRef.current?.()}><Plus size={12} aria-hidden="true" /> Add model</button>
              </div>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong>When to use each model</strong>
                    <small>Notes that help parent agents choose a model from their crew. <SettingInfo label="About model guidance">Notes are suggestions only. They never add sub-agents and don&rsquo;t affect native Claude Code and Codex CLI sub-agents.</SettingInfo></small>
                  </div>
                </div>
                <div className="set-body model-guidance-body">
                  <SubagentModelGuidanceEditor
                    addRef={guidanceAddRef}
                    value={local.subagentModelGuidance ?? []}
                    draft={guidanceDraft}
                    onDraftChange={setGuidanceDraft}
                    modelCatalogs={subAgentModelCatalogs}
                    modelFavorites={modelFavorites}
                    onToggleModelFavorite={onToggleModelFavorite}
                    onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
                    onChange={(subagentModelGuidance) => setLocal((current) => ({ ...current, subagentModelGuidance }))}
                  />
                </div>
              </div>
            </div>

            <div className="set-group" id="subagents-behavior">
              <h4 tabIndex={-1}>Behavior</h4>
              <div className="set-card">
                <div className="set-row terminal-timeout-row">
                  <div className="set-copy">
                    <strong>Automatic follow-ups</strong>
                    <small id={`${followUpLimitId}-help`}>How many times a parent agent can continue on its own before pausing. <SettingInfo label="How automatic follow-ups work">Applies to managed parents on this computer. Each follow-up uses your plan or credits like any model turn. Saved changes apply to the next automatic follow-up. Choose &ldquo;Continue with&rdquo; to resume a paused run with a fresh count.</SettingInfo></small>
                  </div>
                  <div className="set-control">
                    <AppSelectMenu
                      ariaLabel={`Automatic follow-up limit, ${followUpLimited ? "Limited" : "Unlimited"}`}
                      value={followUpLimited ? "limited" : "unlimited"}
                      portal
                      options={[
                        { value: "limited", label: "Limited", detail: "Pause after a set number" },
                        { value: "unlimited", label: "Unlimited", detail: "No count limit" },
                      ]}
                      onChange={(value) => setFollowUpLimitUnlimited(value === "unlimited")}
                    />
                  </div>
                  {followUpLimited ? (
                    <div className="terminal-timeout-detail">
                      <label id={`${followUpLimitId}-label`} htmlFor={`${followUpLimitId}-count`}>Limit</label>
                      <input
                        ref={scrollableNumberInputRef}
                        id={`${followUpLimitId}-count`}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_PARENT_FOLLOW_UP_LIMIT}
                        step={1}
                        autoComplete="off"
                        aria-labelledby={`${followUpLimitId}-label ${followUpLimitId}-unit`}
                        aria-describedby={`${followUpLimitId}-help${followUpLimitInvalid ? ` ${followUpLimitId}-error` : ""}`}
                        aria-invalid={followUpLimitInvalid}
                        value={followUpLimitText ?? String(followUpLimit)}
                        onChange={(event) => editFollowUpLimit(event.target.value)}
                        onBlur={() => { if (!followUpLimitInvalid) setFollowUpLimitText(null); }}
                      />
                      <span id={`${followUpLimitId}-unit`}>follow-ups before pausing</span>
                      {followUpLimitInvalid && <p id={`${followUpLimitId}-error`} className="terminal-timeout-error" role="alert">
                        Enter a whole number from 1 to {MAX_PARENT_FOLLOW_UP_LIMIT.toLocaleString()}, or choose Unlimited.
                      </p>}
                    </div>
                  ) : <p className="terminal-timeout-detail">Other pause rules still apply.</p>}
                </div>
<div className="set-row">
                <div className="set-copy">
                  <strong>Archive sub-agent threads automatically</strong>
                  <small>Moves finished sub-agent threads to Archived once their parent is done. <SettingInfo label="When sub-agent threads are archived">V2 assignments also need sign-off from the parent or you. Active work and pending guidance stay visible.</SettingInfo></small>
                </div>
                <div className="set-control">
                  <Switch checked={local.autoArchiveSubagentThreads} label="Archive sub-agent threads automatically" onChange={() => setLocal({ ...local, autoArchiveSubagentThreads: !local.autoArchiveSubagentThreads })} />
                </div>
              </div>              </div>
            </div>

            <CustomAgentsSettings sectionId="subagents-custom" agents={agents} onAgents={onAgents} drafts={harnessDrafts} onDrafts={setHarnessDrafts} />

            <div className="set-group" id="subagents-preview">
              <h4 tabIndex={-1}>Preview features</h4>
              <div className="set-card">
                {/* The switch stays level with the title, and nothing here appears
                    or disappears when it is flipped, so the row never moves. */}
                <div className="set-row set-row-top">
                  <div className="set-copy">
                    <strong className="subagent-preview-heading">Mythra Code sub-agents V2 <span className="subagent-preview-badge">Preview</span></strong>
                    <small id={`${managedSubagentV2Id}-help`}>Lets parents and sub-agents message each other while work continues. Native Claude Code and Codex CLI sub-agents aren&rsquo;t affected.</small>
                    {managedSubagentV2LockedReason && <p className="subagent-preview-lock" id={`${managedSubagentV2Id}-lock`} role="status"><Info size={13} aria-hidden="true" /><span>{managedSubagentV2LockedReason}</span></p>}
                    {managedSubagentV2DraftLocked && <>
                      <small id={`${managedSubagentV2Id}-draft`}>Waiting to switch V2 {local.managedSubagentV2 === true ? "on" : "off"}. It stays {settings.managedSubagentV2 === true ? "on" : "off"} until the current work allows the change.</small>
                      <button type="button" className="secondary-button subagent-preview-keep-current" aria-describedby={`${managedSubagentV2Id}-draft`} onClick={() => setLocal((draft) => ({ ...draft, managedSubagentV2: settings.managedSubagentV2 === true }))}>Keep current workflow</button>
                    </>}
                  </div>
                  <div className="set-control">
                    <Switch checked={local.managedSubagentV2 === true} label="Mythra Code sub-agents V2" describedBy={`${managedSubagentV2Id}-help${managedSubagentV2LockedReason ? ` ${managedSubagentV2Id}-lock` : ""}${managedSubagentV2DraftLocked ? ` ${managedSubagentV2Id}-draft` : ""}`} disabled={Boolean(managedSubagentV2LockedReason)} className="subagent-preview-toggle" onChange={() => setLocal((draft) => ({ ...draft, managedSubagentV2: draft.managedSubagentV2 !== true }))} />
                  </div>
                </div>
              </div>
            </div>

          </section>}

          {settingsSection === "models" &&
          <section className="settings-section">
            <div className="set-group">
              <h4>Accounts</h4>
            <div className="account-list" role="list">
              {accountRows.map((row) => {
                const expanded = accountExpanded && accountProvider === row.id;
                return (
                  <div key={row.id} className={`account-row${expanded ? " expanded" : ""}`} role="listitem">
                    <div className="account-row-head">
                      <button type="button" id={`account-toggle-${row.id}`} className="account-row-toggle" aria-expanded={expanded} aria-controls={`account-detail-${row.id}`} onClick={() => toggleAccount(row.id)}>
                        {row.logo}
                        <span className="account-row-copy"><strong>{row.name}</strong><small>{row.detail}</small></span>
                        {/* A row offering its own action needs no "not connected" tag. */}
                        {(expanded || !row.action) && row.status}
                      </button>
                      {!expanded && row.action && <div className="account-row-action">{row.action}</div>}
                      <ChevronRight className="account-row-chevron" size={14} aria-hidden="true" />
                    </div>
                    {/* Grows open and shrinks shut; the content stays in place while it
                        closes, then is hidden (and is inert from the moment it starts leaving). */}
                    <SmoothDisclosure open={expanded} animate={accountMotion} id={`account-detail-${row.id}`} role="region" labelledBy={`account-toggle-${row.id}`} className="account-row-disclosure">
                    <div className="account-row-detail">
                      {/* Opening an account never edits the defaults; switching is its own action. */}
                      <div className="account-default-line">
                        {local.provider === row.id
                          ? <span className="account-default-tag"><Check size={12} aria-hidden="true" />Default for new threads</span>
                          : <>
                            <small>New threads use {TITLE_PROVIDER_LABELS[local.provider]}.</small>
                            <button type="button" className="secondary-button" onClick={() => setLocal((current) => settingsWithDefaultProvider(current, row.id, lmStudioModels[0]?.id))}>Use {row.name} as default</button>
                          </>}
                      </div>
                      {mountedAccounts.includes(row.id) && accountDetail(row.id)}
                    </div>
                    </SmoothDisclosure>
                  </div>
                );
              })}
            </div>

            </div>
            <div className="set-group">
              <h4>Defaults for new threads</h4>
              <p>New threads start with this provider and model. Existing threads keep theirs.</p>
              <div className="set-card"><div className="set-row stack default-model-picker">
              <div className="set-control">
              <div className="project-default-grid">
              <div className="project-default-field">
                <span>Default provider</span>
                <AppSelectMenu value={local.provider} options={PROJECT_PROVIDER_OPTIONS} ariaLabel="Default provider" menuPlacement="top" portal onChange={(provider) => setLocal((current) => settingsWithDefaultProvider(current, provider as Provider, lmStudioModels[0]?.id))} />
              </div>
              <div className="project-default-field project-default-model">
              <span>Default model</span>
              <AppSelectMenu
                key={local.provider}
                value={displayedDefaultModel}
                options={defaultModelOptions}
                selectedDisplay={defaultModelSelectedDisplay}
                ariaLabel={`Default ${local.provider === "openai" ? "OpenAI" : local.provider === "openrouter" ? "OpenRouter" : local.provider === "lmstudio" ? "LM Studio" : local.provider === "claude" ? "Claude" : "Cursor"} model`}
                placeholder="Choose a default model"
                searchable={defaultModelOptions.length > 8 || local.provider === "openrouter" || local.provider === "lmstudio" || local.provider === "cursor"}
                menuPlacement="top"
                portal
                favorites={favoriteModels(modelFavorites, local.provider)}
                {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(local.provider, model) } : {})}
                {...(local.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})}
                emptyMessage={local.provider === "lmstudio" ? "Connect LM Studio and refresh its catalog first." : "No models are currently available for this provider."}
                onChange={(model) => setLocal((current) => ({ ...current, model, defaultModelExplicit: true }))}
              />
              </div>
              </div>
              {local.provider === "claude" && !claudeModels.length
                ? <div className="settings-notice" role="status"><Info size={13} /><span>Showing Mythra Code’s built-in Claude list because the Claude Code catalog could not be read.</span><button type="button" className="secondary-button" onClick={() => void onClaudeRefresh()}>Retry</button></div>
                : <small className="set-control-help">{defaultModelHelp}</small>}
              </div>
              </div></div>
            </div>
            <div className="set-group">
              <h4>Model options</h4>
              <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>OpenAI speed</strong>
                  <small>The default for the composer’s Fast switch. Fast uses OpenAI Priority processing, which may cost more or use limits faster.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu portal value={local.serviceTier ?? ""} options={SERVICE_TIER_OPTIONS} ariaLabel="OpenAI speed" onChange={(value) => setLocal({ ...local, serviceTier: value || null })} />
                </div>
              </div>
                <div className="set-row">
                <div className="set-copy">
                  <strong>Warn before using Max reasoning</strong>
                  <small id={maxReasoningWarningId}>Ask before choosing Max, which can use far more of your allowance.</small>
                </div>
                <div className="set-control">
                <Switch checked={local.warnOnMaxReasoning !== false} label="Warn before using Max reasoning" describedBy={maxReasoningWarningId} onChange={() => setLocal((current) => ({ ...current, warnOnMaxReasoning: current.warnOnMaxReasoning === false }))} />
                </div>
              </div>
              </div>
            </div>
          </section>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function GitHubSettings({
  status,
  busy,
  loginPending,
  signInError,
  cloneUrl,
  cloneParent,
  onCloneUrl,
  onCloneParent,
  onSignIn,
  onRefresh,
  onClone,
}: {
  status: GitHubAccountStatus | null;
  busy: boolean;
  loginPending: boolean;
  signInError: string;
  cloneUrl: string;
  cloneParent: string;
  onCloneUrl: (value: string) => void;
  onCloneParent: (value: string) => void;
  onSignIn: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClone: () => Promise<void>;
}) {
  const [choosing, setChoosing] = useState(false);
  const choosingRef = useRef(false);
  const [folderError, setFolderError] = useState("");
  const [startingSignIn, setStartingSignIn] = useState(false);
  const startingSignInRef = useRef(false);
  const [signInRequested, setSignInRequested] = useState(false);
  const [localSignInError, setLocalSignInError] = useState("");
  const [commandCopied, setCommandCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const loginCommand = "gh auth login --hostname github.com";
  const loginError = signInError || localSignInError;
  const accountBusy = busy || startingSignIn;
  const showLoginHelp = !status?.authenticated && (signInRequested || loginPending || Boolean(loginError));
  useEffect(() => {
    if (!status?.authenticated) return;
    setSignInRequested(false);
    setLocalSignInError("");
    setCommandCopied(false);
    setCopyError("");
  }, [status?.authenticated]);
  const signIn = async () => {
    if (accountBusy || loginPending || startingSignInRef.current) return;
    startingSignInRef.current = true;
    setStartingSignIn(true);
    setSignInRequested(true);
    setLocalSignInError("");
    setCommandCopied(false);
    setCopyError("");
    try {
      await onSignIn();
    } catch (error) {
      // These are GitHub/terminal errors, not model-runtime failures.
      setLocalSignInError(formatGitError(error));
    } finally {
      startingSignInRef.current = false;
      setStartingSignIn(false);
    }
  };
  const copyLoginCommand = async () => {
    setCommandCopied(false);
    setCopyError("");
    try {
      await navigator.clipboard.writeText(loginCommand);
      setCommandCopied(true);
    } catch {
      setCopyError("Could not copy the command. Select it above and copy it manually.");
    }
  };
  const refresh = async () => {
    try { await onRefresh(); } catch (error) {
      setLocalSignInError(formatGitError(error));
    }
  };
  const target = parseGitHubCloneTarget(cloneUrl);
  const chooseParent = async () => {
    if (choosingRef.current || busy) return;
    choosingRef.current = true;
    setChoosing(true);
    setFolderError("");
    try {
      const selected = await openFolderDialog({ directory: true, multiple: false, title: "Choose parent folder — a new repository folder will be created inside", ...(cloneParent ? { defaultPath: cloneParent } : {}) });
      if (typeof selected === "string" && selected) onCloneParent(selected);
    } catch (error) {
      setFolderError(friendlyError(error));
    } finally {
      choosingRef.current = false;
      setChoosing(false);
    }
  };
  const clone = async () => {
    setFolderError("");
    try { await onClone(); } catch (error) { setFolderError(formatGitError(error)); }
  };
  return <>
    <section className="set-group">
      <h4>GitHub account</h4>
      <p>Signs in through the official GitHub CLI. <SettingInfo label="How GitHub access works">Mythra Code never puts your GitHub token into prompts or project files. Agents with command access can still run credential-aware CLI tools, so use the same care you would in a terminal.</SettingInfo></p>
      <div className="credential-panel github-account-panel">
        <span className="github-avatar-placeholder"><GitFork size={18} /></span>
        <div>
          <strong>{status?.authenticated ? status.name || status.login || "GitHub account" : status?.available ? status.error ? "GitHub account needs attention" : "GitHub is ready to connect" : "GitHub CLI is required"}</strong>
          <small role={!status?.authenticated && status?.error ? "alert" : undefined}>{status?.authenticated ? `@${status.login}${status.email ? ` · ${status.email}` : ""}` : status?.error || (status?.available ? "Sign in to GitHub to connect Mythra Code." : "Install GitHub CLI to connect repositories.")}</small>
        </div>
        {status?.authenticated ? (
          <span className="provider-status on">Connected</span>
        ) : status?.available ? (
          <button className="secondary-button" onClick={() => void signIn()} disabled={accountBusy || loginPending}>
            {accountBusy ? <LoaderCircle className="spin" size={14} /> : <GitFork size={14} />} {loginPending ? "Awaiting sign-in" : loginError ? "Retry sign-in" : "Sign in"}
          </button>
        ) : (
          <button className="secondary-button" onClick={() => void openUrl("https://cli.github.com/")}><ExternalLink size={13} /> Install GitHub CLI</button>
        )}
        <button className="icon-button" onClick={() => void refresh()} disabled={accountBusy} aria-busy={accountBusy} title="Refresh GitHub status" aria-label="Refresh GitHub status"><RotateCcw size={14} className={accountBusy ? "spin" : undefined} /></button>
      </div>
      {showLoginHelp && <div className="set-card"><div className="set-body">
        {loginError && <p className="github-clone-error" role="alert">{loginError}</p>}
        <p>{loginPending || (signInRequested && !loginError) ? "Finish GitHub sign-in in your terminal. If it did not open, run this command in a terminal or PowerShell:" : "Run this command in a terminal or PowerShell and follow GitHub’s sign-in prompts:"}</p>
        <p><code>{loginCommand}</code></p>
        <button type="button" className="secondary-button" onClick={() => void copyLoginCommand()} aria-label="Copy GitHub login command"><Copy size={13} /> Copy command</button>
        {commandCopied && <p role="status">Command copied</p>}
        {copyError && <p className="github-clone-error" role="alert">{copyError}</p>}
        <p>After signing in, choose Refresh GitHub status above to connect Mythra Code.</p>
      </div></div>}
    </section>
    <section className="set-group">
      <h4>Clone a repository</h4>
      <p>Download a repository and add it as a project.</p>
      <div className="set-card"><div className="set-body">
      <div className="github-clone-grid">
        <label className="field-label"><span>Repository URL</span><input value={cloneUrl} disabled={busy || choosing} onChange={(event) => { setFolderError(""); onCloneUrl(event.target.value); }} placeholder="https://github.com/owner/repository.git" aria-describedby="github-clone-url-help" aria-invalid={Boolean(cloneUrl.trim() && !target)} /></label>
        <div className="field-label github-clone-parent-field">
          <span>Parent folder</span>
          <div className="github-clone-location">
          <button type="button" className="secondary-button" onClick={() => void chooseParent()} disabled={busy || choosing} aria-describedby={cloneParent ? "github-clone-parent" : "github-clone-url-help"}>
            {choosing ? <LoaderCircle size={15} className="spin" /> : <FolderCog size={15} />}{cloneParent ? "Change parent folder…" : "Choose parent folder…"}
          </button>
          {cloneParent && <span id="github-clone-parent" className="github-clone-path" role="status">{cloneParent}</span>}
          </div>
        </div>
      </div>
      <p id="github-clone-url-help" className="github-clone-hint" role="status">{cloneUrl.trim() && !target ? "Enter a GitHub repository URL with a folder name supported on macOS and Windows." : "A new folder named after the repository is created inside it. Existing folders are never overwritten."}</p>
      {target && cloneParent && <p id="github-clone-destination" className="github-clone-destination" role="status"><strong>Clone into</strong>{" "}<span className="github-clone-path">{joinPath(cloneParent, target.name)}</span></p>}
      {folderError && <p className="github-clone-error" role="alert">{folderError}</p>}
      <button type="button" className="primary-button" disabled={!status?.authenticated || busy || choosing || !target || !cloneParent} aria-describedby={target && cloneParent ? "github-clone-destination" : "github-clone-url-help"} onClick={() => void clone()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} Clone repository</button>
      </div></div>
    </section>
  </>;
}

const USAGE_DISPLAY_OPTIONS: ReadonlyArray<{ id: UsageDisplayMode; label: string }> = [
  { id: "remaining", label: "Remaining" },
  { id: "consumed", label: "Used" },
];

function UsageDisplaySettings({ value, onChange }: { value: UsageDisplayMode; onChange: (value: UsageDisplayMode) => void }) {
  return <section className="set-group">
    <h4>Quota display</h4>
    <div className="set-card"><div className="set-row">
      <div className="set-copy">
        <strong>Read limits as</strong>
        <small id="usage-display-help">How subscription limits are shown everywhere a live quota appears. <span className="usage-display-preview"><Gauge size={12} aria-hidden="true" />Example: 5h window {usagePercentLabel(42, value)}</span></small>
      </div>
      <div className="set-control">
        {/* Rendered through the same helper the live cards use, so the example
            can never describe a format the app does not actually produce. */}
        <div className="settings-segmented" role="radiogroup" aria-label="Read limits as" aria-describedby="usage-display-help" onKeyDown={rovingChoiceKeyDown}>
          {USAGE_DISPLAY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={value === option.id}
              tabIndex={value === option.id ? 0 : -1}
              className={value === option.id ? "selected" : ""}
              onClick={() => onChange(option.id)}
            >{option.label}</button>
          ))}
        </div>
      </div>
    </div></div>
  </section>;
}

function ProjectDefaultsSettings({ active, projects, activeProjectId, settings, runtimeModels, claudeModels, cursorModels, openRouterModels, lmStudioModels, modelFavorites, onToggleModelFavorite, onDiscoverOpenRouterModels, onProjects, onThemePreview, onEffortSliderPreview, onChatFontPreview }: {
  active: boolean;
  projects: Project[];
  activeProjectId: string | null;
  settings: AppSettings;
  runtimeModels: RuntimeModel[];
  claudeModels: ClaudeModel[];
  cursorModels: CursorModel[];
  openRouterModels: OpenRouterModel[];
  lmStudioModels: LMStudioModel[];
  modelFavorites: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onProjects: (value: Project[]) => void;
  onThemePreview: (theme: ThemeName) => void;
  onEffortSliderPreview: (style: EffortSliderStyle) => void;
  onChatFontPreview: (font: ChatFont) => void;
}) {
  const customFonts = useCustomFonts();
  useCustomFontFaces(customFonts, active);
  const [projectToAdd, setProjectToAdd] = useState("");
  const configured = projects.filter((project) => project.overrides?.defaults);
  const available = projects.filter((project) => !project.overrides?.defaults);
  const catalogs = { runtimeModels, claudeModels, cursorModels, openRouterModels, lmStudioModels };
  const projectOptions = available.map((project) => ({
    value: project.id,
    label: project.name,
    detail: project.path,
    icon: <FolderCog size={14} />,
  }));
  const themeOptions: AppSelectOption[] = [
    { value: "", label: "Use global theme", detail: THEMES.find((theme) => theme.id === settings.theme)?.name ?? settings.theme, icon: <Palette size={14} /> },
    ...THEMES.map((theme) => ({
      value: theme.id,
      label: theme.name,
      detail: theme.description,
      icon: <span className="project-theme-swatch" style={{ background: theme.swatches[0] }}><i style={{ background: theme.swatches[2] }} /></span>,
    })),
  ];
  const effortOptions: AppSelectOption[] = [
    { value: "", label: "Use global slider", detail: EFFORT_SLIDER_STYLES.find((style) => style.id === settings.effortSlider)?.name ?? settings.effortSlider, icon: <RotateCcw size={14} /> },
    ...EFFORT_SLIDER_STYLES.map((style) => ({
      value: style.id,
      label: style.name,
      detail: style.description,
      icon: <span className={`project-effort-swatch ${style.id}`}><i /><b /></span>,
    })),
  ];
  const fontOptions: AppSelectOption[] = [
    { value: "", label: "Use global font", detail: chatFontName(settings.chatFont, customFonts), icon: <RotateCcw size={14} /> },
    ...chatFontOptions(customFonts),
  ];

  const updateDefaults = (id: string, update: (defaults: ProjectDefaults) => ProjectDefaults) => {
    onProjects(projects.map((project) => {
      const defaults = project.overrides?.defaults;
      if (project.id !== id || !defaults) return project;
      return { ...project, overrides: { ...(project.overrides ?? {}), defaults: update(defaults) } };
    }));
  };
  const addProject = () => {
    const project = projects.find((entry) => entry.id === projectToAdd && !entry.overrides?.defaults);
    if (!project) return;
    const modelOptions = modelOptionsForProvider(settings.provider, settings.model, catalogs);
    const model = modelOptions.find((option) => option.value === settings.model && !option.disabled)?.value
      ?? modelOptions.find((option) => !option.disabled)?.value
      ?? "";
    onProjects(projects.map((entry) => entry.id === project.id
      ? { ...entry, overrides: { ...(entry.overrides ?? {}), defaults: { provider: settings.provider, model } } }
      : entry));
    setProjectToAdd("");
  };
  const removeProject = async (project: Project) => {
    if (!await confirmDialog(`Remove the project-specific defaults for “${project.name}”? The project itself stays in Mythra Code.`, { confirmLabel: "Remove overrides" })) return;
    onProjects(projects.map((entry) => {
      if (entry.id !== project.id || !entry.overrides?.defaults) return entry;
      const overrides = { ...(entry.overrides ?? {}) };
      delete overrides.defaults;
      return { ...entry, overrides: Object.keys(overrides).length ? overrides : undefined };
    }));
    if (project.id === activeProjectId) {
      onThemePreview(settings.theme);
      onEffortSliderPreview(settings.effortSlider);
      onChatFontPreview(settings.chatFont);
    }
  };

  return (
    <section className="set-group project-defaults-settings">
      <h4>Project overrides</h4>
      <p>Overrides replace the app defaults for one project&rsquo;s new threads: provider, model and look. Anything not set here follows the app. <SettingInfo label="Other project settings">Sub-agent overrides live in Sub-agents → Defaults. Project instructions open from the &hellip; menu in the top bar.</SettingInfo></p>
      {!projects.length && <EmptyState icon={FolderCog} title="No projects yet" detail="Add one from the sidebar to give it its own defaults." />}

      {!projects.length ? null : configured.length ? <div className="project-default-list">{configured.map((project) => {
        const defaults = project.overrides!.defaults!;
        // A removed per-device font uses the interface fallback while retaining
        // the stored override until the user explicitly chooses a replacement.
        const selectedFont = defaults.chatFont && !fontOptions.some((option) => option.value === defaults.chatFont) ? "system" : defaults.chatFont ?? "";
        const modelOptions = modelOptionsForProvider(defaults.provider, defaults.model, catalogs);
        const selectedDisplay = savedClaudeModelDisplay(defaults.provider, defaults.model, catalogs);
        const setProvider = (provider: Provider) => {
          const options = modelOptionsForProvider(provider, "", catalogs);
          const model = provider === defaults.provider
            ? defaults.model
            : (options.find((option) => !option.disabled)?.value ?? "");
          updateDefaults(project.id, (current) => ({ ...current, provider, model }));
        };
        return (
          <article className="project-default-card" key={project.id}>
            <div className="project-default-card-head">
              <span><strong>{project.name} <em className="project-default-badge">Overrides</em></strong><small>{project.path}</small></span>
              <button type="button" className="icon-button project-default-remove" aria-label={`Remove overrides for ${project.name}`} title="Remove project overrides; the project follows the app defaults again" onClick={() => void removeProject(project)}><Trash2 size={13} /></button>
            </div>
            <div className="project-default-grid">
              <div className="project-default-field"><span>Provider</span><AppSelectMenu value={defaults.provider} options={PROJECT_PROVIDER_OPTIONS} ariaLabel={`Default provider for ${project.name}`} menuPlacement="top" onChange={(value) => setProvider(value as Provider)} /></div>
              <div className="project-default-field project-default-model"><span>Model</span><AppSelectMenu value={defaults.model} options={modelOptions} selectedDisplay={selectedDisplay} ariaLabel={`Default model for ${project.name}`} placeholder="Choose a model…" searchable={modelOptions.length > 8 || defaults.provider === "openrouter" || defaults.provider === "lmstudio" || defaults.provider === "cursor"} menuPlacement="top" favorites={favoriteModels(modelFavorites, defaults.provider)} {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(defaults.provider, model) } : {})} {...(defaults.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})} emptyMessage={defaults.provider === "lmstudio" ? "Connect LM Studio and refresh its catalog first." : "No models are currently available for this provider."} onChange={(model) => updateDefaults(project.id, (current) => ({ ...current, model }))} /></div>
              <div className="project-default-field"><span>App theme</span><AppSelectMenu value={defaults.theme ?? ""} options={themeOptions} ariaLabel={`App theme for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.theme = value as ThemeName; else delete next.theme; return next; }); if (project.id === activeProjectId) onThemePreview((value || settings.theme) as ThemeName); }} /></div>
              <div className="project-default-field"><span>Effort slider</span><AppSelectMenu value={defaults.effortSlider ?? ""} options={effortOptions} ariaLabel={`Effort slider for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.effortSlider = value as EffortSliderStyle; else delete next.effortSlider; return next; }); if (project.id === activeProjectId) onEffortSliderPreview((value || settings.effortSlider) as EffortSliderStyle); }} /></div>
              <div className="project-default-field"><span>Chat font</span><AppSelectMenu value={selectedFont} options={fontOptions} ariaLabel={`Chat font for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.chatFont = value as ChatFont; else delete next.chatFont; return next; }); if (project.id === activeProjectId) onChatFontPreview((value || settings.chatFont) as ChatFont); }} /></div>
            </div>
            {!defaults.model && <p className="project-default-warning" role="alert">Choose a model so these project overrides can be saved.</p>}
          </article>
        );
      })}</div> : null}

      {projects.length > 0 && <div className="project-default-add">
        {/* M11 (round 6): with no overrides yet, this one row is both the
            empty state and its next action (no separate "nothing here" card). */}
        <div className="project-default-field"><span>{configured.length ? "Choose a project" : "No overrides yet · every project uses the app defaults. Choose one to change that."}</span><AppSelectMenu value={projectToAdd} options={projectOptions} ariaLabel="Project to configure" placeholder={projects.length ? "Choose a project…" : "No projects available"} searchable={projectOptions.length > 8} menuPlacement="top" emptyMessage="Every existing project already has overrides." onChange={setProjectToAdd} /></div>
        <button type="button" className="secondary-button" onClick={addProject} disabled={!projectToAdd}><Plus size={12} /> Add project overrides</button>
      </div>}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Automatic thread titles
 *
 * One tiny turn on whichever provider the person picks, so the naming does
 * not drag a second subscription into a workspace that already has one it
 * likes. Everything here edits the settings draft and nothing else: no
 * catalog is fetched, no provider is contacted, and no account is required
 * before the choice can be made.
 * ------------------------------------------------------------------ */


const TITLE_PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  claude: "Claude",
  cursor: "Cursor",
  openrouter: "OpenRouter",
  lmstudio: "LM Studio",
};

/** Whether the *chosen* provider is connected. Picking Claude here must never
 *  turn into a demand to sign into OpenAI. */
function titleProviderReady(provider: Provider, readiness: ChildAgentReadiness): boolean {
  if (provider === "openai") return readiness.openAiSignedIn;
  if (provider === "claude") return readiness.claudeReady;
  if (provider === "cursor") return readiness.cursorReady;
  if (provider === "openrouter") return readiness.openRouterReady;
  // LM Studio does not always report readiness, and an unreported answer is no
  // reason to tell someone their local server is missing.
  return readiness.lmStudioReady !== false;
}

function ThreadTitleFields({ settings, catalogs, readiness, onChange, onAccounts }: {
  settings: AppSettings;
  catalogs: ModelCatalogs;
  readiness: ChildAgentReadiness;
  onChange: (settings: AppSettings) => void;
  onAccounts: () => void;
}) {
  const provider = settings.threadTitleProvider;
  const model = settings.threadTitleModel;
  const catalog = modelOptionsForProvider(provider, model, catalogs);
  const lunaId = resolveThreadTitleModel("openai", "", { openai: catalogs.runtimeModels.map((entry) => ({ id: entry.id, label: entry.id })) });
  const luna = provider === "openai" && lunaId ? { id: lunaId, fromCatalog: catalogs.runtimeModels.length > 0 } : null;
  const hasCatalog = modelOptionsForProvider(provider, "", catalogs).length > 0;
  // Only OpenAI has a sensible default that needs no choosing. Everywhere else
  // an empty model means nothing to run, so the blank option does not exist.
  const options: AppSelectOption[] = provider === "openai"
    ? [{
        value: "",
        label: "Luna (automatic)",
        // Display names only; raw model ids stay out of the picker.
        detail: luna
          ? luna.fromCatalog
            ? `Newest in your account · ${catalog.find((entry) => entry.value === luna.id)?.label ?? "Luna"}`
            : "Newest Luna, once your models load"
          : "No Luna model in your account. Choose another",
        icon: <ProviderLogo provider="openai" size={15} />,
      }, ...catalog]
    : catalog;

  const ready = titleProviderReady(provider, readiness);
  const missingModel = provider !== "openai" && !model.trim();
  const noLuna = provider === "openai" && !model && !luna;

  const switchProvider = (next: Provider) => {
    if (next === provider) return;
    // The same rule project defaults use: land on something this provider can
    // actually run, rather than carrying another provider's model across.
    const fresh = modelOptionsForProvider(next, "", catalogs);
    const nextModel = next === "openai" ? "" : (fresh.find((option) => !option.disabled)?.value ?? "");
    onChange({ ...settings, threadTitleProvider: next, threadTitleModel: nextModel });
  };

  return (
    <div className="set-body thread-title-fields">
      <div className="field-label">
        <span>Title provider</span>
        <AppSelectMenu portal
          value={provider}
          options={PROJECT_PROVIDER_OPTIONS}
          ariaLabel="Thread title provider"
          menuPlacement="top"
          onChange={(value) => switchProvider(value as Provider)}
        />
      </div>
      <div className="field-label">
        <span>Title model</span>
        <AppSelectMenu portal
          value={model}
          options={options}
          ariaLabel="Thread title model"
          menuPlacement="top"
          placeholder="Choose a model…"
          searchable={options.length > 8 || provider === "openrouter" || provider === "lmstudio"}
          emptyMessage={provider === "lmstudio"
            ? "Connect LM Studio and refresh its catalog first."
            : "No models are currently available for this provider."}
          onChange={(value) => onChange({ ...settings, threadTitleModel: value })}
        />
      </div>
      {/* No catalog to choose from is not a dead end: the id can be typed, the
          way run-command discovery accepts one. */}
      {!hasCatalog && (
        <label className="field-label thread-title-id">
          <span>Model ID</span>
          <input
            aria-label="Thread title model ID"
            maxLength={160}
            value={model}
            placeholder="vendor/model-name"
            spellCheck={false}
            onChange={(event) => onChange({ ...settings, threadTitleModel: event.target.value })}
          />
        </label>
      )}
      {missingModel && <p className="thread-title-note">Choose a model, or new threads keep their usual names.</p>}
      {noLuna && <p className="thread-title-note">Your account catalog reports no Luna model. Choose one above, or new threads keep their usual names.</p>}
      {!ready && <p className="thread-title-note">{TITLE_PROVIDER_LABELS[provider]} is not connected yet, so new threads keep their usual names until it is.</p>}
      {(!ready || !hasCatalog) && (
        <button type="button" className="secondary-button thread-title-accounts" onClick={onAccounts}>Open Models &amp; accounts</button>
      )}
    </div>
  );
}

function RecentErrorsPanel({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!active) return;
    recentAuditRows(20, "ui.error")
      .then((result) => {
        setRows(result);
        setUnavailable(false);
      })
      .catch(() => setUnavailable(true));
  }, [active]);
  if (unavailable || !rows.length) return null;
  return (
    <div className="recent-errors">
      <h3 className="panel-label">Recent errors</h3>
      <div className="recent-errors-list">
        {rows.map((row) => {
          const message = typeof row.payload === "object" && row.payload !== null && "message" in row.payload
            ? String((row.payload as { message?: unknown }).message ?? "")
            : String(row.payload ?? "");
          return (
            <div key={row.id}>
              <small>{new Date(row.createdAt).toLocaleString()}</small>
              <span>{message || row.kind}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDiagnosticBytes(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function RecentPerformancePanel({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    if (!active) return;
    recentAuditRows(10, "performance.threadOpen")
      .then(setRows)
      .catch(() => setRows([]));
  }, [active]);
  if (!rows.length) return null;
  return (
    <div className="recent-errors recent-performance">
      <h3 className="panel-label">Recent thread opens</h3>
      <div className="recent-errors-list">
        {rows.map((row) => {
          const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
          const durations = payload.durationMs && typeof payload.durationMs === "object" ? payload.durationMs as Record<string, unknown> : {};
          const history = payload.history && typeof payload.history === "object" ? payload.history as Record<string, unknown> : {};
          const processMemory = payload.processMemory && typeof payload.processMemory === "object" ? payload.processMemory as Record<string, unknown> : {};
          const transcriptCache = payload.transcriptCache && typeof payload.transcriptCache === "object" ? payload.transcriptCache as Record<string, unknown> : {};
          const timeline = finiteMetric(durations.timelineCommit);
          const ready = finiteMetric(durations.runtimeReady) ?? finiteMetric(durations.total);
          const bytes = formatDiagnosticBytes(finiteMetric(history.projectedBytes));
          const resident = formatDiagnosticBytes(finiteMetric(processMemory.managedProcessTreeResidentBytes));
          const cachedTranscriptBytes = formatDiagnosticBytes(finiteMetric(transcriptCache.estimatedBytes));
          const hydratedThreads = finiteMetric(transcriptCache.hydratedThreads);
          const summary = [
            String(payload.provider ?? "provider"),
            timeline === null ? null : `timeline ${Math.round(timeline)} ms`,
            ready === null ? null : `ready ${Math.round(ready)} ms`,
            bytes,
            cachedTranscriptBytes ? `${cachedTranscriptBytes} transcript cache${hydratedThreads === null ? "" : ` / ${Math.round(hydratedThreads)} threads`}` : null,
            resident ? `${resident} managed RSS` : null,
            payload.outcome && payload.outcome !== "completed" ? String(payload.outcome) : null,
          ].filter(Boolean).join(" · ");
          return <div key={row.id}><small>{new Date(row.createdAt).toLocaleString()}</small><span>{summary}</span></div>;
        })}
      </div>
    </div>
  );
}

function DeveloperRuntimeUpdateCard({
  target,
  name,
  status,
  updater,
}: {
  target: DeveloperRuntimeTarget;
  name: string;
  status: DeveloperRuntimeTargetStatus | null;
  updater: DeveloperRuntimeUpdater;
}) {
  const updating = updater.updating === target;
  const busy = updater.checking || updater.updating !== null;
  const stale = Boolean(status?.latestVersionStale || status?.installedVersionStale);
  const needsRestart = target === "codex" && Boolean(status?.restartRequired) && !status?.installedVersionStale;
  const installedCurrent = Boolean(status?.installed && status.currentVersion && status.latestVersion && !status.updateAvailable && !status.error && !stale);
  const provablyCurrent = installedCurrent && !status?.notice && !needsRestart;
  // A pending restart is not another available download. Otherwise users can
  // repeatedly reinstall an update that's already on disk without activating it.
  const actionAvailable = Boolean(status?.canUpdate && !installedCurrent);
  const state = status?.error || stale ? "unverified" : status?.updateAvailable || status?.installed === false ? "available" : "current";
  const detail = updating ? `Updating ${name}…`
    : updater.checking ? `Checking for ${name} updates…`
      : status?.error ? status.error
        : stale ? `Couldn’t refresh ${name} updates. Showing previously checked information.`
        : status?.installed === false ? `${name} is not installed. Install ${status.latestVersion ? `version ${status.latestVersion}` : "the latest version"} here.`
          : status?.updateAvailable ? `${name} ${status.latestVersion} is available.`
            : needsRestart ? "Mythra Code is still running a different Codex CLI version than the one installed."
            : provablyCurrent ? `${name} is up to date.`
              // M13: each component names its own state instead of
              // repeating the pane's "check for updates" instruction.
              : !status ? "Not checked yet."
                : status.installed && status.currentVersion && !status.latestVersion ? `Installed · latest release not checked yet.`
                  : status.installed && !status.currentVersion ? "Installed · version not reported."
                    : "Not checked yet.";
  // M11 (round 6): before the first check the pane's summary already says
  // "Not checked yet"; each runtime card doesn't repeat it.
  const unchecked = !status && !updating && !updater.checking;
  const actionLabel = status?.installed === false ? `Install ${name}` : `Update ${name}`;
  return <div className={`update-card developer-runtime-update-card ${state}`}>
    <div className="update-version-row">
      {/* Before the first check there is no version to report, so the card says
          so plainly instead of printing a name trailed by an ellipsis. */}
      <span><small>{status?.installedVersionStale ? "Previously detected" : status?.installed ? `Installed · ${status.source ?? "Local runtime"}` : "Local runtime"}</small><strong>{status?.currentVersion ? `${name} ${status.currentVersion}` : status?.installed === false ? `${name} · not installed` : name}</strong></span>
      {status?.latestVersion && <span className={`update-version-available${status.latestVersionStale ? " stale" : ""}`}><small>{status.latestVersionStale ? "Last known latest" : "Latest"}</small><strong>{status.latestVersion}</strong>{status.latestVersionStale && status.latestVersionCheckedAt && <small>Checked {new Date(status.latestVersionCheckedAt).toLocaleString()}</small>}</span>}
    </div>
    {!unchecked && <div className="update-status-row">
      {(updating || updater.checking) && <LoaderCircle className="spin" size={15} />}
      {!updating && !updater.checking && provablyCurrent && <Check size={15} />}
      {!updating && !updater.checking && (status?.error || stale) && <Info size={15} />}
      {!updating && !updater.checking && !status?.error && !stale && status?.updateAvailable && <Download size={15} />}
      <span>{detail}</span>
    </div>}
    {target === "codex" && status?.runningVersion && <div className="runtime-running-version">
      <span>{status.installedVersionStale ? "Previously running in Mythra Code" : "Running in Mythra Code"}</span>
      <strong>Codex CLI {status.runningVersion}</strong>
    </div>}
    {status?.notice && <div className="update-status-row runtime-activation-note"><Info size={15} /><span>{status.installedVersionStale ? `Previously reported: ${status.notice}` : status.notice}</span></div>}
    {needsRestart && !updater.checking && !updating && !status?.notice && <div className="update-status-row runtime-activation-note"><Info size={15} /><span>Finish active work, then restart Mythra Code to use the installed version. Nothing running will be interrupted automatically.</span></div>}
    {target === "claude" && status?.installed && !status.installedVersionStale && <p className="runtime-launch-note">New Mythra Code runs use the installed version. Claude Code already open in a terminal needs a separate restart.</p>}
    {(status?.path || status?.runningPath) && <details className="runtime-executable-paths">
      <summary className="set-disclosure"><ChevronRight size={13} aria-hidden="true" className="set-disclosure-chevron" />{status.installedVersionStale ? "Previously detected executable locations" : "Executable locations"}</summary>
      <dl>
        {status.path && <><dt>Installed</dt><dd title={status.path}>{status.path}</dd></>}
        {status.runningPath && <><dt>Running in Mythra Code</dt><dd title={status.runningPath}>{status.runningPath}</dd></>}
      </dl>
    </details>}
    {status && (!status.canUpdate || actionAvailable || status.error || stale) && (
      <div className="update-actions">
        {!status.canUpdate && <small>Mythra Code will not overwrite a custom executable path.</small>}
        {(status.error || stale) && <button className="secondary-button" disabled={busy} onClick={() => void updater.checkForUpdates()}><RotateCcw size={13} /> Try again</button>}
        {actionAvailable && (
        <button className="primary-button" disabled={busy} onClick={() => void updater.updateRuntime(target)}>
          {updating ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} {updating ? "Updating…" : actionLabel}
        </button>
        )}
      </div>
    )}
  </div>;
}

function UpdateSettings({ appUpdater, developerRuntimeUpdater, checkAll }: { appUpdater: AppUpdater; developerRuntimeUpdater: DeveloperRuntimeUpdater; checkAll: ReactNode }) {
  const progress = updateProgress(appUpdater.downloadedBytes, appUpdater.totalBytes);
  const busy = ["checking", "downloading", "installing", "restarting"].includes(appUpdater.phase);
  const detail = appUpdater.phase === "checking" ? "Checking GitHub Releases…"
    : appUpdater.phase === "current" ? "You have the newest available version."
      : appUpdater.phase === "available" ? `Version ${appUpdater.availableVersion} is available.`
        : appUpdater.phase === "downloading" ? (progress === null ? "Downloading the signed update…" : `Downloading the signed update… ${progress}%`)
          : appUpdater.phase === "installing" ? "Verifying and installing the update…"
            : appUpdater.phase === "restarting" ? "Update installed. Restarting Mythra Code…"
              : appUpdater.phase === "error" ? appUpdater.error || "The update could not be completed."
                : "Check the public Mythra Code repository for a newer signed release.";


  const runtimeStatus = developerRuntimeUpdater.status;
  const runtimeUpdate = Boolean(runtimeStatus?.claude.updateAvailable || runtimeStatus?.codex.updateAvailable);
  const summary = appUpdater.phase === "checking" || developerRuntimeUpdater.checking ? "Checking for updates…"
    : appUpdater.phase === "available" || runtimeUpdate ? "Updates are available"
      : appUpdater.phase === "current" && runtimeStatus && !runtimeStatus.claude.error && !runtimeStatus.codex.error ? "Everything is up to date"
        : "Not checked yet";
  return <section className="update-settings-section">
    <div className="update-overview">
      <span role="status">{summary}</span>
      {checkAll}
    </div>
    <div className="set-group">
    <div className="set-group-head"><h4>Mythra Code</h4></div>
    <div className={`update-card ${appUpdater.phase}`}>
      <div className="update-version-row">
        <span><small>{appUpdater.restartPending ? "Running" : "Installed"}</small><strong>Mythra Code {appUpdater.currentVersion}</strong></span>
        {appUpdater.availableVersion && <span className="update-version-available"><small>{appUpdater.restartPending ? "Installed" : "Available"}</small><strong>{appUpdater.availableVersion}</strong></span>}
      </div>
      <div className="update-status-row">
        {busy && <LoaderCircle className="spin" size={15} />}
        {!busy && appUpdater.phase === "current" && <Check size={15} />}
        {!busy && appUpdater.phase === "available" && <Download size={15} />}
        <span>{detail}</span>
      </div>
      {(appUpdater.phase === "downloading" || appUpdater.phase === "installing") && (
        <div className={`update-progress ${progress === null ? "indeterminate" : ""}`} role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <span style={progress === null ? undefined : { width: `${progress}%` }} />
        </div>
      )}
      {appUpdater.notes && <div className="update-notes"><strong>What’s new</strong><p>{appUpdater.notes}</p>{appUpdater.publishedAt && <small>{new Date(appUpdater.publishedAt).toLocaleDateString()}</small>}</div>}
      <div className="update-actions">
        <button className="secondary-button" onClick={() => void openUrl(RELEASE_NOTES_URL)}><ExternalLink size={13} /> View release notes</button>
        {appUpdater.phase === "available" ? (
          <button className="primary-button" onClick={() => void appUpdater.applyUpdate()}><Download size={13} /> Download, install, and restart</button>
        ) : appUpdater.phase === "error" ? appUpdater.restartPending ? (
          <button className="primary-button" onClick={() => void appUpdater.applyUpdate()}><RotateCcw size={13} /> Save and restart</button>
        ) : (
          <button className="secondary-button" onClick={() => void appUpdater.checkForUpdates()}><RotateCcw size={13} /> Try again</button>
        ) : null}
      </div>
    </div>
    </div>
    <div className="set-group">
    <div className="set-group-head"><h4>Developer runtimes</h4></div>
    <div className="developer-runtime-update-grid">
      <DeveloperRuntimeUpdateCard target="claude" name="Claude Code" status={developerRuntimeUpdater.status?.claude ?? null} updater={developerRuntimeUpdater} />
      <DeveloperRuntimeUpdateCard target="codex" name="Codex CLI" status={developerRuntimeUpdater.status?.codex ?? null} updater={developerRuntimeUpdater} />
    </div>
    {developerRuntimeUpdater.error && <div className="update-card developer-runtime-result error" role="alert"><div className="update-status-row"><Info size={13} /><span>{developerRuntimeUpdater.error}</span></div><div className="update-actions"><button className="secondary-button" disabled={developerRuntimeUpdater.checking || developerRuntimeUpdater.updating !== null} onClick={() => void developerRuntimeUpdater.checkForUpdates()}><RotateCcw size={13} /> Check again</button></div></div>}
    {developerRuntimeUpdater.message && <div className="update-card developer-runtime-result" role="status"><div className="update-status-row"><Check size={13} /><span>{developerRuntimeUpdater.message.slice(-2_000)}</span></div></div>}
    </div>
    <p className="settings-footnote"><ShieldCheck size={13} aria-hidden="true" /><span>Updates come only from official channels. <SettingInfo label="How updates are verified">Mythra Code packages must match this app’s updater key. Claude Code and Codex CLI installers are fetched over HTTPS from their official publishers and verify the release assets they install.</SettingInfo></span></p>
  </section>;
}

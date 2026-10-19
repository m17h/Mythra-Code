import "./SettingsModal.legacy.css";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openFolderDialog, save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/confirmDialog";
import { skillMentionRanges } from "../lib/skillMentions";
import { mergePromptProfileDrafts } from "../lib/instructionFiles";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  BadgeDollarSign,
  Boxes,
  BookOpenCheck,
  CalendarClock,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderCog,
  Gauge,
  GitFork,
  Info,
  KeyRound,
  LoaderCircle,
  Mic,
  NotebookPen,
  Palette,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UsersRound,
  Wrench,
  X,
  Brain,
  CornerDownRight,
  Cpu,
} from "lucide-react";
import { exportDiagnostics, recentAuditRows, rpc, saveLmStudioKey, saveOpenRouterKey, type AuditRow, type CodexRuntimeStatus } from "../lib/codex";
import { cancelClaudeLogin, isClaudeModelSuperseded, visibleClaudeModels, type ClaudeRuntimeStatus } from "../lib/claude";
import { claudeUsesApiKey, codexAccountReady } from "../lib/providerAuth";
import { ClaudeBillingPanel, OpenAiApiKeyPanel, useProviderAuthOperation } from "./ProviderApiKeyPanel";
import type { CursorModel, CursorRuntimeStatus } from "../lib/cursor";
import { DEFAULT_CURSOR_MODEL, DEFAULT_LM_STUDIO_BASE_URL, DEFAULT_SETTINGS, DEFAULT_TERMINAL_TIMEOUT_MINUTES, EFFORT_SLIDER_STYLES, MAX_TERMINAL_TIMEOUT_MINUTES, RELEASE_NOTES_URL, THEMES, sanitizeTerminalTimeoutMinutes } from "../lib/appConfig";
import { resolveThreadTitleModel } from "../lib/threadTitles";
import { formatGitError, friendlyError } from "../lib/errors";
import { resolveProviderSystemPrompt } from "../lib/systemPrompt";
import { useModalFocus } from "../hooks/useModalFocus";
import { useSettingsSheetResize } from "../hooks/useSettingsSheetResize";
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
import { SubagentModelGuidanceEditor } from "./SubagentModelGuidanceEditor";
import { HarnessSettings } from "./HarnessSettings";
import { PreferenceLearningSettings } from "./PreferenceLearningSettings";
import { LanguageToolsSettings } from "./LanguageToolsSettings";
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
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { ProjectProfiles } from "./ProjectProfiles";
import "./SettingsModal.css";
import { CLAUDE_FALLBACK_MODELS } from "./ClaudeModelControl";
import { openAiModelOptions, type RuntimeModel } from "./ModelPowerControl";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import type { ChildAgentModelOption } from "./ChildAgentRoster";
import type { ClaudeModel } from "../lib/claude";
import type { OpenRouterModel } from "./OpenRouterModelControl";
import { sanitizeProjectDefaultOverrides } from "../lib/projectDefaults";
import { settingsWithDefaultProvider, settingsWithOnboardingDraft, type OnboardingSettingsDraft } from "../lib/onboardingSettings";
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

// Grouped by what someone is trying to do, not by implementation.
const SETTINGS_NAV: ReadonlyArray<{ group: string; items: ReadonlyArray<SettingsNavItem> }> = [
  {
    group: "AI",
    items: [
      { id: "models", label: "Models & accounts", icon: KeyRound, detail: "Choose the default provider, connect your accounts, and pick a default model.", keywords: "model provider account sign in login api key openai chatgpt codex anthropic claude cursor openrouter lm studio subscription credentials token default" },
      { id: "voice", label: "Voice input", icon: Mic, detail: "Dictate into the message box. Uses its own transcription API key, separate from your chat accounts.", keywords: "voice input dictation dictate microphone mic speech to text speech-to-text transcription transcribe whisper audio record recording api key openai openrouter model" },
      { id: "prompts", label: "Prompts", icon: NotebookPen, detail: "What every agent is told before your message.", keywords: "prompt system instructions agents.md claude.md guidance context profile profiles preset global codex claude layer" },
      { id: "memory", label: "Memory", icon: Brain, detail: "Optionally learn how you like to work from your conversations.", keywords: "memory learning learned preferences history personalize personalization remember experimental" },
      { id: "agents", label: "Sub-agents", icon: UsersRound, detail: "Sub-agent workflows, thread cleanup, and reusable setups.", keywords: "sub-agent subagent child agent delegate parallel concurrency preset archive cleanup crew mythra v2 preview conversation steering review model guidance notes" },
    ],
  },
  {
    group: "Connections",
    items: [
      { id: "github", label: "GitHub", icon: GitFork, detail: "Connect your GitHub account and clone repositories into new projects.", keywords: "github git clone repository repo account sign in gh cli remote" },
      { id: "tools", label: "Tools & MCP", icon: Wrench, detail: "Language tools, local MCP servers, and live tool controls.", keywords: "mcp tool tools server stdio model context protocol integration workspace language languages lsp install automatic setup" },
      { id: "skills", label: "Skills", icon: Boxes, detail: "Markdown skills in a local folder that models can call by name.", keywords: "skill skills markdown folder library import capability" },
    ],
  },
  {
    group: "Automation",
    items: [
      { id: "workflows", label: "Workflows", icon: Play, detail: "Multi-step agent recipes and one-click project actions.", keywords: "workflow automation recipe steps pipeline action command run trigger" },
      { id: "scheduled-tasks", label: "Scheduled tasks", icon: CalendarClock, detail: "Prompts that run on their own in a chat or a project.", keywords: "schedule scheduled cron timer interval recurring unattended background task reminder" },
    ],
  },
  {
    group: "Usage",
    items: [
      { id: "usage", label: "Usage", icon: Gauge, detail: "How quotas are shown, plus everything this device has used.", keywords: "usage quota limit tokens cost price pricing spend billing rate percentage remaining consumed" },
      { id: "pricing", label: "Model pricing", icon: BadgeDollarSign, parent: "usage", detail: "Official OpenAI and Anthropic API list prices per 1M tokens. Reference only; subscriptions aren’t billed at these rates.", keywords: "pricing price prices rate rates cost api list per million mtok token tokens input output cache read write cached long context openai anthropic claude gpt opus sonnet haiku" },
    ],
  },
  {
    group: "App",
    items: [
      { id: "general", label: "Interface", icon: Palette, detail: "Appearance and keyboard shortcuts. Appearance previews instantly; save to keep your changes.", keywords: "theme dark light appearance colour color scheme font typeface text size scale zoom density effort slider logo icon mark look keyboard shortcut escape esc stop cancel active run" },
      { id: "projects", label: "Projects", icon: FolderCog, detail: "Set up Git, name new threads automatically, and give each project its own provider, model, and look.", keywords: "profile export import copy project folder workspace default override per-project repository repo git init initialize initialization automatic thread title titles naming rename luna" },
      { id: "system", label: "Runtime", icon: Cpu, detail: "Onboarding, notifications, service tier, terminal memory and timeout, and diagnostics.", keywords: "runtime notification alert service tier terminal scrollback memory timeout time limit stop kill command local server dev server long-running minutes diagnostics logs errors performance onboarding getting started" },
      { id: "updates", label: "Updates", icon: Download, detail: "Mythra Code, Claude Code, and Codex updates in one place, always from their official channels.", keywords: "update upgrade version release install download changelog notes" },
    ],
  },
];

type SettingsRow = {
  pane: SettingsPane;
  label: string;
  keywords?: string;
  /** Stable target for controls outside the shared setting-row markup. */
  target?: "openrouter-key" | "lmstudio-server" | "transcription-key" | "openai-api-key" | "claude-billing";
  accountProvider?: Provider;
};

/** Individual settings that search can jump to. Most use the visible title;
 * provider-specific controls also name their disclosure and stable target. */
const SETTINGS_ROWS: ReadonlyArray<SettingsRow> = [
  { pane: "usage", label: "Record last-turn instructions", keywords: "privacy instruction records receipts context delete history" },
  { pane: "general", label: "Escape stops the active run", keywords: "esc keyboard shortcut cancel" },
  { pane: "general", label: "Warn before using Max reasoning", keywords: "reasoning effort warning" },
  { pane: "general", label: "Theme", keywords: "dark light colour color appearance" },
  { pane: "general", label: "App scale", keywords: "zoom size interface text bigger smaller" },
  { pane: "general", label: "Chat typeface", keywords: "font serif mono" },
  { pane: "general", label: "Effort slider style", keywords: "reasoning slider" },
  { pane: "general", label: "Provider marks", keywords: "logo icon openai claude cursor" },
  { pane: "projects", label: "Automatically initialize Git for new project threads", keywords: "git init repository" },
  { pane: "projects", label: "Automatic thread titles", keywords: "name rename title luna" },
  { pane: "projects", label: "Project profiles", keywords: "export import copy share project settings profile differs defaults" },
  { pane: "models", label: "Accounts & connections", keywords: "sign in login account" },
  { pane: "models", label: "OpenAI API key and billing", keywords: "openai api key billing subscription chatgpt codex pay as you go", target: "openai-api-key", accountProvider: "openai" },
  { pane: "models", label: "Claude API key and billing", keywords: "anthropic claude api key billing subscription console", target: "claude-billing", accountProvider: "claude" },
  { pane: "models", label: "OpenRouter API key", keywords: "key token openrouter", target: "openrouter-key", accountProvider: "openrouter" },
  { pane: "models", label: "LM Studio local server", keywords: "lm studio local url token", target: "lmstudio-server", accountProvider: "lmstudio" },
  { pane: "models", label: "Defaults for new threads", keywords: "default provider model" },
  { pane: "voice", label: "Transcription provider", keywords: "voice dictation speech openai openrouter" },
  { pane: "voice", label: "Transcription API key", keywords: "voice dictation speech key token credential", target: "transcription-key" },
  { pane: "voice", label: "Transcription model", keywords: "voice dictation speech whisper gpt transcribe" },
  { pane: "prompts", label: "Your instructions", keywords: "system prompt global codex claude profile" },
  { pane: "prompts", label: "Project files", keywords: "agents.md claude.md discovery" },
  { pane: "prompts", label: "What the agent receives", keywords: "preview combined layers" },
  { pane: "memory", label: "Learned preferences", keywords: "learning history scope" },
  { pane: "agents", label: "Sub-agent defaults", keywords: "concurrency parallel delegate" },
  { pane: "agents", label: "Model guidance", keywords: "model notes when to use sub-agent preferences" },
  { pane: "agents", label: "Archive sub-agent threads automatically", keywords: "cleanup archive" },
  { pane: "agents", label: "Sub-agent presets", keywords: "preset crew setup" },
  { pane: "agents", label: "Custom agents", keywords: "specialist instructions" },
  { pane: "tools", label: "MCP servers", keywords: "mcp server stdio" },
  { pane: "tools", label: "Live tool controls", keywords: "workspace tools" },
  { pane: "workflows", label: "Quick project actions", keywords: "action command button" },
  { pane: "usage", label: "Provider quota display", keywords: "remaining consumed percentage" },
  { pane: "system", label: "Guided setup", keywords: "onboarding tour getting started" },
  { pane: "system", label: "Desktop notifications", keywords: "notify alert" },
  { pane: "system", label: "Status in the menu bar", keywords: "tray menu bar notification area icon running" },
  { pane: "system", label: "Performance overlay", keywords: "fps frame rate memory heap debug" },
  { pane: "system", label: "OpenAI service tier", keywords: "fast priority" },
  { pane: "system", label: "Terminal scrollback", keywords: "terminal memory buffer" },
  { pane: "system", label: "Terminal and local-server timeout", keywords: "terminal timeout minutes dev server" },
  { pane: "system", label: "Export a diagnostic bundle", keywords: "diagnostics logs support" },
];

/** Which pane edits each saved setting, for the sidebar's unsaved markers. */
const SETTING_PANES: Partial<Record<keyof AppSettings, SettingsPane>> = {
  provider: "models", model: "models", lmStudioBaseUrl: "models", reasoningEffort: "models", ultra: "models", permission: "models",
  openAiLogo: "general", claudeLogo: "general", cursorLogo: "general", theme: "general", effortSlider: "general", chatFont: "general",
  escapeStopsRun: "general", warnOnMaxReasoning: "general", uiScale: "general",
  systemPrompt: "prompts", codexSystemPrompt: "prompts", claudeSystemPrompt: "prompts", promptProfileId: "prompts",
  projectInstructionsEnabled: "prompts", projectClaudeInstructionsEnabled: "prompts",
  subagentsEnabled: "agents", subagentMax: "agents", subagentEngine: "agents", nativeSubagentMax: "agents", nativeSubagentOptions: "agents",
  autoCompactTokens: "agents", autoArchiveSubagentThreads: "agents", childAgents: "agents", childAgentPresets: "agents", managedSubagentV2: "agents", subagentModelGuidance: "agents",
  automaticGitInitialization: "projects", automaticThreadTitles: "projects", threadTitleProvider: "projects", threadTitleModel: "projects",
  serviceTier: "system", notificationsEnabled: "system", terminalScrollback: "system", terminalTimeoutMinutes: "system",
  usageDisplay: "usage",
  transcription: "voice",
};

/** Does a pane match what someone typed into the sidebar's search field? */
function settingsNavMatches(item: { label: string; detail: string; keywords: string }, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.detail} ${item.keywords}`.toLowerCase();
  // Every word has to land somewhere, so "claude key" reaches Models & accounts
  // without dragging in every pane that merely mentions Claude.
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

const SETTINGS_PANES = new Map(SETTINGS_NAV.flatMap((section) => section.items.map((item) => [item.id, item] as const)));

/** Typed timeout minutes, or null while the text is not a whole number in range. */
function parseTerminalTimeoutMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= MAX_TERMINAL_TIMEOUT_MINUTES ? minutes : null;
}

// Picker-only metadata stays in the lazy Settings chunk. The actual stacks
// live in CSS, while startup only needs the compact persisted id sanitizer.
// Keep these ids synchronized with sanitizeChatFont and --chat-font-*.
const CHAT_FONTS: ReadonlyArray<{ id: ChatFont; name: string; description: string }> = [
  { id: "system", name: "Interface default", description: "The same typeface as the rest of Mythra Code" },
  { id: "humanist", name: "Humanist sans", description: "Open, warm letterforms with a little more air" },
  { id: "serif", name: "Reading serif", description: "Book-like text for long answers" },
  { id: "mono", name: "Monospace", description: "Fixed-width throughout, like a terminal" },
];

const INTERFACE_SIZE_OPTIONS: AppSelectOption[] = [
  { value: "90", label: "Compact", detail: "90% · fit more on screen" },
  { value: "100", label: "Default", detail: "100% · recommended" },
  { value: "110", label: "Comfortable", detail: "110% · easier to read" },
  { value: "125", label: "Large", detail: "125% · maximum size" },
];

const SERVICE_TIER_OPTIONS: AppSelectOption[] = [
  { value: "", label: "Standard", detail: "Regular processing" },
  { value: "priority", label: "Fast / priority", detail: "When supported · API pricing or plan limits may differ" },
];

const TERMINAL_SCROLLBACK_OPTIONS: AppSelectOption[] = [
  { value: "25000", label: "25k characters", detail: "Lightest on memory" },
  { value: "100000", label: "100k characters", detail: "Recommended" },
  { value: "500000", label: "500k characters", detail: "Keeps long build logs" },
];

const PROJECT_PROVIDER_OPTIONS: AppSelectOption[] = [
  { value: "openai", label: "OpenAI", detail: "Codex · subscription or API key", icon: <ProviderLogo provider="openai" size={15} /> },
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

function supersededClaudeDisplay(provider: Provider, selectedModel: string, catalogs: ModelCatalogs): Omit<AppSelectOption, "value"> | undefined {
  if (provider !== "claude" || !isClaudeModelSuperseded(catalogs.claudeModels, selectedModel)) return undefined;
  return {
    label: "Superseded Claude model",
    detail: "Choose a current model before saving",
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
  const selectedClaudeModelWasSuperseded = provider === "claude"
    && isClaudeModelSuperseded(catalogs.claudeModels, selectedModel);
  if (selectedModel && !selectedClaudeModelWasSuperseded && !options.some((entry) => entry.value === selectedModel)) {
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

/** An ordinary account read reports Codex's local sign-in, not service health. */
const OPENAI_SIGNED_IN_NOTE = "Signed in according to Codex on this device. OpenAI service status is not checked.";

function accountConnectionLabel(check: string | undefined, connected: boolean, available: boolean, missing: string, signedInLabel = "Connected"): string {
  if (check === "Checking connection…") return "Checking…";
  if (check === "Waiting for sign-in…") return "Signing in…";
  if (check && check !== "Sign-in required") return "Unverified";
  return connected ? signedInLabel : available ? "Not signed in" : missing;
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
        ? `${result.message}\n\nRestart Mythra Code when convenient to use the updated Codex runtime.`
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
  /** Starred models, shared with the composer and sub-agent pickers. */
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  /** Resolves an OpenRouter slug typed into the app-native model search. */
  onDiscoverOpenRouterModels?: (query: string) => void;
  /** Which providers a cross-provider child could be started on right now. */
  childAgentReadiness: ChildAgentReadiness;
  /** Live workflow-change lock; draft edits are retained until saving. */
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
  /** Interface size previews like the other appearance choices; save to keep. */
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
  onLearnPastConversations?: (scopeKey: string) => Promise<void>;
  onCancelPreferenceLearning?: (scopeKey: string) => void;
  preferenceHistoryProgress?: PreferenceHistoryProgress | null;
  onPreferenceLearningChanged?: (message: string) => void;
}) {
  const cursorAccountCheck = accountChecks.cursor || (cursorStatus?.loggedIn && cursorStatus.authVerified === false ? "Connection unverified" : "");
  const managedDeveloperRuntimeUpdater = useDeveloperRuntimeUpdater(onClaudeRefresh, !injectedDeveloperRuntimeUpdater);
  const developerRuntimeUpdater = injectedDeveloperRuntimeUpdater ?? managedDeveloperRuntimeUpdater;
  const [local, setLocal] = useState(settings);
  // Browsing credentials is not an edit to the defaults for new threads.
  const [accountProvider, setAccountProvider] = useState<Provider>(settings.provider);
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
  // Minutes as typed. null mirrors the draft setting; while disabled it keeps
  // the last limit so switching back on restores it.
  const [terminalTimeoutText, setTerminalTimeoutText] = useState<string | null>(null);
  const subagentPanelId = useId();
  const managedSubagentV2Id = useId();
  const managedSubagentV2DraftLocked = Boolean(managedSubagentV2LockedReason)
    && (local.managedSubagentV2 === true) !== (settings.managedSubagentV2 === true);
  const terminalTimeoutId = useId();
  const escapeStopsRunId = useId();
  const maxReasoningWarningId = useId();
  const automaticGitInitializationId = useId();
  const [apiKey, setApiKey] = useState("");
  const [lmStudioToken, setLmStudioToken] = useState("");
  const [lmStudioConnectionMessage, setLmStudioConnectionMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsPane>(initialSection);
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
  const settingsEntryRef = useRef({ open: false, section: initialSection as SettingsPane });
  const updatesRef = useRef({ appUpdater, developerRuntimeUpdater });
  updatesRef.current = { appUpdater, developerRuntimeUpdater };

  const modelCatalogs = useMemo<ModelCatalogs>(() => ({
    runtimeModels,
    claudeModels,
    cursorModels,
    openRouterModels,
    lmStudioModels,
  }), [claudeModels, cursorModels, lmStudioModels, openRouterModels, runtimeModels]);

  const defaultModelOptions = useMemo<AppSelectOption[]>(
    () => modelOptionsForProvider(local.provider, local.model, modelCatalogs),
    [local.model, local.provider, modelCatalogs],
  );
  const defaultModelSelectedDisplay = supersededClaudeDisplay(local.provider, local.model, modelCatalogs);

  const subAgentModelCatalogs = useMemo<Partial<Record<Provider, ChildAgentModelOption[]>>>(() => ({
    openai: openAiModelOptions(runtimeModels).map((entry) => ({
      id: entry.id,
      label: entry.name,
      detail: entry.tagline,
    })),
    ...(claudeModels.length ? {
      claude: visibleClaudeModels(claudeModels).filter((entry) => !entry.disabled).map((entry) => ({
        id: entry.id,
        label: entry.displayName,
        detail: entry.description || entry.resolvedModel,
        keywords: entry.resolvedModel,
      })),
    } : {}),
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
  }), [claudeModels, cursorModels, lmStudioModels, openRouterModels, runtimeModels]);

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

  // Buffered edits (theme, prompt, toggles) are discarded on close — warn
  // before silently throwing away work like a hand-written system prompt.
  // Settings saved before the timeout existed read as the five-minute default.
  const terminalTimeoutMinutes = sanitizeTerminalTimeoutMinutes(local.terminalTimeoutMinutes);
  const terminalTimeoutEnabled = terminalTimeoutMinutes > 0;
  const terminalTimeoutTyped = terminalTimeoutEnabled && terminalTimeoutText !== null
    ? parseTerminalTimeoutMinutes(terminalTimeoutText) : terminalTimeoutMinutes;
  // Invalid text never reaches the draft, so it blocks Save instead of being
  // silently replaced by the previous limit or read as "disabled".
  const terminalTimeoutInvalid = terminalTimeoutTyped === null;
  const dirty = useMemo(() => open && (JSON.stringify(local) !== JSON.stringify(settings) || JSON.stringify(localProjects) !== JSON.stringify(projects) || JSON.stringify(localProfiles) !== JSON.stringify(profiles) || terminalTimeoutTyped !== terminalTimeoutMinutes), [open, local, settings, localProjects, projects, localProfiles, profiles, terminalTimeoutTyped, terminalTimeoutMinutes]);
  const activeProjectAppearance = localProjects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
  const activeProjectHasAppearanceOverride = Boolean(activeProjectAppearance?.theme || activeProjectAppearance?.chatFont || activeProjectAppearance?.effortSlider);
  const projectDefaultsComplete = localProjects.every((project) => !project.overrides?.defaults || Boolean(project.overrides.defaults.model.trim()));
  const requestClose = async () => {
    if (dirty && !await confirmDialog("Discard unsaved settings changes?")) return;
    onClose();
  };
  const requestOnboarding = async () => {
    if (dirty && !await confirmDialog("Discard unsaved settings changes?")) return;
    onOpenOnboarding();
  };

  // Snapshot of the props the current drafts were seeded from, so external
  // updates while the modal is open can tell "user edited this" apart from
  // "still the value we started with".
  const draftBaselineRef = useRef({ settings, projects, profiles });
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      // Seed drafts only on the closed→open transition — reseeding on every
      // prop change wiped in-progress edits (e.g. cloning a repo from the
      // GitHub pane updates `projects` and used to discard a drafted prompt).
      wasOpenRef.current = true;
      draftBaselineRef.current = { settings, projects, profiles };
      const seeded = settingsWithOnboardingDraft(settings, initialDraft, lmStudioModels[0]?.id);
      setLocal(seeded);
      setAccountProvider(seeded.provider);
      setLocalProjects(projects);
      setLocalProfiles(profiles);
      setExpandedPresetId(null);
      setRenamingPresetId(null);
      setCreatingPreset(false);
      setPresetDraftName("");
      setPolicyNotice("");
      setTerminalTimeoutText(null);
      const activeDefaults = projects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
      onThemePreview(initialDraft?.appearance ? seeded.theme : activeDefaults?.theme ?? seeded.theme);
      onEffortSliderPreview(initialDraft?.appearance ? seeded.effortSlider : activeDefaults?.effortSlider ?? seeded.effortSlider);
      onChatFontPreview(initialDraft?.appearance ? seeded.chatFont : activeDefaults?.chatFont ?? seeded.chatFont);
      onUiScalePreview(settings.uiScale ?? 100);
      setSettingsSection(initialSection);
      return;
    }
    const baseline = draftBaselineRef.current;
    if (settings !== baseline.settings) {
      // Adopt external settings changes only when the draft is untouched, so
      // the dirty check keeps meaning "you have unsaved edits". Timeout text
      // that differs from the draft is an edit even before it parses into it.
      if (terminalTimeoutTyped === terminalTimeoutMinutes && JSON.stringify(local) === JSON.stringify(baseline.settings)) {
        setLocal(settings);
        setTerminalTimeoutText(null);
      }
    }
    if (projects !== baseline.projects) {
      // Merge external project changes: new projects appear, removed ones
      // disappear, and per-project drafts survive only where the user
      // actually diverged from the snapshot they started editing.
      const baselineById = new Map(baseline.projects.map((project) => [project.id, project]));
      setLocalProjects((current) => {
        const draftsById = new Map(current.map((project) => [project.id, project]));
        return projects.map((incoming) => {
          const draft = draftsById.get(incoming.id);
          const base = baselineById.get(incoming.id);
          return draft && base && JSON.stringify(draft) !== JSON.stringify(base) ? draft : incoming;
        });
      });
    }
    if (profiles !== baseline.profiles) {
      setLocalProfiles((current) => mergePromptProfileDrafts(baseline.profiles, current, profiles));
    }
    draftBaselineRef.current = { settings, projects, profiles };
  }, [activeProjectId, initialDraft, initialSection, lmStudioModels, onChatFontPreview, onEffortSliderPreview, onThemePreview, onUiScalePreview, local, open, projects, profiles, settings, terminalTimeoutMinutes, terminalTimeoutTyped]);

  useEffect(() => {
    const previous = settingsEntryRef.current;
    // On reopening, the old pane is retained until the draft-seeding effect
    // updates it. Use the requested pane to avoid a spurious or double check.
    let section = open && !previous.open ? initialSection : settingsSection;
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
  }, [initialDraft?.appearance, initialSection, open, settingsSection]);

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

  const previewTheme = (theme: ThemeName) => {
    setLocal((current) => ({ ...current, theme }));
    onThemePreview(theme);
  };

  const previewEffortSlider = (style: EffortSliderStyle) => {
    setLocal((current) => ({ ...current, effortSlider: style }));
    onEffortSliderPreview(style);
  };

  const previewChatFont = (chatFont: ChatFont) => {
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
  // Thirteen panes is more than anyone scans reliably, so the sidebar can be
  // searched. Filtering only hides nav rows: the pane in front of you is never
  // swapped out mid-edit just because you started typing.
  const [navQuery, setNavQuery] = useState("");
  const navGroups = useMemo(() => SETTINGS_NAV
    .map((section) => ({ ...section, items: section.items.filter((item) => (navQuery.trim() || !item.parent) && settingsNavMatches(item, navQuery)) }))
    .filter((section) => section.items.length > 0), [navQuery]);
  const navMatches = useMemo(() => navGroups.flatMap((section) => section.items), [navGroups]);
  // Individual settings, so "scrollback" lands on the row, not just Runtime.
  const rowMatches = useMemo(() => navQuery.trim()
    ? SETTINGS_ROWS.filter((row) => settingsNavMatches({ label: row.label, detail: SETTINGS_PANES.get(row.pane)?.label ?? "", keywords: row.keywords ?? "" }, navQuery)).slice(0, 8)
    : [], [navQuery]);
  const [rowFocus, setRowFocus] = useState<(SettingsRow & { nonce: number }) | null>(null);
  const goToRow = (row: SettingsRow) => {
    // Reveal the account panel without editing the default provider/model.
    if (row.accountProvider) setAccountProvider(row.accountProvider);
    setSettingsSection(row.pane);
    setRowFocus((current) => ({ ...row, nonce: (current?.nonce ?? 0) + 1 }));
  };
  // Panes with edits that Save would write, marked in the sidebar.
  const dirtyPanes = useMemo(() => {
    const panes = new Set<SettingsPane>();
    if (!open) return panes;
    for (const key of Object.keys(SETTING_PANES) as Array<keyof AppSettings>) {
      if (JSON.stringify(local[key]) !== JSON.stringify(settings[key])) panes.add(SETTING_PANES[key]!);
    }
    if (JSON.stringify(localProjects) !== JSON.stringify(projects)) panes.add("projects");
    if (JSON.stringify(localProfiles) !== JSON.stringify(profiles)) panes.add("prompts");
    if (terminalTimeoutTyped !== terminalTimeoutMinutes) panes.add("system");
    return panes;
  }, [open, local, settings, localProjects, projects, localProfiles, profiles, terminalTimeoutTyped, terminalTimeoutMinutes]);
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
      const match = rowFocus.target
        ? content?.querySelector<HTMLElement>(`[data-settings-row="${rowFocus.target}"]`)
        : content && [...content.querySelectorAll<HTMLElement>("h4, .set-row strong, summary")]
          .find((element) => element.textContent?.trim().toLowerCase() === label);
      if (!match) {
        if (++attempts < 30) frame = requestAnimationFrame(find);
        return;
      }
      marked = rowFocus.target ? match : match.closest<HTMLElement>(".set-row, .set-group") ?? match;
      marked.scrollIntoView?.({ block: "center" });
      marked.classList.add("settings-row-highlight");
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
  const wideSheet = settingsSection === "usage" || settingsSection === "pricing";
  useSettingsSheetResize(dialogRef, contentRef, wideSheet ? "wide" : "reading", open);
  const terminalTimeoutInputRef = useCallback((input: HTMLInputElement | null) => {
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

  // Each pane's primary action lives in its heading, beside the title, so
  // the pane never needs a second heading of its own.
  const updatesChecking = appUpdater.phase === "checking" || developerRuntimeUpdater.checking;
  const updatesBusy = ["checking", "downloading", "installing", "restarting"].includes(appUpdater.phase) || developerRuntimeUpdater.checking || developerRuntimeUpdater.updating !== null;
  const paneAction = settingsSection === "general" && local.theme !== DEFAULT_SETTINGS.theme
    ? <button type="button" className="secondary-button" onClick={() => previewTheme(DEFAULT_SETTINGS.theme)}><RotateCcw size={12} /> Default theme</button>
    : settingsSection === "updates"
      ? <button type="button" className="secondary-button" disabled={updatesBusy} onClick={() => void Promise.all([appUpdater.checkForUpdates(), developerRuntimeUpdater.checkForUpdates()])}>{updatesChecking ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Check all</button>
      : null;

  const saveSettings = () => {
    if (!projectDefaultsComplete || terminalTimeoutInvalid) return;
    if (onBeforeSave?.(local) === false) return;
    const nextProjects = sanitizeProjectDefaultOverrides(sanitizeProjectSubagentOverrides(localProjects));
    const normalizedSubagents = projectSubagentSettingsFromApp(local);
    onProjects(nextProjects);
    onProfiles(mergePromptProfileDrafts(draftBaselineRef.current.profiles, localProfiles, profiles));
    onSave({
      ...local,
      childAgents: normalizedSubagents.childAgents,
      childAgentPresets: sanitizeChildAgentPresets(local.childAgentPresets),
      subagentModelGuidance: sanitizeSubagentModelGuidance(local.subagentModelGuidance),
      subagentMax: normalizedSubagents.maxConcurrent,
      terminalTimeoutMinutes,
    });
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

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} onMouseDown={requestClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div ref={dialogRef} className={`settings-modal${wideSheet ? " settings-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            <div className="settings-nav-head">
              <h2 id="settings-title">Settings</h2>
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
                    // Once a search has narrowed to one answer, Enter goes
                    // there: no second aim with the mouse.
                    if (event.key === "Enter" && rowMatches.length === 1) goToRow(rowMatches[0]!);
                    else if (event.key === "Enter" && navMatches.length === 1) setSettingsSection(navMatches[0]!.id);
                  }}
                />
                {navQuery && <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setNavQuery("")}><X size={12} /></button>}
              </div>
            </div>
            <div className="settings-nav-scroll">
              {navGroups.map((section) => (
                <div className="settings-nav-group" key={section.group} role="group" aria-label={section.group}>
                  <span className="settings-nav-label" aria-hidden>{section.group}</span>
                  {section.items.map(({ id, label, icon: Icon }) => {
                    const current = settingsSection === id || (!navQuery.trim() && SETTINGS_PANES.get(settingsSection)?.parent === id);
                    const dirtyHere = dirtyPanes.has(id) || [...dirtyPanes].some((pane) => SETTINGS_PANES.get(pane)?.parent === id);
                    return <button
                      key={id}
                      className={current ? "active" : ""}
                      onClick={() => setSettingsSection(id)}
                      aria-current={current ? "page" : undefined}
                    >
                      <Icon size={14} aria-hidden="true" /><span>{label}</span>{id === "updates" && anyUpdateAvailable && <span className="settings-update-dot" role="img" aria-label="Update available" />}{dirtyHere && <span className="settings-dirty-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
                    </button>;
                  })}
                </div>
              ))}
              {rowMatches.length > 0 && <div className="settings-nav-group settings-row-results" role="group" aria-label="Settings">
                <span className="settings-nav-label" aria-hidden>Settings</span>
                {rowMatches.map((row) => <button key={`${row.pane}:${row.label}`} type="button" onClick={() => goToRow(row)}>
                  <CornerDownRight size={14} aria-hidden="true" /><span className="settings-row-result"><small>{SETTINGS_PANES.get(row.pane)?.label}</small><span>{row.label}</span></span>
                </button>)}
              </div>}
              {!navGroups.length && !rowMatches.length && <p className="settings-nav-empty">Nothing matches &ldquo;{navQuery.trim()}&rdquo;.</p>}
            </div>
          </nav>
          <div className="settings-pane">
            <header className="settings-pane-heading">
              <div className={wideSheet ? "settings-heading-stack" : undefined}>
                {wideSheet ? (["usage", "pricing"] as const).map((pane) => (
                  <div className="settings-heading-copy" key={pane} aria-hidden={settingsSection !== pane}>
                    <h3>{SETTINGS_PANES.get(pane)?.label}</h3>
                    <small>{SETTINGS_PANES.get(pane)?.detail}</small>
                  </div>
                )) : <>
                  <h3>{SETTINGS_PANES.get(settingsSection)?.label}</h3>
                  <small>{SETTINGS_PANES.get(settingsSection)?.detail}</small>
                </>}
              </div>
              {paneAction}
              <button className="icon-button settings-close" onClick={requestClose} aria-label="Close settings"><X size={17} /></button>
            </header>
            <div className={`settings-content ${moreBelow ? "has-more-below" : ""}`} ref={contentRef}>
          {settingsSection === "voice" &&
          <TranscriptionSettings
            visible={open}
            value={local.transcription}
            onChange={(transcription) => setLocal((current) => ({ ...current, transcription }))}
            accountOpenRouterKeySaved={openRouterReady}
            onOpenAccounts={() => {
              setAccountProvider("openrouter");
              setSettingsSection("models");
            }}
          />}

          {settingsSection === "system" &&
          <div className="set-group">
            <h4>Getting started</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Guided setup</strong>
                <small>Explore providers, projects, sub-agents, and ways to make the app your own.</small>
              </div>
              <div className="set-control">
                <button type="button" className="secondary-button" onClick={requestOnboarding}><BookOpenCheck size={13} /> Run onboarding</button>
              </div>
            </div></div>
          </div>}

          {settingsSection === "general" &&
          <section className="settings-section theme-settings-section">
            {activeProjectHasAppearanceOverride && <p className="settings-footnote" role="note"><Info size={13} aria-hidden="true" /><span>Save updates app-wide defaults. This project has appearance overrides; edit them in Projects.</span></p>}
            <div className="set-group">
              <h4>Theme</h4>
              <div className="set-card bare"><div className="set-body">
                <div className="theme-grid">
                  {THEMES.map((theme) => (
                    <button
                      type="button"
                      key={theme.id}
                      className={`theme-card ${local.theme === theme.id ? "selected" : ""}`}
                      aria-pressed={local.theme === theme.id}
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
                      <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                      {local.theme === theme.id && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Interface size</h4>
              <div className="set-card"><div className="set-row">
                <div className="set-copy">
                  <strong>App scale</strong>
                  <small>Scales the whole app, including chat text, without changing the typeface.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu
                    value={String(local.uiScale ?? 100)}
                    options={INTERFACE_SIZE_OPTIONS}
                    ariaLabel="Interface size"
                    portal
                    onChange={(value) => previewUiScale(Number(value))}
                  />
                </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Chat typeface</h4>
              <p>Conversation text and the composer only. The rest of the interface keeps its own type, and code stays monospaced.</p>
              <div className="set-card bare"><div className="set-body">
                    <div className="chat-font-grid">
                      {CHAT_FONTS.map((font) => (
                        <button
                          type="button"
                          key={font.id}
                          className={`chat-font-card ${local.chatFont === font.id ? "selected" : ""}`}
                          data-chat-font-option={font.id}
                          aria-pressed={local.chatFont === font.id}
                          onClick={() => previewChatFont(font.id)}
                        >
                          <span className="chat-font-preview" style={{ fontFamily: `var(--chat-font-${font.id})` }} aria-hidden="true">Ag</span>
                          <span><strong>{font.name}</strong><small>{font.description}</small></span>
                          {local.chatFont === font.id && <Check size={14} />}
                        </button>
                      ))}
                    </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Behavior</h4>
              <div className="set-card">
                <div className="set-row">
                <div className="set-copy">
                  <strong>Escape stops the active run</strong>
                  <small id={escapeStopsRunId}>Applies across the app. Escape still dismisses menus and dialogs when this is off. Editable fields keep their own Escape behavior.</small>
                </div>
                <button type="button" role="switch" aria-label="Escape stops the active run" aria-describedby={escapeStopsRunId} aria-checked={local.escapeStopsRun} className={`toggle-switch ${local.escapeStopsRun ? "on" : ""}`} onClick={() => setLocal({ ...local, escapeStopsRun: !local.escapeStopsRun })}><span /></button>
              </div>
                <div className="set-row">
                <div className="set-copy">
                  <strong>Warn before using Max reasoning</strong>
                  <small id={maxReasoningWarningId}>Ask before selecting Max in model and sub-agent controls. Extra reasoning can use much more of your allowance or API budget without a meaningful improvement. Applies app-wide.</small>
                </div>
                <button type="button" role="switch" aria-label="Warn before using Max reasoning" aria-describedby={maxReasoningWarningId} aria-checked={local.warnOnMaxReasoning !== false} className={`toggle-switch ${local.warnOnMaxReasoning !== false ? "on" : ""}`} onClick={() => setLocal((current) => ({ ...current, warnOnMaxReasoning: current.warnOnMaxReasoning === false }))}><span /></button>
              </div>
              </div>
            </div>
            <div className="set-group">
              <h4>Effort slider style</h4>
              <p>How the reasoning-effort slider looks for every provider.</p>
              <div className="set-card bare"><div className="set-body">
                    <div className="slider-style-grid">
                      {EFFORT_SLIDER_STYLES.map((style) => (
                        <button
                          type="button"
                          key={style.id}
                          className={`slider-style-card ${local.effortSlider === style.id ? "selected" : ""}`}
                          aria-pressed={local.effortSlider === style.id}
                          onClick={() => previewEffortSlider(style.id)}
                        >
                          <span className={`slider-style-preview ${style.id}`} aria-hidden="true">
                            <i className="slider-style-rail" /><i className="slider-style-thumb" />
                          </span>
                          <span><strong>{style.name}</strong><small>{style.description}</small></span>
                          {local.effortSlider === style.id && <Check size={14} />}
                        </button>
                      ))}
                    </div>
              </div></div>
            </div>

            <div className="set-group">
              <h4>Provider marks</h4>
              <p>The logo shown on threads, responses, and provider controls for each subscription.</p>
              <div className="set-card bare"><div className="set-body">
                    <div className="provider-mark-grid">
                      <div className="provider-mark-group">
                        <span>OpenAI threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="OpenAI model logo">
                          <button type="button" className={local.openAiLogo === "openai" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "openai"} onClick={() => setLocal({ ...local, openAiLogo: "openai" })}>
                            <span className="provider-logo-preview openai"><OpenAILogo size={18} /></span>
                            <span><strong>OpenAI</strong></span>
                            {local.openAiLogo === "openai" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.openAiLogo === "codex" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "codex"} onClick={() => setLocal({ ...local, openAiLogo: "codex" })}>
                            <span className="provider-logo-preview codex"><CodexLogo size={20} /></span>
                            <span><strong>Codex</strong></span>
                            {local.openAiLogo === "codex" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                      <div className="provider-mark-group">
                        <span>Claude threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="Claude model logo">
                          <button type="button" className={local.claudeLogo === "claude" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "claude"} onClick={() => setLocal({ ...local, claudeLogo: "claude" })}>
                            <span className="provider-logo-preview claude"><ClaudeLogo size={18} /></span>
                            <span><strong>Claude</strong></span>
                            {local.claudeLogo === "claude" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.claudeLogo === "anthropic" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "anthropic"} onClick={() => setLocal({ ...local, claudeLogo: "anthropic" })}>
                            <span className="provider-logo-preview anthropic"><AnthropicLogo size={18} /></span>
                            <span><strong>Anthropic</strong></span>
                            {local.claudeLogo === "anthropic" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                      <div className="provider-mark-group">
                        <span>Cursor threads</span>
                        <div className="provider-logo-options" role="radiogroup" aria-label="Cursor model logo">
                          <button type="button" className={local.cursorLogo === "cube" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "cube"} onClick={() => setLocal({ ...local, cursorLogo: "cube" })}>
                            <span className="provider-logo-preview cursor"><CursorLogo size={19} /></span>
                            <span><strong>Cursor</strong></span>
                            {local.cursorLogo === "cube" && <Check size={13} />}
                          </button>
                          <button type="button" className={local.cursorLogo === "app-dark" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "app-dark"} onClick={() => setLocal({ ...local, cursorLogo: "app-dark" })}>
                            <span className="provider-logo-preview cursor-app-dark"><CursorDarkAppIcon size={26} /></span>
                            <span><strong>Cursor Dark</strong></span>
                            {local.cursorLogo === "app-dark" && <Check size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>
              </div></div>
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
            />
          </section></div>

          <div hidden={!(["agents", "workflows", "scheduled-tasks", "tools"] as const).includes(settingsSection as "agents" | "workflows" | "scheduled-tasks" | "tools")}><HarnessSettings
            section={(["agents", "workflows", "scheduled-tasks", "tools"] as const).includes(settingsSection as "agents" | "workflows" | "scheduled-tasks" | "tools") ? settingsSection as "agents" | "workflows" | "scheduled-tasks" | "tools" : "tools"}
            visible={open}
            settings={local}
            agents={agents}
            actions={actions}
            schedules={schedules}
            workflows={workflows}
            workflowRuns={workflowRuns}
            projects={projects}
            skills={skills}
            modelCatalogs={subAgentModelCatalogs}
            onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
            onAgents={onAgents}
            onActions={onActions}
            onSchedules={onSchedules}
            onWorkflows={onWorkflows}
            onRunWorkflow={onRunWorkflow}
            onStopWorkflow={onStopWorkflow}
            mcpServers={mcpServers}
            onMcpChanged={onMcpChanged}
            scheduleRuns={scheduleRuns}
            onOpenRun={onOpenRun}
          /></div>

          {settingsSection === "memory" && <section className="settings-section">
            <PreferenceLearningSettings projects={projects} modelCatalogs={learningModelCatalogs} onLearnPastConversations={onLearnPastConversations} onCancelLearning={onCancelPreferenceLearning} historyProgress={preferenceHistoryProgress} onChanged={onPreferenceLearningChanged} />
          </section>}

          {settingsSection === "tools" && <LanguageToolsSettings />}

          {settingsSection === "tools" &&
          <div className="set-group">
            <h4>Live tools</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Live tool controls</strong>
                <small>{workspaceToolsAvailable ? "Inspect skills, finish MCP sign-in, connect configured servers, and run project actions in the active workspace." : "Open a project first to inspect its live skills, MCP servers, and project actions."}</small>
              </div>
              <div className="set-control">
                <button className="secondary-button" onClick={onWorkspaceTools} disabled={!workspaceToolsAvailable}><PanelRight size={13} /> Open workspace tools</button>
              </div>
            </div></div>
          </div>}

          {settingsSection === "projects" && <>
          <div className="set-group">
            <h4>Git setup</h4>
            <div className="set-card"><div className="set-row">
              <div className="set-copy">
                <strong>Automatically initialize Git for new project threads</strong>
                <small id={automaticGitInitializationId}>When enabled, creates a local Git repository in the project folder when you start a new thread if the folder is not already in a repository. Existing repositories are left untouched. Does not create commits or publish to GitHub.</small>
              </div>
              <div className="set-control">
                <button type="button" role="switch" aria-label="Automatically initialize Git for new project threads" aria-describedby={automaticGitInitializationId} aria-checked={local.automaticGitInitialization === true} className={`toggle-switch ${local.automaticGitInitialization === true ? "on" : ""}`} onClick={() => setLocal({ ...local, automaticGitInitialization: local.automaticGitInitialization !== true })}><span /></button>
              </div>
            </div></div>
          </div>
          <div className="set-group">
            <h4>Thread titles</h4>
            <div className="set-card">
              {/* Opt-in, and it says the two things people would otherwise
                  find out afterwards: the first message leaves for whichever
                  provider is chosen here even from a thread running on another
                  one, and a name you typed is yours. The fields appear only
                  once it is on — an off switch needs no configuration. */}
              <div className="set-row">
                <div className="set-copy">
                  <strong>Automatic thread titles</strong>
                  <small>Names each new thread from your first message, using the provider and model you choose.</small>
                  <small>That first message goes to the chosen provider even when the thread itself runs on another one, and uses that provider&rsquo;s own subscription or credits. Nothing is kept as a chat, and a title you write yourself is never replaced.</small>
                </div>
                <div className="set-control">
                  <button type="button" role="switch" aria-label="Automatic thread titles" aria-checked={local.automaticThreadTitles} className={`toggle-switch ${local.automaticThreadTitles ? "on" : ""}`} onClick={() => setLocal({ ...local, automaticThreadTitles: !local.automaticThreadTitles })}><span /></button>
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
          <ProjectDefaultsSettings
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

          {(settingsSection === "usage" || settingsSection === "pricing") && <div className="settings-pane-tabs" role="tablist" aria-label="Usage views">
            <button type="button" role="tab" aria-selected={settingsSection === "usage"} className={settingsSection === "usage" ? "selected" : ""} onClick={() => setSettingsSection("usage")}>Usage</button>
            <button type="button" role="tab" aria-selected={settingsSection === "pricing"} className={settingsSection === "pricing" ? "selected" : ""} onClick={() => setSettingsSection("pricing")}>Model pricing</button>
          </div>}
          {settingsSection === "usage" && <>
            {open && <UsageDashboard onRefreshPricing={onRefreshUsagePricing} openRouterPricingError={openRouterPricingError} />}
            <UsageDisplaySettings value={local.usageDisplay} onChange={(usageDisplay) => setLocal({ ...local, usageDisplay })} />
            <div className="set-group">
              <h4>Instruction records</h4>
              <p>Optional, off by default, and saved immediately on this device. Records can contain private prompts, learned preferences and skill instructions. They are not uploaded by this feature.</p>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong>Record last-turn instructions</strong>
                    <small>Keep the last confirmed turn for up to 24 threads, with the first 32,000 instruction characters each. View them in the workspace panel&rsquo;s Usage &amp; audit tab. Turning this off stops new records; existing records remain until deleted.</small>
                  </div>
                  <div className="set-control">
                    <button type="button" role="switch" aria-label="Record last-turn instructions" aria-checked={instructionRecording} disabled={instructionRecordBusy} className={`toggle-switch ${instructionRecording ? "on" : ""}`} onClick={() => {
                      try {
                        setTurnContextRecordingEnabled(!instructionRecording);
                        setInstructionRecordError("");
                        setInstructionRecordStatus("");
                      } catch { setInstructionRecordError("Could not save this privacy preference. Please try again."); }
                    }}><span /></button>
                  </div>
                </div>
                <div className="set-row">
                  <div className="set-copy"><strong>Delete existing instruction records</strong><small>{instructionRecordCount} saved {instructionRecordCount === 1 ? "thread" : "threads"}. Deletes these local copies and turns recording off. Chats, skills, learned preferences and original instruction files are not deleted.</small></div>
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
              {instructionRecordError && <p role="alert">{instructionRecordError}</p>}
              {instructionRecordStatus && <p role="status">{instructionRecordStatus}</p>}
            </div>
          </>}

          {settingsSection === "pricing" && open && <FrontierPricingSettings onRefreshAvailableModels={onRefreshAvailableModels} />}

          {settingsSection === "skills" && <SkillLibrary
            active={open}
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

          {settingsSection === "updates" && <UpdateSettings appUpdater={appUpdater} developerRuntimeUpdater={developerRuntimeUpdater} />}

          {settingsSection === "system" && <>
          <div className="set-group">
            <h4>Runtime behavior</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Desktop notifications</strong>
                  <small>Notify when a background task finishes.</small>
                </div>
                <div className="set-control">
                  <button type="button" role="switch" aria-label="Desktop notifications" aria-checked={local.notificationsEnabled} className={`toggle-switch ${local.notificationsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, notificationsEnabled: !local.notificationsEnabled })}><span /></button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Status in the menu bar</strong>
                  <small>Shows how many threads are working or waiting for approval in the macOS menu bar or the Windows notification area, with a shortcut back to the app. Saves automatically.</small>
                </div>
                <div className="set-control">
                  <button type="button" role="switch" aria-label="Status in the menu bar" aria-checked={trayStatus} className={`toggle-switch ${trayStatus ? "on" : ""}`} onClick={() => setTrayStatusEnabled(!trayStatus)}><span /></button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>OpenAI service tier</strong>
                  <small>How OpenAI requests are scheduled. API pricing or subscription limits may differ.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu value={local.serviceTier ?? ""} options={SERVICE_TIER_OPTIONS} ariaLabel="OpenAI service tier" onChange={(value) => setLocal({ ...local, serviceTier: value || null })} />
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Terminal scrollback</strong>
                  <small>How much output each terminal keeps in memory.</small>
                </div>
                <div className="set-control">
                  <AppSelectMenu value={String(local.terminalScrollback)} options={TERMINAL_SCROLLBACK_OPTIONS} ariaLabel="Terminal scrollback" onChange={(value) => setLocal({ ...local, terminalScrollback: Number(value) })} />
                </div>
              </div>
              <div className="set-row terminal-timeout-row">
                <div className="set-copy">
                  <strong>Terminal and local-server timeout</strong>
                  <small id={`${terminalTimeoutId}-help`}>Applies to new commands launched from Terminal or Run; commands already running keep the limit they launched with. With no timeout, a command runs until it exits or you stop it. Provider tool runs, Project Actions and project checks keep their own limits.</small>
                </div>
                <div className="set-control">
                  <button type="button" role="switch" aria-label="Automatically stop terminal commands" aria-describedby={`${terminalTimeoutId}-help`} aria-checked={terminalTimeoutEnabled} className={`toggle-switch ${terminalTimeoutEnabled ? "on" : ""}`} onClick={() => setTerminalTimeoutEnabled(!terminalTimeoutEnabled)}><span /></button>
                </div>
                {terminalTimeoutEnabled ? (
                  <div className="terminal-timeout-detail">
                    <label id={`${terminalTimeoutId}-label`} htmlFor={`${terminalTimeoutId}-minutes`}>Timeout</label>
                    <input
                      ref={terminalTimeoutInputRef}
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
                        ? `Enter ${MAX_TERMINAL_TIMEOUT_MINUTES.toLocaleString()} minutes or fewer, or turn the timeout off.`
                        : "Enter a whole number of minutes, 1 or more."}
                    </p>}
                  </div>
                ) : <p className="terminal-timeout-detail">No automatic timeout</p>}
              </div>
            </div>
          </div>

          <div className="set-group">
            <h4>Diagnostics</h4>
            <div className="set-card">
              <div className="set-row">
                <div className="set-copy">
                  <strong>Export a diagnostic bundle</strong>
                  <small>Runtime details, recent errors, and performance samples as JSON · {runtimeStatus?.version ?? "runtime version unavailable"}{runtimeStatus?.warning ? ` · ${runtimeStatus.warning}` : ""}</small>
                </div>
                <div className="set-control">
                  <button className="secondary-button" onClick={() => void exportDiagnosticBundle()}>Export JSON</button>
                </div>
              </div>
              <div className="set-row">
                <div className="set-copy">
                  <strong>Performance overlay</strong>
                  <small>Shows frame rate, slow frames, long tasks, provider events per second and memory in a corner of the window. Saves automatically.</small>
                </div>
                <div className="set-control">
                  <button type="button" role="switch" aria-label="Performance overlay" aria-checked={performanceOverlay} className={`toggle-switch ${performanceOverlay ? "on" : ""}`} onClick={() => setPerformanceOverlayEnabled(!performanceOverlay)}><span /></button>
                </div>
              </div>
              <RecentPerformancePanel active={open && settingsSection === "system"} />
              <RecentErrorsPanel active={open && settingsSection === "system"} />
            </div>
          </div>
          </>}

          {settingsSection === "agents" &&
          <section className="settings-section subagent-settings">
            <div className="set-group">
              <h4>Sub-agent workflow</h4>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong className="subagent-preview-heading">Mythra Code sub-agents V2 <span className="subagent-preview-badge">Preview</span></strong>
                    <small id={`${managedSubagentV2Id}-help`}>Off: sub-agents run an assignment once and return their result. On: parents and sub-agents can ask questions, continue conversations, and steer work, with parent review before automatic archiving.</small>
                    <small id={`${managedSubagentV2Id}-scope`}>Only affects the Mythra Code sub-agent system. Native Claude Code and Codex sub-agents, their models, limits, and settings are unchanged.</small>
                    <small>Applies across all projects using Mythra Code-managed sub-agents. Existing V2 crews keep their workflow until their assignments are reviewed and accepted.</small>
                    {local.managedSubagentV2 === true && <small role="status">V2 preview selected for Mythra Code only. Your native sub-agent setup stays unchanged.</small>}
                    {managedSubagentV2LockedReason && <p className="subagent-preview-lock" id={`${managedSubagentV2Id}-lock`} role="status"><Info size={13} aria-hidden="true" /><span>{managedSubagentV2LockedReason}</span></p>}
                    {managedSubagentV2DraftLocked && <>
                      <small id={`${managedSubagentV2Id}-draft`}>The switch shows your unsaved draft. V2 is still {settings.managedSubagentV2 === true ? "on" : "off"}. Keep the current workflow to save your other settings while this change is waiting.</small>
                      <button type="button" className="secondary-button subagent-preview-keep-current" aria-describedby={`${managedSubagentV2Id}-draft`} onClick={() => setLocal((draft) => ({ ...draft, managedSubagentV2: settings.managedSubagentV2 === true }))}>Keep current workflow</button>
                    </>}
                  </div>
                  <div className="set-control">
                    <button
                      type="button"
                      role="switch"
                      aria-label="Mythra Code sub-agents V2"
                      aria-describedby={`${managedSubagentV2Id}-help ${managedSubagentV2Id}-scope${managedSubagentV2LockedReason ? ` ${managedSubagentV2Id}-lock` : ""}${managedSubagentV2DraftLocked ? ` ${managedSubagentV2Id}-draft` : ""}`}
                      aria-checked={local.managedSubagentV2 === true}
                      disabled={Boolean(managedSubagentV2LockedReason)}
                      className={`toggle-switch subagent-preview-toggle ${local.managedSubagentV2 === true ? "on" : ""}`}
                      onClick={() => setLocal((draft) => ({ ...draft, managedSubagentV2: draft.managedSubagentV2 !== true }))}
                    ><span /></button>
                  </div>
                </div>
              </div>
            </div>

            <div className="set-group">
              <h4>Sub-agent defaults</h4>
              <div className="set-card">
                <div className="set-row">
                  <div className="set-copy">
                    <strong>Reusable sub-agent setup</strong>
                    <small>Every new thread starts with sub-agents off. Enable spawning in that thread's composer when needed. Saved crews and limits remain available; existing thread opt-ins are kept.</small>
                  </div>
                  <div className="set-control">
                    <button type="button" className="secondary-button" aria-expanded={agentDefaultsOpen} onClick={() => setAgentDefaultsOpen((open) => !open)}>{agentDefaultsOpen ? "Done editing" : "Edit defaults"}</button>
                  </div>
                </div>
            {agentDefaultsOpen && <div className="set-body" role="group" aria-label="Sub-agent defaults editor">
            <p className="subagent-applied-note">The saved switch below applies to older threads that still use defaults. It does not enable spawning in new threads.</p>
            <div className="field-label">
              <span>Edit defaults for</span>
              <AppSelectMenu ariaLabel="Sub-agent defaults scope" value={agentEditScope} options={[
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

            <div className="set-group">
              <div className="set-group-head">
                <h4>Model guidance</h4>
                <span className="set-group-note">{(local.subagentModelGuidance ?? []).length} of {MAX_SUBAGENT_MODEL_GUIDANCE}</span>
              </div>
              <p>Tell parent agents when and how to use a model in Mythra Code-managed sub-agent crews. A parent sees notes only for models already in its approved crew, once per model, starting with its next message. Notes are preferences: they never add sub-agents, turn them on, or affect native Claude Code and Codex sub-agents.</p>
              <SubagentModelGuidanceEditor
                value={local.subagentModelGuidance ?? []}
                modelCatalogs={subAgentModelCatalogs}
                modelFavorites={modelFavorites}
                onToggleModelFavorite={onToggleModelFavorite}
                onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
                onChange={(subagentModelGuidance) => setLocal((current) => ({ ...current, subagentModelGuidance }))}
              />
            </div>

            <div className="set-group">
              <h4>Thread cleanup</h4>
              <div className="set-card"><div className="set-row">
                <div className="set-copy">
                  <strong>Archive sub-agent threads automatically</strong>
                  <small>Move settled sub-agent threads to Archived once their parent finishes. V2 assignments also need explicit parent or user sign-off; active work and pending guidance stay visible.</small>
                </div>
                <div className="set-control">
                  <button
                    type="button"
                    role="switch"
                    aria-label="Archive sub-agent threads automatically"
                    aria-checked={local.autoArchiveSubagentThreads}
                    className={`toggle-switch ${local.autoArchiveSubagentThreads ? "on" : ""}`}
                    onClick={() => setLocal({ ...local, autoArchiveSubagentThreads: !local.autoArchiveSubagentThreads })}
                  >
                    <span />
                  </button>
                </div>
              </div></div>
            </div>

            {policyNotice && <p className="subagent-applied-note" role="status"><Check size={13} aria-hidden="true" /> {policyNotice}</p>}

            <div className="set-group preset-panel">
                  <div className="set-group-head">
                    <h4>Sub-agent presets</h4>
                    <span className="set-group-note">{local.childAgentPresets.length} of {MAX_CHILD_AGENT_PRESETS}</span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setCreatingPreset(true)}
                      disabled={presetsFull || creatingPreset}
                    ><Plus size={12} /> Create preset</button>
                  </div>
                  <p>Save providers, models, reasoning, and concurrency as one reusable setup.</p>
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
                                  <AppSelectMenu
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
                    <p className="preset-empty">
                      No presets yet. Create one to configure a reusable group of sub-agents, then apply it wherever you need it.
                    </p>
                  ) : null}
            </div>

          </section>}

          {settingsSection === "models" &&
          <section className="settings-section">
            <div className="set-group">
              <h4>Accounts & connections</h4>
              <p>Select a provider to connect or manage its account. This does not change your defaults.</p>
            <div className="provider-cards">
              <button className={`provider-card ${accountProvider === "openai" ? "selected" : ""}`} aria-pressed={accountProvider === "openai"} onClick={() => setAccountProvider("openai")}>
                <span className="provider-logo openai">{local.openAiLogo === "codex" ? <CodexLogo size={18} /> : <OpenAILogo size={17} />}</span>
                <span><strong>OpenAI</strong><small>ChatGPT plan or API key</small></span>
                <span className={`provider-status ${codexAccountReady(account) && !accountChecks.openai ? "on" : ""}`} title={accountChecks.openai || (codexAccountReady(account) ? OPENAI_SIGNED_IN_NOTE : undefined)} aria-live="polite">{accountChecks.openai === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{accountConnectionLabel(accountChecks.openai, codexAccountReady(account), Boolean(runtimeStatus?.available), "Codex CLI needed", account?.type === "apiKey" ? "API key" : "Signed in")}</span>
                {accountProvider === "openai" && <Check size={16} />}
              </button>
              <button className={`provider-card ${accountProvider === "claude" ? "selected" : ""}`} aria-pressed={accountProvider === "claude"} onClick={() => setAccountProvider("claude")}>
                <span className={`provider-logo claude${local.claudeLogo === "anthropic" ? " anthropic-mark" : ""}`}>{local.claudeLogo === "anthropic" ? <AnthropicLogo size={17} /> : <ClaudeLogo size={18} />}</span>
                <span><strong>Anthropic</strong><small>Claude plan or API key</small></span>
                <span className={`provider-status ${claudeStatus?.loggedIn && !accountChecks.claude ? "on" : ""}`} title={accountChecks.claude} aria-live="polite">{accountChecks.claude === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{claudeUsesApiKey(claudeStatus) && !claudeStatus?.loggedIn && !accountChecks.claude ? "Key needed" : accountConnectionLabel(accountChecks.claude, Boolean(claudeStatus?.loggedIn), Boolean(claudeStatus?.available), "Claude Code needed", claudeUsesApiKey(claudeStatus) ? "API key" : "Connected")}</span>
                {accountProvider === "claude" && <Check size={16} />}
              </button>
              <button className={`provider-card ${accountProvider === "cursor" ? "selected" : ""}`} aria-pressed={accountProvider === "cursor"} onClick={() => setAccountProvider("cursor")}>
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <span><strong>Cursor</strong><small>Cursor subscription</small></span>
                <span className={`provider-status ${cursorStatus?.loggedIn && !cursorAccountCheck ? "on" : ""}`} title={cursorAccountCheck} aria-live="polite">{cursorAccountCheck === "Checking connection…" && <LoaderCircle className="spin" size={12} aria-hidden="true" />}{accountConnectionLabel(cursorAccountCheck, Boolean(cursorStatus?.loggedIn), Boolean(cursorStatus?.available), "Cursor Agent needed")}</span>
                {accountProvider === "cursor" && <Check size={16} />}
              </button>
              <button className={`provider-card ${accountProvider === "openrouter" ? "selected" : ""}`} aria-pressed={accountProvider === "openrouter"} onClick={() => setAccountProvider("openrouter")}>
                <span className="provider-logo openrouter"><OpenRouterLogo size={18} /></span>
                <span><strong>OpenRouter</strong><small>Pay-as-you-go API key</small></span>
                <span className={`provider-status ${openRouterReady ? "on" : ""}`}>{openRouterReady ? "Key saved" : "No key yet"}</span>
                {accountProvider === "openrouter" && <Check size={16} />}
              </button>
              <button className={`provider-card ${accountProvider === "lmstudio" ? "selected" : ""}`} aria-pressed={accountProvider === "lmstudio"} onClick={() => setAccountProvider("lmstudio")}>
                <span className="provider-logo lmstudio"><LmStudioLogo size={18} /></span>
                <span><strong>LM Studio</strong><small>Local models on this computer</small></span>
                <span className={`provider-status ${lmStudioReady ? "on" : ""}`}>{lmStudioReady ? "Connected" : "Not connected"}</span>
                {accountProvider === "lmstudio" && <Check size={16} />}
              </button>
            </div>

            {accountProvider === "openai" ? (
              <>
              <OpenAiApiKeyPanel visible={open} account={account} runtimeAvailable={Boolean(runtimeStatus?.available)} operation={openAiAuthOperation} disabled={openAiLoginStarting || busy} onChanged={onOpenAiBillingChanged} onBillingRead={setOpenAiBilling} />
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : openAiBilling === "apiKey" ? "OpenAI API connection" : "OpenAI connection"}</strong>
                  <small>{accountChecks.openai === "Checking connection…" ? accountChecks.openai : openAiBilling === "apiKey" && !account ? "Save or connect an API key above" : accountChecks.openai || (account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan · signed in to Codex` : account?.type === "apiKey" ? "Billed per token to your OpenAI API account · signed in to Codex" : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI required")}</small>
                </div>
                {codexAccountReady(account) ? (
                  <div className="credential-actions">
                    <span className={`connected-badge${accountChecks.openai ? " unverified" : ""}`} title={accountChecks.openai ? undefined : OPENAI_SIGNED_IN_NOTE} aria-live="polite">{accountChecks.openai === "Checking connection…" ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : !accountChecks.openai ? <Check size={12} /> : null} {accountChecks.openai === "Checking connection…" ? "Checking…" : accountChecks.openai ? "Unverified" : "Signed in"}</span>
                    <button className="secondary-button" onClick={() => void signOut()} disabled={busy || openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>Sign out</button>
                  </div>
                ) : openAiBilling !== "apiKey" || !runtimeStatus?.available ? (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy || openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>
                    {busy || openAiLoginStarting ? <LoaderCircle className="spin" size={14} /> : !runtimeStatus?.available ? <Download size={14} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex"}
                  </button>
                ) : null}
                {runtimeStatus?.available && <button className="icon-button" onClick={refreshOpenAi} title="Refresh OpenAI connection" aria-label="Refresh OpenAI connection" aria-busy={openAiRefreshing > 0} disabled={openAiLoginStarting || Boolean(openAiAuthOperation.busy)}>{openAiRefreshing ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button>}
              </div>
              </>
            ) : accountProvider === "openrouter" ? (
              <div className="credential-panel stacked" data-settings-row="openrouter-key">
                <div className="credential-status">
                  <div><strong>OpenRouter API key</strong><small>{openRouterReady ? "Stored securely on this device" : "No key stored"}</small></div>
                  {openRouterReady && <span className="connected-badge"><Check size={12} /> Connected</span>}
                </div>
                <div className="key-input-row">
                  <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  <button className="secondary-button" onClick={() => void storeKey()} disabled={!apiKey.trim() || busy}>Save key</button>
                </div>
              </div>
            ) : accountProvider === "lmstudio" ? (
              <div className="credential-panel stacked" data-settings-row="lmstudio-server">
                <div className="credential-status">
                  <div>
                    <strong>LM Studio local server</strong>
                    <small>{lmStudioReady ? `${lmStudioModels.length} model${lmStudioModels.length === 1 ? "" : "s"} available` : lmStudioModelsError || "Start the server from LM Studio’s Developer tab"}</small>
                  </div>
                  {lmStudioReady && <span className="connected-badge"><Check size={12} /> Connected</span>}
                </div>
                <label className="field-label">
                  <span>Server URL</span>
                  <input value={local.lmStudioBaseUrl} onChange={(event) => setLocal({ ...local, lmStudioBaseUrl: event.target.value })} placeholder={DEFAULT_LM_STUDIO_BASE_URL} spellCheck={false} />
                  <small>Mythra Code uses LM Studio’s OpenAI-compatible Responses API. Keep the default for a server on this computer.</small>
                </label>
                <div className="key-input-row">
                  <input type="password" value={lmStudioToken} onChange={(event) => setLmStudioToken(event.target.value)} placeholder={lmStudioTokenStored ? "Token stored in the OS credential store" : "Optional API token"} />
                  <button className="secondary-button" onClick={() => void storeLmStudioToken()} disabled={!lmStudioToken.trim() || busy}>Save token</button>
                  {lmStudioTokenStored && <button className="secondary-button" onClick={() => void storeLmStudioToken(true)} disabled={busy}>Remove</button>}
                </div>
                <div className="credential-status">
                  <small>{lmStudioConnectionMessage || "Authentication is optional for the default localhost server. Use a token for authenticated or network-accessible servers."}</small>
                  <button className="secondary-button" onClick={() => void testLmStudioConnection()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Test connection</button>
                </div>
              </div>
            ) : accountProvider === "claude" ? (
              <>
              <ClaudeBillingPanel visible={open} claudeStatus={claudeStatus} operation={claudeAuthOperation} disabled={claudeLoginStarting} onChanged={onClaudeBillingChanged ?? onClaudeRefresh} />
              <div className="credential-panel">
                <div>
                  <strong>{claudeUsesApiKey(claudeStatus) ? "Anthropic API key" : claudeStatus?.loggedIn ? claudeStatus.email || "Claude subscription" : "Claude Code subscription"}</strong>
                  <small>{accountChecks.claude || (claudeUsesApiKey(claudeStatus)
                    ? claudeStatus?.loggedIn ? `Billed per token through ${claudeStatus.version || "Claude Code"}` : claudeStatus?.warning || "Add an Anthropic API key above"
                    : claudeStatus?.loggedIn
                    ? `${claudeStatus.subscriptionType || claudeStatus.authMethod || "Claude"} plan connected · ${claudeStatus.version || "Claude Code"}`
                    : claudeStatus?.warning || (claudeStatus?.available ? "Claude Code detected · sign in to continue" : "Claude Code must be installed first"))}</small>
                </div>
                {claudeStatus?.loggedIn ? (
                  <span className={`connected-badge${accountChecks.claude ? " unverified" : ""}`} aria-live="polite">{accountChecks.claude === "Checking connection…" ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : !accountChecks.claude ? <Check size={12} /> : null} {accountChecks.claude === "Checking connection…" ? "Checking…" : accountChecks.claude ? "Unverified" : "Connected"}</span>
                ) : claudeUsesApiKey(claudeStatus) && claudeStatus?.available ? null : (
                  claudeLoginStarting ? (
                    <button className="secondary-button" onClick={() => void cancelClaudeLogin().catch(() => undefined)} title="Finish signing in in your browser, or cancel">
                      <LoaderCircle className="spin" size={14} /> Cancel sign-in
                    </button>
                  ) : (
                    <button className="secondary-button" onClick={() => void signInClaude()} disabled={Boolean(claudeAuthOperation.busy)}>
                      {!claudeStatus?.available ? <Download size={14} /> : null}
                      {claudeStatus?.available ? "Sign in" : "Install Claude Code"}
                    </button>
                  )
                )}
                <button className="icon-button" onClick={() => void refreshClaude()} title="Refresh Claude status" aria-label="Refresh Claude status" disabled={claudeLoginStarting || Boolean(claudeAuthOperation.busy)} aria-busy={claudeAuthOperation.busy === "refreshing"}>{claudeAuthOperation.busy === "refreshing" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}</button>
              </div>
              {claudeStatus?.loggedIn && claudeStatus.warning && <div className="settings-notice" role="status">
                <Info size={13} /><span>{claudeStatus.warning}</span>
                <button type="button" className="secondary-button" onClick={() => setSettingsSection("updates")}>Open Updates</button>
              </div>}
              </>
            ) : (
              <div className="credential-panel">
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <div>
                  <strong>{cursorStatus?.loggedIn ? cursorStatus.email || "Cursor subscription" : "Cursor Agent subscription"}</strong>
                  <small>{cursorAccountCheck || (cursorStatus?.loggedIn
                    ? "Signed in to Cursor Agent on this device"
                    : cursorStatus?.warning || (cursorStatus?.available ? "Cursor Agent detected · sign in to continue" : "Cursor Agent CLI must be installed first"))}</small>
                </div>
                {cursorStatus?.loggedIn && (
                  <span className={`connected-badge${cursorAccountCheck ? " unverified" : ""}`} aria-live="polite">{cursorAccountCheck === "Checking connection…" ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : !cursorAccountCheck ? <Check size={12} /> : null} {cursorAccountCheck === "Checking connection…" ? "Checking…" : cursorAccountCheck === "Waiting for sign-in…" ? "Signing in…" : cursorAccountCheck ? "Unverified" : "Connected"}</span>
                )}
                {(!cursorStatus?.loggedIn || cursorStatus.authVerified === false) && (
                  <button className="secondary-button" onClick={() => void (cursorStatus?.available ? onCursorSignIn() : openUrl("https://cursor.com/docs/cli/installation"))} disabled={cursorLoginStarting}>
                    {cursorLoginStarting ? <LoaderCircle className="spin" size={14} /> : !cursorStatus?.available ? <Download size={14} /> : null}
                    {cursorLoginStarting ? "Signing in…" : cursorStatus?.available ? "Sign in" : "Install Cursor Agent"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onCursorRefresh()} title="Refresh Cursor status" aria-label="Refresh Cursor status"><RotateCcw size={14} /></button>
              </div>
            )}

            <p className="settings-footnote" role="note" aria-label="Antigravity and Gemini account support">
              <Info size={14} aria-hidden="true" />
              <span><strong>Our stance on Antigravity and Gemini.</strong> We strongly advise against Gemini for coding: we do not consider its coding reliability good enough to recommend. We do not plan to add direct Antigravity or Gemini account integration—the complexity and account risks are not worth it. Google warns that third-party Antigravity access can lead to account suspension or termination. We’re not willing to risk our Google accounts—or yours—on that integration. If you want to use Gemini, we recommend its official website in your browser. Models offered through existing providers such as OpenRouter remain available.</span>
            </p>
            </div>
            <div className="set-group">
              <h4>Defaults for new threads</h4>
              <p>New threads start with this provider and model. Existing threads keep their own selections.</p>
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
                value={local.model}
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
                onChange={(model) => setLocal((current) => ({ ...current, model }))}
              />
              </div>
              </div>
              {local.provider === "claude" && !claudeModels.length
                ? <div className="settings-notice" role="status"><Info size={13} /><span>Showing Mythra Code’s built-in Claude list because the Claude Code catalog could not be read.</span><button type="button" className="secondary-button" onClick={() => void onClaudeRefresh()}>Retry</button></div>
                : <small className="set-control-help">{defaultModelHelp}</small>}
              </div>
              </div></div>
            </div>
          </section>}
            </div>
            <div className="modal-footer">
              {dirty && <span className="unsaved-hint"><span>{dirtyPanes.size ? `Unsaved changes in ${[...dirtyPanes].map((pane) => SETTINGS_PANES.get(pane)?.label ?? pane).join(", ")}` : "Unsaved changes"}</span>{terminalTimeoutInvalid && <span role="status">· Fix the terminal timeout in Runtime to save</span>}</span>}
              <button className="secondary-button" onClick={requestClose}>Cancel</button>
              <button className="primary-button" onClick={saveSettings} disabled={!projectDefaultsComplete || terminalTimeoutInvalid}>Save settings</button>
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
      <p>Mythra Code uses the official GitHub CLI and never injects its token into prompts or project files. Agents with command access can still run credential-aware CLI tools, so use the same care you would in a terminal.</p>
      <div className="credential-panel github-account-panel">
        <span className="github-avatar-placeholder"><GitFork size={18} /></span>
        <div>
          <strong>{status?.authenticated ? status.name || status.login || "GitHub account" : status?.available ? status.error ? "GitHub account needs attention" : "GitHub is ready to connect" : "GitHub CLI is required"}</strong>
          <small role={!status?.authenticated && status?.error ? "alert" : undefined}>{status?.authenticated ? `@${status.login}${status.email ? ` · ${status.email}` : ""}` : status?.error || (status?.available ? "Sign in to GitHub to connect Mythra Code." : "Install GitHub CLI to connect repositories.")}</small>
        </div>
        {status?.authenticated ? (
          <span className="connected-badge"><Check size={12} /> Connected</span>
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
      <p>Download a GitHub repository into a new local folder and add it to Mythra Code as a project.</p>
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
      <p id="github-clone-url-help" className="github-clone-hint" role="status">{cloneUrl.trim() && !target ? "Enter a GitHub repository URL with a folder name supported on macOS and Windows." : "Choose the parent folder, not the repository folder itself. Mythra Code creates a new repository-named folder inside that parent. Existing folders are never overwritten."}</p>
      {target && cloneParent && <p id="github-clone-destination" className="github-clone-destination" role="status"><strong>Clone into</strong>{" "}<span className="github-clone-path">{joinPath(cloneParent, target.name)}</span></p>}
      {folderError && <p className="github-clone-error" role="alert">{folderError}</p>}
      <button type="button" className="primary-button" disabled={!status?.authenticated || busy || choosing || !target || !cloneParent} aria-describedby={target && cloneParent ? "github-clone-destination" : "github-clone-url-help"} onClick={() => void clone()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} Clone repository</button>
      </div></div>
    </section>
  </>;
}

const USAGE_DISPLAY_OPTIONS: ReadonlyArray<{ id: UsageDisplayMode; label: string }> = [
  { id: "remaining", label: "Percentage remaining" },
  { id: "consumed", label: "Percentage consumed" },
];

function UsageDisplaySettings({ value, onChange }: { value: UsageDisplayMode; onChange: (value: UsageDisplayMode) => void }) {
  return <section className="set-group">
    <h4>Provider quota display</h4>
    <div className="set-card"><div className="set-row usage-display-layout">
      <div className="set-copy">
        <strong>Read limits as</strong>
        <small id="usage-display-help">Choose the direction Mythra Code reads subscription limits in. The choice applies everywhere a live provider quota appears — the usage card in the studio dock, OpenAI/Codex rate limits, and Claude Code rate limits — including each window&rsquo;s length and reset time.</small>
      </div>
      <div className="set-control usage-display-controls">
        <div className="usage-display-options" role="radiogroup" aria-label="Provider quota display" aria-describedby="usage-display-help">
          {USAGE_DISPLAY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={value === option.id}
              className={value === option.id ? "selected" : ""}
              onClick={() => onChange(option.id)}
            >
              <strong>{option.label}</strong>
              {value === option.id && <Check size={14} />}
            </button>
          ))}
        </div>
        {/* Rendered through the same helper the live cards use, so the example can
            never describe a format the app does not actually produce. */}
        <div className="usage-display-preview"><Gauge size={13} /><span>Example · 5h window {usagePercentLabel(42, value)}</span></div>
      </div>
    </div></div>
  </section>;
}

function ProjectDefaultsSettings({ projects, activeProjectId, settings, runtimeModels, claudeModels, cursorModels, openRouterModels, lmStudioModels, modelFavorites, onToggleModelFavorite, onDiscoverOpenRouterModels, onProjects, onThemePreview, onEffortSliderPreview, onChatFontPreview }: {
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
    { value: "", label: "Use global font", detail: CHAT_FONTS.find((font) => font.id === settings.chatFont)?.name ?? settings.chatFont, icon: <RotateCcw size={14} /> },
    ...CHAT_FONTS.map((font) => ({
      value: font.id,
      label: font.name,
      detail: font.description,
      icon: <BookOpenCheck size={14} />,
    })),
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
    if (!await confirmDialog(`Remove the project-specific defaults for “${project.name}”? The project itself will stay in Mythra Code.`)) return;
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
    <section className="settings-section project-defaults-settings">
      {!projects.length && <div className="project-default-empty"><FolderCog size={18} /><span><strong>Add a project first</strong><small>Projects come from the sidebar. Once one exists, give it its own provider, model, app theme, effort-slider theme, or chat font here.</small></span></div>}

      {!projects.length ? null : configured.length ? <div className="project-default-list">{configured.map((project) => {
        const defaults = project.overrides!.defaults!;
        const modelOptions = modelOptionsForProvider(defaults.provider, defaults.model, catalogs);
        const selectedDisplay = supersededClaudeDisplay(defaults.provider, defaults.model, catalogs);
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
              <span><strong>{project.name}</strong><small>{project.path}</small></span>
              <button type="button" className="icon-button project-default-remove" aria-label={`Remove defaults for ${project.name}`} title="Remove project defaults" onClick={() => void removeProject(project)}><Trash2 size={13} /></button>
            </div>
            <div className="project-default-grid">
              <div className="project-default-field"><span>Provider</span><AppSelectMenu value={defaults.provider} options={PROJECT_PROVIDER_OPTIONS} ariaLabel={`Default provider for ${project.name}`} menuPlacement="top" onChange={(value) => setProvider(value as Provider)} /></div>
              <div className="project-default-field project-default-model"><span>Model</span><AppSelectMenu value={defaults.model} options={modelOptions} selectedDisplay={selectedDisplay} ariaLabel={`Default model for ${project.name}`} placeholder="Choose a model…" searchable={modelOptions.length > 8 || defaults.provider === "openrouter" || defaults.provider === "lmstudio" || defaults.provider === "cursor"} menuPlacement="top" favorites={favoriteModels(modelFavorites, defaults.provider)} {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(defaults.provider, model) } : {})} {...(defaults.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})} emptyMessage={defaults.provider === "lmstudio" ? "Connect LM Studio and refresh its catalog first." : "No models are currently available for this provider."} onChange={(model) => updateDefaults(project.id, (current) => ({ ...current, model }))} /></div>
              <div className="project-default-field"><span>App theme</span><AppSelectMenu value={defaults.theme ?? ""} options={themeOptions} ariaLabel={`App theme for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.theme = value as ThemeName; else delete next.theme; return next; }); if (project.id === activeProjectId) onThemePreview((value || settings.theme) as ThemeName); }} /></div>
              <div className="project-default-field"><span>Effort slider</span><AppSelectMenu value={defaults.effortSlider ?? ""} options={effortOptions} ariaLabel={`Effort slider for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.effortSlider = value as EffortSliderStyle; else delete next.effortSlider; return next; }); if (project.id === activeProjectId) onEffortSliderPreview((value || settings.effortSlider) as EffortSliderStyle); }} /></div>
              <div className="project-default-field"><span>Chat font</span><AppSelectMenu value={defaults.chatFont ?? ""} options={fontOptions} ariaLabel={`Chat font for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.chatFont = value as ChatFont; else delete next.chatFont; return next; }); if (project.id === activeProjectId) onChatFontPreview((value || settings.chatFont) as ChatFont); }} /></div>
            </div>
            {!defaults.model && <p className="project-default-warning">Choose a model before saving these project defaults.</p>}
          </article>
        );
      })}</div> : <div className="project-default-empty"><FolderCog size={18} /><span><strong>No projects override the global defaults yet</strong><small>Add a project below to give it its own provider, model, app theme, effort-slider theme, or chat font.</small></span></div>}

      {projects.length > 0 && <div className="project-default-add">
        <div className="project-default-field"><span>Choose a project to override global defaults</span><AppSelectMenu value={projectToAdd} options={projectOptions} ariaLabel="Project to configure" placeholder={projects.length ? "Choose a project…" : "No projects available"} searchable={projectOptions.length > 8} menuPlacement="top" emptyMessage="Every existing project already has project-specific defaults." onChange={setProjectToAdd} /></div>
        <button type="button" onClick={addProject} disabled={!projectToAdd}><Plus size={12} /> Set defaults</button>
      </div>}
      <p className="settings-footnote" role="note"><Info size={13} /><span><strong>Looking for project instructions?</strong> Open that project’s chat, then choose Project instructions beside the project name at the top of the window.</span></p>
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

/** The Luna to fall back on before an account catalog has been read. The same
 *  known id run-command discovery starts from — never a guess at one that
 *  might exist. */
const FALLBACK_LUNA_MODEL = "gpt-5.6-luna";

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
        detail: luna
          ? luna.fromCatalog
            ? `Newest Luna in your account · ${luna.id}`
            : `${FALLBACK_LUNA_MODEL} until your account catalog loads`
          : "Your account catalog has no Luna — pick a model instead",
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
        <span>Provider</span>
        <AppSelectMenu
          value={provider}
          options={PROJECT_PROVIDER_OPTIONS}
          ariaLabel="Thread title provider"
          menuPlacement="top"
          onChange={(value) => switchProvider(value as Provider)}
        />
      </div>
      <div className="field-label">
        <span>Model</span>
        <AppSelectMenu
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
            : needsRestart ? "The installed Codex runtime differs from the one Mythra Code is running."
            : provablyCurrent ? `${name} is up to date.`
              : `Check for the latest ${name} release.`;
  const actionLabel = status?.installed === false ? `Install ${name}` : `Update ${name}`;
  return <div className={`update-card developer-runtime-update-card ${state}`}>
    <div className="update-version-row">
      {/* Before the first check there is no version to report, so the card says
          so plainly instead of printing a name trailed by an ellipsis. */}
      <span><small>{status?.installedVersionStale ? "Previously detected" : status?.installed ? `Installed · ${status.source ?? "Local runtime"}` : "Local runtime"}</small><strong>{status?.currentVersion ? `${name} ${status.currentVersion}` : status?.installed === false ? `${name} · not installed` : name}</strong></span>
      {status?.latestVersion && <span className={`update-version-available${status.latestVersionStale ? " stale" : ""}`}><small>{status.latestVersionStale ? "Last known latest" : "Latest"}</small><strong>{status.latestVersion}</strong>{status.latestVersionStale && status.latestVersionCheckedAt && <small>Checked {new Date(status.latestVersionCheckedAt).toLocaleString()}</small>}</span>}
    </div>
    <div className="update-status-row">
      {(updating || updater.checking) && <LoaderCircle className="spin" size={15} />}
      {!updating && !updater.checking && provablyCurrent && <Check size={15} />}
      {!updating && !updater.checking && (status?.error || stale) && <Info size={15} />}
      {!updating && !updater.checking && !status?.error && !stale && status?.updateAvailable && <Download size={15} />}
      <span>{detail}</span>
    </div>
    {target === "codex" && status?.runningVersion && <div className="runtime-running-version">
      <span>{status.installedVersionStale ? "Previously running in Mythra Code" : "Running in Mythra Code"}</span>
      <strong>Codex {status.runningVersion}</strong>
    </div>}
    {status?.notice && <div className="update-status-row runtime-activation-note"><Info size={15} /><span>{status.installedVersionStale ? `Previously reported: ${status.notice}` : status.notice}</span></div>}
    {needsRestart && !updater.checking && !updating && !status?.notice && <div className="update-status-row runtime-activation-note"><Info size={15} /><span>Finish active work, then restart Mythra Code to use the installed version. Nothing running will be interrupted automatically.</span></div>}
    {target === "claude" && status?.installed && !status.installedVersionStale && <p className="runtime-launch-note">New Mythra Code runs use the installed version. Claude Code already open in a terminal needs a separate restart.</p>}
    {(status?.path || status?.runningPath) && <details className="runtime-executable-paths">
      <summary>{status.installedVersionStale ? "Previously detected executable locations" : "Executable locations"}</summary>
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

function UpdateSettings({ appUpdater, developerRuntimeUpdater }: { appUpdater: AppUpdater; developerRuntimeUpdater: DeveloperRuntimeUpdater }) {
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


  return <section className="update-settings-section">
    <div className="set-group">
    <div className="set-group-head"><h4>Mythra Code</h4><span className="set-group-note">signed releases from the public repository</span></div>
    <div className={`update-card ${appUpdater.phase}`}>
      <div className="update-version-row">
        <span><small>Installed</small><strong>Mythra Code {appUpdater.currentVersion}</strong></span>
        {appUpdater.availableVersion && <span className="update-version-available"><small>Available</small><strong>{appUpdater.availableVersion}</strong></span>}
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
          <button className="primary-button" onClick={() => void appUpdater.downloadAndRestart()}><Download size={13} /> Download, install, and restart</button>
        ) : appUpdater.phase === "error" ? (
          <button className="secondary-button" disabled={busy} onClick={() => void appUpdater.checkForUpdates()}><RotateCcw size={13} /> Try again</button>
        ) : null}
      </div>
    </div>
    </div>
    <div className="set-group">
    <div className="set-group-head"><h4>Developer runtimes</h4><span className="set-group-note">the local Claude Code and Codex installs Mythra Code drives</span></div>
    <div className="developer-runtime-update-grid">
      <DeveloperRuntimeUpdateCard target="claude" name="Claude Code" status={developerRuntimeUpdater.status?.claude ?? null} updater={developerRuntimeUpdater} />
      <DeveloperRuntimeUpdateCard target="codex" name="Codex" status={developerRuntimeUpdater.status?.codex ?? null} updater={developerRuntimeUpdater} />
    </div>
    {developerRuntimeUpdater.error && <div className="update-card developer-runtime-result error" role="alert"><div className="update-status-row"><Info size={13} /><span>{developerRuntimeUpdater.error}</span></div><div className="update-actions"><button className="secondary-button" disabled={developerRuntimeUpdater.checking || developerRuntimeUpdater.updating !== null} onClick={() => void developerRuntimeUpdater.checkForUpdates()}><RotateCcw size={13} /> Check again</button></div></div>}
    {developerRuntimeUpdater.message && <div className="update-card developer-runtime-result" role="status"><div className="update-status-row"><Check size={13} /><span>{developerRuntimeUpdater.message.slice(-2_000)}</span></div></div>}
    </div>
    <div className="update-trust-row"><ShieldCheck size={14} /><span><strong>Official distribution channels</strong><small>Mythra Code packages must match this app’s updater key. Claude Code and Codex installers are fetched over HTTPS from their official publishers and verify the release assets they install.</small></span></div>
  </section>;
}

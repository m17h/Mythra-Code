import { useEffect, useId, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/confirmDialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Boxes,
  BookOpenCheck,
  CalendarClock,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderCog,
  Gauge,
  GitFork,
  Info,
  KeyRound,
  LoaderCircle,
  NotebookPen,
  Palette,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { exportDiagnostics, recentAuditRows, rpc, saveLmStudioKey, saveOpenRouterKey, type AuditRow, type CodexRuntimeStatus } from "../lib/codex";
import { visibleClaudeModels, type ClaudeRuntimeStatus } from "../lib/claude";
import type { CursorModel, CursorRuntimeStatus } from "../lib/cursor";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_LM_STUDIO_BASE_URL, DEFAULT_OPENAI_MODEL, DEFAULT_SETTINGS, EFFORT_SLIDER_STYLES, RELEASE_NOTES_URL, THEMES } from "../lib/appConfig";
import { friendlyError } from "../lib/errors";
import { useModalFocus } from "../hooks/useModalFocus";
import { AnthropicLogo, ClaudeLogo, CodexLogo, CursorDarkAppIcon, CursorLogo, LmStudioLogo, OpenAILogo, OpenRouterLogo, ProviderLogo } from "./BrandLogos";
import type { LMStudioModel } from "../lib/lmStudio";
import { updateProgress, type AppUpdater } from "../lib/appUpdater";
import {
  projectSubagentSettingsFromApp,
  providerDisplayName,
  sanitizeChildAgentPresetPolicy,
  sanitizeChildAgentPresets,
  sanitizeProjectSubagentOverrides,
  uniqueChildAgentPresetId,
  MAX_CHILD_AGENT_PRESETS,
  type ChildAgentReadiness,
} from "../lib/childAgents";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { SubagentPolicyEditor } from "./SubagentPolicyEditor";
import { HarnessSettings } from "./HarnessSettings";
import { SkillLibrary } from "./SkillLibrary";
import type { McpView } from "./StudioDock";
import type { GitHubAccountStatus } from "../lib/github";
import { formatEstimatedCost, type UsageTotals } from "../lib/usageLedger";
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
  UsageDisplayMode,
} from "../types";
import { usagePercentLabel } from "../lib/providerUsage";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { CLAUDE_FALLBACK_MODELS } from "./ClaudeModelControl";
import { openAiModelOptions, type RuntimeModel } from "./ModelPowerControl";
import { favoriteModels, type ModelFavorites } from "../lib/modelFavorites";
import type { ChildAgentModelOption } from "./ChildAgentRoster";
import type { ClaudeModel } from "../lib/claude";
import type { OpenRouterModel } from "./OpenRouterModelControl";
import { sanitizeProjectDefaultOverrides } from "../lib/projectDefaults";
import { modelForProvider } from "../lib/threadProvider";
import { cachedDeveloperRuntimeUpdates, checkDeveloperRuntimeUpdates, ensureDeveloperRuntimeUpdates, updateDeveloperRuntime, type DeveloperRuntimeTarget, type DeveloperRuntimeTargetStatus, type DeveloperRuntimeUpdater } from "../lib/runtimeUpdates";

/**
 * Single source of truth for the settings navigation: the rail, the pane
 * heading, and its supporting line all read from here, so a label can never
 * drift between the button and the pane it opens.
 */
const SETTINGS_NAV: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ id: SettingsSection; label: string; icon: typeof Palette; detail: string }>;
}> = [
  {
    group: "Workspace",
    items: [
      { id: "general", label: "Interface", icon: Palette, detail: "How Mythra Code looks: theme, effort slider, and chat typography" },
      { id: "projects", label: "Projects", icon: FolderCog, detail: "Project-specific model and appearance defaults" },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { id: "models", label: "Models & accounts", icon: KeyRound, detail: "Default provider, credentials, and model routing" },
      { id: "github", label: "GitHub", icon: GitFork, detail: "Account connection and repository cloning" },
      { id: "usage", label: "Usage", icon: Gauge, detail: "All-time tokens and API-equivalent inference value" },
      { id: "prompts", label: "Prompts", icon: NotebookPen, detail: "Your complete harness instruction and reusable profiles" },
      { id: "agents", label: "Sub-agents", icon: UsersRound, detail: "Automatic cleanup and reusable sub-agent setups" },
    ],
  },
  {
    group: "Automation",
    items: [
      { id: "workflows", label: "Workflows", icon: Play, detail: "Multi-step recipes, triggers, commands, skills, and traceable runs" },
      { id: "scheduled-tasks", label: "Scheduled tasks", icon: CalendarClock, detail: "Recurring unattended prompts in chats or projects" },
      { id: "skills", label: "Skills", icon: Boxes, detail: "Local Markdown workflows with model-facing invocation names" },
      { id: "tools", label: "Tools & MCP", icon: Wrench, detail: "Model Context Protocol servers and live tool controls" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "system", label: "Runtime & diagnostics", icon: Wrench, detail: "Getting started, background behavior, and local diagnostics" },
      { id: "updates", label: "Updates", icon: Download, detail: "Secure releases delivered directly from the Mythra Code repository" },
    ],
  },
];

const SETTINGS_PANES = new Map(SETTINGS_NAV.flatMap((section) => section.items.map((item) => [item.id, item] as const)));

// Picker-only metadata stays in the lazy Settings chunk. The actual stacks
// live in CSS, while startup only needs the compact persisted id sanitizer.
// Keep these ids synchronized with sanitizeChatFont and --chat-font-*.
const CHAT_FONTS: ReadonlyArray<{ id: ChatFont; name: string; description: string }> = [
  { id: "system", name: "Interface default", description: "The same typeface as the rest of Mythra Code" },
  { id: "humanist", name: "Humanist sans", description: "Open, warm letterforms with a little more air" },
  { id: "serif", name: "Reading serif", description: "Book-like text for long answers" },
  { id: "mono", name: "Monospace", description: "Fixed-width throughout, like a terminal" },
];

const PROJECT_PROVIDER_OPTIONS: AppSelectOption[] = [
  { value: "openai", label: "OpenAI", detail: "ChatGPT subscription", icon: <ProviderLogo provider="openai" size={15} /> },
  { value: "claude", label: "Claude", detail: "Claude Code subscription", icon: <ProviderLogo provider="claude" size={15} /> },
  { value: "cursor", label: "Cursor", detail: "Cursor subscription", icon: <ProviderLogo provider="cursor" size={15} /> },
  { value: "openrouter", label: "OpenRouter", detail: "API model routing", icon: <ProviderLogo provider="openrouter" size={15} /> },
  { value: "lmstudio", label: "LM Studio", detail: "Local models", icon: <ProviderLogo provider="lmstudio" size={15} /> },
];

function modelOptionsForProvider(provider: Provider, selectedModel: string, catalogs: {
  runtimeModels: RuntimeModel[];
  claudeModels: ClaudeModel[];
  cursorModels: CursorModel[];
  openRouterModels: OpenRouterModel[];
  lmStudioModels: LMStudioModel[];
}): AppSelectOption[] {
  let options: AppSelectOption[];
  if (provider === "openai") {
    options = openAiModelOptions(catalogs.runtimeModels).map((entry) => ({ value: entry.id, label: entry.name, detail: entry.tagline }));
  } else if (provider === "claude") {
    options = (catalogs.claudeModels.length ? visibleClaudeModels(catalogs.claudeModels).filter((entry) => !entry.disabled) : CLAUDE_FALLBACK_MODELS).map((entry) => ({
      value: entry.id,
      label: entry.displayName,
      detail: entry.description || entry.resolvedModel,
      keywords: entry.resolvedModel,
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
  if (selectedModel && !options.some((entry) => entry.value === selectedModel)) {
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

export function useDeveloperRuntimeUpdater(
  onClaudeRefresh: (() => Promise<ClaudeRuntimeStatus>) | undefined,
  enabled: boolean,
): DeveloperRuntimeUpdater {
  const [status, setStatus] = useState(() => cachedDeveloperRuntimeUpdates());
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<DeveloperRuntimeTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestRef = useRef(0);

  const checkForUpdates = async () => {
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
      if (requestRef.current === request) setChecking(false);
    }
  };

  useEffect(() => {
    if (!enabled || !isTauri() || status) return;
    const request = ++requestRef.current;
    setChecking(true);
    void ensureDeveloperRuntimeUpdates()
      .then((next) => { if (requestRef.current === request) setStatus(next); })
      .catch((reason) => { if (requestRef.current === request) setError(friendlyError(reason)); })
      .finally(() => { if (requestRef.current === request) setChecking(false); });
    // The injected updater and initial cache decision are fixed for this
    // Settings mount; manual checks own subsequent refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const updateRuntime = async (target: DeveloperRuntimeTarget) => {
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
      if (requestRef.current === request) setError(friendlyError(reason));
    } finally {
      setUpdating((current) => current === target ? null : current);
    }
  };

  return { status, checking, updating, error, message, checkForUpdates, updateRuntime };
}

export function SettingsModal({
  open,
  initialSection,
  appUpdater,
  developerRuntimeUpdater: injectedDeveloperRuntimeUpdater,
  settings,
  account,
  runtimeStatus,
  claudeStatus = null,
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
  githubStatus,
  githubBusy = false,
  usageTotals,
  onClose,
  onSave,
  onThemePreview,
  onEffortSliderPreview,
  onChatFontPreview,
  onSignIn,
  onClaudeSignIn = async () => {},
  onClaudeRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null }),
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
  agents,
  actions,
  schedules,
  workflows,
  workflowRuns,
  projects,
  activeProjectId = null,
  skillsFolder,
  skills,
  removedSkills,
  skillsBusy,
  skillsError,
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
  onImportSkills,
  onCreateSkill,
  onReadSkill,
  onUpdateSkill,
  onRenameSkill,
  onToggleSkill,
  onRemoveSkill,
  onRestoreSkill,
  onOpenOnboarding,
}: {
  open: boolean;
  initialSection: SettingsSection;
  appUpdater: AppUpdater;
  developerRuntimeUpdater?: DeveloperRuntimeUpdater;
  settings: AppSettings;
  account: Account | null;
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus?: ClaudeRuntimeStatus | null;
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
  githubStatus: GitHubAccountStatus | null;
  githubBusy?: boolean;
  usageTotals: UsageTotals;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onThemePreview: (theme: ThemeName) => void;
  onEffortSliderPreview: (style: EffortSliderStyle) => void;
  onChatFontPreview: (font: ChatFont) => void;
  onSignIn: () => Promise<void>;
  onClaudeSignIn?: () => Promise<void>;
  onClaudeRefresh?: () => Promise<ClaudeRuntimeStatus>;
  onCursorSignIn?: () => Promise<void>;
  onCursorRefresh?: () => Promise<CursorRuntimeStatus>;
  onRuntimeRequired: () => void;
  onWorkspaceTools: () => void;
  onOpenRouterChange: (ready: boolean) => void;
  onLMStudioRefresh?: (baseUrl: string) => Promise<LMStudioModel[]>;
  onLMStudioTokenChange?: (stored: boolean) => void;
  onGitHubSignIn: () => Promise<void>;
  onGitHubRefresh: () => Promise<void>;
  onGitHubClone: (url: string, folderName: string) => Promise<boolean>;
  onError: (error: string | null) => void;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  activeProjectId?: string | null;
  skillsFolder: string;
  skills: LocalSkill[];
  removedSkills: LocalSkill[];
  skillsBusy: boolean;
  skillsError: string;
  mcpServers?: McpView[];
  onMcpChanged?: () => void;
  workspaceToolsAvailable: boolean;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  onProjects: (value: Project[]) => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
  onChooseSkillsFolder: () => void;
  onRefreshSkills: (silent?: boolean) => Promise<void> | void;
  onImportSkills: () => void;
  onCreateSkill: (name: string, instructions: string) => Promise<boolean>;
  onReadSkill: (path: string) => Promise<string>;
  onUpdateSkill: (path: string, content: string, original: string) => Promise<void>;
  onRenameSkill: (path: string, name: string) => boolean;
  onToggleSkill: (path: string) => void;
  onRemoveSkill: (path: string, deleteSource: boolean) => Promise<boolean>;
  onRestoreSkill: (path: string) => Promise<boolean>;
  onOpenOnboarding: () => void;
}) {
  const managedDeveloperRuntimeUpdater = useDeveloperRuntimeUpdater(onClaudeRefresh, !injectedDeveloperRuntimeUpdater);
  const developerRuntimeUpdater = injectedDeveloperRuntimeUpdater ?? managedDeveloperRuntimeUpdater;
  const [local, setLocal] = useState(settings);
  const [localProjects, setLocalProjects] = useState(projects);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  const [renamingPresetId, setRenamingPresetId] = useState<string | null>(null);
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [presetDraftName, setPresetDraftName] = useState("");
  const [policyNotice, setPolicyNotice] = useState("");
  const subagentPanelId = useId();
  const [apiKey, setApiKey] = useState("");
  const [lmStudioToken, setLmStudioToken] = useState("");
  const [lmStudioConnectionMessage, setLmStudioConnectionMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSection);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneFolder, setCloneFolder] = useState("");
  const githubRefreshRequestedRef = useRef(false);
  const skillsRefreshRef = useRef(onRefreshSkills);
  skillsRefreshRef.current = onRefreshSkills;

  const defaultModelOptions = useMemo<AppSelectOption[]>(() => {
    return modelOptionsForProvider(local.provider, local.model, {
      runtimeModels,
      claudeModels,
      cursorModels,
      openRouterModels,
      lmStudioModels,
    });
  }, [claudeModels, cursorModels, lmStudioModels, local.model, local.provider, openRouterModels, runtimeModels]);

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

  const defaultModelHelp = local.provider === "openrouter"
    ? "Search the live OpenRouter catalog. New threads will start with this model."
    : local.provider === "lmstudio"
      ? "Choose from the models reported by the configured LM Studio server."
      : local.provider === "claude"
        ? (claudeModels.length
          ? "Live catalog from your Claude Code CLI."
          : "Mythra Code’s built-in list — the Claude Code CLI catalog could not be read.")
        : local.provider === "cursor"
          ? "Choose from the live catalog associated with your Cursor subscription."
          : "Availability follows the signed-in ChatGPT account.";
  const developerUpdateAvailable = Boolean(
    developerRuntimeUpdater.status?.claude.updateAvailable
    || developerRuntimeUpdater.status?.codex.updateAvailable,
  );
  const anyUpdateAvailable = appUpdater.phase === "available" || developerUpdateAvailable;

  // Buffered edits (theme, prompt, toggles) are discarded on close — warn
  // before silently throwing away work like a hand-written system prompt.
  const dirty = open && (JSON.stringify(local) !== JSON.stringify(settings) || JSON.stringify(localProjects) !== JSON.stringify(projects));
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
  const draftBaselineRef = useRef({ settings, projects });
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
      draftBaselineRef.current = { settings, projects };
      setLocal(settings);
      setLocalProjects(projects);
      setExpandedPresetId(null);
      setRenamingPresetId(null);
      setCreatingPreset(false);
      setPresetDraftName("");
      setPolicyNotice("");
      const activeDefaults = projects.find((project) => project.id === activeProjectId)?.overrides?.defaults;
      onThemePreview(activeDefaults?.theme ?? settings.theme);
      onEffortSliderPreview(activeDefaults?.effortSlider ?? settings.effortSlider);
      onChatFontPreview(activeDefaults?.chatFont ?? settings.chatFont);
      setSettingsSection(initialSection);
      return;
    }
    const baseline = draftBaselineRef.current;
    if (settings !== baseline.settings) {
      // Adopt external settings changes only when the draft is untouched, so
      // the dirty check keeps meaning "you have unsaved edits".
      setLocal((current) => (JSON.stringify(current) === JSON.stringify(baseline.settings) ? settings : current));
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
    draftBaselineRef.current = { settings, projects };
  }, [activeProjectId, initialSection, onChatFontPreview, onEffortSliderPreview, onThemePreview, open, projects, settings]);

  useEffect(() => {
    if (open && initialSection === "general" && appUpdater.phase === "available") {
      setSettingsSection("updates");
    }
  }, [appUpdater.phase, initialSection, open]);

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
    if (!open || settingsSection !== "skills" || !skillsFolder) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async (silent: boolean) => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        await skillsRefreshRef.current(silent);
      } finally {
        inFlight = false;
      }
    };
    void refresh(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 2_000);
    const onFocus = () => void refresh(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [open, settingsSection, skillsFolder]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
    setBusy(true);
    onError(null);
    try {
      await onSignIn();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await rpc("account/logout");
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
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

  const exportDiagnosticBundle = async () => {
    try {
      const path = await save({ title: "Export Mythra Code diagnostics", defaultPath: `mythra-code-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) await exportDiagnostics(path);
    } catch (reason) { onError(friendlyError(reason)); }
  };

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
  const saveSettings = () => {
    const nextProjects = sanitizeProjectDefaultOverrides(sanitizeProjectSubagentOverrides(localProjects));
    const normalizedSubagents = projectSubagentSettingsFromApp(local);
    onProjects(nextProjects);
    onSave({
      ...local,
      childAgents: normalizedSubagents.childAgents,
      childAgentPresets: sanitizeChildAgentPresets(local.childAgentPresets),
      subagentMax: normalizedSubagents.maxConcurrent,
    });
  };

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} onMouseDown={requestClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div ref={dialogRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><h2 id="settings-title">Settings</h2><p>Customize Mythra Code without hidden configuration.</p></div>
          <button className="icon-button" onClick={requestClose} aria-label="Close settings"><X size={18} /></button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_NAV.map((section) => (
              <div className="settings-nav-group" key={section.group} role="group" aria-label={section.group}>
                <span className="settings-nav-label" aria-hidden>{section.group}</span>
                {section.items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className={settingsSection === id ? "active" : ""}
                    onClick={() => setSettingsSection(id)}
                    aria-current={settingsSection === id ? "page" : undefined}
                  >
                    <Icon size={14} /><span>{label}</span>{id === "updates" && anyUpdateAvailable && <span className="settings-update-dot" role="img" aria-label="Update available" />}<ChevronRight size={12} />
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-content">
          <div className="settings-pane-heading">
            <span>{SETTINGS_PANES.get(settingsSection)?.label}</span>
            <small>{SETTINGS_PANES.get(settingsSection)?.detail}</small>
          </div>
          {settingsSection === "system" &&
          <section className="settings-section getting-started-settings">
            <div className="settings-section-heading settings-heading-with-action">
              <div className="settings-icon"><BookOpenCheck size={17} /></div>
              <div><h3>Getting started</h3><p>Review model setup, projects and chats, permissions, and local skills.</p></div>
              <button type="button" className="secondary-button" onClick={requestOnboarding}>Run onboarding</button>
            </div>
          </section>}

          {settingsSection === "general" &&
          <section className="settings-section theme-settings-section">
            <div className="settings-section-heading settings-heading-with-action">
              <div className="settings-icon"><Palette size={17} /></div>
              <div><h3>Appearance</h3><p>Theme, slider, and typeface preview instantly. Interface size applies when you save.</p></div>
              <button type="button" className="default-theme-button" onClick={() => previewTheme(DEFAULT_SETTINGS.theme)} disabled={local.theme === DEFAULT_SETTINGS.theme}>
                <RotateCcw size={12} /> Default theme
              </button>
            </div>
            <div className="theme-grid">
              {THEMES.map((theme) => (
                <button
                  type="button"
                  key={theme.id}
                  className={`theme-card ${local.theme === theme.id ? "selected" : ""}`}
                  aria-pressed={local.theme === theme.id}
                  onClick={() => previewTheme(theme.id)}
                >
                  <span className="theme-preview" style={{ background: theme.swatches[0] }}>
                    <i style={{ background: theme.swatches[1] }} />
                    <i style={{ background: theme.swatches[2] }} />
                  </span>
                  <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  {local.theme === theme.id && <Check size={14} />}
                </button>
              ))}
            </div>
            <div className="slider-style-heading">
              <strong>Interface size</strong>
              <small>Scale the complete app, including chat text, without changing the selected typeface.</small>
            </div>
            <div className="runtime-field-grid interface-size-grid">
              <label><span>Interface size</span><select value={local.uiScale ?? 100} onChange={(event) => setLocal({ ...local, uiScale: Number(event.target.value) })}><option value={90}>Compact (90%)</option><option value={100}>Default (100%)</option><option value={110}>Comfortable (110%)</option><option value={125}>Large (125%)</option></select></label>
            </div>
            <div className="slider-style-heading">
              <strong>Effort slider style</strong>
              <small>How the reasoning-effort slider looks across every provider. Previewed instantly; save to keep.</small>
            </div>
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
            <div className="slider-style-heading">
              <strong>Chat typeface</strong>
              <small>Applies to conversation text and the message composer only — the rest of the interface keeps its own type. Code stays monospaced.</small>
            </div>
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
          </section>}

          {settingsSection === "prompts" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><NotebookPen size={17} /></div>
              <div><h3>System prompts</h3><p>Mythra Code applies the global layer first, followed by the selected subscription’s own layer.</p></div>
            </div>
            <div className="prompt-file-notice" role="note">
              <Info size={16} />
              <p><strong>Global instruction files are not inherited.</strong> Your global <code>CLAUDE.md</code> and <code>AGENTS.md</code> do not affect Mythra Code. Add those instructions to the prompt fields below instead. Project-level <code>AGENTS.md</code> files can still be discovered when that setting is enabled.</p>
            </div>
            <div className="prompt-guidance-control">
              <span><strong>Project AGENTS.md discovery</strong><small>Allow AGENTS.md guidance from the active project for its threads (up to 32 KB).</small></span>
              <button type="button" role="switch" aria-label="Project AGENTS.md discovery" aria-checked={local.projectInstructionsEnabled} className={`toggle-switch ${local.projectInstructionsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, projectInstructionsEnabled: !local.projectInstructionsEnabled })}><span /></button>
            </div>
            <label className="prompt-layer-field">
              <span><strong>Global Mythra Code prompt</strong><small>Used by every provider.</small></span>
              <textarea
                className="prompt-editor"
                value={local.systemPrompt}
                onChange={(event) => setLocal({ ...local, systemPrompt: event.target.value })}
                placeholder="Empty — add your own instructions here"
                rows={5}
              />
            </label>
            <div className="provider-prompt-grid">
              <label className="prompt-layer-field">
                <span><strong>Codex subscription prompt</strong><small>Appended after the global prompt for ChatGPT subscription threads.</small></span>
                <textarea
                  className="prompt-editor"
                  value={local.codexSystemPrompt}
                  onChange={(event) => setLocal({ ...local, codexSystemPrompt: event.target.value })}
                  placeholder="Optional Codex-specific instructions"
                  rows={4}
                />
              </label>
              <label className="prompt-layer-field">
                <span><strong>Claude Code subscription prompt</strong><small>Appended after the global prompt for Claude subscription threads.</small></span>
                <textarea
                  className="prompt-editor"
                  value={local.claudeSystemPrompt}
                  onChange={(event) => setLocal({ ...local, claudeSystemPrompt: event.target.value })}
                  placeholder="Optional Claude-specific instructions"
                  rows={4}
                />
              </label>
            </div>
            <div className="prompt-audit-row">
              <span><Check size={13} /> Global layer first</span>
              <span><Check size={13} /> Subscription layer second</span>
              <span><Check size={13} /> AGENTS.md discovery {local.projectInstructionsEnabled ? "enabled" : "disabled"}</span>
            </div>
          </section>}

          {(["prompts", "agents", "workflows", "scheduled-tasks", "tools"] as const).includes(settingsSection as "prompts" | "agents" | "workflows" | "scheduled-tasks" | "tools") && <HarnessSettings
            section={settingsSection as "prompts" | "agents" | "workflows" | "scheduled-tasks" | "tools"}
            settings={local}
            profiles={profiles}
            agents={agents}
            actions={actions}
            schedules={schedules}
            workflows={workflows}
            workflowRuns={workflowRuns}
            projects={projects}
            skills={skills}
            modelCatalogs={subAgentModelCatalogs}
            onDiscoverOpenRouterModels={onDiscoverOpenRouterModels}
            onSettings={setLocal}
            onProfiles={onProfiles}
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
          />}

          {settingsSection === "tools" && <div className="settings-workspace-link"><div><strong>Live tool controls</strong><small>{workspaceToolsAvailable ? "Inspect skills, connect configured MCP servers, and run project actions in the active workspace." : "Select a project to inspect live skills, MCP servers, and project actions."}</small></div><button className="secondary-button" onClick={onWorkspaceTools} disabled={!workspaceToolsAvailable}><PanelRight size={13} /> Open workspace tools</button></div>}

          {settingsSection === "projects" && <ProjectDefaultsSettings
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
          />}

          {settingsSection === "github" &&
          <GitHubSettings
            status={githubStatus}
            busy={githubBusy}
            cloneUrl={cloneUrl}
            cloneFolder={cloneFolder}
            onCloneUrl={setCloneUrl}
            onCloneFolder={setCloneFolder}
            onSignIn={onGitHubSignIn}
            onRefresh={onGitHubRefresh}
            onClone={async () => {
              if (await onGitHubClone(cloneUrl, cloneFolder)) {
                setCloneUrl("");
                setCloneFolder("");
              }
            }}
          />}

          {settingsSection === "usage" && <>
            <UsageDisplaySettings value={local.usageDisplay} onChange={(usageDisplay) => setLocal({ ...local, usageDisplay })} />
            <AllTimeUsageSettings totals={usageTotals} />
          </>}

          {settingsSection === "skills" && <SkillLibrary
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

          {settingsSection === "system" &&
          <section className="settings-section">
            <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>Runtime behavior</h3><p>Control background alerts, service tier, and terminal memory.</p></div></div>
            <div className="behavior-grid behavior-grid-single">
              <div><span><strong>Desktop notifications</strong><small>Notify when a background task finishes.</small></span><button type="button" role="switch" aria-checked={local.notificationsEnabled} className={`toggle-switch ${local.notificationsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, notificationsEnabled: !local.notificationsEnabled })}><span /></button></div>
            </div>
            <div className="runtime-field-grid"><label><span>OpenAI service tier</span><select value={local.serviceTier ?? ""} onChange={(event) => setLocal({ ...local, serviceTier: event.target.value || null })}><option value="">Standard</option><option value="priority">Fast / priority</option></select></label><label><span>Terminal scrollback</span><select value={local.terminalScrollback} onChange={(event) => setLocal({ ...local, terminalScrollback: Number(event.target.value) })}><option value={25000}>25k characters</option><option value={100000}>100k characters</option><option value={500000}>500k characters</option></select></label></div>
            <div className="diagnostic-card"><span><strong>Diagnostics</strong><small>{runtimeStatus?.version ?? "Runtime version unavailable"}{runtimeStatus?.warning ? ` · ${runtimeStatus.warning}` : runtimeStatus?.compatible ? " · compatible" : ""} · includes local performance samples</small></span><button className="secondary-button" onClick={() => void exportDiagnosticBundle()}>Export JSON</button></div>
            <RecentPerformancePanel active={open && settingsSection === "system"} />
            <RecentErrorsPanel active={open && settingsSection === "system"} />
          </section>}

          {settingsSection === "agents" &&
          <section className="settings-section subagent-settings">
            <div className="subagent-archive-setting">
              <span className="settings-subgroup-label">Thread cleanup</span>
              <div className={`agent-settings-card single ${local.autoArchiveSubagentThreads ? "enabled" : ""}`}>
                <div className="agent-toggle-copy">
                  <strong>Archive sub-agent threads automatically</strong>
                  <small>Move each settled sub-agent conversation to Archived once its parent finishes. Sub-agents still working stay visible.</small>
                </div>
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
            </div>

            {policyNotice && <p className="subagent-applied-note" role="status"><Check size={13} aria-hidden="true" /> {policyNotice}</p>}

            <div className="preset-panel">
                  <div className="preset-section-heading">
                    <h4>Sub-agent presets</h4>
                    <p>Save providers, models, reasoning, and concurrency as one reusable setup.</p>
                  </div>
                  <div className="preset-toolbar">
                    <span>{local.childAgentPresets.length} of {MAX_CHILD_AGENT_PRESETS} sub-agent presets</span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setCreatingPreset(true)}
                      disabled={presetsFull || creatingPreset}
                    ><Plus size={12} /> Create preset</button>
                  </div>
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
            <div className="settings-section-heading">
              <div className="settings-icon"><KeyRound size={17} /></div>
              <div><h3>Default model provider</h3><p>New threads start with this provider. Each thread keeps its own provider after it starts.</p></div>
            </div>
            <div className="provider-cards">
              <button className={`provider-card ${local.provider === "openai" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openai", model: local.provider === "openai" ? (local.model || DEFAULT_OPENAI_MODEL) : DEFAULT_OPENAI_MODEL, ultra: false })}>
                <span className="provider-logo openai">{local.openAiLogo === "codex" ? <CodexLogo size={18} /> : <OpenAILogo size={17} />}</span>
                <span><strong>OpenAI</strong><small>Official ChatGPT subscription sign-in</small></span>
                {local.provider === "openai" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "claude" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "claude", model: local.provider === "claude" ? (local.model || DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL, ultra: false })}>
                <span className={`provider-logo claude${local.claudeLogo === "anthropic" ? " anthropic-mark" : ""}`}>{local.claudeLogo === "anthropic" ? <AnthropicLogo size={17} /> : <ClaudeLogo size={17} />}</span>
                <span><strong>Anthropic</strong><small>Official Claude Code subscription login</small></span>
                {local.provider === "claude" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "cursor" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "cursor", model: local.provider === "cursor" ? local.model : DEFAULT_CURSOR_MODEL, ultra: false })}>
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <span><strong>Cursor</strong><small>Official Cursor subscription login</small></span>
                {local.provider === "cursor" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "openrouter" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openrouter", model: local.provider === "openrouter" ? local.model : "", ultra: false })}>
                <span className="provider-logo openrouter"><OpenRouterLogo size={18} /></span>
                <span><strong>OpenRouter</strong><small>Responses-compatible model routing</small></span>
                {local.provider === "openrouter" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "lmstudio" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "lmstudio", model: local.provider === "lmstudio" ? local.model : (lmStudioModels[0]?.id ?? ""), ultra: false })}>
                <span className="provider-logo lmstudio"><LmStudioLogo size={18} /></span>
                <span><strong>LM Studio</strong><small>Local models through your LM Studio server</small></span>
                {local.provider === "lmstudio" && <Check size={16} />}
              </button>
            </div>
            <p className="provider-default-note">Use the provider control above the conversation to choose a different provider for one new thread without changing this default.</p>

            {local.provider === "openai" ? (
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : "ChatGPT subscription"}</strong>
                  <small>{account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan connected` : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI required"}</small>
                </div>
                {account?.type === "chatgpt" ? (
                  <div className="credential-actions">
                    <span className="connected-badge"><Check size={12} /> Connected</span>
                    <button className="secondary-button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
                  </div>
                ) : (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : !runtimeStatus?.available ? <Download size={14} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex"}
                  </button>
                )}
              </div>
            ) : local.provider === "openrouter" ? (
              <div className="credential-panel stacked">
                <div className="credential-status">
                  <div><strong>OpenRouter API key</strong><small>{openRouterReady ? "Stored securely on this device" : "No key stored"}</small></div>
                  {openRouterReady && <span className="connected-badge"><Check size={12} /> Connected</span>}
                </div>
                <div className="key-input-row">
                  <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  <button className="secondary-button" onClick={() => void storeKey()} disabled={!apiKey.trim() || busy}>Save key</button>
                </div>
              </div>
            ) : local.provider === "lmstudio" ? (
              <div className="credential-panel stacked">
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
            ) : local.provider === "claude" ? (
              <div className="credential-panel">
                <div>
                  <strong>{claudeStatus?.loggedIn ? claudeStatus.email || "Claude subscription" : "Claude Code subscription"}</strong>
                  <small>{claudeStatus?.loggedIn
                    ? `${claudeStatus.subscriptionType || claudeStatus.authMethod || "Claude"} plan connected · ${claudeStatus.version || "Claude Code"}`
                    : claudeStatus?.warning || (claudeStatus?.available ? "Claude Code detected · sign in to continue" : "Claude Code must be installed first")}</small>
                </div>
                {claudeStatus?.loggedIn ? (
                  <span className="connected-badge"><Check size={12} /> Connected</span>
                ) : (
                  <button className="secondary-button" onClick={() => void (claudeStatus?.available ? onClaudeSignIn() : openUrl("https://docs.anthropic.com/en/docs/claude-code/setup"))} disabled={claudeLoginStarting}>
                    {claudeLoginStarting ? <LoaderCircle className="spin" size={14} /> : !claudeStatus?.available ? <Download size={14} /> : null}
                    {claudeLoginStarting ? "Signing in…" : claudeStatus?.available ? "Sign in" : "Install Claude Code"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onClaudeRefresh()} title="Refresh Claude status" aria-label="Refresh Claude status"><RotateCcw size={14} /></button>
              </div>
            ) : (
              <div className="credential-panel">
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <div>
                  <strong>{cursorStatus?.loggedIn ? cursorStatus.email || "Cursor subscription" : "Cursor Agent subscription"}</strong>
                  <small>{cursorStatus?.loggedIn
                    ? `${cursorStatus.subscriptionType || "Cursor"} plan connected · ${cursorStatus.version || "Cursor Agent"}`
                    : cursorStatus?.warning || (cursorStatus?.available ? "Cursor Agent detected · sign in to continue" : "Cursor Agent CLI must be installed first")}</small>
                </div>
                {cursorStatus?.loggedIn ? (
                  <span className="connected-badge"><Check size={12} /> Connected</span>
                ) : (
                  <button className="secondary-button" onClick={() => void (cursorStatus?.available ? onCursorSignIn() : openUrl("https://cursor.com/docs/cli/installation"))} disabled={cursorLoginStarting}>
                    {cursorLoginStarting ? <LoaderCircle className="spin" size={14} /> : !cursorStatus?.available ? <Download size={14} /> : null}
                    {cursorLoginStarting ? "Signing in…" : cursorStatus?.available ? "Sign in" : "Install Cursor Agent"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onCursorRefresh()} title="Refresh Cursor status" aria-label="Refresh Cursor status"><RotateCcw size={14} /></button>
              </div>
            )}

            <div className="field-label default-model-picker">
              <span>Default model</span>
              <AppSelectMenu
                value={local.model}
                options={defaultModelOptions}
                ariaLabel={`Default ${local.provider === "openai" ? "OpenAI" : local.provider === "openrouter" ? "OpenRouter" : local.provider === "lmstudio" ? "LM Studio" : local.provider === "claude" ? "Claude" : "Cursor"} model`}
                placeholder="Choose a default model"
                searchable={defaultModelOptions.length > 8 || local.provider === "openrouter" || local.provider === "lmstudio" || local.provider === "cursor"}
                menuPlacement="top"
                favorites={favoriteModels(modelFavorites, local.provider)}
                {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(local.provider, model) } : {})}
                {...(local.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})}
                emptyMessage={local.provider === "lmstudio" ? "Connect LM Studio and refresh its catalog first." : "No models are currently available for this provider."}
                onChange={(model) => setLocal({ ...local, model })}
              />
              <small>{defaultModelHelp}</small>
            </div>

            <div className="provider-logo-settings">
              <div>
                <strong>OpenAI model logo</strong>
                <small>Choose the mark used for OpenAI threads, responses, and provider controls throughout Mythra Code.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="OpenAI model logo">
                <button type="button" className={local.openAiLogo === "openai" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "openai"} onClick={() => setLocal({ ...local, openAiLogo: "openai" })}>
                  <span className="provider-logo-preview openai"><OpenAILogo size={20} /></span>
                  <span><strong>OpenAI</strong></span>
                  {local.openAiLogo === "openai" && <Check size={14} />}
                </button>
                <button type="button" className={local.openAiLogo === "codex" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "codex"} onClick={() => setLocal({ ...local, openAiLogo: "codex" })}>
                  <span className="provider-logo-preview codex"><CodexLogo size={22} /></span>
                  <span><strong>Codex</strong></span>
                  {local.openAiLogo === "codex" && <Check size={14} />}
                </button>
              </div>
            </div>
            <div className="provider-logo-settings">
              <div>
                <strong>Cursor model logo</strong>
                <small>Choose the official Cursor mark used for threads, responses, and model controls.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="Cursor model logo">
                <button type="button" className={local.cursorLogo === "cube" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "cube"} onClick={() => setLocal({ ...local, cursorLogo: "cube" })}>
                  <span className="provider-logo-preview cursor"><CursorLogo size={21} /></span>
                  <span><strong>Cursor</strong></span>
                  {local.cursorLogo === "cube" && <Check size={14} />}
                </button>
                <button type="button" className={local.cursorLogo === "app-dark" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "app-dark"} onClick={() => setLocal({ ...local, cursorLogo: "app-dark" })}>
                  <span className="provider-logo-preview cursor-app-dark"><CursorDarkAppIcon size={30} /></span>
                  <span><strong>Cursor Dark</strong></span>
                  {local.cursorLogo === "app-dark" && <Check size={14} />}
                </button>
              </div>
            </div>
            <div className="provider-logo-settings">
              <div>
                <strong>Claude model logo</strong>
                <small>Choose the mark used for Claude threads, responses, and provider controls throughout Mythra Code.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="Claude model logo">
                <button type="button" className={local.claudeLogo === "claude" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "claude"} onClick={() => setLocal({ ...local, claudeLogo: "claude" })}>
                  <span className="provider-logo-preview claude"><ClaudeLogo size={20} /></span>
                  <span><strong>Claude</strong></span>
                  {local.claudeLogo === "claude" && <Check size={14} />}
                </button>
                <button type="button" className={local.claudeLogo === "anthropic" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "anthropic"} onClick={() => setLocal({ ...local, claudeLogo: "anthropic" })}>
                  <span className="provider-logo-preview anthropic"><AnthropicLogo size={20} /></span>
                  <span><strong>Anthropic</strong></span>
                  {local.claudeLogo === "anthropic" && <Check size={14} />}
                </button>
              </div>
            </div>
          </section>}
          </div>
        </div>

        <div className="modal-footer">
          {dirty && <span className="unsaved-hint">Unsaved changes</span>}
          <button className="secondary-button" onClick={requestClose}>Cancel</button>
          <button className="primary-button" onClick={saveSettings} disabled={!projectDefaultsComplete}>Save settings</button>
        </div>
      </div>
    </div>
  );
}

function GitHubSettings({
  status,
  busy,
  cloneUrl,
  cloneFolder,
  onCloneUrl,
  onCloneFolder,
  onSignIn,
  onRefresh,
  onClone,
}: {
  status: GitHubAccountStatus | null;
  busy: boolean;
  cloneUrl: string;
  cloneFolder: string;
  onCloneUrl: (value: string) => void;
  onCloneFolder: (value: string) => void;
  onSignIn: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClone: () => Promise<void>;
}) {
  return <>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-icon"><GitFork size={17} /></div>
        <div><h3>GitHub account</h3><p>Mythra Code uses the official GitHub CLI and never injects its token into prompts or project files. Agents with command access can still run credential-aware CLI tools, so use the same care you would in a terminal.</p></div>
      </div>
      <div className="credential-panel github-account-panel">
        <span className="github-avatar-placeholder"><GitFork size={18} /></span>
        <div>
          <strong>{status?.authenticated ? status.name || status.login || "GitHub account" : status?.available ? "GitHub is ready to connect" : "GitHub CLI is required"}</strong>
          <small>{status?.authenticated ? `@${status.login}${status.email ? ` · ${status.email}` : ""}` : status?.error || "Install GitHub CLI to connect repositories."}</small>
        </div>
        {status?.authenticated ? (
          <span className="connected-badge"><Check size={12} /> Connected</span>
        ) : (
          <button className="secondary-button" onClick={() => void onSignIn()} disabled={busy || !status?.available}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <GitFork size={14} />} Sign in
          </button>
        )}
        <button className="icon-button" onClick={() => void onRefresh()} disabled={busy} title="Refresh GitHub status" aria-label="Refresh GitHub status"><RotateCcw size={14} /></button>
      </div>
      {!status?.available && <button className="secondary-button settings-external-action" onClick={() => void openUrl("https://cli.github.com/")}><ExternalLink size={13} /> Install GitHub CLI</button>}
    </section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-icon"><Download size={17} /></div>
        <div><h3>Clone a repository</h3><p>Download a GitHub repository into a new local folder and add it to Mythra Code as a project.</p></div>
      </div>
      <div className="github-clone-grid">
        <label className="field-label"><span>Repository URL</span><input value={cloneUrl} onChange={(event) => onCloneUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
        <label className="field-label"><span>Local folder name</span><input value={cloneFolder} onChange={(event) => onCloneFolder(event.target.value)} placeholder="repository" /></label>
      </div>
      <button className="primary-button" disabled={!status?.authenticated || busy || !cloneUrl.trim() || !cloneFolder.trim()} onClick={() => void onClone()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} Choose location and clone</button>
    </section>
  </>;
}

const USAGE_DISPLAY_OPTIONS: ReadonlyArray<{ id: UsageDisplayMode; label: string }> = [
  { id: "remaining", label: "Percentage remaining" },
  { id: "consumed", label: "Percentage consumed" },
];

function UsageDisplaySettings({ value, onChange }: { value: UsageDisplayMode; onChange: (value: UsageDisplayMode) => void }) {
  return <section className="settings-section">
    <div className="usage-display-layout">
      <div className="settings-section-heading">
        <div className="settings-icon"><Gauge size={17} /></div>
        <div>
          <h3>Provider quota display</h3>
          <p id="usage-display-help">Choose the direction Mythra Code reads subscription limits in. The choice applies everywhere a live provider quota appears — the usage card in the studio dock, OpenAI/Codex rate limits, and Claude Code rate limits — including each window&rsquo;s length and reset time.</p>
        </div>
      </div>
      <div className="usage-display-controls">
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
    </div>
  </section>;
}

function AllTimeUsageSettings({ totals }: { totals: UsageTotals }) {
  return <section className="settings-section">
    <div className="settings-section-heading">
      <div className="settings-icon"><Gauge size={17} /></div>
      <div><h3>All-time local usage</h3><p>Accumulated since local usage history was enabled on this device. Dollar values estimate standard API pricing; subscription use is not an API charge.</p></div>
    </div>
    <div className="usage-settings-hero">
      <span>Estimated API-equivalent value</span>
      <strong>{formatEstimatedCost(totals.estimatedCost)}</strong>
      <small>{totals.threads.toLocaleString()} tracked thread{totals.threads === 1 ? "" : "s"}</small>
    </div>
    <div className="metric-grid three usage-settings-metrics">
      <div><strong>{totals.inputTokens.toLocaleString()}</strong><span>Input tokens</span></div>
      <div><strong>{totals.outputTokens.toLocaleString()}</strong><span>Output tokens</span></div>
      <div><strong>{totals.totalTokens.toLocaleString()}</strong><span>Total tokens</span></div>
    </div>
    {(totals.cachedInputTokens > 0 || totals.cacheWriteInputTokens > 0) && (
      <div className="usage-cache-note">Prompt caching: {totals.cachedInputTokens.toLocaleString()} read · {totals.cacheWriteInputTokens.toLocaleString()} written</div>
    )}
    <div className="usage-pricing-note">
      <ShieldCheck size={14} />
      <span>{totals.unpricedTokens
        ? `${totals.unpricedTokens.toLocaleString()} tokens are excluded from the dollar estimate because their model has no official published price.`
        : "All tracked tokens with model metadata have a published price."} Cache-write premiums are included when providers report them; long-context, regional, batch, and priority pricing adjustments are not.</span>
    </div>
    <div className="usage-source-links">
      <span>Pricing refreshes from Mythra Code's validated catalog each time the app opens. New rates apply only to future usage.</span>
      <button className="secondary-button" onClick={() => void openUrl("https://developers.openai.com/api/docs/models/compare")}><ExternalLink size={12} /> OpenAI pricing</button>
      <button className="secondary-button" onClick={() => void openUrl("https://www.anthropic.com/pricing")}><ExternalLink size={12} /> Anthropic pricing</button>
    </div>
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
    const model = modelForProvider(settings.provider, settings.model) || modelOptions[0]?.value || "";
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
      <div className="settings-section-heading">
        <div className="settings-icon"><FolderCog size={17} /></div>
        <div><h3>Project defaults</h3><p>Add a project when you want it to override the global provider, model, app theme, effort-slider theme, or chat font. Its choices apply automatically whenever you enter that project.</p></div>
      </div>
      <div className="project-prompt-location-note" role="note">
        <Info size={16} />
        <span><strong>Looking for project instructions?</strong><small>Open that project’s chat, then choose Project instructions beside the project name at the top of the window.</small></span>
      </div>

      {configured.length ? <div className="project-default-list">{configured.map((project) => {
        const defaults = project.overrides!.defaults!;
        const modelOptions = modelOptionsForProvider(defaults.provider, defaults.model, catalogs);
        const setProvider = (provider: Provider) => {
          const options = modelOptionsForProvider(provider, "", catalogs);
          const model = provider === defaults.provider ? defaults.model : (options[0]?.value ?? modelForProvider(provider, ""));
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
              <div className="project-default-field project-default-model"><span>Model</span><AppSelectMenu value={defaults.model} options={modelOptions} ariaLabel={`Default model for ${project.name}`} placeholder="Choose a model…" searchable={modelOptions.length > 8 || defaults.provider === "openrouter" || defaults.provider === "lmstudio" || defaults.provider === "cursor"} menuPlacement="top" favorites={favoriteModels(modelFavorites, defaults.provider)} {...(onToggleModelFavorite ? { onToggleFavorite: (model: string) => onToggleModelFavorite(defaults.provider, model) } : {})} {...(defaults.provider === "openrouter" && onDiscoverOpenRouterModels ? { onSearch: onDiscoverOpenRouterModels } : {})} emptyMessage={defaults.provider === "lmstudio" ? "Connect LM Studio and refresh its catalog first." : "No models are currently available for this provider."} onChange={(model) => updateDefaults(project.id, (current) => ({ ...current, model }))} /></div>
              <div className="project-default-field"><span>App theme</span><AppSelectMenu value={defaults.theme ?? ""} options={themeOptions} ariaLabel={`App theme for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.theme = value as ThemeName; else delete next.theme; return next; }); if (project.id === activeProjectId) onThemePreview((value || settings.theme) as ThemeName); }} /></div>
              <div className="project-default-field"><span>Effort slider</span><AppSelectMenu value={defaults.effortSlider ?? ""} options={effortOptions} ariaLabel={`Effort slider for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.effortSlider = value as EffortSliderStyle; else delete next.effortSlider; return next; }); if (project.id === activeProjectId) onEffortSliderPreview((value || settings.effortSlider) as EffortSliderStyle); }} /></div>
              <div className="project-default-field"><span>Chat font</span><AppSelectMenu value={defaults.chatFont ?? ""} options={fontOptions} ariaLabel={`Chat font for ${project.name}`} menuPlacement="top" onChange={(value) => { updateDefaults(project.id, (current) => { const next = { ...current }; if (value) next.chatFont = value as ChatFont; else delete next.chatFont; return next; }); if (project.id === activeProjectId) onChatFontPreview((value || settings.chatFont) as ChatFont); }} /></div>
            </div>
            {!defaults.model && <p className="project-default-warning">Choose a model before saving these project defaults.</p>}
          </article>
        );
      })}</div> : <div className="project-default-empty"><FolderCog size={18} /><span><strong>No projects override the global defaults yet</strong><small>Add a project below to give it its own provider, model, app theme, effort-slider theme, or chat font.</small></span></div>}

      <div className="project-default-add">
        <div className="project-default-field"><span>Choose a project to override global defaults</span><AppSelectMenu value={projectToAdd} options={projectOptions} ariaLabel="Project to configure" placeholder={projects.length ? "Choose a project…" : "No projects available"} searchable={projectOptions.length > 8} menuPlacement="top" emptyMessage="Every existing project already has project-specific defaults." onChange={setProjectToAdd} /></div>
        <button type="button" onClick={addProject} disabled={!projectToAdd}><Plus size={12} /> Set defaults</button>
      </div>
    </section>
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
  const provablyCurrent = Boolean(status?.installed && status.currentVersion && status.latestVersion && !status.updateAvailable);
  const actionAvailable = Boolean(status?.canUpdate && !provablyCurrent);
  const state = status?.error ? "error" : status?.updateAvailable || status?.installed === false ? "available" : "current";
  const detail = updating ? `Updating ${name}…`
    : updater.checking && !status ? `Checking ${name}…`
      : status?.error ? status.error
        : status?.installed === false ? `${name} is not installed. Install ${status.latestVersion ? `version ${status.latestVersion}` : "the latest version"} here.`
          : status?.updateAvailable ? `${name} ${status.latestVersion} is available.`
            : status?.currentVersion ? `${name} is up to date.`
              : `Check for the latest ${name} release.`;
  const actionLabel = status?.installed === false ? `Install ${name}` : `Update ${name}`;
  return <div className={`update-card developer-runtime-update-card ${state}`}>
    <div className="update-version-row">
      <span><small>Installed · {status?.source ?? "Local runtime"}</small><strong>{name} {status?.currentVersion ?? (status?.installed === false ? "not installed" : "…")}</strong></span>
      {status?.latestVersion && <span className="update-version-available"><small>Latest</small><strong>{status.latestVersion}</strong></span>}
    </div>
    <div className="update-status-row">
      {(updating || updater.checking && !status) && <LoaderCircle className="spin" size={15} />}
      {!updating && status && !status.error && !status.updateAvailable && status.installed && <Check size={15} />}
      {!updating && status?.updateAvailable && <Download size={15} />}
      <span>{detail}</span>
    </div>
    {status && (!status.canUpdate || actionAvailable) && (
      <div className="update-actions">
        {!status.canUpdate && <small>Mythra Code will not overwrite a custom executable path.</small>}
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

  const checkingAll = appUpdater.phase === "checking" || developerRuntimeUpdater.checking;
  const checkAll = () => void Promise.all([
    appUpdater.checkForUpdates(),
    developerRuntimeUpdater.checkForUpdates(),
  ]);

  return <section className="settings-section update-settings-section">
    <div className="settings-section-heading settings-heading-with-action">
      <div className="settings-icon"><Download size={17} /></div>
      <div><h3>Updates</h3><p>Keep Mythra Code and its local Claude Code and Codex runtimes current from one place.</p></div>
      <button className="secondary-button" disabled={checkingAll || busy || developerRuntimeUpdater.updating !== null} onClick={checkAll}>{checkingAll ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} Check all</button>
    </div>
    <h4 className="update-group-heading">Mythra Code</h4>
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
        ) : (
          <button className="secondary-button" disabled={busy} onClick={() => void appUpdater.checkForUpdates()}>{appUpdater.phase === "checking" ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} {appUpdater.phase === "error" ? "Try again" : "Check for updates"}</button>
        )}
      </div>
    </div>
    <h4 className="update-group-heading">Developer runtimes</h4>
    <div className="developer-runtime-update-grid">
      <DeveloperRuntimeUpdateCard target="claude" name="Claude Code" status={developerRuntimeUpdater.status?.claude ?? null} updater={developerRuntimeUpdater} />
      <DeveloperRuntimeUpdateCard target="codex" name="Codex" status={developerRuntimeUpdater.status?.codex ?? null} updater={developerRuntimeUpdater} />
    </div>
    {developerRuntimeUpdater.error && <div className="update-card developer-runtime-result error" role="alert"><div className="update-status-row"><Info size={13} /><span>{developerRuntimeUpdater.error}</span></div></div>}
    {developerRuntimeUpdater.message && <div className="update-card developer-runtime-result" role="status"><div className="update-status-row"><Check size={13} /><span>{developerRuntimeUpdater.message.slice(-2_000)}</span></div></div>}
    <div className="update-trust-row"><ShieldCheck size={14} /><span><strong>Official distribution channels</strong><small>Mythra Code packages must match this app’s updater key. Claude Code and Codex installers are fetched over HTTPS from their official publishers and verify the release assets they install.</small></span></div>
  </section>;
}

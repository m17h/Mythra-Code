import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Archive, ArchiveRestore, Bot, Check, ChevronDown, Circle, Code2, Command, Download, FileCode2, Folder, FolderOpen, LoaderCircle, MessageSquare, Paperclip, PanelRight, PanelLeftClose, PanelLeftOpen, Plus, Pin, PinOff, Pencil, Search, Settings, Shield, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, UsersRound, X } from "lucide-react";
import { getCodexRuntimeStatus, auditEvent, exportTextFile, getNormalChatWorkspace, hasOpenRouterKey, listOpenRouterModels, respond, restartRuntime, rpc, type CodexRuntimeStatus, type JsonObject } from "./lib/codex";
import { deleteClaudeTranscript, getClaudeRuntimeStatus, interruptClaudeTurn, loadClaudeTranscript, respondToClaudePermission, saveClaudeTranscript, startClaudeLogin, startClaudeTurn, steerClaudeTurn, type ClaudeRuntimeStatus } from "./lib/claude";
import { loadStored, storeValue } from "./lib/storage";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PROMPT_PROFILES, DEFAULT_SETTINGS, THEMES } from "./lib/appConfig";
import { commandSandbox, threadResumeParams, threadRuntimeConfig, threadStartParams, turnStartParams } from "./lib/turnConfig";
import { threadSearchParams, threadsForWorkspace, type ThreadSearchResponse } from "./lib/threadSearch";
import { buildTurnInput, withoutSentAttachments } from "./lib/turnInput";
import { forgetSidebarThread, optimisticStartedThread, pruneSidebarIndex, reconcileWorkspaceThreads, rememberSidebarThread, sidebarThread, upsertThread, type ThreadSidebarIndex } from "./lib/threadList";
import { timelineFromTurns } from "./lib/threadTimeline";
import { buildTranscriptMarkdown } from "./lib/transcript";
import { timeAgo } from "./lib/timeAgo";
import { RowMenu } from "./components/RowMenu";
import { type ReasoningEffort, ModelPowerControl, type RuntimeModel } from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import { ClaudeModelControl } from "./components/ClaudeModelControl";
import { ThreadProviderControl } from "./components/ThreadProviderControl";
import { ProjectPromptControl } from "./components/ProjectPromptControl";
import { ApprovalCenter } from "./components/ApprovalCenter";
import { Composer, type ComposerHandle } from "./components/Composer";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsModal } from "./components/SettingsModal";
import { AuthRequiredModal, RuntimeSetupModal } from "./components/RuntimeModals";
import type { AgentRecord, AttachmentRecord, CheckpointRecord, McpView, StudioTab } from "./components/StudioDock";
import type { Account, Activity, AppSettings, ArchivedThread, ChatMessage, CustomAgentProfile, PendingApproval, PermissionMode, Project, ProjectAction, ProjectPromptMode, PromptProfile, Provider, ScheduledTask, ScheduleRunRecord, SettingsSection, Thread, Turn, ThemeName, WorkspaceMode } from "./types";
import { useTaskStore } from "./lib/taskStore";
import { friendlyError } from "./lib/errors";
import { recordError } from "./lib/errorLog";
import { costTotals, formatCost, recordThreadCost } from "./lib/costLedger";
import { useAppUpdater } from "./lib/appUpdater";
import { useCodexEvents } from "./hooks/useCodexEvents";
import { useClaudeEvents } from "./hooks/useClaudeEvents";
import { useScheduler } from "./hooks/useScheduler";
import { useTerminal } from "./hooks/useTerminal";
import { usePaneResize } from "./hooks/usePaneResize";
import { useWorkflowEngine } from "./hooks/useWorkflowEngine";
import { isEstablishedOpenKiwiInstall, ONBOARDING_EXIT_MS, ONBOARDING_VERSION } from "./lib/onboarding";
import { createLocalSkill, importLocalSkills, normalizeSkillName, resolveLocalSkills, scanLocalSkills, syncLocalSkills, type LocalSkill, type LocalSkillFile } from "./lib/skills";
import { compactWorkflowRun, normalizeWorkflows, recoverWorkflowRuns, type WorkflowDefinition, type WorkflowRunRecord } from "./lib/workflows";
import { modelForProvider, providerFromThread } from "./lib/threadProvider";
import { resolveSystemPrompt } from "./lib/systemPrompt";
import { providerAccountUsage } from "./lib/providerUsage";

const ChatTimeline = lazy(() => import("./components/ChatTimeline").then((module) => ({ default: module.ChatTimeline })));
const StudioDock = lazy(() => import("./components/StudioDock").then((module) => ({ default: module.StudioDock })));
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then((module) => ({ default: module.OnboardingModal })));

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Activity[] = [];
const EMPTY_AGENTS: AgentRecord[] = [];

const initialProjects = loadStored<Project[]>("kiwi.projects", []).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
const initialWorkspaceMode: WorkspaceMode = loadStored<WorkspaceMode>("kiwi.workspaceMode", initialProjects.length ? "project" : "chat");
const initialKnownThreads = pruneSidebarIndex(loadStored<ThreadSidebarIndex>("kiwi.knownThreads", {}));
const initialOnboardingVersion = loadStored<number>("kiwi.onboardingVersion", 0);
const establishedInstall = isEstablishedOpenKiwiInstall({ projects: initialProjects.length, knownThreads: Object.keys(initialKnownThreads).length, hasStoredSettings: localStorage.getItem("kiwi.settings") !== null, hasSkillsFolder: Boolean(loadStored<string>("kiwi.skillsFolder", "")) });
const initialOnboardingOpen = initialOnboardingVersion < ONBOARDING_VERSION && !establishedInstall;
const storedSettings = loadStored<Partial<AppSettings>>("kiwi.settings", {});
const initialSettings: AppSettings = { ...DEFAULT_SETTINGS, ...storedSettings, subagentMax: Math.min(24, Math.max(1, Number(storedSettings.subagentMax) || DEFAULT_SETTINGS.subagentMax)), model: storedSettings.provider === "openrouter" ? ((storedSettings.model || "").includes("/") ? storedSettings.model! : "") : storedSettings.provider === "claude" ? ((storedSettings.model || "").startsWith("claude-") ? storedSettings.model! : DEFAULT_CLAUDE_MODEL) : storedSettings.model || DEFAULT_SETTINGS.model, theme: THEMES.some((theme) => theme.id === storedSettings.theme) ? storedSettings.theme! : DEFAULT_SETTINGS.theme, uiScale: Math.min(150, Math.max(80, Number(storedSettings.uiScale) || DEFAULT_SETTINGS.uiScale)) };

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function normalizedProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function providerLabel(provider: AppSettings["provider"]): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "claude") return "Claude";
  return "OpenAI";
}

function isClaudeThread(thread: Thread | null | undefined): boolean {
  return thread?.modelProvider?.toLowerCase() === "claude";
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }) {
  if (mode === "read-only") return <Shield size={size} />;
  if (mode === "full") return <ShieldAlert size={size} />;
  return <ShieldCheck size={size} />;
}

/**
 * Per-row spinner/unread badge with its own narrow store subscription, so
 * streaming updates re-render one sidebar row instead of the whole App.
 */
function ThreadRowBadge({ threadId }: { threadId: string }) {
  const status = useTaskStore((state) => state.statuses[threadId]);
  const unread = useTaskStore((state) => Boolean(state.tasks[threadId]?.unread));
  return (
    <>
      {(status === "running" || status === "starting") && <LoaderCircle className="spin thread-state" size={11} />}
      {unread && <i className="thread-unread" />}
    </>
  );
}

/**
 * Subscribes to the streaming timeline itself so per-frame delta flushes stop
 * at this component boundary instead of re-rendering the entire App.
 */
function ConversationTimeline({ threadId, running, thinkingLabel, approval, provider, searchQuery, searchActiveMatch, onSearchMatches, onEditMessage, onApprovalRespond }: { threadId: string; running: boolean; thinkingLabel: string; approval: PendingApproval | null; provider: AppSettings["provider"]; searchQuery?: string; searchActiveMatch?: number; onSearchMatches?: (count: number) => void; onEditMessage: (text: string) => void; onApprovalRespond: (approval: PendingApproval, result: JsonObject) => void }) {
  const messages = useTaskStore((state) => state.tasks[threadId]?.messages ?? EMPTY_MESSAGES);
  const activities = useTaskStore((state) => state.tasks[threadId]?.activities ?? EMPTY_ACTIVITIES);
  return <ChatTimeline messages={messages} activities={activities} running={running} thinkingLabel={thinkingLabel} approval={approval} provider={provider} searchQuery={searchQuery} searchActiveMatch={searchActiveMatch} onSearchMatches={onSearchMatches} onEditMessage={onEditMessage} onApprovalRespond={onApprovalRespond} />;
}

export default function App() {
  const appUpdater = useAppUpdater();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialProjects[0]?.id ?? null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialWorkspaceMode);
  const [chatWorkspacePath, setChatWorkspacePath] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [startingTurn, setStartingTurn] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [threadModels, setThreadModels] = useState<Record<string, string>>(() => loadStored("kiwi.threadModels", {}));
  const [draftThreadProvider, setDraftThreadProvider] = useState<Provider | null>(null);
  const [draftThreadModel, setDraftThreadModel] = useState<string | null>(null);
  const [previewTheme, setPreviewTheme] = useState<ThemeName | null>(null);
  const [promptProfiles, setPromptProfiles] = useState<PromptProfile[]>(() => loadStored("kiwi.promptProfiles", DEFAULT_PROMPT_PROFILES));
  const [customAgents, setCustomAgents] = useState<CustomAgentProfile[]>(() => loadStored("kiwi.customAgents", []));
  const [projectActions, setProjectActions] = useState<ProjectAction[]>(() => loadStored("kiwi.projectActions", []));
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>(() => loadStored("kiwi.scheduledTasks", []));
  const [scheduleRuns, setScheduleRuns] = useState<ScheduleRunRecord[]>(() => loadStored("kiwi.scheduleRuns", []));
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>(() => normalizeWorkflows(loadStored("kiwi.workflows", [])));
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunRecord[]>(() => recoverWorkflowRuns(loadStored("kiwi.workflowRuns", [])));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("general");
  const [onboardingOpen, setOnboardingOpen] = useState(initialOnboardingOpen);
  const [onboardingMounted, setOnboardingMounted] = useState(initialOnboardingOpen);
  const onboardingExitTimerRef = useRef<number | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [convSearchOpen, setConvSearchOpen] = useState(false);
  const [convSearchQuery, setConvSearchQuery] = useState("");
  const [convSearchIndex, setConvSearchIndex] = useState(0);
  const [convSearchCount, setConvSearchCount] = useState(0);
  const convSearchInputRef = useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = useState<Thread[] | null>(null);
  const [pinnedThreadIds, setPinnedThreadIds] = useState<string[]>(() => loadStored("kiwi.pinnedThreads", []));
  const [archivedThreads, setArchivedThreads] = useState<ArchivedThread[]>(() => loadStored("kiwi.archivedThreads", []));
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadNameDraft, setThreadNameDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [status, setStatus] = useState("Checking runtime");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeRuntimeStatus | null>(null);
  const [claudeLoginStarting, setClaudeLoginStarting] = useState(false);
  const [runtimeSetupOpen, setRuntimeSetupOpen] = useState(false);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [authRequiredOpen, setAuthRequiredOpen] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const threadProjectBindingsRef = useRef<Record<string, string> | null>(null);
  const knownThreadsRef = useRef<ThreadSidebarIndex | null>(null);
  const providerRepairThreadsRef = useRef(new Set<string>());
  const [openRouterReady, setOpenRouterReady] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<StudioTab>("review");
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>(() => loadStored("kiwi.checkpoints", []));
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [rateSummary, setRateSummary] = useState("");
  const [skillsFolder, setSkillsFolder] = useState(() => loadStored<string>("kiwi.skillsFolder", ""));
  const [skillFiles, setSkillFiles] = useState<LocalSkillFile[]>([]);
  const [skillAliases, setSkillAliases] = useState<Record<string, string>>(() => loadStored("kiwi.skillAliases", {}));
  const [disabledSkillPaths, setDisabledSkillPaths] = useState<string[]>(() => loadStored("kiwi.disabledSkills", []));
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const skillRuntimeRootRef = useRef("");
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [gitOutput, setGitOutput] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false);
  const [openRouterModelsError, setOpenRouterModelsError] = useState("");
  const composerRef = useRef<ComposerHandle>(null);
  const threadSearchRequestRef = useRef(0);
  const cancelRequestedRef = useRef(new Set<string>());
  const claudeSaveTimersRef = useRef(new Map<string, number>());
  const permissionControlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    storeValue("kiwi.workflows", workflows);
    storeValue(
      "kiwi.workflowRuns",
      workflowRuns.map((run) => compactWorkflowRun(run)),
    );
    // Persist normalized workflow defaults and recover any run left active by
    // a previous app exit. Later updates are persisted by their own writers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (threadProjectBindingsRef.current === null) {
    threadProjectBindingsRef.current = loadStored("kiwi.threadProjects", {});
  }
  if (knownThreadsRef.current === null) knownThreadsRef.current = initialKnownThreads;

  const selectedProject = useMemo(() => projects.find((project) => project.id === activeProjectId) ?? null, [activeProjectId, projects]);
  const activeProject = workspaceMode === "project" ? selectedProject : null;
  const chatWorkspace = useMemo<Project | null>(() => (chatWorkspacePath ? { id: "openkiwi-normal-chats", name: "Chats", path: chatWorkspacePath, isChat: true } : null), [chatWorkspacePath]);
  const activeWorkspace = workspaceMode === "chat" ? chatWorkspace : activeProject;
  const activeThreadId = activeThread?.id ?? null;
  const activeProvider = activeThread ? providerFromThread(activeThread, settings.provider) : (draftThreadProvider ?? settings.provider);
  // Per-project overrides win over global defaults, while provider and model
  // are resolved for the active thread (or the unsent new-thread draft).
  const effectiveSettings = useMemo<AppSettings>(() => {
    const overrides = activeProject?.overrides;
    const resolved = !overrides
      ? settings
      : {
          ...settings,
          ...(overrides.model ? { model: overrides.model } : {}),
          ...(overrides.permission ? { permission: overrides.permission } : {}),
          systemPrompt: resolveSystemPrompt(settings.systemPrompt, overrides.systemPrompt, overrides.systemPromptMode),
        };
    const threadModel = activeThreadId ? threadModels[activeThreadId] : draftThreadModel;
    return { ...resolved, provider: activeProvider, model: modelForProvider(activeProvider, threadModel ?? resolved.model) };
  }, [activeProject, activeProvider, activeThreadId, draftThreadModel, settings, threadModels]);

  const terminal = useTerminal({ scrollback: settings.terminalScrollback, permission: effectiveSettings.permission, onError: setError });
  const timelineEmpty = useTaskStore((state) => {
    if (!activeThreadId) return true;
    const task = state.tasks[activeThreadId];
    return !task || (task.messages.length === 0 && task.activities.length === 0);
  });
  const diff = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.diff ?? "") : ""));
  const agentRecords = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.agents ?? EMPTY_AGENTS) : EMPTY_AGENTS));
  const tokenUsage = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.usage ?? null) : null));
  const taskStatus = useTaskStore((state) => (activeThreadId ? (state.statuses[activeThreadId] ?? "idle") : "idle"));
  const running = startingTurn || taskStatus === "starting" || taskStatus === "running";
  // Standard approvals for the thread being viewed render inline in its
  // timeline; the modal is reserved for background threads and for complex
  // input/elicitation forms.
  const inlineApproval = useTaskStore((state) => {
    if (!state.activeThreadId) return null;
    const candidate = state.tasks[state.activeThreadId]?.approvals[0] ?? null;
    if (!candidate) return null;
    if (candidate.method === "item/tool/requestUserInput" || candidate.method === "mcpServer/elicitation/request") return null;
    return candidate;
  });
  const pendingApproval = useTaskStore((state) => {
    let earliest: PendingApproval | null = null;
    for (const task of Object.values(state.tasks)) {
      const candidate = task.approvals[0];
      if (!candidate) continue;
      const handledInline = candidate.threadId === state.activeThreadId && candidate.method !== "item/tool/requestUserInput" && candidate.method !== "mcpServer/elicitation/request";
      if (handledInline) continue;
      if (!earliest || candidate.receivedAt < earliest.receivedAt) earliest = candidate;
    }
    return earliest;
  });
  const pendingApprovalCount = useTaskStore((state) => {
    let count = 0;
    for (const task of Object.values(state.tasks)) count += task.approvals.length;
    return count;
  });
  const displayedThreads = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    const merged = threads.filter((thread) => `${thread.name ?? ""} ${thread.preview}`.toLowerCase().includes(query));
    const mergedIds = new Set(merged.map((thread) => thread.id));
    for (const found of searchResults ?? []) {
      if (!mergedIds.has(found.id)) {
        mergedIds.add(found.id);
        merged.push(found);
      }
    }
    const pinned = new Set(pinnedThreadIds);
    return merged.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.updatedAt - a.updatedAt);
  }, [pinnedThreadIds, searchResults, threadSearch, threads]);
  // @-mention autocomplete searches project files with the same fuzzy RPC the
  // file browser uses. Only available inside a project workspace.
  const activeProjectPath = activeProject?.path;
  const searchProjectFiles = useMemo(() => {
    if (!activeProjectPath) return undefined;
    return async (query: string): Promise<string[]> => {
      if (!query.trim()) return [];
      const result = await rpc<{ files: Array<{ path?: string; file_name?: string }> }>("fuzzyFileSearch", { query: query.trim(), roots: [activeProjectPath], cancellationToken: crypto.randomUUID() });
      return (result.files ?? [])
        .map((entry) => entry.path || entry.file_name || "")
        .filter(Boolean)
        .slice(0, 8);
    };
  }, [activeProjectPath]);

  // OpenRouter publishes per-token USD pricing — surface the spend estimate
  // for the active thread instead of discarding the data.
  const costEstimate = useMemo(() => {
    if (effectiveSettings.provider !== "openrouter" || !tokenUsage) return "";
    const pricing = openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.pricing;
    const promptRate = Number(pricing?.prompt ?? NaN);
    const completionRate = Number(pricing?.completion ?? NaN);
    if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) return "";
    const cost = tokenUsage.inputTokens * promptRate + tokenUsage.outputTokens * completionRate;
    if (!Number.isFinite(cost) || cost < 0) return "";
    return cost >= 0.01 ? `≈ $${cost.toFixed(2)} this thread` : `≈ $${cost.toFixed(4)} this thread`;
  }, [effectiveSettings.model, effectiveSettings.provider, openRouterModels, tokenUsage]);

  // Aggregate OpenRouter spend across threads (today + this project).
  const costTotalsView = useMemo(() => {
    if (effectiveSettings.provider !== "openrouter") return "";
    const totals = costTotals(activeProject ? normalizedProjectPath(activeProject.path) : undefined);
    if (!totals.today && !totals.project) return "";
    return `${activeProject ? `This project ≈ ${formatCost(totals.project)} · ` : ""}Today ≈ ${formatCost(totals.today)}`;
    // taskStatus retriggers the memo after each turn completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject, effectiveSettings.provider, taskStatus, tokenUsage]);

  const accountUsageView = useMemo(() => {
    return providerAccountUsage(effectiveSettings.provider, {
      openAiRateSummary: rateSummary,
      claudeStatus,
      openRouterReady,
    });
  }, [claudeStatus, effectiveSettings.provider, openRouterReady, rateSummary]);

  // Only offer "Check settings" for failures settings can actually fix.
  const errorSuggestsSettings = useMemo(() => Boolean(error) && /sign in|api key|openrouter|claude|model|settings|runtime|codex|account/i.test(error ?? ""), [error]);
  const workspaceArchived = useMemo(() => (activeWorkspace ? archivedThreads.filter((record) => record.path === normalizedProjectPath(activeWorkspace.path)) : []), [activeWorkspace, archivedThreads]);

  const persistSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    storeValue("kiwi.settings", next);
  }, []);

  const persistThreadModel = useCallback((threadId: string, model: string) => {
    setThreadModels((current) => {
      if (current[threadId] === model) return current;
      const next = { ...current, [threadId]: model };
      storeValue("kiwi.threadModels", next);
      return next;
    });
  }, []);

  const forgetThreadModel = useCallback((threadId: string) => {
    setThreadModels((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      storeValue("kiwi.threadModels", next);
      return next;
    });
  }, []);

  const persistActiveProjectOverride = useCallback(
    <K extends keyof NonNullable<Project["overrides"]>>(key: K, value: NonNullable<Project["overrides"]>[K]) => {
      if (!activeProject?.overrides?.[key]) return false;
      setProjects((current) => {
        const next = current.map((project) => (project.id === activeProject.id ? { ...project, overrides: { ...project.overrides, [key]: value } } : project));
        storeValue("kiwi.projects", next);
        return next;
      });
      return true;
    },
    [activeProject],
  );

  const persistComposerModel = useCallback(
    (model: string) => {
      if (activeThreadId) {
        persistThreadModel(activeThreadId, model);
      } else if (draftThreadProvider !== null) {
        setDraftThreadModel(model);
      } else if (!persistActiveProjectOverride("model", model)) {
        persistSettings({ ...settings, model });
      }
    },
    [activeThreadId, draftThreadProvider, persistActiveProjectOverride, persistSettings, persistThreadModel, settings],
  );

  const persistComposerPermission = useCallback(
    (permission: PermissionMode) => {
      if (!persistActiveProjectOverride("permission", permission)) persistSettings({ ...settings, permission });
    },
    [persistActiveProjectOverride, persistSettings, settings],
  );

  const persistActiveProjectPrompt = useCallback(
    (systemPrompt: string | undefined, mode: ProjectPromptMode) => {
      if (!activeProject) return;
      setProjects((current) => {
        const next = current.map((project) => {
          if (project.id !== activeProject.id) return project;
          const overrides = { ...(project.overrides ?? {}) };
          if (systemPrompt?.trim()) {
            overrides.systemPrompt = systemPrompt.trim();
            if (mode === "append") overrides.systemPromptMode = "append";
            else delete overrides.systemPromptMode;
          } else {
            delete overrides.systemPrompt;
            delete overrides.systemPromptMode;
          }
          return { ...project, overrides: Object.keys(overrides).length ? overrides : undefined };
        });
        storeValue("kiwi.projects", next);
        return next;
      });
    },
    [activeProject],
  );

  const { paneSizes, startPaneResize } = usePaneResize((settings.uiScale || 100) / 100);

  // Confirmation statuses like "Stopped" used to persist in the topbar forever.
  const transientStatusTimerRef = useRef<number | null>(null);
  const setTransientStatus = useCallback((message: string) => {
    setStatus(message);
    if (transientStatusTimerRef.current !== null) window.clearTimeout(transientStatusTimerRef.current);
    transientStatusTimerRef.current = window.setTimeout(() => {
      transientStatusTimerRef.current = null;
      setStatus((current) => (current === message ? "Ready" : current));
    }, 3000);
  }, []);

  const openSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setPreviewTheme(null);
    setSettingsOpen(false);
  }, []);

  const completeOnboarding = useCallback(() => {
    storeValue("kiwi.onboardingVersion", ONBOARDING_VERSION);
    setOnboardingOpen(false);
    if (onboardingExitTimerRef.current !== null) window.clearTimeout(onboardingExitTimerRef.current);
    onboardingExitTimerRef.current = window.setTimeout(() => {
      onboardingExitTimerRef.current = null;
      setOnboardingMounted(false);
    }, ONBOARDING_EXIT_MS);
  }, []);

  const openOnboarding = useCallback(() => {
    if (onboardingExitTimerRef.current !== null) {
      window.clearTimeout(onboardingExitTimerRef.current);
      onboardingExitTimerRef.current = null;
    }
    setOnboardingMounted(true);
    requestAnimationFrame(() => setOnboardingOpen(true));
  }, []);

  useEffect(
    () => () => {
      if (onboardingExitTimerRef.current !== null) window.clearTimeout(onboardingExitTimerRef.current);
    },
    [],
  );

  const startNormalChat = useCallback(() => {
    setWorkspaceMode("chat");
    storeValue("kiwi.workspaceMode", "chat");
  }, []);

  const persistArchivedThreads = useCallback((update: (current: ArchivedThread[]) => ArchivedThread[]) => {
    setArchivedThreads((current) => {
      const next = update(current);
      storeValue("kiwi.archivedThreads", next);
      return next;
    });
  }, []);

  const bindThreadToProject = useCallback((threadId: string, projectPath: string) => {
    const current = threadProjectBindingsRef.current ?? {};
    if (current[threadId] && normalizedProjectPath(current[threadId]) === normalizedProjectPath(projectPath)) return;
    const next = { ...current, [threadId]: projectPath };
    threadProjectBindingsRef.current = next;
    storeValue("kiwi.threadProjects", next);
  }, []);

  const rememberThread = useCallback((thread: Thread) => {
    const next = rememberSidebarThread(knownThreadsRef.current ?? {}, thread);
    knownThreadsRef.current = next;
    storeValue("kiwi.knownThreads", next);
  }, []);

  const forgetThread = useCallback((threadId: string) => {
    const next = forgetSidebarThread(knownThreadsRef.current ?? {}, threadId);
    knownThreadsRef.current = next;
    storeValue("kiwi.knownThreads", next);
  }, []);

  const persistClaudeThread = useCallback(
    (threadId: string) => {
      const task = useTaskStore.getState().tasks[threadId];
      const thread = activeThread?.id === threadId ? activeThread : (threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId]);
      if (!task || !thread || !isClaudeThread(thread)) return Promise.resolve();
      return saveClaudeTranscript({ thread, messages: task.messages.map((message) => ({ ...message, streaming: false })), activities: task.activities });
    },
    [activeThread, threads],
  );

  const scheduleClaudeThreadSave = useCallback(
    (threadId: string) => {
      const existing = claudeSaveTimersRef.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        claudeSaveTimersRef.current.delete(threadId);
        void persistClaudeThread(threadId).catch(() => {});
      }, 250);
      claudeSaveTimersRef.current.set(threadId, timer);
    },
    [persistClaudeThread],
  );

  useEffect(
    () => () => {
      for (const timer of claudeSaveTimersRef.current.values()) window.clearTimeout(timer);
      claudeSaveTimersRef.current.clear();
    },
    [],
  );

  const checkRuntime = useCallback(async (showSetupWhenMissing = true): Promise<CodexRuntimeStatus> => {
    setRuntimeChecking(true);
    try {
      const result = await getCodexRuntimeStatus();
      setRuntimeStatus(result);
      if (result.available) {
        setStatus("Ready");
      } else {
        setStatus("Setup required");
        if (showSetupWhenMissing) setRuntimeSetupOpen(true);
      }
      return result;
    } catch (reason) {
      const result: CodexRuntimeStatus = { available: false, source: null, path: null, version: null, compatible: false, warning: null };
      setRuntimeStatus(result);
      setStatus("Setup required");
      setError(friendlyError(reason));
      if (showSetupWhenMissing) setRuntimeSetupOpen(true);
      return result;
    } finally {
      setRuntimeChecking(false);
    }
  }, []);

  const refreshClaudeStatus = useCallback(async () => {
    try {
      const result = await getClaudeRuntimeStatus();
      setClaudeStatus(result);
      return result;
    } catch (reason) {
      const result: ClaudeRuntimeStatus = { available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null };
      setClaudeStatus(result);
      setError(friendlyError(reason));
      return result;
    }
  }, []);

  const loadThreadsRequestRef = useRef(0);
  const loadThreads = useCallback(
    async (project: Project | null) => {
      // Last-write-wins guard: a slow page loop for a previous workspace must
      // not overwrite the thread list of the workspace the user switched to.
      const requestId = ++loadThreadsRequestRef.current;
      if (!project) {
        setThreads([]);
        return;
      }
      if (!runtimeStatus?.available) {
        setThreads(reconcileWorkspaceThreads([], knownThreadsRef.current ?? {}, project.path, threadProjectBindingsRef.current ?? {}));
        return;
      }
      try {
        const allThreads: Thread[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page += 1) {
          const result: { data: Thread[]; nextCursor?: string | null } = await rpc("thread/list", { cwd: project.path, limit: 100, cursor });
          if (loadThreadsRequestRef.current !== requestId) return;
          allThreads.push(...(result.data ?? []));
          cursor = result.nextCursor ?? null;
          if (!cursor) break;
        }
        const projectPath = normalizedProjectPath(project.path);
        const runtimeThreads = allThreads.filter((thread) => {
          const boundPath = threadProjectBindingsRef.current?.[thread.id];
          return normalizedProjectPath(boundPath || thread.cwd) === projectPath;
        });
        const merged = { ...(knownThreadsRef.current ?? {}) };
        for (const thread of runtimeThreads) merged[thread.id] = sidebarThread(thread);
        const remembered = pruneSidebarIndex(merged);
        knownThreadsRef.current = remembered;
        storeValue("kiwi.knownThreads", remembered);
        if (loadThreadsRequestRef.current !== requestId) return;
        setThreads(reconcileWorkspaceThreads(runtimeThreads, remembered, project.path, threadProjectBindingsRef.current ?? {}));
      } catch (reason) {
        if (loadThreadsRequestRef.current !== requestId) return;
        setThreads(reconcileWorkspaceThreads([], knownThreadsRef.current ?? {}, project.path, threadProjectBindingsRef.current ?? {}));
        setError(friendlyError(reason));
      }
    },
    [runtimeStatus?.available],
  );

  const refreshAccount = useCallback(async () => {
    try {
      const result = await rpc<{ account: Account | null }>("account/read", { refreshToken: false });
      setAccount(result.account);
      if (result.account?.type === "chatgpt") {
        setAuthRequiredOpen(false);
        setError(null);
        setStatus("Ready");
      }
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const allModels: RuntimeModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result: { data: RuntimeModel[]; nextCursor?: string | null } = await rpc("model/list", { limit: 100, includeHidden: false, cursor });
        allModels.push(...(result.data ?? []));
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      setRuntimeModels(allModels);
    } catch {
      setRuntimeModels([]);
    }
  }, []);

  const refreshOpenRouterModels = useCallback(async () => {
    setOpenRouterModelsLoading(true);
    setOpenRouterModelsError("");
    try {
      const result = await listOpenRouterModels<{ data?: OpenRouterModel[] }>();
      const models = (result.data ?? []).filter((entry) => entry.id && entry.name).sort((a, b) => a.name.localeCompare(b.name));
      setOpenRouterModels(models);
      if (!models.length) setOpenRouterModelsError("OpenRouter returned an empty catalog");
    } catch (reason) {
      setOpenRouterModelsError(friendlyError(reason));
    } finally {
      setOpenRouterModelsLoading(false);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const result = await rpc<{ rateLimits?: { primary?: { usedPercent?: number; resetsAt?: number } } }>("account/rateLimits/read");
      const primary = result.rateLimits?.primary;
      setRateSummary(primary ? `${Math.round(primary.usedPercent ?? 0)}% used${primary.resetsAt ? ` · resets ${new Date(primary.resetsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}` : "No active limit window");
    } catch {
      setRateSummary("");
    }
  }, []);

  const prepareLocalSkills = useCallback(
    async (folder: string, files: LocalSkillFile[], aliases: Record<string, string>, disabled: string[]) => {
      const resolved = resolveLocalSkills(files, aliases, disabled);
      setSkills(resolved);
      if (!folder) {
        skillRuntimeRootRef.current = "";
        if (runtimeStatus?.available) await rpc("skills/extraRoots/set", { extraRoots: [] });
        return resolved;
      }
      const runtimeRoot = await syncLocalSkills(folder, resolved);
      skillRuntimeRootRef.current = runtimeRoot;
      if (runtimeStatus?.available) {
        await rpc("skills/extraRoots/set", { extraRoots: [runtimeRoot] });
      }
      return resolved;
    },
    [runtimeStatus?.available],
  );

  const refreshLocalSkills = useCallback(
    async (folder = skillsFolder, aliases = skillAliases, disabled = disabledSkillPaths) => {
      if (!folder) {
        setSkillFiles([]);
        setSkills([]);
        setSkillsError("");
        return prepareLocalSkills("", [], aliases, disabled);
      }
      setSkillsBusy(true);
      setSkillsError("");
      try {
        const files = await scanLocalSkills(folder);
        setSkillFiles(files);
        return await prepareLocalSkills(folder, files, aliases, disabled);
      } catch (reason) {
        setSkillsError(friendlyError(reason));
        setSkillFiles([]);
        setSkills([]);
        try {
          await prepareLocalSkills("", [], aliases, disabled);
        } catch {
          /* Keep the scan error as the useful message. */
        }
        return [];
      } finally {
        setSkillsBusy(false);
      }
    },
    [disabledSkillPaths, prepareLocalSkills, skillAliases, skillsFolder],
  );

  const refreshTools = useCallback(
    async (workspace: Project | null) => {
      await refreshLocalSkills();
      if (!runtimeStatus?.available) return;
      const tasks: Array<Promise<unknown>> = [rpc<{ data: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }> }>("mcpServerStatus/list", { detail: "full" }).then((result) => setMcpServers((result.data ?? []).map((server) => ({ name: server.name, status: server.authStatus || "ready", tools: Object.keys(server.tools ?? {}).length }))))];
      if (workspace) tasks.push(rpc("skills/list", { cwds: [workspace.path], forceReload: true }));
      await Promise.allSettled(tasks);
    },
    [refreshLocalSkills, runtimeStatus?.available],
  );

  const ensureSkillRoots = useCallback(async () => {
    if (!runtimeStatus?.available) return;
    const root = skillRuntimeRootRef.current;
    await rpc("skills/extraRoots/set", { extraRoots: root ? [root] : [] });
  }, [runtimeStatus?.available]);

  const executeCommand = useCallback(
    async (command: string[], cwd: string) => {
      return rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", { command, cwd, timeoutMs: 120000, sandboxPolicy: commandSandbox(effectiveSettings.permission, cwd) });
    },
    [effectiveSettings.permission],
  );

  const refreshDiffFor = useCallback(
    async (threadId: string, projectPath: string) => {
      try {
        const result = await rpc<{ diff: string }>("gitDiffToRemote", { cwd: projectPath });
        useTaskStore.getState().setDiff(threadId, result.diff ?? "");
      } catch {
        try {
          const result = await executeCommand(["git", "diff", "--no-ext-diff", "--"], projectPath);
          useTaskStore.getState().setDiff(threadId, `${result.stdout}${result.stderr}`);
        } catch (reason) {
          setError(friendlyError(reason));
        }
      }
    },
    [executeCommand],
  );

  const refreshDiff = useCallback(async () => {
    if (!activeProject || !activeThreadId) return;
    await refreshDiffFor(activeThreadId, activeProject.path);
  }, [activeProject, activeThreadId, refreshDiffFor]);

  // The event context is rebuilt each render so callbacks always see fresh
  // state; useCodexEvents reads it through a ref and subscribes exactly once.
  useCodexEvents({
    bindingFor: (threadId) => threadProjectBindingsRef.current?.[threadId],
    respond: (id, result) => respond(id, result),
    audit: (kind, payload, threadId) => void auditEvent(kind, payload, threadId).catch(() => {}),
    onStatus: setStatus,
    onError: setError,
    onAuthRequired: () => setAuthRequiredOpen(true),
    onRateSummary: setRateSummary,
    onTerminalOutput: terminal.append,
    onAccountUpdated: () => void refreshAccount(),
    onLoginFailed: (message) => {
      setError(message);
      setAuthRequiredOpen(true);
    },
    onProviderToolCompatibilityError: (threadId) => {
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      if (providerFromThread(thread, "openai") === "openrouter") providerRepairThreadsRef.current.add(threadId);
    },
    onApprovalRequested: (threadId) => {
      if (!settings.notificationsEnabled || useTaskStore.getState().activeThreadId === threadId) return;
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      const label = thread?.name || thread?.preview || "A background task";
      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "OpenKiwi needs your approval", body: `“${label}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId, turn) => {
      const needsProviderRepair = providerRepairThreadsRef.current.delete(threadId);
      if (turn) {
        setActiveThread((current) => (current && current.id === threadId ? { ...current, turns: [...(current.turns ?? []).filter((entry) => entry.id !== turn.id), turn] } : current));
      }
      if (needsProviderRepair) {
        setStatus("Refreshing OpenRouter");
        void deliberateRestartRuntime()
          .then(() => checkRuntime(false))
          .then(() => {
            setStatus("Ready");
            setError("OpenRouter compatibility was refreshed. Send your message again.");
          })
          .catch((reason) => {
            setStatus("Runtime issue");
            setError(friendlyError(reason));
          });
        return;
      }
      if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== threadId) {
        const thread = threads.find((entry) => entry.id === threadId);
        const label = thread?.name || thread?.preview || "A background task";
        const projectPath = threadProjectBindingsRef.current?.[threadId];
        const projectName = projectPath && !projectPath.includes("normal-chats") ? basename(projectPath) : null;
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: "OpenKiwi task complete", body: projectName ? `“${label}” finished in ${projectName}.` : `“${label}” finished.` });
        })().catch(() => {});
      }
      const projectPath = threadProjectBindingsRef.current?.[threadId];
      const completedThread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      if (providerFromThread(completedThread, "openai") === "openrouter") {
        const usage = useTaskStore.getState().tasks[threadId]?.usage;
        // Newly stored thread models are authoritative. The active-model
        // fallback preserves cost tracking for OpenRouter threads created
        // before that storage existed.
        const completedModel = threadModels[threadId] ?? (activeThreadId === threadId ? effectiveSettings.model : undefined);
        const pricing = openRouterModels.find((entry) => entry.id === completedModel)?.pricing;
        const promptRate = Number(pricing?.prompt ?? NaN);
        const completionRate = Number(pricing?.completion ?? NaN);
        if (usage && Number.isFinite(promptRate) && Number.isFinite(completionRate)) {
          recordThreadCost(threadId, projectPath ? normalizedProjectPath(projectPath) : "", usage.inputTokens * promptRate + usage.outputTokens * completionRate);
        }
      }
      if (projectPath && activeWorkspace && normalizedProjectPath(projectPath) === normalizedProjectPath(activeWorkspace.path)) {
        // Bump just the finished thread instead of re-paging the entire
        // thread list from the runtime after every turn.
        const known = knownThreadsRef.current?.[threadId];
        if (known) {
          // Refresh the preview from the latest user message so the sidebar
          // does not stay frozen on the thread's first optimistic prompt.
          const taskMessages = useTaskStore.getState().tasks[threadId]?.messages ?? [];
          const latestUserText = [...taskMessages].reverse().find((message) => message.role === "user")?.text;
          const updated = { ...known, preview: latestUserText?.slice(0, 140) || known.preview, updatedAt: Math.floor(Date.now() / 1000) };
          rememberThread(updated);
          setThreads((current) => upsertThread(current, updated));
        } else {
          void loadThreads(activeWorkspace);
        }
      }
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) void refreshDiffFor(threadId, projectPath);
    },
  });

  useClaudeEvents({
    bindingFor: (threadId) => threadProjectBindingsRef.current?.[threadId],
    onStatus: setStatus,
    onError: setError,
    onTranscriptChanged: scheduleClaudeThreadSave,
    onApprovalRequested: (threadId) => {
      if (!settings.notificationsEnabled || useTaskStore.getState().activeThreadId === threadId) return;
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "OpenKiwi needs your approval", body: `“${thread?.name || thread?.preview || "A Claude task"}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId) => {
      const timer = claudeSaveTimersRef.current.get(threadId);
      if (timer !== undefined) window.clearTimeout(timer);
      claudeSaveTimersRef.current.delete(threadId);
      const task = useTaskStore.getState().tasks[threadId];
      const known = knownThreadsRef.current?.[threadId];
      if (known) {
        const latestUser = [...(task?.messages ?? [])].reverse().find((message) => message.role === "user")?.text;
        const updated = { ...known, preview: latestUser?.slice(0, 140) || known.preview, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updated);
        setThreads((current) => upsertThread(current, updated));
        void saveClaudeTranscript({ thread: updated, messages: (task?.messages ?? []).map((message) => ({ ...message, streaming: false })), activities: task?.activities ?? [] }).catch(() => {});
      }
      if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== threadId) {
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: "OpenKiwi task complete", body: `“${known?.name || known?.preview || "Claude task"}” finished.` });
        })().catch(() => {});
      }
      const projectPath = threadProjectBindingsRef.current?.[threadId];
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) void refreshDiffFor(threadId, projectPath);
    },
  });

  useEffect(() => {
    void getNormalChatWorkspace()
      .then(setChatWorkspacePath)
      .catch((reason) => setError(friendlyError(reason)));
    if (!initialOnboardingOpen && initialOnboardingVersion < ONBOARDING_VERSION) {
      storeValue("kiwi.onboardingVersion", ONBOARDING_VERSION);
    }
    void checkRuntime(!initialOnboardingOpen && initialSettings.provider !== "claude").then((runtime) => {
      if (!runtime.available) return;
      void refreshAccount();
      void refreshModels();
      void refreshUsage();
    });
    void refreshClaudeStatus();
    void refreshOpenRouterModels();
    void hasOpenRouterKey()
      .then(setOpenRouterReady)
      .catch(() => setOpenRouterReady(false));
  }, [checkRuntime, refreshAccount, refreshClaudeStatus, refreshModels, refreshOpenRouterModels, refreshUsage]);

  const shortcutStateRef = useRef({ running: false, modalOpen: false, threadOpen: false, stopTurn: () => {}, newThread: () => {} });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (meta && event.key.toLowerCase() === "f" && shortcutStateRef.current.threadOpen && !shortcutStateRef.current.modalOpen) {
        event.preventDefault();
        setConvSearchOpen(true);
        requestAnimationFrame(() => convSearchInputRef.current?.focus());
        return;
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        shortcutStateRef.current.newThread();
        return;
      }
      if (meta && event.key === ",") {
        event.preventDefault();
        openSettings();
        return;
      }
      if (event.key === "Escape" && !shortcutStateRef.current.modalOpen && shortcutStateRef.current.running) {
        // Escape inside a text field (thread rename, search, composer) means
        // "cancel that edit", never "interrupt the running task".
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        event.preventDefault();
        shortcutStateRef.current.stopTurn();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openSettings]);

  // Workspace-change side effects are keyed on the workspace *path* and
  // runtime availability, with refreshTools read through a ref. Depending on
  // the callback identities here used to reset the open conversation whenever
  // an unrelated setting (skills, project pinning) changed.
  const refreshToolsRef = useRef(refreshTools);
  refreshToolsRef.current = refreshTools;
  const workspaceEffectRef = useRef<{ path: string | null; available: boolean } | null>(null);
  useEffect(() => {
    const path = activeWorkspace ? normalizedProjectPath(activeWorkspace.path) : null;
    const available = Boolean(runtimeStatus?.available || claudeStatus?.available);
    const previous = workspaceEffectRef.current;
    if (previous && previous.path === path && previous.available === available) return;
    workspaceEffectRef.current = { path, available };
    if (available) {
      void loadThreads(activeWorkspace);
    } else {
      setThreads([]);
    }
    void refreshToolsRef.current(activeWorkspace);
    if (previous && previous.path === path) return; // Only availability changed — keep the open conversation.
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(null);
    setDraftThreadModel(null);
    setAttachments([]);
    setThreadSearch("");
    setSearchResults(null);
    if (!activeProject) setStudioOpen(false);
  }, [activeProject, activeWorkspace, claudeStatus?.available, loadThreads, runtimeStatus?.available]);

  // Every surfaced error also lands in the diagnostics ring buffer/audit log.
  useEffect(() => {
    if (error) recordError(error);
  }, [error]);

  // The backend emits "codex-runtime" when the codex process dies or spawns.
  // A death without a quick respawn (deliberate restarts respawn immediately)
  // triggers recovery: fail running threads, ping to respawn, tell the user.
  const runtimeDownRef = useRef(false);
  // Deliberate restarts (provider repair, manual retry) kill the process on
  // purpose; suppress the disconnect-recovery flow while one is under way.
  const suppressRuntimeRecoveryUntilRef = useRef(0);
  const deliberateRestartRuntime = useCallback(async () => {
    suppressRuntimeRecoveryUntilRef.current = Date.now() + 20_000;
    try {
      await restartRuntime();
    } finally {
      suppressRuntimeRecoveryUntilRef.current = Date.now() + 3_000;
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    listen<{ alive: boolean }>("codex-runtime", ({ payload }) => {
      if (payload.alive) {
        runtimeDownRef.current = false;
        return;
      }
      runtimeDownRef.current = true;
      window.setTimeout(() => {
        if (!runtimeDownRef.current || disposed) return;
        if (Date.now() < suppressRuntimeRecoveryUntilRef.current) return;
        setStatus("Runtime disconnected — reconnecting");
        const store = useTaskStore.getState();
        for (const [threadId, threadStatus] of Object.entries(store.statuses)) {
          if ((threadStatus === "running" || threadStatus === "starting") && !isClaudeThread(knownThreadsRef.current?.[threadId])) {
            store.setActiveTurn(threadId, undefined);
            store.setTaskStatus(threadId, "error", "The Codex runtime disconnected during this task.");
          }
        }
        setStartingTurn(false);
        void rpc("model/list", { limit: 1 })
          .then(() => {
            if (disposed) return;
            setStatus("Ready");
            setError("The Codex runtime restarted. Resend your last message if a task was interrupted.");
          })
          .catch((reason) => {
            if (disposed) return;
            setStatus("Runtime issue");
            setError(friendlyError(reason));
          });
      }, 1500);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // OS files dragged onto the window become attachments. Tauri delivers
  // native drag-drop through the webview event, not HTML5 DataTransfer.
  const [dropActive, setDropActive] = useState(false);
  const addAttachmentPathsRef = useRef<(paths: string[]) => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "over") setDropActive(true);
          else if (event.payload.type === "drop") {
            setDropActive(false);
            addAttachmentPathsRef.current(event.payload.paths);
          } else setDropActive(false);
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stop = unlisten;
        })
        .catch(() => {
          // Browser preview without a Tauri host.
        });
    } catch {
      // Browser preview without a Tauri host.
    }
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!permissionOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!permissionControlRef.current?.contains(event.target as Node)) setPermissionOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPermissionOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [permissionOpen]);

  // Sidebar search also queries the runtime's full-text thread search, so
  // matches are not limited to the loaded name/preview strings.
  useEffect(() => {
    const requestId = ++threadSearchRequestRef.current;
    const query = threadSearch.trim();
    if (!query || !activeWorkspace || !runtimeStatus?.available) {
      setSearchResults(null);
      return;
    }
    const workspacePath = activeWorkspace.path;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await rpc<ThreadSearchResponse>("thread/search", threadSearchParams(query));
          if (threadSearchRequestRef.current !== requestId) return;
          setSearchResults(threadsForWorkspace(result.data ?? [], workspacePath, threadProjectBindingsRef.current ?? {}));
        } catch {
          if (threadSearchRequestRef.current !== requestId) return;
          setSearchResults(null);
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeWorkspace, runtimeStatus?.available, threadSearch]);

  const addProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (!selected || Array.isArray(selected)) return;
    const existing = projects.find((project) => project.path === selected);
    if (existing) {
      setActiveProjectId(existing.id);
      setWorkspaceMode("project");
      storeValue("kiwi.workspaceMode", "project");
      return;
    }
    const project: Project = { id: crypto.randomUUID(), name: basename(selected), path: selected };
    const next = [...projects, project];
    setProjects(next);
    setActiveProjectId(project.id);
    setWorkspaceMode("project");
    storeValue("kiwi.workspaceMode", "project");
    storeValue("kiwi.projects", next);
  };

  const toggleProjectPin = (project: Project) => {
    const next = projects.map((entry) => (entry.id === project.id ? { ...entry, pinned: !entry.pinned } : entry)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    setProjects(next);
    storeValue("kiwi.projects", next);
  };

  const removeProject = (project: Project) => {
    const confirmed = window.confirm(`Remove “${project.name}” from OpenKiwi?\n\nIts folder and every file inside it will remain untouched on your Mac.`);
    if (!confirmed) return;
    const next = projects.filter((entry) => entry.id !== project.id);
    setProjects(next);
    storeValue("kiwi.projects", next);
    if (activeProjectId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      if (!next.length) {
        setWorkspaceMode("chat");
        storeValue("kiwi.workspaceMode", "chat");
      }
    }
  };

  const selectThreadRequestRef = useRef(0);
  const selectThread = async (thread: Thread) => {
    if (!activeWorkspace) return;
    const projectPath = normalizedProjectPath(activeWorkspace.path);
    const threadPath = normalizedProjectPath(threadProjectBindingsRef.current?.[thread.id] || thread.cwd);
    if (threadPath !== projectPath) {
      setError("That thread belongs to a different chat or project and cannot be opened here.");
      return;
    }
    // Clicking two threads quickly must open the one clicked last, not the
    // one whose resume RPC happened to finish last.
    const requestId = ++selectThreadRequestRef.current;
    setError(null);
    setStatus("Loading thread");
    setDraftThreadProvider(null);
    setDraftThreadModel(null);
    try {
      if (isClaudeThread(thread)) {
        const transcript = await loadClaudeTranscript(thread.id);
        if (selectThreadRequestRef.current !== requestId) return;
        const resolvedThread = transcript?.thread ?? thread;
        if (!threadModels[resolvedThread.id]) {
          const projectModel = activeProject?.overrides?.model ?? settings.model;
          persistThreadModel(resolvedThread.id, modelForProvider("claude", projectModel));
        }
        bindThreadToProject(resolvedThread.id, activeWorkspace.path);
        rememberThread(resolvedThread);
        setActiveThread(resolvedThread);
        useTaskStore.getState().hydrateTask(resolvedThread.id, transcript?.messages ?? [], transcript?.activities ?? [], activeWorkspace.path);
        useTaskStore.getState().setActiveThread(resolvedThread.id);
        setStatus("Ready");
        return;
      }
      const provider = providerFromThread(thread, settings.provider);
      const projectModel = activeProject?.overrides?.model ?? settings.model;
      const threadProviderSettings: AppSettings = { ...effectiveSettings, provider, model: modelForProvider(provider, threadModels[thread.id] ?? projectModel) };
      const result = await rpc<{ thread: Thread }>("thread/resume", threadResumeParams(threadProviderSettings, thread.id, activeWorkspace.path, { customAgents, modelContextWindow: provider === "openrouter" ? openRouterModels.find((entry) => entry.id === threadProviderSettings.model)?.context_length : undefined }));
      if (selectThreadRequestRef.current !== requestId) return;
      if (!threadModels[result.thread.id]) persistThreadModel(result.thread.id, threadProviderSettings.model);
      bindThreadToProject(result.thread.id, activeWorkspace.path);
      rememberThread(result.thread);
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeWorkspace.path);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStatus("Ready");
    } catch (reason) {
      if (selectThreadRequestRef.current !== requestId) return;
      setError(friendlyError(reason));
      setStatus("Ready");
    }
  };

  const exportTranscript = async () => {
    if (!activeThread) return;
    const task = useTaskStore.getState().tasks[activeThread.id];
    if (!task) return;
    const label = activeThread.name || activeThread.preview || "OpenKiwi thread";
    try {
      const path = await save({
        title: "Export conversation",
        defaultPath: `${
          label
            .replace(/[\\/:*?"<>|]/g, "-")
            .slice(0, 60)
            .trim() || "openkiwi-thread"
        }.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await exportTextFile(path, buildTranscriptMarkdown(label, task.messages, task.activities));
      setTransientStatus("Transcript exported");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const editMessageIntoComposer = useCallback((text: string) => {
    composerRef.current?.setDraft(text);
  }, []);

  const newThread = () => {
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(null);
    setDraftThreadModel(null);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const startNewThreadWithProvider = (provider: Provider) => {
    if (running) {
      setError("Stop the running task before starting a thread with another provider.");
      return;
    }
    if (activeThread && !window.confirm(`Start a new ${providerLabel(provider)} thread?\n\nProvider sessions cannot share conversation state, so this keeps the current thread unchanged and starts a separate thread in the same workspace.`)) {
      return;
    }
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(provider === settings.provider ? null : provider);
    setDraftThreadModel(null);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // Returns true when the message was delivered; the Composer restores its
  // draft when it was not.
  const sendMessage = async (text: string): Promise<boolean> => {
    if (!text || !activeWorkspace) return false;
    if (effectiveSettings.provider !== "claude" && !runtimeStatus?.available) {
      setRuntimeSetupOpen(true);
      return false;
    }
    if (effectiveSettings.provider === "openai" && account?.type !== "chatgpt") {
      setAuthRequiredOpen(true);
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !openRouterReady) {
      openSettings("models");
      setError("Add an OpenRouter API key before using OpenRouter.");
      return false;
    }
    if (effectiveSettings.provider === "claude" && (!claudeStatus?.available || !claudeStatus.loggedIn)) {
      openSettings("models");
      setError(claudeStatus?.available ? "Sign in to Claude Code before using your Claude subscription." : "Install Claude Code, then sign in before using the Claude provider.");
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !effectiveSettings.model.trim()) {
      setError("Choose an OpenRouter model before starting this thread.");
      return false;
    }
    if (running && activeThread) {
      const sentAttachments = [...attachments];
      setError(null);
      const steerMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(activeThread.id, { id: steerMessageId, role: "user", text });
      try {
        if (isClaudeThread(activeThread)) {
          await steerClaudeTurn(
            activeThread.id,
            text,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
          );
          scheduleClaudeThreadSave(activeThread.id);
        } else {
          await rpc("turn/steer", { threadId: activeThread.id, input: buildTurnInput(text, sentAttachments) });
        }
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        setTransientStatus("Direction added");
        return true;
      } catch (reason) {
        // The message never reached the runtime — remove the optimistic bubble
        // so a retry does not duplicate it in the timeline.
        useTaskStore.getState().removeMessage(activeThread.id, steerMessageId);
        setError(friendlyError(reason));
        return false;
      }
    }

    setError(null);
    setStartingTurn(true);
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    const sentAttachments = [...attachments];
    try {
      if (effectiveSettings.provider === "claude") {
        if (skillsFolder && !skillRuntimeRootRef.current) await refreshLocalSkills();
        let thread = activeThread;
        if (!thread) {
          thread = { id: crypto.randomUUID(), name: null, preview: text.slice(0, 140), cwd: activeWorkspace.path, updatedAt: Math.floor(Date.now() / 1000), modelProvider: "claude" };
          startedThreadId = thread.id;
          bindThreadToProject(thread.id, activeWorkspace.path);
          rememberThread(thread);
          persistThreadModel(thread.id, effectiveSettings.model);
          setThreads((current) => upsertThread(current, thread!));
          setActiveThread(thread);
          useTaskStore.getState().ensureTask(thread.id, activeWorkspace.path);
          useTaskStore.getState().setActiveThread(thread.id);
        }
        startedThreadId = thread.id;
        const updatedThread = { ...thread, preview: text.slice(0, 140) || thread.preview, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
        useTaskStore.getState().ensureTask(thread.id, activeWorkspace.path);
        useTaskStore.getState().setTaskStatus(thread.id, "starting");
        const canResumeClaude = Boolean(activeThread && useTaskStore.getState().tasks[thread.id]?.messages.some((message) => message.role === "assistant"));
        sentMessageId = `local-${crypto.randomUUID()}`;
        useTaskStore.getState().appendUserMessage(thread.id, { id: sentMessageId, role: "user", text });
        await saveClaudeTranscript({ thread: updatedThread, messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] });
        const result = await startClaudeTurn({ threadId: thread.id, cwd: activeWorkspace.path, prompt: text, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: settings.ultra ? "ultra" : settings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: effectiveSettings.systemPrompt, resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentsEnabled: settings.subagentsEnabled, subagentMax: settings.subagentMax, customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined });
        useTaskStore.getState().setActiveTurn(thread.id, result.turnId);
        useTaskStore.getState().setTaskStatus(thread.id, "running");
        setStartingTurn(false);
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        if (cancelRequestedRef.current.delete(thread.id)) {
          await interruptClaudeTurn(thread.id);
          useTaskStore.getState().setActiveTurn(thread.id, undefined);
          useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
          setTransientStatus("Stopped");
        }
        return true;
      }

      await ensureSkillRoots();
      const input = buildTurnInput(text, sentAttachments);
      let threadId = activeThread?.id;
      startedThreadId = threadId;
      if (!threadId) {
        const result = await rpc<{ thread: Thread }>("thread/start", threadStartParams(effectiveSettings, activeWorkspace.path, { serviceName: activeWorkspace.isChat ? "OpenKiwi Chat" : "OpenKiwi", customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined, interactive: true }));
        const startedThread = optimisticStartedThread(result.thread, text);
        threadId = startedThread.id;
        startedThreadId = threadId;
        bindThreadToProject(startedThread.id, activeWorkspace.path);
        rememberThread(startedThread);
        persistThreadModel(startedThread.id, effectiveSettings.model);
        setThreads((current) => upsertThread(current, startedThread));
        setActiveThread(startedThread);
        useTaskStore.getState().ensureTask(startedThread.id, activeWorkspace.path);
        useTaskStore.getState().setActiveThread(startedThread.id);
      } else if (effectiveSettings.provider === "openrouter") {
        // Re-apply the isolated provider config before every subsequent turn.
        // This repairs a persisted thread after a compatibility refresh.
        await rpc("thread/resume", { ...threadResumeParams(effectiveSettings, threadId, activeWorkspace.path, { customAgents, modelContextWindow: openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length, excludeTurns: true }), model: effectiveSettings.model });
      }

      if (activeThread?.id === threadId) {
        const updatedThread = { ...activeThread, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
      }
      useTaskStore.getState().ensureTask(threadId, activeWorkspace.path);
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(threadId, { id: sentMessageId, role: "user", text });

      const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(effectiveSettings, threadId, activeWorkspace.path, input));
      if (result.turn?.id) useTaskStore.getState().setActiveTurn(threadId, result.turn.id);
      setStartingTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (cancelRequestedRef.current.delete(threadId)) {
        // The user pressed stop while the turn was still starting.
        if (result.turn?.id) await rpc("turn/interrupt", { threadId, turnId: result.turn.id });
        useTaskStore.getState().setActiveTurn(threadId, undefined);
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setTransientStatus("Stopped");
      }
      return true;
    } catch (reason) {
      setStartingTurn(false);
      // Use the locally captured thread id: for a brand-new thread the
      // activeThread closure is still null here, which used to leave the
      // thread stuck in "starting" forever.
      if (startedThreadId) {
        cancelRequestedRef.current.delete(startedThreadId);
        if (sentMessageId) useTaskStore.getState().removeMessage(startedThreadId, sentMessageId);
        useTaskStore.getState().setTaskStatus(startedThreadId, "error", friendlyError(reason));
      }
      setStatus("Ready");
      setError(friendlyError(reason));
      return false;
    }
  };

  const stopTurn = async () => {
    if (!activeThread || !running) return;
    const turnId = useTaskStore.getState().tasks[activeThread.id]?.activeTurnId;
    if (!turnId) {
      // The turn/start RPC is still in flight. Record the intent so
      // sendMessage interrupts the turn the moment its id is known.
      cancelRequestedRef.current.add(activeThread.id);
      setStatus("Stopping");
      return;
    }
    try {
      if (isClaudeThread(activeThread)) await interruptClaudeTurn(activeThread.id);
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      useTaskStore.getState().setActiveTurn(activeThread.id, undefined);
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      setStartingTurn(false);
      setTransientStatus("Stopped");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const retryRuntime = async () => {
    const runtime = await checkRuntime(false);
    if (!runtime.available) {
      setRuntimeSetupOpen(true);
      return;
    }
    try {
      await deliberateRestartRuntime();
      setRuntimeSetupOpen(false);
      setError(null);
      await Promise.all([refreshAccount(), refreshModels(), refreshUsage()]);
      if (activeWorkspace) await loadThreads(activeWorkspace);
      if (activeProject) await refreshTools(activeProject);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const beginChatGptLogin = async () => {
    if (!runtimeStatus?.available) {
      setAuthRequiredOpen(false);
      setRuntimeSetupOpen(true);
      return;
    }
    setLoginStarting(true);
    setError(null);
    try {
      const result = await rpc<{ authUrl?: string }>("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "codex" });
      if (!result.authUrl) throw new Error("Codex did not return a ChatGPT sign-in URL.");
      setAuthRequiredOpen(false);
      setStatus("Waiting for sign-in");
      await openUrl(result.authUrl);
      window.setTimeout(() => void refreshAccount(), 1800);
    } catch (reason) {
      setError(friendlyError(reason));
      setAuthRequiredOpen(true);
    } finally {
      setLoginStarting(false);
    }
  };

  const beginClaudeLogin = async () => {
    if (!claudeStatus?.available) {
      openSettings("models");
      setError("Install Claude Code first, then return here to sign in.");
      return;
    }
    setClaudeLoginStarting(true);
    setError(null);
    setStatus("Opening Claude sign-in");
    try {
      await startClaudeLogin();
      setStatus("Finish sign-in in Terminal");
      window.setTimeout(() => {
        void refreshClaudeStatus().then((next) => {
          if (next.loggedIn) setStatus("Ready");
        });
      }, 2500);
    } catch (reason) {
      setStatus("Setup required");
      setError(friendlyError(reason));
    } finally {
      setClaudeLoginStarting(false);
    }
  };

  const respondToApproval = useCallback(async (approval: PendingApproval, result: JsonObject) => {
    try {
      if (approval.method === "claude/can_use_tool") {
        await respondToClaudePermission(approval.threadId, String(approval.id), result);
      } else {
        await respond(approval.id, result);
      }
      void auditEvent("approval.resolved", { method: approval.method, responseRecorded: true }, approval.threadId).catch(() => {});
      useTaskStore.getState().resolveApproval(approval.threadId, approval.id);
    } catch (reason) {
      const message = friendlyError(reason);
      if (
        approval.method === "claude/can_use_tool" &&
        /no longer|not currently running/i.test(message)
      ) {
        useTaskStore
          .getState()
          .resolveApproval(approval.threadId, approval.id);
      }
      setError(message);
    }
  }, []);

  const startThreadRename = (thread: Thread) => {
    setRenamingThreadId(thread.id);
    setThreadNameDraft(thread.name || thread.preview || "Untitled thread");
  };

  const renameThread = async (thread: Thread) => {
    const name = threadNameDraft.trim();
    setRenamingThreadId(null);
    if (!name || name === thread.name) return;
    try {
      const updated = { ...thread, name };
      if (!isClaudeThread(thread)) await rpc("thread/name/set", { threadId: thread.id, name });
      rememberThread(updated);
      setThreads((current) => current.map((entry) => (entry.id === thread.id ? updated : entry)));
      setActiveThread((current) => (current?.id === thread.id ? { ...current, name } : current));
      if (isClaudeThread(thread)) {
        const task = useTaskStore.getState().tasks[thread.id];
        await saveClaudeTranscript({ thread: updated, messages: task?.messages ?? [], activities: task?.activities ?? [] });
      }
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const archiveThread = async (thread: Thread) => {
    const label = thread.name || thread.preview || "Untitled thread";
    if (!window.confirm(`Archive “${label}”?\n\nIt moves to the Archived list in the sidebar, where you can restore or permanently delete it.`)) return;
    try {
      if (!isClaudeThread(thread)) await rpc("thread/archive", { threadId: thread.id });
      if (activeThread?.id === thread.id) newThread();
      forgetThread(thread.id);
      setThreads((current) => current.filter((entry) => entry.id !== thread.id));
      const path = normalizedProjectPath(threadProjectBindingsRef.current?.[thread.id] || thread.cwd);
      persistArchivedThreads((current) => [{ id: thread.id, label, path, archivedAt: Date.now() }, ...current.filter((entry) => entry.id !== thread.id)]);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const unarchiveThread = async (record: ArchivedThread) => {
    try {
      const transcript = await loadClaudeTranscript(record.id);
      if (transcript) {
        rememberThread(transcript.thread);
      } else {
        await rpc("thread/unarchive", { threadId: record.id });
      }
      persistArchivedThreads((current) => current.filter((entry) => entry.id !== record.id));
      void loadThreads(activeWorkspace);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const deleteThreadForever = async (threadId: string, label: string) => {
    const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
    const claude = isClaudeThread(thread);
    if (!window.confirm(`Permanently delete “${label}”?\n\nThis removes the conversation from ${claude ? "OpenKiwi" : "the Codex runtime"} and cannot be undone.`)) return;
    try {
      if (claude) await deleteClaudeTranscript(threadId);
      else await rpc("thread/delete", { threadId });
      if (activeThread?.id === threadId) newThread();
      forgetThread(threadId);
      forgetThreadModel(threadId);
      setThreads((current) => current.filter((entry) => entry.id !== threadId));
      persistArchivedThreads((current) => current.filter((entry) => entry.id !== threadId));
      useTaskStore.getState().removeTask(threadId);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const toggleThreadPin = (threadId: string) => {
    const next = pinnedThreadIds.includes(threadId) ? pinnedThreadIds.filter((id) => id !== threadId) : [...pinnedThreadIds, threadId];
    setPinnedThreadIds(next);
    storeValue("kiwi.pinnedThreads", next);
  };

  const openStudio = (tab: StudioTab) => {
    setStudioTab(tab);
    setStudioOpen(true);
  };

  const startReview = async () => {
    if (!activeThread) return;
    if (isClaudeThread(activeThread)) {
      setError("Inline Studio review is currently available for OpenAI and OpenRouter threads. Ask Claude to review the project in the conversation instead.");
      return;
    }
    try {
      await rpc("review/start", { threadId: activeThread.id, target: { type: "uncommittedChanges" }, delivery: "inline" });
      setStatus("Reviewing");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const compactThread = async () => {
    if (!activeThread) return;
    if (isClaudeThread(activeThread)) {
      setError("Claude Code manages its own context compaction. OpenKiwi’s manual compact action is available for OpenAI and OpenRouter threads.");
      return;
    }
    try {
      await rpc("thread/compact/start", { threadId: activeThread.id });
      setStatus("Compacting context");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const openAgent = async (threadId: string) => {
    try {
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, result.thread.cwd);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const stopAgent = async (threadId: string) => {
    const turnId = useTaskStore.getState().tasks[threadId]?.activeTurnId;
    if (!turnId) {
      setError("That sub-agent does not have an active task to stop.");
      return;
    }
    try {
      await rpc("turn/interrupt", { threadId, turnId });
      useTaskStore.getState().setActiveTurn(threadId, undefined);
      useTaskStore.getState().setTaskStatus(threadId, "interrupted");
      if (activeThreadId) useTaskStore.getState().upsertAgent(activeThreadId, { id: threadId, prompt: "Delegated task", status: "interrupted" });
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const createCheckpoint = () => {
    if (!activeThread) return;
    const turnId = activeThread.turns?.at(-1)?.id;
    if (!turnId) {
      setError("Send a message first — a checkpoint marks the latest completed turn so you can fork from it.");
      return;
    }
    const checkpoint: CheckpointRecord = { id: crypto.randomUUID(), threadId: activeThread.id, turnId, label: `Checkpoint ${checkpoints.filter((item) => item.threadId === activeThread.id).length + 1}`, createdAt: Date.now() };
    const next = [checkpoint, ...checkpoints];
    setCheckpoints(next);
    storeValue("kiwi.checkpoints", next);
  };

  const forkThread = async (checkpoint?: CheckpointRecord) => {
    if (!activeThread) return;
    try {
      await ensureSkillRoots();
      const result = await rpc<{ thread: Thread }>("thread/fork", { threadId: checkpoint?.threadId ?? activeThread.id, lastTurnId: checkpoint?.turnId, cwd: activeWorkspace?.path, runtimeWorkspaceRoots: activeWorkspace ? [activeWorkspace.path] : undefined, model: effectiveSettings.model, modelProvider: effectiveSettings.provider === "openrouter" ? "openrouter" : undefined, config: threadRuntimeConfig(effectiveSettings, { customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined }), baseInstructions: effectiveSettings.systemPrompt, developerInstructions: "" });
      if (activeWorkspace) bindThreadToProject(result.thread.id, activeWorkspace.path);
      rememberThread(result.thread);
      persistThreadModel(result.thread.id, effectiveSettings.model);
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeWorkspace?.path);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
      void loadThreads(activeWorkspace);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const rollbackTurn = async () => {
    if (!activeThread) return;
    if (!window.confirm("Undo the last turn?\n\nThis permanently removes the latest exchange from the conversation. Files changed by the turn are not reverted.")) return;
    try {
      const result = await rpc<{ thread: Thread }>("thread/rollback", { threadId: activeThread.id, numTurns: 1 });
      rememberThread(result.thread);
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeWorkspace?.path);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const createWorktree = async () => {
    if (!activeProject) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .slice(0, 12);
    const worktreePath = `${activeProject.path}-openkiwi-${stamp}`;
    const branch = `openkiwi/${stamp}`;
    try {
      const result = await executeCommand(["git", "worktree", "add", worktreePath, "-b", branch], activeProject.path);
      terminal.append(`\n$ git worktree add ${worktreePath} -b ${branch}\n${result.stdout}${result.stderr}`);
      const project: Project = { id: crypto.randomUUID(), name: `${activeProject.name} · ${branch}`, path: worktreePath, worktree: { source: activeProject.path, branch } };
      const next = [...projects, project];
      setProjects(next);
      storeValue("kiwi.projects", next);
      setActiveProjectId(project.id);
      setWorkspaceMode("project");
      storeValue("kiwi.workspaceMode", "project");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const addAttachmentPaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const imagePattern = /\.(png|jpe?g|gif|webp|heic)$/i;
    setAttachments((current) => [...current, ...paths.filter((path) => !current.some((item) => item.path === path)).map((path) => ({ path, name: basename(path), kind: imagePattern.test(path) ? ("image" as const) : ("file" as const) }))]);
  }, []);

  addAttachmentPathsRef.current = addAttachmentPaths;

  const addAttachment = async () => {
    const selected = await open({ multiple: true, directory: false, title: "Add context files or images" });
    if (!selected) return;
    addAttachmentPaths(Array.isArray(selected) ? selected : [selected]);
  };

  const pasteImages = useCallback(async (items: DataTransferItemList) => {
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let offset = 0; offset < buffer.length; offset += chunk) {
          binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk));
        }
        const extension = (item.type.split("/")[1] ?? "png").toLowerCase();
        const path = await invoke<string>("save_pasted_image", { dataBase64: btoa(binary), extension });
        setAttachments((current) => (current.some((entry) => entry.path === path) ? current : [...current, { path, name: basename(path), kind: "image" }]));
      } catch (reason) {
        setError(friendlyError(reason));
      }
    }
  }, []);

  const runGitAction = async (action: "status" | "diff" | "stage" | "revert" | "commit" | "comments" | "ci" | "pr") => {
    if (!activeProject) return;
    let command: string[];
    if (action === "status") command = ["git", "status", "--short", "--branch"];
    else if (action === "diff") command = ["git", "diff", "--stat", "--patch"];
    else if (action === "stage") command = ["git", "add", "--all"];
    else if (action === "revert") {
      if (!window.confirm("Revert all tracked staged and working-tree changes? Untracked files will be kept.")) return;
      command = ["git", "restore", "--staged", "--worktree", "."];
    } else if (action === "commit") command = ["git", "commit", "-m", gitCommitMessage.trim()];
    else if (action === "comments") command = ["gh", "pr", "view", "--comments"];
    else if (action === "ci") command = ["gh", "pr", "checks"];
    else {
      if (!window.confirm("Create a draft pull request on the configured GitHub remote?")) return;
      command = ["gh", "pr", "create", "--draft", "--fill"];
    }
    try {
      const result = await executeCommand(command, activeProject.path);
      const combined = `${result.stdout}${result.stderr || ""}`;
      setGitOutput(combined.includes("not a git repository") ? "This project folder is not a Git repository yet. Initialize Git from the terminal to enable these workflows." : `$ ${command.join(" ")}\n${combined}\n[exit ${result.exitCode}]`);
      if (action === "diff" && activeThreadId) useTaskStore.getState().setDiff(activeThreadId, result.stdout);
      if (action === "commit" && result.exitCode === 0) setGitCommitMessage("");
    } catch (reason) {
      setGitOutput(friendlyError(reason));
    }
  };

  const runProjectAction = async (action: ProjectAction) => {
    if (!activeProject) return;
    setStudioTab("terminal");
    terminal.append(`${terminal.outputStore.get() ? "\n" : ""}$ ${action.command}\n`);
    try {
      const result = await executeCommand(["/bin/zsh", "-lc", action.command], activeProject.path);
      terminal.append(`${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
      void auditEvent("action.completed", { actionId: action.id, command: action.command, exitCode: result.exitCode }, activeThreadId ?? undefined).catch(() => {});
    } catch (reason) {
      terminal.append(`${friendlyError(reason)}\n`);
    }
  };

  const runGitPathAction = async (action: "stage" | "revert", path: string) => {
    if (!activeProject) return;
    if (action === "revert" && !window.confirm(`Revert changes to ${path}?`)) return;
    const command = action === "stage" ? ["git", "add", "--", path] : ["git", "restore", "--staged", "--worktree", "--", path];
    try {
      const result = await executeCommand(command, activeProject.path);
      setGitOutput(`$ ${command.join(" ")}\n${result.stdout}${result.stderr}\n[exit ${result.exitCode}]`);
      if (activeThreadId) await refreshDiffFor(activeThreadId, activeProject.path);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const chooseSkillsFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose your OpenKiwi skills folder" });
    if (!selected || Array.isArray(selected)) return;
    setSkillsFolder(selected);
    storeValue("kiwi.skillsFolder", selected);
    await refreshLocalSkills(selected, skillAliases, disabledSkillPaths);
  };

  const importSkills = async () => {
    if (!skillsFolder) return;
    const selected = await open({ directory: false, multiple: true, title: "Import Markdown skills", filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setSkillsBusy(true);
    setSkillsError("");
    try {
      await importLocalSkills(skillsFolder, paths);
      await refreshLocalSkills();
    } catch (reason) {
      setSkillsError(friendlyError(reason));
    } finally {
      setSkillsBusy(false);
    }
  };

  const createSkill = async (name: string, instructions: string): Promise<boolean> => {
    if (!skillsFolder) return false;
    setSkillsError("");
    try {
      await createLocalSkill(skillsFolder, name, instructions);
      await refreshLocalSkills();
      return true;
    } catch (reason) {
      setSkillsError(friendlyError(reason));
      return false;
    }
  };

  const renameSkill = (path: string, requestedName: string): boolean => {
    const name = normalizeSkillName(requestedName);
    if (!name) {
      setSkillsError("Skill names need at least one letter or number.");
      return false;
    }
    if (skills.some((skill) => skill.path !== path && skill.name === name)) {
      setSkillsError(`Another skill already uses $${name}.`);
      return false;
    }
    const next = { ...skillAliases, [path]: name };
    setSkillAliases(next);
    storeValue("kiwi.skillAliases", next);
    setSkills(resolveLocalSkills(skillFiles, next, disabledSkillPaths));
    setSkillsError("");
    return true;
  };

  const toggleSkill = (path: string) => {
    const next = disabledSkillPaths.includes(path) ? disabledSkillPaths.filter((candidate) => candidate !== path) : [...disabledSkillPaths, path];
    setDisabledSkillPaths(next);
    storeValue("kiwi.disabledSkills", next);
    setSkills(resolveLocalSkills(skillFiles, skillAliases, next));
  };

  const connectMcp = async (server: McpView) => {
    try {
      const result = await rpc<{ authorizationUrl: string }>("mcpServer/oauth/login", { name: server.name, threadId: activeThreadId });
      if (result.authorizationUrl) await openUrl(result.authorizationUrl);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const updateSchedule = useCallback((id: string, patch: (current: ScheduledTask) => ScheduledTask) => {
    setScheduledTasks((current) => {
      const next = current.map((item) => (item.id === id ? patch(item) : item));
      storeValue("kiwi.scheduledTasks", next);
      return next;
    });
  }, []);

  shortcutStateRef.current = { running: Boolean(running && activeThread), modalOpen: onboardingOpen || settingsOpen || commandPaletteOpen || runtimeSetupOpen || authRequiredOpen || Boolean(pendingApproval) || permissionOpen, threadOpen: Boolean(activeThreadId), stopTurn: () => void stopTurn(), newThread };

  const recordScheduleRun = useCallback((run: ScheduleRunRecord) => {
    setScheduleRuns((current) => {
      const next = [run, ...current].slice(0, 100);
      storeValue("kiwi.scheduleRuns", next);
      return next;
    });
  }, []);

  const persistWorkflows = useCallback((next: WorkflowDefinition[]) => {
    setWorkflows(next);
    storeValue("kiwi.workflows", next);
  }, []);

  const updateWorkflow = useCallback((id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => {
    setWorkflows((current) => {
      const next = current.map((workflow) => (workflow.id === id ? patch(workflow) : workflow));
      storeValue("kiwi.workflows", next);
      return next;
    });
  }, []);

  const recordWorkflowRun = useCallback((run: WorkflowRunRecord) => {
    setWorkflowRuns((current) => {
      const existing = current.findIndex((item) => item.id === run.id);
      const next = existing >= 0 ? current.map((item) => (item.id === run.id ? run : item)) : [run, ...current].slice(0, 100);
      storeValue(
        "kiwi.workflowRuns",
        next.map((item) => compactWorkflowRun(item)),
      );
      return next;
    });
  }, []);

  const { runWorkflow, stopWorkflow } = useWorkflowEngine({
    workflows,
    projects,
    runtimeAvailable: Boolean(runtimeStatus?.available),
    chatGptConnected: account?.type === "chatgpt",
    openRouterReady,
    customAgents,
    ensureSkillRoots,
    bindThreadToProject,
    updateWorkflow,
    recordRun: recordWorkflowRun,
    onThreadStarted: (project, threadId, source) => {
      if (source === "manual") {
        setActiveProjectId(project.id);
        setWorkspaceMode("project");
        storeValue("kiwi.workspaceMode", "project");
        void openAgent(threadId);
      } else if (activeProject?.id === project.id) {
        void loadThreads(project);
      }
    },
    onError: (message) => setError(message),
  });

  const runWorkflowFromShortcut = useCallback(
    async (workflow: WorkflowDefinition) => {
      if (workflowRuns.some((run) => run.workflowId === workflow.id && run.status === "running")) {
        setError(`“${workflow.name}” is already running.`);
        return;
      }
      const variables: Record<string, string> = {};
      for (const variable of workflow.variables ?? []) {
        if (!variable.promptOnRun) {
          variables[variable.name] = variable.value;
          continue;
        }
        const value = window.prompt(`Value for ${variable.name}`, variable.value);
        if (value === null) return;
        variables[variable.name] = value;
      }
      const commandCount = workflow.steps.filter((step) => step.type === "command").length;
      if (commandCount && !window.confirm(`Run “${workflow.name}” now?\n\nIt contains ${commandCount} shell command${commandCount === 1 ? "" : "s"} that will run with the saved ${workflow.run.permission} permission setting.`)) return;
      await runWorkflow(workflow.id, "manual", variables);
    },
    [runWorkflow, workflowRuns],
  );

  useScheduler({
    schedules: scheduledTasks,
    updateSchedule,
    recordRun: recordScheduleRun,
    projects,
    settings,
    runtimeAvailable: Boolean(runtimeStatus?.available),
    chatGptConnected: account?.type === "chatgpt",
    openRouterReady,
    ensureSkillRoots,
    bindThreadToProject,
    onThreadStarted: (project) => {
      if (activeProject?.id === project.id) void loadThreads(project);
    },
  });

  return (
    <div className="app-shell" data-theme={previewTheme ?? settings.theme} style={{ zoom: (settings.uiScale || 100) / 100 }}>
      <aside className={`sidebar ${sidebarOpen ? "open" : "closed"}`} style={sidebarOpen ? { flexBasis: paneSizes.sidebar, width: paneSizes.sidebar } : undefined}>
        {sidebarOpen && <div className="pane-resize sidebar-resize" onPointerDown={startPaneResize("sidebar")} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />}
        <div className="sidebar-brand">
          <div className="brand-mark">
            <img src="/openkiwi-logo.png" alt="" />
          </div>
          <span>OpenKiwi</span>
          <button className="icon-button subtle collapse-button" onClick={() => setSidebarOpen(false)} title="Hide sidebar" aria-label="Hide sidebar">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className="new-thread-button" onClick={newThread} disabled={!activeWorkspace} title={activeWorkspace?.isChat ? "Start a chat without a project folder" : activeProject ? `Start a thread in ${activeProject.name}` : "Select a workspace first"}>
          <Plus size={16} />
          <span>New thread</span>
          <kbd>⌘N</kbd>
        </button>

        <div className="sidebar-section workspaces-section">
          <div className="section-label-row">
            <span className="section-label">Workspaces</span>
            <button className="icon-button tiny" onClick={addProject} title="Add project" aria-label="Add project">
              <Plus size={14} />
            </button>
          </div>
          <div className="workspace-list">
            <button
              className={`workspace-row chat ${workspaceMode === "chat" ? "active" : ""}`}
              onClick={() => {
                setWorkspaceMode("chat");
                storeValue("kiwi.workspaceMode", "chat");
              }}
              title="Conversations without a project folder"
            >
              <span className="workspace-icon chat">
                <MessageSquare size={14} />
              </span>
              <span className="workspace-name">Chats</span>
            </button>
            {projects.map((project) => (
              <div key={project.id} className={`workspace-row-wrap ${workspaceMode === "project" && project.id === activeProjectId ? "active" : ""}`}>
                <button
                  className="workspace-row"
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setWorkspaceMode("project");
                    storeValue("kiwi.workspaceMode", "project");
                  }}
                  title={project.path}
                >
                  <span className="workspace-icon">{project.pinned ? <Pin size={13} /> : <Folder size={14} />}</span>
                  <span className="workspace-name">{project.name}</span>
                </button>
                <RowMenu
                  label={`Options for ${project.name}`}
                  scale={(settings.uiScale || 100) / 100}
                  items={[
                    { label: project.pinned ? "Unpin project" : "Pin project", icon: project.pinned ? <PinOff size={13} /> : <Pin size={13} />, onSelect: () => toggleProjectPin(project) },
                    { label: "Project settings", icon: <Settings size={13} />, onSelect: () => openSettings("projects") },
                    { label: "Remove from OpenKiwi", icon: <Trash2 size={13} />, danger: true, onSelect: () => removeProject(project) },
                  ]}
                />
              </div>
            ))}
            {!projects.length && (
              <button className="empty-project-button" onClick={addProject}>
                <FolderOpen size={17} />
                Open a folder
              </button>
            )}
          </div>
        </div>

        <div className="sidebar-section threads-section">
          <div className="section-label-row">
            <span className="section-label">Threads</span>
            {activeWorkspace && threads.length > 0 && <span className="thread-count">{threads.length}</span>}
          </div>
          {activeWorkspace && (
            <label className="thread-search">
              <Search size={11} />
              <input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder={`Search ${workspaceMode === "chat" ? "chats" : (activeProject?.name ?? "threads")}…`} />
            </label>
          )}
          <div className="thread-list">
            {displayedThreads.map((thread) => (
              <div key={thread.id} className={`thread-row-wrap ${activeThread?.id === thread.id ? "active" : ""}`}>
                {renamingThreadId === thread.id ? (
                  <div className="thread-rename-row">
                    <MessageSquare size={14} />
                    <input
                      autoFocus
                      value={threadNameDraft}
                      onChange={(event) => setThreadNameDraft(event.target.value)}
                      onBlur={() => void renameThread(thread)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void renameThread(thread);
                        if (event.key === "Escape") {
                          setThreadNameDraft(thread.name || "");
                          setRenamingThreadId(null);
                        }
                      }}
                      aria-label="Thread name"
                    />
                  </div>
                ) : (
                  <button className="thread-row" onClick={() => void selectThread(thread)}>
                    {pinnedThreadIds.includes(thread.id) ? <Pin size={13} /> : <MessageSquare size={14} />}
                    <span>{thread.name || thread.preview || "Untitled thread"}</span>
                    <ThreadRowBadge threadId={thread.id} />
                    <time className="thread-time">{timeAgo(thread.updatedAt)}</time>
                  </button>
                )}
                <RowMenu
                  label={`Options for ${thread.name || thread.preview || "thread"}`}
                  scale={(settings.uiScale || 100) / 100}
                  items={[
                    { label: pinnedThreadIds.includes(thread.id) ? "Unpin" : "Pin", icon: pinnedThreadIds.includes(thread.id) ? <PinOff size={13} /> : <Pin size={13} />, onSelect: () => toggleThreadPin(thread.id) },
                    { label: "Rename", icon: <Pencil size={13} />, onSelect: () => startThreadRename(thread) },
                    { label: "Archive", icon: <Archive size={13} />, onSelect: () => void archiveThread(thread) },
                    { label: "Delete forever", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteThreadForever(thread.id, thread.name || thread.preview || "Untitled thread") },
                  ]}
                />
              </div>
            ))}
            {activeWorkspace && !threads.length && <div className="empty-threads">{workspaceMode === "chat" ? "No normal chats yet" : "No threads in this project yet"}</div>}
          </div>
          {workspaceArchived.length > 0 && (
            <div className="archived-threads">
              <button className="archived-toggle" onClick={() => setArchivedOpen((open) => !open)} aria-expanded={archivedOpen}>
                <Archive size={12} />
                <span>Archived</span>
                <span className="thread-count">{workspaceArchived.length}</span>
                <ChevronDown className={archivedOpen ? "open" : ""} size={12} />
              </button>
              {archivedOpen &&
                workspaceArchived.map((record) => (
                  <div key={record.id} className="thread-row-wrap archived">
                    <span className="thread-row archived-label" title={`Archived ${new Date(record.archivedAt).toLocaleString()}`}>
                      <Archive size={13} />
                      <span>{record.label}</span>
                    </span>
                    <RowMenu
                      label={`Options for archived ${record.label}`}
                      scale={(settings.uiScale || 100) / 100}
                      items={[
                        { label: "Restore", icon: <ArchiveRestore size={13} />, onSelect: () => void unarchiveThread(record) },
                        { label: "Delete forever", icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteThreadForever(record.id, record.label) },
                      ]}
                    />
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-settings" onClick={() => openSettings()}>
            <Settings size={16} />
            <span>Settings</span>
            <span className={`provider-dot ${settings.provider}`} title={`Default provider: ${providerLabel(settings.provider)}`} />
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button className="icon-button" onClick={() => setSidebarOpen(true)} title="Show sidebar" aria-label="Show sidebar">
                <PanelLeftOpen size={18} />
              </button>
            )}
            <div className="project-heading">
              <span>{activeWorkspace?.isChat ? "Normal chat" : (activeProject?.name ?? "No project selected")}</span>
              <small>{activeThread ? activeThread.name || activeThread.preview || "New thread" : activeWorkspace?.isChat ? "No project folder" : (activeProject?.path ?? "Choose a project or use Chats")}</small>
            </div>
            {activeProject && (
              <ProjectPromptControl
                key={activeProject.id}
                projectName={activeProject.name}
                projectPrompt={activeProject.overrides?.systemPrompt}
                promptMode={activeProject.overrides?.systemPromptMode ?? "replace"}
                appPrompt={settings.systemPrompt}
                provider={effectiveSettings.provider}
                threadStarted={Boolean(activeThread)}
                onSave={persistActiveProjectPrompt}
                onAppPromptSettings={() => openSettings("prompts")}
              />
            )}
          </div>
          <div className="topbar-right">
            {activeThread && (
              <button className="icon-button" onClick={() => void exportTranscript()} title="Export conversation as Markdown" aria-label="Export conversation as Markdown">
                <Download size={15} />
              </button>
            )}
            <button className="command-palette-trigger" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette">
              <Command size={13} />
              <span>Search</span>
              <kbd>⌘K</kbd>
            </button>
            <div className="runtime-status">
              {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
              <span>{status}</span>
            </div>
            <ThreadProviderControl
              provider={effectiveSettings.provider}
              model={effectiveSettings.model}
              defaultProvider={settings.provider}
              threadStarted={Boolean(activeThread)}
              disabled={!activeWorkspace || running}
              onProvider={startNewThreadWithProvider}
              onDefaultSettings={() => openSettings("models")}
            />
            <button className={`workspace-tools-trigger studio-toggle ${studioOpen ? "active" : ""}`} onClick={() => (studioOpen ? setStudioOpen(false) : openStudio(studioTab))} title={activeProject ? "Open project workspace tools" : "Workspace tools are available inside projects"} aria-label={studioOpen ? "Close workspace tools" : "Open workspace tools"} aria-expanded={studioOpen} disabled={!activeProject}>
              <PanelRight size={17} />
              <span>Workspace</span>
            </button>
          </div>
        </header>

        {appUpdater.phase === "available" && (
          <div className="app-update-banner" role="status">
            <span className="app-update-banner-icon">
              <Download size={15} />
            </span>
            <span>
              <strong>OpenKiwi {appUpdater.availableVersion} is ready</strong>
              <small>Review the release notes, then update and restart from Settings.</small>
            </span>
            <button className="secondary-button" onClick={() => openSettings("updates")}>
              View update
            </button>
          </div>
        )}

        {!activeWorkspace ? (
          <section className="welcome-screen">
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                {errorSuggestsSettings && (
                  <button className="error-settings" onClick={() => openSettings()}>
                    Check settings
                  </button>
                )}
                <button onClick={() => setError(null)} aria-label="Dismiss error">
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="welcome-orbit">
              <Code2 size={34} />
            </div>
            <h1>Choose how you want to work.</h1>
            <p>Open a project for coding inside a folder, or use a normal chat with no project attached.</p>
            <div className="welcome-actions">
              <button className="primary-button large" onClick={addProject}>
                <FolderOpen size={17} /> Open project
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  setWorkspaceMode("chat");
                  storeValue("kiwi.workspaceMode", "chat");
                }}
              >
                <MessageSquare size={16} /> Normal chat
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="conversation">
              {convSearchOpen && activeThreadId && (
                <div className="conv-search-bar" role="search">
                  <Search size={12} />
                  <input
                    ref={convSearchInputRef}
                    value={convSearchQuery}
                    onChange={(event) => {
                      setConvSearchQuery(event.target.value);
                      setConvSearchIndex(0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        setConvSearchIndex((current) => current + (event.shiftKey ? -1 : 1));
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setConvSearchOpen(false);
                        setConvSearchQuery("");
                      }
                    }}
                    placeholder="Search this conversation…"
                    aria-label="Search this conversation"
                  />
                  <small>{convSearchQuery.trim() ? (convSearchCount ? `${(((convSearchIndex % convSearchCount) + convSearchCount) % convSearchCount) + 1} of ${convSearchCount}` : "No matches") : ""}</small>
                  <button onClick={() => setConvSearchIndex((current) => current - 1)} disabled={!convSearchCount} title="Previous match" aria-label="Previous match">
                    <ChevronDown style={{ transform: "rotate(180deg)" }} size={13} />
                  </button>
                  <button onClick={() => setConvSearchIndex((current) => current + 1)} disabled={!convSearchCount} title="Next match" aria-label="Next match">
                    <ChevronDown size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setConvSearchOpen(false);
                      setConvSearchQuery("");
                    }}
                    title="Close search"
                    aria-label="Close conversation search"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              {timelineEmpty || !activeThreadId ? (
                <div className="thread-empty-state">
                  <div className={`empty-state-icon ${activeWorkspace.isChat ? "chat" : ""}`}>{activeWorkspace.isChat ? <MessageSquare size={27} /> : <Bot size={27} />}</div>
                  <h1>{activeWorkspace.isChat ? "Start a normal chat." : "What should we build?"}</h1>
                  <p>{activeWorkspace.isChat ? "This conversation is not attached to any project folder. Ask a question, brainstorm, or work without repository context." : `This thread works inside ${activeProject?.name}. Commands and file changes start in that project folder.`}</p>
                  <div className="trust-strip">
                    <span>
                      <Check size={13} /> No app-added system prompt
                    </span>
                    <span>
                      <Check size={13} /> {activeWorkspace.isChat ? "No project folder" : "Local project access"}
                    </span>
                    <span>
                      <Check size={13} /> Approval controls
                    </span>
                  </div>
                  {!activeWorkspace.isChat && (
                    <div className="empty-state-actions" aria-label="Project workspace shortcuts">
                      <button onClick={() => openStudio("files")}>
                        <FileCode2 size={14} /> Browse files
                      </button>
                      <button onClick={() => openStudio("terminal")}>
                        <TerminalSquare size={14} /> Terminal
                      </button>
                      <button onClick={() => openStudio("review")}>
                        <Search size={14} /> Review changes
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <ErrorBoundary label="conversation">
                  <Suspense
                    fallback={
                      <div className="timeline-loading">
                        <LoaderCircle className="spin" size={15} /> Loading conversation…
                      </div>
                    }
                  >
                    <ConversationTimeline threadId={activeThreadId} running={running} thinkingLabel={activeWorkspace.isChat ? "Thinking in normal chat" : `Working in ${activeProject?.name}`} approval={inlineApproval} provider={effectiveSettings.provider} searchQuery={convSearchOpen ? convSearchQuery : ""} searchActiveMatch={convSearchIndex} onSearchMatches={setConvSearchCount} onEditMessage={editMessageIntoComposer} onApprovalRespond={(approval, result) => void respondToApproval(approval, result)} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </section>

            <section className="composer-zone">
              {error && (
                <div className="error-banner" role="alert">
                  <span>{error}</span>
                  {errorSuggestsSettings && (
                    <button className="error-settings" onClick={() => openSettings()}>
                      Check settings
                    </button>
                  )}
                  <button onClick={() => setError(null)} aria-label="Dismiss error">
                    <X size={14} />
                  </button>
                </div>
              )}
              <Composer
                ref={composerRef}
                threadKey={activeThreadId ?? `new:${activeWorkspace.path}`}
                running={running}
                steering={Boolean(running && activeThread)}
                dropActive={dropActive}
                placeholder={running && activeThread ? "Add direction to the running task…" : activeWorkspace.isChat ? "Ask anything — no project folder attached…" : `Ask OpenKiwi to work in ${activeProject?.name ?? "this project"}…`}
                attachments={attachments}
                searchFiles={searchProjectFiles}
                onRemoveAttachment={(path) => setAttachments((current) => current.filter((entry) => entry.path !== path))}
                onPasteImages={(items) => void pasteImages(items)}
                onSend={sendMessage}
                onStop={() => void stopTurn()}
                modelControls={
                  <>
                    {effectiveSettings.provider === "openai" && <ModelPowerControl model={effectiveSettings.model || DEFAULT_OPENAI_MODEL} effort={settings.reasoningEffort} ultra={settings.ultra} fast={settings.serviceTier === "priority"} runtimeModels={runtimeModels} onModel={persistComposerModel} onEffort={(reasoningEffort: ReasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })} onUltra={(ultra) => persistSettings({ ...settings, ultra, subagentsEnabled: ultra ? true : settings.subagentsEnabled })} onFast={(fast) => persistSettings({ ...settings, serviceTier: fast ? "priority" : null })} />}
                    {effectiveSettings.provider === "openrouter" && (
                      <OpenRouterModelControl
                        model={effectiveSettings.model}
                        effort={settings.reasoningEffort}
                        models={openRouterModels}
                        loading={openRouterModelsLoading}
                        error={openRouterModelsError}
                        onModel={(model) => {
                          persistComposerModel(model);
                          if (settings.ultra) persistSettings({ ...settings, ultra: false });
                        }}
                        onEffort={(reasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })}
                        onRefresh={() => void refreshOpenRouterModels()}
                      />
                    )}
                    {effectiveSettings.provider === "claude" && <ClaudeModelControl model={effectiveSettings.model || DEFAULT_CLAUDE_MODEL} effort={settings.reasoningEffort} onModel={(model) => persistComposerModel(model)} onEffort={(reasoningEffort) => persistSettings({ ...settings, reasoningEffort, ultra: false })} />}
                  </>
                }
                controls={
                  <>
                    <div className="permission-control" ref={permissionControlRef}>
                      <button className="toolbar-button" onClick={() => setPermissionOpen((open) => !open)} aria-haspopup="menu" aria-expanded={permissionOpen}>
                        <PermissionIcon mode={effectiveSettings.permission} />
                        {permissionLabel(effectiveSettings.permission)}
                        {activeProject?.overrides?.permission && <em className="project-override-mark">project</em>}
                        <ChevronDown size={13} />
                      </button>
                      {permissionOpen && (
                        <div className="permission-menu" role="menu" aria-label="Permission mode">
                          {(["read-only", "ask", "full"] as PermissionMode[]).map((mode) => (
                            <button
                              key={mode}
                              className={effectiveSettings.permission === mode ? "selected" : ""}
                              onClick={() => {
                                persistComposerPermission(mode);
                                setPermissionOpen(false);
                              }}
                            >
                              <PermissionIcon mode={mode} size={17} />
                              <span>
                                <strong>{permissionLabel(mode)}</strong>
                                <small>{mode === "read-only" ? "Inspect without changing files" : mode === "ask" ? "Work locally; ask for elevated actions" : "Unrestricted local access"}</small>
                              </span>
                              {effectiveSettings.permission === mode && <Check size={15} />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className={`toolbar-button agents-button ${settings.subagentsEnabled ? "enabled" : ""}`} onClick={() => persistSettings({ ...settings, subagentsEnabled: !settings.subagentsEnabled })} disabled={Boolean(activeThread)} title={activeThread ? "Sub-agent access is fixed when a thread starts" : "Allow the model to spawn direct sub-agents for this thread"}>
                      <UsersRound size={14} />
                      {settings.subagentsEnabled ? `Agents: ${settings.subagentMax}` : "Agents off"}
                    </button>
                    <button className={`toolbar-button ${attachments.length ? "has-attachments" : ""}`} onClick={() => void addAttachment()} title="Attach context">
                      <Paperclip size={14} />
                      {attachments.length ? attachments.length : "Attach"}
                    </button>
                  </>
                }
              />
              <div className="composer-caption">
                OpenKiwi can make mistakes. Review commands and changes before shipping.
                {tokenUsage?.contextWindow ? (
                  <span className={`context-meter ${tokenUsage.totalTokens / tokenUsage.contextWindow > 0.8 ? "warn" : ""}`}>
                    {" "}
                    · Context {Math.min(100, Math.round((tokenUsage.totalTokens / tokenUsage.contextWindow) * 100))}% used{costEstimate ? ` · ${costEstimate}` : ""}
                  </span>
                ) : null}
              </div>
            </section>
          </>
        )}
      </main>

      <ErrorBoundary label="workspace tools">
        <Suspense fallback={null}>
          <StudioDock
            open={studioOpen && Boolean(activeProject)}
            width={paneSizes.dock}
            onResizeStart={startPaneResize("dock")}
            tab={studioTab}
            projectName={activeProject?.name}
            projectPath={activeProject?.path}
            activeThread={Boolean(activeThread)}
            diff={diff}
            agents={agentRecords}
            terminalOutput={terminal.outputStore}
            terminalCommand={terminal.command}
            terminalRunning={terminal.running}
            checkpoints={checkpoints.filter((item) => !activeThread || item.threadId === activeThread.id)}
            attachments={attachments}
            usage={tokenUsage}
            costEstimate={costEstimate}
            costTotals={costTotalsView}
            accountUsage={accountUsageView}
            skills={skills}
            mcpServers={mcpServers}
            gitOutput={gitOutput}
            gitCommitMessage={gitCommitMessage}
            promptAudit={[
              { label: "Base instruction", value: effectiveSettings.systemPrompt ? `${activeProject?.overrides?.systemPrompt ? (activeProject.overrides.systemPromptMode === "append" && settings.systemPrompt.trim() ? "app + project" : "project") : "app"} · ${effectiveSettings.systemPrompt.length} chars` : "empty" },
              { label: "Developer instruction", value: "empty" },
              { label: "AGENTS.md discovery", value: settings.projectInstructionsEnabled ? "enabled · up to 32 KB" : "disabled" },
              { label: "Model", value: effectiveSettings.model || "provider default" },
              { label: "Reasoning", value: settings.ultra ? "ultra" : settings.reasoningEffort },
              { label: "Sub-agents", value: settings.subagentsEnabled ? `on · max ${settings.subagentMax}` : "off" },
              { label: "Skills", value: skillsFolder ? `${skills.filter((skill) => skill.enabled).length} enabled · local folder` : "no folder selected" },
              { label: "Permissions", value: permissionLabel(effectiveSettings.permission) },
              { label: "Service tier", value: settings.serviceTier || "standard" },
            ]}
            projectActions={projectActions}
            workflows={workflows.filter((workflow) => workflow.projectId === activeProject?.id && workflow.enabled)}
            workflowRuns={workflowRuns}
            onTab={setStudioTab}
            onClose={() => setStudioOpen(false)}
            onRefreshDiff={() => void refreshDiff()}
            onReview={() => void startReview()}
            onOpenAgent={(id) => void openAgent(id)}
            onStopAgent={(id) => void stopAgent(id)}
            onTerminalCommand={terminal.setCommand}
            onRunTerminal={() => {
              if (activeProject) void terminal.run(activeProject.path);
            }}
            onStopTerminal={() => void terminal.stop()}
            onTerminalInput={terminal.write}
            onTerminalResize={terminal.resize}
            onCheckpoint={createCheckpoint}
            onFork={(checkpoint) => void forkThread(checkpoint)}
            onRollback={() => void rollbackTurn()}
            onWorktree={() => void createWorktree()}
            onAddAttachment={() => void addAttachment()}
            onRemoveAttachment={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
            onRefreshUsage={() => {
              if (effectiveSettings.provider === "claude") void refreshClaudeStatus();
              else if (effectiveSettings.provider === "openrouter") void hasOpenRouterKey().then(setOpenRouterReady).catch(() => setOpenRouterReady(false));
              else void refreshUsage();
            }}
            onCompact={() => void compactThread()}
            onRefreshTools={() => void refreshTools(activeProject)}
            onGitAction={(action) => void runGitAction(action)}
            onGitCommitMessage={setGitCommitMessage}
            onGitPathAction={(action, path) => void runGitPathAction(action, path)}
            onAttachPath={(path) => setAttachments((current) => (current.some((item) => item.path === path) ? current : [...current, { path, name: basename(path), kind: "file" }]))}
            onProjectAction={(action) => void runProjectAction(action)}
            onRunWorkflow={(workflow) => void runWorkflowFromShortcut(workflow)}
            onStopWorkflow={(workflowId) => void stopWorkflow(workflowId)}
            onOpenWorkflowRun={(threadId) => void openAgent(threadId)}
            onToggleSkill={(skill) => void toggleSkill(skill)}
            onConnectMcp={(server) => void connectMcp(server)}
          />
        </Suspense>
      </ErrorBoundary>

      <SettingsModal
        open={settingsOpen}
        initialSection={settingsInitialSection}
        appUpdater={appUpdater}
        settings={settings}
        account={account}
        runtimeStatus={runtimeStatus}
        claudeStatus={claudeStatus}
        claudeLoginStarting={claudeLoginStarting}
        openRouterReady={openRouterReady}
        onClose={closeSettings}
        onSave={(next) => {
          persistSettings(next);
          closeSettings();
        }}
        onThemePreview={setPreviewTheme}
        onAccountChange={async () => {
          await refreshAccount();
          await refreshModels();
        }}
        onSignIn={beginChatGptLogin}
        onClaudeSignIn={beginClaudeLogin}
        onClaudeRefresh={refreshClaudeStatus}
        onRuntimeRequired={() => setRuntimeSetupOpen(true)}
        onWorkspaceTools={() => {
          closeSettings();
          openStudio("tools");
        }}
        onOpenRouterChange={setOpenRouterReady}
        onError={setError}
        profiles={promptProfiles}
        agents={customAgents}
        actions={projectActions}
        schedules={scheduledTasks}
        workflows={workflows}
        workflowRuns={workflowRuns}
        projects={projects}
        skillsFolder={skillsFolder}
        skills={skills}
        skillsBusy={skillsBusy}
        skillsError={skillsError}
        mcpServers={mcpServers}
        onMcpChanged={() => void refreshTools(activeProject)}
        workspaceToolsAvailable={Boolean(activeProject)}
        onProfiles={(value) => {
          setPromptProfiles(value);
          storeValue("kiwi.promptProfiles", value);
        }}
        onAgents={(value) => {
          setCustomAgents(value);
          storeValue("kiwi.customAgents", value);
        }}
        onActions={(value) => {
          setProjectActions(value);
          storeValue("kiwi.projectActions", value);
        }}
        onSchedules={(value) => {
          setScheduledTasks(value);
          storeValue("kiwi.scheduledTasks", value);
        }}
        onWorkflows={persistWorkflows}
        onRunWorkflow={async (workflowId, variables) => {
          closeSettings();
          await runWorkflow(workflowId, "manual", variables);
        }}
        onStopWorkflow={(workflowId) => stopWorkflow(workflowId)}
        onProjects={(value) => {
          setProjects(value);
          storeValue("kiwi.projects", value);
        }}
        scheduleRuns={scheduleRuns}
        onOpenRun={(threadId) => {
          closeSettings();
          void openAgent(threadId);
        }}
        onChooseSkillsFolder={() => void chooseSkillsFolder()}
        onRefreshSkills={() => void refreshLocalSkills()}
        onImportSkills={() => void importSkills()}
        onCreateSkill={createSkill}
        onRenameSkill={renameSkill}
        onToggleSkill={toggleSkill}
        onOpenOnboarding={() => {
          closeSettings();
          openOnboarding();
        }}
      />

      {onboardingMounted && (
        <Suspense fallback={null}>
          <OnboardingModal open={onboardingOpen} runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} account={account} openRouterReady={openRouterReady} skillsFolder={skillsFolder} onComplete={completeOnboarding} onOpenSettings={(section) => openSettings(section)} onChooseSkillsFolder={() => void chooseSkillsFolder()} onAddProject={() => void addProject()} onStartChat={startNormalChat} />
        </Suspense>
      )}

      <RuntimeSetupModal open={runtimeSetupOpen} checking={runtimeChecking} onClose={() => setRuntimeSetupOpen(false)} onRetry={() => void retryRuntime()} />

      <AuthRequiredModal open={authRequiredOpen} busy={loginStarting} onClose={() => setAuthRequiredOpen(false)} onSignIn={() => void beginChatGptLogin()} />

      {pendingApproval && (
        <ApprovalCenter
          approval={pendingApproval}
          threadLabel={(() => {
            if (pendingApproval.threadId === "runtime") return undefined;
            const known = knownThreadsRef.current?.[pendingApproval.threadId];
            const thread = threads.find((entry) => entry.id === pendingApproval.threadId) ?? known;
            return thread?.name || thread?.preview || `thread ${pendingApproval.threadId.slice(0, 8)}`;
          })()}
          pendingCount={pendingApprovalCount - 1}
          onRespond={(result) => void respondToApproval(pendingApproval, result)}
        />
      )}
      <CommandPalette
        open={commandPaletteOpen}
        projects={projects}
        threads={threads}
        workflows={workflows}
        projectActive={Boolean(activeProject)}
        onClose={() => setCommandPaletteOpen(false)}
        onProject={(project) => {
          setActiveProjectId(project.id);
          setWorkspaceMode("project");
          storeValue("kiwi.workspaceMode", "project");
        }}
        onThread={(thread) => void selectThread(thread)}
        onWorkflow={(workflow) => void runWorkflowFromShortcut(workflow)}
        onNewThread={newThread}
        onSettings={() => openSettings()}
        onTool={openStudio}
      />
    </div>
  );
}

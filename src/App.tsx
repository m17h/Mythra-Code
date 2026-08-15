import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Archive, ArchiveRestore, Bot, Check, ChevronDown, Circle, Code2, Command, Download, FileCode2, Folder, FolderOpen, GitBranch, GitFork, LoaderCircle, MessageSquare, Paperclip, PanelRight, PanelLeftClose, PanelLeftOpen, Plus, Pin, PinOff, Pencil, Search, Settings, Shield, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, X } from "lucide-react";
import { getCodexRuntimeStatus, auditEvent, exportTextFile, getNormalChatWorkspace, hasOpenRouterKey, listOpenRouterModels, respond, restartRuntime, rpc, runtimeInstanceId, type CodexRuntimeStatus, type JsonObject } from "./lib/codex";
import { deleteClaudeTranscript, getClaudeRuntimeStatus, loadClaudeTranscript, respondClaudeControlError, respondToClaudePermission, saveClaudeTranscript, startClaudeLogin, type ClaudeRuntimeStatus } from "./lib/claude";
import { deleteCursorTranscript, getCursorRuntimeStatus, listCursorModels, loadCursorTranscript, respondToCursorPermission, saveCursorTranscript, startCursorLogin, type CursorModel, type CursorRuntimeStatus } from "./lib/cursor";
import { loadStored, storeValue } from "./lib/storage";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PROMPT_PROFILES, DEFAULT_SETTINGS, THEMES } from "./lib/appConfig";
import { commandSandbox, threadResumeParams, threadRuntimeConfig } from "./lib/turnConfig";
import { threadSearchParams, threadsForWorkspace, type ThreadSearchResponse } from "./lib/threadSearch";
import { countActiveThreadsByWorkspace, filterThreadsByKind, filterThreadsForWorkspace, forgetSidebarThread, isSubAgentThread, pruneSidebarIndex, reconcileWorkspaceThreads, rememberSidebarThread, sidebarThread, threadBelongsToWorkspace, upsertThread, type ThreadSidebarIndex } from "./lib/threadList";
import { timelineFromTurns } from "./lib/threadTimeline";
import { buildTranscriptMarkdown } from "./lib/transcript";
import { RowMenu } from "./components/RowMenu";
import { ModelPowerControl, type RuntimeModel } from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import { ClaudeModelControl } from "./components/ClaudeModelControl";
import { CursorModelControl } from "./components/CursorModelControl";
import { ThreadProviderControl } from "./components/ThreadProviderControl";
import { ThreadInboxCard } from "./components/ThreadInboxCard";
import { ProjectPromptControl } from "./components/ProjectPromptControl";
import { ApprovalCenter } from "./components/ApprovalCenter";
import { Composer, discardDraft, type ComposerHandle } from "./components/Composer";
import { SubAgentCommandCenter, type SubAgentModelOption, type SubAgentPolicyMode } from "./components/SubAgentCommandCenter";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsModal } from "./components/SettingsModal";
import { AuthRequiredModal, RuntimeSetupModal } from "./components/RuntimeModals";
import type { AgentRecord, AttachmentRecord, McpView, StudioTab } from "./components/StudioDock";
import type { Account, Activity, AppSettings, ArchivedThread, ChatMessage, CustomAgentProfile, PendingApproval, PermissionMode, Project, ProjectAction, ProjectPromptMode, ProjectSubagentSettings, PromptProfile, Provider, ScheduledTask, ScheduleRunRecord, SettingsSection, Thread, ThreadHandoff, ThreadReasoning, ThemeName, WorkspaceMode } from "./types";
import { PendingTurnStarts } from "./lib/pendingTurnStarts";
import { useTaskStore, type QueuedTurn } from "./lib/taskStore";
import { friendlyError } from "./lib/errors";
import { recordError } from "./lib/errorLog";
import {
  annotateThreadUsage,
  estimateUsageCost,
  formatEstimatedCost,
  modelPricingCatalogRevision,
  pricingForModel,
  refreshModelPricingCatalog,
  usageForThread,
  usageTotals,
  type ModelPricing,
} from "./lib/usageLedger";
import { costTotals, formatCost, recordThreadCost } from "./lib/costLedger";
import {
  attachGitHubRemote,
  cloneGitHubRepository,
  createGitHubRepository,
  getGitHubRepoStatus,
  getGitHubStatus,
  gitActionUnavailableReason,
  githubCliCommand,
  gitPushCompletionNote,
  gitPushCommand,
  startGitHubLogin,
  type GitWorkspaceAction,
  type GitHubAccountStatus,
  type GitHubRepoStatus,
} from "./lib/github";
import { useAppUpdater } from "./lib/appUpdater";
import { usePersistedState, usePersistedStateRef } from "./hooks/usePersistedState";
import { forgetQueuedDeliveries, useTurnRunner } from "./hooks/useTurnRunner";
import { useCheckpoints } from "./hooks/useCheckpoints";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useThreadHealth } from "./hooks/useThreadHealth";
import { useCodexEvents } from "./hooks/useCodexEvents";
import { useClaudeEvents } from "./hooks/useClaudeEvents";
import { useCursorEvents } from "./hooks/useCursorEvents";
import { useScheduler } from "./hooks/useScheduler";
import { useTerminal } from "./hooks/useTerminal";
import { PANE_BOUNDS, usePaneResize } from "./hooks/usePaneResize";
import { useSidebarSplitResize } from "./hooks/useSidebarSplitResize";
import { useWorkflowEngine } from "./hooks/useWorkflowEngine";
import { isEstablishedOpenKiwiInstall, ONBOARDING_EXIT_MS, ONBOARDING_VERSION } from "./lib/onboarding";
import { createLocalSkill, importLocalSkills, normalizeSkillName, resolveLocalSkills, scanLocalSkills, syncLocalSkills, type LocalSkill, type LocalSkillFile } from "./lib/skills";
import { compactWorkflowRun, normalizeWorkflows, recoverWorkflowRuns, type WorkflowDefinition, type WorkflowRunRecord } from "./lib/workflows";
import { isClaudeThread, isCursorThread, isLocalSubscriptionThread, modelForProvider, providerFromThread } from "./lib/threadProvider";
import { basename, normalizedProjectPath } from "./lib/paths";
import { resolveProviderSystemPrompt, resolveSystemPrompt } from "./lib/systemPrompt";
import { providerAccountUsage } from "./lib/providerUsage";
import { contextUsagePercent } from "./lib/contextUsage";
import { openKiwiDeveloperInstructions } from "./lib/completionPrompt";
import { providerForArchivedThread } from "./lib/threadArchive";
import { buildProviderHandoffPrompt, sanitizePendingHandoff } from "./lib/providerHandoff";
import { deleteThreadTurnDurations } from "./lib/turnDurations";
import {
  childAgentLinksAfterThreadDeletion,
  childAgentModel,
  describeChildAgentRoster,
  childAgentPolicyForThread,
  crewSafeConcurrency,
  providerDisplayName,
  projectSubagentSettingsFromApp,
  readyChildAgentTargets,
  sanitizeChildAgentLinks,
  sanitizeChildAgentPolicies,
  sanitizeChildAgentSettings,
  sanitizeProjectSubagentOverrides,
  settingsWithoutChildDelegation,
  settingsWithProjectSubagents,
  type ChildAgentLink,
  type ChildAgentPolicy,
  type ChildAgentReadiness,
} from "./lib/childAgents";
import { cacheChildAgentPolicy, ensureChildAgentBridge, invalidateChildAgentLaunch, releaseChildAgentSessions } from "./lib/childAgentSessions";
import { forgetSubagentCapabilities, planSubagentCapabilities, recordSubagentCapabilities, subagentCapabilitySignature } from "./lib/threadCapabilities";
import { nativeAgentLinkFromThread, nativeAgentLinksAfterThreadDeletion, sanitizeNativeAgentLinks, type NativeAgentLink } from "./lib/nativeAgentLinks";
import { collectSubAgentWorkers, isSubAgentWorkerActive, type SubAgentWorker } from "./lib/subAgentActivity";
import { useChildAgents } from "./hooks/useChildAgents";
import { reorderProjects, type ProjectDropPosition } from "./lib/projectOrdering";
import {
  deleteCheckpointSnapshot,
  type CheckpointRecord,
} from "./lib/checkpoints";
import {
  applyWorktreeToSource,
  executionPathForThread,
  initializeWorkspaceGit,
  mergeWorktreeBranch,
  recreateThreadWorktree,
  readWorkspaceGitInfo,
  readWorktreeStatus,
  removeThreadWorktree,
  type ThreadWorktreeRecord,
  type WorktreeStatus,
  type WorkspaceGitInfo,
} from "./lib/worktrees";

const ChatTimeline = lazy(() => import("./components/ChatTimeline").then((module) => ({ default: module.ChatTimeline })));
const StudioDock = lazy(() => import("./components/StudioDock").then((module) => ({ default: module.StudioDock })));
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then((module) => ({ default: module.OnboardingModal })));

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Activity[] = [];
const EMPTY_AGENTS: AgentRecord[] = [];
const EMPTY_QUEUED_TURNS: QueuedTurn[] = [];
const LOCAL_TRANSCRIPT_SAVE_DEBOUNCE_MS = 900;

const initialProjects = sanitizeProjectSubagentOverrides(loadStored<Project[]>("kiwi.projects", []));
const initialWorkspaceMode: WorkspaceMode = loadStored<WorkspaceMode>("kiwi.workspaceMode", initialProjects.length ? "project" : "chat");
const initialKnownThreads = pruneSidebarIndex(loadStored<ThreadSidebarIndex>("kiwi.knownThreads", {}));
const initialOnboardingVersion = loadStored<number>("kiwi.onboardingVersion", 0);
const establishedInstall = isEstablishedOpenKiwiInstall({ projects: initialProjects.length, knownThreads: Object.keys(initialKnownThreads).length, hasStoredSettings: localStorage.getItem("kiwi.settings") !== null, hasSkillsFolder: Boolean(loadStored<string>("kiwi.skillsFolder", "")) });
const initialOnboardingOpen = initialOnboardingVersion < ONBOARDING_VERSION && !establishedInstall;
const storedSettings = loadStored<Partial<AppSettings>>("kiwi.settings", {});
const initialChildAgents = sanitizeChildAgentSettings(storedSettings.childAgents);
const initialSettings: AppSettings = { ...DEFAULT_SETTINGS, ...storedSettings, openAiLogo: storedSettings.openAiLogo === "codex" ? "codex" : "openai", claudeLogo: storedSettings.claudeLogo === "anthropic" ? "anthropic" : "claude", cursorLogo: storedSettings.cursorLogo === "app-dark" ? "app-dark" : "cube", subagentMax: crewSafeConcurrency(Number(storedSettings.subagentMax) || DEFAULT_SETTINGS.subagentMax, initialChildAgents), childAgents: initialChildAgents, model: modelForProvider(storedSettings.provider ?? DEFAULT_SETTINGS.provider, storedSettings.model ?? DEFAULT_SETTINGS.model), theme: THEMES.some((theme) => theme.id === storedSettings.theme) ? storedSettings.theme! : DEFAULT_SETTINGS.theme, uiScale: Math.min(150, Math.max(80, Number(storedSettings.uiScale) || DEFAULT_SETTINGS.uiScale)) };

function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function providerLabel(provider: AppSettings["provider"]): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "claude") return "Claude";
  if (provider === "cursor") return "Cursor";
  return "OpenAI";
}

function PermissionIcon({ mode, size = 15 }: { mode: PermissionMode; size?: number }) {
  if (mode === "read-only") return <Shield size={size} />;
  if (mode === "full") return <ShieldAlert size={size} />;
  return <ShieldCheck size={size} />;
}

/**
 * Subscribes to the streaming timeline itself so per-frame delta flushes stop
 * at this component boundary instead of re-rendering the entire App.
 */
function ConversationTimeline({ threadId, running, thinkingLabel, approval, provider, searchQuery, searchActiveMatch, onSearchMatches, onEditMessage, onApprovalRespond }: { threadId: string; running: boolean; thinkingLabel: string; approval: PendingApproval | null; provider: AppSettings["provider"]; searchQuery?: string; searchActiveMatch?: number; onSearchMatches?: (count: number) => void; onEditMessage: (text: string) => void; onApprovalRespond: (approval: PendingApproval, result: JsonObject) => void | Promise<void> }) {
  const messages = useTaskStore((state) => state.tasks[threadId]?.messages ?? EMPTY_MESSAGES);
  const activities = useTaskStore((state) => state.tasks[threadId]?.activities ?? EMPTY_ACTIVITIES);
  // A thread change must create a fresh virtual scroller so its initial
  // position is applied to the newly selected conversation.
  return <ChatTimeline key={threadId} messages={messages} activities={activities} running={running} thinkingLabel={thinkingLabel} approval={approval} provider={provider} searchQuery={searchQuery} searchActiveMatch={searchActiveMatch} onSearchMatches={onSearchMatches} onEditMessage={onEditMessage} onApprovalRespond={onApprovalRespond} />;
}

export default function App() {
  const appUpdater = useAppUpdater();
  const [projects, setProjects] = usePersistedState<Project[]>("kiwi.projects", [], { init: () => initialProjects });
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialProjects[0]?.id ?? null);
  const [workspaceMode, setWorkspaceMode] = usePersistedState<WorkspaceMode>("kiwi.workspaceMode", "chat", { init: () => initialWorkspaceMode });
  const [chatWorkspacePath, setChatWorkspacePath] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  // True only while a send with no active thread yet (a brand-new draft) is
  // creating its thread. Once a thread exists, its own task status carries
  // the starting/running state — never a global flag, so a start in one
  // thread cannot make another thread look busy.
  const [startingDraftTurn, setStartingDraftTurn] = useState(false);
  const [settings, persistSettings] = usePersistedState<AppSettings>("kiwi.settings", DEFAULT_SETTINGS, { init: () => initialSettings });
  const [threadModels, setThreadModels] = usePersistedState<Record<string, string>>("kiwi.threadModels", {});
  const [threadReasoning, setThreadReasoning] = usePersistedState<Record<string, ThreadReasoning>>("kiwi.threadReasoning", {});
  const [draftThreadProvider, setDraftThreadProvider] = useState<Provider | null>(null);
  const [draftThreadModel, setDraftThreadModel] = useState<string | null>(null);
  const [draftThreadIsolated, setDraftThreadIsolated] = useState(false);
  const [threadWorktrees, persistThreadWorktrees, threadWorktreesRef] = usePersistedStateRef<Record<string, ThreadWorktreeRecord>>("kiwi.threadWorktrees", {});
  const [workspaceGitInfo, setWorkspaceGitInfo] = useState<WorkspaceGitInfo | null>(null);
  const [gitInitializing, setGitInitializing] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const successToastTimerRef = useRef<number | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<ThemeName | null>(null);
  const [promptProfiles, setPromptProfiles] = usePersistedState<PromptProfile[]>("kiwi.promptProfiles", DEFAULT_PROMPT_PROFILES);
  const [customAgents, setCustomAgents] = usePersistedState<CustomAgentProfile[]>("kiwi.customAgents", []);
  const [projectActions, setProjectActions] = usePersistedState<ProjectAction[]>("kiwi.projectActions", []);
  const [scheduledTasks, setScheduledTasks] = usePersistedState<ScheduledTask[]>("kiwi.scheduledTasks", []);
  const [scheduleRuns, setScheduleRuns] = usePersistedState<ScheduleRunRecord[]>("kiwi.scheduleRuns", []);
  const [workflows, setWorkflows] = usePersistedState<WorkflowDefinition[]>("kiwi.workflows", [], { init: (load) => normalizeWorkflows(load()) });
  const [workflowRuns, setWorkflowRuns] = usePersistedState<WorkflowRunRecord[]>("kiwi.workflowRuns", [], {
    init: (load) => recoverWorkflowRuns(load()),
    serialize: (runs) => runs.map((run) => compactWorkflowRun(run)),
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("general");
  const [onboardingOpen, setOnboardingOpen] = useState(initialOnboardingOpen);
  const [onboardingMounted, setOnboardingMounted] = useState(initialOnboardingOpen);
  const onboardingExitTimerRef = useRef<number | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [threadKindView, setThreadKindView] = useState<"main" | "subagents">("main");
  const [convSearchOpen, setConvSearchOpen] = useState(false);
  const [convSearchQuery, setConvSearchQuery] = useState("");
  const [convSearchIndex, setConvSearchIndex] = useState(0);
  const [convSearchCount, setConvSearchCount] = useState(0);
  const convSearchInputRef = useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = useState<Thread[] | null>(null);
  const [pinnedThreadIds, setPinnedThreadIds] = usePersistedState<string[]>("kiwi.pinnedThreads", []);
  const [archivedThreads, persistArchivedThreads] = usePersistedState<ArchivedThread[]>("kiwi.archivedThreads", []);
  const [threadHandoffs, persistThreadHandoffs] = usePersistedState<Record<string, ThreadHandoff>>("kiwi.threadHandoffs", {});
  // Cross-provider delegation: one frozen policy per bridge session, plus the
  // parent/child ownership record that outlives a reload.
  const [childAgentPolicies, persistChildAgentPolicies] = usePersistedState<Record<string, ChildAgentPolicy>>("kiwi.childAgentPolicies", {}, { init: (load) => sanitizeChildAgentPolicies(load()) });
  const [childAgentLinks, persistChildAgentLinks] = usePersistedState<Record<string, ChildAgentLink>>("kiwi.childAgentLinks", {}, { init: (load) => sanitizeChildAgentLinks(load()) });
  const [nativeAgentLinks, persistNativeAgentLinks] = usePersistedState<Record<string, NativeAgentLink>>("kiwi.nativeAgentLinks", {}, { init: (load) => sanitizeNativeAgentLinks(load()) });
  const [pendingHandoff, setPendingHandoff] = usePersistedState<ThreadHandoff | null>("kiwi.pendingHandoff", null, {
    init: (load) => sanitizePendingHandoff(load()),
  });
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadNameDraft, setThreadNameDraft] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const draggedProjectIdRef = useRef<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{ id: string; position: ProjectDropPosition } | null>(null);
  const projectDropTargetRef = useRef<{ id: string; position: ProjectDropPosition } | null>(null);
  const suppressProjectClickRef = useRef(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [status, setStatus] = useState("Checking runtime");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<CodexRuntimeStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeRuntimeStatus | null>(null);
  const [claudeLoginStarting, setClaudeLoginStarting] = useState(false);
  const [cursorStatus, setCursorStatus] = useState<CursorRuntimeStatus | null>(null);
  const [cursorLoginStarting, setCursorLoginStarting] = useState(false);
  const [cursorModels, setCursorModels] = useState<CursorModel[]>([]);
  const [cursorModelsLoading, setCursorModelsLoading] = useState(false);
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
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [rateSummary, setRateSummary] = useState("");
  const [skillsFolder, setSkillsFolder] = usePersistedState<string>("kiwi.skillsFolder", "");
  const [skillFiles, setSkillFiles] = useState<LocalSkillFile[]>([]);
  const [skillAliases, setSkillAliases] = usePersistedState<Record<string, string>>("kiwi.skillAliases", {});
  const [disabledSkillPaths, setDisabledSkillPaths] = usePersistedState<string[]>("kiwi.disabledSkills", []);
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const skillRuntimeRootRef = useRef("");
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [gitOutput, setGitOutput] = useState("");
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [githubStatus, setGithubStatus] = useState<GitHubAccountStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubLoginPending, setGithubLoginPending] = useState(false);
  const [githubRepoStatus, setGithubRepoStatus] = useState<GitHubRepoStatus | null>(null);
  const [githubRepoError, setGithubRepoError] = useState("");
  const [githubRemoteInput, setGithubRemoteInput] = useState("");
  const [githubRepoName, setGithubRepoName] = useState("");
  const [githubRepoVisibility, setGithubRepoVisibility] = useState<"private" | "public">("private");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false);
  const [openRouterModelsError, setOpenRouterModelsError] = useState("");
  const [pricingCatalogRevision, setPricingCatalogRevision] = useState(modelPricingCatalogRevision);
  const composerRef = useRef<ComposerHandle>(null);
  const threadSearchRequestRef = useRef(0);
  const pendingTurnStartsRef = useRef(new PendingTurnStarts());
  const claudeSaveTimersRef = useRef(new Map<string, number>());
  const cursorSaveTimersRef = useRef(new Map<string, number>());
  const cursorSessionIdsRef = useRef<Record<string, string>>({});
  const permissionControlRef = useRef<HTMLDivElement>(null);
  if (threadProjectBindingsRef.current === null) {
    threadProjectBindingsRef.current = loadStored("kiwi.threadProjects", {});
  }
  if (knownThreadsRef.current === null) knownThreadsRef.current = initialKnownThreads;

  const selectedProject = useMemo(() => projects.find((project) => project.id === activeProjectId) ?? null, [activeProjectId, projects]);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeProject = workspaceMode === "project" ? selectedProject : null;
  const chatWorkspace = useMemo<Project | null>(() => (chatWorkspacePath ? { id: "openkiwi-normal-chats", name: "Chats", path: chatWorkspacePath, isChat: true } : null), [chatWorkspacePath]);
  const activeWorkspace = workspaceMode === "chat" ? chatWorkspace : activeProject;
  useEffect(() => {
    setThreadKindView("main");
  }, [activeWorkspace?.id]);
  // Current workspace identity for async continuations (sendMessage) that
  // must not install UI state after a mid-flight workspace switch.
  const activeWorkspacePathRef = useRef<string | null>(null);
  activeWorkspacePathRef.current = activeWorkspace ? normalizedProjectPath(activeWorkspace.path) : null;
  const pendingHandoffForWorkspace = pendingHandoff && activeWorkspace
    && normalizedProjectPath(pendingHandoff.workspacePath) === normalizedProjectPath(activeWorkspace.path)
    ? pendingHandoff
    : null;
  const activeThreadId = activeThread?.id ?? null;
  const childThreadLinks = useMemo<Record<string, unknown>>(
    () => ({ ...nativeAgentLinks, ...childAgentLinks }),
    [childAgentLinks, nativeAgentLinks],
  );
  const activeThreadHandoff = activeThreadId ? threadHandoffs[activeThreadId] : undefined;
  const activeThreadWorktree = activeThreadId ? threadWorktrees[activeThreadId] : undefined;
  const activeExecutionPath = activeWorkspace
    ? executionPathForThread(activeThreadId, activeWorkspace.path, threadWorktrees)
    : "";
  const activeProvider = activeThread ? providerFromThread(activeThread, settings.provider) : (draftThreadProvider ?? settings.provider);
  // Resolve project policy independently of the open conversation. Thread
  // selection needs this unclamped shape: the previously active thread may be
  // a depth-one child while the thread being opened is a root (or vice versa).
  const projectSettings = useMemo<AppSettings>(() => {
    const overrides = activeProject?.overrides;
    const projectResolved = !overrides
      ? settings
      : {
          ...settings,
          ...(overrides.model ? { model: overrides.model } : {}),
          ...(overrides.permission ? { permission: overrides.permission } : {}),
        };
    return settingsWithProjectSubagents(projectResolved, overrides?.subagents);
  }, [activeProject, settings]);
  const subscriptionSystemPrompts = useMemo(() => {
    const resolveFor = (provider: "openai" | "claude") => resolveSystemPrompt(
      resolveProviderSystemPrompt(projectSettings.systemPrompt, provider, projectSettings.codexSystemPrompt, projectSettings.claudeSystemPrompt),
      activeProject?.overrides?.systemPrompt,
      activeProject?.overrides?.systemPromptMode,
    );
    return { openai: resolveFor("openai"), claude: resolveFor("claude") };
  }, [activeProject, projectSettings]);
  // Per-project overrides win over global defaults, while provider and model
  // are resolved for the active thread (or the unsent new-thread draft).
  const effectiveSettings = useMemo<AppSettings>(() => {
    const threadModel = activeThreadId ? threadModels[activeThreadId] : draftThreadModel;
    const rememberedReasoning = activeThreadId ? threadReasoning[activeThreadId] : undefined;
    const providerPrompt = activeProvider === "openai" || activeProvider === "claude"
      ? subscriptionSystemPrompts[activeProvider]
      : resolveSystemPrompt(projectSettings.systemPrompt, activeProject?.overrides?.systemPrompt, activeProject?.overrides?.systemPromptMode);
    const resolved = {
      ...projectSettings,
      provider: activeProvider,
      model: modelForProvider(activeProvider, threadModel ?? projectSettings.model),
      systemPrompt: providerPrompt,
      ...(rememberedReasoning ?? {}),
    };
    return activeThread && isSubAgentThread(activeThread, childThreadLinks)
      ? settingsWithoutChildDelegation(resolved)
      : resolved;
  }, [activeProject, activeProvider, activeThread, activeThreadId, childThreadLinks, draftThreadModel, projectSettings, subscriptionSystemPrompts, threadModels, threadReasoning]);

  useEffect(() => {
    if (!pendingHandoff || !activeWorkspace || activeThread) return;
    if (normalizedProjectPath(pendingHandoff.workspacePath) !== normalizedProjectPath(activeWorkspace.path)) {
      discardDraft(`new:${pendingHandoff.workspacePath}`);
      setPendingHandoff(null);
      setDraftThreadProvider(null);
      setDraftThreadModel(null);
      setDraftThreadIsolated(false);
      return;
    }
    // Restore the destination choice beside the durable composer draft after
    // an app restart. Keeping only the text could otherwise send a handoff
    // through the default provider and lose its provenance.
    setDraftThreadProvider(pendingHandoff.targetProvider === settings.provider ? null : pendingHandoff.targetProvider);
    setDraftThreadModel(pendingHandoff.targetProvider === settings.provider ? null : modelForProvider(pendingHandoff.targetProvider, ""));
    setDraftThreadIsolated(false);
  }, [activeThread, activeWorkspace, pendingHandoff, setPendingHandoff, settings.provider]);

  // Which providers a cross-provider child could actually be started on right
  // now. Unusable destinations are filtered out of a thread's policy instead
  // of failing at the moment the model tries to delegate.
  const childAgentReadiness = useMemo<ChildAgentReadiness>(() => ({
    codexRuntimeAvailable: Boolean(runtimeStatus?.available),
    openAiSignedIn: account?.type === "chatgpt",
    openRouterReady,
    claudeReady: Boolean(claudeStatus?.available && claudeStatus.loggedIn),
    cursorReady: Boolean(cursorStatus?.available && cursorStatus.loggedIn),
  }), [account?.type, claudeStatus, cursorStatus, openRouterReady, runtimeStatus?.available]);

  // One line for the composer and the thread summary; the roster itself is
  // edited in Settings so the composer stays uncluttered.
  const activeChildAgentPolicy = useMemo(
    () => childAgentPolicyForThread(childAgentPolicies, activeThreadId ?? undefined),
    [activeThreadId, childAgentPolicies],
  );
  // A zero-target policy is the proposal-only control channel used while
  // delegation is off. It grants no destination authority and therefore must
  // not make the crew UI look frozen/read-only.
  const activeDelegationPolicy = activeChildAgentPolicy?.targets.length
    ? activeChildAgentPolicy
    : undefined;
  /** This conversation is itself a sub-agent, so it may never delegate. */
  const activeThreadIsChild = Boolean(activeThread && isSubAgentThread(activeThread, childThreadLinks));
  /**
   * A thread is only locked once a run has made its cross-provider roster
   * available. Until then it stays editable, so sub-agents configured partway
   * through a conversation are usable on its very next turn.
   */
  const subagentPolicyMode = useMemo<SubAgentPolicyMode>(() => {
    if (activeThreadIsChild) return "child";
    return activeDelegationPolicy ? "captured" : "open";
  }, [activeDelegationPolicy, activeThreadIsChild]);
  const childAgentSummary = useMemo(() => {
    // The frozen roster is what a thread would delegate to, but only while the
    // live switches still expose it — the runtime re-reads those every turn.
    const roster = activeDelegationPolicy
      ? { enabled: effectiveSettings.childAgents.enabled, targets: activeDelegationPolicy.targets }
      : effectiveSettings.childAgents;
    if (!effectiveSettings.subagentsEnabled) return "Cross-provider off";
    return describeChildAgentRoster(roster, childAgentReadiness);
  }, [activeDelegationPolicy, childAgentReadiness, effectiveSettings.childAgents, effectiveSettings.subagentsEnabled]);
  // The composer's command center edits this shape directly; a started thread
  // renders it read-only beside the policy it froze.
  const composerSubagentPolicy = useMemo(
    () => projectSubagentSettingsFromApp(effectiveSettings),
    [effectiveSettings],
  );
  const subAgentModelCatalogs = useMemo<Partial<Record<Provider, SubAgentModelOption[]>>>(() => ({
    ...(runtimeModels.length ? {
      openai: runtimeModels.map((entry) => ({
        id: entry.model || entry.id,
        label: entry.displayName || entry.model || entry.id,
        detail: entry.description || entry.model || entry.id,
      })),
    } : {}),
    ...(cursorModels.length ? {
      cursor: cursorModels.map((entry) => ({
        id: entry.id,
        label: entry.name || entry.id,
        detail: entry.id,
      })),
    } : {}),
    openrouter: openRouterModels.map((entry) => ({
      id: entry.id,
      label: entry.name || entry.id,
      detail: entry.id,
      keywords: entry.description,
    })),
  }), [cursorModels, openRouterModels, runtimeModels]);

  const terminal = useTerminal({ scrollback: settings.terminalScrollback, permission: effectiveSettings.permission, onError: setError });
  const timelineEmpty = useTaskStore((state) => {
    if (!activeThreadId) return true;
    const task = state.tasks[activeThreadId];
    return !task || (task.messages.length === 0 && task.activities.length === 0);
  });
  const diff = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.diff ?? "") : ""));
  const agentRecords = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.agents ?? EMPTY_AGENTS) : EMPTY_AGENTS));
  const agentRunStartedAt = useTaskStore((state) => (activeThreadId ? state.tasks[activeThreadId]?.agentRunStartedAt : undefined));
  const tokenUsage = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.usage ?? null) : null));
  const contextPercent = contextUsagePercent(tokenUsage);
  const queuedTurns = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.queuedTurns ?? EMPTY_QUEUED_TURNS) : EMPTY_QUEUED_TURNS));
  const taskStatus = useTaskStore((state) => (activeThreadId ? (state.statuses[activeThreadId] ?? "idle") : "idle"));
  const threadTaskStatuses = useTaskStore((state) => state.statuses);
  // Live crew for the composer panel: OpenKiwi-owned cross-provider children
  // merged with whatever native agents the root task reported.
  const subAgentWorkers = useMemo(
    () => collectSubAgentWorkers({
      rootThreadId: activeThreadId,
      links: childAgentLinks,
      statuses: threadTaskStatuses,
      agents: agentRecords,
      runStartedAt: agentRunStartedAt,
    }),
    [activeThreadId, agentRecords, agentRunStartedAt, childAgentLinks, threadTaskStatuses],
  );
  const running = activeThreadId ? taskStatus === "starting" || taskStatus === "running" : startingDraftTurn;
  // A root turn can end — normally, or by failing — while children it spawned
  // are still editing the folder. Stop has to stay reachable for exactly that
  // window, or the only cutoff left would be one worker at a time inside the
  // crew panel.
  const childrenRunning = useMemo(
    () => subAgentWorkers.some((worker) => isSubAgentWorkerActive(worker.status)),
    [subAgentWorkers],
  );
  // Standard approvals for the thread being viewed render inline in its
  // timeline; the modal is reserved for background threads and for complex
  // input/elicitation forms.
  const inlineApproval = useTaskStore((state) => {
    if (!state.activeThreadId) return null;
    const candidate = state.tasks[state.activeThreadId]?.approvals[0] ?? null;
    if (!candidate) return null;
    if (candidate.method === "item/tool/requestUserInput" || candidate.method === "cursor/ask_question" || candidate.method === "mcpServer/elicitation/request") return null;
    return candidate;
  });
  const pendingApproval = useTaskStore((state) => {
    let earliest: PendingApproval | null = null;
    for (const task of Object.values(state.tasks)) {
      const candidate = task.approvals[0];
      if (!candidate) continue;
      const handledInline = candidate.threadId === state.activeThreadId && candidate.method !== "item/tool/requestUserInput" && candidate.method !== "cursor/ask_question" && candidate.method !== "mcpServer/elicitation/request";
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
  const projectThreadCounts = countActiveThreadsByWorkspace(
    knownThreadsRef.current ?? {},
    threadProjectBindingsRef.current ?? {},
    threadTaskStatuses,
  );
  const displayedThreads = useMemo(() => {
    if (!activeWorkspace) return [];
    const threadProjectBindings = threadProjectBindingsRef.current ?? {};
    const query = threadSearch.trim().toLowerCase();
    const merged = filterThreadsByKind(
      filterThreadsForWorkspace(threads, activeWorkspace.path, threadProjectBindings),
      childThreadLinks,
      threadKindView,
    )
      .filter((thread) => `${thread.name ?? ""} ${thread.preview}`.toLowerCase().includes(query));
    const mergedIds = new Set(merged.map((thread) => thread.id));
    for (const found of filterThreadsForWorkspace(searchResults ?? [], activeWorkspace.path, threadProjectBindings)) {
      if (!filterThreadsByKind([found], childThreadLinks, threadKindView).length) continue;
      if (!mergedIds.has(found.id)) {
        mergedIds.add(found.id);
        merged.push(found);
      }
    }
    const pinned = new Set(pinnedThreadIds);
    return merged.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.updatedAt - a.updatedAt);
  }, [activeWorkspace, childThreadLinks, pinnedThreadIds, searchResults, threadKindView, threadSearch, threads]);

  // Jump-to surfaces are for the user's own conversations. Delegated children
  // are browsable through the sidebar's Sub-agents view, not mixed into search.
  const paletteThreads = useMemo(
    () => filterThreadsByKind(threads, childThreadLinks, "main"),
    [childThreadLinks, threads],
  );

  const threadKindCounts = useMemo(() => {
    if (!activeWorkspace) return { main: 0, subagents: 0 };
    const scoped = filterThreadsForWorkspace(threads, activeWorkspace.path, threadProjectBindingsRef.current ?? {});
    const subagents = scoped.filter((thread) => isSubAgentThread(thread, childThreadLinks)).length;
    return { main: scoped.length - subagents, subagents };
  }, [activeWorkspace, childThreadLinks, threads]);
  // @-mention autocomplete searches project files with the same fuzzy RPC the
  // file browser uses. Only available inside a project workspace.
  const activeProjectPath = activeProject ? activeExecutionPath : undefined;
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
  const composerSkills = useMemo(
    () => skills.filter((skill) => skill.enabled).map((skill) => ({ name: skill.name, description: skill.description })),
    [skills],
  );

  const activeOpenRouterPricing = useMemo<ModelPricing | undefined>(() => {
    if (effectiveSettings.provider !== "openrouter") return undefined;
    const pricing = openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.pricing;
    const input = Number(pricing?.prompt ?? NaN);
    const output = Number(pricing?.completion ?? NaN);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
    return {
      inputPerMillion: input * 1_000_000,
      outputPerMillion: output * 1_000_000,
      source: "OpenRouter",
      asOf: new Date().toISOString().slice(0, 10),
    };
  }, [effectiveSettings.model, effectiveSettings.provider, openRouterModels]);

  useEffect(() => {
    if (!activeThreadId) return;
    annotateThreadUsage(activeThreadId, {
      provider: effectiveSettings.provider,
      model: effectiveSettings.model,
      projectPath: activeWorkspace ? normalizedProjectPath(activeWorkspace.path) : undefined,
      pricing: activeOpenRouterPricing ?? pricingForModel(effectiveSettings.provider, effectiveSettings.model),
    });
  }, [activeOpenRouterPricing, activeThreadId, activeWorkspace, effectiveSettings.model, effectiveSettings.provider, pricingCatalogRevision, tokenUsage]);

  const activeUsageRecord = activeThreadId ? usageForThread(activeThreadId) : null;
  const activeUsageCost = activeUsageRecord?.estimatedCost
    ?? (tokenUsage ? estimateUsageCost(tokenUsage, activeUsageRecord?.pricing) : null);
  const activeUsageIsUnpriced = Boolean(
    activeUsageRecord
    && activeUsageRecord.unpricedTokens
    && !activeUsageRecord.pricedTokens,
  );
  const costEstimate = !tokenUsage
    ? ""
    : activeUsageCost === null || activeUsageIsUnpriced
      ? "Price unavailable for this model"
      : `≈ ${formatEstimatedCost(activeUsageCost)} ${activeUsageRecord?.pricing?.source === "OpenRouter" ? "estimated spend" : "API-equivalent"}${activeUsageRecord?.unpricedTokens ? " · partial estimate" : ""}`;
  const allTimeUsage = usageTotals();
  const costTotalsView = (() => {
    const totals = costTotals(activeProject ? normalizedProjectPath(activeProject.path) : undefined);
    if (!totals.today && !totals.project) return "";
    return activeProject
      ? `${formatCost(totals.project)} in this project · ${formatCost(totals.today)} today`
      : `${formatCost(totals.today)} today`;
  })();

  const accountUsageView = useMemo(() => {
    return providerAccountUsage(effectiveSettings.provider, {
      openAiRateSummary: rateSummary,
      claudeStatus,
      cursorStatus,
      openRouterReady,
    });
  }, [claudeStatus, cursorStatus, effectiveSettings.provider, openRouterReady, rateSummary]);

  // Only offer "Check settings" for failures settings can actually fix.
  const errorSuggestsSettings = useMemo(() => Boolean(error) && /sign in|api key|openrouter|claude|model|settings|runtime|codex|account/i.test(error ?? ""), [error]);
  const workspaceArchived = useMemo(() => (activeWorkspace ? archivedThreads.filter((record) => (
    record.path === normalizedProjectPath(activeWorkspace.path)
    && Boolean(childThreadLinks[record.id]) === (threadKindView === "subagents")
  )) : []), [activeWorkspace, archivedThreads, childThreadLinks, threadKindView]);

  const persistThreadModel = useCallback((threadId: string, model: string) => {
    setThreadModels((current) => (current[threadId] === model ? current : { ...current, [threadId]: model }));
  }, [setThreadModels]);

  const persistThreadReasoning = useCallback((threadId: string, reasoning: ThreadReasoning) => {
    setThreadReasoning((current) => {
      const existing = current[threadId];
      return existing?.reasoningEffort === reasoning.reasoningEffort && existing.ultra === reasoning.ultra
        ? current
        : { ...current, [threadId]: reasoning };
    });
  }, [setThreadReasoning]);

  const executionPathFor = useCallback((threadId: string | null | undefined, logicalPath: string) => (
    executionPathForThread(threadId, logicalPath, threadWorktreesRef.current)
  ), [threadWorktreesRef]);

  useEffect(() => {
    let disposed = false;
    if (!activeProject) {
      setWorkspaceGitInfo(null);
      return;
    }
    void readWorkspaceGitInfo(activeProject.path)
      .then((info) => {
        if (!disposed) setWorkspaceGitInfo(info);
      })
      .catch(() => {
        if (!disposed) setWorkspaceGitInfo(null);
      });
    return () => {
      disposed = true;
    };
  }, [activeProject]);

  useEffect(() => () => {
    if (successToastTimerRef.current !== null) {
      window.clearTimeout(successToastTimerRef.current);
    }
  }, []);

  const showSuccessToast = useCallback((message: string) => {
    if (successToastTimerRef.current !== null) {
      window.clearTimeout(successToastTimerRef.current);
    }
    setSuccessToast(message);
    successToastTimerRef.current = window.setTimeout(() => {
      setSuccessToast(null);
      successToastTimerRef.current = null;
    }, 4_500);
  }, []);

  useEffect(() => {
    if (!githubLoginPending) return;
    let disposed = false;
    let attempts = 0;
    const check = async () => {
      attempts += 1;
      try {
        const next = await getGitHubStatus();
        if (disposed) return;
        setGithubStatus(next);
        if (next.authenticated) {
          setGithubLoginPending(false);
          showSuccessToast(`GitHub connected${next.login ? ` as @${next.login}` : ""}`);
        } else if (attempts >= 45) {
          setGithubLoginPending(false);
          setError("GitHub sign-in was not detected. Finish `gh auth login`, then use Refresh in GitHub settings.");
        }
      } catch (reason) {
        if (!disposed && attempts >= 45) {
          setGithubLoginPending(false);
          setError(`Could not verify GitHub sign-in: ${friendlyError(reason)}`);
        }
      }
    };
    const timer = window.setInterval(() => void check(), 2_000);
    void check();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [githubLoginPending, showSuccessToast]);

  const dismissSuccessToast = useCallback(() => {
    if (successToastTimerRef.current !== null) {
      window.clearTimeout(successToastTimerRef.current);
      successToastTimerRef.current = null;
    }
    setSuccessToast(null);
  }, []);

  const initializeActiveProjectGit = useCallback(async () => {
    if (!activeProject || gitInitializing) return;
    const project = activeProject;
    setError(null);
    setGitInitializing(true);
    try {
      const result = await initializeWorkspaceGit(project.path);
      if (activeProjectIdRef.current === project.id) {
        setWorkspaceGitInfo(result.info);
        setDraftThreadIsolated(false);
      }
      showSuccessToast(
        result.initialized
          ? `Git repository created for ${project.name}. Isolated worktrees are ready.`
          : `Initial Git snapshot created for ${project.name}. Isolated worktrees are ready.`,
      );
    } catch (reason) {
      if (activeProjectIdRef.current === project.id) {
        setError(friendlyError(reason));
        void readWorkspaceGitInfo(project.path).then(setWorkspaceGitInfo).catch(() => {});
      }
    } finally {
      setGitInitializing(false);
    }
  }, [activeProject, gitInitializing, showSuccessToast]);

  useEffect(() => {
    let disposed = false;
    if (!activeThreadWorktree || activeThreadWorktree.status === "removed") {
      setWorktreeStatus(null);
      return;
    }
    void readWorktreeStatus(
      activeThreadWorktree.projectPath,
      activeThreadWorktree.path,
      activeThreadWorktree.branch,
      activeThreadWorktree.baseCommit,
    )
      .then((next) => {
        if (disposed) return;
        setWorktreeStatus(next);
        if ((!next.exists || !next.registered) && activeThreadWorktree.status !== "missing") {
          persistThreadWorktrees((current) => ({
            ...current,
            [activeThreadWorktree.threadId]: { ...activeThreadWorktree, status: "missing" },
          }));
        } else if (next.exists && next.registered && activeThreadWorktree.status === "missing") {
          persistThreadWorktrees((current) => ({
            ...current,
            [activeThreadWorktree.threadId]: { ...activeThreadWorktree, status: "active" },
          }));
        }
      })
      .catch(() => {
        if (!disposed) setWorktreeStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [activeThreadWorktree, persistThreadWorktrees]);

  const forgetThreadModel = useCallback((threadId: string) => {
    setThreadModels((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, [setThreadModels]);

  const forgetThreadReasoning = useCallback((threadId: string) => {
    setThreadReasoning((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, [setThreadReasoning]);

  const persistActiveProjectOverride = useCallback(
    <K extends keyof NonNullable<Project["overrides"]>>(key: K, value: NonNullable<Project["overrides"]>[K]) => {
      if (!activeProject?.overrides?.[key]) return false;
      setProjects((current) => current.map((project) => (project.id === activeProject.id ? { ...project, overrides: { ...project.overrides, [key]: value } } : project)));
      return true;
    },
    [activeProject, setProjects],
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

  const persistComposerReasoning = useCallback((reasoningEffort: ThreadReasoning["reasoningEffort"]) => {
    if (activeThreadId) {
      persistThreadReasoning(activeThreadId, { reasoningEffort, ultra: false });
    } else {
      persistSettings({ ...settings, reasoningEffort, ultra: false });
    }
  }, [activeThreadId, persistSettings, persistThreadReasoning, settings]);

  const persistComposerUltra = useCallback((ultra: boolean) => {
    if (activeThreadId) {
      persistThreadReasoning(activeThreadId, { reasoningEffort: effectiveSettings.reasoningEffort, ultra });
      if (ultra && !settings.subagentsEnabled) persistSettings({ ...settings, subagentsEnabled: true });
    } else {
      persistSettings({ ...settings, ultra, subagentsEnabled: ultra ? true : settings.subagentsEnabled });
    }
  }, [activeThreadId, effectiveSettings.reasoningEffort, persistSettings, persistThreadReasoning, settings]);

  const persistComposerPermission = useCallback(
    (permission: PermissionMode) => {
      if (!persistActiveProjectOverride("permission", permission)) persistSettings({ ...settings, permission });
    },
    [persistActiveProjectOverride, persistSettings, settings],
  );

  /**
   * Write a sub-agent policy edited in the composer back to the scope it came
   * from: the active project's own override, or the global defaults that Chats
   * and every uncustomized project inherit.
   */
  const persistComposerSubagentPolicy = useCallback(
    (next: ProjectSubagentSettings) => {
      if (!activeProject) {
        persistSettings({
          ...settings,
          subagentsEnabled: next.enabled,
          subagentMax: next.maxConcurrent,
          childAgents: next.childAgents,
        });
        return;
      }
      setProjects((current) => current.map((project) => (project.id === activeProject.id
        ? { ...project, overrides: { ...(project.overrides ?? {}), subagents: next } }
        : project)));
    },
    [activeProject, persistSettings, setProjects, settings],
  );

  const persistActiveProjectPrompt = useCallback(
    (systemPrompt: string | undefined, mode: ProjectPromptMode) => {
      if (!activeProject) return;
      setProjects((current) => current.map((project) => {
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
      }));
    },
    [activeProject, setProjects],
  );

  const { paneSizes, shellRef, startPaneResize, resizePaneWithKeyboard } = usePaneResize((settings.uiScale || 100) / 100);
  const {
    splitRatio: sidebarSplitRatio,
    sidebarSectionsRef,
    startSidebarSplitResize,
    resizeSidebarSplitWithKeyboard,
  } = useSidebarSplitResize((settings.uiScale || 100) / 100);

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
  }, [setWorkspaceMode]);

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
      }, LOCAL_TRANSCRIPT_SAVE_DEBOUNCE_MS);
      claudeSaveTimersRef.current.set(threadId, timer);
    },
    [persistClaudeThread],
  );

  const persistCursorThread = useCallback(
    (threadId: string) => {
      const task = useTaskStore.getState().tasks[threadId];
      const thread = activeThread?.id === threadId ? activeThread : (threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId]);
      if (!task || !thread || !isCursorThread(thread)) return Promise.resolve();
      return saveCursorTranscript({
        thread,
        cursorSessionId: cursorSessionIdsRef.current[threadId] ?? "",
        messages: task.messages.map((message) => ({ ...message, streaming: false })),
        activities: task.activities,
      });
    },
    [activeThread, threads],
  );

  const scheduleCursorThreadSave = useCallback(
    (threadId: string) => {
      const existing = cursorSaveTimersRef.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        cursorSaveTimersRef.current.delete(threadId);
        void persistCursorThread(threadId).catch(() => {});
      }, LOCAL_TRANSCRIPT_SAVE_DEBOUNCE_MS);
      cursorSaveTimersRef.current.set(threadId, timer);
    },
    [persistCursorThread],
  );

  useEffect(
    () => () => {
      for (const timer of claudeSaveTimersRef.current.values()) window.clearTimeout(timer);
      claudeSaveTimersRef.current.clear();
      for (const timer of cursorSaveTimersRef.current.values()) window.clearTimeout(timer);
      cursorSaveTimersRef.current.clear();
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

  const refreshCursorStatus = useCallback(async () => {
    try {
      const result = await getCursorRuntimeStatus();
      const normalized = result ?? { available: false, path: null, version: null, loggedIn: false, email: null, subscriptionType: null, warning: null };
      setCursorStatus(normalized);
      return normalized;
    } catch (reason) {
      const result: CursorRuntimeStatus = { available: false, path: null, version: null, loggedIn: false, email: null, subscriptionType: null, warning: null };
      setCursorStatus(result);
      setError(friendlyError(reason));
      return result;
    }
  }, []);

  const refreshCursorModels = useCallback(async () => {
    setCursorModelsLoading(true);
    try {
      const models = await listCursorModels() ?? [];
      setCursorModels(models);
      return models;
    } catch (reason) {
      setCursorModels([]);
      if (cursorStatus?.loggedIn) setError(friendlyError(reason));
      return [];
    } finally {
      setCursorModelsLoading(false);
    }
  }, [cursorStatus?.loggedIn]);

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
        // Newer Codex app-servers expose native collaboration ownership on
        // thread/list. Capture it before workspace filtering because a child
        // may execute in a managed worktree while belonging to its root's
        // logical project.
        const discoveredNativeLinks: Record<string, NativeAgentLink> = {};
        for (const thread of allThreads) {
          const link = nativeAgentLinkFromThread(thread);
          if (!link) continue;
          discoveredNativeLinks[link.childThreadId] = link;
          const rootPath = threadProjectBindingsRef.current?.[link.rootThreadId]
            ?? knownThreadsRef.current?.[link.rootThreadId]?.cwd
            ?? project.path;
          bindThreadToProject(link.childThreadId, rootPath);
        }
        if (Object.keys(discoveredNativeLinks).length) {
          persistNativeAgentLinks((current) => ({ ...current, ...discoveredNativeLinks }));
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
    [bindThreadToProject, persistNativeAgentLinks, runtimeStatus?.available],
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
  // Babel's TS-7-compatible parser treats the `result.account` property as
  // the unrelated component state named `account`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    async (command: string[], cwd: string, additionalWritableRoots: string[] = []) => {
      return rpc<{ exitCode: number; stdout: string; stderr: string }>("command/exec", { command, cwd, timeoutMs: 120000, sandboxPolicy: commandSandbox(effectiveSettings.permission, cwd, additionalWritableRoots) });
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
    // The parser reports the unrelated rendered `diff` value here; refresh
    // writes through the task store and reads only executeCommand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [executeCommand],
  );

  const refreshDiff = useCallback(async () => {
    if (!activeProject || !activeThreadId || !activeExecutionPath) return;
    await refreshDiffFor(activeThreadId, activeExecutionPath);
  }, [activeExecutionPath, activeProject, activeThreadId, refreshDiffFor]);

  const {
    checkpoints,
    checkpointHeads,
    checkpointsRef,
    checkpointBusyId,
    checkpointPreview,
    runCheckpointProjectOperation,
    persistCheckpoints,
    beginRunCheckpoint,
    finalizeRunCheckpoint,
    discardRunCheckpoint,
    projectHasActiveTask,
    captureCurrentStateCheckpoint,
    createCheckpoint,
    restoreCheckpoint,
    toggleCheckpointAccepted,
    previewCheckpoint,
    removeCheckpoint,
    forgetThreadCheckpoints,
  } = useCheckpoints({
    chatWorkspacePath,
    activeThread,
    activeProject,
    activeThreadId,
    activeExecutionPath,
    defaultProvider: settings.provider,
    threadModels,
    knownThreadsRef,
    threadProjectBindingsRef,
    threadWorktreesRef,
    persistThreadWorktrees,
    refreshDiffFor,
    setError,
    setTransientStatus,
  });

  // The event context is rebuilt each render so callbacks always see fresh
  // state; useCodexEvents reads it through a ref and subscribes exactly once.
  useCodexEvents({
    bindingFor: (threadId) => {
      const logicalPath = threadProjectBindingsRef.current?.[threadId];
      return logicalPath ? executionPathFor(threadId, logicalPath) : undefined;
    },
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
    onNativeAgentDiscovered: (rootThreadId, childThreadId, details) => {
      if (!childThreadId || childThreadId === rootThreadId) return;
      const now = Date.now();
      const rootThread = threads.find((entry) => entry.id === rootThreadId) ?? knownThreadsRef.current?.[rootThreadId];
      const existingThread = threads.find((entry) => entry.id === childThreadId) ?? knownThreadsRef.current?.[childThreadId];
      const logicalPath = threadProjectBindingsRef.current?.[rootThreadId] ?? rootThread?.cwd;
      const title = details.prompt?.trim()
        || details.path?.split("/").filter(Boolean).at(-1)?.replaceAll("_", " ")
        || existingThread?.preview
        || "Delegated task";
      persistNativeAgentLinks((current) => {
        const existing = current[childThreadId];
        const link: NativeAgentLink = {
          childThreadId,
          rootThreadId,
          title: existing?.title || title,
          ...(details.path || existing?.path ? { path: details.path || existing?.path } : {}),
          createdAt: existing?.createdAt ?? now,
        };
        return { ...current, [childThreadId]: link };
      });
      if (logicalPath) bindThreadToProject(childThreadId, logicalPath);
      const childThread: Thread = {
        id: childThreadId,
        name: existingThread?.name ?? null,
        preview: existingThread?.preview || title,
        cwd: existingThread?.cwd || rootThread?.cwd || logicalPath || "",
        updatedAt: Math.max(existingThread?.updatedAt ?? 0, Math.floor(now / 1000)),
        modelProvider: existingThread?.modelProvider || rootThread?.modelProvider || "openai",
        parentThreadId: rootThreadId,
        threadSource: "subagent",
        agentPath: details.path || existingThread?.agentPath,
      };
      rememberThread(childThread);
      setThreads((current) => upsertThread(current, childThread));
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
      void finalizeRunCheckpoint(threadId, turn?.id);
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
      const completedProvider = providerFromThread(completedThread, "openai");
      const completedModel = threadModels[threadId]
        ?? (activeThreadId === threadId ? effectiveSettings.model : modelForProvider(completedProvider, ""));
      const pricing = completedProvider === "openrouter"
        ? openRouterModels.find((entry) => entry.id === completedModel)?.pricing
        : undefined;
      const promptRate = Number(pricing?.prompt ?? NaN);
      const completionRate = Number(pricing?.completion ?? NaN);
      annotateThreadUsage(threadId, {
        provider: completedProvider,
        model: completedModel,
        projectPath: projectPath ? normalizedProjectPath(projectPath) : undefined,
        pricing: Number.isFinite(promptRate) && Number.isFinite(completionRate)
          ? { inputPerMillion: promptRate * 1_000_000, outputPerMillion: completionRate * 1_000_000, source: "OpenRouter", asOf: new Date().toISOString().slice(0, 10) }
          : pricingForModel(completedProvider, completedModel),
      });
      if (completedProvider === "openrouter") {
        const completedUsage = usageForThread(threadId);
        if (completedUsage?.estimatedCost != null) {
          recordThreadCost(
            threadId,
            projectPath ? normalizedProjectPath(projectPath) : "",
            completedUsage.estimatedCost,
          );
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
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) {
        void refreshDiffFor(threadId, executionPathFor(threadId, projectPath));
      }
    },
  });

  useClaudeEvents({
    bindingFor: (threadId) => {
      const logicalPath = threadProjectBindingsRef.current?.[threadId];
      return logicalPath ? executionPathFor(threadId, logicalPath) : undefined;
    },
    onStatus: setStatus,
    onError: setError,
    onTranscriptChanged: scheduleClaudeThreadSave,
    onUnsupportedControlRequest: (threadId, requestId, subtype) => {
      void respondClaudeControlError(threadId, requestId, `OpenKiwi does not support ${subtype} requests yet.`).catch(() => undefined);
      void auditEvent("claude.unsupportedControlRequest", { subtype }, threadId).catch(() => undefined);
    },
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
      void finalizeRunCheckpoint(threadId);
      const task = useTaskStore.getState().tasks[threadId];
      const known = knownThreadsRef.current?.[threadId];
      if (known) {
        // Cancel the debounced save only when this final save replaces it;
        // otherwise a thread no longer in the index would lose the last
        // scheduled persist of its final turn.
        const timer = claudeSaveTimersRef.current.get(threadId);
        if (timer !== undefined) window.clearTimeout(timer);
        claudeSaveTimersRef.current.delete(threadId);
        const latestUser = [...(task?.messages ?? [])].reverse().find((message) => message.role === "user")?.text;
        const updated = { ...known, preview: latestUser?.slice(0, 140) || known.preview, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updated);
        if (activeWorkspace && threadBelongsToWorkspace(updated, activeWorkspace.path, threadProjectBindingsRef.current ?? {})) {
          setThreads((current) => upsertThread(current, updated));
        }
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
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) {
        void refreshDiffFor(threadId, executionPathFor(threadId, projectPath));
      }
    },
  });

  useCursorEvents({
    bindingFor: (threadId) => {
      const logicalPath = threadProjectBindingsRef.current?.[threadId];
      return logicalPath ? executionPathFor(threadId, logicalPath) : undefined;
    },
    onStatus: setStatus,
    onError: setError,
    onTranscriptChanged: scheduleCursorThreadSave,
    onApprovalRequested: (threadId) => {
      if (!settings.notificationsEnabled || useTaskStore.getState().activeThreadId === threadId) return;
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "OpenKiwi needs your approval", body: `“${thread?.name || thread?.preview || "A Cursor task"}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId) => {
      void finalizeRunCheckpoint(threadId);
      const task = useTaskStore.getState().tasks[threadId];
      const known = knownThreadsRef.current?.[threadId];
      if (known) {
        // Cancel the debounced save only when this final save replaces it;
        // otherwise a thread no longer in the index would lose the last
        // scheduled persist of its final turn.
        const timer = cursorSaveTimersRef.current.get(threadId);
        if (timer !== undefined) window.clearTimeout(timer);
        cursorSaveTimersRef.current.delete(threadId);
        const latestUser = [...(task?.messages ?? [])].reverse().find((message) => message.role === "user")?.text;
        const updated = { ...known, preview: latestUser?.slice(0, 140) || known.preview, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updated);
        if (activeWorkspace && threadBelongsToWorkspace(updated, activeWorkspace.path, threadProjectBindingsRef.current ?? {})) {
          setThreads((current) => upsertThread(current, updated));
        }
        void saveCursorTranscript({ thread: updated, cursorSessionId: cursorSessionIdsRef.current[threadId] ?? "", messages: (task?.messages ?? []).map((message) => ({ ...message, streaming: false })), activities: task?.activities ?? [] }).catch(() => {});
      }
      if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== threadId) {
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: "OpenKiwi task complete", body: `“${known?.name || known?.preview || "Cursor task"}” finished.` });
        })().catch(() => {});
      }
      const projectPath = threadProjectBindingsRef.current?.[threadId];
      if (projectPath && !projectPath.includes("normal-chats")) void refreshDiffFor(threadId, executionPathFor(threadId, projectPath));
    },
  });

  // The startup sequence must run exactly once per launch. Some of its
  // callbacks change identity later (refreshCursorModels depends on the
  // Cursor login state), and re-running checkRuntime on such a change could
  // pop the Codex setup modal in the middle of a session.
  const startupRanRef = useRef(false);
  useEffect(() => {
    if (startupRanRef.current) return;
    startupRanRef.current = true;
    void getNormalChatWorkspace()
      .then(setChatWorkspacePath)
      .catch((reason) => setError(friendlyError(reason)));
    if (!initialOnboardingOpen && initialOnboardingVersion < ONBOARDING_VERSION) {
      storeValue("kiwi.onboardingVersion", ONBOARDING_VERSION);
    }
    void checkRuntime(!initialOnboardingOpen && initialSettings.provider !== "claude" && initialSettings.provider !== "cursor").then((runtime) => {
      if (!runtime.available) return;
      void refreshAccount();
      void refreshModels();
      void refreshUsage();
    });
    void refreshClaudeStatus();
    void refreshCursorStatus();
    void refreshOpenRouterModels();
    void refreshModelPricingCatalog()
      .then((catalog) => {
        if (catalog) setPricingCatalogRevision(catalog.updatedAt);
      })
      .catch(() => {
        // Pricing is advisory and the last validated or bundled snapshot stays
        // active offline, so a startup network failure should not interrupt chat.
      });
    void hasOpenRouterKey()
      .then(setOpenRouterReady)
      .catch(() => setOpenRouterReady(false));
  }, [checkRuntime, refreshAccount, refreshClaudeStatus, refreshCursorStatus, refreshModels, refreshOpenRouterModels, refreshUsage]);

  // Cursor sign-in (at startup or later) refreshes only the Cursor model
  // list, never the whole startup sequence above.
  useEffect(() => {
    if (cursorStatus?.loggedIn) void refreshCursorModels();
  }, [cursorStatus?.loggedIn, refreshCursorModels]);

  // Workspace-change side effects are keyed on the workspace *path* and
  // runtime availability, with refreshTools read through a ref. Depending on
  // the callback identities here used to reset the open conversation whenever
  // an unrelated setting (skills, project pinning) changed.
  const refreshToolsRef = useRef(refreshTools);
  refreshToolsRef.current = refreshTools;
  const workspaceEffectRef = useRef<{ path: string | null; available: boolean } | null>(null);
  useEffect(() => {
    const path = activeWorkspace ? normalizedProjectPath(activeWorkspace.path) : null;
    const available = Boolean(runtimeStatus?.available || claudeStatus?.available || cursorStatus?.available);
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
    // Invalidate any in-flight thread selection: a slow thread/resume issued
    // from the previous workspace must not re-install its thread here.
    selectThreadRequestRef.current += 1;
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(pendingHandoffForWorkspace?.targetProvider === settings.provider ? null : pendingHandoffForWorkspace?.targetProvider ?? null);
    setDraftThreadModel(pendingHandoffForWorkspace ? modelForProvider(pendingHandoffForWorkspace.targetProvider, "") : null);
    setAttachments([]);
    setThreadSearch("");
    setSearchResults(null);
    if (!activeProject) setStudioOpen(false);
  }, [activeProject, activeWorkspace, claudeStatus?.available, cursorStatus?.available, loadThreads, pendingHandoffForWorkspace, runtimeStatus?.available, settings.provider]);

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
  /**
   * Replace the app-server so an already loaded thread can be given different
   * startup-only sub-agent config, and report the identity of the runtime that
   * took its place. Refuses rather than interrupting somebody else's work:
   * every thread the old process was running dies with it, and a thread whose
   * provider is unknown is assumed to be one of them.
   */
  const restartRuntimeForCapabilities = useCallback(async (threadId: string) => {
    const anotherCodexRun = Object.entries(useTaskStore.getState().statuses).some(([candidateId, candidateStatus]) => {
      if (candidateId === threadId || (candidateStatus !== "starting" && candidateStatus !== "running")) return false;
      return !isLocalSubscriptionThread(knownThreadsRef.current?.[candidateId]);
    });
    if (anotherCodexRun) {
      throw new Error("Sub-agent settings are ready, but another OpenAI or OpenRouter task is still running. Your message was not sent; try again when that task finishes so OpenKiwi can safely refresh the runtime without interrupting it.");
    }
    await deliberateRestartRuntime();
    return runtimeInstanceId();
  }, [deliberateRestartRuntime]);
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
          if ((threadStatus === "running" || threadStatus === "starting") && !isLocalSubscriptionThread(knownThreadsRef.current?.[threadId])) {
            store.setActiveTurn(threadId, undefined);
            store.setTaskStatus(threadId, "error", "The Codex runtime disconnected during this task.");
            void finalizeRunCheckpoint(threadId, undefined, "interrupted");
          }
        }
        // Queued Codex approvals reference request ids the dead process owned.
        // Every response to them would fail after the respawn, leaving an
        // undismissable modal — drop them, and say so in the thread.
        // `openkiwi/` approvals are answered entirely inside the app, so a
        // runtime restart must not throw away a decision the user still owes.
        for (const task of Object.values(store.tasks)) {
          const codexApprovals = task.approvals.filter((approval) => !approval.method.startsWith("claude/")
            && !approval.method.startsWith("cursor/")
            && !approval.method.startsWith("openkiwi/"));
          if (!codexApprovals.length || codexApprovals.length !== task.approvals.length) continue;
          store.clearApprovals(task.threadId);
          store.upsertActivity(task.threadId, {
            id: `approvals-dropped-${Date.now()}`,
            kind: "warning",
            title: codexApprovals.length === 1 ? "A pending approval was dropped" : `${codexApprovals.length} pending approvals were dropped`,
            detail: "The Codex runtime disconnected, so its queued approval requests can no longer be answered. The model will ask again if it still needs permission.",
          });
          void auditEvent("approval.droppedOnRuntimeRestart", { count: codexApprovals.length }, task.threadId).catch(() => {});
        }
        setStartingDraftTurn(false);
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
  }, [finalizeRunCheckpoint]);

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

  const startProjectPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, projectId: string) => {
    if ((event.button !== undefined && event.button !== 0) || (event.target as HTMLElement).closest(".row-menu")) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const workspaceList = event.currentTarget.closest(".workspace-list") as HTMLElement | null;
    let active = false;
    const isCurrentPointer = (candidate: number | undefined) =>
      pointerId === undefined || candidate === undefined || candidate === pointerId;

    const updateTarget = (clientX: number, clientY: number) => {
      if (!workspaceList) return;
      const listBounds = workspaceList.getBoundingClientRect();
      if (clientY < listBounds.top - 8 || clientY > listBounds.bottom + 8) {
        projectDropTargetRef.current = null;
        setProjectDropTarget(null);
        return;
      }
      if (clientY < listBounds.top + 24) workspaceList.scrollTop -= 8;
      else if (clientY > listBounds.bottom - 24) workspaceList.scrollTop += 8;

      const pointedRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-project-id]");
      if (pointedRow?.dataset.projectId === projectId) {
        projectDropTargetRef.current = null;
        setProjectDropTarget(null);
        return;
      }
      const rows = [...workspaceList.querySelectorAll<HTMLElement>("[data-project-id]")]
        .filter((row) => row.dataset.projectId !== projectId);
      const targetRow = pointedRow && pointedRow.dataset.projectId !== projectId && workspaceList.contains(pointedRow)
        ? pointedRow
        : rows.reduce<HTMLElement | null>((nearest, row) => {
            if (!nearest) return row;
            const rowDistance = Math.abs(clientY - (row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2));
            const nearestBounds = nearest.getBoundingClientRect();
            const nearestDistance = Math.abs(clientY - (nearestBounds.top + nearestBounds.height / 2));
            return rowDistance < nearestDistance ? row : nearest;
          }, null);
      const targetId = targetRow?.dataset.projectId;
      if (!targetRow || !targetId) return;
      const bounds = targetRow.getBoundingClientRect();
      const position: ProjectDropPosition = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      const nextTarget = { id: targetId, position };
      projectDropTargetRef.current = nextTarget;
      setProjectDropTarget((current) => current?.id === targetId && current.position === position ? current : nextTarget);
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!isCurrentPointer(moveEvent.pointerId)) return;
      if (!active && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
      moveEvent.preventDefault();
      if (!active) {
        active = true;
        draggedProjectIdRef.current = projectId;
        setDraggedProjectId(projectId);
        document.body.classList.add("project-reordering");
      }
      updateTarget(moveEvent.clientX, moveEvent.clientY);
    };

    const onEnd = (endEvent: PointerEvent) => {
      if (!isCurrentPointer(endEvent.pointerId)) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.classList.remove("project-reordering");

      const target = projectDropTargetRef.current;
      if (endEvent.type === "pointerup" && active && target) {
        setProjects((current) => reorderProjects(current, projectId, target.id, target.position));
        suppressProjectClickRef.current = true;
        window.setTimeout(() => {
          suppressProjectClickRef.current = false;
        }, 0);
      }
      draggedProjectIdRef.current = null;
      projectDropTargetRef.current = null;
      setDraggedProjectId(null);
      setProjectDropTarget(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const addProject = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (!selected || Array.isArray(selected)) return;
    const existing = projects.find((project) => project.path === selected);
    if (existing) {
      setActiveProjectId(existing.id);
      setWorkspaceMode("project");
      return;
    }
    const project: Project = { id: crypto.randomUUID(), name: basename(selected), path: selected };
    const next = [...projects, project];
    setProjects(next);
    setActiveProjectId(project.id);
    setWorkspaceMode("project");
  };

  const toggleProjectPin = (project: Project) => {
    const updated = { ...project, pinned: !project.pinned };
    const remaining = projects.filter((entry) => entry.id !== project.id);
    const next = updated.pinned ? [updated, ...remaining] : projects.map((entry) => entry.id === project.id ? updated : entry);
    setProjects(next);
  };

  const removeProject = (project: Project) => {
    const isolatedCount = Object.values(threadWorktreesRef.current).filter(
      (record) => normalizedProjectPath(record.projectPath) === normalizedProjectPath(project.path)
        && record.status !== "removed",
    ).length;
    if (isolatedCount > 0) {
      setError(`Remove the ${isolatedCount} isolated worktree${isolatedCount === 1 ? "" : "s"} in this project from the Worktrees workspace tab before removing the project from OpenKiwi.`);
      return;
    }
    const confirmed = window.confirm(`Remove “${project.name}” from OpenKiwi?\n\nIts folder and every file inside it will remain untouched on your Mac.`);
    if (!confirmed) return;
    const next = projects.filter((entry) => entry.id !== project.id);
    setProjects(next);
    if (activeProjectId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      if (!next.length) setWorkspaceMode("chat");
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
    setDraftThreadIsolated(false);
    if (pendingHandoff) composerRef.current?.setDraft("");
    setPendingHandoff(null);
    try {
      const isolation = threadWorktreesRef.current[thread.id];
      // Keep the unavailable execution path attached to the task while the
      // transcript is read-only. Falling back to the source folder here would
      // make later file/tool state look shared before the user explicitly
      // chooses "Continue shared".
      const executionPath = isolation?.path ?? activeWorkspace.path;
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
        useTaskStore.getState().hydrateTask(resolvedThread.id, transcript?.messages ?? [], transcript?.activities ?? [], executionPath);
        useTaskStore.getState().setActiveThread(resolvedThread.id);
        setStatus("Ready");
        return;
      }
      if (isCursorThread(thread)) {
        const transcript = await loadCursorTranscript(thread.id);
        if (selectThreadRequestRef.current !== requestId) return;
        const resolvedThread = transcript?.thread ?? thread;
        if (transcript?.cursorSessionId) cursorSessionIdsRef.current[resolvedThread.id] = transcript.cursorSessionId;
        if (!threadModels[resolvedThread.id]) {
          const projectModel = activeProject?.overrides?.model ?? settings.model;
          persistThreadModel(resolvedThread.id, modelForProvider("cursor", projectModel));
        }
        bindThreadToProject(resolvedThread.id, activeWorkspace.path);
        rememberThread(resolvedThread);
        setActiveThread(resolvedThread);
        useTaskStore.getState().hydrateTask(resolvedThread.id, transcript?.messages ?? [], transcript?.activities ?? [], executionPath);
        useTaskStore.getState().setActiveThread(resolvedThread.id);
        setStatus("Ready");
        return;
      }
      const provider = providerFromThread(thread, settings.provider);
      const projectModel = activeProject?.overrides?.model ?? settings.model;
      const providerPrompt = provider === "openai" || provider === "claude"
        ? subscriptionSystemPrompts[provider]
        : resolveSystemPrompt(projectSettings.systemPrompt, activeProject?.overrides?.systemPrompt, activeProject?.overrides?.systemPromptMode);
      const targetSettings: AppSettings = {
        ...projectSettings,
        provider,
        model: modelForProvider(provider, threadModels[thread.id] ?? projectModel),
        systemPrompt: providerPrompt,
        ...(threadReasoning[thread.id] ?? {}),
      };
      const threadIsChild = Boolean(childThreadLinks[thread.id]) || isSubAgentThread(thread, childThreadLinks);
      const threadProviderSettings = threadIsChild
        ? settingsWithoutChildDelegation(targetSettings)
        : targetSettings;
      // Codex keeps a resumed thread loaded in its app-server. Attach the
      // OpenKiwi bridge during that resume—not one message later—so project
      // settings proposals are available even while delegation is off and an
      // ordinary follow-up does not have to restart the runtime just to add
      // the proposal-only tool.
      const childBridge = activeProject ? await ensureChildAgentBridge({
        threadId: thread.id,
        policies: childAgentPolicies,
        links: childAgentLinks,
        isChildThread: threadIsChild,
        settings: threadProviderSettings,
        permission: threadProviderSettings.permission,
        systemPrompt: threadProviderSettings.systemPrompt,
        providerSystemPrompts: subscriptionSystemPrompts,
        projectInstructionsEnabled: threadProviderSettings.projectInstructionsEnabled,
        reasoningEffort: threadProviderSettings.ultra ? "ultra" : threadProviderSettings.reasoningEffort,
        serviceTier: threadProviderSettings.serviceTier,
        readiness: childAgentReadiness,
        settingsProposalsEnabled: true,
      }) : null;
      if (selectThreadRequestRef.current !== requestId) return;
      if (childBridge?.captured) {
        const policy = { ...childBridge.policy, rootThreadId: thread.id };
        cacheChildAgentPolicy(policy);
        persistChildAgentPolicies((current) => ({ ...current, [policy.sessionId]: policy }));
      }
      const resumedSubagentMax = childBridge?.policy.maxConcurrent
        ?? childAgentPolicyForThread(childAgentPolicies, thread.id)?.maxConcurrent
        ?? threadProviderSettings.subagentMax;
      const resumedSettings = resumedSubagentMax === threadProviderSettings.subagentMax
        ? threadProviderSettings
        : { ...threadProviderSettings, subagentMax: resumedSubagentMax };
      // Capture the process identity before resume. If the process disappears
      // immediately afterwards, preserving its old identity makes the next
      // turn detect the replacement and resume this thread again. Capturing it
      // after resume could incorrectly claim the replacement already loaded it.
      let resumedRuntimeInstance = isolation?.status === "missing" || isolation?.status === "removed"
        ? null
        : await runtimeInstanceId().catch(() => null);
      const capabilitySignature = subagentCapabilitySignature({
        subagentsEnabled: Boolean(childBridge?.launch.toolNames.includes("spawn_agent")),
        subagentMax: resumedSubagentMax,
        bridgeInstanceId: childBridge?.launch.configPath,
      });
      let capabilityRefreshDeferred = false;
      if (resumedRuntimeInstance) {
        const capabilityPlan = planSubagentCapabilities(thread.id, resumedRuntimeInstance, capabilitySignature);
        if (capabilityPlan.restartRuntime) {
          try {
            resumedRuntimeInstance = await restartRuntimeForCapabilities(thread.id);
          } catch (reason) {
            // Navigation must remain available while another task is running.
            // Read the durable transcript without claiming startup config was
            // applied; the next send will retry the guarded refresh.
            if (/another OpenAI or OpenRouter task is still running/i.test(friendlyError(reason))) {
              capabilityRefreshDeferred = true;
            } else {
              throw reason;
            }
          }
        }
      }
      const result = isolation?.status === "missing" || isolation?.status === "removed" || capabilityRefreshDeferred
        ? await rpc<{ thread: Thread }>("thread/read", { threadId: thread.id, includeTurns: true })
        : await rpc<{ thread: Thread }>("thread/resume", threadResumeParams(resumedSettings, thread.id, executionPath, { customAgents, modelContextWindow: provider === "openrouter" ? openRouterModels.find((entry) => entry.id === resumedSettings.model)?.context_length : undefined, additionalWorkspaceRoots: isolation?.gitDir ? [isolation.gitDir] : [], childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true }));
      if (selectThreadRequestRef.current !== requestId) return;
      if (isolation?.status !== "missing" && isolation?.status !== "removed" && !capabilityRefreshDeferred) {
        // Opening a thread resumes it with the complete capability config,
        // including the project-control/delegation bridge when applicable.
        if (resumedRuntimeInstance) {
          recordSubagentCapabilities(result.thread.id, resumedRuntimeInstance, capabilitySignature);
        }
        if (selectThreadRequestRef.current !== requestId) return;
      }
      if (!threadModels[result.thread.id]) persistThreadModel(result.thread.id, threadProviderSettings.model);
      bindThreadToProject(result.thread.id, activeWorkspace.path);
      rememberThread(result.thread);
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, executionPath);
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
    setDraftThreadIsolated(false);
    if (pendingHandoff) composerRef.current?.setDraft("");
    setPendingHandoff(null);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const startNewThreadWithProvider = (provider: Provider) => {
    if (running) {
      setError("Stop the running task before starting a thread with another provider.");
      return;
    }
    if (activeThread) {
      if (activeThreadWorktree && activeThreadWorktree.status !== "removed") {
        setError("Provider handoff is unavailable while this conversation owns an isolated worktree. Apply or merge its changes, remove the worktree, and choose Continue shared before handing it off.");
        return;
      }
      const sourceProvider = providerFromThread(activeThread, settings.provider);
      const sourceTitle = activeThread.name || activeThread.preview || "Untitled task";
      if (!window.confirm(`Hand off “${sourceTitle}” from ${providerLabel(sourceProvider)} to ${providerLabel(provider)}?\n\nOpenKiwi will start a separate provider thread in the same workspace with a bounded, visible copy of the conversation. The original thread remains unchanged.`)) return;
      const task = useTaskStore.getState().tasks[activeThread.id];
      const handoff: ThreadHandoff = {
        sourceThreadId: activeThread.id,
        sourceTitle,
        sourceProvider,
        sourceModel: threadModels[activeThread.id] ?? effectiveSettings.model,
        workspacePath: activeWorkspace?.path ?? activeThread.cwd,
        targetProvider: provider,
        createdAt: Date.now(),
      };
      const prompt = buildProviderHandoffPrompt({
        title: sourceTitle,
        sourceProvider,
        sourceModel: handoff.sourceModel,
        workspaceName: activeWorkspace?.name ?? "Workspace",
        workspacePath: activeWorkspace?.path ?? activeThread.cwd,
        messages: task?.messages ?? [],
      });
      setPendingHandoff(handoff);
      setActiveThread(null);
      useTaskStore.getState().setActiveThread(null);
      setDraftThreadProvider(provider === settings.provider ? null : provider);
      setDraftThreadModel(provider === settings.provider ? null : modelForProvider(provider, ""));
      setDraftThreadIsolated(false);
      setError(null);
      requestAnimationFrame(() => composerRef.current?.setDraft(prompt));
      return;
    }
    if (pendingHandoffForWorkspace) setPendingHandoff({ ...pendingHandoffForWorkspace, targetProvider: provider });
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(provider === settings.provider ? null : provider);
    setDraftThreadModel(provider === settings.provider ? null : modelForProvider(provider, ""));
    setDraftThreadIsolated(false);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleThreadCreated = useCallback((threadId: string) => {
    if (!pendingHandoffForWorkspace) return;
    persistThreadHandoffs((current) => ({ ...current, [threadId]: pendingHandoffForWorkspace }));
    setPendingHandoff(null);
  }, [pendingHandoffForWorkspace, persistThreadHandoffs, setPendingHandoff]);

  const { sendMessage, steerMessage, steerQueuedMessage, retryQueuedMessage, removeQueuedMessage, stopTurn } = useTurnRunner({
    activeThread,
    activeWorkspace,
    activeProject,
    running,
    attachments,
    effectiveSettings,
    subscriptionSystemPrompts,
    customAgents,
    openRouterModels,
    runtimeStatus,
    claudeStatus,
    cursorStatus,
    account,
    openRouterReady,
    workspaceGitInfo,
    draftThreadIsolated,
    worktreeBusy,
    skillsFolder,
    childAgentPolicies,
    childAgentLinks,
    activeThreadIsChild,
    childAgentReadiness,
    persistChildAgentPolicies,
    threadWorktreesRef,
    threadProjectBindingsRef,
    activeWorkspacePathRef,
    pendingTurnStartsRef,
    skillRuntimeRootRef,
    cursorSessionIdsRef,
    executionPathFor,
    bindThreadToProject,
    rememberThread,
    onThreadCreated: handleThreadCreated,
    persistThreadModel,
    persistThreadReasoning,
    persistThreadWorktrees,
    restartRuntimeForCapabilities,
    beginRunCheckpoint,
    discardRunCheckpoint,
    refreshLocalSkills,
    ensureSkillRoots,
    scheduleClaudeThreadSave,
    scheduleCursorThreadSave,
    setThreads,
    setActiveThread,
    setAttachments,
    setDraftThreadIsolated,
    setStartingDraftTurn,
    setError,
    setStatus,
    setTransientStatus,
    setRuntimeSetupOpen,
    setAuthRequiredOpen,
    openSettings,
  });

  // Turns the delegation requests a root agent makes into real per-provider
  // child turns. Children inherit the parent's execution folder and permission
  // mode; they never receive its conversation or attachments.
  const applyProposedProjectSubagents = useCallback(async (rootThreadId: string, next: ProjectSubagentSettings) => {
    const projectPath = threadProjectBindingsRef.current?.[rootThreadId];
    const project = projects.find((entry) => projectPath
      && normalizedProjectPath(entry.path) === normalizedProjectPath(projectPath));
    if (!project) throw new Error("Project sub-agent settings only exist for saved projects, and this conversation is not in one.");
    setProjects((current) => current.map((entry) => (entry.id === project.id
      ? { ...entry, overrides: { ...(entry.overrides ?? {}), subagents: next } }
      : entry)));
    setTransientStatus(`Sub-agent settings updated for ${project.name}`);
    // This approval is explicit user authority to refresh the otherwise-frozen
    // roster. The bridge the running turn is holding stays valid — only the
    // cached launch is dropped, so the next prompt rebuilds it with the
    // approved crew and the runtime capability planner reloads that MCP config.
    // A thread that never captured a policy has nothing frozen to refresh; it
    // simply captures the approved roster on its next turn.
    const existing = childAgentPolicyForThread(childAgentPolicies, rootThreadId);
    if (!existing) return;
    // Staging an empty roster would promote a policy the backend refuses, so
    // an approval that leaves nothing to delegate to simply drops any queued
    // recapture: the live on/off switch already carries that decision.
    const targets = next.enabled && next.childAgents.enabled
      ? readyChildAgentTargets(next.childAgents, childAgentReadiness)
      : [];
    persistChildAgentPolicies((current) => {
      const base = { ...(current[existing.sessionId] ?? existing) };
      delete base.pendingRecapture;
      if (targets.length) base.pendingRecapture = { maxConcurrent: next.maxConcurrent, targets, approvedAt: Date.now() };
      return { ...current, [existing.sessionId]: base };
    });
    invalidateChildAgentLaunch(existing.sessionId);
  }, [childAgentPolicies, childAgentReadiness, persistChildAgentPolicies, projects, setProjects, setTransientStatus]);

  const projectSubagentSettingsForThread = useCallback((rootThreadId: string): ProjectSubagentSettings => {
    const projectPath = threadProjectBindingsRef.current?.[rootThreadId];
    const project = projects.find((entry) => projectPath
      && normalizedProjectPath(entry.path) === normalizedProjectPath(projectPath));
    if (!project) throw new Error("Project sub-agent settings only exist for saved projects, and this conversation is not in one.");
    return projectSubagentSettingsFromApp(settingsWithProjectSubagents(settings, project.overrides?.subagents));
  }, [projects, settings]);

  const { cancelChildAgentsFor, respondToSettingsProposal, stopChildAgent } = useChildAgents({
    policies: childAgentPolicies,
    links: childAgentLinks,
    persistChildAgentLinks,
    openRouterModels,
    readiness: childAgentReadiness,
    projectPathForThread: (threadId) => threadProjectBindingsRef.current?.[threadId],
    executionPathFor,
    isolationGitDirFor: (threadId) => threadWorktreesRef.current[threadId]?.gitDir,
    serviceNameFor: (threadId) => {
      const boundPath = threadProjectBindingsRef.current?.[threadId];
      return boundPath && chatWorkspacePath && normalizedProjectPath(boundPath) === normalizedProjectPath(chatWorkspacePath)
        ? "OpenKiwi Chat"
        : "OpenKiwi";
    },
    bindThreadToProject,
    rememberThread,
    persistThreadModel,
    persistThreadReasoning,
    setThreads,
    cursorSessionIdsRef,
    scheduleClaudeThreadSave,
    scheduleCursorThreadSave,
    projectSubagentSettingsForThread,
    applyProjectSubagentSettings: applyProposedProjectSubagents,
  });

  const stopSubAgentWorker = useCallback(async (worker: SubAgentWorker) => {
    if (!activeThreadId) throw new Error("Open the thread that owns this sub-agent before stopping it.");
    await stopChildAgent(activeThreadId, worker.id);
    setTransientStatus(`Stopped ${worker.title}`);
  }, [activeThreadId, setTransientStatus, stopChildAgent]);

  const replaceSubAgentWorker = useCallback(async (worker: SubAgentWorker, targetId: string) => {
    if (!activeThreadId) throw new Error("Open the thread that owns this sub-agent before replacing it.");
    const policy = childAgentPolicyForThread(childAgentPolicies, activeThreadId);
    const target = policy?.targets.find((entry) => entry.id === targetId);
    if (!policy || !target) throw new Error("That replacement destination was not approved when this thread started.");

    // Stop first so the old child releases its concurrency slot. The root
    // performs the replacement spawn through its frozen bridge, which keeps
    // the backend registry, depth limit, and collect/cancel tools authoritative.
    await stopChildAgent(activeThreadId, worker.id);
    const delivered = await steerMessage([
      "OpenKiwi sub-agent control: replace the sub-agent I just stopped.",
      `Use the approved \`${target.id}\` destination (${target.label || providerDisplayName(target.provider)} · ${childAgentModel(target) || "provider default"}).`,
      `Restart the same delegated task: ${worker.title}`,
      "Spawn a fresh child for that task; do not resume or reuse the stopped child id.",
    ].join("\n"));
    if (!delivered) throw new Error("The old sub-agent was stopped, but the replacement instruction could not be delivered to the root agent.");
    setTransientStatus(`Replacing ${worker.title}`);
  }, [activeThreadId, childAgentPolicies, setTransientStatus, steerMessage, stopChildAgent]);

  /**
   * Stopping a conversation stops the work it started. Without this, pressing
   * Stop would leave cross-provider children editing the same folder while the
   * thread that owns them reports itself as stopped.
   */
  const stopTurnAndChildren = useCallback(async () => {
    const rootThreadId = useTaskStore.getState().activeThreadId;
    // Dispatch every cutoff before awaiting any provider. One slow runtime must
    // never delay the other agents from receiving Stop.
    const results = await Promise.allSettled([
      stopTurn(),
      ...(rootThreadId ? [cancelChildAgentsFor(rootThreadId)] : []),
    ]);
    const failures = results.flatMap((result) => result.status === "rejected" ? [friendlyError(result.reason)] : []);
    if (failures.length) setError(`Stop could not confirm every cutoff:\n${failures.join("\n")}`);
  }, [cancelChildAgentsFor, setError, stopTurn]);

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

  const beginCursorLogin = async () => {
    if (!cursorStatus?.available) {
      openSettings("models");
      setError("Install the official Cursor Agent CLI for Windows first, then return here to sign in.");
      return;
    }
    setCursorLoginStarting(true);
    setError(null);
    setStatus("Opening Cursor sign-in");
    try {
      await startCursorLogin();
      setStatus("Finish sign-in in Terminal");
      window.setTimeout(() => {
        void refreshCursorStatus().then((next) => {
          if (next.loggedIn) {
            setStatus("Ready");
            void refreshCursorModels();
          }
        });
      }, 2500);
    } catch (reason) {
      setStatus("Setup required");
      setError(friendlyError(reason));
    } finally {
      setCursorLoginStarting(false);
    }
  };

  const respondToApproval = useCallback(async (approval: PendingApproval, result: JsonObject) => {
    try {
      if (approval.method === "openkiwi/subagents/change") {
        await respondToSettingsProposal(approval, result);
      } else if (approval.method === "claude/can_use_tool") {
        await respondToClaudePermission(approval.threadId, String(approval.id), result);
      } else if (approval.method === "cursor/request_permission" || approval.method === "cursor/ask_question") {
        await respondToCursorPermission(approval.threadId, approval.id, result);
      } else {
        await respond(approval.id, result);
      }
      void auditEvent("approval.resolved", { method: approval.method, responseRecorded: true }, approval.threadId).catch(() => {});
      useTaskStore.getState().resolveApproval(approval.threadId, approval.id);
    } catch (reason) {
      const message = friendlyError(reason);
      // A rejection that says the runtime no longer knows this request (the
      // turn ended, or the process crashed and respawned) can never succeed
      // on retry. Resolve it locally so the modal cannot reappear forever.
      // An `openkiwi/` approval has no runtime to retry against at all: the
      // user answered it, and a failure to apply must not trap them in a modal.
      const terminal = approval.method.startsWith("openkiwi/")
        || /no longer|not currently running|unknown request|not found|closed/i.test(message);
      if (terminal) {
        useTaskStore
          .getState()
          .resolveApproval(approval.threadId, approval.id);
      }
      setError(message);
      if (!terminal) throw reason instanceof Error ? reason : new Error(message);
    }
  }, [respondToSettingsProposal]);

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
      if (!isLocalSubscriptionThread(thread)) await rpc("thread/name/set", { threadId: thread.id, name });
      rememberThread(updated);
      setThreads((current) => current.map((entry) => (entry.id === thread.id ? updated : entry)));
      setActiveThread((current) => (current?.id === thread.id ? { ...current, name } : current));
      if (isClaudeThread(thread)) {
        const task = useTaskStore.getState().tasks[thread.id];
        await saveClaudeTranscript({ thread: updated, messages: task?.messages ?? [], activities: task?.activities ?? [] });
      } else if (isCursorThread(thread)) {
        const task = useTaskStore.getState().tasks[thread.id];
        await saveCursorTranscript({ thread: updated, cursorSessionId: cursorSessionIdsRef.current[thread.id] ?? "", messages: task?.messages ?? [], activities: task?.activities ?? [] });
      }
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  /**
   * Drop a thread's delegation state. Ending the bridge session first means a
   * bridge process left behind by a provider CLI can no longer reach the app,
   * even before its parent process notices the thread is gone.
   */
  const forgetChildAgentState = async (threadId: string, dropRecords: boolean) => {
    await releaseChildAgentSessions(childAgentPolicies, threadId);
    // Archiving only shuts down the live bridge. Keep the frozen policy and
    // ownership records so restoring the same thread restores the same powers.
    // Keep the runtime capability record too: app-server may still have the
    // archived thread loaded, and its old bridge identity is exactly what lets
    // the first restored turn detect that a refresh is required.
    if (!dropRecords) return;
    forgetSubagentCapabilities(threadId);
    persistChildAgentPolicies((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([, policy]) => policy.rootThreadId !== threadId));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
    // A deleted root's surviving children still need their ownership records
    // to stay in the Sub-agents inbox. Only deleting the child itself removes
    // that classification record.
    persistChildAgentLinks((current) => childAgentLinksAfterThreadDeletion(current, threadId));
    persistNativeAgentLinks((current) => nativeAgentLinksAfterThreadDeletion(current, threadId));
  };

  const archiveThread = async (thread: Thread) => {
    const label = thread.name || thread.preview || "Untitled thread";
    const taskStatus = useTaskStore.getState().statuses[thread.id];
    if (taskStatus === "starting" || taskStatus === "running") {
      setError(`Stop “${label}” before archiving it so its final output and transcript are preserved.`);
      return;
    }
    if (!window.confirm(`Archive “${label}”?\n\nIt moves to the Archived list in the sidebar, where you can restore or permanently delete it.`)) return;
    try {
      if (!isLocalSubscriptionThread(thread)) await rpc("thread/archive", { threadId: thread.id });
      await cancelChildAgentsFor(thread.id);
      await forgetChildAgentState(thread.id, false);
      if (activeThread?.id === thread.id) newThread();
      forgetThread(thread.id);
      forgetQueuedDeliveries(thread.id);
      setThreads((current) => current.filter((entry) => entry.id !== thread.id));
      const path = normalizedProjectPath(threadProjectBindingsRef.current?.[thread.id] || thread.cwd);
      const provider = providerFromThread(thread, "openai");
      persistArchivedThreads((current) => [{ id: thread.id, label, path, archivedAt: Date.now(), provider }, ...current.filter((entry) => entry.id !== thread.id)]);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const unarchiveThread = async (record: ArchivedThread) => {
    try {
      const claudeTranscript = record.provider === "cursor" ? null : await loadClaudeTranscript(record.id);
      const cursorTranscript = claudeTranscript || record.provider === "claude" ? null : await loadCursorTranscript(record.id);
      if (claudeTranscript) {
        rememberThread(claudeTranscript.thread);
      } else if (cursorTranscript) {
        if (cursorTranscript.cursorSessionId) cursorSessionIdsRef.current[record.id] = cursorTranscript.cursorSessionId;
        rememberThread(cursorTranscript.thread);
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
    const isolation = threadWorktreesRef.current[threadId];
    if (isolation && isolation.status !== "removed") {
      setError(`Remove “${isolation.branch}” from the Worktrees workspace tab before permanently deleting this thread.`);
      return;
    }
    const taskStatus = useTaskStore.getState().statuses[threadId];
    if (taskStatus === "starting" || taskStatus === "running") {
      setError(`Stop “${label}” before deleting it so no model process continues working after the conversation is removed.`);
      return;
    }
    const archived = archivedThreads.find((record) => record.id === threadId);
    let legacyClaudeTranscript = false;
    if (!thread && archived && !archived.provider) {
      try {
        legacyClaudeTranscript = Boolean(await loadClaudeTranscript(threadId));
      } catch (reason) {
        setError(friendlyError(reason));
        return;
      }
    }
    const provider = thread
      ? providerFromThread(thread, "openai")
      : archived
        ? providerForArchivedThread(archived, legacyClaudeTranscript)
        : "openai";
    const localSubscription = provider === "claude" || provider === "cursor";
    if (!window.confirm(`Permanently delete “${label}”?\n\nThis removes the conversation from ${localSubscription ? "OpenKiwi" : "the Codex runtime"} and cannot be undone.`)) return;
    try {
      const saveTimer = claudeSaveTimersRef.current.get(threadId);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      claudeSaveTimersRef.current.delete(threadId);
      const cursorSaveTimer = cursorSaveTimersRef.current.get(threadId);
      if (cursorSaveTimer !== undefined) window.clearTimeout(cursorSaveTimer);
      cursorSaveTimersRef.current.delete(threadId);
      if (provider === "claude") await deleteClaudeTranscript(threadId);
      else if (provider === "cursor") await deleteCursorTranscript(threadId);
      else await rpc("thread/delete", { threadId });
      delete cursorSessionIdsRef.current[threadId];
      await cancelChildAgentsFor(threadId);
      await forgetChildAgentState(threadId, true);
      if (activeThread?.id === threadId) newThread();
      forgetThread(threadId);
      forgetThreadModel(threadId);
      forgetThreadReasoning(threadId);
      deleteThreadTurnDurations(threadId);
      setThreads((current) => current.filter((entry) => entry.id !== threadId));
      persistArchivedThreads((current) => current.filter((entry) => entry.id !== threadId));
      persistThreadHandoffs((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      useTaskStore.getState().removeTask(threadId);
      forgetQueuedDeliveries(threadId);
      setPinnedThreadIds((current) => (current.includes(threadId) ? current.filter((id) => id !== threadId) : current));
      forgetThreadCheckpoints(threadId);
      const bindings = threadProjectBindingsRef.current ?? {};
      if (threadId in bindings) {
        const next = { ...bindings };
        delete next[threadId];
        threadProjectBindingsRef.current = next;
        storeValue("kiwi.threadProjects", next);
      }
      persistThreadWorktrees((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const toggleThreadPin = (threadId: string) => {
    const next = pinnedThreadIds.includes(threadId) ? pinnedThreadIds.filter((id) => id !== threadId) : [...pinnedThreadIds, threadId];
    setPinnedThreadIds(next);
  };

  const openStudio = (tab: StudioTab) => {
    setStudioTab(tab);
    setStudioOpen(true);
  };

  const startReview = async () => {
    if (!activeThread) return;
    if (isLocalSubscriptionThread(activeThread)) {
      setError(`Inline Studio review is currently available for OpenAI and OpenRouter threads. Ask ${providerLabel(providerFromThread(activeThread, settings.provider))} to review the project in the conversation instead.`);
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
    if (isLocalSubscriptionThread(activeThread)) {
      setError(`${providerLabel(providerFromThread(activeThread, settings.provider))} manages its own context compaction. OpenKiwi’s manual compact action is available for OpenAI and OpenRouter threads.`);
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
      // A cross-provider child is an OpenKiwi-owned thread, so its timeline
      // lives in a local transcript rather than in the Codex runtime.
      const link = childAgentLinks[threadId];
      if (link?.provider === "claude" || link?.provider === "cursor") {
        const transcript = link.provider === "claude"
          ? await loadClaudeTranscript(threadId)
          : await loadCursorTranscript(threadId);
        const logicalPath = threadProjectBindingsRef.current?.[threadId];
        const fallbackCwd = logicalPath ? executionPathFor(threadId, logicalPath) : activeExecutionPath;
        const childThread = transcript?.thread
          ?? knownThreadsRef.current?.[threadId]
          ?? { id: threadId, name: null, preview: link.title, cwd: fallbackCwd, updatedAt: Math.floor(Date.now() / 1000), modelProvider: link.provider };
        setActiveThread(childThread);
        if (transcript) {
          useTaskStore.getState().hydrateTask(threadId, transcript.messages, transcript.activities, childThread.cwd);
        } else {
          useTaskStore.getState().ensureTask(threadId, childThread.cwd);
        }
        useTaskStore.getState().setActiveThread(threadId);
        setStudioOpen(false);
        return;
      }
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
      const nativeLink = nativeAgentLinks[threadId];
      const logicalPath = threadProjectBindingsRef.current?.[threadId]
        ?? (nativeLink ? threadProjectBindingsRef.current?.[nativeLink.rootThreadId] : undefined)
        ?? activeWorkspace?.path;
      if (logicalPath) bindThreadToProject(result.thread.id, logicalPath);
      rememberThread(result.thread);
      setThreads((current) => upsertThread(current, result.thread));
      setActiveThread(result.thread);
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, result.thread.cwd);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  /**
   * The studio dock's per-agent Stop. It shares one cutoff implementation with
   * the command center and the model's own `cancel_agent`, so a sub-agent can
   * never be "stopped" in one surface and still running behind another.
   */
  const stopAgent = async (threadId: string) => {
    const rootThreadId = childAgentLinks[threadId]?.rootThreadId ?? nativeAgentLinks[threadId]?.rootThreadId ?? activeThreadId;
    if (!rootThreadId) {
      setError("Open the thread that owns this sub-agent before stopping it.");
      return;
    }
    try {
      await stopChildAgent(rootThreadId, threadId);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const forkThread = async (checkpoint?: CheckpointRecord) => {
    if (!activeThread) return;
    if (activeThreadWorktree && activeThreadWorktree.status !== "removed") {
      setError(
        "Forking an isolated conversation is not available yet because two threads must not silently share one worktree. Apply or merge its changes, remove the worktree, and continue from the shared project first.",
      );
      return;
    }
    try {
      await ensureSkillRoots();
      const result = await rpc<{ thread: Thread }>("thread/fork", { threadId: checkpoint?.threadId ?? activeThread.id, lastTurnId: checkpoint?.turnId, cwd: activeWorkspace?.path, runtimeWorkspaceRoots: activeWorkspace ? [activeWorkspace.path] : undefined, model: effectiveSettings.model, modelProvider: effectiveSettings.provider === "openrouter" ? "openrouter" : undefined, config: threadRuntimeConfig(effectiveSettings, { customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined }), baseInstructions: effectiveSettings.systemPrompt, developerInstructions: openKiwiDeveloperInstructions(false) });
      if (activeWorkspace) bindThreadToProject(result.thread.id, activeWorkspace.path);
      rememberThread(result.thread);
      persistThreadModel(result.thread.id, effectiveSettings.model);
      persistThreadReasoning(result.thread.id, { reasoningEffort: effectiveSettings.reasoningEffort, ultra: effectiveSettings.ultra });
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
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeExecutionPath);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const refreshActiveWorktreeStatus = async () => {
    if (!activeThreadWorktree) return;
    try {
      const next = await readWorktreeStatus(
        activeThreadWorktree.projectPath,
        activeThreadWorktree.path,
        activeThreadWorktree.branch,
        activeThreadWorktree.baseCommit,
      );
      setWorktreeStatus(next);
      if ((!next.exists || !next.registered) && activeThreadWorktree.status !== "missing") {
        persistThreadWorktrees((current) => ({
          ...current,
          [activeThreadWorktree.threadId]: { ...activeThreadWorktree, status: "missing" },
        }));
      } else if (next.exists && next.registered && activeThreadWorktree.status === "missing") {
        persistThreadWorktrees((current) => ({
          ...current,
          [activeThreadWorktree.threadId]: { ...activeThreadWorktree, status: "active" },
        }));
      }
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const applyActiveWorktree = async () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (projectHasActiveTask(activeThreadWorktree.path) || projectHasActiveTask(activeThreadWorktree.projectPath)) {
      setError("Wait for every active task in the isolated worktree and source project to finish before applying changes.");
      return;
    }
    const recreationWarning = activeThreadWorktree.recreatedFromMissing
      ? "\n\nThis worktree was recreated from its committed branch after its folder disappeared. Applying can remove earlier uncommitted work that had already been copied to the shared project; the safety checkpoint lets you restore it."
      : "";
    if (!window.confirm(
      `Apply all changes from “${activeThreadWorktree.branch}” to the shared project?\n\n`
      + `OpenKiwi will save the shared project as a safety checkpoint first. The isolated branch and worktree remain unchanged, and Git staging and commits are not modified.${recreationWarning}`,
    )) return;
    setWorktreeBusy(true);
    try {
      await runCheckpointProjectOperation(activeThreadWorktree.projectPath, async () => {
        const safety = await captureCurrentStateCheckpoint({
          threadId: activeThread.id,
          workspacePath: activeThreadWorktree.projectPath,
          label: `Safety copy before applying ${activeThreadWorktree.branch}`,
          status: "safety",
          worktreeThreadId: activeThread.id,
          worktreeBaseline: activeThreadWorktree.appliedTree ?? activeThreadWorktree.baseCommit,
          serialize: false,
        });
        const applied = await applyWorktreeToSource(
          activeThread.id,
          activeThreadWorktree.projectPath,
          activeThreadWorktree.path,
          activeThreadWorktree.appliedTree ?? activeThreadWorktree.baseCommit,
          safety.id,
        );
        persistThreadWorktrees((current) => ({
          ...current,
          [activeThread.id]: {
            ...activeThreadWorktree,
            status: "applied",
            lastAppliedAt: Date.now(),
            appliedTree: applied.isolatedTree,
            recreatedFromMissing: false,
          },
        }));
      });
      await refreshActiveWorktreeStatus();
      setTransientStatus("Isolated changes applied to project");
    } catch (reason) {
      setError(`Could not apply the isolated changes: ${friendlyError(reason)} The shared-project safety checkpoint remains available.`);
    } finally {
      setWorktreeBusy(false);
    }
  };

  const mergeActiveWorktree = async () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (projectHasActiveTask(activeThreadWorktree.path) || projectHasActiveTask(activeThreadWorktree.projectPath)) {
      setError("Wait for every active task in the isolated worktree and source project to finish before merging.");
      return;
    }
    if (!window.confirm(
      `Merge “${activeThreadWorktree.branch}” into the source project's current branch?\n\n`
      + "Both working folders must be clean and all isolated changes must be committed. OpenKiwi saves a safety checkpoint first and aborts automatically if Git reports a conflict.",
    )) return;
    setWorktreeBusy(true);
    try {
      await runCheckpointProjectOperation(activeThreadWorktree.projectPath, async () => {
        const safety = await captureCurrentStateCheckpoint({
          threadId: activeThread.id,
          workspacePath: activeThreadWorktree.projectPath,
          label: `Safety copy before merging ${activeThreadWorktree.branch}`,
          status: "safety",
          serialize: false,
        });
        const merged = await mergeWorktreeBranch(
          activeThread.id,
          activeThreadWorktree.projectPath,
          activeThreadWorktree.path,
          activeThreadWorktree.branch,
          safety.id,
        );
        persistThreadWorktrees((current) => ({
          ...current,
          [activeThread.id]: {
            ...activeThreadWorktree,
            status: "merged",
            mergedAt: Date.now(),
            appliedTree: merged.isolatedTree,
          },
        }));
      });
      await refreshActiveWorktreeStatus();
      setTransientStatus("Isolated branch merged");
    } catch (reason) {
      setError(`Could not merge the isolated branch: ${friendlyError(reason)}`);
    } finally {
      setWorktreeBusy(false);
    }
  };

  const removeActiveWorktree = async () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (projectHasActiveTask(activeThreadWorktree.path) || projectHasActiveTask(activeThreadWorktree.projectPath)) {
      setError("Wait for active tasks in the isolated worktree and source project before removing it.");
      return;
    }
    setWorktreeBusy(true);
    try {
      const latest = await readWorktreeStatus(
        activeThreadWorktree.projectPath,
        activeThreadWorktree.path,
        activeThreadWorktree.branch,
        activeThreadWorktree.baseCommit,
      );
      setWorktreeStatus(latest);
      const destructive = !latest.clean || latest.ignoredFiles.length > 0 || latest.ahead > 0;
      const details = [
        latest.changedFiles ? `${latest.changedFiles} changed or untracked file${latest.changedFiles === 1 ? "" : "s"}` : "",
        latest.ahead ? `${latest.ahead} unmerged commit${latest.ahead === 1 ? "" : "s"}` : "",
        latest.ignoredFiles.length ? `${latest.ignoredFiles.length} ignored file${latest.ignoredFiles.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      if (!window.confirm(
        destructive
          ? `Remove this isolated worktree and delete its branch?\n\nIt contains ${details}. Those worktree-only files and commits will be permanently deleted. The shared project and GitHub are not changed.`
          : `Remove this isolated worktree and delete its branch?\n\nThe shared project, GitHub repository, and conversation remain available. This thread must be explicitly switched to shared mode before it can run again.`,
      )) return;
      const worktreeCheckpoints = checkpointsRef.current.filter(
        (checkpoint) => checkpoint.workspacePath
          && normalizedProjectPath(checkpoint.workspacePath) === normalizedProjectPath(activeThreadWorktree.path),
      );
      await runCheckpointProjectOperation(activeThreadWorktree.projectPath, async () => {
        await removeThreadWorktree(
          activeThread.id,
          activeThreadWorktree.projectPath,
          activeThreadWorktree.path,
          activeThreadWorktree.branch,
          destructive,
          true,
        );
        for (const checkpoint of worktreeCheckpoints) {
          await deleteCheckpointSnapshot(checkpoint.id, activeThreadWorktree.projectPath).catch(() => undefined);
        }
      });
      persistCheckpoints((current) => current.map((checkpoint) => (
        checkpoint.workspacePath
        && normalizedProjectPath(checkpoint.workspacePath) === normalizedProjectPath(activeThreadWorktree.path)
          ? {
              ...checkpoint,
              status: "failed",
              beforeCommit: undefined,
              afterCommit: undefined,
              error: "The isolated worktree was removed; this historical checkpoint is no longer restorable.",
            }
          : checkpoint
      )));
      persistThreadWorktrees((current) => ({
        ...current,
        [activeThread.id]: {
          ...activeThreadWorktree,
          status: "removed",
          removedAt: Date.now(),
        },
      }));
      setWorktreeStatus(null);
      setTransientStatus("Isolated worktree removed");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setWorktreeBusy(false);
    }
  };

  const continueThreadInSharedProject = () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (activeThreadWorktree.status === "missing") {
      setError("Recreate the missing worktree from its branch, then remove it before continuing this conversation in the shared project.");
      return;
    }
    if (!window.confirm(
      "Continue this conversation in the shared project folder?\n\nFuture model work will run directly in the project. Existing isolated files are not copied automatically.",
    )) return;
    persistThreadWorktrees((current) => {
      const next = { ...current };
      delete next[activeThread.id];
      return next;
    });
    useTaskStore.getState().ensureTask(activeThread.id, activeThreadWorktree.projectPath);
    setTransientStatus("Thread now uses shared project");
  };

  const recreateActiveWorktree = async () => {
    if (!activeThread || !activeThreadWorktree || activeThreadWorktree.status !== "missing") return;
    if (!window.confirm(
      "Recreate this worktree from its committed branch?\n\nUncommitted files from the missing folder cannot be recovered. Changes already applied to the shared project remain there, but a later Apply may reconcile them with the recreated branch and will save a safety checkpoint first.",
    )) return;
    setWorktreeBusy(true);
    try {
      const recreated = await recreateThreadWorktree(
        activeThreadWorktree.projectPath,
        activeThreadWorktree.branch,
        activeThread.name || activeThread.preview || "thread",
      );
      persistThreadWorktrees((current) => ({
        ...current,
        [activeThread.id]: {
          ...activeThreadWorktree,
          path: recreated.path,
          gitDir: recreated.gitDir,
          status: "active",
          // Keep the last successfully applied baseline. The recreated
          // branch may contain commits that still need to cross to source.
          appliedTree: activeThreadWorktree.appliedTree,
          recreatedFromMissing: true,
        },
      }));
      setWorktreeStatus(null);
      setTransientStatus("Isolated worktree recreated from branch");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setWorktreeBusy(false);
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

  const refreshGitHubRepo = useCallback(async (cwd = activeExecutionPath || activeProject?.path || "") => {
    if (!cwd) {
      setGithubRepoStatus(null);
      setGithubRepoError("");
      return;
    }
    try {
      setGithubRepoStatus(await getGitHubRepoStatus(cwd));
      setGithubRepoError("");
    } catch (reason) {
      setGithubRepoStatus(null);
      setGithubRepoError(friendlyError(reason));
    }
  }, [activeExecutionPath, activeProject?.path]);

  useEffect(() => {
    void refreshGitHubRepo();
    setGithubRemoteInput("");
    setGithubRepoName(activeProject?.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ?? "");
  }, [activeExecutionPath, activeProject?.id, activeProject?.name, refreshGitHubRepo]);

  const runGitAction = async (action: GitWorkspaceAction) => {
    if (!activeProject) return;
    const unavailable = gitActionUnavailableReason(action, effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    const commandPath = activeExecutionPath || activeProject.path;
    const gitRoots = activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : [];
    const pushCommand = gitPushCommand(githubRepoStatus);
    const pushCompletionNote = async () => {
      try {
        const remaining = await executeCommand(["git", "status", "--porcelain", "-uall"], commandPath, gitRoots);
        return remaining.exitCode === 0 ? gitPushCompletionNote(remaining.stdout) : "";
      } catch {
        return "";
      }
    };
    const showPushOutput = (output: string) => {
      setGitOutput(output);
      void pushCompletionNote().then((note) => {
        if (!note) return;
        setGitOutput((current) => current === output ? `${output}\n\n${note}` : current);
      });
    };
    if (action === "commitPush") {
      if (!pushCommand) {
        setGitOutput("Check out a named branch before committing and pushing to GitHub.");
        return;
      }
      const commitCommand = ["git", "commit", "-m", gitCommitMessage.trim()];
      try {
        const commit = await executeCommand(commitCommand, commandPath, gitRoots);
        if (commit.exitCode !== 0) {
          setGitOutput(`$ ${commitCommand.join(" ")}\n${commit.stdout}${commit.stderr}\n[exit ${commit.exitCode}]`);
          return;
        }
        const push = await executeCommand(pushCommand, commandPath, gitRoots);
        const output = `$ ${commitCommand.join(" ")}\n${commit.stdout}${commit.stderr}\n[exit ${commit.exitCode}]\n\n$ ${pushCommand.join(" ")}\n${push.stdout}${push.stderr}\n[exit ${push.exitCode}]`;
        if (push.exitCode === 0) showPushOutput(output);
        else setGitOutput(output);
        setGitCommitMessage("");
        if (push.exitCode === 0) void refreshGitHubRepo(commandPath);
      } catch (reason) {
        setGitOutput(friendlyError(reason));
      }
      return;
    }
    let command: string[];
    if (action === "status") command = ["git", "status", "--short", "--branch"];
    else if (action === "diff") command = ["git", "diff", "--stat", "--patch"];
    else if (action === "stage") command = ["git", "add", "--all"];
    else if (action === "revert") {
      if (!window.confirm("Revert all tracked staged and working-tree changes? Untracked files will be kept.")) return;
      command = ["git", "restore", "--staged", "--worktree", "."];
    } else if (action === "commit") command = ["git", "commit", "-m", gitCommitMessage.trim()];
    else if (action === "fetch") command = ["git", "fetch", "--prune", "origin"];
    else if (action === "pull") command = ["git", "pull", "--ff-only"];
    else if (action === "push") {
      if (!pushCommand) {
        setGitOutput("Check out a named branch before pushing to GitHub.");
        return;
      }
      command = pushCommand;
    } else if (action === "comments") command = githubCliCommand(githubStatus?.path || "gh", "comments");
    else if (action === "ci") command = githubCliCommand(githubStatus?.path || "gh", "ci");
    else {
      if (!window.confirm("Create a draft pull request on the configured GitHub remote?")) return;
      command = githubCliCommand(githubStatus?.path || "gh", "pr");
    }
    try {
      const result = await executeCommand(command, commandPath, gitRoots);
      const combined = `${result.stdout}${result.stderr || ""}`;
      const output = combined.includes("not a git repository")
        ? "This project folder is not a Git repository yet. Initialize Git from the terminal to enable these workflows."
        : `$ ${command.join(" ")}\n${combined}\n[exit ${result.exitCode}]`;
      if (action === "push" && result.exitCode === 0) showPushOutput(output);
      else setGitOutput(output);
      if (action === "diff" && activeThreadId) useTaskStore.getState().setDiff(activeThreadId, result.stdout);
      if (action === "commit" && result.exitCode === 0) setGitCommitMessage("");
      if (result.exitCode === 0) void refreshGitHubRepo(commandPath);
    } catch (reason) {
      setGitOutput(friendlyError(reason));
    }
  };

  const attachActiveGitHubRemote = async () => {
    if (!activeProject || !githubRemoteInput.trim()) return;
    const unavailable = gitActionUnavailableReason("attach", effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    setGithubBusy(true);
    try {
      const next = await attachGitHubRemote(activeExecutionPath || activeProject.path, githubRemoteInput.trim());
      setGithubRepoStatus(next);
      setGithubRemoteInput("");
      showSuccessToast("GitHub repository attached");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setGithubBusy(false);
    }
  };

  const createActiveGitHubRepository = async () => {
    if (!activeProject || !githubRepoName.trim()) return;
    const unavailable = gitActionUnavailableReason("create", effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    setGithubBusy(true);
    try {
      const next = await createGitHubRepository(activeExecutionPath || activeProject.path, githubRepoName.trim(), githubRepoVisibility);
      setGithubRepoStatus(next);
      showSuccessToast(`${githubRepoVisibility === "private" ? "Private" : "Public"} GitHub repository created`);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setGithubBusy(false);
    }
  };

  const refreshGitHubAccount = async () => {
    setGithubBusy(true);
    try {
      setGithubStatus(await getGitHubStatus());
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setGithubBusy(false);
    }
  };

  const beginGitHubLogin = async () => {
    setGithubBusy(true);
    try {
      await startGitHubLogin();
      setGithubLoginPending(true);
      showSuccessToast("Finish GitHub sign-in in Terminal; OpenKiwi will connect automatically");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setGithubBusy(false);
    }
  };

  const cloneGitHubProject = async (url: string, folderName: string): Promise<boolean> => {
    const safeName = folderName.trim();
    if (!safeName || safeName === "." || safeName === ".." || /[\\/]/.test(safeName)) {
      setError("Choose a simple local folder name without slashes.");
      return false;
    }
    const parent = await open({ directory: true, multiple: false, title: "Choose where to clone the project" });
    if (!parent || Array.isArray(parent)) return false;
    const destination = `${parent.replace(/[\\/]+$/, "")}/${safeName}`;
    setGithubBusy(true);
    try {
      await cloneGitHubRepository(url.trim(), destination);
      const project: Project = { id: crypto.randomUUID(), name: safeName, path: destination };
      const next = [...projects, project];
      setProjects(next);
      setActiveProjectId(project.id);
      setWorkspaceMode("project");
      showSuccessToast("GitHub repository cloned and added");
      return true;
    } catch (reason) {
      setError(friendlyError(reason));
      return false;
    } finally {
      setGithubBusy(false);
    }
  };

  const runProjectAction = async (action: ProjectAction) => {
    if (!activeProject) return;
    setStudioTab("terminal");
    terminal.append(`${terminal.outputStore.appendedLength() ? "\n" : ""}$ ${action.command}\n`);
    try {
      const result = await executeCommand(["/bin/zsh", "-lc", action.command], activeExecutionPath || activeProject.path, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
      terminal.append(`${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
      void auditEvent("action.completed", { actionId: action.id, command: action.command, exitCode: result.exitCode }, activeThreadId ?? undefined).catch(() => {});
    } catch (reason) {
      terminal.append(`${friendlyError(reason)}\n`);
    }
  };

  const runGitPathAction = async (action: "stage" | "revert", path: string) => {
    if (!activeProject) return;
    const unavailable = gitActionUnavailableReason(action, effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    const commandPath = activeExecutionPath || activeProject.path;
    if (action === "revert" && !window.confirm(`Revert changes to ${path}?`)) return;
    const command = action === "stage" ? ["git", "add", "--", path] : ["git", "restore", "--staged", "--worktree", "--", path];
    try {
      const result = await executeCommand(command, commandPath, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
      setGitOutput(`$ ${command.join(" ")}\n${result.stdout}${result.stderr}\n[exit ${result.exitCode}]`);
      if (activeThreadId) await refreshDiffFor(activeThreadId, commandPath);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const chooseSkillsFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose your OpenKiwi skills folder" });
    if (!selected || Array.isArray(selected)) return;
    setSkillsFolder(selected);
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
      setSkillsError(`Another skill already uses @${name}.`);
      return false;
    }
    const next = { ...skillAliases, [path]: name };
    setSkillAliases(next);
    setSkills(resolveLocalSkills(skillFiles, next, disabledSkillPaths));
    setSkillsError("");
    return true;
  };

  const toggleSkill = (path: string) => {
    const next = disabledSkillPaths.includes(path) ? disabledSkillPaths.filter((candidate) => candidate !== path) : [...disabledSkillPaths, path];
    setDisabledSkillPaths(next);
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
    setScheduledTasks((current) => current.map((item) => (item.id === id ? patch(item) : item)));
  }, [setScheduledTasks]);

  useAppShortcuts({
    running: Boolean((running || childrenRunning) && activeThread),
    modalOpen: onboardingOpen || settingsOpen || commandPaletteOpen || runtimeSetupOpen || authRequiredOpen || Boolean(pendingApproval) || permissionOpen,
    commandPaletteOpen,
    threadOpen: Boolean(activeThreadId),
    toggleCommandPalette: () => setCommandPaletteOpen((open) => !open),
    openConversationSearch: () => {
      setConvSearchOpen(true);
      requestAnimationFrame(() => convSearchInputRef.current?.focus());
    },
    newThread,
    openSettings,
    stopTurn: () => void stopTurnAndChildren(),
  });
  useThreadHealth({
    runtimeAvailable: Boolean(runtimeStatus?.available),
    threadFor: (threadId) => knownThreadsRef.current?.[threadId] ?? (activeThread?.id === threadId ? activeThread : undefined),
  });

  const recordScheduleRun = useCallback((run: ScheduleRunRecord) => {
    setScheduleRuns((current) => [run, ...current].slice(0, 100));
  }, [setScheduleRuns]);

  const updateWorkflow = useCallback((id: string, patch: (current: WorkflowDefinition) => WorkflowDefinition) => {
    setWorkflows((current) => current.map((workflow) => (workflow.id === id ? patch(workflow) : workflow)));
  }, [setWorkflows]);

  const recordWorkflowRun = useCallback((run: WorkflowRunRecord) => {
    setWorkflowRuns((current) => {
      const existing = current.findIndex((item) => item.id === run.id);
      return existing >= 0 ? current.map((item) => (item.id === run.id ? run : item)) : [run, ...current].slice(0, 100);
    });
  }, [setWorkflowRuns]);

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
    <div ref={shellRef} className="app-shell" data-theme={previewTheme ?? settings.theme} data-openai-logo={settings.openAiLogo} data-claude-logo={settings.claudeLogo} data-cursor-logo={settings.cursorLogo} style={{ zoom: (settings.uiScale || 100) / 100 }}>
      {successToast && (
        <div className="app-toast success" role="status" aria-live="polite">
          <span className="app-toast-icon"><Check size={14} strokeWidth={2.5} /></span>
          <span>{successToast}</span>
          <button onClick={dismissSuccessToast} aria-label="Dismiss notification">
            <X size={13} />
          </button>
        </div>
      )}
      {/* While Settings or Onboarding is open, the content behind the dialog
          is inert so keyboard and assistive-tech focus cannot reach it. The
          studio dock and remaining modals are covered by the full-screen
          backdrop and each dialog's own focus containment. */}
      {/* Width comes from --sidebar-width on the shell, not an inline style:
          a drag writes that property directly so the edge tracks the pointer
          without rendering the app, and an unrelated render mid-drag cannot
          snap the sidebar back to the last committed width. */}
      <aside inert={settingsOpen || onboardingOpen ? true : undefined} className={`sidebar ${sidebarOpen ? "open" : "closed"}`}>
        {sidebarOpen && (
          <div
            className="pane-resize sidebar-resize"
            onPointerDown={startPaneResize("sidebar")}
            onKeyDown={resizePaneWithKeyboard("sidebar")}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={PANE_BOUNDS.sidebar.min}
            aria-valuemax={PANE_BOUNDS.sidebar.max}
            aria-valuenow={Math.round(paneSizes.sidebar)}
            tabIndex={0}
          />
        )}
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
          <kbd>Ctrl+N</kbd>
        </button>

        {/* Same arrangement as the sidebar edge: the split lives in
            --sidebar-split on this container, written directly while dragging
            and committed to React once on release. */}
        <div className="sidebar-sections" ref={sidebarSectionsRef}>
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
              onClick={() => setWorkspaceMode("chat")}
              title="Conversations without a project folder"
            >
              <span className="workspace-icon chat">
                <MessageSquare size={14} />
              </span>
              <span className="workspace-name">Chats</span>
            </button>
            {projects.map((project) => {
              const workingCount = projectThreadCounts[normalizedProjectPath(project.path)] ?? 0;
              const workingLabel = `${workingCount} thread${workingCount === 1 ? "" : "s"} working`;
              return <div
                key={project.id}
                className={[
                  "workspace-row-wrap",
                  workspaceMode === "project" && project.id === activeProjectId ? "active" : "",
                  draggedProjectId === project.id ? "dragging" : "",
                  projectDropTarget?.id === project.id ? `drop-${projectDropTarget.position}` : "",
                ].filter(Boolean).join(" ")}
                data-project-id={project.id}
                onPointerDown={(event) => startProjectPointerDrag(event, project.id)}
              >
                <button
                  className="workspace-row"
                  aria-label={workingCount > 0 ? `${project.name}, ${workingLabel}` : project.name}
                  onClick={(event) => {
                    if (suppressProjectClickRef.current) {
                      event.preventDefault();
                      return;
                    }
                    setActiveProjectId(project.id);
                    setWorkspaceMode("project");
                  }}
                  title={project.path}
                >
                  <span className="workspace-icon">{project.pinned ? <Pin size={13} /> : <Folder size={14} />}</span>
                  <span className="workspace-name">{project.name}</span>
                  {workingCount > 0 && (
                    <span
                      className="workspace-thread-count"
                      title={workingLabel}
                      aria-hidden="true"
                    >
                      {workingCount}
                    </span>
                  )}
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
              </div>;
            })}
            {!projects.length && (
              <button className="empty-project-button" onClick={addProject}>
                <FolderOpen size={17} />
                Open a folder
              </button>
            )}
          </div>
        </div>

        <div
          className="sidebar-section-resize"
          onPointerDown={startSidebarSplitResize}
          onKeyDown={resizeSidebarSplitWithKeyboard}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize projects and threads"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(sidebarSplitRatio * 100)}
          tabIndex={0}
        />

        <div className="sidebar-section threads-section">
          <div className="section-label-row">
            <span className="section-label">Threads</span>
            {activeWorkspace && <div className="thread-kind-switch" role="group" aria-label="Thread type">
              <button className={threadKindView === "main" ? "active" : ""} onClick={() => setThreadKindView("main")} aria-pressed={threadKindView === "main"}>Main <span>{threadKindCounts.main}</span></button>
              <button className={threadKindView === "subagents" ? "active" : ""} onClick={() => setThreadKindView("subagents")} aria-pressed={threadKindView === "subagents"}>Sub-agents <span>{threadKindCounts.subagents}</span></button>
            </div>}
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
                  <ThreadInboxCard
                    threadId={thread.id}
                    title={thread.name || thread.preview || "Untitled thread"}
                    workspaceName={activeWorkspace?.name ?? basename(thread.cwd)}
                    directory={threadWorktrees[thread.id]?.path || thread.cwd || activeWorkspace?.path || ""}
                    provider={providerFromThread(thread, settings.provider)}
                    providerName={providerLabel(providerFromThread(thread, settings.provider))}
                    pinned={pinnedThreadIds.includes(thread.id)}
                    isolated={Boolean(threadWorktrees[thread.id] && threadWorktrees[thread.id].status !== "removed")}
                    branch={threadWorktrees[thread.id]?.branch}
                    onOpen={() => void selectThread(thread)}
                  />
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
            {activeWorkspace && !displayedThreads.length && <div className="empty-threads">{threadKindView === "subagents" ? "No sub-agent threads yet" : workspaceMode === "chat" ? "No normal chats yet" : "No threads in this project yet"}</div>}
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
        </div>

        <div className="sidebar-footer">
          <button className="sidebar-settings" onClick={() => openSettings()}>
            <Settings size={16} />
            <span>Settings</span>
            <span className={`provider-dot ${settings.provider}`} title={`Default provider: ${providerLabel(settings.provider)}`} />
          </button>
        </div>
      </aside>

      <main inert={settingsOpen || onboardingOpen ? true : undefined} className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button className="icon-button" onClick={() => setSidebarOpen(true)} title="Show sidebar" aria-label="Show sidebar">
                <PanelLeftOpen size={18} />
              </button>
            )}
            <div className="project-heading">
              <span>{activeWorkspace?.isChat ? "Normal chat" : (activeProject?.name ?? "No project selected")}</span>
              <small>{activeThreadWorktree && activeThreadWorktree.status !== "removed"
                ? `${activeThreadWorktree.branch} · ${activeThreadWorktree.path}`
                : activeThread ? activeThread.name || activeThread.preview || "New thread" : activeWorkspace?.isChat ? "No project folder" : (activeProject?.path ?? "Choose a project or use Chats")}</small>
            </div>
            {activeThreadWorktree && activeThreadWorktree.status !== "removed" && (
              <button className="isolation-chip" onClick={() => void revealItemInDir(activeThreadWorktree.path)} title={activeThreadWorktree.path}>
                <GitBranch size={12} /> <span>Isolated</span>
              </button>
            )}
            {activeThreadHandoff && (
              <button className="handoff-chip" onClick={() => {
                // The source can be deleted or pruned out of the sidebar index
                // long after the handoff; say so instead of doing nothing.
                const source = knownThreadsRef.current?.[activeThreadHandoff.sourceThreadId];
                if (source) void selectThread(source);
                else setError(`The source task “${activeThreadHandoff.sourceTitle}” is no longer available. This thread keeps the context that was handed off.`);
              }} title={`Open source task: ${activeThreadHandoff.sourceTitle}`}>
                <GitFork size={12} /> <span>From {providerLabel(activeThreadHandoff.sourceProvider)}</span>
              </button>
            )}
            {activeProject && (
              <ProjectPromptControl
                key={activeProject.id}
                projectName={activeProject.name}
                projectPrompt={activeProject.overrides?.systemPrompt}
                promptMode={activeProject.overrides?.systemPromptMode ?? "replace"}
                appPrompt={resolveProviderSystemPrompt(settings.systemPrompt, effectiveSettings.provider, settings.codexSystemPrompt, settings.claudeSystemPrompt)}
                provider={effectiveSettings.provider}
                threadStarted={Boolean(activeThread)}
                onSave={persistActiveProjectPrompt}
                onAppPromptSettings={() => openSettings("prompts")}
              />
            )}
          </div>
          <div className="topbar-right">
            {activeThread && (
              <button className="icon-button topbar-export-button" onClick={() => void exportTranscript()} title="Export conversation as Markdown" aria-label="Export conversation as Markdown">
                <Download size={15} />
              </button>
            )}
            <button className="command-palette-trigger" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette">
              <Command size={13} />
              <span>Search</span>
              <kbd>Ctrl+K</kbd>
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
                onClick={() => setWorkspaceMode("chat")}
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
                  {pendingHandoffForWorkspace && (
                    <div className="handoff-draft-banner">
                      <GitFork size={15} />
                      <span><strong>Provider handoff ready</strong><small>From {providerLabel(pendingHandoffForWorkspace.sourceProvider)} · review the visible context below, then send it to {providerLabel(pendingHandoffForWorkspace.targetProvider)}.</small></span>
                    </div>
                  )}
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
                  {!activeWorkspace.isChat && !activeThread && (
                    <div className="isolation-choice" aria-label="Thread workspace mode">
                      <button className={!draftThreadIsolated ? "active" : ""} onClick={() => setDraftThreadIsolated(false)}>
                        <Folder size={15} />
                        <span><strong>Shared project</strong><small>Work directly in {activeProject?.name}</small></span>
                      </button>
                      {workspaceGitInfo && !workspaceGitInfo.error && (
                        (!workspaceGitInfo.isRepo || (workspaceGitInfo.isRoot && !workspaceGitInfo.hasCommit)) ? (
                          <button
                            className="git-initialize-choice"
                            onClick={() => void initializeActiveProjectGit()}
                            disabled={gitInitializing}
                            aria-busy={gitInitializing}
                            title="Create a local Git repository and initial snapshot. Nothing is pushed."
                          >
                            {gitInitializing ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}
                            <span>
                              <strong>{workspaceGitInfo.isRepo ? "Create initial Git snapshot" : "Initialize Git repository"}</strong>
                              <small>{gitInitializing ? "Preparing this project…" : "Local only; respects .gitignore"}</small>
                            </span>
                          </button>
                        ) : (
                          <button
                            className={draftThreadIsolated ? "active" : ""}
                            onClick={() => setDraftThreadIsolated(true)}
                            disabled={!workspaceGitInfo.isRoot || !workspaceGitInfo.hasCommit}
                            title={!workspaceGitInfo.isRoot ? "Open the Git repository root to use an isolated worktree" : !workspaceGitInfo.hasCommit ? "Requires at least one Git commit" : "Create a private branch and worktree for this thread"}
                          >
                            <GitBranch size={15} />
                            <span>
                              <strong className="isolated-worktree-title">Isolated worktree</strong>
                              <small>{workspaceGitInfo.isRoot ? <>Private branch; apply or<br />merge when ready</> : "Open the repository root folder"}</small>
                            </span>
                          </button>
                        )
                      )}
                      {!workspaceGitInfo && (
                        <button disabled title="Checking this project's Git status">
                          <LoaderCircle className="spin" size={15} />
                          <span>
                            <strong>Checking Git status</strong>
                            <small>Preparing workspace options…</small>
                          </span>
                        </button>
                      )}
                      {workspaceGitInfo?.error && (
                        <button disabled title={workspaceGitInfo.error}>
                          <GitBranch size={15} />
                          <span>
                            <strong>Git status unavailable</strong>
                            <small>Check that the project folder still exists</small>
                          </span>
                        </button>
                      )}
                    </div>
                  )}
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
                    <ConversationTimeline threadId={activeThreadId} running={running} thinkingLabel={activeWorkspace.isChat ? "Thinking in normal chat" : `Working in ${activeProject?.name}`} approval={inlineApproval} provider={effectiveSettings.provider} searchQuery={convSearchOpen ? convSearchQuery : ""} searchActiveMatch={convSearchIndex} onSearchMatches={setConvSearchCount} onEditMessage={editMessageIntoComposer} onApprovalRespond={respondToApproval} />
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
                childrenRunning={childrenRunning}
                queueing={Boolean(running && activeThread)}
                dropActive={dropActive}
                placeholder={running && activeThread ? "Queue a follow-up for after this run…" : activeWorkspace.isChat ? "Ask anything — no project folder attached…" : `Ask OpenKiwi to work in ${activeProject?.name ?? "this project"}…`}
                attachments={attachments}
                queuedTurns={queuedTurns}
                searchFiles={searchProjectFiles}
                skills={composerSkills}
                onRemoveAttachment={(path) => setAttachments((current) => current.filter((entry) => entry.path !== path))}
                onPasteImages={(items) => void pasteImages(items)}
                onSend={sendMessage}
                onSteer={steerMessage}
                onSteerQueued={(queuedTurnId) => void steerQueuedMessage(queuedTurnId)}
                onRetryQueued={retryQueuedMessage}
                onRemoveQueued={removeQueuedMessage}
                onStop={() => void stopTurnAndChildren()}
                modelControls={
                  <>
                    {effectiveSettings.provider === "openai" && <ModelPowerControl model={effectiveSettings.model || DEFAULT_OPENAI_MODEL} effort={effectiveSettings.reasoningEffort} ultra={effectiveSettings.ultra} fast={settings.serviceTier === "priority"} runtimeModels={runtimeModels} onModel={persistComposerModel} onEffort={persistComposerReasoning} onUltra={persistComposerUltra} onFast={(fast) => persistSettings({ ...settings, serviceTier: fast ? "priority" : null })} />}
                    {effectiveSettings.provider === "openrouter" && (
                      <OpenRouterModelControl
                        model={effectiveSettings.model}
                        effort={effectiveSettings.reasoningEffort}
                        models={openRouterModels}
                        loading={openRouterModelsLoading}
                        error={openRouterModelsError}
                        onModel={(model) => {
                          persistComposerModel(model);
                          if (effectiveSettings.ultra) persistComposerReasoning(effectiveSettings.reasoningEffort);
                        }}
                        onEffort={persistComposerReasoning}
                        onRefresh={() => void refreshOpenRouterModels()}
                      />
                    )}
                    {effectiveSettings.provider === "claude" && <ClaudeModelControl model={effectiveSettings.model || DEFAULT_CLAUDE_MODEL} effort={effectiveSettings.reasoningEffort} onModel={(model) => persistComposerModel(model)} onEffort={persistComposerReasoning} />}
                    {effectiveSettings.provider === "cursor" && <CursorModelControl model={effectiveSettings.model || DEFAULT_CURSOR_MODEL} models={cursorModels} effort={effectiveSettings.reasoningEffort} loading={cursorModelsLoading} onRefresh={() => void refreshCursorModels()} onModel={(model) => persistComposerModel(model)} onEffort={persistComposerReasoning} />}
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
                    <SubAgentCommandCenter
                      policy={composerSubagentPolicy}
                      capturedPolicy={activeDelegationPolicy ?? null}
                      mode={subagentPolicyMode}
                      readiness={childAgentReadiness}
                      workers={subAgentWorkers}
                      scopeLabel={activeProject ? activeProject.name : "Chats & project defaults"}
                      projectOverride={Boolean(activeProject?.overrides?.subagents)}
                      modelCatalogs={subAgentModelCatalogs}
                      onChange={persistComposerSubagentPolicy}
                      onOpenSettings={() => openSettings("agents")}
                      onStopWorker={stopSubAgentWorker}
                      onReplaceWorker={replaceSubAgentWorker}
                    />
                    <button className={`toolbar-button ${attachments.length ? "has-attachments" : ""}`} onClick={() => void addAttachment()} title="Attach context">
                      <Paperclip size={14} />
                      {attachments.length ? attachments.length : "Attach"}
                    </button>
                  </>
                }
              />
              <div className="composer-caption">
                OpenKiwi can make mistakes. Review commands and changes before shipping.
                {contextPercent !== null ? (
                  <span className={`context-meter ${contextPercent > 80 ? "warn" : ""}`}>
                    {" "}
                    · Context {Math.round(contextPercent)}% used{costEstimate ? ` · ${costEstimate}` : ""}
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
            onResizeStart={startPaneResize("dock")}
            onResizeKeyDown={resizePaneWithKeyboard("dock")}
            resizeValue={paneSizes.dock}
            tab={studioTab}
            projectName={activeProject?.name}
            projectPath={activeExecutionPath || activeProject?.path}
            activeThread={Boolean(activeThread)}
            diff={diff}
            agents={agentRecords}
            terminalOutput={terminal.outputStore}
            terminalCommand={terminal.command}
            terminalRunning={terminal.running}
            checkpoints={checkpoints.filter((item) => {
              if (!activeProject) return false;
              if (item.workspacePath) {
                const path = normalizedProjectPath(item.workspacePath);
                return path === normalizedProjectPath(activeExecutionPath)
                  || Boolean(activeThread && item.threadId === activeThread.id && path === normalizedProjectPath(activeProject.path));
              }
              return Boolean(activeThread && item.threadId === activeThread.id);
            })}
            checkpointHead={activeProject ? checkpointHeads[normalizedProjectPath(activeExecutionPath)] : undefined}
            checkpointBusyId={checkpointBusyId}
            checkpointPreview={checkpointPreview}
            worktree={activeThreadWorktree}
            worktreeStatus={worktreeStatus}
            worktreeBusy={worktreeBusy}
            attachments={attachments}
            usage={tokenUsage}
            costEstimate={costEstimate}
            costTotals={costTotalsView}
            accountUsage={accountUsageView}
            skills={skills}
            mcpServers={mcpServers}
            gitOutput={gitOutput}
            gitCommitMessage={gitCommitMessage}
            githubAuthenticated={Boolean(githubStatus?.authenticated)}
            githubRepoStatus={githubRepoStatus}
            githubRepoError={githubRepoError}
            gitActionsReadOnly={effectiveSettings.permission === "read-only"}
            githubRemoteInput={githubRemoteInput}
            githubRepoName={githubRepoName}
            githubRepoVisibility={githubRepoVisibility}
            promptAudit={[
              { label: "Base instruction", value: effectiveSettings.systemPrompt ? `${activeProject?.overrides?.systemPrompt ? (activeProject.overrides.systemPromptMode === "append" ? "OpenKiwi + project" : "project") : "OpenKiwi"} · ${effectiveSettings.systemPrompt.length} chars` : "empty" },
              { label: "Developer instruction", value: "empty" },
              { label: "AGENTS.md discovery", value: settings.projectInstructionsEnabled ? "enabled · up to 32 KB" : "disabled" },
              { label: "Model", value: effectiveSettings.model || "provider default" },
              { label: "Reasoning", value: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort },
              { label: "Sub-agents", value: effectiveSettings.subagentsEnabled ? `on · max ${effectiveSettings.subagentMax}` : "off" },
              { label: "Cross-provider", value: effectiveSettings.subagentsEnabled ? childAgentSummary : "off" },
              { label: "Skills", value: skillsFolder ? `${skills.filter((skill) => skill.enabled).length} enabled · local folder` : "no folder selected" },
              { label: "Permissions", value: permissionLabel(effectiveSettings.permission) },
              { label: "Service tier", value: settings.serviceTier || "standard" },
            ]}
            projectActions={projectActions}
            workflows={workflows.filter((workflow) => workflow.projectId === activeProject?.id && workflow.enabled)}
            workflowRuns={workflowRuns}
            onTab={(tab) => {
              setStudioTab(tab);
              if (tab === "git") void refreshGitHubAccount();
            }}
            onClose={() => setStudioOpen(false)}
            onRefreshDiff={() => void refreshDiff()}
            onReview={() => void startReview()}
            onOpenAgent={(id) => void openAgent(id)}
            onStopAgent={(id) => void stopAgent(id)}
            onTerminalCommand={terminal.setCommand}
            onRunTerminal={() => {
              if (activeExecutionPath) void terminal.run(activeExecutionPath, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
            }}
            onStopTerminal={() => void terminal.stop()}
            onTerminalInput={terminal.write}
            onTerminalResize={terminal.resize}
            onCheckpoint={() => void createCheckpoint()}
            onFork={(checkpoint) => void forkThread(checkpoint)}
            onCheckpointRestore={(checkpoint, target) => void restoreCheckpoint(checkpoint, target)}
            onCheckpointAccept={toggleCheckpointAccepted}
            onCheckpointPreview={(checkpoint) => void previewCheckpoint(checkpoint)}
            onCheckpointDelete={(checkpoint) => void removeCheckpoint(checkpoint)}
            onRollback={() => void rollbackTurn()}
            onWorktreeReview={() => {
              setStudioTab("review");
              void refreshDiff();
            }}
            onWorktreeApply={() => void applyActiveWorktree()}
            onWorktreeMerge={() => void mergeActiveWorktree()}
            onWorktreeReveal={() => {
              if (activeThreadWorktree) void revealItemInDir(activeThreadWorktree.path);
            }}
            onWorktreeRefresh={() => void refreshActiveWorktreeStatus()}
            onWorktreeRemove={() => void removeActiveWorktree()}
            onWorktreeRecreate={() => void recreateActiveWorktree()}
            onWorktreeContinueShared={continueThreadInSharedProject}
            onAddAttachment={() => void addAttachment()}
            onRemoveAttachment={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
            onRefreshUsage={() => {
              if (effectiveSettings.provider === "claude") void refreshClaudeStatus();
              else if (effectiveSettings.provider === "cursor") void Promise.all([refreshCursorStatus(), refreshCursorModels()]);
              else if (effectiveSettings.provider === "openrouter") void hasOpenRouterKey().then(setOpenRouterReady).catch(() => setOpenRouterReady(false));
              else void refreshUsage();
            }}
            onCompact={() => void compactThread()}
            onRefreshTools={() => void refreshTools(activeProject)}
            onGitAction={(action) => void runGitAction(action)}
            onGitCommitMessage={setGitCommitMessage}
            onGitHubRemoteInput={setGithubRemoteInput}
            onGitHubRepoName={setGithubRepoName}
            onGitHubRepoVisibility={setGithubRepoVisibility}
            onGitHubAttach={() => void attachActiveGitHubRemote()}
            onGitHubCreate={() => void createActiveGitHubRepository()}
            onOpenGitHubSettings={() => {
              setStudioOpen(false);
              openSettings("github");
            }}
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
        cursorStatus={cursorStatus}
        cursorLoginStarting={cursorLoginStarting}
        openRouterReady={openRouterReady}
        childAgentReadiness={childAgentReadiness}
        githubStatus={githubStatus}
        githubBusy={githubBusy || githubLoginPending}
        usageTotals={allTimeUsage}
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
        onCursorSignIn={beginCursorLogin}
        onCursorRefresh={async () => {
          const next = await refreshCursorStatus();
          if (next.loggedIn) await refreshCursorModels();
          return next;
        }}
        onRuntimeRequired={() => setRuntimeSetupOpen(true)}
        onWorkspaceTools={() => {
          closeSettings();
          openStudio("tools");
        }}
        onOpenRouterChange={setOpenRouterReady}
        onGitHubSignIn={beginGitHubLogin}
        onGitHubRefresh={refreshGitHubAccount}
        onGitHubClone={cloneGitHubProject}
        onError={setError}
        profiles={promptProfiles}
        agents={customAgents}
        actions={projectActions}
        schedules={scheduledTasks}
        workflows={workflows}
        workflowRuns={workflowRuns}
        projects={projects}
        activeProjectId={workspaceMode === "project" ? activeProjectId : null}
        skillsFolder={skillsFolder}
        skills={skills}
        skillsBusy={skillsBusy}
        skillsError={skillsError}
        mcpServers={mcpServers}
        onMcpChanged={() => void refreshTools(activeProject)}
        workspaceToolsAvailable={Boolean(activeProject)}
        onProfiles={setPromptProfiles}
        onAgents={setCustomAgents}
        onActions={setProjectActions}
        onSchedules={setScheduledTasks}
        onWorkflows={setWorkflows}
        onRunWorkflow={async (workflowId, variables) => {
          closeSettings();
          await runWorkflow(workflowId, "manual", variables);
        }}
        onStopWorkflow={(workflowId) => stopWorkflow(workflowId)}
        onProjects={setProjects}
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
          <OnboardingModal open={onboardingOpen} runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} skillsFolder={skillsFolder} onComplete={completeOnboarding} onOpenSettings={(section) => openSettings(section)} onChooseSkillsFolder={() => void chooseSkillsFolder()} onAddProject={() => void addProject()} onStartChat={startNormalChat} />
        </Suspense>
      )}

      <RuntimeSetupModal open={runtimeSetupOpen} checking={runtimeChecking} onClose={() => setRuntimeSetupOpen(false)} onRetry={() => void retryRuntime()} />

      <AuthRequiredModal open={authRequiredOpen} busy={loginStarting} onClose={() => setAuthRequiredOpen(false)} onSignIn={() => void beginChatGptLogin()} />

      {pendingApproval && (
        <ApprovalCenter
          key={`${pendingApproval.threadId}:${pendingApproval.id}`}
          approval={pendingApproval}
          threadLabel={(() => {
            if (pendingApproval.threadId === "runtime") return undefined;
            const known = knownThreadsRef.current?.[pendingApproval.threadId];
            const thread = threads.find((entry) => entry.id === pendingApproval.threadId) ?? known;
            return thread?.name || thread?.preview || `thread ${pendingApproval.threadId.slice(0, 8)}`;
          })()}
          pendingCount={pendingApprovalCount - 1}
          onRespond={(result) => respondToApproval(pendingApproval, result)}
        />
      )}
      <CommandPalette
        open={commandPaletteOpen}
        projects={projects}
        threads={paletteThreads}
        workflows={workflows}
        projectActive={Boolean(activeProject)}
        onClose={() => setCommandPaletteOpen(false)}
        onProject={(project) => {
          setActiveProjectId(project.id);
          setWorkspaceMode("project");
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

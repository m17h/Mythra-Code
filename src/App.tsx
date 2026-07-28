import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Archive, ArchiveRestore, Bot, Check, ChevronDown, Circle, Code2, Command, Download, FileCode2, Folder, FolderOpen, GitBranch, LoaderCircle, MessageSquare, Paperclip, PanelRight, PanelLeftClose, PanelLeftOpen, Plus, Pin, PinOff, Pencil, Search, Settings, Shield, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, UsersRound, X } from "lucide-react";
import { getCodexRuntimeStatus, auditEvent, exportTextFile, getNormalChatWorkspace, hasOpenRouterKey, listOpenRouterModels, respond, restartRuntime, rpc, type CodexRuntimeStatus, type JsonObject } from "./lib/codex";
import { deleteClaudeTranscript, getClaudeRuntimeStatus, interruptClaudeTurn, isClaudeThreadBusyError, killClaudeTurn, loadClaudeTranscript, respondClaudeControlError, respondToClaudePermission, saveClaudeTranscript, startClaudeLogin, startClaudeTurn, steerClaudeTurn, type ClaudeRuntimeStatus } from "./lib/claude";
import { loadStored, storeValue } from "./lib/storage";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_PROMPT_PROFILES, DEFAULT_SETTINGS, THEMES } from "./lib/appConfig";
import { commandSandbox, threadResumeParams, threadRuntimeConfig, threadStartParams, turnStartParams } from "./lib/turnConfig";
import { threadSearchParams, threadsForWorkspace, type ThreadSearchResponse } from "./lib/threadSearch";
import { buildTurnInput, withoutSentAttachments } from "./lib/turnInput";
import { forgetSidebarThread, optimisticStartedThread, pruneSidebarIndex, reconcileWorkspaceThreads, rememberSidebarThread, sidebarThread, upsertThread, type ThreadSidebarIndex } from "./lib/threadList";
import { timelineFromTurns } from "./lib/threadTimeline";
import { buildTranscriptMarkdown } from "./lib/transcript";
import { RowMenu } from "./components/RowMenu";
import { type ReasoningEffort, ModelPowerControl, type RuntimeModel } from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import { ClaudeModelControl } from "./components/ClaudeModelControl";
import { ThreadProviderControl } from "./components/ThreadProviderControl";
import { ThreadInboxCard } from "./components/ThreadInboxCard";
import { ProjectPromptControl } from "./components/ProjectPromptControl";
import { ApprovalCenter } from "./components/ApprovalCenter";
import { Composer, type ComposerHandle } from "./components/Composer";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsModal } from "./components/SettingsModal";
import { AuthRequiredModal, RuntimeSetupModal } from "./components/RuntimeModals";
import type { AgentRecord, AttachmentRecord, McpView, StudioTab } from "./components/StudioDock";
import type { Account, Activity, AppSettings, ArchivedThread, ChatMessage, CustomAgentProfile, PendingApproval, PermissionMode, Project, ProjectAction, ProjectPromptMode, PromptProfile, Provider, ScheduledTask, ScheduleRunRecord, SettingsSection, Thread, Turn, ThemeName, WorkspaceMode } from "./types";
import { PendingTurnStarts, type PendingTurnStart } from "./lib/pendingTurnStarts";
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
import { OPENKIWI_COMPLETION_INSTRUCTIONS, withOpenKiwiCompletionInstructions } from "./lib/completionPrompt";
import { providerForArchivedThread } from "./lib/threadArchive";
import { deleteThreadTurnDurations } from "./lib/turnDurations";
import {
  checkpointIsRestorable,
  completeCheckpointSnapshot,
  createCheckpointSnapshot,
  deleteCheckpointSnapshot,
  readCheckpointDiff,
  restoreCheckpointSnapshot,
  type CheckpointHead,
  type CheckpointRecord,
  type CheckpointRestoreTarget,
} from "./lib/checkpoints";
import {
  applyWorktreeToSource,
  createThreadWorktree,
  executionPathForThread,
  mergeWorktreeBranch,
  recreateThreadWorktree,
  readWorkspaceGitInfo,
  readWorktreeStatus,
  removeThreadWorktree,
  type CreatedWorktree,
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
 * Subscribes to the streaming timeline itself so per-frame delta flushes stop
 * at this component boundary instead of re-rendering the entire App.
 */
function ConversationTimeline({ threadId, running, thinkingLabel, approval, provider, searchQuery, searchActiveMatch, onSearchMatches, onEditMessage, onApprovalRespond }: { threadId: string; running: boolean; thinkingLabel: string; approval: PendingApproval | null; provider: AppSettings["provider"]; searchQuery?: string; searchActiveMatch?: number; onSearchMatches?: (count: number) => void; onEditMessage: (text: string) => void; onApprovalRespond: (approval: PendingApproval, result: JsonObject) => void }) {
  const messages = useTaskStore((state) => state.tasks[threadId]?.messages ?? EMPTY_MESSAGES);
  const activities = useTaskStore((state) => state.tasks[threadId]?.activities ?? EMPTY_ACTIVITIES);
  // A thread change must create a fresh virtual scroller so its initial
  // position is applied to the newly selected conversation.
  return <ChatTimeline key={threadId} messages={messages} activities={activities} running={running} thinkingLabel={thinkingLabel} approval={approval} provider={provider} searchQuery={searchQuery} searchActiveMatch={searchActiveMatch} onSearchMatches={onSearchMatches} onEditMessage={onEditMessage} onApprovalRespond={onApprovalRespond} />;
}

export default function App() {
  const appUpdater = useAppUpdater();
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initialProjects[0]?.id ?? null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(initialWorkspaceMode);
  const [chatWorkspacePath, setChatWorkspacePath] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  // True only while a send with no active thread yet (a brand-new draft) is
  // creating its thread. Once a thread exists, its own task status carries
  // the starting/running state — never a global flag, so a start in one
  // thread cannot make another thread look busy.
  const [startingDraftTurn, setStartingDraftTurn] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [threadModels, setThreadModels] = useState<Record<string, string>>(() => loadStored("kiwi.threadModels", {}));
  const [draftThreadProvider, setDraftThreadProvider] = useState<Provider | null>(null);
  const [draftThreadModel, setDraftThreadModel] = useState<string | null>(null);
  const [draftThreadIsolated, setDraftThreadIsolated] = useState(false);
  const [threadWorktrees, setThreadWorktrees] = useState<Record<string, ThreadWorktreeRecord>>(() => loadStored("kiwi.threadWorktrees", {}));
  const threadWorktreesRef = useRef(threadWorktrees);
  const [workspaceGitInfo, setWorkspaceGitInfo] = useState<WorkspaceGitInfo | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<WorktreeStatus | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
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
  const checkpointsRef = useRef(checkpoints);
  const [checkpointHeads, setCheckpointHeads] = useState<Record<string, CheckpointHead>>(() => loadStored("kiwi.checkpointHeads", {}));
  const checkpointHeadsRef = useRef(checkpointHeads);
  const activeRunCheckpointsRef = useRef(new Map<string, string>());
  const checkpointProjectQueuesRef = useRef(new Map<string, Promise<void>>());
  const checkpointUnsupportedPathsRef = useRef(new Set<string>());
  const [checkpointBusyId, setCheckpointBusyId] = useState<string | null>(null);
  const [checkpointPreview, setCheckpointPreview] = useState<{ id: string; diff: string } | null>(null);
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
  const pendingTurnStartsRef = useRef(new PendingTurnStarts());
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
  const activeThreadWorktree = activeThreadId ? threadWorktrees[activeThreadId] : undefined;
  const activeExecutionPath = activeWorkspace
    ? executionPathForThread(activeThreadId, activeWorkspace.path, threadWorktrees)
    : "";
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
  const running = activeThreadId ? taskStatus === "starting" || taskStatus === "running" : startingDraftTurn;
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

  const persistThreadWorktrees = useCallback((
    update: (current: Record<string, ThreadWorktreeRecord>) => Record<string, ThreadWorktreeRecord>,
  ) => {
    const next = update(threadWorktreesRef.current);
    threadWorktreesRef.current = next;
    setThreadWorktrees(next);
    storeValue("kiwi.threadWorktrees", next);
  }, []);

  const executionPathFor = useCallback((threadId: string | null | undefined, logicalPath: string) => (
    executionPathForThread(threadId, logicalPath, threadWorktreesRef.current)
  ), []);

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

  const persistCheckpoints = useCallback((update: (current: CheckpointRecord[]) => CheckpointRecord[]) => {
    const next = update(checkpointsRef.current);
    checkpointsRef.current = next;
    setCheckpoints(next);
    storeValue("kiwi.checkpoints", next);
  }, []);

  const persistCheckpointHead = useCallback((workspacePath: string, head: CheckpointHead | null) => {
    const key = normalizedProjectPath(workspacePath);
    const next = { ...checkpointHeadsRef.current };
    if (head) next[key] = head;
    else delete next[key];
    checkpointHeadsRef.current = next;
    setCheckpointHeads(next);
    storeValue("kiwi.checkpointHeads", next);
  }, []);

  const runCheckpointProjectOperation = useCallback(async <T,>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = normalizedProjectPath(workspacePath);
    const previous = checkpointProjectQueuesRef.current.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    checkpointProjectQueuesRef.current.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (checkpointProjectQueuesRef.current.get(key) === tail) {
        checkpointProjectQueuesRef.current.delete(key);
      }
    }
  }, []);

  const beginRunCheckpoint = useCallback(async (
    threadId: string,
    workspacePath: string,
    prompt: string,
    provider: Provider,
    model: string,
  ): Promise<string | undefined> => {
    const pathKey = normalizedProjectPath(workspacePath);
    if (
      (chatWorkspacePath && pathKey === normalizedProjectPath(chatWorkspacePath))
      || checkpointUnsupportedPathsRef.current.has(pathKey)
    ) return undefined;
    const id = crypto.randomUUID();
    const parent = checkpointHeadsRef.current[pathKey];
    const taskState = useTaskStore.getState();
    const overlappingRun = Object.entries(taskState.statuses).some(([candidateId, taskStatus]) => {
      if (candidateId === threadId || (taskStatus !== "starting" && taskStatus !== "running")) return false;
      const binding = taskState.tasks[candidateId]?.workspacePath
        ?? threadProjectBindingsRef.current?.[candidateId];
      return Boolean(binding && normalizedProjectPath(binding) === pathKey);
    });
    const label = prompt.trim()
      ? `Run: ${prompt.trim().replace(/\s+/g, " ").slice(0, 72)}`
      : "Model run";
    const checkpoint: CheckpointRecord = {
      id,
      threadId,
      workspacePath,
      threadLabel: knownThreadsRef.current?.[threadId]?.name || knownThreadsRef.current?.[threadId]?.preview || prompt.slice(0, 72),
      provider,
      model,
      label,
      createdAt: Date.now(),
      status: "running",
      parentId: parent?.checkpointId,
      parentPosition: parent?.position,
      overlappingRun,
    };
    persistCheckpoints((current) => [
      checkpoint,
      ...current.map((entry) => (
        overlappingRun
        && entry.status === "running"
        && entry.workspacePath
        && normalizedProjectPath(entry.workspacePath) === pathKey
          ? { ...entry, overlappingRun: true }
          : entry
      )),
    ]);
    try {
      const snapshot = await runCheckpointProjectOperation(
        workspacePath,
        () => createCheckpointSnapshot(id, workspacePath, `${label} · before`),
      );
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        repoRoot: snapshot.repoRoot,
        beforeCommit: snapshot.commit,
        fileCount: snapshot.fileCount,
        branch: snapshot.branch ?? undefined,
        head: snapshot.head ?? undefined,
      } : entry));
      activeRunCheckpointsRef.current.set(threadId, id);
      return id;
    } catch (reason) {
      const message = friendlyError(reason);
      persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
      void deleteCheckpointSnapshot(id, workspacePath).catch(() => undefined);
      if (/Checkpoints (?:currently )?require/i.test(message)) {
        checkpointUnsupportedPathsRef.current.add(pathKey);
        useTaskStore.getState().upsertActivity(threadId, {
          id: `checkpoint-unavailable-${id}`,
          kind: "warning",
          title: "Automatic checkpoints unavailable",
          detail: `${message}. The model can still work, but OpenKiwi cannot create restorable file snapshots here.`,
        });
      } else {
        recordError(`Could not create the automatic checkpoint: ${message}`);
        useTaskStore.getState().upsertActivity(threadId, {
          id: `checkpoint-failed-${id}`,
          kind: "warning",
          title: "Automatic checkpoint failed",
          detail: message,
        });
      }
      return undefined;
    }
  }, [chatWorkspacePath, persistCheckpoints, runCheckpointProjectOperation]);

  const finalizeRunCheckpoint = useCallback(async (
    threadId: string,
    turnId?: string,
    completionStatus: "ready" | "interrupted" | "recovered" = "ready",
  ) => {
    const id = activeRunCheckpointsRef.current.get(threadId);
    if (!id) return;
    activeRunCheckpointsRef.current.delete(threadId);
    const checkpoint = checkpointsRef.current.find((entry) => entry.id === id);
    if (!checkpoint?.workspacePath) return;
    try {
      const result = await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => completeCheckpointSnapshot(id, checkpoint.workspacePath!, `${checkpoint.label} · completed`),
      );
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        turnId: turnId ?? entry.turnId,
        status: completionStatus,
        completedAt: Date.now(),
        afterCommit: result.snapshot.commit,
        fileCount: result.snapshot.fileCount,
        changedFiles: result.changedFiles,
        additions: result.additions,
        deletions: result.deletions,
      } : entry));
      persistCheckpointHead(checkpoint.workspacePath, { checkpointId: id, position: "after" });
    } catch (reason) {
      const message = friendlyError(reason);
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        status: "failed",
        completedAt: Date.now(),
        error: message,
      } : entry));
      recordError(`Could not finish checkpoint “${checkpoint.label}”: ${message}`);
    }
  }, [persistCheckpointHead, persistCheckpoints, runCheckpointProjectOperation]);

  const discardRunCheckpoint = useCallback((threadId: string) => {
    const id = activeRunCheckpointsRef.current.get(threadId);
    if (!id) return;
    activeRunCheckpointsRef.current.delete(threadId);
    const checkpoint = checkpointsRef.current.find((entry) => entry.id === id);
    persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
    if (checkpoint?.workspacePath) {
      void runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => deleteCheckpointSnapshot(id, checkpoint.workspacePath!),
      ).catch(() => undefined);
    }
  }, [persistCheckpoints, runCheckpointProjectOperation]);

  useEffect(() => {
    for (const checkpoint of checkpointsRef.current) {
      if (checkpoint.status === "running" && (!checkpoint.workspacePath || !checkpoint.beforeCommit)) {
        persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
          ...entry,
          status: "failed",
          completedAt: Date.now(),
          error: "OpenKiwi closed before the initial project snapshot finished.",
        } : entry));
        continue;
      }
      if (
        checkpoint.status !== "running"
        || !checkpoint.workspacePath
        || !checkpoint.beforeCommit
        || activeRunCheckpointsRef.current.has(checkpoint.threadId)
      ) {
        continue;
      }
      activeRunCheckpointsRef.current.set(checkpoint.threadId, checkpoint.id);
      void finalizeRunCheckpoint(checkpoint.threadId, checkpoint.turnId, "recovered");
    }
  }, [finalizeRunCheckpoint, persistCheckpoints]);

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
    [executeCommand],
  );

  const refreshDiff = useCallback(async () => {
    if (!activeProject || !activeThreadId || !activeExecutionPath) return;
    await refreshDiffFor(activeThreadId, activeExecutionPath);
  }, [activeExecutionPath, activeProject, activeThreadId, refreshDiffFor]);

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
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) {
        void refreshDiffFor(threadId, executionPathFor(threadId, projectPath));
      }
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
    // Invalidate any in-flight thread selection: a slow thread/resume issued
    // from the previous workspace must not re-install its thread here.
    selectThreadRequestRef.current += 1;
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
            void finalizeRunCheckpoint(threadId, undefined, "interrupted");
          }
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
    const isolatedCount = Object.values(threadWorktreesRef.current).filter(
      (record) => normalizedProjectPath(record.projectPath) === normalizedProjectPath(project.path)
        && record.status !== "removed",
    ).length;
    if (isolatedCount > 0) {
      setError(`Clean up the ${isolatedCount} isolated worktree${isolatedCount === 1 ? "" : "s"} in this project before removing it from OpenKiwi.`);
      return;
    }
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
    setDraftThreadIsolated(false);
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
      const provider = providerFromThread(thread, settings.provider);
      const projectModel = activeProject?.overrides?.model ?? settings.model;
      const threadProviderSettings: AppSettings = { ...effectiveSettings, provider, model: modelForProvider(provider, threadModels[thread.id] ?? projectModel) };
      const result = isolation?.status === "missing" || isolation?.status === "removed"
        ? await rpc<{ thread: Thread }>("thread/read", { threadId: thread.id, includeTurns: true })
        : await rpc<{ thread: Thread }>("thread/resume", threadResumeParams(threadProviderSettings, thread.id, executionPath, { customAgents, modelContextWindow: provider === "openrouter" ? openRouterModels.find((entry) => entry.id === threadProviderSettings.model)?.context_length : undefined, additionalWorkspaceRoots: isolation?.gitDir ? [isolation.gitDir] : [] }));
      if (selectThreadRequestRef.current !== requestId) return;
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
    setDraftThreadIsolated(false);
    setError(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  // Returns true when the message was delivered; the Composer restores its
  // draft when it was not.
  const sendMessage = async (text: string): Promise<boolean> => {
    if (!text || !activeWorkspace) return false;
    const currentIsolation = activeThread ? threadWorktreesRef.current[activeThread.id] : undefined;
    if (currentIsolation && worktreeBusy) {
      setError("Wait for the isolated worktree operation to finish before starting another model turn.");
      return false;
    }
    if (currentIsolation?.status === "missing" || currentIsolation?.status === "removed") {
      setError("This thread's isolated worktree is unavailable. Recreate it or explicitly continue in the shared project before sending another message.");
      return false;
    }
    if (!activeThread && draftThreadIsolated && (!workspaceGitInfo?.isRepo || !workspaceGitInfo.isRoot || !workspaceGitInfo.hasCommit)) {
      setError("Isolated threads require a Git repository root with at least one commit.");
      return false;
    }
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

    const willUseSharedFolder = !currentIsolation && !(draftThreadIsolated && !activeThread);
    if (willUseSharedFolder) {
      const sharedPath = normalizedProjectPath(activeWorkspace.path);
      const taskState = useTaskStore.getState();
      const anotherSharedRun = Object.entries(taskState.statuses).some(([threadId, threadStatus]) => {
        if (threadId === activeThread?.id || (threadStatus !== "starting" && threadStatus !== "running")) return false;
        const logicalPath = threadProjectBindingsRef.current?.[threadId];
        const executionPath = taskState.tasks[threadId]?.workspacePath
          ?? (logicalPath ? executionPathFor(threadId, logicalPath) : undefined);
        return Boolean(executionPath && normalizedProjectPath(executionPath) === sharedPath);
      });
      if (anotherSharedRun && !window.confirm(
        "Another thread is already working in this shared project folder.\n\nBoth models can edit the same files at the same time. Continue anyway, or cancel and start this as an isolated worktree instead?",
      )) return false;
    }

    setError(null);
    let pendingStart: PendingTurnStart | undefined;
    // Mark the start synchronously, before the first await, so Stop and the
    // composer reflect it immediately — and only on the thread actually
    // starting. A send with no active thread yet is tracked by the draft
    // flag until the created thread's own status takes over.
    const startingThreadId = activeThread?.id;
    if (startingThreadId) {
      useTaskStore.getState().setTaskStatus(startingThreadId, "starting");
      pendingStart = pendingTurnStartsRef.current.begin(startingThreadId);
    } else {
      setStartingDraftTurn(true);
    }
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    let provisionalWorktree: CreatedWorktree | undefined;
    let provisionalPersisted = false;
    const sentAttachments = [...attachments];
    try {
      let executionPath = activeWorkspace.path;
      if (!activeThread && draftThreadIsolated && activeProject) {
        provisionalWorktree = await createThreadWorktree(activeProject.path, text);
        executionPath = provisionalWorktree.path;
      } else if (activeThread) {
        executionPath = executionPathFor(activeThread.id, activeWorkspace.path);
      }
      const isolationGitDir = provisionalWorktree?.gitDir ?? currentIsolation?.gitDir;
      const additionalWorkspaceRoots = isolationGitDir ? [isolationGitDir] : [];
      if (effectiveSettings.provider === "claude") {
        if (skillsFolder && !skillRuntimeRootRef.current) await refreshLocalSkills();
        let thread = activeThread;
        if (!thread) {
          thread = { id: crypto.randomUUID(), name: null, preview: text.slice(0, 140), cwd: executionPath, updatedAt: Math.floor(Date.now() / 1000), modelProvider: "claude" };
          startedThreadId = thread.id;
          bindThreadToProject(thread.id, activeWorkspace.path);
          if (provisionalWorktree && activeProject) {
            const record: ThreadWorktreeRecord = {
              threadId: thread.id,
              projectId: activeProject.id,
              projectPath: activeProject.path,
              path: provisionalWorktree.path,
              branch: provisionalWorktree.branch,
              baseCommit: provisionalWorktree.baseCommit,
              gitDir: provisionalWorktree.gitDir,
              createdAt: Date.now(),
              status: "active",
            };
            persistThreadWorktrees((current) => ({ ...current, [thread!.id]: record }));
            provisionalPersisted = true;
            setDraftThreadIsolated(false);
          }
          rememberThread(thread);
          persistThreadModel(thread.id, effectiveSettings.model);
          setThreads((current) => upsertThread(current, thread!));
          setActiveThread(thread);
          useTaskStore.getState().ensureTask(thread.id, executionPath);
          useTaskStore.getState().setActiveThread(thread.id);
        }
        startedThreadId = thread.id;
        const updatedThread = { ...thread, preview: text.slice(0, 140) || thread.preview, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
        useTaskStore.getState().ensureTask(thread.id, executionPath);
        useTaskStore.getState().setTaskStatus(thread.id, "starting");
        if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(thread.id);
        await beginRunCheckpoint(thread.id, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
        const canResumeClaude = Boolean(activeThread && useTaskStore.getState().tasks[thread.id]?.messages.some((message) => message.role === "assistant"));
        sentMessageId = `local-${crypto.randomUUID()}`;
        useTaskStore.getState().appendUserMessage(thread.id, { id: sentMessageId, role: "user", text });
        await saveClaudeTranscript({ thread: updatedThread, messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] });
        const result = await startClaudeTurn({ threadId: thread.id, cwd: executionPath, prompt: text, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: settings.ultra ? "ultra" : settings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: withOpenKiwiCompletionInstructions(effectiveSettings.systemPrompt), resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentsEnabled: settings.subagentsEnabled, subagentMax: settings.subagentMax, customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined });
        useTaskStore.getState().setActiveTurn(thread.id, result.turnId);
        useTaskStore.getState().setTaskStatus(thread.id, "running");
        setStartingDraftTurn(false);
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        if (pendingTurnStartsRef.current.finish(thread.id, pendingStart)) {
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
        const result = await rpc<{ thread: Thread }>("thread/start", threadStartParams(effectiveSettings, executionPath, { serviceName: activeWorkspace.isChat ? "OpenKiwi Chat" : "OpenKiwi", customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined, interactive: true, additionalWorkspaceRoots }));
        const startedThread = optimisticStartedThread(result.thread, text);
        threadId = startedThread.id;
        startedThreadId = threadId;
        bindThreadToProject(startedThread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record: ThreadWorktreeRecord = {
            threadId: startedThread.id,
            projectId: activeProject.id,
            projectPath: activeProject.path,
            path: provisionalWorktree.path,
            branch: provisionalWorktree.branch,
            baseCommit: provisionalWorktree.baseCommit,
            gitDir: provisionalWorktree.gitDir,
            createdAt: Date.now(),
            status: "active",
          };
          persistThreadWorktrees((current) => ({ ...current, [startedThread.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(startedThread);
        persistThreadModel(startedThread.id, effectiveSettings.model);
        setThreads((current) => upsertThread(current, startedThread));
        setActiveThread(startedThread);
        useTaskStore.getState().ensureTask(startedThread.id, executionPath);
        useTaskStore.getState().setActiveThread(startedThread.id);
      } else if (effectiveSettings.provider === "openrouter") {
        // Re-apply the isolated provider config before every subsequent turn.
        // This repairs a persisted thread after a compatibility refresh.
        await rpc("thread/resume", { ...threadResumeParams(effectiveSettings, threadId, executionPath, { customAgents, modelContextWindow: openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length, excludeTurns: true, additionalWorkspaceRoots }), model: effectiveSettings.model });
      }

      if (activeThread?.id === threadId) {
        const updatedThread = { ...activeThread, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        setThreads((current) => upsertThread(current, updatedThread));
        setActiveThread(updatedThread);
      }
      useTaskStore.getState().ensureTask(threadId, executionPath);
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(threadId);
      await beginRunCheckpoint(threadId, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(threadId, { id: sentMessageId, role: "user", text });

      const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(effectiveSettings, threadId, executionPath, input, additionalWorkspaceRoots));
      if (result.turn?.id) useTaskStore.getState().setActiveTurn(threadId, result.turn.id);
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (pendingTurnStartsRef.current.finish(threadId, pendingStart)) {
        // The user pressed stop while the turn was still starting.
        if (result.turn?.id) await rpc("turn/interrupt", { threadId, turnId: result.turn.id });
        useTaskStore.getState().setActiveTurn(threadId, undefined);
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setTransientStatus("Stopped");
      }
      return true;
    } catch (reason) {
      setStartingDraftTurn(false);
      // Use the locally captured thread ids: for a brand-new thread the
      // activeThread closure is still null here (which used to leave the
      // thread stuck in "starting" forever), and a failure before the send
      // resolved its thread must still clear the "starting" mark applied at
      // the top of this function.
      const failedThreadId = startedThreadId ?? startingThreadId;
      if (provisionalWorktree && activeProject && !provisionalPersisted) {
        void removeThreadWorktree(
          undefined,
          activeProject.path,
          provisionalWorktree.path,
          provisionalWorktree.branch,
          true,
          true,
        ).catch(() => undefined);
      }
      if (failedThreadId) {
        discardRunCheckpoint(failedThreadId);
        if (pendingStart) pendingTurnStartsRef.current.finish(failedThreadId, pendingStart);
        if (sentMessageId) useTaskStore.getState().removeMessage(failedThreadId, sentMessageId);
        useTaskStore.getState().setTaskStatus(failedThreadId, "error", friendlyError(reason));
        if (isClaudeThreadBusyError(reason)) {
          // The backend slot is held by a Claude process the UI no longer
          // tracks (e.g. after an event loss). Free it so a retry succeeds
          // instead of failing until OpenKiwi restarts.
          void killClaudeTurn(failedThreadId).catch(() => undefined);
        }
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
      // If this thread's turn/start RPC is still in flight, flag that exact
      // pending start so sendMessage interrupts the turn the moment its id is
      // known. When this thread has no start in flight (e.g. the user
      // navigated here while another thread was starting), there is nothing
      // to stop and no intent must be recorded.
      if (pendingTurnStartsRef.current.requestCancel(activeThread.id)) {
        setStatus("Stopping");
      }
      return;
    }
    try {
      if (isClaudeThread(activeThread)) await interruptClaudeTurn(activeThread.id);
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      useTaskStore.getState().setActiveTurn(activeThread.id, undefined);
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      setStartingDraftTurn(false);
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
    const taskStatus = useTaskStore.getState().statuses[thread.id];
    if (taskStatus === "starting" || taskStatus === "running") {
      setError(`Stop “${label}” before archiving it so its final output and transcript are preserved.`);
      return;
    }
    if (!window.confirm(`Archive “${label}”?\n\nIt moves to the Archived list in the sidebar, where you can restore or permanently delete it.`)) return;
    try {
      if (!isClaudeThread(thread)) await rpc("thread/archive", { threadId: thread.id });
      if (activeThread?.id === thread.id) newThread();
      forgetThread(thread.id);
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
    const isolation = threadWorktreesRef.current[threadId];
    if (isolation && isolation.status !== "removed") {
      setError(`Clean up “${isolation.branch}” from the Checkpoints workspace tab before permanently deleting this thread.`);
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
    const claude = provider === "claude";
    if (!window.confirm(`Permanently delete “${label}”?\n\nThis removes the conversation from ${claude ? "OpenKiwi" : "the Codex runtime"} and cannot be undone.`)) return;
    try {
      const saveTimer = claudeSaveTimersRef.current.get(threadId);
      if (saveTimer !== undefined) window.clearTimeout(saveTimer);
      claudeSaveTimersRef.current.delete(threadId);
      if (claude) await deleteClaudeTranscript(threadId);
      else await rpc("thread/delete", { threadId });
      if (activeThread?.id === threadId) newThread();
      forgetThread(threadId);
      forgetThreadModel(threadId);
      deleteThreadTurnDurations(threadId);
      setThreads((current) => current.filter((entry) => entry.id !== threadId));
      persistArchivedThreads((current) => current.filter((entry) => entry.id !== threadId));
      useTaskStore.getState().removeTask(threadId);
      setPinnedThreadIds((current) => {
        if (!current.includes(threadId)) return current;
        const next = current.filter((id) => id !== threadId);
        storeValue("kiwi.pinnedThreads", next);
        return next;
      });
      const deletedCheckpointIds = new Set(
        checkpointsRef.current
          .filter((checkpoint) => checkpoint.threadId === threadId)
          .map((checkpoint) => checkpoint.id),
      );
      for (const [path, head] of Object.entries(checkpointHeadsRef.current)) {
        if (deletedCheckpointIds.has(head.checkpointId)) persistCheckpointHead(path, null);
      }
      const deletedCheckpoints = checkpointsRef.current.filter((checkpoint) => checkpoint.threadId === threadId);
      for (const checkpoint of deletedCheckpoints) {
        if (checkpoint.workspacePath) {
          void runCheckpointProjectOperation(
            checkpoint.workspacePath,
            () => deleteCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!),
          ).catch(() => undefined);
        }
      }
      persistCheckpoints((current) => current.filter((checkpoint) => checkpoint.threadId !== threadId));
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

  const captureCurrentStateCheckpoint = async ({
    threadId,
    workspacePath,
    label,
    status = "ready",
    restoredFromId,
    serialize = true,
  }: {
    threadId: string;
    workspacePath: string;
    label: string;
    status?: CheckpointRecord["status"];
    restoredFromId?: string;
    serialize?: boolean;
  }): Promise<CheckpointRecord> => {
    const id = crypto.randomUUID();
    const pathKey = normalizedProjectPath(workspacePath);
    const parent = checkpointHeadsRef.current[pathKey];
    const thread = knownThreadsRef.current?.[threadId];
    const checkpoint: CheckpointRecord = {
      id,
      threadId,
      workspacePath,
      threadLabel: thread?.name || thread?.preview || "Project state",
      provider: providerFromThread(thread, settings.provider),
      model: threadModels[threadId],
      label,
      createdAt: Date.now(),
      status: "running",
      parentId: parent?.checkpointId,
      parentPosition: parent?.position,
      restoredFromId,
    };
    persistCheckpoints((current) => [checkpoint, ...current]);
    const capture = async () => {
      const before = await createCheckpointSnapshot(id, workspacePath, `${label} · saved`);
      const after = await completeCheckpointSnapshot(id, workspacePath, `${label} · saved`);
      const completed: CheckpointRecord = {
        ...checkpoint,
        repoRoot: before.repoRoot,
        beforeCommit: before.commit,
        afterCommit: after.snapshot.commit,
        branch: before.branch ?? undefined,
        head: before.head ?? undefined,
        fileCount: after.snapshot.fileCount,
        changedFiles: after.changedFiles,
        additions: after.additions,
        deletions: after.deletions,
        status,
        completedAt: Date.now(),
      };
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? completed : entry));
      return completed;
    };
    try {
      return serialize
        ? await runCheckpointProjectOperation(workspacePath, capture)
        : await capture();
    } catch (reason) {
      persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
      void deleteCheckpointSnapshot(id, workspacePath).catch(() => undefined);
      throw reason;
    }
  };

  const createCheckpoint = async () => {
    if (!activeThread || !activeProject) return;
    if (projectHasActiveTask(activeExecutionPath)) {
      setError("Wait for active tasks in this project to finish before saving a manual checkpoint.");
      return;
    }
    setCheckpointBusyId("manual");
    try {
      const count = checkpointsRef.current.filter((item) => normalizedProjectPath(item.workspacePath ?? "") === normalizedProjectPath(activeExecutionPath)).length + 1;
      const checkpoint = await captureCurrentStateCheckpoint({
        threadId: activeThread.id,
        workspacePath: activeExecutionPath,
        label: `Manual checkpoint ${count}`,
      });
      persistCheckpointHead(activeExecutionPath, { checkpointId: checkpoint.id, position: "after" });
      setTransientStatus("Checkpoint saved");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  };

  const projectHasActiveTask = (workspacePath: string): boolean => {
    const target = normalizedProjectPath(workspacePath);
    if (checkpointProjectQueuesRef.current.has(target)) return true;
    const state = useTaskStore.getState();
    return Object.entries(state.statuses).some(([threadId, taskStatus]) => {
      if (taskStatus !== "starting" && taskStatus !== "running") return false;
      const binding = threadProjectBindingsRef.current?.[threadId];
      const executionPath = state.tasks[threadId]?.workspacePath;
      return Boolean(
        (binding && normalizedProjectPath(binding) === target)
        || (executionPath && normalizedProjectPath(executionPath) === target),
      );
    });
  };

  const restoreCheckpoint = async (checkpoint: CheckpointRecord, target: CheckpointRestoreTarget) => {
    if (!checkpoint.workspacePath || !checkpointIsRestorable(checkpoint, target)) {
      setError("This older conversation marker does not contain a restorable file snapshot.");
      return;
    }
    if (projectHasActiveTask(checkpoint.workspacePath)) {
      setError("Stop every active task in this project before restoring a checkpoint.");
      return;
    }
    const action = target === "before"
      ? `restore the project to before “${checkpoint.label}”`
      : `restore the completed state of “${checkpoint.label}”`;
    if (!window.confirm(
      `Are you sure you want to ${action}?\n\n`
      + "The complete project source state will move to that point. Later work will leave the active folder, but OpenKiwi will save the current state as a new safety checkpoint first. Git commits and ignored files are not changed.",
    )) return;

    setCheckpointBusyId(checkpoint.id);
    let safetyId: string | null = null;
    try {
      await runCheckpointProjectOperation(checkpoint.workspacePath, async () => {
        const safety = await captureCurrentStateCheckpoint({
          threadId: activeThread?.id ?? checkpoint.threadId,
          workspacePath: checkpoint.workspacePath!,
          label: `Safety copy before restoring ${checkpoint.label}`,
          status: "safety",
          restoredFromId: checkpoint.id,
          serialize: false,
        });
        safetyId = safety.id;
        await restoreCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!, target, safety.id);
      });
      persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
        ...entry,
        status: target === "before" ? "restored-before" : "restored-after",
      } : entry));
      persistCheckpointHead(checkpoint.workspacePath, { checkpointId: checkpoint.id, position: target });
      setCheckpointPreview(null);
      if (activeThreadId && normalizedProjectPath(activeExecutionPath) === normalizedProjectPath(checkpoint.workspacePath)) {
        await refreshDiffFor(activeThreadId, activeExecutionPath);
      }
      setTransientStatus(target === "before" ? "Restored before run" : "Completed state restored");
    } catch (reason) {
      if (safetyId) persistCheckpointHead(checkpoint.workspacePath, { checkpointId: safetyId, position: "after" });
      setError(`Checkpoint restore stopped: ${friendlyError(reason)}${safetyId ? " Your pre-restore safety copy is available in Checkpoints." : ""}`);
    } finally {
      setCheckpointBusyId(null);
    }
  };

  const toggleCheckpointAccepted = (checkpoint: CheckpointRecord) => {
    persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
      ...entry,
      accepted: !entry.accepted,
    } : entry));
    setTransientStatus(checkpoint.accepted ? "Acceptance undone" : "Checkpoint accepted");
  };

  const previewCheckpoint = async (checkpoint: CheckpointRecord) => {
    if (!checkpoint.workspacePath || !checkpoint.afterCommit) {
      setError("This checkpoint does not have a completed file snapshot to preview.");
      return;
    }
    if (checkpointPreview?.id === checkpoint.id) {
      setCheckpointPreview(null);
      return;
    }
    setCheckpointBusyId(checkpoint.id);
    try {
      const diff = await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => readCheckpointDiff(checkpoint.id, checkpoint.workspacePath!),
      );
      setCheckpointPreview({ id: checkpoint.id, diff });
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  };

  const removeCheckpoint = async (checkpoint: CheckpointRecord) => {
    if (!checkpoint.workspacePath) {
      persistCheckpoints((current) => current.filter((entry) => entry.id !== checkpoint.id));
      return;
    }
    if (checkpoint.status === "running") {
      setError("Wait for this run to finish before deleting its checkpoint.");
      return;
    }
    if (!window.confirm(`Delete “${checkpoint.label}”?\n\nIts saved file states will no longer be restorable. Your current files and Git history will not change.`)) return;
    setCheckpointBusyId(checkpoint.id);
    try {
      await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => deleteCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!),
      );
      persistCheckpoints((current) => current.filter((entry) => entry.id !== checkpoint.id));
      const pathKey = normalizedProjectPath(checkpoint.workspacePath);
      if (checkpointHeadsRef.current[pathKey]?.checkpointId === checkpoint.id) {
        persistCheckpointHead(checkpoint.workspacePath, null);
      }
      if (checkpointPreview?.id === checkpoint.id) setCheckpointPreview(null);
      setTransientStatus("Checkpoint deleted");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  };

  const forkThread = async (checkpoint?: CheckpointRecord) => {
    if (!activeThread) return;
    if (activeThreadWorktree && activeThreadWorktree.status !== "removed") {
      setError(
        "Forking an isolated conversation is not available yet because two threads must not silently share one worktree. Apply or merge its changes, clean it up, and continue from the shared project first.",
      );
      return;
    }
    try {
      await ensureSkillRoots();
      const result = await rpc<{ thread: Thread }>("thread/fork", { threadId: checkpoint?.threadId ?? activeThread.id, lastTurnId: checkpoint?.turnId, cwd: activeWorkspace?.path, runtimeWorkspaceRoots: activeWorkspace ? [activeWorkspace.path] : undefined, model: effectiveSettings.model, modelProvider: effectiveSettings.provider === "openrouter" ? "openrouter" : undefined, config: threadRuntimeConfig(effectiveSettings, { customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : undefined }), baseInstructions: effectiveSettings.systemPrompt, developerInstructions: OPENKIWI_COMPLETION_INSTRUCTIONS });
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

  const cleanupActiveWorktree = async () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (projectHasActiveTask(activeThreadWorktree.path) || projectHasActiveTask(activeThreadWorktree.projectPath)) {
      setError("Wait for active tasks in the isolated worktree and source project before cleaning it up.");
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
          ? `Permanently delete this isolated worktree and branch?\n\nIt contains ${details}. Those worktree-only files and commits will be permanently deleted. The shared project is not changed.`
          : `Delete this isolated worktree and its branch?\n\nThe shared project and conversation remain available. This thread must be explicitly switched to shared mode before it can run again.`,
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
              error: "The isolated worktree was cleaned up; this historical checkpoint is no longer restorable.",
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
      setTransientStatus("Isolated worktree cleaned up");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setWorktreeBusy(false);
    }
  };

  const continueThreadInSharedProject = () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (activeThreadWorktree.status === "missing") {
      setError("Recreate the missing worktree from its branch, then clean it up before continuing this conversation in the shared project.");
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

  const runGitAction = async (action: "status" | "diff" | "stage" | "revert" | "commit" | "comments" | "ci" | "pr") => {
    if (!activeProject) return;
    const commandPath = activeExecutionPath || activeProject.path;
    const gitRoots = activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : [];
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
      const result = await executeCommand(command, commandPath, gitRoots);
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
      const result = await executeCommand(["/bin/zsh", "-lc", action.command], activeExecutionPath || activeProject.path, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
      terminal.append(`${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`);
      void auditEvent("action.completed", { actionId: action.id, command: action.command, exitCode: result.exitCode }, activeThreadId ?? undefined).catch(() => {});
    } catch (reason) {
      terminal.append(`${friendlyError(reason)}\n`);
    }
  };

  const runGitPathAction = async (action: "stage" | "revert", path: string) => {
    if (!activeProject) return;
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
      {/* While Settings or Onboarding is open, the content behind the dialog
          is inert so keyboard and assistive-tech focus cannot reach it. The
          studio dock and remaining modals are covered by the full-screen
          backdrop and each dialog's own focus containment. */}
      <aside inert={settingsOpen || onboardingOpen ? true : undefined} className={`sidebar ${sidebarOpen ? "open" : "closed"}`} style={sidebarOpen ? { flexBasis: paneSizes.sidebar, width: paneSizes.sidebar } : undefined}>
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
                <GitBranch size={12} /> Isolated
              </button>
            )}
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
                  {!activeWorkspace.isChat && !activeThread && (
                    <div className="isolation-choice" aria-label="Thread workspace mode">
                      <button className={!draftThreadIsolated ? "active" : ""} onClick={() => setDraftThreadIsolated(false)}>
                        <Folder size={15} />
                        <span><strong>Shared project</strong><small>Work directly in {activeProject?.name}</small></span>
                      </button>
                      <button
                        className={draftThreadIsolated ? "active" : ""}
                        onClick={() => setDraftThreadIsolated(true)}
                        disabled={!workspaceGitInfo?.isRepo || !workspaceGitInfo.isRoot || !workspaceGitInfo.hasCommit}
                        title={!workspaceGitInfo?.isRepo || !workspaceGitInfo.isRoot || !workspaceGitInfo.hasCommit ? "Requires a Git repository root with at least one commit" : "Create a private branch and worktree for this thread"}
                      >
                        <GitBranch size={15} />
                        <span><strong>Isolated worktree</strong><small>Private branch; apply or merge when ready</small></span>
                      </button>
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
            onWorktreeCleanup={() => void cleanupActiveWorktree()}
            onWorktreeRecreate={() => void recreateActiveWorktree()}
            onWorktreeContinueShared={continueThreadInSharedProject}
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

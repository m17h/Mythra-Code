import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Archive, ArchiveRestore, Bot, Check, ChevronDown, Circle, Code2, Download, FileCode2, Folder, FolderOpen, Gauge, GitBranch, GitFork, LoaderCircle, MessageSquare, Paperclip, PanelRight, PanelLeftClose, PanelLeftOpen, Plus, Pin, PinOff, Pencil, Search, Settings, Shield, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, X } from "lucide-react";
import { getCodexRuntimeStatus, auditEvent, exportTextFile, getNormalChatWorkspace, getOpenRouterCredits, hasLmStudioKey, hasOpenRouterKey, respond, restartRuntime, rpc, runtimeInstanceId, type CodexRuntimeStatus, type JsonObject, type OpenRouterCreditBalance } from "./lib/codex";
import { deleteClaudeTranscript, getClaudeRateLimits, getClaudeRuntimeStatus, listClaudeModels, loadClaudeTranscript, respondClaudeControlError, respondToClaudePermission, saveClaudeTranscript, startClaudeLogin, type ClaudeModel, type ClaudeRuntimeStatus } from "./lib/claude";
import { deleteCursorTranscript, getCursorRuntimeStatus, listCursorModels, loadCursorTranscript, respondToCursorPermission, saveCursorTranscript, startCursorLogin, type CursorModel, type CursorRuntimeStatus } from "./lib/cursor";
import { loadStored, storeValue } from "./lib/storage";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_LM_STUDIO_BASE_URL, DEFAULT_OPENAI_MODEL, DEFAULT_PROMPT_PROFILES, DEFAULT_SETTINGS, sanitizeAutoArchiveSubagentThreads, sanitizeEffortSlider, sanitizeTheme, themeColorScheme } from "./lib/appConfig";
import { commandSandbox, threadResumeParams, threadRuntimeConfig } from "./lib/turnConfig";
import { threadSearchParams, threadsForWorkspace, type ThreadSearchResponse } from "./lib/threadSearch";
import { countActiveThreadsByWorkspace, filterThreadsByKind, filterThreadsForWorkspace, forgetSidebarThread, isSubAgentThread, partitionBulkArchiveThreads, pruneSidebarIndex, reconcileWorkspaceThreads, rememberSidebarThread, repairRootThreadMetadata, sidebarThread, threadBelongsToWorkspace, upsertThread, type ThreadSidebarIndex } from "./lib/threadList";
import { timelineFromTurns } from "./lib/threadTimeline";
import { INITIAL_THREAD_TURN_LIMIT, OLDER_THREAD_TURN_LIMIT, isPaginatedHistoryUnsupported, normalizeThreadTurnsPage, turnsFromDescendingPage, type ThreadHistoryState } from "./lib/threadHistory";
import { buildTranscriptMarkdown } from "./lib/transcript";
import { RowMenu } from "./components/RowMenu";
import { Odometer } from "./components/Odometer";
import { confirmDialog } from "./lib/confirmDialog";
import { ConfirmDialogModal } from "./components/ConfirmDialogModal";
import { ModelPowerControl, type RuntimeModel } from "./components/ModelPowerControl";
import { OpenRouterModelControl, type OpenRouterModel } from "./components/OpenRouterModelControl";
import { ClaudeModelControl } from "./components/ClaudeModelControl";
import { CursorModelControl } from "./components/CursorModelControl";
import { LMStudioModelControl } from "./components/LMStudioModelControl";
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
import type { AgentRecord, AttachmentRecord, McpView } from "./components/StudioDock";
import { isStudioTab, type StudioTab } from "./lib/studioTabs";
import type { GitPanelAction, GitRepositoryState } from "./components/GitPanel";
import type { Account, Activity, AppSettings, ArchivedThread, ChatMessage, CustomAgentProfile, PendingApproval, PermissionMode, Project, ProjectAction, ProjectPromptMode, ProjectSubagentSettings, EffortSliderStyle, PromptProfile, Provider, ScheduledTask, ScheduleRunRecord, SettingsSection, Thread, ThreadHandoff, ThreadReasoning, ThemeName, WorkspaceMode } from "./types";
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
  type GitHubAccountStatus,
  type GitHubRepoStatus,
} from "./lib/github";
import { useAppUpdater } from "./lib/appUpdater";
import { usePersistedState, usePersistedStateRef } from "./hooks/usePersistedState";
import { forgetQueuedDeliveries, useTurnRunner } from "./hooks/useTurnRunner";
import { useCheckpoints } from "./hooks/useCheckpoints";
import { useAppShortcuts, workspaceShortcutLabel } from "./hooks/useAppShortcuts";
import { useThreadHealth } from "./hooks/useThreadHealth";
import { useCodexEvents } from "./hooks/useCodexEvents";
import { useClaudeEvents } from "./hooks/useClaudeEvents";
import { useCursorEvents } from "./hooks/useCursorEvents";
import { useScheduler } from "./hooks/useScheduler";
import { useTerminal } from "./hooks/useTerminal";
import { PANE_BOUNDS, usePaneResize } from "./hooks/usePaneResize";
import { useSidebarSplitResize } from "./hooks/useSidebarSplitResize";
import { useWorkflowEngine } from "./hooks/useWorkflowEngine";
import { isEstablishedMythraCodeInstall, ONBOARDING_EXIT_MS, ONBOARDING_VERSION } from "./lib/onboarding";
import { createLocalSkill, deleteLocalSkill, importLocalSkills, normalizeSkillName, readLocalSkill, resolveLocalSkills, scanLocalSkills, syncLocalSkills, updateLocalSkill, type LocalSkill, type LocalSkillFile } from "./lib/skills";
import { compactWorkflowRun, normalizeWorkflows, recoverWorkflowRuns, type WorkflowDefinition, type WorkflowRunRecord } from "./lib/workflows";
import { isClaudeThread, isCursorThread, isLocalSubscriptionThread, modelForProvider, providerFromThread } from "./lib/threadProvider";
import { listLMStudioModels, type LMStudioModel } from "./lib/lmStudio";
import { EMPTY_MODEL_FAVORITES, MODEL_FAVORITES_KEY, favoriteModels, sanitizeModelFavorites, toggleFavoriteModel, type ModelFavorites } from "./lib/modelFavorites";
import { fetchOpenRouterCatalog, mergeOpenRouterModels, resolveOpenRouterSlug } from "./lib/openRouterCatalog";
import { basename, joinPath, normalizedProjectPath } from "./lib/paths";
import { attachmentRecord, withAttachedPaths } from "./lib/attachments";
import { attachmentsFor, forgetAttachmentDraft, withAttachmentDraft, type AttachmentDrafts } from "./lib/attachmentDrafts";
import { EMPTY_REVIEW_DIFF } from "./lib/gitDiff";
import { shellCommand } from "./lib/shellCommand";
import { resolveProviderSystemPrompt, resolveSystemPrompt } from "./lib/systemPrompt";
import { parseCodexRateLimits, providerAccountUsage, providerHeaderUsage, sanitizeUsageDisplay, type ProviderRateLimits } from "./lib/providerUsage";
import { contextUsagePercent } from "./lib/contextUsage";
import { mythraCodeDeveloperInstructions } from "./lib/completionPrompt";
import { runtimeModelProviderId } from "./lib/providerIds";
import { primaryModifierLabel } from "./lib/platform";
import { archivedThreadsForInbox, providerForArchivedThread } from "./lib/threadArchive";
import { sanitizeProjectDefaultOverrides } from "./lib/projectDefaults";
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
  sanitizeChildAgentPresets,
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
import { cacheChildAgentPolicy, ensureChildAgentBridge, invalidateChildAgentLaunch, releaseChildAgentSession, releaseChildAgentSessions } from "./lib/childAgentSessions";
import { forgetSubagentCapabilities, planSubagentCapabilities, recordSubagentCapabilities, subagentCapabilitySignature } from "./lib/threadCapabilities";
import { canOwnThread, nativeAgentLinkFromThread, nativeAgentLinksAfterThreadDeletion, sanitizeNativeAgentLinks, type NativeAgentLink, type OwnershipLinks } from "./lib/nativeAgentLinks";
import { autoArchiveSubagentCandidates } from "./lib/subAgentArchive";
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
const DEFAULT_GIT_COMMIT_MESSAGE = "Update project files";
/** Enough to name what is missing from a diff without pasting a build tree. */
const MAX_LISTED_UNTRACKED_PATHS = 50;
const COMPOSER_REASONING_EFFORTS: ThreadReasoning["reasoningEffort"][] = ["low", "medium", "high", "xhigh", "max"];

interface LoadedThreadHistory {
  thread: Thread;
  turns: NonNullable<Thread["turns"]>;
  history: ThreadHistoryState;
}

let paginatedHistoryUnavailable = false;

class MalformedThreadHistoryPageError extends Error {}

/**
 * Load only a recent Codex window. Installed app-server versions are not
 * upgraded in lockstep with Mythra Code, so the established full-read path is
 * retained as a compatibility fallback instead of making history fragile.
 */
async function loadThreadHistory(
  method: "thread/read" | "thread/resume",
  params: JsonObject,
  fallbackParams: JsonObject,
): Promise<LoadedThreadHistory> {
  const fallback = async (): Promise<LoadedThreadHistory> => {
    const result = await rpc<{ thread: Thread }>(method, fallbackParams);
    return {
      thread: sidebarThread(result.thread),
      turns: result.thread.turns ?? [],
      history: { nextCursor: null, hasMore: false, loading: false, paginated: false },
    };
  };
  if (paginatedHistoryUnavailable) return fallback();
  try {
    const result = await rpc<{ thread: Thread; initialTurnsPage?: unknown }>(method, {
      ...params,
      ...(method === "thread/resume" ? {
        excludeTurns: true,
        initialTurnsPage: { limit: INITIAL_THREAD_TURN_LIMIT, sortDirection: "desc", itemsView: "full" },
      } : {}),
    });
    let page = normalizeThreadTurnsPage(result.initialTurnsPage);
    if (!page) {
      page = normalizeThreadTurnsPage(await rpc<unknown>("thread/turns/list", {
        threadId: result.thread.id,
        limit: INITIAL_THREAD_TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      }));
    }
    if (!page) throw new MalformedThreadHistoryPageError("Paginated thread history returned a malformed page");
    return {
      thread: sidebarThread(result.thread),
      turns: turnsFromDescendingPage(page),
      history: { nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor), loading: false, paginated: true },
    };
  } catch (reason) {
    if (reason instanceof MalformedThreadHistoryPageError) return fallback();
    if (!isPaginatedHistoryUnsupported(reason)) throw reason;
    paginatedHistoryUnavailable = true;
    return fallback();
  }
}

function sanitizeComposerReasoningEffort(
  value: unknown,
  fallback: ThreadReasoning["reasoningEffort"] = DEFAULT_SETTINGS.reasoningEffort,
): ThreadReasoning["reasoningEffort"] {
  if (value === "ultra") return "max";
  return COMPOSER_REASONING_EFFORTS.includes(value as ThreadReasoning["reasoningEffort"])
    ? value as ThreadReasoning["reasoningEffort"]
    : fallback;
}

function sanitizeThreadReasoningRecords(value: unknown): Record<string, ThreadReasoning> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([threadId, reasoning]) => {
    if (!reasoning || typeof reasoning !== "object") return [];
    const rawEffort = (reasoning as Partial<ThreadReasoning>).reasoningEffort;
    if (typeof rawEffort !== "string" || (rawEffort !== "ultra" && !COMPOSER_REASONING_EFFORTS.includes(rawEffort as ThreadReasoning["reasoningEffort"]))) return [];
    return [[threadId, { reasoningEffort: sanitizeComposerReasoningEffort(rawEffort), ultra: false }]];
  }));
}

const initialProjects = sanitizeProjectDefaultOverrides(sanitizeProjectSubagentOverrides(loadStored<Project[]>("kiwi.projects", [])));
const initialWorkspaceMode: WorkspaceMode = loadStored<WorkspaceMode>("kiwi.workspaceMode", initialProjects.length ? "project" : "chat");
const initialKnownThreads = pruneSidebarIndex(loadStored<ThreadSidebarIndex>("kiwi.knownThreads", {}));
const initialOnboardingVersion = loadStored<number>("kiwi.onboardingVersion", 0);
const establishedInstall = isEstablishedMythraCodeInstall({ projects: initialProjects.length, knownThreads: Object.keys(initialKnownThreads).length, hasStoredSettings: localStorage.getItem("kiwi.settings") !== null, hasSkillsFolder: Boolean(loadStored<string>("kiwi.skillsFolder", "")) });
const initialOnboardingOpen = initialOnboardingVersion < ONBOARDING_VERSION && !establishedInstall;
const storedSettings = loadStored<Partial<AppSettings>>("kiwi.settings", {});
const initialChildAgents = sanitizeChildAgentSettings(storedSettings.childAgents);
const initialSettings: AppSettings = { ...DEFAULT_SETTINGS, ...storedSettings, openAiLogo: storedSettings.openAiLogo === "codex" ? "codex" : "openai", claudeLogo: storedSettings.claudeLogo === "anthropic" ? "anthropic" : "claude", cursorLogo: storedSettings.cursorLogo === "app-dark" ? "app-dark" : "cube", subagentMax: crewSafeConcurrency(Number(storedSettings.subagentMax) || DEFAULT_SETTINGS.subagentMax, initialChildAgents), autoArchiveSubagentThreads: sanitizeAutoArchiveSubagentThreads(storedSettings.autoArchiveSubagentThreads), childAgents: initialChildAgents, childAgentPresets: sanitizeChildAgentPresets(storedSettings.childAgentPresets), model: modelForProvider(storedSettings.provider ?? DEFAULT_SETTINGS.provider, storedSettings.model ?? DEFAULT_SETTINGS.model), reasoningEffort: sanitizeComposerReasoningEffort(storedSettings.reasoningEffort), ultra: false, lmStudioBaseUrl: storedSettings.lmStudioBaseUrl?.trim() || DEFAULT_LM_STUDIO_BASE_URL, theme: sanitizeTheme(storedSettings.theme), effortSlider: sanitizeEffortSlider(storedSettings.effortSlider), uiScale: Math.min(150, Math.max(80, Number(storedSettings.uiScale) || DEFAULT_SETTINGS.uiScale)), usageDisplay: sanitizeUsageDisplay(storedSettings.usageDisplay) };

/**
 * Claude/Cursor transcripts flow memory → disk on a debounced save, so the
 * in-memory task is always at least as fresh as the file. Replacing a
 * non-empty task with the disk snapshot would truncate everything persisted
 * less than a debounce ago — including a turn still streaming — and the next
 * scheduled save would then write that truncation back to disk.
 */
function hydrateLocalProviderTask(
  threadId: string,
  transcript: { messages: ChatMessage[]; activities: Activity[] } | null | undefined,
  executionPath: string | undefined,
): void {
  const store = useTaskStore.getState();
  const existing = store.tasks[threadId];
  if (existing && (existing.messages.length > 0 || existing.activities.length > 0)) {
    store.ensureTask(threadId, executionPath);
    return;
  }
  store.hydrateTask(threadId, transcript?.messages ?? [], transcript?.activities ?? [], executionPath);
}

function permissionLabel(mode: PermissionMode): string {
  if (mode === "read-only") return "Read only";
  if (mode === "full") return "Full access";
  return "Ask to act";
}

function providerLabel(provider: AppSettings["provider"]): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "lmstudio") return "LM Studio";
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
function ConversationTimeline({ threadId, running, thinkingLabel, approval, provider, searchQuery, searchActiveMatch, onSearchMatches, onEditMessage, onApprovalRespond, onLoadEarlier }: { threadId: string; running: boolean; thinkingLabel: string; approval: PendingApproval | null; provider: AppSettings["provider"]; searchQuery?: string; searchActiveMatch?: number; onSearchMatches?: (count: number) => void; onEditMessage: (text: string) => void; onApprovalRespond: (approval: PendingApproval, result: JsonObject) => void | Promise<void>; onLoadEarlier: () => void }) {
  const messages = useTaskStore((state) => state.tasks[threadId]?.messages ?? EMPTY_MESSAGES);
  const activities = useTaskStore((state) => state.tasks[threadId]?.activities ?? EMPTY_ACTIVITIES);
  const history = useTaskStore((state) => state.tasks[threadId]?.history);
  // A thread change must create a fresh virtual scroller so its initial
  // position is applied to the newly selected conversation.
  return <ChatTimeline key={threadId} messages={messages} activities={activities} running={running} thinkingLabel={thinkingLabel} approval={approval} provider={provider} history={history} onLoadEarlier={onLoadEarlier} searchQuery={searchQuery} searchActiveMatch={searchActiveMatch} onSearchMatches={onSearchMatches} onEditMessage={onEditMessage} onApprovalRespond={onApprovalRespond} />;
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
  const [threadReasoning, setThreadReasoning] = usePersistedState<Record<string, ThreadReasoning>>("kiwi.threadReasoning", {}, {
    init: (load) => sanitizeThreadReasoningRecords(load()),
  });
  const [deferredReasoningNoticeThreads, setDeferredReasoningNoticeThreads] = useState<Set<string>>(() => new Set());
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
  const [previewEffortSlider, setPreviewEffortSlider] = useState<EffortSliderStyle | null>(null);
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
  const archivingThreadIdsRef = useRef(new Set<string>());
  const autoArchiveCompletionRef = useRef<(completedThreadId: string) => void>(() => undefined);
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
  const historyRequestRef = useRef(new Map<string, number>());
  const historyRequestSequenceRef = useRef(0);
  const providerRepairThreadsRef = useRef(new Set<string>());
  const [openRouterReady, setOpenRouterReady] = useState(false);
  const [openRouterCredits, setOpenRouterCredits] = useState<OpenRouterCreditBalance | null>(null);
  const [openRouterCreditsRead, setOpenRouterCreditsRead] = useState(false);
  const [openRouterCreditsError, setOpenRouterCreditsError] = useState("");
  const [lmStudioTokenStored, setLmStudioTokenStored] = useState(false);
  // The dock's open state is deliberately not persisted: it covers a third of
  // the window, and restoring it on launch hides the conversation the user
  // came back for. The chosen surface is persisted, so reopening lands where
  // the last session left off.
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTab, setStudioTab] = usePersistedState<StudioTab>("kiwi.studioTab", "review", {
    init: (load) => {
      const stored = load();
      return isStudioTab(stored) ? stored : "review";
    },
  });
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDrafts>({});
  const [openAiRateLimits, setOpenAiRateLimits] = useState<ProviderRateLimits | null>(null);
  const [openAiRateLimitsRead, setOpenAiRateLimitsRead] = useState(false);
  const openAiAccountRequestRef = useRef(0);
  const openAiUsageRequestRef = useRef(0);
  const [claudeRateLimits, setClaudeRateLimits] = useState<ProviderRateLimits | null>(null);
  const [skillsFolder, setSkillsFolder] = usePersistedState<string>("kiwi.skillsFolder", "");
  const [skillFiles, setSkillFiles] = useState<LocalSkillFile[]>([]);
  const [skillAliases, setSkillAliases] = usePersistedState<Record<string, string>>("kiwi.skillAliases", {});
  const [disabledSkillPaths, setDisabledSkillPaths] = usePersistedState<string[]>("kiwi.disabledSkills", []);
  const [removedSkillPaths, setRemovedSkillPaths] = usePersistedState<string[]>("kiwi.removedSkills", []);
  const [skills, setSkills] = useState<LocalSkill[]>([]);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const skillRuntimeRootRef = useRef("");
  const skillFilesRef = useRef<LocalSkillFile[]>([]);
  const skillScanSequenceRef = useRef(0);
  const skillsBusyCountRef = useRef(0);
  const removedSkills = useMemo(
    () => resolveLocalSkills(skillFiles.filter((file) => removedSkillPaths.includes(file.path)), skillAliases, disabledSkillPaths),
    [disabledSkillPaths, removedSkillPaths, skillAliases, skillFiles],
  );
  const [mcpServers, setMcpServers] = useState<McpView[]>([]);
  const [gitOutput, setGitOutput] = useState("");
  const [gitCommitSuccess, setGitCommitSuccess] = useState("");
  const [gitCommitBusy, setGitCommitBusy] = useState(false);
  const gitProjectSequenceRef = useRef(0);
  const [githubStatus, setGithubStatus] = useState<GitHubAccountStatus | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubLoginPending, setGithubLoginPending] = useState(false);
  const [githubRepoStatus, setGithubRepoStatus] = useState<GitHubRepoStatus | null>(null);
  const githubRepoRefreshSequenceRef = useRef(0);
  const [githubRepoError, setGithubRepoError] = useState("");
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModel[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false);
  const [openRouterModelsError, setOpenRouterModelsError] = useState("");
  const [openRouterSearching, setOpenRouterSearching] = useState(false);
  const [claudeModels, setClaudeModels] = useState<ClaudeModel[]>([]);
  const [claudeModelsLoading, setClaudeModelsLoading] = useState(false);
  const [claudeModelsError, setClaudeModelsError] = useState("");
  // Starred models per provider. Sanitized on load because the store outlives
  // any single catalog and can hold ids a provider has since retired.
  const [modelFavorites, setModelFavorites] = usePersistedState<ModelFavorites>(
    MODEL_FAVORITES_KEY,
    EMPTY_MODEL_FAVORITES,
    { init: (load) => sanitizeModelFavorites(load()) },
  );
  const [lmStudioModels, setLMStudioModels] = useState<LMStudioModel[]>([]);
  const [lmStudioModelsLoading, setLMStudioModelsLoading] = useState(false);
  const [lmStudioModelsError, setLMStudioModelsError] = useState("");
  const lmStudioReady = lmStudioModels.length > 0 && !lmStudioModelsError;
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
  // The whole durable ownership graph, both generations. Inbox classification
  // and the cycle guards below have to see every record: a root proved by a
  // cross-provider link must not be reclassified by a native one, or the
  // reverse.
  const childThreadLinks = useMemo<OwnershipLinks>(
    () => ({ ...nativeAgentLinks, ...childAgentLinks }),
    [childAgentLinks, nativeAgentLinks],
  );
  const childThreadLinksRef = useRef(childThreadLinks);
  childThreadLinksRef.current = childThreadLinks;
  const childAgentLinksRef = useRef(childAgentLinks);
  childAgentLinksRef.current = childAgentLinks;
  const activeThreadHandoff = activeThreadId ? threadHandoffs[activeThreadId] : undefined;
  const activeThreadWorktree = activeThreadId ? threadWorktrees[activeThreadId] : undefined;
  const activeExecutionPath = activeWorkspace
    ? executionPathForThread(activeThreadId, activeWorkspace.path, threadWorktrees)
    : "";
  // Attachments follow the composer's draft identity exactly: a started thread
  // owns them by id, an unsent one by its workspace. Switching conversations
  // therefore cannot carry a file into another thread's next turn, and coming
  // back to a draft still finds the files chosen for it.
  const attachmentKey = activeThreadId ?? (activeWorkspace ? `new:${activeWorkspace.path}` : "new:");
  const attachments = attachmentsFor(attachmentDrafts, attachmentKey);
  const setAttachmentsForKey = useCallback((key: string, update: AttachmentRecord[] | ((current: AttachmentRecord[]) => AttachmentRecord[])) => {
    setAttachmentDrafts((current) => {
      const existing = attachmentsFor(current, key);
      const next = typeof update === "function" ? update(existing) : update;
      return next === existing ? current : withAttachmentDraft(current, key, next);
    });
  }, []);
  // Bound to the key of the render that created it, so a send that finishes
  // after a thread switch clears the attachments of the thread it sent from.
  const setAttachments = useCallback<Dispatch<SetStateAction<AttachmentRecord[]>>>((update) => {
    setAttachmentsForKey(attachmentKey, update);
  }, [attachmentKey, setAttachmentsForKey]);
  const projectDefaults = activeProject?.overrides?.defaults;
  const projectDefaultProvider = projectDefaults?.provider ?? settings.provider;
  const activeProvider = activeThread ? providerFromThread(activeThread, projectDefaultProvider) : (draftThreadProvider ?? projectDefaultProvider);
  // Resolve project policy independently of the open conversation. Thread
  // selection needs this unclamped shape: the previously active thread may be
  // a depth-one child while the thread being opened is a root (or vice versa).
  const projectSettings = useMemo<AppSettings>(() => {
    const overrides = activeProject?.overrides;
    const defaults = overrides?.defaults;
    const projectResolved = !defaults
      ? settings
      : {
          ...settings,
          provider: defaults.provider,
          model: defaults.model,
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
  // Opt-in project defaults win over global defaults, while provider and model
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
      reasoningEffort: sanitizeComposerReasoningEffort(rememberedReasoning?.reasoningEffort ?? projectSettings.reasoningEffort),
      ultra: false,
    };
    return activeThread && isSubAgentThread(activeThread, childThreadLinks)
      ? settingsWithoutChildDelegation(resolved)
      : resolved;
  }, [activeProject, activeProvider, activeThread, activeThreadId, childThreadLinks, draftThreadModel, projectSettings, subscriptionSystemPrompts, threadModels, threadReasoning]);

  useEffect(() => {
    if (!pendingHandoff || !activeWorkspace || activeThread) return;
    if (normalizedProjectPath(pendingHandoff.workspacePath) !== normalizedProjectPath(activeWorkspace.path)) {
      // The abandoned handoff draft loses both halves of its content.
      discardDraft(`new:${pendingHandoff.workspacePath}`);
      setAttachmentDrafts((current) => forgetAttachmentDraft(current, `new:${pendingHandoff.workspacePath}`));
      setPendingHandoff(null);
      setDraftThreadProvider(null);
      setDraftThreadModel(null);
      setDraftThreadIsolated(false);
      return;
    }
    // Restore the destination choice beside the durable composer draft after
    // an app restart. Keeping only the text could otherwise send a handoff
    // through the default provider and lose its provenance.
    setDraftThreadProvider(pendingHandoff.targetProvider === projectDefaultProvider ? null : pendingHandoff.targetProvider);
    setDraftThreadModel(pendingHandoff.targetProvider === projectDefaultProvider ? null : modelForProvider(pendingHandoff.targetProvider, ""));
    setDraftThreadIsolated(false);
  }, [activeThread, activeWorkspace, pendingHandoff, projectDefaultProvider, setPendingHandoff]);

  // Which providers a cross-provider child could actually be started on right
  // now. Unusable destinations are filtered out of a thread's policy instead
  // of failing at the moment the model tries to delegate.
  const childAgentReadiness = useMemo<ChildAgentReadiness>(() => ({
    codexRuntimeAvailable: Boolean(runtimeStatus?.available),
    openAiSignedIn: account?.type === "chatgpt",
    openRouterReady,
    lmStudioReady,
    claudeReady: Boolean(claudeStatus?.available && claudeStatus.loggedIn),
    cursorReady: Boolean(cursorStatus?.available && cursorStatus.loggedIn),
  }), [account?.type, claudeStatus, cursorStatus, lmStudioReady, openRouterReady, runtimeStatus?.available]);

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
  /** A captured thread keeps its own roster; activity decides whether the
   * command center may stage a replacement for the next turn. */
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
  // The composer's command center edits this shape directly until a thread has
  // captured a crew of its own.
  const composerSubagentPolicy = useMemo(
    () => projectSubagentSettingsFromApp(effectiveSettings),
    [effectiveSettings],
  );
  // Captured conversations edit a thread-local draft. A pending recapture is
  // shown immediately so the UI never appears to discard an edit while it is
  // waiting for the next prompt to promote it.
  const activeThreadSubagentPolicy = useMemo<ProjectSubagentSettings>(() => {
    if (!activeDelegationPolicy) return composerSubagentPolicy;
    const pending = activeDelegationPolicy.pendingRecapture;
    return {
      enabled: effectiveSettings.subagentsEnabled,
      maxConcurrent: pending?.maxConcurrent ?? activeDelegationPolicy.maxConcurrent,
      childAgents: {
        enabled: effectiveSettings.childAgents.enabled,
        targets: pending?.targets ?? activeDelegationPolicy.targets,
      },
    };
  }, [activeDelegationPolicy, composerSubagentPolicy, effectiveSettings.childAgents.enabled, effectiveSettings.subagentsEnabled]);
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
    // A model the Claude plan cannot run is left out entirely here: a
    // destination roster is a promise the child turn will actually start.
    ...(claudeModels.length ? {
      claude: claudeModels.filter((entry) => !entry.disabled).map((entry) => ({
        id: entry.id,
        label: entry.displayName,
        detail: entry.description || entry.resolvedModel,
        keywords: entry.resolvedModel,
      })),
    } : {}),
    openrouter: openRouterModels.map((entry) => ({
      id: entry.id,
      label: entry.name || entry.id,
      detail: entry.id,
      keywords: entry.description,
    })),
    lmstudio: lmStudioModels.map((entry) => ({
      id: entry.id,
      label: entry.id,
      detail: `${entry.publisher}${entry.trainedForToolUse ? " · tool use" : ""}`,
    })),
  }), [claudeModels, cursorModels, lmStudioModels, openRouterModels, runtimeModels]);

  const terminal = useTerminal({ scrollback: settings.terminalScrollback, permission: effectiveSettings.permission, scope: activeExecutionPath, onError: setError });
  const timelineEmpty = useTaskStore((state) => {
    if (!activeThreadId) return true;
    const task = state.tasks[activeThreadId];
    // A recent page can contain only non-rendered protocol items while older
    // pages still hold visible conversation. Keep the timeline mounted so the
    // user can reach its history control instead of being trapped in the
    // generic empty state.
    return !task || (task.messages.length === 0 && task.activities.length === 0 && !task.history.hasMore);
  });
  const reviewDiff = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.diff ?? EMPTY_REVIEW_DIFF) : EMPTY_REVIEW_DIFF));
  const agentRecords = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.agents ?? EMPTY_AGENTS) : EMPTY_AGENTS));
  const agentRunStartedAt = useTaskStore((state) => (activeThreadId ? state.tasks[activeThreadId]?.agentRunStartedAt : undefined));
  const tokenUsage = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.usage ?? null) : null));
  const contextPercent = contextUsagePercent(tokenUsage);
  const queuedTurns = useTaskStore((state) => (activeThreadId ? (state.tasks[activeThreadId]?.queuedTurns ?? EMPTY_QUEUED_TURNS) : EMPTY_QUEUED_TURNS));
  const taskStatus = useTaskStore((state) => (activeThreadId ? (state.statuses[activeThreadId] ?? "idle") : "idle"));
  const threadTaskStatuses = useTaskStore((state) => state.statuses);
  // Live crew for the composer panel: Mythra Code-owned cross-provider children
  // merged with whatever native agents the root task reported.
  const subAgentWorkers = useMemo(
    () => collectSubAgentWorkers({
      rootThreadId: activeThreadId,
      links: childAgentLinks,
      statuses: threadTaskStatuses,
      agents: agentRecords,
      runStartedAt: agentRunStartedAt,
      // A provider-native child runs inside this thread's own runtime, so the
      // row names this thread's provider and model rather than leaving the
      // user with a bare id and a status word.
      nativeLinks: nativeAgentLinks,
      nativeProvider: activeProvider,
      nativeModel: effectiveSettings.model,
    }),
    [activeProvider, activeThreadId, agentRecords, agentRunStartedAt, childAgentLinks, effectiveSettings.model, nativeAgentLinks, threadTaskStatuses],
  );
  const running = activeThreadId ? taskStatus === "starting" || taskStatus === "running" : startingDraftTurn;
  useEffect(() => {
    setDeferredReasoningNoticeThreads((current) => {
      const next = new Set(
        [...current].filter((threadId) => {
          const status = threadTaskStatuses[threadId];
          return status === "starting" || status === "running";
        }),
      );
      if (next.size === current.size && [...next].every((threadId) => current.has(threadId))) return current;
      return next;
    });
  }, [threadTaskStatuses]);
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
  const workspaceKindThreads = useMemo(() => {
    if (!activeWorkspace) return [];
    return filterThreadsByKind(
      filterThreadsForWorkspace(threads, activeWorkspace.path, threadProjectBindingsRef.current ?? {}),
      childThreadLinks,
      threadKindView,
    );
  }, [activeWorkspace, childThreadLinks, threadKindView, threads]);
  const displayedThreads = useMemo(() => {
    if (!activeWorkspace) return [];
    const threadProjectBindings = threadProjectBindingsRef.current ?? {};
    const query = threadSearch.trim().toLowerCase();
    const merged = workspaceKindThreads
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
  }, [activeWorkspace, childThreadLinks, pinnedThreadIds, searchResults, threadKindView, threadSearch, workspaceKindThreads]);

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

  /**
   * Claude's live catalog offers aliases (`default`, `opus[1m]`) rather than
   * the ids pricing is published under. The catalog is the only authority on
   * what an alias currently resolves to, so cost estimates use it when it is
   * loaded and fall back to pattern normalization when it is not.
   */
  const pricingModel = useCallback((provider: Provider, model: string) => (
    provider === "claude" ? claudeModels.find((entry) => entry.id === model)?.resolvedModel ?? model : model
  ), [claudeModels]);

  useEffect(() => {
    if (!activeThreadId) return;
    annotateThreadUsage(activeThreadId, {
      provider: effectiveSettings.provider,
      model: effectiveSettings.model,
      projectPath: activeWorkspace ? normalizedProjectPath(activeWorkspace.path) : undefined,
      pricing: activeOpenRouterPricing ?? pricingForModel(effectiveSettings.provider, pricingModel(effectiveSettings.provider, effectiveSettings.model)),
    });
  }, [activeOpenRouterPricing, activeThreadId, activeWorkspace, effectiveSettings.model, effectiveSettings.provider, pricingCatalogRevision, pricingModel, tokenUsage]);

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
    : effectiveSettings.provider === "lmstudio"
      ? "Local inference · no API charge"
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
      openAiRateLimits,
      openAiRateLimitsRead,
      openAiConnected: account?.type === "chatgpt",
      claudeStatus,
      claudeRateLimits,
      cursorStatus,
      openRouterReady,
      openRouterCredits,
      openRouterCreditsRead,
      openRouterCreditsError,
      lmStudioReady,
      usageDisplay: settings.usageDisplay,
    });
  }, [account?.type, claudeRateLimits, claudeStatus, cursorStatus, effectiveSettings.provider, lmStudioReady, openAiRateLimits, openAiRateLimitsRead, openRouterCredits, openRouterCreditsError, openRouterCreditsRead, openRouterReady, settings.usageDisplay]);
  const headerUsageView = useMemo(() => providerHeaderUsage(effectiveSettings.provider, accountUsageView, {
    openRouterReady,
    openRouterCredits,
    openRouterCreditsRead,
    openRouterCreditsError,
  }), [accountUsageView, effectiveSettings.provider, openRouterCredits, openRouterCreditsError, openRouterCreditsRead, openRouterReady]);

  // Only offer "Check settings" for failures settings can actually fix.
  const errorSuggestsSettings = useMemo(() => Boolean(error) && /sign in|api key|openrouter|lm studio|claude|model|settings|runtime|codex|account/i.test(error ?? ""), [error]);
  const workspaceArchived = useMemo(() => (activeWorkspace
    ? archivedThreadsForInbox(archivedThreads, activeWorkspace.path, childThreadLinks, threadKindView)
    : []), [activeWorkspace, archivedThreads, childThreadLinks, threadKindView]);

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

  const persistComposerModel = useCallback(
    (model: string) => {
      if (activeThreadId) {
        persistThreadModel(activeThreadId, model);
      } else if (draftThreadProvider !== null || activeProject?.overrides?.defaults) {
        setDraftThreadModel(model);
      } else {
        persistSettings({ ...settings, model });
      }
    },
    [activeProject, activeThreadId, draftThreadProvider, persistSettings, persistThreadModel, settings],
  );

  const persistComposerReasoning = useCallback((reasoningEffort: ThreadReasoning["reasoningEffort"]) => {
    if (activeThreadId) {
      persistThreadReasoning(activeThreadId, { reasoningEffort, ultra: false });
      if (running) {
        setDeferredReasoningNoticeThreads((current) => {
          if (current.has(activeThreadId)) return current;
          const next = new Set(current);
          next.add(activeThreadId);
          return next;
        });
      }
    } else {
      persistSettings({ ...settings, reasoningEffort, ultra: false });
    }
  }, [activeThreadId, persistSettings, persistThreadReasoning, running, settings]);

  const persistComposerPermission = useCallback(
    (permission: PermissionMode) => {
      persistSettings({ ...settings, permission });
    },
    [persistSettings, settings],
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

  /**
   * Stage destination/model/reasoning/limit edits for this conversation only.
   * The global/project switches intentionally remain live defaults, while the
   * captured roster is promoted atomically by the next prompt.
   */
  const persistActiveThreadSubagentPolicy = useCallback((next: ProjectSubagentSettings) => {
    const existing = activeDelegationPolicy;
    if (!existing || !activeThreadId) {
      persistComposerSubagentPolicy(next);
      return;
    }
    // The rendered controls re-lock as soon as work starts, but re-check here
    // so a click that lands in the same tick as a run cannot mutate its crew.
    const latestStatus = useTaskStore.getState().statuses[activeThreadId] ?? "idle";
    const parentActive = latestStatus === "starting" || latestStatus === "running" || queuedTurns.length > 0;
    if (parentActive || childrenRunning) {
      setTransientStatus("Finish or stop the parent and every sub-agent before changing this setup");
      return;
    }

    // These switches have always been revocation controls read fresh by every
    // turn. Preserve that contract without copying this thread's roster back
    // into project/global defaults.
    if (next.enabled !== composerSubagentPolicy.enabled
      || next.childAgents.enabled !== composerSubagentPolicy.childAgents.enabled) {
      persistComposerSubagentPolicy({
        ...composerSubagentPolicy,
        enabled: next.enabled,
        childAgents: { ...composerSubagentPolicy.childAgents, enabled: next.childAgents.enabled },
      });
    }

    const crewChanged = next.maxConcurrent !== activeThreadSubagentPolicy.maxConcurrent
      || JSON.stringify(next.childAgents.targets) !== JSON.stringify(activeThreadSubagentPolicy.childAgents.targets);
    if (!crewChanged) {
      setTransientStatus("Sub-agent access updated · applies next message");
      return;
    }
    const targets = next.childAgents.targets;
    if (!readyChildAgentTargets({ enabled: true, targets }, childAgentReadiness).length) {
      setTransientStatus("Keep one ready destination, or switch cross-provider sub-agents off");
      return;
    }
    const pendingRecapture = {
      maxConcurrent: crewSafeConcurrency(next.maxConcurrent, { enabled: true, targets }),
      targets,
      approvedAt: Date.now(),
    };
    const staged = { ...existing, pendingRecapture };
    // The immediate cache closes the tiny click-then-send race before React's
    // persisted state has rendered the staged policy back into this callback.
    cacheChildAgentPolicy(staged);
    persistChildAgentPolicies((current) => ({
      ...current,
      [existing.sessionId]: { ...(current[existing.sessionId] ?? existing), pendingRecapture },
    }));
    invalidateChildAgentLaunch(existing.sessionId);
    setTransientStatus("Sub-agent setup updated for this thread · applies next message");
  }, [
    activeDelegationPolicy,
    activeThreadSubagentPolicy,
    activeThreadId,
    childAgentReadiness,
    childrenRunning,
    composerSubagentPolicy,
    persistChildAgentPolicies,
    persistComposerSubagentPolicy,
    queuedTurns.length,
    setTransientStatus,
  ]);

  const openSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setPreviewTheme(null);
    setPreviewEffortSlider(null);
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

  // Repair old poisoned root records while ownership proof still exists. The
  // corrected record is written back, so removing the root's final child later
  // cannot reveal stale child metadata and move the main conversation again.
  useEffect(() => {
    const remembered = knownThreadsRef.current ?? {};
    let rememberedChanged = false;
    const nextRemembered: ThreadSidebarIndex = {};
    for (const [threadId, thread] of Object.entries(remembered)) {
      const repaired = repairRootThreadMetadata(thread, childThreadLinks);
      nextRemembered[threadId] = repaired;
      if (repaired !== thread) rememberedChanged = true;
    }
    if (rememberedChanged) {
      knownThreadsRef.current = nextRemembered;
      storeValue("kiwi.knownThreads", nextRemembered);
    }
    setThreads((current) => {
      let listChanged = false;
      const repaired = current.map((thread) => {
        const next = repairRootThreadMetadata(thread, childThreadLinks);
        if (next !== thread) listChanged = true;
        return next;
      });
      return listChanged ? repaired : current;
    });
    setActiveThread((current) => current ? repairRootThreadMetadata(current, childThreadLinks) : current);
  }, [childThreadLinks]);

  const persistClaudeThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const task = useTaskStore.getState().tasks[threadId];
      const thread = activeThread?.id === threadId ? activeThread : (threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId]);
      if (!task || !thread || !isClaudeThread(thread)) return false;
      await saveClaudeTranscript({ thread, messages: task.messages.map((message) => ({ ...message, streaming: false })), activities: task.activities });
      return true;
    },
    [activeThread, threads],
  );

  const scheduleClaudeThreadSave = useCallback(
    (threadId: string) => {
      useTaskStore.getState().setTranscriptDirty(threadId, true);
      const existing = claudeSaveTimersRef.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        claudeSaveTimersRef.current.delete(threadId);
        void persistClaudeThread(threadId)
          .then((saved) => {
            if (saved) useTaskStore.getState().setTranscriptDirty(threadId, false);
          })
          .catch((error) => recordError(`Claude transcript save failed: ${error instanceof Error ? error.message : String(error)}`));
      }, LOCAL_TRANSCRIPT_SAVE_DEBOUNCE_MS);
      claudeSaveTimersRef.current.set(threadId, timer);
    },
    [persistClaudeThread],
  );

  const persistCursorThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const task = useTaskStore.getState().tasks[threadId];
      const thread = activeThread?.id === threadId ? activeThread : (threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId]);
      if (!task || !thread || !isCursorThread(thread)) return false;
      await saveCursorTranscript({
        thread,
        cursorSessionId: cursorSessionIdsRef.current[threadId] ?? "",
        messages: task.messages.map((message) => ({ ...message, streaming: false })),
        activities: task.activities,
      });
      return true;
    },
    [activeThread, threads],
  );

  const scheduleCursorThreadSave = useCallback(
    (threadId: string) => {
      useTaskStore.getState().setTranscriptDirty(threadId, true);
      const existing = cursorSaveTimersRef.current.get(threadId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        cursorSaveTimersRef.current.delete(threadId);
        void persistCursorThread(threadId)
          .then((saved) => {
            if (saved) useTaskStore.getState().setTranscriptDirty(threadId, false);
          })
          .catch((error) => recordError(`Cursor transcript save failed: ${error instanceof Error ? error.message : String(error)}`));
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
      if (result.loggedIn) {
        setClaudeRateLimits(await getClaudeRateLimits().catch(() => null));
      } else {
        setClaudeRateLimits(null);
      }
      return result;
    } catch (reason) {
      const result: ClaudeRuntimeStatus = { available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null };
      setClaudeStatus(result);
      setClaudeRateLimits(null);
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

  const cursorModelsRequestRef = useRef(0);
  const refreshCursorModels = useCallback(async () => {
    const request = ++cursorModelsRequestRef.current;
    setCursorModelsLoading(true);
    try {
      const models = await listCursorModels() ?? [];
      if (cursorModelsRequestRef.current === request) setCursorModels(models);
      return models;
    } catch (reason) {
      if (cursorModelsRequestRef.current === request) {
        setCursorModels([]);
        if (cursorStatus?.loggedIn) setError(friendlyError(reason));
      }
      return [];
    } finally {
      if (cursorModelsRequestRef.current === request) setCursorModelsLoading(false);
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
      // Paint the remembered sidebar snapshot for this workspace immediately.
      // Without it, the frames between the project click and the first
      // thread/list page render an empty inbox — a visible flicker of the
      // rows and of every header control derived from the visible list.
      setThreads(reconcileWorkspaceThreads([], knownThreadsRef.current ?? {}, project.path, threadProjectBindingsRef.current ?? {}));
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
        // Ownership claims are checked against the graph Mythra Code already has,
        // plus the ones accepted from this same page. A runtime that reports a
        // root's own parent — or a cycle through one — must not be able to move
        // an established root conversation into the Sub-agents inbox.
        const ownershipGraph: OwnershipLinks = { ...childThreadLinksRef.current };
        const listedRootIds = new Set<string>();
        for (const thread of allThreads) {
          if (nativeAgentLinkFromThread(thread)) continue;
          listedRootIds.add(thread.id);
          // thread/list is authoritative for provider-native ownership. Remove
          // only a stale native claim; an Mythra Code bridge link remains proof
          // that a cross-provider child belongs in the child inbox.
          if (!childAgentLinksRef.current[thread.id]) delete ownershipGraph[thread.id];
        }
        for (const thread of allThreads) {
          const link = nativeAgentLinkFromThread(thread);
          if (!link) continue;
          if (!canOwnThread(ownershipGraph, link.rootThreadId, link.childThreadId)) continue;
          ownershipGraph[link.childThreadId] = link;
          discoveredNativeLinks[link.childThreadId] = link;
          const rootPath = threadProjectBindingsRef.current?.[link.rootThreadId]
            ?? knownThreadsRef.current?.[link.rootThreadId]?.cwd
            ?? project.path;
          bindThreadToProject(link.childThreadId, rootPath);
        }
        if (listedRootIds.size || Object.keys(discoveredNativeLinks).length) {
          persistNativeAgentLinks((current) => {
            const next = { ...current };
            for (const threadId of listedRootIds) delete next[threadId];
            return sanitizeNativeAgentLinks({ ...next, ...discoveredNativeLinks });
          });
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

  const refreshAccount = useCallback(async (refreshToken = false): Promise<{ account: Account | null; requiresOpenaiAuth?: boolean } | null> => {
    const request = ++openAiAccountRequestRef.current;
    try {
      const result = await rpc<{ account: Account | null; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken });
      if (openAiAccountRequestRef.current !== request) return null;
      setAccount(result.account);
      if (result.account?.type === "chatgpt") {
        setAuthRequiredOpen(false);
        setError(null);
        setStatus("Ready");
      } else {
        openAiUsageRequestRef.current += 1;
        setOpenAiRateLimits(null);
        setOpenAiRateLimitsRead(false);
      }
      return result;
    } catch (reason) {
      if (openAiAccountRequestRef.current !== request) return null;
      const message = friendlyError(reason);
      setError(message);
      if (/\b401\b|oauth|access token|authenticate|authentication|sign in/i.test(message)) {
        setAccount(null);
        openAiUsageRequestRef.current += 1;
        setOpenAiRateLimits(null);
        setOpenAiRateLimitsRead(false);
        setAuthRequiredOpen(true);
        setStatus("Sign-in required");
      }
      return null;
    }
  // Babel's TS-7-compatible parser treats the `result.account` property as
  // the unrelated component state named `account`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runtimeModelsRequestRef = useRef(0);
  const refreshModels = useCallback(async () => {
    const request = ++runtimeModelsRequestRef.current;
    try {
      const allModels: RuntimeModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result: { data: RuntimeModel[]; nextCursor?: string | null } = await rpc("model/list", { limit: 100, includeHidden: false, cursor });
        allModels.push(...(result.data ?? []));
        cursor = result.nextCursor ?? null;
        if (!cursor) break;
      }
      if (runtimeModelsRequestRef.current === request) setRuntimeModels(allModels);
    } catch {
      if (runtimeModelsRequestRef.current === request) setRuntimeModels([]);
    }
  }, []);

  const openRouterModelsRequestRef = useRef(0);
  const refreshOpenRouterModels = useCallback(async () => {
    const request = ++openRouterModelsRequestRef.current;
    setOpenRouterModelsLoading(true);
    setOpenRouterModelsError("");
    try {
      const models = await fetchOpenRouterCatalog();
      // A full refresh is authoritative: retired or newly unavailable models
      // must leave the catalog instead of surviving through an earlier search.
      if (openRouterModelsRequestRef.current === request) {
        setOpenRouterModels(models);
        if (!models.length) setOpenRouterModelsError("OpenRouter returned an empty catalog");
      }
    } catch (reason) {
      if (openRouterModelsRequestRef.current === request) setOpenRouterModelsError(friendlyError(reason));
    } finally {
      if (openRouterModelsRequestRef.current === request) setOpenRouterModelsLoading(false);
    }
  }, []);

  /** Resolve a complete typed slug that is absent from the full account list. */
  const openRouterDiscoveryRef = useRef(0);
  const discoverOpenRouterModels = useCallback(async (query: string) => {
    const search = query.trim();
    if (!search.includes("/")) return;
    const request = ++openRouterDiscoveryRef.current;
    setOpenRouterSearching(true);
    try {
      const slug = openRouterModels.some((entry) => entry.id.toLowerCase() === search.toLowerCase())
        ? null
        : await resolveOpenRouterSlug(search).catch(() => null);
      if (openRouterDiscoveryRef.current !== request) return;
      const additions = slug?.verified ? [slug.model] : [];
      if (additions.length) setOpenRouterModels((current) => mergeOpenRouterModels(current, additions));
    } finally {
      if (openRouterDiscoveryRef.current === request) setOpenRouterSearching(false);
    }
  }, [openRouterModels]);

  /**
   * Reads the Claude Code CLI's own model catalog. The CLI has no `models`
   * subcommand, so this rides the stream-json control protocol; an older CLI
   * or a signed-out install leaves the labelled built-in list in place.
   */
  const claudeModelsRequestRef = useRef(0);
  const refreshClaudeModels = useCallback(async () => {
    const request = ++claudeModelsRequestRef.current;
    setClaudeModelsLoading(true);
    setClaudeModelsError("");
    try {
      const models = await listClaudeModels();
      if (claudeModelsRequestRef.current === request) {
        setClaudeModels(models);
        if (!models.length) setClaudeModelsError("Claude Code returned no models.");
      }
      return models;
    } catch (reason) {
      if (claudeModelsRequestRef.current === request) {
        setClaudeModels([]);
        setClaudeModelsError(friendlyError(reason));
      }
      return [];
    } finally {
      if (claudeModelsRequestRef.current === request) setClaudeModelsLoading(false);
    }
  }, []);

  const toggleModelFavorite = useCallback((provider: Provider, model: string) => {
    setModelFavorites((current) => toggleFavoriteModel(current, provider, model));
  }, [setModelFavorites]);

  const lmStudioModelsRequestRef = useRef(0);
  const refreshLMStudioModels = useCallback(async (baseUrl: string) => {
    const request = ++lmStudioModelsRequestRef.current;
    setLMStudioModelsLoading(true);
    setLMStudioModelsError("");
    try {
      const models = await listLMStudioModels(baseUrl);
      // A startup probe can still be in flight when Settings tests a newly
      // entered server URL. Only the newest request may publish its catalog;
      // otherwise the slow old server replaces a successful fresh result.
      if (lmStudioModelsRequestRef.current === request) {
        setLMStudioModels(models);
        if (!models.length) setLMStudioModelsError("LM Studio is connected, but it did not report any models");
      }
      return models;
    } catch (reason) {
      if (lmStudioModelsRequestRef.current === request) {
        setLMStudioModels([]);
        setLMStudioModelsError(friendlyError(reason));
      }
      return [];
    } finally {
      if (lmStudioModelsRequestRef.current === request) setLMStudioModelsLoading(false);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    const request = ++openAiUsageRequestRef.current;
    try {
      const result = await rpc<unknown>("account/rateLimits/read");
      if (openAiUsageRequestRef.current === request) {
        setOpenAiRateLimits(parseCodexRateLimits(result));
        setOpenAiRateLimitsRead(true);
      }
    } catch {
      if (openAiUsageRequestRef.current === request) {
        setOpenAiRateLimits(null);
        setOpenAiRateLimitsRead(false);
      }
    }
  }, []);

  const openRouterCreditsRequestRef = useRef(0);
  const refreshOpenRouterCredits = useCallback(async () => {
    const request = ++openRouterCreditsRequestRef.current;
    setOpenRouterCreditsRead(false);
    setOpenRouterCreditsError("");
    try {
      const balance = await getOpenRouterCredits();
      if (openRouterCreditsRequestRef.current === request) {
        setOpenRouterCredits(balance);
        setOpenRouterCreditsRead(true);
      }
    } catch (reason) {
      if (openRouterCreditsRequestRef.current === request) {
        setOpenRouterCredits(null);
        setOpenRouterCreditsError(friendlyError(reason));
        setOpenRouterCreditsRead(true);
      }
    }
  }, []);

  const refreshAccountData = useCallback(async (refreshToken = false) => {
    const result = await refreshAccount(refreshToken);
    if (result?.account?.type === "chatgpt") {
      await Promise.all([refreshModels(), refreshUsage()]);
    }
    return result;
  }, [refreshAccount, refreshModels, refreshUsage]);

  useEffect(() => {
    if (openRouterReady) {
      void refreshOpenRouterCredits();
    } else {
      openRouterCreditsRequestRef.current += 1;
      setOpenRouterCredits(null);
      setOpenRouterCreditsRead(false);
      setOpenRouterCreditsError("");
    }
  }, [openRouterReady, refreshOpenRouterCredits]);

  const prepareLocalSkills = useCallback(
    async (folder: string, files: LocalSkillFile[], aliases: Record<string, string>, disabled: string[], removed: string[]) => {
      const resolved = resolveLocalSkills(files, aliases, disabled, removed);
      if (!folder) {
        setSkills(resolved);
        skillRuntimeRootRef.current = "";
        if (runtimeStatus?.available) await rpc("skills/extraRoots/set", { extraRoots: [] });
        return resolved;
      }
      const runtimeRoot = await syncLocalSkills(folder, resolved);
      if (runtimeStatus?.available) {
        await rpc("skills/extraRoots/set", { extraRoots: [runtimeRoot] });
      }
      skillRuntimeRootRef.current = runtimeRoot;
      setSkills(resolved);
      return resolved;
    },
    [runtimeStatus?.available],
  );

  const refreshLocalSkills = useCallback(
    async (
      folder = skillsFolder,
      aliases = skillAliases,
      disabled = disabledSkillPaths,
      removed = removedSkillPaths,
      silent = false,
    ) => {
      const scanSequence = ++skillScanSequenceRef.current;
      if (!folder) {
        skillFilesRef.current = [];
        setSkillFiles([]);
        setSkills([]);
        setSkillsError("");
        return prepareLocalSkills("", [], aliases, disabled, removed);
      }
      if (!silent) {
        skillsBusyCountRef.current += 1;
        setSkillsBusy(true);
        setSkillsError("");
      }
      try {
        const files = await scanLocalSkills(folder);
        // Folder polling, focus refreshes, and explicit deletion can overlap.
        // Only the newest scan may publish state or rebuild the model runtime.
        if (scanSequence !== skillScanSequenceRef.current) return [];
        const unchanged = JSON.stringify(files) === JSON.stringify(skillFilesRef.current);
        setSkillsError("");
        if (silent && unchanged) return resolveLocalSkills(files, aliases, disabled, removed);
        skillFilesRef.current = files;
        setSkillFiles(files);
        return await prepareLocalSkills(folder, files, aliases, disabled, removed);
      } catch (reason) {
        // Editors, sync clients, and antivirus can briefly lock Markdown on
        // Windows. Background refreshes keep the last known-good library and
        // runtime instead of tearing every skill down for a transient error.
        if (scanSequence !== skillScanSequenceRef.current || silent) return [];
        setSkillsError(friendlyError(reason));
        skillFilesRef.current = [];
        setSkillFiles([]);
        setSkills([]);
        try {
          await prepareLocalSkills("", [], aliases, disabled, removed);
        } catch {
          /* Keep the scan error as the useful message. */
        }
        return [];
      } finally {
        if (!silent) {
          skillsBusyCountRef.current = Math.max(0, skillsBusyCountRef.current - 1);
          if (skillsBusyCountRef.current === 0) setSkillsBusy(false);
        }
      }
    },
    [disabledSkillPaths, prepareLocalSkills, removedSkillPaths, skillAliases, skillsFolder],
  );

  // Polling the skills folder every five seconds is only worth doing where a
  // change is visible: the Tools surface or the Settings skills library. Away
  // from those it ran forever against a folder nobody was looking at. Window
  // focus still refreshes unconditionally, so returning to the app after an
  // external edit is up to date wherever the user lands.
  const skillsSurfaceVisible = settingsOpen || (studioOpen && studioTab === "tools");
  useEffect(() => {
    if (!skillsFolder) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, removedSkillPaths, true);
    };
    const interval = skillsSurfaceVisible ? window.setInterval(refresh, 5_000) : null;
    window.addEventListener("focus", refresh);
    return () => {
      if (interval !== null) window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [disabledSkillPaths, refreshLocalSkills, removedSkillPaths, skillAliases, skillsFolder, skillsSurfaceVisible]);

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

  /**
   * Loads the Review panel's diff. The runtime's `gitDiffToRemote` is
   * preferred; when it is unavailable the repository answers directly.
   *
   * The fallback is taken against `HEAD`, so staged changes are included —
   * plain `git diff` showed only unstaged work and quietly hid anything the
   * user or the model had already staged. Untracked files can never appear in
   * a diff, so they are listed separately instead of being passed off as "no
   * changes".
   */
  const refreshDiffFor = useCallback(
    async (threadId: string, projectPath: string) => {
      // Review refresh is optional post-turn work. Check repository
      // availability through the native helper first: on Windows without Git,
      // asking app-server to run `git` produces the alarming but unrelated
      // "failed to spawn command: program not found" after Claude completes.
      const gitInfo = await readWorkspaceGitInfo(projectPath).catch(() => null);
      if (gitInfo && !gitInfo.isRepo) {
        useTaskStore.getState().setDiff(threadId, EMPTY_REVIEW_DIFF);
        return;
      }
      try {
        const result = await rpc<{ diff: string }>("gitDiffToRemote", { cwd: projectPath });
        useTaskStore.getState().setDiff(threadId, {
          text: result.diff ?? "",
          source: "runtime",
          baseline: "the tracked remote branch",
          untrackedPaths: [],
        });
        return;
      } catch {
        /* Fall through to the repository-owned diff below. */
      }
      try {
        let baseline = "HEAD";
        let tracked = await executeCommand(["git", "diff", "--no-ext-diff", "HEAD", "--"], projectPath);
        if (tracked.exitCode !== 0) {
          // A repository with no commits has no HEAD. Show both halves of its
          // state: `--cached` compares staged files with the empty repository,
          // while the ordinary diff adds edits made after staging. Using only
          // the latter silently hid every fully staged new file.
          baseline = "the empty repository";
          const [staged, working] = await Promise.all([
            executeCommand(["git", "diff", "--no-ext-diff", "--cached", "--"], projectPath),
            executeCommand(["git", "diff", "--no-ext-diff", "--"], projectPath),
          ]);
          tracked = {
            exitCode: staged.exitCode || working.exitCode,
            stdout: [staged.stdout, working.stdout].filter(Boolean).join("\n"),
            stderr: [staged.stderr, working.stderr].filter(Boolean).join("\n"),
          };
        }
        const untracked = await executeCommand(
          ["git", "ls-files", "--others", "--exclude-standard"],
          projectPath,
        ).catch(() => null);
        const untrackedPaths = untracked && untracked.exitCode === 0
          ? untracked.stdout.split(/\r?\n/).filter(Boolean)
          : [];
        useTaskStore.getState().setDiff(threadId, {
          text: `${tracked.stdout}${tracked.stderr}`,
          source: "repository",
          baseline,
          untrackedPaths: untrackedPaths.slice(0, MAX_LISTED_UNTRACKED_PATHS),
          untrackedTruncated: untrackedPaths.length > MAX_LISTED_UNTRACKED_PATHS,
        });
      } catch (reason) {
        // A missing Git installation or optional diff capability must not turn
        // a successfully completed model run into an app-level failure.
        recordError(`Review diff refresh skipped: ${friendlyError(reason)}`);
        useTaskStore.getState().setDiff(threadId, EMPTY_REVIEW_DIFF);
      }
    },
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
    onRateLimits: (limits) => {
      setOpenAiRateLimits(limits);
      setOpenAiRateLimitsRead(true);
    },
    onTerminalOutput: terminal.appendProcess,
    onAccountUpdated: () => void refreshAccountData(),
    onLoginFailed: (message) => {
      setError(message);
      setAuthRequiredOpen(true);
    },
    onProviderToolCompatibilityError: (threadId) => {
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      if (providerFromThread(thread, "openai") === "openrouter") providerRepairThreadsRef.current.add(threadId);
    },
    onNativeAgentDiscovered: (rootThreadId, childThreadId, details) => {
      // Ownership is durable and it decides which inbox a conversation lives
      // in. A self, reversed, or cyclic claim is refused outright rather than
      // recorded, because writing `parentThreadId` onto a root thread record
      // would move the user's main conversation into the Sub-agents inbox and
      // keep it there across reloads.
      if (!canOwnThread(childThreadLinksRef.current, rootThreadId, childThreadId)) {
        if (childThreadId && childThreadId !== rootThreadId) {
          void auditEvent("nativeAgent.ownershipRejected", { rootThreadId, childThreadId }).catch(() => {});
        }
        return;
      }
      const now = Date.now();
      const rootThread = threads.find((entry) => entry.id === rootThreadId) ?? knownThreadsRef.current?.[rootThreadId];
      const existingThread = threads.find((entry) => entry.id === childThreadId) ?? knownThreadsRef.current?.[childThreadId];
      const logicalPath = threadProjectBindingsRef.current?.[rootThreadId] ?? rootThread?.cwd;
      const title = details.prompt?.trim()
        || (details.path ? basename(details.path).replaceAll("_", " ") : undefined)
        || existingThread?.preview
        || "Delegated task";
      persistNativeAgentLinks((current) => {
        // Re-check against the newest persisted graph: two discoveries can be
        // dispatched before either state update renders.
        if (!canOwnThread({ ...current, ...childAgentLinks }, rootThreadId, childThreadId)) return current;
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
        if (granted) sendNotification({ title: "Mythra Code needs your approval", body: `“${label}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId, turn) => {
      void finalizeRunCheckpoint(threadId, turn?.id);
      autoArchiveCompletionRef.current(threadId);
      const needsProviderRepair = providerRepairThreadsRef.current.delete(threadId);
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
          if (granted) sendNotification({ title: "Mythra Code task complete", body: projectName ? `“${label}” finished in ${projectName}.` : `“${label}” finished.` });
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
          : pricingForModel(completedProvider, pricingModel(completedProvider, completedModel)),
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
        void refreshOpenRouterCredits();
      } else if (completedProvider === "openai") {
        void refreshUsage();
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
      void respondClaudeControlError(threadId, requestId, `Mythra Code does not support ${subtype} requests yet.`).catch(() => undefined);
      void auditEvent("claude.unsupportedControlRequest", { subtype }, threadId).catch(() => undefined);
    },
    onApprovalRequested: (threadId) => {
      if (!settings.notificationsEnabled || useTaskStore.getState().activeThreadId === threadId) return;
      const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
      void (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "Mythra Code needs your approval", body: `“${thread?.name || thread?.preview || "A Claude task"}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId) => {
      void finalizeRunCheckpoint(threadId);
      autoArchiveCompletionRef.current(threadId);
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
        useTaskStore.getState().setTranscriptDirty(threadId, true);
        void saveClaudeTranscript({ thread: updated, messages: (task?.messages ?? []).map((message) => ({ ...message, streaming: false })), activities: task?.activities ?? [] })
          .then(() => useTaskStore.getState().setTranscriptDirty(threadId, false))
          .catch((error) => recordError(`Claude transcript save failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== threadId) {
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: "Mythra Code task complete", body: `“${known?.name || known?.preview || "Claude task"}” finished.` });
        })().catch(() => {});
      }
      const projectPath = threadProjectBindingsRef.current?.[threadId];
      if (runtimeStatus?.available && projectPath && !projectPath.includes("normal-chats")) {
        void refreshDiffFor(threadId, executionPathFor(threadId, projectPath));
      }
      void getClaudeRateLimits()
        .then(setClaudeRateLimits)
        .catch(() => setClaudeRateLimits(null));
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
        if (granted) sendNotification({ title: "Mythra Code needs your approval", body: `“${thread?.name || thread?.preview || "A Cursor task"}” is waiting for permission to continue.` });
      })().catch(() => {});
    },
    onTurnCompleted: (threadId) => {
      void finalizeRunCheckpoint(threadId);
      autoArchiveCompletionRef.current(threadId);
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
        useTaskStore.getState().setTranscriptDirty(threadId, true);
        void saveCursorTranscript({ thread: updated, cursorSessionId: cursorSessionIdsRef.current[threadId] ?? "", messages: (task?.messages ?? []).map((message) => ({ ...message, streaming: false })), activities: task?.activities ?? [] })
          .then(() => useTaskStore.getState().setTranscriptDirty(threadId, false))
          .catch((error) => recordError(`Cursor transcript save failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (settings.notificationsEnabled && useTaskStore.getState().activeThreadId !== threadId) {
        void (async () => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) sendNotification({ title: "Mythra Code task complete", body: `“${known?.name || known?.preview || "Cursor task"}” finished.` });
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
      // Reading account state is deliberately non-forcing: Codex manages its
      // own token refresh, and local thread hydration must not wait on an
      // avoidable network refresh before showing the user's history.
      void refreshAccountData(false);
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
    void hasLmStudioKey()
      .then(setLmStudioTokenStored)
      .catch(() => setLmStudioTokenStored(false));
  }, [checkRuntime, refreshAccountData, refreshClaudeStatus, refreshCursorStatus, refreshLMStudioModels, refreshOpenRouterModels]);

  useEffect(() => {
    void refreshLMStudioModels(settings.lmStudioBaseUrl);
  }, [refreshLMStudioModels, settings.lmStudioBaseUrl]);

  // Cursor sign-in (at startup or later) refreshes only the Cursor model
  // list, never the whole startup sequence above.
  useEffect(() => {
    if (cursorStatus?.loggedIn) void refreshCursorModels();
  }, [cursorStatus?.loggedIn, refreshCursorModels]);

  // The Claude catalog needs a signed-in CLI to answer, so it is read after
  // sign-in rather than as part of the startup sequence.
  useEffect(() => {
    if (claudeStatus?.available && claudeStatus.loggedIn) void refreshClaudeModels();
  }, [claudeStatus?.available, claudeStatus?.loggedIn, refreshClaudeModels]);

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
    setDraftThreadProvider(pendingHandoffForWorkspace?.targetProvider === projectDefaultProvider ? null : pendingHandoffForWorkspace?.targetProvider ?? null);
    setDraftThreadModel(pendingHandoffForWorkspace ? modelForProvider(pendingHandoffForWorkspace.targetProvider, "") : null);
    // Attachments are keyed by draft identity, so a workspace switch simply
    // selects a different draft. Clearing here would throw away files chosen
    // for a thread the user is about to come back to.
    setThreadSearch("");
    setSearchResults(null);
    if (!activeProject) setStudioOpen(false);
  }, [activeProject, activeWorkspace, claudeStatus?.available, cursorStatus?.available, loadThreads, pendingHandoffForWorkspace, projectDefaultProvider, runtimeStatus?.available]);

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
      // A restart may replace the app-server with a newer protocol version.
      // Let the next thread open probe pagination again.
      paginatedHistoryUnavailable = false;
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
      throw new Error("Sub-agent settings are ready, but another OpenAI, OpenRouter, or LM Studio task is still running. Your message was not sent; try again when that task finishes so Mythra Code can safely refresh the runtime without interrupting it.");
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

  const removeProject = async (project: Project) => {
    const isolatedCount = Object.values(threadWorktreesRef.current).filter(
      (record) => normalizedProjectPath(record.projectPath) === normalizedProjectPath(project.path)
        && record.status !== "removed",
    ).length;
    if (isolatedCount > 0) {
      setError(`Remove the ${isolatedCount} isolated worktree${isolatedCount === 1 ? "" : "s"} in this project from the Worktrees workspace tab before removing the project from Mythra Code.`);
      return;
    }
    const confirmed = await confirmDialog(`Remove “${project.name}” from Mythra Code?\n\nIts folder and every file inside it will remain untouched on your computer.`);
    if (!confirmed) return;
    const next = projects.filter((entry) => entry.id !== project.id);
    setProjects(next);
    if (activeProjectId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      if (!next.length) setWorkspaceMode("chat");
    }
  };

  const selectThreadRequestRef = useRef(0);
  const loadEarlier = useCallback(async (threadId: string) => {
    const store = useTaskStore.getState();
    const task = store.tasks[threadId];
    if (!task?.history.paginated || !task.history.hasMore || task.history.loading || !task.history.nextCursor) return;
    const requestId = ++historyRequestSequenceRef.current;
    historyRequestRef.current.set(threadId, requestId);
    store.setHistory(threadId, { loading: true });
    try {
      let page = normalizeThreadTurnsPage(await rpc<unknown>("thread/turns/list", {
        threadId,
        cursor: task.history.nextCursor,
        limit: OLDER_THREAD_TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      }));
      if (!page) throw new MalformedThreadHistoryPageError("Paginated thread history returned a malformed page");
      const currentState = useTaskStore.getState();
      if (
        historyRequestRef.current.get(threadId) !== requestId
        || currentState.activeThreadId !== threadId
        || currentState.tasks[threadId]?.history.nextCursor !== task.history.nextCursor
      ) return;
      const olderTurns = turnsFromDescendingPage(page);
      const history = timelineFromTurns(olderTurns);
      store.prependHistory(threadId, history.messages, history.activities, {
        nextCursor: page.nextCursor,
        hasMore: Boolean(page.nextCursor),
        loading: false,
        paginated: true,
      });
    } catch (reason) {
      if (historyRequestRef.current.get(threadId) !== requestId) return;
      store.setHistory(threadId, { loading: false });
      const unsupportedPagination = isPaginatedHistoryUnsupported(reason);
      if (unsupportedPagination || reason instanceof MalformedThreadHistoryPageError) {
        // A runtime can change underneath the app (for example after an
        // update). Recover with the known-safe full read and stop offering a
        // cursor that this runtime cannot serve. A malformed response also
        // falls back for this request, but must not globally disable a valid
        // pagination API for the rest of the session.
        if (unsupportedPagination) paginatedHistoryUnavailable = true;
        try {
          const fallback = await rpc<{ thread: Thread }>("thread/read", { threadId, includeTurns: true });
          const currentState = useTaskStore.getState();
          if (
            historyRequestRef.current.get(threadId) !== requestId
            || currentState.activeThreadId !== threadId
            || currentState.tasks[threadId]?.history.nextCursor !== task.history.nextCursor
          ) return;
          const fullHistory = timelineFromTurns(fallback.thread.turns);
          store.hydrateTask(threadId, fullHistory.messages, fullHistory.activities, task.workspacePath, {
            nextCursor: null,
            hasMore: false,
            loading: false,
            paginated: false,
          });
          if (activeThread?.id === threadId) setActiveThread(sidebarThread(fallback.thread));
          return;
        } catch (fallbackReason) {
          setError(friendlyError(fallbackReason));
          return;
        }
      }
      if (activeThread?.id === threadId) setError(friendlyError(reason));
    } finally {
      if (historyRequestRef.current.get(threadId) === requestId) {
        historyRequestRef.current.delete(threadId);
        const currentStore = useTaskStore.getState();
        if (currentStore.tasks[threadId]?.history.loading) currentStore.setHistory(threadId, { loading: false });
      }
    }
  }, [activeThread?.id]);

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
          const projectModel = activeProject?.overrides?.defaults?.model ?? settings.model;
          persistThreadModel(resolvedThread.id, modelForProvider("claude", projectModel));
        }
        bindThreadToProject(resolvedThread.id, activeWorkspace.path);
        rememberThread(resolvedThread);
        setActiveThread(resolvedThread);
        hydrateLocalProviderTask(resolvedThread.id, transcript, executionPath);
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
          const projectModel = activeProject?.overrides?.defaults?.model ?? settings.model;
          persistThreadModel(resolvedThread.id, modelForProvider("cursor", projectModel));
        }
        bindThreadToProject(resolvedThread.id, activeWorkspace.path);
        rememberThread(resolvedThread);
        setActiveThread(resolvedThread);
        hydrateLocalProviderTask(resolvedThread.id, transcript, executionPath);
        useTaskStore.getState().setActiveThread(resolvedThread.id);
        setStatus("Ready");
        return;
      }
      const provider = providerFromThread(thread, projectDefaultProvider);
      const projectModel = activeProject?.overrides?.defaults?.model ?? settings.model;
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
      // Mythra Code bridge during that resume—not one message later—so project
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
      if (selectThreadRequestRef.current !== requestId) {
        // A newer selection won while the bridge was starting. A freshly
        // captured session has no persisted policy pointing at it, so nothing
        // could ever revoke it — release it before abandoning this select.
        if (childBridge?.captured) void releaseChildAgentSession(childBridge.policy.sessionId);
        return;
      }
      if (childBridge?.captured || childBridge?.policyUpdated) {
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
        subagentsEnabled: Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")),
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
            if (/another OpenAI, OpenRouter, or LM Studio task is still running/i.test(friendlyError(reason))) {
              capabilityRefreshDeferred = true;
            } else {
              throw reason;
            }
          }
        }
      }
      const resumeParams = threadResumeParams(resumedSettings, thread.id, executionPath, { customAgents, modelContextWindow: provider === "openrouter" ? openRouterModels.find((entry) => entry.id === resumedSettings.model)?.context_length : provider === "lmstudio" ? lmStudioModels.find((entry) => entry.id === resumedSettings.model)?.maxContextLength : undefined, additionalWorkspaceRoots: isolation?.gitDir ? [isolation.gitDir] : [], childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true });
      const loaded = isolation?.status === "missing" || isolation?.status === "removed" || capabilityRefreshDeferred
        ? await loadThreadHistory("thread/read", { threadId: thread.id, includeTurns: false }, { threadId: thread.id, includeTurns: true })
        : await loadThreadHistory("thread/resume", resumeParams, threadResumeParams(resumedSettings, thread.id, executionPath, { customAgents, modelContextWindow: provider === "openrouter" ? openRouterModels.find((entry) => entry.id === resumedSettings.model)?.context_length : provider === "lmstudio" ? lmStudioModels.find((entry) => entry.id === resumedSettings.model)?.maxContextLength : undefined, additionalWorkspaceRoots: isolation?.gitDir ? [isolation.gitDir] : [], childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true }));
      const result = { thread: loaded.thread };
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
      const history = timelineFromTurns(loaded.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, executionPath, loaded.history);
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
    const label = activeThread.name || activeThread.preview || "Mythra Code thread";
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

  const startNewThreadWithProvider = async (provider: Provider) => {
    if (running) {
      setError("Stop the running task before starting a thread with another provider.");
      return;
    }
    if (activeThread) {
      if (activeThreadWorktree && activeThreadWorktree.status !== "removed") {
        setError("Provider handoff is unavailable while this conversation owns an isolated worktree. Apply or merge its changes, remove the worktree, and choose Continue shared before handing it off.");
        return;
      }
      const sourceProvider = providerFromThread(activeThread, projectDefaultProvider);
      const sourceTitle = activeThread.name || activeThread.preview || "Untitled task";
      if (!await confirmDialog(`Hand off the current thread to ${providerLabel(provider)}?\n\nMythra Code will start a separate provider thread in the same workspace with a bounded, visible copy of the conversation. The original thread remains unchanged.`)) return;
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
      setDraftThreadProvider(provider === projectDefaultProvider ? null : provider);
      setDraftThreadModel(provider === projectDefaultProvider ? null : modelForProvider(provider, ""));
      setDraftThreadIsolated(false);
      setError(null);
      requestAnimationFrame(() => composerRef.current?.setDraft(prompt));
      return;
    }
    if (pendingHandoffForWorkspace) setPendingHandoff({ ...pendingHandoffForWorkspace, targetProvider: provider });
    setActiveThread(null);
    useTaskStore.getState().setActiveThread(null);
    setDraftThreadProvider(provider === projectDefaultProvider ? null : provider);
    setDraftThreadModel(provider === projectDefaultProvider ? null : modelForProvider(provider, ""));
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
    lmStudioModels,
    runtimeStatus,
    claudeStatus,
    cursorStatus,
    account,
    openRouterReady,
    lmStudioReady,
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
    lmStudioModels,
    lmStudioBaseUrl: settings.lmStudioBaseUrl,
    readiness: childAgentReadiness,
    projectPathForThread: (threadId) => threadProjectBindingsRef.current?.[threadId],
    executionPathFor,
    isolationGitDirFor: (threadId) => threadWorktreesRef.current[threadId]?.gitDir,
    serviceNameFor: (threadId) => {
      const boundPath = threadProjectBindingsRef.current?.[threadId];
      return boundPath && chatWorkspacePath && normalizedProjectPath(boundPath) === normalizedProjectPath(chatWorkspacePath)
        ? "Mythra Code Chat"
        : "Mythra Code";
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
    beginRunCheckpoint,
    discardRunCheckpoint,
  });

  /**
   * Open one worker's own conversation.
   *
   * Every sub-agent — cross-provider or provider-native — is a real thread, so
   * the row's Open action is the same thread selection the sidebar performs.
   * The thread record may not have reached the sidebar list yet for a child
   * that has only just been discovered, so the remembered index is consulted
   * too, and a genuinely unresolvable id reports why instead of doing nothing.
   */
  const openSubAgentWorker = useCallback(async (worker: SubAgentWorker) => {
    const thread = threads.find((entry) => entry.id === worker.id)
      ?? knownThreadsRef.current?.[worker.id];
    if (!thread) {
      throw new Error("Mythra Code does not have this sub-agent's conversation yet. It appears in the Sub-agents inbox once its provider reports the thread.");
    }
    await selectThread(thread);
  // selectThread is redeclared every render and is not a dependency-stable
  // callback; the thread list is what this actually reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

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
      "Mythra Code sub-agent control: replace the sub-agent I just stopped.",
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
      await refreshAccountData(false);
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
      setError("Install the official Cursor Agent CLI first, then return here to sign in.");
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

  const archiveThreadRecord = async (thread: Thread, confirmArchive: boolean): Promise<boolean> => {
    const label = thread.name || thread.preview || "Untitled thread";
    const taskStatus = useTaskStore.getState().statuses[thread.id];
    if (taskStatus === "starting" || taskStatus === "running") {
      if (confirmArchive) setError(`Stop “${label}” before archiving it so its final output and transcript are preserved.`);
      return false;
    }
    if (archivingThreadIdsRef.current.has(thread.id)) return false;
    if (confirmArchive && !await confirmDialog(`Archive “${label}”?\n\nIt moves to the Archived list in the sidebar, where you can restore or permanently delete it.`)) return false;
    archivingThreadIdsRef.current.add(thread.id);
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
      return true;
    } catch (reason) {
      setError(friendlyError(reason));
      return false;
    } finally {
      archivingThreadIdsRef.current.delete(thread.id);
    }
  };

  const archiveThread = async (thread: Thread) => archiveThreadRecord(thread, true);

  const archiveAllThreadsInInbox = async () => {
    if (!activeWorkspace || workspaceKindThreads.length === 0) return;
    const kindLabel = threadKindView === "subagents" ? "sub-agent" : "main";
    const { ready, active } = partitionBulkArchiveThreads(
      workspaceKindThreads,
      useTaskStore.getState().statuses,
    );
    if (ready.length === 0) {
      setError(`Stop the active ${kindLabel} ${active.length === 1 ? "thread" : "threads"} before archiving this inbox.`);
      return;
    }
    const activeNote = active.length
      ? `\n\n${active.length} active ${active.length === 1 ? "thread" : "threads"} will remain in the inbox.`
      : "";
    if (!await confirmDialog(
      `Archive all ${ready.length} idle ${kindLabel} ${ready.length === 1 ? "thread" : "threads"} in “${activeWorkspace.name}”?`
      + `\n\nThey move to the Archived list, where they can be restored or permanently deleted.${activeNote}`,
    )) return;

    setError(null);
    let archived = 0;
    for (const thread of ready) {
      if (await archiveThreadRecord(thread, false)) archived += 1;
    }
    const failed = ready.length - archived;
    setStatus(`Archived ${archived} ${kindLabel} ${archived === 1 ? "thread" : "threads"}${active.length ? ` · ${active.length} active skipped` : ""}`);
    if (failed > 0) {
      setError(`${failed} ${kindLabel} ${failed === 1 ? "thread could" : "threads could"} not be archived. Try ${failed === 1 ? "it" : "them"} individually for details.`);
    }
    if (archived > 0) setArchivedOpen(true);
  };

  // Completion callbacks run before React has necessarily rendered the latest
  // task-store snapshot, so they enter through a ref and inspect the store
  // synchronously. A parent completion sweeps its settled children; a child
  // that genuinely outlives the parent sweeps itself when its own turn ends.
  autoArchiveCompletionRef.current = (completedThreadId) => {
    if (!settings.autoArchiveSubagentThreads) return;
    const childIds = autoArchiveSubagentCandidates({
      completedThreadId,
      links: childThreadLinks,
      statuses: useTaskStore.getState().statuses,
      archivedThreadIds: archivedThreads.map((record) => record.id),
    });
    for (const childThreadId of childIds) {
      const child = threads.find((thread) => thread.id === childThreadId) ?? knownThreadsRef.current?.[childThreadId];
      if (child) void archiveThreadRecord(child, false);
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

  const deleteThreadRecord = async (threadId: string, label: string, confirmDelete: boolean): Promise<boolean> => {
    const thread = threads.find((entry) => entry.id === threadId) ?? knownThreadsRef.current?.[threadId];
    const isolation = threadWorktreesRef.current[threadId];
    if (isolation && isolation.status !== "removed") {
      setError(`Remove “${isolation.branch}” from the Worktrees workspace tab before permanently deleting this thread.`);
      return false;
    }
    const taskStatus = useTaskStore.getState().statuses[threadId];
    if (taskStatus === "starting" || taskStatus === "running") {
      setError(`Stop “${label}” before deleting it so no model process continues working after the conversation is removed.`);
      return false;
    }
    const archived = archivedThreads.find((record) => record.id === threadId);
    let legacyClaudeTranscript = false;
    if (!thread && archived && !archived.provider) {
      try {
        legacyClaudeTranscript = Boolean(await loadClaudeTranscript(threadId));
      } catch (reason) {
        setError(friendlyError(reason));
        return false;
      }
    }
    const provider = thread
      ? providerFromThread(thread, "openai")
      : archived
        ? providerForArchivedThread(archived, legacyClaudeTranscript)
        : "openai";
    const localSubscription = provider === "claude" || provider === "cursor";
    if (confirmDelete && !await confirmDialog(`Permanently delete “${label}”?\n\nThis removes the conversation from ${localSubscription ? "Mythra Code" : "the Codex runtime"} and cannot be undone.`)) return false;
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
      // A deleted thread's attachment draft has nowhere to be sent.
      setAttachmentDrafts((current) => forgetAttachmentDraft(current, threadId));
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
      return true;
    } catch (reason) {
      setError(friendlyError(reason));
      return false;
    }
  };

  const deleteThreadForever = async (threadId: string, label: string) => deleteThreadRecord(threadId, label, true);

  const deleteAllArchivedThreads = async () => {
    if (!activeWorkspace || workspaceArchived.length === 0) return;
    const kindLabel = threadKindView === "subagents" ? "sub-agent" : "main";
    if (!await confirmDialog(
      `Permanently delete all ${workspaceArchived.length} archived ${kindLabel} ${workspaceArchived.length === 1 ? "thread" : "threads"} in “${activeWorkspace.name}”?`
      + "\n\nEvery conversation in this Archived section will be removed. This cannot be undone.",
    )) return;

    setError(null);
    let deleted = 0;
    for (const record of workspaceArchived) {
      if (await deleteThreadRecord(record.id, record.label, false)) deleted += 1;
    }
    const failed = workspaceArchived.length - deleted;
    setStatus(`Deleted ${deleted} archived ${kindLabel} ${deleted === 1 ? "thread" : "threads"}`);
    if (failed > 0) {
      setError(`${failed} archived ${kindLabel} ${failed === 1 ? "thread could" : "threads could"} not be deleted. Try ${failed === 1 ? "it" : "them"} individually for details.`);
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

  /**
   * Why the Review panel's AI review is unavailable, if it is. Claude Code and
   * Cursor Agent own their own review flow, so the control explains that up
   * front instead of accepting a click and answering with an error.
   */
  const reviewDisabledReason = activeThread && isLocalSubscriptionThread(activeThread)
    ? `Inline review is available for OpenAI, OpenRouter, and LM Studio threads. Ask ${providerLabel(providerFromThread(activeThread, projectDefaultProvider))} to review the project in the conversation instead.`
    : undefined;

  /**
   * Whether the project folder is a Git repository. `workspaceGitInfo` is the
   * local truth; the GitHub probe is only consulted as a fallback because it
   * can fail for reasons that say nothing about the repository (offline, no
   * `gh`). A failed probe leaves the state `unknown`, which keeps purely local
   * Git actions available instead of disabling them all.
   */
  const gitRepositoryState: GitRepositoryState = workspaceGitInfo && !workspaceGitInfo.error
    ? (workspaceGitInfo.isRepo ? "ready" : "absent")
    : githubRepoStatus
      ? (githubRepoStatus.isRepo ? "ready" : "absent")
      : "unknown";

  const defaultRepositoryName = activeProject?.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";

  // Derived dock inputs are memoized so an unrelated app rerender (a keystroke
  // in the composer, a streamed token) does not rebuild the checkpoint list,
  // the workflow list, and the audit table on every frame.
  const workspaceCheckpoints = useMemo(() => checkpoints.filter((item) => {
    if (!activeProject) return false;
    if (item.workspacePath) {
      const path = normalizedProjectPath(item.workspacePath);
      return path === normalizedProjectPath(activeExecutionPath)
        || Boolean(activeThread && item.threadId === activeThread.id && path === normalizedProjectPath(activeProject.path));
    }
    return Boolean(activeThread && item.threadId === activeThread.id);
  }), [activeExecutionPath, activeProject, activeThread, checkpoints]);

  const projectWorkflows = useMemo(
    () => workflows.filter((workflow) => workflow.projectId === activeProject?.id && workflow.enabled),
    [activeProject?.id, workflows],
  );

  const promptAudit = useMemo(() => [
    { label: "Base instruction", value: effectiveSettings.systemPrompt ? `${activeProject?.overrides?.systemPrompt ? (activeProject.overrides.systemPromptMode === "append" ? "Mythra Code + project" : "project") : "Mythra Code"} · ${effectiveSettings.systemPrompt.length} chars` : "empty" },
    { label: "Developer instruction", value: `Mythra Code internal · ${mythraCodeDeveloperInstructions(effectiveSettings.subagentsEnabled, effectiveSettings.subagentsEnabled).length} chars` },
    { label: "AGENTS.md discovery", value: settings.projectInstructionsEnabled ? "enabled · up to 32 KB" : "disabled" },
    { label: "Model", value: effectiveSettings.model || "provider default" },
    { label: "Reasoning", value: effectiveSettings.reasoningEffort },
    { label: "Sub-agents", value: effectiveSettings.subagentsEnabled ? `on · max ${effectiveSettings.subagentMax}` : "off" },
    { label: "Cross-provider", value: effectiveSettings.subagentsEnabled ? childAgentSummary : "off" },
    { label: "Skills", value: skillsFolder ? `${skills.filter((skill) => skill.enabled).length} enabled · local folder` : "no folder selected" },
    { label: "Permissions", value: permissionLabel(effectiveSettings.permission) },
    { label: "Service tier", value: settings.serviceTier || "standard" },
  ], [activeProject, childAgentSummary, effectiveSettings, settings.projectInstructionsEnabled, settings.serviceTier, skills, skillsFolder]);

  const startReview = async () => {
    if (!activeThread) return;
    if (reviewDisabledReason) {
      setError(reviewDisabledReason);
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
      setError(`${providerLabel(providerFromThread(activeThread, projectDefaultProvider))} manages its own context compaction. Mythra Code’s manual compact action is available for OpenAI, OpenRouter, and LM Studio threads.`);
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
      // A cross-provider child is an Mythra Code-owned thread, so its timeline
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
        hydrateLocalProviderTask(threadId, transcript, childThread.cwd);
        useTaskStore.getState().setActiveThread(threadId);
        setStudioOpen(false);
        return;
      }
      const loaded = await loadThreadHistory("thread/read", { threadId, includeTurns: false }, { threadId, includeTurns: true });
      const result = { thread: loaded.thread };
      const nativeLink = nativeAgentLinks[threadId];
      const logicalPath = threadProjectBindingsRef.current?.[threadId]
        ?? (nativeLink ? threadProjectBindingsRef.current?.[nativeLink.rootThreadId] : undefined)
        ?? activeWorkspace?.path;
      if (logicalPath) bindThreadToProject(result.thread.id, logicalPath);
      rememberThread(result.thread);
      setThreads((current) => upsertThread(current, result.thread));
      setActiveThread(result.thread);
      const history = timelineFromTurns(loaded.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, result.thread.cwd, loaded.history);
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
      const modelProvider = runtimeModelProviderId(effectiveSettings.provider);
      const forkParams = { threadId: checkpoint?.threadId ?? activeThread.id, lastTurnId: checkpoint?.turnId, cwd: activeWorkspace?.path, runtimeWorkspaceRoots: activeWorkspace ? [activeWorkspace.path] : undefined, model: effectiveSettings.model, ...(modelProvider ? { modelProvider } : {}), config: threadRuntimeConfig(effectiveSettings, { customAgents, modelContextWindow: effectiveSettings.provider === "openrouter" ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length : effectiveSettings.provider === "lmstudio" ? lmStudioModels.find((entry) => entry.id === effectiveSettings.model)?.maxContextLength : undefined }), baseInstructions: effectiveSettings.systemPrompt, developerInstructions: mythraCodeDeveloperInstructions(false) };
      let result: { thread: Thread };
      let forkedWithoutTurns = false;
      try {
        result = await rpc<{ thread: Thread }>("thread/fork", { ...forkParams, excludeTurns: true });
        forkedWithoutTurns = true;
      } catch (reason) {
        if (!isPaginatedHistoryUnsupported(reason)) throw reason;
        paginatedHistoryUnavailable = true;
        result = await rpc<{ thread: Thread }>("thread/fork", forkParams);
      }
      if (activeWorkspace) bindThreadToProject(result.thread.id, activeWorkspace.path);
      const loaded = forkedWithoutTurns
        ? await loadThreadHistory("thread/read", { threadId: result.thread.id, includeTurns: false }, { threadId: result.thread.id, includeTurns: true })
        : { thread: sidebarThread(result.thread), turns: result.thread.turns ?? [], history: { nextCursor: null, hasMore: false, loading: false, paginated: false } };
      rememberThread(loaded.thread);
      persistThreadModel(result.thread.id, effectiveSettings.model);
      persistThreadReasoning(result.thread.id, { reasoningEffort: effectiveSettings.reasoningEffort, ultra: effectiveSettings.ultra });
      setActiveThread(loaded.thread);
      const history = timelineFromTurns(loaded.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeWorkspace?.path, loaded.history);
      useTaskStore.getState().setActiveThread(result.thread.id);
      setStudioOpen(false);
      void loadThreads(activeWorkspace);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const rollbackTurn = async () => {
    if (!activeThread) return;
    if (!await confirmDialog("Undo the last turn?\n\nThis permanently removes the latest exchange from the conversation. Files changed by the turn are not reverted.")) return;
    try {
      const result = await rpc<{ thread: Thread }>("thread/rollback", { threadId: activeThread.id, numTurns: 1 });
      rememberThread(result.thread);
      setActiveThread(sidebarThread(result.thread));
      const history = timelineFromTurns(result.thread.turns);
      useTaskStore.getState().hydrateTask(result.thread.id, history.messages, history.activities, activeExecutionPath, {
        nextCursor: null,
        hasMore: false,
        loading: false,
        paginated: false,
      });
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
    if (!await confirmDialog(
      `Apply all changes from “${activeThreadWorktree.branch}” to the shared project?\n\n`
      + `Mythra Code will save the shared project as a safety checkpoint first. The isolated branch and worktree remain unchanged, and Git staging and commits are not modified.${recreationWarning}`,
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
    if (!await confirmDialog(
      `Merge “${activeThreadWorktree.branch}” into the source project's current branch?\n\n`
      + "Both working folders must be clean and all isolated changes must be committed. Mythra Code saves a safety checkpoint first and aborts automatically if Git reports a conflict.",
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
      const destructive = !latest.clean || latest.ignoredFileCount > 0 || latest.ahead > 0;
      const details = [
        latest.changedFiles ? `${latest.changedFiles} changed or untracked file${latest.changedFiles === 1 ? "" : "s"}` : "",
        latest.ahead ? `${latest.ahead} unmerged commit${latest.ahead === 1 ? "" : "s"}` : "",
        latest.ignoredFileCount ? `${latest.ignoredFileCount} ignored file${latest.ignoredFileCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      if (!await confirmDialog(
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

  const continueThreadInSharedProject = async () => {
    if (!activeThread || !activeThreadWorktree) return;
    if (activeThreadWorktree.status === "missing") {
      setError("Recreate the missing worktree from its branch, then remove it before continuing this conversation in the shared project.");
      return;
    }
    if (!await confirmDialog(
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
    if (!await confirmDialog(
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
    setAttachments((current) => withAttachedPaths(current, paths));
  }, [setAttachments]);

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
        // Pasted bytes are known to be an image regardless of the extension
        // the native side chose for the temporary file.
        setAttachments((current) => (current.some((entry) => entry.path === path)
          ? current
          : [...current, { ...attachmentRecord(path), kind: "image" as const }]));
      } catch (reason) {
        setError(friendlyError(reason));
      }
    }
  }, [setAttachments]);

  const refreshGitHubRepo = useCallback(async (cwd = activeExecutionPath || activeProject?.path || "") => {
    const refreshSequence = ++githubRepoRefreshSequenceRef.current;
    if (!cwd) {
      setGithubRepoStatus(null);
      setGithubRepoError("");
      return;
    }
    try {
      const next = await getGitHubRepoStatus(cwd);
      if (githubRepoRefreshSequenceRef.current !== refreshSequence) return;
      setGithubRepoStatus(next);
      setGithubRepoError("");
    } catch (reason) {
      if (githubRepoRefreshSequenceRef.current !== refreshSequence) return;
      setGithubRepoStatus(null);
      setGithubRepoError(friendlyError(reason));
    }
  }, [activeExecutionPath, activeProject?.path]);

  useEffect(() => {
    gitProjectSequenceRef.current += 1;
    void refreshGitHubRepo();
    setGitOutput("");
    setGitCommitBusy(false);
    setGitCommitSuccess("");
  }, [activeExecutionPath, activeProject?.id, activeProject?.name, refreshGitHubRepo]);

  const runGitAction = async (action: GitPanelAction, commitMessageInput?: string) => {
    if (!activeProject) return;
    const unavailable = gitActionUnavailableReason(action, effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    const commandPath = activeExecutionPath || activeProject.path;
    const projectSequence = gitProjectSequenceRef.current;
    const isCurrentProject = () => gitProjectSequenceRef.current === projectSequence;
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
      if (!isCurrentProject()) return;
      setGitOutput(output);
      void pushCompletionNote().then((note) => {
        if (!note || !isCurrentProject()) return;
        setGitOutput((current) => current === output ? `${output}\n\n${note}` : current);
      });
    };
    if (action === "commit" || action === "commitPush") {
      if (action === "commitPush" && !pushCommand) {
        setGitOutput("Check out a named branch before committing and pushing to GitHub.");
        return;
      }
      const commitMessage = (commitMessageInput ?? "").trim() || DEFAULT_GIT_COMMIT_MESSAGE;
      const stageCommand = ["git", "add", "--all"];
      const commitCommand = ["git", "commit", "-m", commitMessage];
      setGitCommitBusy(true);
      setGitCommitSuccess("");
      try {
        const stage = await executeCommand(stageCommand, commandPath, gitRoots);
        if (stage.exitCode !== 0) {
          if (isCurrentProject()) setGitOutput(`$ ${stageCommand.join(" ")}\n${stage.stdout}${stage.stderr}\n[exit ${stage.exitCode}]`);
          return;
        }
        const commit = await executeCommand(commitCommand, commandPath, gitRoots);
        if (commit.exitCode !== 0) {
          if (isCurrentProject()) setGitOutput(`$ ${stageCommand.join(" ")}\n${stage.stdout}${stage.stderr}\n[exit ${stage.exitCode}]\n\n$ ${commitCommand.join(" ")}\n${commit.stdout}${commit.stderr}\n[exit ${commit.exitCode}]`);
          return;
        }
        const commitResultIsVisible = isCurrentProject();
        if (commitResultIsVisible) {
          setGitCommitSuccess(`“${commitMessage}” was saved to this repository.`);
        }
        if (action === "commit") {
          if (!commitResultIsVisible) return;
          setGitOutput(`$ ${stageCommand.join(" ")}\n${stage.stdout}${stage.stderr}\n[exit ${stage.exitCode}]\n\n$ ${commitCommand.join(" ")}\n${commit.stdout}${commit.stderr}\n[exit ${commit.exitCode}]`);
          showSuccessToast("Changes committed locally");
          void refreshGitHubRepo(commandPath);
          return;
        }
        const push = await executeCommand(pushCommand!, commandPath, gitRoots);
        if (!isCurrentProject()) return;
        const output = `$ ${stageCommand.join(" ")}\n${stage.stdout}${stage.stderr}\n[exit ${stage.exitCode}]\n\n$ ${commitCommand.join(" ")}\n${commit.stdout}${commit.stderr}\n[exit ${commit.exitCode}]\n\n$ ${pushCommand!.join(" ")}\n${push.stdout}${push.stderr}\n[exit ${push.exitCode}]`;
        if (push.exitCode === 0) {
          showPushOutput(output);
          showSuccessToast("Changes committed locally and pushed to GitHub");
          void refreshGitHubRepo(commandPath);
        } else {
          setGitOutput(output);
          showSuccessToast("Changes committed locally; GitHub push needs attention");
        }
      } catch (reason) {
        if (isCurrentProject()) setGitOutput(friendlyError(reason));
      } finally {
        if (isCurrentProject()) setGitCommitBusy(false);
      }
      return;
    }
    let command: string[];
    if (action === "status") command = ["git", "status", "--short", "--branch"];
    else if (action === "diff") command = ["git", "diff", "--stat", "--patch"];
    else if (action === "stage") command = ["git", "add", "--all"];
    else if (action === "revert") {
      if (!await confirmDialog("Revert all tracked staged and working-tree changes? Untracked files will be kept.")) return;
      command = ["git", "restore", "--staged", "--worktree", "."];
    } else if (action === "fetch") command = ["git", "fetch", "--prune", "origin"];
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
      if (!await confirmDialog("Create a draft pull request on the configured GitHub remote?")) return;
      command = githubCliCommand(githubStatus?.path || "gh", "pr");
    }
    try {
      const result = await executeCommand(command, commandPath, gitRoots);
      if (!isCurrentProject()) return;
      const combined = `${result.stdout}${result.stderr || ""}`;
      const output = combined.includes("not a git repository")
        ? "This project folder is not a Git repository yet. Initialize Git from the terminal to enable these workflows."
        : `$ ${command.join(" ")}\n${combined}\n[exit ${result.exitCode}]`;
      if (action === "push" && result.exitCode === 0) showPushOutput(output);
      else setGitOutput(output);
      // The Git console shows its own command output. It deliberately does not
      // write the Review panel's diff: `git diff --stat --patch` is a different
      // baseline than the review diff, and overwriting it made Review claim to
      // be showing something it was not.
      if (result.exitCode === 0) void refreshGitHubRepo(commandPath);
    } catch (reason) {
      if (isCurrentProject()) setGitOutput(friendlyError(reason));
    }
  };

  const attachActiveGitHubRemote = async (url: string) => {
    if (!activeProject || !url.trim()) return;
    const unavailable = gitActionUnavailableReason("attach", effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    setGithubBusy(true);
    try {
      const next = await attachGitHubRemote(activeExecutionPath || activeProject.path, url.trim());
      setGithubRepoStatus(next);
      showSuccessToast("GitHub repository attached");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setGithubBusy(false);
    }
  };

  const createActiveGitHubRepository = async (name: string, visibility: "private" | "public") => {
    if (!activeProject || !name.trim()) return;
    const unavailable = gitActionUnavailableReason("create", effectiveSettings.permission);
    if (unavailable) {
      setGitOutput(unavailable);
      return;
    }
    setGithubBusy(true);
    try {
      const next = await createGitHubRepository(activeExecutionPath || activeProject.path, name.trim(), visibility);
      setGithubRepoStatus(next);
      showSuccessToast(`${visibility === "private" ? "Private" : "Public"} GitHub repository created`);
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
      showSuccessToast("Finish GitHub sign-in in Terminal; Mythra Code will connect automatically");
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
    const destination = joinPath(parent, safeName);
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
    // The action's output belongs to the folder it runs in, not to whichever
    // project happens to be selected when it finishes.
    const commandPath = activeExecutionPath || activeProject.path;
    setStudioTab("terminal");
    terminal.append(`${terminal.appendedLength(commandPath) ? "\n" : ""}$ ${action.command}\n`, commandPath);
    try {
      const result = await executeCommand(shellCommand(action.command), commandPath, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
      terminal.append(`${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`, commandPath);
      void auditEvent("action.completed", { actionId: action.id, command: action.command, exitCode: result.exitCode }, activeThreadId ?? undefined).catch(() => {});
    } catch (reason) {
      terminal.append(`${friendlyError(reason)}\n`, commandPath);
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
    if (action === "revert" && !await confirmDialog(`Revert changes to ${path}?`)) return;
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
    const selected = await open({ directory: true, multiple: false, title: "Choose your Mythra Code skills folder" });
    if (!selected || Array.isArray(selected)) return;
    setSkillsFolder(selected);
    await refreshLocalSkills(selected, skillAliases, disabledSkillPaths, removedSkillPaths);
  };

  const importSkills = async () => {
    if (!skillsFolder) return;
    const selected = await open({ directory: false, multiple: true, title: "Import Markdown skills", filters: [{ name: "Markdown", extensions: ["md", "markdown"] }] });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    setSkillsBusy(true);
    setSkillsError("");
    try {
      const imported = await importLocalSkills(skillsFolder, paths);
      const nextRemoved = removedSkillPaths.filter((path) => !imported.includes(path));
      if (nextRemoved.length !== removedSkillPaths.length) setRemovedSkillPaths(nextRemoved);
      await refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, nextRemoved);
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
      const createdPath = await createLocalSkill(skillsFolder, name, instructions);
      const nextRemoved = removedSkillPaths.filter((path) => path !== createdPath);
      if (nextRemoved.length !== removedSkillPaths.length) setRemovedSkillPaths(nextRemoved);
      await refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, nextRemoved);
      return true;
    } catch (reason) {
      setSkillsError(friendlyError(reason));
      return false;
    }
  };

  const readSkill = async (path: string): Promise<string> => {
    if (!skillsFolder) throw new Error("Choose a skills folder before editing a skill.");
    return readLocalSkill(skillsFolder, path);
  };

  const updateSkill = async (path: string, content: string, original: string): Promise<void> => {
    if (!skillsFolder) throw new Error("Choose a skills folder before editing a skill.");
    setSkillsBusy(true);
    setSkillsError("");
    try {
      await updateLocalSkill(skillsFolder, path, content, original);
      await refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, removedSkillPaths);
    } catch (reason) {
      setSkillsError(friendlyError(reason));
      throw reason;
    } finally {
      setSkillsBusy(false);
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
    setSkills(resolveLocalSkills(skillFiles, next, disabledSkillPaths, removedSkillPaths));
    setSkillsError("");
    return true;
  };

  const toggleSkill = (path: string) => {
    const next = disabledSkillPaths.includes(path) ? disabledSkillPaths.filter((candidate) => candidate !== path) : [...disabledSkillPaths, path];
    setDisabledSkillPaths(next);
    setSkills(resolveLocalSkills(skillFiles, skillAliases, next, removedSkillPaths));
  };

  const restoreSkill = async (path: string): Promise<boolean> => {
    const nextRemoved = removedSkillPaths.filter((candidate) => candidate !== path);
    setRemovedSkillPaths(nextRemoved);
    setSkillsError("");
    try {
      await refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, nextRemoved);
      return true;
    } catch (reason) {
      setSkillsError(friendlyError(reason));
      return false;
    }
  };

  const removeSkill = async (path: string, deleteSource: boolean): Promise<boolean> => {
    if (!skillsFolder) return false;
    setSkillsError("");
    try {
      if (deleteSource) await deleteLocalSkill(skillsFolder, path);
      const nextRemoved = deleteSource
        ? removedSkillPaths.filter((candidate) => candidate !== path)
        : [...new Set([...removedSkillPaths, path])];
      const nextDisabled = deleteSource
        ? disabledSkillPaths.filter((candidate) => candidate !== path)
        : disabledSkillPaths;
      const nextAliases = deleteSource
        ? Object.fromEntries(Object.entries(skillAliases).filter(([candidate]) => candidate !== path))
        : skillAliases;
      setRemovedSkillPaths(nextRemoved);
      setDisabledSkillPaths(nextDisabled);
      setSkillAliases(nextAliases);
      await refreshLocalSkills(skillsFolder, nextAliases, nextDisabled, nextRemoved);
      return true;
    } catch (reason) {
      setSkillsError(friendlyError(reason));
      return false;
    }
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
    workspaceOpen: studioOpen && Boolean(activeProject),
    workspaceAvailable: Boolean(activeProject),
    toggleWorkspace: () => (studioOpen ? setStudioOpen(false) : openStudio(studioTab)),
    closeWorkspace: () => setStudioOpen(false),
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
    lmStudioReady,
    lmStudioModels,
    customAgents,
    ensureSkillRoots,
    bindThreadToProject,
    beginRunCheckpoint,
    finalizeRunCheckpoint,
    discardRunCheckpoint,
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
      if (commandCount && !await confirmDialog(`Run “${workflow.name}” now?\n\nIt contains ${commandCount} shell command${commandCount === 1 ? "" : "s"} that will run with the saved ${workflow.run.permission} permission setting.`)) return;
      await runWorkflow(workflow.id, "manual", variables);
    },
    [runWorkflow, workflowRuns],
  );

  useScheduler({
    schedules: scheduledTasks,
    updateSchedule,
    recordRun: recordScheduleRun,
    projects,
    chatWorkspace,
    settings,
    runtimeAvailable: Boolean(runtimeStatus?.available),
    chatGptConnected: account?.type === "chatgpt",
    openRouterReady,
    lmStudioReady,
    lmStudioModels,
    ensureSkillRoots,
    bindThreadToProject,
    beginRunCheckpoint,
    discardRunCheckpoint,
    onThreadStarted: (workspace) => {
      if (workspace.isChat ? workspaceMode === "chat" : activeProject?.id === workspace.id) {
        void loadThreads(workspace);
      }
    },
  });

  return (
    <div ref={shellRef} className="app-shell" data-theme={previewTheme ?? projectDefaults?.theme ?? settings.theme} data-color-scheme={themeColorScheme(previewTheme ?? projectDefaults?.theme ?? settings.theme)} data-effort-slider={previewEffortSlider ?? projectDefaults?.effortSlider ?? settings.effortSlider} data-openai-logo={settings.openAiLogo} data-claude-logo={settings.claudeLogo} data-cursor-logo={settings.cursorLogo} style={{ zoom: (settings.uiScale || 100) / 100 }}>
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
            <img src="/mythra-code-glyph.svg" alt="" />
          </div>
          <span>Mythra Code</span>
          <button className="icon-button subtle collapse-button" onClick={() => setSidebarOpen(false)} title="Hide sidebar" aria-label="Hide sidebar">
            <PanelLeftClose size={17} />
          </button>
        </div>

        <button className="new-thread-button" onClick={newThread} disabled={!activeWorkspace} title={activeWorkspace?.isChat ? "Start a chat without a project folder" : activeProject ? `Start a thread in ${activeProject.name}` : "Select a workspace first"}>
          <Plus size={16} />
          <span>New thread</span>
          <kbd>{primaryModifierLabel()}+N</kbd>
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
                    { label: "Remove from Mythra Code", icon: <Trash2 size={13} />, danger: true, onSelect: () => removeProject(project) },
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
            <div className="thread-search-actions">
              <label className="thread-search">
                <Search size={11} />
                <input value={threadSearch} onChange={(event) => setThreadSearch(event.target.value)} placeholder={`Search ${workspaceMode === "chat" ? "chats" : (activeProject?.name ?? "threads")}…`} />
              </label>
              <button
                className="thread-bulk-button"
                onClick={() => void archiveAllThreadsInInbox()}
                disabled={workspaceKindThreads.length === 0}
                title={`Archive all ${threadKindView === "subagents" ? "sub-agent" : "main"} threads in this ${workspaceMode === "chat" ? "workspace" : "project"}`}
              >
                <Archive size={12} />
                <span>Archive all</span>
              </button>
            </div>
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
                    provider={providerFromThread(thread, projectDefaultProvider)}
                    providerName={providerLabel(providerFromThread(thread, projectDefaultProvider))}
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
              <div className="archived-header">
                <button className="archived-toggle" onClick={() => setArchivedOpen((open) => !open)} aria-expanded={archivedOpen}>
                  <Archive size={12} />
                  <span>Archived</span>
                  <span className="thread-count">{workspaceArchived.length}</span>
                  <ChevronDown className={archivedOpen ? "open" : ""} size={12} />
                </button>
                <button
                  className="archived-delete-all"
                  onClick={() => void deleteAllArchivedThreads()}
                  title={`Permanently delete all archived ${threadKindView === "subagents" ? "sub-agent" : "main"} threads in this ${workspaceMode === "chat" ? "workspace" : "project"}`}
                >
                  <Trash2 size={11} />
                  <span>Delete all</span>
                </button>
              </div>
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
              <Search size={13} aria-hidden="true" />
              <span>Search</span>
              <kbd>{primaryModifierLabel()}+K</kbd>
            </button>
            <div className="runtime-status">
              {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
              <span>{status}</span>
            </div>
            {headerUsageView && (
              <button
                className={`topbar-usage-chip ${effectiveSettings.provider}`}
                type="button"
                title={headerUsageView.title}
                aria-label={`${headerUsageView.title}. ${headerUsageView.needsConnection ? "Open Models & accounts" : "Open usage details"}`}
                onClick={() => {
                  if (headerUsageView.needsConnection) {
                    openSettings("models");
                  } else if (activeProject) {
                    openStudio("usage");
                  } else {
                    openSettings("usage");
                  }
                }}
              >
                <Gauge size={13} aria-hidden="true" />
                <span>{headerUsageView.text}</span>
              </button>
            )}
            <ThreadProviderControl
              provider={effectiveSettings.provider}
              model={effectiveSettings.model}
              defaultProvider={projectDefaultProvider}
              threadStarted={Boolean(activeThread)}
              disabled={!activeWorkspace || running}
              onProvider={startNewThreadWithProvider}
              onDefaultSettings={() => openSettings(activeProject ? "projects" : "models")}
            />
            <button className={`workspace-tools-trigger studio-toggle ${studioOpen ? "active" : ""}`} onClick={() => (studioOpen ? setStudioOpen(false) : openStudio(studioTab))} title={activeProject ? `${studioOpen ? "Close" : "Open"} project workspace tools (${workspaceShortcutLabel()})` : "Workspace tools are available inside projects"} aria-label={studioOpen ? "Close workspace tools" : "Open workspace tools"} aria-expanded={studioOpen} disabled={!activeProject}>
              <PanelRight size={17} />
              <span>Workspace</span>
              <kbd>{workspaceShortcutLabel()}</kbd>
            </button>
          </div>
        </header>

        {appUpdater.phase === "available" && (
          <div className="app-update-banner" role="status">
            <span className="app-update-banner-icon">
              <Download size={15} />
            </span>
            <span>
              <strong>Mythra Code {appUpdater.availableVersion} is ready</strong>
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
                    <ConversationTimeline threadId={activeThreadId} running={running} thinkingLabel={activeWorkspace.isChat ? "Thinking in normal chat" : `Working in ${activeProject?.name}`} approval={inlineApproval} provider={effectiveSettings.provider} onLoadEarlier={() => void loadEarlier(activeThreadId)} searchQuery={convSearchOpen ? convSearchQuery : ""} searchActiveMatch={convSearchIndex} onSearchMatches={setConvSearchCount} onEditMessage={editMessageIntoComposer} onApprovalRespond={respondToApproval} />
                  </Suspense>
                </ErrorBoundary>
              )}
            </section>

            {/* Ambient glow tints to the active provider and breathes while a turn runs. */}
            <section className={`composer-zone ambiance-${effectiveSettings.provider} ${running ? "ambiance-live" : ""}`}>
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
                threadKey={attachmentKey}
                running={running}
                childrenRunning={childrenRunning}
                queueing={Boolean(running && activeThread)}
                canSteer={Boolean(activeThread && taskStatus === "running")}
                dropActive={dropActive}
                placeholder={running && activeThread ? "Queue a follow-up for after this run…" : activeWorkspace.isChat ? "Ask anything — no project folder attached…" : `Ask Mythra Code to work in ${activeProject?.name ?? "this project"}…`}
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
                    {effectiveSettings.provider === "openai" && <ModelPowerControl model={effectiveSettings.model || DEFAULT_OPENAI_MODEL} effort={effectiveSettings.reasoningEffort} fast={settings.serviceTier === "priority"} runtimeModels={runtimeModels} favorites={favoriteModels(modelFavorites, "openai")} onToggleFavorite={(model) => toggleModelFavorite("openai", model)} onModel={persistComposerModel} onEffort={persistComposerReasoning} onFast={(fast) => persistSettings({ ...settings, serviceTier: fast ? "priority" : null })} />}
                    {effectiveSettings.provider === "openrouter" && (
                      <OpenRouterModelControl
                        model={effectiveSettings.model}
                        effort={effectiveSettings.reasoningEffort}
                        models={openRouterModels}
                        loading={openRouterModelsLoading}
                        error={openRouterModelsError}
                        searching={openRouterSearching}
                        favorites={favoriteModels(modelFavorites, "openrouter")}
                        onToggleFavorite={(model) => toggleModelFavorite("openrouter", model)}
                        onModel={(model) => {
                          persistComposerModel(model);
                        }}
                        onEffort={persistComposerReasoning}
                        onRefresh={() => void refreshOpenRouterModels()}
                        onDiscover={(query) => void discoverOpenRouterModels(query)}
                      />
                    )}
                    {effectiveSettings.provider === "lmstudio" && (
                      <LMStudioModelControl
                        model={effectiveSettings.model}
                        models={lmStudioModels}
                        effort={effectiveSettings.reasoningEffort}
                        loading={lmStudioModelsLoading}
                        error={lmStudioModelsError}
                        favorites={favoriteModels(modelFavorites, "lmstudio")}
                        onToggleFavorite={(model) => toggleModelFavorite("lmstudio", model)}
                        onRefresh={() => void refreshLMStudioModels(settings.lmStudioBaseUrl)}
                        onModel={persistComposerModel}
                        onEffort={persistComposerReasoning}
                      />
                    )}
                    {effectiveSettings.provider === "claude" && <ClaudeModelControl model={effectiveSettings.model || DEFAULT_CLAUDE_MODEL} effort={effectiveSettings.reasoningEffort} models={claudeModels} loading={claudeModelsLoading} error={claudeModelsError} favorites={favoriteModels(modelFavorites, "claude")} onToggleFavorite={(model) => toggleModelFavorite("claude", model)} onRefresh={() => void refreshClaudeModels()} onModel={(model) => persistComposerModel(model)} onEffort={persistComposerReasoning} />}
                    {effectiveSettings.provider === "cursor" && <CursorModelControl model={effectiveSettings.model || DEFAULT_CURSOR_MODEL} models={cursorModels} effort={effectiveSettings.reasoningEffort} loading={cursorModelsLoading} favorites={favoriteModels(modelFavorites, "cursor")} onToggleFavorite={(model) => toggleModelFavorite("cursor", model)} onRefresh={() => void refreshCursorModels()} onModel={(model) => persistComposerModel(model)} onEffort={persistComposerReasoning} />}
                    {running && activeThreadId && deferredReasoningNoticeThreads.has(activeThreadId) && (
                      <p className="composer-reasoning-notice" role="status" aria-live="polite">
                        Reasoning change will apply to the next prompt.
                      </p>
                    )}
                  </>
                }
                controls={
                  <>
                    <div className="permission-control" ref={permissionControlRef}>
                      <button className="toolbar-button" onClick={() => setPermissionOpen((open) => !open)} aria-haspopup="menu" aria-expanded={permissionOpen}>
                        <PermissionIcon mode={effectiveSettings.permission} />
                        {permissionLabel(effectiveSettings.permission)}
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
                      policy={activeThreadSubagentPolicy}
                      capturedPolicy={activeDelegationPolicy ?? null}
                      mode={subagentPolicyMode}
                      readiness={childAgentReadiness}
                      workers={subAgentWorkers}
                      parentActive={running || queuedTurns.length > 0}
                      scopeLabel={activeProject ? activeProject.name : "Chats & project defaults"}
                      projectOverride={!activeDelegationPolicy && Boolean(activeProject?.overrides?.subagents)}
                      presets={settings.childAgentPresets}
                      modelCatalogs={subAgentModelCatalogs}
                      modelFavorites={modelFavorites}
                      onToggleModelFavorite={toggleModelFavorite}
                      onChange={activeDelegationPolicy ? persistActiveThreadSubagentPolicy : persistComposerSubagentPolicy}
                      onOpenSettings={() => openSettings("agents")}
                      onOpenWorker={openSubAgentWorker}
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
                Mythra Code can make mistakes. Review commands and changes before shipping.
                {contextPercent !== null ? (
                  <span className={`context-meter ${contextPercent > 80 ? "warn" : ""}`}>
                    {" "}
                    · Context <Odometer value={String(Math.round(contextPercent))} label={`${Math.round(contextPercent)} percent`} />% used
                    {costEstimate ? <> · <Odometer value={costEstimate} /></> : null}
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
            reviewDiff={reviewDiff}
            reviewDisabledReason={reviewDisabledReason}
            agents={agentRecords}
            terminalOutput={terminal.outputStore}
            terminalRunning={terminal.running}
            terminalRunningCommand={terminal.runningCommand}
            terminalRunningElsewhere={terminal.runningElsewhere}
            commandsReadOnly={effectiveSettings.permission === "read-only"}
            checkpoints={workspaceCheckpoints}
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
            gitCommitSuccess={gitCommitSuccess}
            gitCommitBusy={gitCommitBusy}
            gitRepositoryState={gitRepositoryState}
            gitRepositoryStateDetail={githubRepoError || workspaceGitInfo?.error || undefined}
            gitInitializing={gitInitializing}
            githubAuthenticated={Boolean(githubStatus?.authenticated)}
            githubRepoStatus={githubRepoStatus}
            githubRepoError={githubRepoError}
            gitActionsReadOnly={effectiveSettings.permission === "read-only"}
            defaultRepositoryName={defaultRepositoryName}
            promptAudit={promptAudit}
            projectActions={projectActions}
            workflows={projectWorkflows}
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
            onRunTerminal={(command) => {
              if (activeExecutionPath) void terminal.run(command, activeThreadWorktree?.gitDir ? [activeThreadWorktree.gitDir] : []);
            }}
            onStopTerminal={() => void terminal.stop()}
            onClearTerminal={terminal.clear}
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
              if (effectiveSettings.provider === "claude") void Promise.all([refreshClaudeStatus(), refreshClaudeModels()]);
              else if (effectiveSettings.provider === "cursor") void Promise.all([refreshCursorStatus(), refreshCursorModels()]);
              else if (effectiveSettings.provider === "openrouter") void Promise.all([
                hasOpenRouterKey().then(setOpenRouterReady).catch(() => setOpenRouterReady(false)),
                refreshOpenRouterCredits(),
              ]);
              else if (effectiveSettings.provider === "lmstudio") void refreshLMStudioModels(settings.lmStudioBaseUrl);
              else void refreshUsage();
            }}
            onCompact={() => void compactThread()}
            onRefreshTools={() => void refreshTools(activeProject)}
            onGitAction={(action, commitMessage) => void runGitAction(action, commitMessage)}
            onInitializeGit={() => void initializeActiveProjectGit()}
            onGitHubAttach={(url) => void attachActiveGitHubRemote(url)}
            onGitHubCreate={(name, visibility) => void createActiveGitHubRepository(name, visibility)}
            onOpenGitHubSettings={() => {
              setStudioOpen(false);
              openSettings("github");
            }}
            onGitPathAction={(action, path) => void runGitPathAction(action, path)}
            onAttachPath={(path) => addAttachmentPaths([path])}
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
        lmStudioReady={lmStudioReady}
        lmStudioTokenStored={lmStudioTokenStored}
        lmStudioModels={lmStudioModels}
        lmStudioModelsError={lmStudioModelsError}
        runtimeModels={runtimeModels}
        openRouterModels={openRouterModels}
        cursorModels={cursorModels}
        claudeModels={claudeModels}
        modelFavorites={modelFavorites}
        onToggleModelFavorite={toggleModelFavorite}
        onDiscoverOpenRouterModels={(query) => void discoverOpenRouterModels(query)}
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
        onEffortSliderPreview={setPreviewEffortSlider}
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
        onOpenRouterChange={(ready) => {
          if (ready && openRouterReady) void refreshOpenRouterCredits();
          setOpenRouterReady(ready);
        }}
        onLMStudioRefresh={refreshLMStudioModels}
        onLMStudioTokenChange={setLmStudioTokenStored}
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
        removedSkills={removedSkills}
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
        onRefreshSkills={(silent = false) => refreshLocalSkills(skillsFolder, skillAliases, disabledSkillPaths, removedSkillPaths, silent).then(() => undefined)}
        onImportSkills={() => void importSkills()}
        onCreateSkill={createSkill}
        onReadSkill={readSkill}
        onUpdateSkill={updateSkill}
        onRenameSkill={renameSkill}
        onToggleSkill={toggleSkill}
        onRemoveSkill={removeSkill}
        onRestoreSkill={restoreSkill}
        onOpenOnboarding={() => {
          closeSettings();
          openOnboarding();
        }}
      />

      {onboardingMounted && (
        <Suspense fallback={null}>
          <OnboardingModal open={onboardingOpen} runtimeStatus={runtimeStatus} claudeStatus={claudeStatus} cursorStatus={cursorStatus} account={account} openRouterReady={openRouterReady} lmStudioReady={lmStudioReady} skillsFolder={skillsFolder} onComplete={completeOnboarding} onOpenSettings={(section) => openSettings(section)} onChooseSkillsFolder={() => void chooseSkillsFolder()} onAddProject={() => void addProject()} onStartChat={startNormalChat} />
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
      <ConfirmDialogModal />
    </div>
  );
}

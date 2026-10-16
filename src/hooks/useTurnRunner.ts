import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ReasoningEffort } from "../components/ModelPowerControl";
import { respond, rpc, runtimeInstanceId, runtimeThreadState, type CodexRuntimeStatus } from "../lib/codex";
import {
  isClaudeThreadBusyError,
  killClaudeTurn,
  saveClaudeTranscript,
  startClaudeTurn,
  steerClaudeTurn,
  type ClaudeRuntimeStatus,
} from "../lib/claude";
import {
  killCursorTurn,
  loadCursorTranscript,
  saveCursorTranscript,
  startCursorTurn,
  steerCursorTurn,
  type CursorRuntimeStatus,
} from "../lib/cursor";
import type { AgentQuestionSubmission } from "../lib/agentQuestionContext";
import { beginCursorTurnStart, cursorTurnOwner, isCurrentCursorTurnStart, rejectCursorTurnStart, type CursorStartAttempt } from "../lib/cursorTurnOwnership";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL } from "../lib/appConfig";
import { cacheChildAgentPolicy, ensureChildAgentBridge, releaseChildAgentSession, type ChildAgentBridgeResult } from "../lib/childAgentSessions";
import { childAgentPolicyForThread, settingsWithoutChildDelegation, type ChildAgentLink, type ChildAgentPolicy, type ChildAgentReadiness } from "../lib/childAgents";
import { nativeSubagentUnavailableReason, parentAutoCompactionUnavailableReason, sanitizeNativeSubagentMax } from "../lib/threadSubagentSettings";
import {
  planSubagentCapabilities,
  recordSubagentCapabilities,
  subagentCapabilitySignature,
} from "../lib/threadCapabilities";
import { threadResumeParams, threadStartParams, turnStartParams } from "../lib/turnConfig";
import { buildTurnInput, withoutSentAttachments } from "../lib/turnInput";
import { optimisticStartedThread, upsertThread } from "../lib/threadList";
import { storedPendingTimedTurns, useTaskStore } from "../lib/taskStore";
import {
  eligibleQueueHead,
  formatDeliveryTime,
  hasEligibleQueuedTurns,
  TIMED_PROMPT_MAX_TIMER_MS,
  timedClockDecision,
} from "../lib/timedPrompts";
import {
  applyNewThreadSnapshot,
  findNewThreadTimedPrompt,
  newThreadSnapshot,
  useNewThreadTimedPrompts,
  type NewThreadTimedPrompt,
} from "../lib/newThreadTimedPrompts";
import { friendlyError, safeErrorText } from "../lib/errors";
import { SkillDependencyError } from "../lib/skillDependencies";
import { confirmDialog } from "../lib/confirmDialog";
import { clearProviderStopIntent, markProviderStopIntent } from "../lib/providerStopIntent";
import { sealStoppedTurn } from "../lib/stopTurnHistory";
import { isClaudeThread, isCursorThread } from "../lib/threadProvider";
import { mythraCodeDeveloperInstructions, withMythraCodeCompletionInstructions } from "../lib/completionPrompt";
import { RUN_COMMAND_TOOL } from "../lib/projectRun";
import { CHECK_COMMAND_TOOL } from "../lib/projectChecks";
import {
  createThreadWorktree,
  removeThreadWorktree,
  type CreatedWorktree,
  type ThreadWorktreeRecord,
  type WorkspaceGitInfo,
} from "../lib/worktrees";
import { normalizedProjectPath } from "../lib/paths";
import { isPullRequestMutationRunning } from "../lib/pullRequestOperations";
import { unsupportedImageReason } from "../lib/attachments";
import type { ResolvedSkillPrompts } from "../lib/skills";
import { appendCurrentLearnedPreferences } from "../lib/currentLearnedPreferences";
import { beginTurnContextReceipt, createTurnContextReceipt, type TurnContextReceipt } from "../lib/turnContextReceipts";
import { appendProjectInstructionContext } from "../lib/projectInstructionContext";
import { invoke } from "@tauri-apps/api/core";
import { PendingTurnStarts, type PendingTurnStart } from "../lib/pendingTurnStarts";
import type { PendingFirstPrompt } from "../lib/pendingFirstPrompt";
import type { SetPersisted } from "./usePersistedState";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { LMStudioModel } from "../lib/lmStudio";
import type { AttachmentRecord } from "../components/StudioDock";
import type { Account, AppSettings, ChatMessage, CustomAgentProfile, NativeSubagentOptions, Project, Provider, SettingsSection, SubagentEngine, Thread, ThreadReasoning, Turn } from "../types";

const queuedDeliveries = new Map<string, { threadId: string; context: TurnRunnerContext }>();
const activeQueuedDeliveries = new Set<string>();
/** Shared-folder new starts own their folder before a provider assigns a thread id. */
const pendingSharedDraftStarts = new Map<symbol, string>();
/** One bounded recovery attempt for a local-provider slot still unwinding. */
const queuedBusyRetries = new Set<string>();
/** Delivery contexts for timed first prompts of not-yet-created threads. */
const newThreadDeliveries = new Map<string, TurnRunnerContext>();
/** New-thread starts run one at a time so the shared-folder check sees each. */
let newThreadDeliveryChain: Promise<void> = Promise.resolve();
const newThreadDeliveriesInFlight = new Set<string>();

/**
 * Last timed-prompt clock check in this renderer session. `null` until the
 * first check after launch/reload, so anything already due then is missed.
 */
let lastTimedClockCheckAt: number | null = null;
let lastTimedPerformanceCheckAt: number | null = null;
/** Failure text reported by a deferred new-thread start, keyed by prompt id. */
const newThreadDeliveryErrors = new Map<string, string>();

/** Stop before a provider request is an undelivered prompt, not a runtime error. */
class CancelledTurnStart extends Error {}

/** The local provider can cross a lifecycle boundary after the UI enables Steer. */
function isUnavailableSteerError(reason: unknown): boolean {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "");
  return [
    /(?:Claude|Cursor).*(?:not currently running|no longer running)/i,
    /Could not (?:write to|flush) (?:Claude Code|Cursor Agent)/i,
    /Cursor session is still starting/i,
    /Claude turn is finishing|Cursor already finished this turn/i,
    /no active turn|active turn is still starting|expected turn(?: id)?.*(?:does not match|mismatch)/i,
  ].some((pattern) => pattern.test(raw));
}

/** Inspect the native disposition before friendly wording can hide a timeout. */
function deliveryIsUncertain(reason: unknown): boolean {
  return /^(?:Error:\s*)?MYTHRA_DELIVERY_UNCERTAIN:/.test(safeErrorText(reason));
}

/**
 * Release the captured delivery contexts for a thread. A context pins the whole
 * App render context, so a deleted conversation must not keep one alive. With
 * no thread id every capture is dropped, which tests use to isolate cases.
 */
export function forgetQueuedDeliveries(threadId?: string): void {
  if (threadId === undefined) {
    queuedDeliveries.clear();
    activeQueuedDeliveries.clear();
    pendingSharedDraftStarts.clear();
    queuedBusyRetries.clear();
    newThreadDeliveries.clear();
    newThreadDeliveriesInFlight.clear();
    newThreadDeliveryChain = Promise.resolve();
    lastTimedClockCheckAt = null;
    lastTimedPerformanceCheckAt = null;
    return;
  }
  for (const [queuedTurnId, delivery] of queuedDeliveries) {
    if (delivery.threadId === threadId) {
      queuedDeliveries.delete(queuedTurnId);
      queuedBusyRetries.delete(queuedTurnId);
    }
  }
  activeQueuedDeliveries.delete(threadId);
}

function queuedDeliveryContext(context: TurnRunnerContext, threadId: string, attachments: AttachmentRecord[], resolveSkillMentions?: false, skillInvocationText?: string): TurnRunnerContext {
  const visible = () => useTaskStore.getState().activeThreadId === threadId;
  return {
    ...context,
    running: false,
    deferredDelivery: true,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    skillInvocationText,
    ...(resolveSkillMentions === false ? {
      resolveSkillMentions: false as const,
      resolveSkillPrompt: async (message: string) => message,
    } : {}),
    // Always treat a deferred send as background-capable. The normal delivery
    // path still updates durable thread/task state and the sidebar entry, but
    // it must never activate a task or clear attachments in whichever
    // conversation the user happens to be viewing when the queued turn starts.
    // The live workspace ref is deliberately kept: delivery still has to know
    // whether the user is in the workspace this turn was queued from.
    setActiveThread: () => undefined,
    setAttachments: () => undefined,
    setStartingDraftTurn: () => undefined,
    setDraftThreadIsolated: () => undefined,
    setError: (error) => { if (visible()) context.setError(error); },
    setStatus: (status) => { if (visible()) context.setStatus(status); },
    setTransientStatus: (status) => { if (visible()) context.setTransientStatus(status); },
  };
}

/**
 * The deferred equivalent of pressing Send in a new-thread draft. The provider
 * identity and isolation choice come from the snapshot taken when the prompt
 * was scheduled, never from whatever the draft picker shows now. Errors are
 * captured for the scheduled row; they reach the visible banner only while
 * the user is looking at that same draft.
 */
function newThreadDeliveryContext(context: TurnRunnerContext, prompt: NewThreadTimedPrompt): TurnRunnerContext {
  const base = queuedDeliveryContext(context, prompt.threadId, prompt.attachments, prompt.resolveSkillMentions, prompt.skillInvocationText);
  const visible = () => useTaskStore.getState().activeThreadId === null
    && context.activeWorkspacePathRef.current === normalizedProjectPath(prompt.workspacePath);
  return {
    ...base,
    activeThread: null,
    activeThreadIsChild: false,
    draftThreadIsolated: prompt.snapshot.isolated,
    effectiveSettings: {
      ...applyNewThreadSnapshot(context.effectiveSettings, prompt.snapshot),
      // The visible draft may have switched provider after scheduling. Keep
      // this workspace's composition, but select the scheduled provider's
      // instructions rather than the visible picker's instructions.
      systemPrompt: context.subscriptionSystemPrompts[prompt.snapshot.provider] ?? context.effectiveSettings.systemPrompt,
    },
    setError: (error) => {
      if (error) newThreadDeliveryErrors.set(prompt.id, error);
      if (visible()) context.setError(error);
    },
    setStatus: (status) => { if (visible()) context.setStatus(status); },
    setTransientStatus: (status) => { if (visible()) context.setTransientStatus(status); },
  };
}

/** Deferred admission refreshes global preview authority; execution choices stay captured. */
function withLiveDeliveryReadiness(captured: TurnRunnerContext, live: TurnRunnerContext): TurnRunnerContext {
  return {
    ...captured,
    effectiveSettings: {
      ...captured.effectiveSettings,
      managedSubagentV2: live.effectiveSettings.managedSubagentV2 === true,
      automaticGitInitialization: live.effectiveSettings.automaticGitInitialization === true,
    },
    // A queued turn is not admitted yet. Current ownership decides whether
    // an existing V2 crew still needs its review tools after the default flips.
    childAgentLinks: live.childAgentLinks,
    childAgentPolicies: live.childAgentPolicies,
    runtimeStatus: live.runtimeStatus,
    claudeStatus: live.claudeStatus,
    cursorStatus: live.cursorStatus,
    account: live.account,
    openRouterReady: live.openRouterReady,
    lmStudioReady: live.lmStudioReady,
    childAgentReadiness: live.childAgentReadiness,
  };
}


/** Keep only the image metadata the transcript needs, detached from composer state. */
function messageImageAttachments(attachments: AttachmentRecord[]) {
  const images = attachments
    .filter((attachment) => attachment.kind === "image")
    .map(({ path, name }) => ({ path, name, kind: "image" as const }));
  return images.length ? images : undefined;
}

/** The verbatim isolation record persisted for a thread's private worktree. */
function threadWorktreeRecord(threadId: string, project: Project, worktree: CreatedWorktree): ThreadWorktreeRecord {
  return {
    threadId,
    projectId: project.id,
    projectPath: project.path,
    path: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
    gitDir: worktree.gitDir,
    createdAt: Date.now(),
    status: "active",
  };
}

export interface TurnRunnerContext {
  /** Optional exact parent identity for a UI-generated worker instruction. */
  deliveryGuard?: (ownedRunStartedAt?: number) => boolean;
  activeThread: Thread | null;
  activeWorkspace: Project | null;
  activeProject: Project | null;
  running: boolean;
  /**
   * Set only on the synthetic context a queued follow-up is delivered with.
   * Such a send starts without the user watching, so it must never block the
   * window on a modal prompt.
   */
  deferredDelivery?: boolean;
  /** Renderer acknowledgement owned by this foreground first-send attempt. */
  firstPromptAttemptId?: string;
  /** View-only attempt identity; never sent to or persisted by a provider. */
  activeFirstPromptIdRef?: MutableRefObject<string | null>;
  onFirstPromptStarted?: (prompt: PendingFirstPrompt) => void;
  onFirstPromptFinished?: (id: string) => void;
  attachments: AttachmentRecord[];
  effectiveSettings: AppSettings;
  subscriptionSystemPrompts: Record<"openai" | "claude", string> & Partial<Record<Provider, string>>;
  customAgents: CustomAgentProfile[];
  openRouterModels: OpenRouterModel[];
  lmStudioModels?: LMStudioModel[];
  runtimeStatus: CodexRuntimeStatus | null;
  nativeReasoningEfforts?: Partial<Record<string, ReasoningEffort[]>>;
  claudeStatus: ClaudeRuntimeStatus | null;
  cursorStatus: CursorRuntimeStatus | null;
  account: Account | null;
  openRouterReady: boolean;
  lmStudioReady?: boolean;
  workspaceGitInfo: WorkspaceGitInfo | null;
  draftThreadIsolated: boolean;
  worktreeBusy: boolean;
  skillsFolder: string;
  resolveSkillPrompt: (message: string, mentionSource?: string) => Promise<string>;
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
  getSkillReferences?: (message: string, mentionSource?: string) => Pick<ChatMessage, "skillReferences" | "skillsFolder">;
  /** Preserve literal generated prompts through deferred and restored delivery. */
  resolveSkillMentions?: false;
  /** Skill invocations in formatted prompts come only from authored text. */
  skillInvocationText?: string;
  /** Bridge sessions for cross-provider sub-agents, keyed by session id. */
  childAgentPolicies: Record<string, ChildAgentPolicy>;
  childAgentLinks: Record<string, ChildAgentLink>;
  /** True for both Mythra Code bridge children and provider-native children. */
  activeThreadIsChild?: boolean;
  childAgentReadiness: ChildAgentReadiness;
  persistChildAgentPolicies: SetPersisted<Record<string, ChildAgentPolicy>>;
  threadWorktreesRef: MutableRefObject<Record<string, ThreadWorktreeRecord>>;
  threadProjectBindingsRef: MutableRefObject<Record<string, string> | null>;
  activeWorkspacePathRef: MutableRefObject<string | null>;
  pendingTurnStartsRef: MutableRefObject<PendingTurnStarts>;
  skillRuntimeRootRef: MutableRefObject<string>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  /** Latest known record for a thread, so a long-delayed delivery never
   * writes back a stale title or preview captured when it was scheduled. */
  currentThread?: (threadId: string) => Thread | null | undefined;
  /** Exact native process expected to own this Codex start. */
  onCodexRuntimeOwned?: (threadId: string, instance: string) => void;
  onExplicitChildStart?: (threadId: string, attemptId: string) => void;
  onExplicitChildStartSettled?: (threadId: string, attemptId: string, dispatched: boolean) => void;
  isExplicitChildStartCurrent?: (threadId: string, attemptId: string) => boolean;
  ensureManagedLocalThreadHydrated?: (threadId: string, assertCanStart: () => void) => Promise<void>;
  /** `deferred` marks a scheduled first prompt, which must not consume the
   * visible draft's pending handoff; `subagentsEnabled` is its snapshot. */
  onThreadCreated: (threadId: string, options?: { deferred?: boolean; subagentsEnabled?: boolean; subagentEngine?: SubagentEngine; nativeSubagentMax?: number; nativeSubagentOptions?: NativeSubagentOptions; autoCompactTokens?: number }) => void;
  /** Runs only for a new project root, after its optimistic prompt is visible. */
  prepareNewThreadGit?: (threadId: string, workspace: Project, enabled: boolean) => Promise<boolean>;
  onThreadTitlePending?: (threadId: string, prompt: string) => void;
  onThreadTitleCancelled?: (threadId: string) => void;
  onThreadTitleRequested?: (threadId: string, prompt: string) => void;
  /** Only direct human-authored input accepted by a provider is learning evidence. */
  onAuthoredPromptAccepted?: (threadId: string, text: string, messageId: string, capturedAt?: number) => void;
  /** Live archive ownership. Existing threads must not start provider work
   * while their archive operation is awaiting cleanup or persistence. */
  isThreadArchiving?: (threadId: string) => boolean;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadReasoning: (threadId: string, reasoning: ThreadReasoning) => void;
  persistThreadWorktrees: SetPersisted<Record<string, ThreadWorktreeRecord>>;
  /** Restart the shared Codex app-server between idle turns so startup-only
   * capability config can be reapplied to an already loaded thread. Resolves
   * with the identity of the app-server that replaced it. */
  restartRuntimeForCapabilities: (threadId: string, allowOwnStarting?: boolean) => Promise<string>;
  /** Wait for view-first OpenAI navigation to finish preparing its runtime. */
  waitForThreadPreparation: (threadId: string) => Promise<void>;
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string, expectedCheckpointId?: string) => void;
  refreshLocalSkills: () => Promise<unknown>;
  ensureSkillRoots: () => Promise<void>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  setActiveThread: Dispatch<SetStateAction<Thread | null>>;
  setAttachments: Dispatch<SetStateAction<AttachmentRecord[]>>;
  setDraftThreadIsolated: (isolated: boolean) => void;
  setStartingDraftTurn: (starting: boolean) => void;
  setError: (error: string | null) => void;
  onSkillDependencyFailure?: (error: SkillDependencyError) => void;
  setStatus: (status: string) => void;
  setTransientStatus: (message: string) => void;
  setRuntimeSetupOpen: (open: boolean) => void;
  setAuthRequiredOpen: (open: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
}

interface SendMessageOptions {
  useComposerAttachments?: boolean;
  resolveSkillMentions?: boolean;
  skillInvocationText?: string;
  firstPromptAttemptId?: string;
  /** Durable attachments from the sending draft, even after navigation. */
  attachments?: AttachmentRecord[];
}

/**
 * Owns the send/steer/stop turn lifecycle for all providers. The context is
 * rebuilt by App on every render and read through a ref, so the stable
 * callbacks always see fresh state; each call snapshots the context once at
 * entry, mirroring the closure captures of the original inline handlers, so
 * mid-flight awaits keep operating on the workspace the send started in.
 */
export function useTurnRunner(context: TurnRunnerContext): {
  pendingFirstPrompts: readonly PendingFirstPrompt[];
  beginFirstPrompt: (text: string) => string | undefined;
  finishFirstPrompt: (id: string | undefined) => void;
  sendMessage: (text: string, options?: SendMessageOptions) => Promise<boolean>;
  answerQuestions: (threadId: string, text: string, submission?: AgentQuestionSubmission) => Promise<boolean>;
  steerMessage: (text: string, options?: { resolveSkillMentions?: boolean; skillInvocationText?: string; expectedThreadId?: string; expectedTurnId?: string; expectedRunStartedAt?: number; deliveryGuard?: () => boolean }) => Promise<boolean>;
  steerQueuedMessage: (queuedTurnId: string) => Promise<void>;
  retryQueuedMessage: (queuedTurnId: string) => void;
  removeQueuedMessage: (queuedTurnId: string) => void;
  beginEditQueuedMessage: (queuedTurnId: string) => boolean;
  finishEditQueuedMessage: (queuedTurnId: string, text?: string) => boolean;
  scheduleMessage: (text: string, deliverAt: number, options?: { useComposerAttachments?: boolean; skillInvocationText?: string }) => Promise<boolean>;
  rescheduleQueuedMessage: (queuedTurnId: string, deliverAt: number) => boolean;
  queueTimedMessageNow: (queuedTurnId: string) => boolean;
  beginEditNewThreadPrompt: (id: string) => boolean;
  finishEditNewThreadPrompt: (id: string, text?: string) => boolean;
  rescheduleNewThreadPrompt: (id: string, deliverAt: number) => boolean;
  sendNewThreadPromptNow: (id: string) => boolean;
  removeNewThreadPrompt: (id: string) => void;
  stopTurn: () => Promise<void>;
  /** Fresh preview-switch authority before a parent has a captured crew. */
  getSubagentPreparationLockedReason: () => string | undefined;
  /** Re-renders consumers when a parent preparation begins or settles. */
  subagentPreparationLockRevision: number;
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  const subagentPreparationsRef = useRef(new Set<symbol>());
  const [subagentPreparationLockRevision, setSubagentPreparationLockRevision] = useState(0);
  const notifySubagentPreparationChanged = useCallback(() => {
    setSubagentPreparationLockRevision((revision) => revision + 1);
  }, []);
  const [pendingFirstPrompts, setPendingFirstPrompts] = useState<PendingFirstPrompt[]>([]);
  const firstPromptAttemptsRef = useRef(new Map<string, PendingFirstPrompt>());
  const firstPromptContextsRef = useRef(new Map<string, TurnRunnerContext>());
  const deliveringFirstPromptIdsRef = useRef(new Set<string>());
  const getSubagentPreparationLockedReason = useCallback((): string | undefined => {
    if (subagentPreparationsRef.current.size) {
      return "Wait for the parent turn to finish preparing before changing this preview.";
    }
    // Composer admission precedes deliverMessage. Read its captured policy
    // synchronously, including drafts no longer selected in the visible UI.
    for (const id of firstPromptAttemptsRef.current.keys()) {
      const captured = firstPromptContextsRef.current.get(id);
      if (captured?.effectiveSettings.subagentsEnabled && !captured.activeThreadIsChild
        && !(captured.activeThread && captured.childAgentLinks[captured.activeThread.id])) {
        return "Wait for the parent turn to finish preparing before changing this preview.";
      }
    }
    return undefined;
  }, []);
  const beginFirstPrompt = useCallback((text: string): string | undefined => {
    const ctx = contextRef.current;
    if (ctx.activeThread || ctx.deferredDelivery || !ctx.activeWorkspace) return undefined;
    const selectedAttempt = ctx.activeFirstPromptIdRef?.current;
    if (selectedAttempt && firstPromptAttemptsRef.current.has(selectedAttempt)) return undefined;
    const id = crypto.randomUUID();
    const prompt: PendingFirstPrompt = {
      id, workspacePath: normalizedProjectPath(ctx.activeWorkspace.path), text, status: "starting",
      attachmentNames: ctx.attachments.map((attachment) => attachment.name),
      provider: ctx.effectiveSettings.provider,
      model: ctx.effectiveSettings.model,
      isolated: ctx.draftThreadIsolated,
    };
    firstPromptAttemptsRef.current.set(id, prompt);
    firstPromptContextsRef.current.set(id, ctx);
    notifySubagentPreparationChanged();
    ctx.onFirstPromptStarted?.(prompt);
    setPendingFirstPrompts((current) => [...current, prompt]);
    ctx.setStartingDraftTurn(true);
    return id;
  }, [notifySubagentPreparationChanged]);
  const finishFirstPrompt = useCallback((id: string | undefined) => {
    if (!id) return;
    const attempt = firstPromptAttemptsRef.current.get(id);
    if (!attempt) return;
    firstPromptAttemptsRef.current.delete(id);
    firstPromptContextsRef.current.delete(id);
    notifySubagentPreparationChanged();
    setPendingFirstPrompts((current) => current.filter((prompt) => prompt.id !== id));
    const ctx = contextRef.current;
    if (attempt && !ctx.activeThread && ctx.activeWorkspacePathRef.current === attempt.workspacePath
      && (!ctx.activeFirstPromptIdRef || ctx.activeFirstPromptIdRef.current === id)) ctx.setStartingDraftTurn(false);
    ctx.onFirstPromptFinished?.(id);
  }, [notifySubagentPreparationChanged]);
  const createdFirstPromptThreadsRef = useRef(new Map<string, string>());
  const bindPendingFirstPrompt = useCallback((attemptId: string | undefined, threadId: string) => {
    if (!attemptId) return;
    createdFirstPromptThreadsRef.current.set(attemptId, threadId);
    const attempt = firstPromptAttemptsRef.current.get(attemptId);
    if (attempt) firstPromptAttemptsRef.current.set(attemptId, { ...attempt, threadId });
    setPendingFirstPrompts((current) => current.map((prompt) => prompt.id === attemptId ? { ...prompt, threadId } : prompt));
  }, []);
  const draftGenerationRef = useRef(0);
  const ordinarySharedDraftStartsRef = useRef(new Map<symbol, string | undefined>());
  const localStartRequestsRef = useRef(new Map<string, { startRequestId: string; runStartedAt?: number; turnId?: string }>());

  const archiveOwnsThread = useCallback((threadId: string): boolean => {
    const current = contextRef.current;
    if (!current.isThreadArchiving?.(threadId)) return false;
    current.setError("This thread is being archived. Wait for archiving to finish before sending another message.");
    return true;
  }, []);

  // Returns true when the message was delivered; the Composer restores its
  // draft when it was not.
  const deliverMessage = useCallback(async (
    ctx: TurnRunnerContext,
    text: string,
    mode: "turn" | "steer",
    onUnavailableSteer?: () => void,
    onResolutionFailure?: (reason: unknown) => void,
  ): Promise<boolean> => {
    if (ctx.deliveryGuard && !ctx.deliveryGuard()) return false;
    const explicitThreadId = mode === "turn" ? ctx.activeThread?.id : undefined;
    const explicitAttemptId = explicitThreadId ? crypto.randomUUID() : undefined;
    let explicitDispatched = false;
    const localStartRequestId = explicitAttemptId ?? crypto.randomUUID();
    const subagentPreparation = mode === "turn" && ctx.effectiveSettings.subagentsEnabled
      && !ctx.activeThreadIsChild && !(ctx.activeThread && ctx.childAgentLinks[ctx.activeThread.id])
      ? Symbol("parent sub-agent preparation") : undefined;
    if (subagentPreparation) {
      subagentPreparationsRef.current.add(subagentPreparation);
      notifySubagentPreparationChanged();
    }
    const explicitAttemptCurrent = () => !explicitThreadId || !explicitAttemptId
      || ctx.isExplicitChildStartCurrent?.(explicitThreadId, explicitAttemptId) !== false;
    try {
    if (explicitThreadId && explicitAttemptId) ctx.onExplicitChildStart?.(explicitThreadId, explicitAttemptId);
    const capturedAt = Date.now();
    const recordAuthoredPrompt = (threadId: string, messageId: string) => {
      // Generated reviews/handoffs explicitly disable mention resolution. A
      // wrapper may instead supply its original authored source separately.
      if (ctx.activeThreadIsChild || (ctx.resolveSkillMentions === false && ctx.skillInvocationText === undefined)) return;
      const authoredText = ctx.skillInvocationText ?? text;
      if (!authoredText.trim()) return;
      try {
        ctx.onAuthoredPromptAccepted?.(threadId, authoredText, messageId, capturedAt);
      } catch {
        // Optional learning capture cannot turn a successful provider send
        // into an undelivered draft or remove an already accepted steer.
      }
    };
    const {
      activeThread, activeWorkspace, activeProject, running, attachments, deferredDelivery,
      effectiveSettings: configuredSettings, subscriptionSystemPrompts, customAgents, openRouterModels, lmStudioModels = [],
      runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, lmStudioReady,
      workspaceGitInfo, draftThreadIsolated, worktreeBusy, skillsFolder, resolveSkillPrompt,
      childAgentPolicies, childAgentLinks, activeThreadIsChild, childAgentReadiness, persistChildAgentPolicies,
      threadWorktreesRef, threadProjectBindingsRef, activeWorkspacePathRef,
      pendingTurnStartsRef, skillRuntimeRootRef, cursorSessionIdsRef,
      executionPathFor, bindThreadToProject, rememberThread, onThreadCreated, persistThreadModel, persistThreadReasoning,
      persistThreadWorktrees, waitForThreadPreparation, beginRunCheckpoint, discardRunCheckpoint,
      refreshLocalSkills, ensureSkillRoots, scheduleClaudeThreadSave, scheduleCursorThreadSave,
      setThreads, setActiveThread, setAttachments, setDraftThreadIsolated: setContextDraftThreadIsolated,
      setStartingDraftTurn: setContextStartingDraftTurn, setError, setStatus, setTransientStatus,
      setRuntimeSetupOpen, setAuthRequiredOpen, openSettings,
    } = ctx;
    const ownsVisibleDraft = () => !(ctx.firstPromptAttemptId && ctx.activeFirstPromptIdRef
        && ctx.activeFirstPromptIdRef.current !== ctx.firstPromptAttemptId
        && useTaskStore.getState().activeThreadId !== createdFirstPromptThreadsRef.current.get(ctx.firstPromptAttemptId));
    const setStartingDraftTurn = (starting: boolean) => { if (ownsVisibleDraft()) setContextStartingDraftTurn(starting); };
    const setDraftThreadIsolated = (isolated: boolean) => { if (ownsVisibleDraft()) setContextDraftThreadIsolated(isolated); };
    const childThread = Boolean(activeThreadIsChild || (activeThread && childAgentLinks[activeThread.id]));
    const effectiveSettings = childThread ? settingsWithoutChildDelegation(configuredSettings) : configuredSettings;
    const nativeDelegation = effectiveSettings.subagentsEnabled && effectiveSettings.subagentEngine === "native";
    if (!text || !activeWorkspace) return false;
    const initializeNewThreadGit = !activeThread && !childThread && !activeWorkspace.isChat && effectiveSettings.automaticGitInitialization === true;
    const compactionReason = parentAutoCompactionUnavailableReason(effectiveSettings.provider, effectiveSettings.autoCompactTokens);
    if (compactionReason) {
      setError(compactionReason);
      return false;
    }
    if (activeThread && archiveOwnsThread(activeThread.id)) return false;
    if (isPullRequestMutationRunning(executionPathFor(activeThread?.id, activeWorkspace.path))) {
      setError("Wait for the pull request operation to finish before starting another model turn.");
      return false;
    }
    if (nativeDelegation) {
      const reason = nativeSubagentUnavailableReason(effectiveSettings.provider, {
        codexRuntime: runtimeStatus,
        claudeRuntime: claudeStatus,
        readiness: childAgentReadiness,
        nativeOptions: effectiveSettings.nativeSubagentOptions,
        nativeDefaultModel: effectiveSettings.model,
        autoCompactTokens: effectiveSettings.autoCompactTokens,
        nativeReasoningEfforts: ctx.nativeReasoningEfforts,
      });
      if (reason) {
        setError(reason);
        return false;
      }
    }
    for (const attachment of attachments) {
      const reason = attachment.kind === "image" ? unsupportedImageReason(attachment.path) : undefined;
      if (reason) {
        setError(reason);
        return false;
      }
    }
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
    if (effectiveSettings.provider !== "claude" && effectiveSettings.provider !== "cursor" && !runtimeStatus?.available) {
      if (!deferredDelivery) setRuntimeSetupOpen(true);
      setError("Set up the model runtime before starting this prompt.");
      return false;
    }
    if (effectiveSettings.provider === "openai" && account?.type !== "chatgpt") {
      if (!deferredDelivery) setAuthRequiredOpen(true);
      setError("Sign in to ChatGPT before starting this prompt.");
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !openRouterReady) {
      if (!deferredDelivery) openSettings("models");
      setError("Add an OpenRouter API key before using OpenRouter.");
      return false;
    }
    if (effectiveSettings.provider === "lmstudio" && !lmStudioReady) {
      if (!deferredDelivery) openSettings("models");
      setError("Start the LM Studio local server and load at least one model before using LM Studio.");
      return false;
    }
    if (effectiveSettings.provider === "claude" && (!claudeStatus?.available || !claudeStatus.loggedIn)) {
      if (!deferredDelivery) openSettings("models");
      setError(claudeStatus?.available ? "Sign in to Claude Code before using your Claude subscription." : "Install Claude Code, then sign in before using the Claude provider.");
      return false;
    }
    if (effectiveSettings.provider === "cursor" && (!cursorStatus?.available || !cursorStatus.loggedIn)) {
      if (!deferredDelivery) openSettings("models");
      setError(cursorStatus?.available ? "Refresh Cursor's connection or sign in from Models & accounts before using your Cursor subscription." : "Install Cursor Agent, then sign in before using the Cursor provider.");
      return false;
    }
    if (effectiveSettings.provider === "openrouter" && !effectiveSettings.model.trim()) {
      setError("Choose an OpenRouter model before starting this thread.");
      return false;
    }
    if (effectiveSettings.provider === "lmstudio" && !effectiveSettings.model.trim()) {
      setError("Choose an LM Studio model before starting this thread.");
      return false;
    }
    const modelContextWindow = effectiveSettings.provider === "openrouter"
      ? openRouterModels.find((entry) => entry.id === effectiveSettings.model)?.context_length
      : effectiveSettings.provider === "lmstudio"
        ? lmStudioModels.find((entry) => entry.id === effectiveSettings.model)?.maxContextLength
        : undefined;
    let providerText: string;
    let resolvedSystemPrompt = effectiveSettings.systemPrompt;
    let userSkillMetadata: Pick<ChatMessage, "skillReferences" | "skillsFolder" | "skillDependencies"> = {};
    // What this turn's instructions were built from, for the dock's audit.
    let contextReceipt: TurnContextReceipt | null = null;
    let receiptAttempt: ReturnType<typeof beginTurnContextReceipt> | undefined;
    if (mode === "steer" && running && activeThread) {
      const steerOwner = useTaskStore.getState().tasks[activeThread.id];
      const expectedSteerTurnId = steerOwner?.activeTurnId;
      const expectedSteerRunStartedAt = steerOwner?.agentRunStartedAt;
      try {
        if (ctx.resolveSkillPrompts) {
          // Steering changes only user input. Never re-resolve or resend the
          // running turn's frozen system policy.
          const resolved = await ctx.resolveSkillPrompts(text, "", ctx.resolveSkillMentions === false ? "" : ctx.skillInvocationText);
          providerText = resolved.prompt;
          userSkillMetadata = { skillReferences: ctx.resolveSkillMentions === false ? [] : resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies };
        } else {
          providerText = await resolveSkillPrompt(text, ctx.skillInvocationText);
          userSkillMetadata = ctx.resolveSkillMentions === false ? { skillReferences: [] } : ctx.getSkillReferences?.(text, ctx.skillInvocationText) ?? {};
        }
      } catch (reason) {
        onResolutionFailure?.(reason);
        setError(friendlyError(reason));
        return false;
      }
      const sentAttachments = [...attachments];
      if (ctx.deliveryGuard && !ctx.deliveryGuard()) return false;
      const currentSteerOwner = useTaskStore.getState().tasks[activeThread.id];
      if (contextRef.current.isThreadArchiving?.(activeThread.id)
        || !expectedSteerTurnId
        || currentSteerOwner?.status !== "running"
        || currentSteerOwner.activeTurnId !== expectedSteerTurnId
        || currentSteerOwner.agentRunStartedAt !== expectedSteerRunStartedAt) {
        onUnavailableSteer?.();
        return false;
      }
      setError(null);
      const steerMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(activeThread.id, {
        id: steerMessageId,
        role: "user",
        text,
        ...userSkillMetadata,
        attachments: messageImageAttachments(sentAttachments),
        steerStatus: "sending",
      });
      try {
        if (isClaudeThread(activeThread)) {
          await steerClaudeTurn(
            activeThread.id,
            providerText,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
            expectedSteerTurnId,
          );
          scheduleClaudeThreadSave(activeThread.id);
        } else if (isCursorThread(activeThread)) {
          await steerCursorTurn(
            activeThread.id,
            providerText,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
            expectedSteerTurnId,
          );
          scheduleCursorThreadSave(activeThread.id);
        } else {
          const expectedTurnId = expectedSteerTurnId;
          if (!expectedTurnId) throw new Error("The active turn is still starting");
          await rpc("turn/steer", {
            threadId: activeThread.id,
            expectedTurnId,
            input: buildTurnInput(providerText, sentAttachments),
          });
        }
        useTaskStore.getState().setMessageSteerStatus(activeThread.id, steerMessageId, "accepted");
        recordAuthoredPrompt(activeThread.id, steerMessageId);
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        setTransientStatus("Steer accepted by the active turn");
        return true;
      } catch (reason) {
        if (deliveryIsUncertain(reason)) {
          // Keep uncertain input visible without returning it to the draft or
          // automatically queueing another copy after a transport failure.
          useTaskStore.getState().setMessageSteerStatus(activeThread.id, steerMessageId, "unconfirmed");
          setAttachments((current) => withoutSentAttachments(current, sentAttachments));
          if (isClaudeThread(activeThread)) scheduleClaudeThreadSave(activeThread.id);
          else if (isCursorThread(activeThread)) scheduleCursorThreadSave(activeThread.id);
          setError("The provider may have received this steering message, but delivery could not be confirmed. It remains visible in this conversation; inspect the current work before retrying it.");
          return true;
        }
        // The message never reached the runtime — remove the optimistic bubble
        // so a retry does not duplicate it in the timeline.
        useTaskStore.getState().removeMessage(activeThread.id, steerMessageId);
        if (isUnavailableSteerError(reason)) {
          // A lifecycle update may still be crossing the Tauri bridge. Let the
          // caller preserve this as a normal queued follow-up instead of
          // presenting the harmless timing race as a broken provider.
          onUnavailableSteer?.();
        } else {
          setError(friendlyError(reason));
        }
        return false;
      }
    }

    const willUseSharedFolder = !activeWorkspace.isChat && !currentIsolation && !(draftThreadIsolated && !activeThread);
    const sharedDraftStart = !activeThread && willUseSharedFolder ? Symbol("shared draft start") : undefined;
    const sharedFolderOverlapMessage = activeThread
      ? "This queued follow-up is waiting because another conversation is working in the same shared project folder. Start it again after that task finishes."
      : "This scheduled prompt did not start because another conversation is working in the same shared project folder. Start it again after that task finishes, or reschedule it.";
    const anotherSharedRun = (ownThreadId = activeThread?.id): boolean => {
      if (!willUseSharedFolder) return false;
      const sharedPath = normalizedProjectPath(activeWorkspace.path);
      if ([...pendingSharedDraftStarts].some(([token, path]) => token !== sharedDraftStart && path === sharedPath)) return true;
      const taskState = useTaskStore.getState();
      return Object.entries(taskState.statuses).some(([threadId, threadStatus]) => {
        if (threadId === ownThreadId || (threadStatus !== "starting" && threadStatus !== "running" && !taskState.workflowOwners[threadId])) return false;
        const logicalPath = threadProjectBindingsRef.current?.[threadId];
        const executionPath = taskState.tasks[threadId]?.workspacePath
          ?? (logicalPath ? executionPathFor(threadId, logicalPath) : undefined);
        return Boolean(executionPath && normalizedProjectPath(executionPath) === sharedPath);
      });
    };
    if (willUseSharedFolder) {
      if (anotherSharedRun()) {
        // A queued follow-up starts on its own schedule, possibly while the
        // user is reading another conversation. A modal there would block the
        // whole window with no context, but silently allowing two models to
        // edit one shared folder is unsafe. Hold the queue at this entry and
        // let the user retry it once the other run is finished.
        if (deferredDelivery) {
          if (activeThread) useTaskStore.getState().upsertActivity(activeThread.id, {
            id: `shared-folder-overlap-${activeThread.id}-${Date.now()}`,
            kind: "warning",
            title: "Another thread is working in this project folder",
            detail: sharedFolderOverlapMessage,
          });
          throw new Error(sharedFolderOverlapMessage);
        } else if (!await confirmDialog(
          "Another thread is already working in this shared project folder.\n\nBoth models can edit the same files at the same time. Continue anyway, or cancel and start this as an isolated worktree instead?",
        )) return false;
      }
    }

    setError(null);
    // Workspace identity captured at send start. After each await below the
    // continuation may resume in a different workspace; installation into the
    // visible UI (thread list, active thread) is then skipped, while the
    // thread itself still starts and stays bound to its own project.
    const sendWorkspacePath = normalizedProjectPath(activeWorkspace.path);
    const originalThreadBinding = activeThread ? threadProjectBindingsRef.current?.[activeThread.id] : undefined;
    const sendThreadBinding = originalThreadBinding === undefined ? undefined : normalizedProjectPath(originalThreadBinding);
    const selectedThreadAtSend = useTaskStore.getState().activeThreadId;
    let activatedCreatedThreadId: string | undefined;
    const workspaceChangedMidSend = () => activeWorkspacePathRef.current !== sendWorkspacePath;
    const threadSelectionChangedMidSend = () => {
      const selectedThread = useTaskStore.getState().activeThreadId;
      if (ctx.firstPromptAttemptId && ctx.activeFirstPromptIdRef
        && ctx.activeFirstPromptIdRef.current !== ctx.firstPromptAttemptId
        && (!activatedCreatedThreadId || selectedThread !== activatedCreatedThreadId)) return true;
      return selectedThread !== selectedThreadAtSend && selectedThread !== activatedCreatedThreadId;
    };
    let pendingStart: PendingTurnStart | undefined;
    let cursorAttempt: CursorStartAttempt | undefined;
    let guardedRunStartedAt: number | undefined;
    let draftGeneration: number | undefined;
    // Mark the start synchronously, before the first await, so Stop and the
    // composer reflect it immediately — and only on the thread actually
    // starting. A send with no active thread yet is tracked by the draft
    // flag until the created thread's own status takes over.
    const startingThreadId = activeThread?.id;
    if (startingThreadId) {
      if (effectiveSettings.provider === "cursor") cursorAttempt = beginCursorTurnStart(startingThreadId, useTaskStore.getState().tasks[startingThreadId]?.activeTurnId);
      useTaskStore.getState().beginAgentRun(startingThreadId);
      guardedRunStartedAt = useTaskStore.getState().tasks[startingThreadId]?.agentRunStartedAt;
      useTaskStore.getState().setTaskStatus(startingThreadId, "starting");
      pendingStart = pendingTurnStartsRef.current.begin(startingThreadId);
    } else if (!deferredDelivery) {
      // A scheduled first prompt is not the visible draft: it must neither
      // cancel the user's own draft send nor be cancelled by its Stop.
      draftGeneration = ++draftGenerationRef.current;
      setStartingDraftTurn(true);
    }
    const draftCancelled = () => ctx.firstPromptAttemptId
      ? firstPromptAttemptsRef.current.get(ctx.firstPromptAttemptId)?.status !== "starting"
      : draftGeneration !== undefined && draftGeneration !== draftGenerationRef.current;
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    let providerAccepted = false;
    let activeTurnBeforeDispatch: string | undefined;
    let completedTurnBeforeDispatch: string | undefined;
    let provisionalWorktree: CreatedWorktree | undefined;
    let provisionalPersisted = false;
    let childBridge: ChildAgentBridgeResult | null = null;
    const sentAttachments = [...attachments];
    let preparedExecutionPath: string | undefined;
    let ownedCheckpointId: string | undefined;
    const assertCanStart = () => {
      const ownedThreadId = startedThreadId ?? startingThreadId;
      if (ownedThreadId && contextRef.current.isThreadArchiving?.(ownedThreadId)) {
        throw new CancelledTurnStart("The thread is being archived before the model turn could start");
      }
      if (!explicitAttemptCurrent()) throw new CancelledTurnStart("A newer explicit child turn superseded this preparation");
      if (startingThreadId && guardedRunStartedAt !== undefined
        && useTaskStore.getState().tasks[startingThreadId]?.agentRunStartedAt !== guardedRunStartedAt) {
        throw new CancelledTurnStart("A newer turn superseded this preparation");
      }
      if (ctx.deliveryGuard && !ctx.deliveryGuard(guardedRunStartedAt)) throw new CancelledTurnStart("The parent conversation or turn changed before this instruction was delivered");
      if (cursorAttempt && (cursorAttempt.owner.closed || !isCurrentCursorTurnStart(startedThreadId ?? startingThreadId!, cursorAttempt))) {
        throw new CancelledTurnStart("This Cursor start was superseded");
      }
      if (pendingStart?.cancelRequested || (!activeThread && draftCancelled())) {
        throw new CancelledTurnStart("Stopped before starting the model turn");
      }
      if (activeThread) {
        const binding = threadProjectBindingsRef.current?.[activeThread.id];
        const liveThreadBinding = binding === undefined ? undefined : normalizedProjectPath(binding);
        const liveIsolation = threadWorktreesRef.current[activeThread.id];
        if (liveIsolation?.status === "missing" || liveIsolation?.status === "removed") {
          throw new CancelledTurnStart("The thread's isolated worktree became unavailable before starting the model turn");
        }
        if (liveThreadBinding !== sendThreadBinding
          || preparedExecutionPath !== undefined
            && normalizedProjectPath(executionPathFor(activeThread.id, activeWorkspace.path)) !== normalizedProjectPath(preparedExecutionPath)) {
          throw new CancelledTurnStart("The thread's execution folder changed before starting the model turn");
        }
      }
      // Preparation can await skill scans, bridges, worktrees and checkpoints.
      // A scheduled first prompt has no task identity during the early awaits,
      // so another shared-folder turn may start after the initial preflight.
      // Check the live owner again at each boundary, including immediately
      // before the provider call; exclude the thread this send just created.
      if (deferredDelivery && anotherSharedRun(startedThreadId ?? activeThread?.id)) {
        throw new Error(sharedFolderOverlapMessage);
      }
    };

    // The approved cross-provider destinations are captured once, on the first
    // turn of a thread, and reused verbatim afterwards. Binding them to the
    // thread id can only happen once the runtime has reported it.
    const rememberChildAgentPolicy = (threadId: string) => {
      if (!childBridge) return;
      const { policy, captured, policyUpdated } = childBridge;
      if (!captured && !policyUpdated && policy.rootThreadId === threadId) return;
      const next = { ...policy, rootThreadId: threadId };
      childBridge = { ...childBridge, policy: next, captured: false, policyUpdated: false };
      cacheChildAgentPolicy(next);
      persistChildAgentPolicies((current) => ({ ...current, [next.sessionId]: next }));
    };

    // Shared body of the Claude/Cursor subscription paths: bootstrap the
    // locally-owned thread record, bump its preview, mark the run, take the
    // checkpoint, post the optimistic message, then hand off to the provider
    // strategy for its transcript save + start RPC. Cleanup on failure is
    // handled by sendMessage's own catch via the shared mutable markers.
    const runLocalTurn = async (
      provider: "claude" | "cursor",
      executionPath: string,
      strategy: {
        prepareTurn: (thread: Thread, updatedThread: Thread) => Promise<void>;
        startTurn: (thread: Thread) => Promise<{ turnId: string; superseded?: boolean; stopped?: boolean }>;
        afterStart?: (threadId: string) => void;
        hardStop: (threadId: string, turnId?: string) => Promise<unknown>;
      },
    ): Promise<boolean> => {
      let thread = activeThread;
      if (!thread) {
        thread = { id: crypto.randomUUID(), name: null, preview: text.slice(0, 140), cwd: executionPath, updatedAt: Math.floor(Date.now() / 1000), modelProvider: provider };
        startedThreadId = thread.id;
        bindPendingFirstPrompt(ctx.firstPromptAttemptId, thread.id);
        bindThreadToProject(thread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(thread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [thread!.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(thread);
        contextRef.current.onThreadTitlePending?.(thread.id, text);
        onThreadCreated(thread.id, { deferred: Boolean(deferredDelivery), subagentsEnabled: effectiveSettings.subagentsEnabled, subagentEngine: effectiveSettings.subagentEngine, nativeSubagentMax: effectiveSettings.nativeSubagentMax, nativeSubagentOptions: effectiveSettings.nativeSubagentOptions, autoCompactTokens: effectiveSettings.autoCompactTokens });
        persistThreadModel(thread.id, effectiveSettings.model);
        persistThreadReasoning(thread.id, { reasoningEffort: effectiveSettings.reasoningEffort, ultra: effectiveSettings.ultra });
        useTaskStore.getState().ensureTask(thread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, thread!));
          if (!deferredDelivery && !threadSelectionChangedMidSend()) {
            activatedCreatedThreadId = thread.id;
            setActiveThread(thread);
            useTaskStore.getState().setActiveThread(thread.id);
          }
        }
      }
      startedThreadId = thread.id;
      rememberChildAgentPolicy(thread.id);
      // Stop landed while this brand-new thread was still being created. The
      // prompt was never delivered, so report it as undelivered and let the
      // composer hand the user their text back instead of silently eating it.
      if (!activeThread && draftCancelled()) {
        contextRef.current.onThreadTitleCancelled?.(thread.id);
        useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
        setStartingDraftTurn(false);
        setTransientStatus("Stopped");
        return false;
      }
      const updatedThread = { ...thread, preview: text.slice(0, 140) || thread.preview, updatedAt: Math.floor(Date.now() / 1000) };
      rememberThread(updatedThread);
      if (!workspaceChangedMidSend()) {
        setThreads((current) => upsertThread(current, updatedThread));
        if (!threadSelectionChangedMidSend()) setActiveThread(updatedThread);
      }
      useTaskStore.getState().ensureTask(thread.id, executionPath);
      if (provider === "cursor" && !cursorAttempt) cursorAttempt = beginCursorTurnStart(thread.id);
      if (!activeThread) {
        useTaskStore.getState().beginAgentRun(thread.id);
        guardedRunStartedAt = useTaskStore.getState().tasks[thread.id]?.agentRunStartedAt;
      }
      useTaskStore.getState().setTaskStatus(thread.id, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(thread.id);
      if (!initializeNewThreadGit) ownedCheckpointId = await beginRunCheckpoint(thread.id, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      assertCanStart();
      // Persist the owned thread/prior history before dispatch, not the new
      // optimistic prompt. A Stop or failed save must not leave undelivered
      // skill provenance in a durable (possibly paged) transcript.
      await ctx.ensureManagedLocalThreadHydrated?.(thread.id, assertCanStart);
      assertCanStart();
      await strategy.prepareTurn(thread, updatedThread);
      assertCanStart();
      sentMessageId = `local-${crypto.randomUUID()}`;
      receiptAttempt = beginTurnContextReceipt(thread.id);
      useTaskStore.getState().appendUserMessage(thread.id, {
        id: sentMessageId,
        role: "user",
        text,
        ...userSkillMetadata,
        attachments: messageImageAttachments(sentAttachments),
      });
      if (initializeNewThreadGit) {
        await ctx.prepareNewThreadGit?.(thread.id, activeWorkspace, true);
        assertCanStart();
        ownedCheckpointId = await beginRunCheckpoint(thread.id, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
        assertCanStart();
      }
      const taskBeforeDispatch = useTaskStore.getState().tasks[thread.id];
      activeTurnBeforeDispatch = taskBeforeDispatch?.activeTurnId;
      completedTurnBeforeDispatch = taskBeforeDispatch?.lastCompletedTurnId;
      explicitDispatched = true;
      const nativeStart: { startRequestId: string; runStartedAt?: number; turnId?: string } = {
        startRequestId: provider === "cursor" ? cursorAttempt?.owner.startRequestId ?? localStartRequestId : localStartRequestId,
        runStartedAt: guardedRunStartedAt,
      };
      localStartRequestsRef.current.set(thread.id, nativeStart);
      const result = await strategy.startTurn(thread);
      if (typeof result?.turnId !== "string" || !result.turnId.trim()) {
        throw new Error("MYTHRA_DELIVERY_UNCERTAIN: The provider accepted the start without returning its turn identifier.");
      }
      if (localStartRequestsRef.current.get(thread.id) === nativeStart) nativeStart.turnId = result.turnId;
      providerAccepted = true;
      if (!activeThread) contextRef.current.onThreadTitleRequested?.(thread.id, text);
      recordAuthoredPrompt(thread.id, sentMessageId);
      // Provider events can race ahead of the start RPC response. If a very
      // short turn already delivered its result, reinstalling it here would
      // resurrect the completed thread as permanently running.
      const completedBeforeStartReturned = useTaskStore.getState().tasks[thread.id]?.lastCompletedTurnId === result.turnId;
      const ownsIdentity = explicitAttemptCurrent()
        && useTaskStore.getState().tasks[thread.id]?.agentRunStartedAt === guardedRunStartedAt
        && !result.superseded && (!cursorAttempt || isCurrentCursorTurnStart(thread.id, cursorAttempt));
      if (ownsIdentity && contextReceipt) receiptAttempt.confirm({
        ...contextReceipt,
        model: effectiveSettings.model || (provider === "claude" ? DEFAULT_CLAUDE_MODEL : DEFAULT_CURSOR_MODEL),
      });
      const ownsStart = ownsIdentity && !result.stopped;
      if (ownsStart && !completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(thread.id, result.turnId);
        useTaskStore.getState().setTaskStatus(thread.id, "running");
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (ownsIdentity) strategy.afterStart?.(thread.id);
      if (pendingTurnStartsRef.current.finish(thread.id, pendingStart) && ownsStart && !completedBeforeStartReturned) {
        markProviderStopIntent(thread.id, result.turnId);
        try {
          await strategy.hardStop(thread.id, result.turnId);
        } catch (reason) {
          clearProviderStopIntent(thread.id, result.turnId);
          throw reason;
        }
        if (!cursorAttempt || isCurrentCursorTurnStart(thread.id, cursorAttempt)) {
          if (sealStoppedTurn(thread.id, result.turnId)) setTransientStatus("Stopped");
          strategy.afterStart?.(thread.id);
        }
        clearProviderStopIntent(thread.id, result.turnId);
      }
      return true;
    };

    try {
      if (sharedDraftStart) {
        // Reserve synchronously before any preparation await. The draft flag
        // alone is invisible to other background deliveries until a thread id
        // exists; the reservation bridges that identity gap.
        pendingSharedDraftStarts.set(sharedDraftStart, sendWorkspacePath);
        if (!deferredDelivery) ordinarySharedDraftStartsRef.current.set(sharedDraftStart, ctx.firstPromptAttemptId);
      }
      // Skill scans can wait on disk or startup preparation. They are part of
      // starting a turn, so expose Stop before awaiting them and honor it
      // before creating any workspace, bridge, or provider process.
      if (ctx.resolveSkillPrompts) {
        const resolved = await ctx.resolveSkillPrompts(text, effectiveSettings.systemPrompt, ctx.resolveSkillMentions === false ? "" : ctx.skillInvocationText);
        providerText = resolved.prompt;
        resolvedSystemPrompt = resolved.systemPrompt;
        userSkillMetadata = { skillReferences: ctx.resolveSkillMentions === false ? [] : resolved.skillReferences, skillsFolder: resolved.skillsFolder, skillDependencies: resolved.skillDependencies };
      } else {
        providerText = await resolveSkillPrompt(text, ctx.skillInvocationText);
        userSkillMetadata = ctx.resolveSkillMentions === false ? { skillReferences: [] } : ctx.getSkillReferences?.(text, ctx.skillInvocationText) ?? {};
      }
      const instructionsWithSkills = resolvedSystemPrompt;
      // Learned documents never enter authored skill resolution or saved
      // settings/child baselines. Read the captured target's current documents
      // once for this new turn; steering keeps its running policy frozen.
      assertCanStart();
      resolvedSystemPrompt = await appendCurrentLearnedPreferences(resolvedSystemPrompt, activeProject?.id ?? null);
      const instructionsWithMemory = resolvedSystemPrompt;
      assertCanStart();
      let executionPath = activeWorkspace.path;
      if (!activeThread && draftThreadIsolated && activeProject) {
        provisionalWorktree = await createThreadWorktree(activeProject.path, text);
        executionPath = provisionalWorktree.path;
      } else if (activeThread) {
        executionPath = executionPathFor(activeThread.id, activeWorkspace.path);
      }
      preparedExecutionPath = executionPath;
      assertCanStart();
      resolvedSystemPrompt = await appendProjectInstructionContext(
        resolvedSystemPrompt, activeProject ? executionPath : null, effectiveSettings, assertCanStart,
      );
      assertCanStart();
      contextReceipt = createTurnContextReceipt({
        provider: effectiveSettings.provider,
        model: effectiveSettings.model,
        effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
        permission: effectiveSettings.permission,
        stages: [
          { label: "Your instructions", text: effectiveSettings.systemPrompt },
          { label: "Skills", text: instructionsWithSkills },
          { label: "Memory", text: instructionsWithMemory },
          { label: "Project files", text: resolvedSystemPrompt },
        ],
        userSkillPrompt: providerText,
        skills: userSkillMetadata.skillReferences?.map((reference) => reference.name),
        attachments: sentAttachments.length,
      });
      if (isPullRequestMutationRunning(executionPath)) {
        throw new Error("Wait for the pull request operation to finish before starting another model turn.");
      }
      const isolationGitDir = provisionalWorktree?.gitDir ?? currentIsolation?.gitDir;
      const additionalWorkspaceRoots = isolationGitDir ? [isolationGitDir] : [];
      // Provision only for real project threads, never a normal chat's backing
      // directory. Existing installations are shared across project worktrees.
      if (!activeThread && activeProject) {
        setStatus("Checking language tools…");
        await invoke("language_tools_prepare_project", { cwd: executionPath, permission: effectiveSettings.permission }).catch(() => undefined);
        assertCanStart();
      }
      if (activeThread && effectiveSettings.provider !== "claude" && effectiveSettings.provider !== "cursor") {
        await waitForThreadPreparation(activeThread.id);
        assertCanStart();
      }
      childBridge = await ensureChildAgentBridge({
        provider: effectiveSettings.provider,
        projectPath: activeProject ? executionPath : undefined,
        threadId: activeThread?.id,
        policies: childAgentPolicies,
        links: childAgentLinks,
        isChildThread: Boolean(activeThread && childThread),
        settings: effectiveSettings,
        permission: effectiveSettings.permission,
        systemPrompt: effectiveSettings.systemPrompt,
        providerSystemPrompts: subscriptionSystemPrompts,
        projectInstructionsEnabled: effectiveSettings.projectInstructionsEnabled,
        projectClaudeInstructionsEnabled: effectiveSettings.projectClaudeInstructionsEnabled === true,
        reasoningEffort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
        serviceTier: effectiveSettings.serviceTier,
        readiness: childAgentReadiness,
        settingsProposalsEnabled: Boolean(activeProject) && effectiveSettings.subagentEngine !== "native",
        // Thread selection may attach a bridge, but only sending a prompt is
        // allowed to consume a staged thread-local crew edit.
        promoteStagedEdits: true,
      });
      assertCanStart();
      // A managed crew retains its captured budget. Native delegation uses
      // the conversation's separate budget, even after switching away from a
      // previously captured Mythra crew.
      const capturedPolicy = childAgentPolicyForThread(childAgentPolicies, activeThread?.id);
      const runtimeSubagentMax = effectiveSettings.subagentEngine === "native"
        ? sanitizeNativeSubagentMax(effectiveSettings.nativeSubagentMax)
        : childBridge?.policy.maxConcurrent
          ?? capturedPolicy?.maxConcurrent
          ?? effectiveSettings.subagentMax;
      const runtimeSettings = { ...effectiveSettings, systemPrompt: resolvedSystemPrompt, subagentMax: runtimeSubagentMax };
      const collaborationV2 = !nativeDelegation && childBridge?.policy.collaborationV2 === true
        && Boolean(childBridge?.launch.toolNames.includes("send_agent_message")
        && childBridge?.launch.toolNames.includes("accept_agent"));
      // The Run button is a project feature: the model is told about it (and
      // its current command) only when this thread's bridge can change it.
      const runButton = {
        toolAvailable: Boolean(childBridge?.launch.toolNames.includes(RUN_COMMAND_TOOL)),
        run: activeProject?.overrides?.run ?? null,
      };
      const checkButton = {
        toolAvailable: Boolean(childBridge?.launch.toolNames.includes(CHECK_COMMAND_TOOL)),
        check: activeProject?.overrides?.check ?? null,
      };
      if (effectiveSettings.provider === "claude") {
        if (skillsFolder && !skillRuntimeRootRef.current) await refreshLocalSkills();
        assertCanStart();
        return await runLocalTurn("claude", executionPath, {
          prepareTurn: (thread, updatedThread) => saveClaudeTranscript({ thread: updatedThread, messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] }),
          startTurn: async (thread) => {
            // Appending the optimistic user message cannot flip assistant
            // presence, so resume detection is unaffected by running after it.
            const canResumeClaude = Boolean(activeThread && useTaskStore.getState().tasks[thread.id]?.messages.some((message) => message.role === "assistant"));
            const result = await startClaudeTurn({ threadId: thread.id, startRequestId: localStartRequestId, cwd: executionPath, prompt: providerText, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: withMythraCodeCompletionInstructions(resolvedSystemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")), runButton, checkButton, nativeDelegation, collaborationV2), resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentMax: runtimeSubagentMax, nativeSubagents: nativeDelegation, nativeSubagentMax: sanitizeNativeSubagentMax(effectiveSettings.nativeSubagentMax), autoCompactTokens: effectiveSettings.autoCompactTokens, ...(nativeDelegation ? { nativeSubagentModel: effectiveSettings.nativeSubagentOptions?.claude?.model?.trim() || undefined, nativeAutoCompactTokens: effectiveSettings.nativeSubagentOptions?.claude?.autoCompactTokens } : {}), customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined, childAgentBridgeConfig: childBridge?.launch.configPath });
            if (typeof result?.turnId !== "string" || !result.turnId.trim()) {
              throw new Error("MYTHRA_DELIVERY_UNCERTAIN: Claude accepted the start without returning its turn identifier.");
            }
            return { turnId: result.turnId };
          },
          afterStart: (threadId) => scheduleClaudeThreadSave(threadId),
          hardStop: (threadId, turnId) => killClaudeTurn(threadId, { turnId, startRequestId: localStartRequestId }),
        });
      }

      if (effectiveSettings.provider === "cursor") {
        const priorThreadId = activeThread?.id;
        if (priorThreadId && !cursorSessionIdsRef.current[priorThreadId]) {
          const native = await invoke<{ cursorSessionId?: string } | null>("cursor_turn_state", { threadId: priorThreadId });
          assertCanStart();
          if (native?.cursorSessionId?.trim()) cursorSessionIdsRef.current[priorThreadId] = native.cursorSessionId;
          else {
            const saved = await loadCursorTranscript(priorThreadId);
            assertCanStart();
            if (saved && (saved.thread.id !== priorThreadId || saved.thread.modelProvider !== "cursor"
              || !saved.thread.cwd?.trim() || normalizedProjectPath(saved.thread.cwd) !== normalizedProjectPath(executionPath))) {
              throw new Error("The saved Cursor conversation no longer matches this thread's execution folder.");
            }
            if (saved?.cursorSessionId?.trim()) {
              cursorSessionIdsRef.current[priorThreadId] = saved.cursorSessionId;
              const resident = useTaskStore.getState().tasks[priorThreadId];
              useTaskStore.getState().hydrateTask(priorThreadId, saved.messages, saved.activities, executionPath, resident?.history, undefined, { source: "local" });
            } else if (saved?.messages.some((message) => message.role === "assistant")
              || useTaskStore.getState().tasks[priorThreadId]?.messages.some((message) => message.role === "assistant")) {
              throw new Error("This Cursor conversation's resume identity is unavailable. Its saved history was retained; a replacement conversation was not started.");
            }
          }
        }
        return await runLocalTurn("cursor", executionPath, {
          prepareTurn: (thread, updatedThread) => saveCursorTranscript({ thread: updatedThread, cursorSessionId: cursorSessionIdsRef.current[thread.id] ?? "", messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] }),
          startTurn: async (thread) => {
            const priorSessionId = cursorSessionIdsRef.current[thread.id];
            const result = await startCursorTurn({
              threadId: thread.id,
              startRequestId: cursorAttempt?.owner.startRequestId,
              cwd: executionPath,
              prompt: providerText,
              model: effectiveSettings.model || DEFAULT_CURSOR_MODEL,
              effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
              permission: effectiveSettings.permission,
              systemPrompt: withMythraCodeCompletionInstructions(resolvedSystemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")), runButton, checkButton, nativeDelegation, collaborationV2),
              resumeSessionId: priorSessionId || undefined,
              attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
              childAgentBridge: childBridge
                ? { name: childBridge.launch.name, command: childBridge.launch.command, args: childBridge.launch.args }
                : undefined,
            });
            if (typeof result?.turnId !== "string" || !result.turnId.trim()) {
              throw new Error("MYTHRA_DELIVERY_UNCERTAIN: Cursor accepted the start without returning its turn identifier.");
            }
            if (!result.superseded && (!cursorAttempt || isCurrentCursorTurnStart(thread.id, cursorAttempt))) cursorSessionIdsRef.current[thread.id] = result.cursorSessionId;
            return { turnId: result.turnId, superseded: result.superseded, stopped: result.stopped };
          },
          afterStart: (threadId) => scheduleCursorThreadSave(threadId),
          hardStop: (threadId, turnId) => killCursorTurn(threadId, { turnId, startRequestId: cursorAttempt?.owner.startRequestId }),
        });
      }

      await ensureSkillRoots();
      assertCanStart();
      const input = buildTurnInput(providerText, sentAttachments);
      // The Codex app server keeps one thread alive across turns and only reads
      // this config when a thread is started or resumed, so the capabilities it
      // is holding have to be compared against the ones this turn wants — and
      // against the app-server identity that was told about them, because a
      // runtime that has since restarted holds nothing at all.
      const currentRuntime = activeThread
        ? await runtimeThreadState(activeThread.id)
        : { instance: await runtimeInstanceId(), loaded: false };
      assertCanStart();
      let runtimeInstance = currentRuntime.instance;
      const capabilities = subagentCapabilitySignature({
        subagentsEnabled: nativeDelegation || Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")),
        subagentEngine: effectiveSettings.subagentEngine,
        nativeSubagentMax: effectiveSettings.nativeSubagentMax,
        nativeSubagentOptions: effectiveSettings.nativeSubagentOptions,
        autoCompactTokens: effectiveSettings.autoCompactTokens,
        subagentMax: runtimeSubagentMax,
        // The same policy receives a new token/config path whenever its bridge
        // is rebuilt. App-server must be refreshed so it starts that process,
        // rather than retaining an MCP process holding the revoked old token.
        bridgeInstanceId: childBridge?.launch.configPath,
      }, { provider: runtimeSettings.provider, lmStudioBaseUrl: runtimeSettings.lmStudioBaseUrl, modelContextWindow });
      let threadId = activeThread?.id;
      let runtimeTurnModel: unknown;
      startedThreadId = threadId;
      if (!threadId) {
        const result = await rpc<{ thread: Thread; model?: unknown; runtimeInstance: string }>("thread/start", threadStartParams(runtimeSettings, executionPath, { serviceName: activeWorkspace.isChat ? "Mythra Code Chat" : "Mythra Code", customAgents, modelContextWindow, interactive: true, perTurnSystemPrompt: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch, projectRunCommand: runButton.run, projectCheckCommand: checkButton.check }));
        runtimeInstance = result.runtimeInstance;
        const startedThread = optimisticStartedThread(result.thread, text);
        runtimeTurnModel = result.model;
        threadId = startedThread.id;
        startedThreadId = threadId;
        bindPendingFirstPrompt(ctx.firstPromptAttemptId, threadId);
        bindThreadToProject(startedThread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(startedThread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [startedThread.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(startedThread);
        contextRef.current.onThreadTitlePending?.(startedThread.id, text);
        onThreadCreated(startedThread.id, { deferred: Boolean(deferredDelivery), subagentsEnabled: effectiveSettings.subagentsEnabled, subagentEngine: effectiveSettings.subagentEngine, nativeSubagentMax: effectiveSettings.nativeSubagentMax, nativeSubagentOptions: effectiveSettings.nativeSubagentOptions, autoCompactTokens: effectiveSettings.autoCompactTokens });
        persistThreadModel(startedThread.id, effectiveSettings.model.trim() || (typeof runtimeTurnModel === "string" ? runtimeTurnModel.trim() : ""));
        persistThreadReasoning(startedThread.id, { reasoningEffort: effectiveSettings.reasoningEffort, ultra: effectiveSettings.ultra });
        recordSubagentCapabilities(startedThread.id, runtimeInstance, capabilities);
        useTaskStore.getState().ensureTask(startedThread.id, executionPath);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, startedThread));
          if (!deferredDelivery && !threadSelectionChangedMidSend()) {
            activatedCreatedThreadId = startedThread.id;
            setActiveThread(startedThread);
            useTaskStore.getState().setActiveThread(startedThread.id);
          }
        }
      } else {
        // Startup-only config overrides are intentionally ignored by Codex
        // when thread/resume rejoins a thread already loaded in app-server.
        // Refresh the managed runtime between turns before resuming whenever
        // that runtime is holding this thread with different capabilities.
        // This keeps the same durable thread/history while making the visible
        // switch real; a runtime that restarted since then has nothing loaded
        // and takes the new config from the resume alone.
        const plan = planSubagentCapabilities(threadId, runtimeInstance, capabilities, currentRuntime.loaded);
        if (plan.restartRuntime) runtimeInstance = await contextRef.current.restartRuntimeForCapabilities(threadId, true);
        assertCanStart();
        if (effectiveSettings.provider === "openrouter" || effectiveSettings.provider === "lmstudio" || plan.resume) {
          const resume = threadResumeParams(runtimeSettings, threadId, executionPath, { customAgents, modelContextWindow, excludeTurns: true, perTurnSystemPrompt: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true, projectRunCommand: runButton.run, projectCheckCommand: checkButton.check });
          const resumed = await rpc<{ model?: unknown; runtimeInstance: string }>("thread/resume", effectiveSettings.provider === "openrouter" || effectiveSettings.provider === "lmstudio" ? { ...resume, model: effectiveSettings.model } : resume);
          runtimeInstance = resumed.runtimeInstance;
          runtimeTurnModel = resumed?.model;
          recordSubagentCapabilities(threadId, runtimeInstance, capabilities);
        }
      }

      assertCanStart();

      if (activeThread?.id === threadId) {
        const updatedThread = { ...activeThread, updatedAt: Math.floor(Date.now() / 1000) };
        rememberThread(updatedThread);
        if (!workspaceChangedMidSend()) {
          setThreads((current) => upsertThread(current, updatedThread));
          if (!threadSelectionChangedMidSend()) setActiveThread(updatedThread);
        }
      }
      rememberChildAgentPolicy(threadId);
      // See runLocalTurn: a draft stopped before its turn started keeps its text.
      if (!activeThread && draftCancelled()) {
        contextRef.current.onThreadTitleCancelled?.(threadId);
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setStartingDraftTurn(false);
        setTransientStatus("Stopped");
        return false;
      }
      useTaskStore.getState().ensureTask(threadId, executionPath);
      if (!activeThread) {
        useTaskStore.getState().beginAgentRun(threadId);
        guardedRunStartedAt = useTaskStore.getState().tasks[threadId]?.agentRunStartedAt;
      }
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(threadId);
      if (!initializeNewThreadGit) ownedCheckpointId = await beginRunCheckpoint(threadId, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      assertCanStart();
      sentMessageId = `local-${crypto.randomUUID()}`;
      receiptAttempt = beginTurnContextReceipt(threadId);
      useTaskStore.getState().appendUserMessage(threadId, {
        id: sentMessageId,
        role: "user",
        text,
        ...userSkillMetadata,
        attachments: messageImageAttachments(sentAttachments),
      });

      if (initializeNewThreadGit) {
        await ctx.prepareNewThreadGit?.(threadId, activeWorkspace, true);
        assertCanStart();
        ownedCheckpointId = await beginRunCheckpoint(threadId, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
        assertCanStart();
      }

      ctx.onCodexRuntimeOwned?.(threadId, runtimeInstance);
      const params = { ...turnStartParams(runtimeSettings, threadId, executionPath, input, additionalWorkspaceRoots, true, {
        systemPrompt: resolvedSystemPrompt,
        model: typeof runtimeTurnModel === "string" ? runtimeTurnModel : undefined,
        developerInstructions: mythraCodeDeveloperInstructions(
          Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")),
          Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")),
          runButton,
          checkButton,
          nativeDelegation,
          collaborationV2,
        ),
      }), expectedRuntimeInstance: runtimeInstance };
      const taskBeforeDispatch = useTaskStore.getState().tasks[threadId];
      activeTurnBeforeDispatch = taskBeforeDispatch?.activeTurnId;
      completedTurnBeforeDispatch = taskBeforeDispatch?.lastCompletedTurnId;
      explicitDispatched = true;
      const result = await rpc<{ turn: Turn }>("turn/start", params);
      if (typeof result?.turn?.id !== "string" || !result.turn.id.trim()) {
        throw new Error("MYTHRA_DELIVERY_UNCERTAIN: The runtime accepted the start without returning its turn identifier.");
      }
      providerAccepted = true;
      // Retain the last confirmed receipt through rejected/cancelled starts.
      // An older response must not replace a newer turn's confirmed context.
      if (contextReceipt && explicitAttemptCurrent()
        && useTaskStore.getState().tasks[threadId]?.agentRunStartedAt === guardedRunStartedAt) {
        receiptAttempt.confirm({
          ...contextReceipt,
          model: typeof runtimeTurnModel === "string" ? runtimeTurnModel : contextReceipt.model,
        });
      }
      if (!activeThread) contextRef.current.onThreadTitleRequested?.(threadId, text);
      recordAuthoredPrompt(threadId, sentMessageId);
      const resultTurnId = result.turn?.id;
      const completedBeforeStartReturned = Boolean(
        resultTurnId
        && useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId === resultTurnId,
      );
      if (explicitAttemptCurrent() && useTaskStore.getState().tasks[threadId]?.agentRunStartedAt === guardedRunStartedAt
        && resultTurnId && !completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(threadId, resultTurnId);
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (pendingTurnStartsRef.current.finish(threadId, pendingStart) && !completedBeforeStartReturned) {
        // The user pressed stop while the turn was still starting.
        await rpc("turn/interrupt", { threadId, turnId: resultTurnId });
        if (sealStoppedTurn(threadId, resultTurnId)) setTransientStatus("Stopped");
      }
      return true;
    } catch (reason) {
      const cancelled = reason instanceof CancelledTurnStart;
      if (reason instanceof SkillDependencyError) ctx.onSkillDependencyFailure?.(reason);
      setStartingDraftTurn(false);
      // Use the locally captured thread ids: for a brand-new thread the
      // activeThread closure is still null here (which used to leave the
      // thread stuck in "starting" forever), and a failure before the send
      // resolved its thread must still clear the "starting" mark applied at
      // the top of this function.
      const failedThreadId = startedThreadId ?? startingThreadId;
      const ownsAttempt = explicitAttemptCurrent()
        && (!failedThreadId || guardedRunStartedAt === undefined
          || useTaskStore.getState().tasks[failedThreadId]?.agentRunStartedAt === guardedRunStartedAt)
        && (!cursorAttempt || !failedThreadId || isCurrentCursorTurnStart(failedThreadId, cursorAttempt));
      const failedTask = failedThreadId ? useTaskStore.getState().tasks[failedThreadId] : undefined;
      const runtimeObserved = ownsAttempt && Boolean(
        failedTask?.activeTurnId && failedTask.activeTurnId !== activeTurnBeforeDispatch
        || failedTask?.lastCompletedTurnId && failedTask.lastCompletedTurnId !== completedTurnBeforeDispatch,
      );
      if (!providerAccepted && explicitDispatched && (deliveryIsUncertain(reason) || runtimeObserved) && failedThreadId) {
        if (!activeThread) contextRef.current.onThreadTitleCancelled?.(failedThreadId);
        const stopRequested = pendingStart ? pendingTurnStartsRef.current.finish(failedThreadId, pendingStart) : false;
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        if (ownsAttempt) {
          useTaskStore.getState().upsertActivity(failedThreadId, {
            id: `start-uncertain-${explicitAttemptId ?? sentMessageId ?? failedThreadId}`,
            kind: "warning", title: "Provider start could not be confirmed",
            detail: "The provider may have received this prompt. Its conversation and checkpoint remain owned; this prompt was not automatically resent. Inspect or stop this work before retrying it.",
          });
          if (effectiveSettings.provider === "claude") scheduleClaudeThreadSave(failedThreadId);
          else if (effectiveSettings.provider === "cursor") scheduleCursorThreadSave(failedThreadId);
        }
        if (ownsAttempt) setError(stopRequested
          ? "The provider start and Stop cutoff could not be confirmed. The prompt and checkpoint were retained; inspect or stop this work before retrying it."
          : "The provider start could not be confirmed. The prompt and checkpoint were retained; inspect or stop this work before retrying it.");
        return true;
      }
      // A failed interruption or post-start callback is not a failed send.
      // Keep the accepted prompt/checkpoint and live turn; restoring its draft
      // would invite a duplicate send while the provider is still working.
      if (providerAccepted && failedThreadId) {
        if (pendingStart) pendingTurnStartsRef.current.finish(failedThreadId, pendingStart);
        setAttachments((current) => withoutSentAttachments(current, sentAttachments));
        if (ownsAttempt) setError(friendlyError(reason));
        return true;
      }
      if (!activeThread && failedThreadId) contextRef.current.onThreadTitleCancelled?.(failedThreadId);
      // `captured` is cleared the moment the policy is bound to a thread and
      // persisted. Anything still flagged as captured was registered with the
      // backend for a turn that never started, so nothing will ever reuse it —
      // including a policy captured mid-conversation for an existing thread.
      if (childBridge?.captured) {
        await releaseChildAgentSession(childBridge.policy.sessionId);
      }
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
        const ownsFailure = ownsAttempt;
        if (ownsFailure && ownedCheckpointId) discardRunCheckpoint(failedThreadId, ownedCheckpointId);
        if (pendingStart) pendingTurnStartsRef.current.finish(failedThreadId, pendingStart);
        if (ownsFailure && sentMessageId) useTaskStore.getState().removeMessage(failedThreadId, sentMessageId);
        if (ownsFailure) useTaskStore.getState().setTaskStatus(failedThreadId, cancelled ? "interrupted" : "error", cancelled ? undefined : friendlyError(reason));
        if (ownsFailure && isClaudeThreadBusyError(reason)) {
          // The backend slot is held by a Claude process the UI no longer
          // tracks (e.g. after an event loss). Free it so a retry succeeds
          // instead of failing until Mythra Code restarts.
          await killClaudeTurn(failedThreadId, { startRequestId: localStartRequestId }).catch(() => undefined);
        } else if (ownsFailure && effectiveSettings.provider === "cursor" && /already working/i.test(friendlyError(reason))) {
          void killCursorTurn(failedThreadId, { startRequestId: cursorAttempt?.owner.startRequestId }).catch(() => undefined);
        }
        if (cursorAttempt) {
          rejectCursorTurnStart(failedThreadId, cursorAttempt);
          if (!ownsFailure) return false;
        }
        if (!ownsFailure) return false;
      }
      setStatus("Ready");
      if (cancelled) setTransientStatus("Stopped");
      else setError(friendlyError(reason));
      return false;
    } finally {
      receiptAttempt?.finish();
      if (sharedDraftStart) {
        pendingSharedDraftStarts.delete(sharedDraftStart);
        ordinarySharedDraftStartsRef.current.delete(sharedDraftStart);
      }
    }
    } finally {
      if (subagentPreparation) {
        subagentPreparationsRef.current.delete(subagentPreparation);
        notifySubagentPreparationChanged();
      }
      if (explicitThreadId && explicitAttemptId) ctx.onExplicitChildStartSettled?.(explicitThreadId, explicitAttemptId, explicitDispatched);
    }
  }, [archiveOwnsThread, bindPendingFirstPrompt, notifySubagentPreparationChanged]);

  const pumpQueuedThread = useCallback(async (threadId: string, force = false): Promise<void> => {
    if (activeQueuedDeliveries.has(threadId)) return;
    const state = useTaskStore.getState();
    if (state.workflowOwners[threadId]) return;
    const task = state.tasks[threadId];
    if (!task || task.status === "starting" || task.status === "running") return;
    // "idle" is the status a task carries when its queue was restored from disk
    // in a later app session: the run those follow-ups were queued behind no
    // longer exists, so the oldest one is simply the next thing to start.
    if (!force && task.status !== "completed" && task.status !== "idle") return;
    // Strictly FIFO: only ever start the head. A head left "failed" (or being
    // steered) holds the queue until the user retries or removes it, so
    // follow-ups can never silently run out of the order they were written in.
    // Pending timed prompts are not in this FIFO at all, so a regular entry is
    // never held behind one and a timed entry can never start early.
    const queuedTurn = eligibleQueueHead(task.queuedTurns);
    if (!queuedTurn || queuedTurn.status !== "queued" || queuedTurn.editing) return;
    const capturedContext = queuedDeliveries.get(queuedTurn.id)?.context;
    // A durable queue can outlive the renderer. Once the user opens that task,
    // the render path below reattaches a fresh delivery context and pumping
    // resumes; guessing provider/workspace settings before then is unsafe.
    if (!capturedContext) return;
    const liveThread = capturedContext.currentThread?.(threadId);
    const queuedContext = liveThread?.id === threadId ? { ...capturedContext, activeThread: liveThread } : capturedContext;
    // Archive ownership can begin after a completion scheduled this pump. Keep
    // the durable entry queued so releasing the archive lock can retry it.
    if (archiveOwnsThread(threadId)) return;

    activeQueuedDeliveries.add(threadId);
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "sending");
    let delivered = false;
    let deliveryError: string | null = null;
    let retryBusySlot = false;
    try {
      // The captured provider context is stable, but an inline edit may have
      // changed the entry's skill source since it was first queued.
      delivered = await deliverMessage(
        {
          ...withLiveDeliveryReadiness(queuedContext, contextRef.current),
          skillInvocationText: queuedTurn.skillInvocationText,
          setError: (error) => { deliveryError = error; queuedContext.setError(error); },
        },
        queuedTurn.text,
        "turn",
      );
      if (delivered) {
        useTaskStore.getState().removeQueuedTurn(threadId, queuedTurn.id);
        queuedDeliveries.delete(queuedTurn.id);
        queuedBusyRetries.delete(queuedTurn.id);
      } else {
        const error = deliveryError ?? useTaskStore.getState().tasks[threadId]?.error ?? "The queued turn could not be started.";
        // The Claude result event and Windows process-tree teardown used to
        // cross in flight. Even with the backend ordering fixed, retain one
        // bounded recovery for older runtimes or an unusually slow cleanup:
        // the user's message stays queued and is retried after the stale slot
        // has been force-released instead of being painted as a failed turn.
        if (isClaudeThreadBusyError(error) && !queuedBusyRetries.has(queuedTurn.id)) {
          queuedBusyRetries.add(queuedTurn.id);
          retryBusySlot = true;
          useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "queued");
        } else {
          useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", error);
        }
      }
    } catch (reason) {
      // Delivery reports failure by returning false; an actual throw would
      // otherwise leave this thread's queue wedged for the rest of the session.
      useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", friendlyError(reason));
    } finally {
      activeQueuedDeliveries.delete(threadId);
    }

    if (retryBusySlot) {
      queueMicrotask(() => { void pumpQueuedThread(threadId, true); });
      return;
    }

    // A very fast provider can finish before its start call resolves. If that
    // happened, there was no later status transition to wake the next item.
    if (delivered && useTaskStore.getState().tasks[threadId]?.status === "completed") {
      queueMicrotask(() => { void pumpQueuedThread(threadId); });
    }
  }, [archiveOwnsThread, deliverMessage]);

  // Reattach durable queue entries to the live provider/workspace context
  // whenever their task is open. Entries created during this app session keep
  // their original captured context and therefore continue in the background.
  const activeThreadId = context.activeThread?.id ?? null;
  if (activeThreadId) {
    const queuedTurns = useTaskStore.getState().tasks[activeThreadId]?.queuedTurns ?? [];
    for (const queuedTurn of queuedTurns) {
      // Refresh live readiness/settings for entries the user can act on. The
      // thread/provider/workspace identity remains the same, while a sign-in,
      // model repair, or settings change made after queuing can now unblock a
      // retry without requiring an app restart.
      if (activeQueuedDeliveries.has(activeThreadId)) continue;
      queuedDeliveries.set(queuedTurn.id, {
        threadId: activeThreadId,
        context: queuedDeliveryContext(context, activeThreadId, queuedTurn.attachments, queuedTurn.resolveSkillMentions, queuedTurn.skillInvocationText),
      });
    }
  }

  // New-thread prompts belong to a logical workspace, not the visible thread.
  // App supplies workspaceGitInfo for activeProject.path (the project root),
  // even while an existing isolated/child thread is open. The deferred context
  // clears activeThread, so its start never inherits that thread's worktree.
  const scheduledWorkspacePath = context.activeWorkspace
    ? normalizedProjectPath(context.activeWorkspace.path)
    : null;
  if (scheduledWorkspacePath) {
    for (const [workspacePath, prompts] of Object.entries(useNewThreadTimedPrompts.getState().prompts)) {
      if (normalizedProjectPath(workspacePath) !== scheduledWorkspacePath) continue;
      for (const prompt of prompts) {
        if (!newThreadDeliveriesInFlight.has(prompt.id)) newThreadDeliveries.set(prompt.id, newThreadDeliveryContext(context, prompt));
      }
    }
  }

  const startNewThreadPrompt = useCallback((id: string): boolean => {
    const prompt = findNewThreadTimedPrompt(id);
    if (!prompt || prompt.status !== "queued" || prompt.editing || newThreadDeliveriesInFlight.has(id) || !newThreadDeliveries.has(id)) return false;
    newThreadDeliveriesInFlight.add(id);
    useNewThreadTimedPrompts.getState().setStatus(id, "sending");
    newThreadDeliveryChain = newThreadDeliveryChain.then(async () => {
      const latest = findNewThreadTimedPrompt(id);
      const ctx = newThreadDeliveries.get(id);
      try {
        if (!latest || latest.status !== "sending" || !ctx) return;
        newThreadDeliveryErrors.delete(id);
        let delivered = false;
        try {
          delivered = await deliverMessage({ ...withLiveDeliveryReadiness(ctx, contextRef.current), skillInvocationText: latest.skillInvocationText }, latest.text, "turn");
        } catch (reason) {
          newThreadDeliveryErrors.set(id, friendlyError(reason));
        }
        if (delivered) {
          useNewThreadTimedPrompts.getState().remove(id);
          newThreadDeliveries.delete(id);
        } else {
          useNewThreadTimedPrompts.getState().setStatus(id, "failed", newThreadDeliveryErrors.get(id) ?? "The scheduled prompt could not be started.");
        }
      } finally {
        newThreadDeliveryErrors.delete(id);
        newThreadDeliveriesInFlight.delete(id);
      }
    });
    return true;
  }, [deliverMessage]);

  /**
   * One clock check. A timed prompt is released only when this session saw
   * its time pass within timer jitter with no detected suspension, and a delivery context exists
   * at that moment. Everything else that is due — first check after launch or
   * reload, a suspended gap (sleep), or no context — is persisted as missed and
   * waits for the user: a prompt written for 9:00 must never run at 18:00, or
   * even at 9:00:20 after reopening, without being asked.
   */
  const releaseDueTimedPrompts = useCallback(() => {
    const now = Date.now();
    const performanceNow = performance.now();
    const previousCheckAt = lastTimedClockCheckAt;
    const elapsedAwakeMs = lastTimedPerformanceCheckAt === null ? undefined : performanceNow - lastTimedPerformanceCheckAt;
    lastTimedClockCheckAt = now;
    lastTimedPerformanceCheckAt = performanceNow;
    const releasable = new Map<string, string[]>();
    const missed = new Map<string, string[]>();
    const add = (target: Map<string, string[]>, threadId: string, id: string) => target.set(threadId, [...(target.get(threadId) ?? []), id]);
    for (const entry of storedPendingTimedTurns()) {
      if (entry.missedAt !== undefined || entry.editing || entry.status === "sending") continue;
      const decision = timedClockDecision(entry.deliverAt!, now, previousCheckAt, undefined, elapsedAwakeMs);
      if (decision === "wait") continue;
      const deliverable = queuedDeliveries.get(entry.id)?.threadId === entry.threadId && Boolean(useTaskStore.getState().tasks[entry.threadId]);
      add(decision === "release" && deliverable ? releasable : missed, entry.threadId, entry.id);
    }
    for (const [threadId, ids] of missed) useTaskStore.getState().markTimedTurnsMissed(threadId, ids, now);
    for (const [threadId, ids] of releasable) {
      useTaskStore.getState().releaseTimedTurns(threadId, ids);
      const task = useTaskStore.getState().tasks[threadId];
      const head = task ? eligibleQueueHead(task.queuedTurns) : undefined;
      // An earlier Stop or failure holds ordinary follow-ups for the user.
      // A prompt deliberately scheduled for now is a fresh intent, so it may
      // start a stopped thread — but only when nothing held is ahead of it.
      const stoppedBefore = task?.status === "interrupted" || task?.status === "error";
      void pumpQueuedThread(threadId, Boolean(stoppedBefore && head && ids.includes(head.id)));
    }
    const missedNewThread: string[] = [];
    for (const prompts of Object.values(useNewThreadTimedPrompts.getState().prompts)) {
      for (const prompt of prompts) {
        if (prompt.status !== "queued" || prompt.editing || prompt.missedAt !== undefined) continue;
        const decision = timedClockDecision(prompt.deliverAt, now, previousCheckAt, undefined, elapsedAwakeMs);
        if (decision === "wait") continue;
        if (decision !== "release" || !startNewThreadPrompt(prompt.id)) missedNewThread.push(prompt.id);
      }
    }
    if (missedNewThread.length) useNewThreadTimedPrompts.getState().markMissed(missedNewThread, now);
  }, [pumpQueuedThread, startNewThreadPrompt]);

  // One timer for the nearest future delivery, re-armed only when a queue
  // changes, plus focus/visibility/wake checks. With no timed prompts there is
  // no timer at all, and streamed deltas never reach this code.
  useEffect(() => {
    let timer: number | null = null;
    let checkPending = false;
    const arm = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const now = Date.now();
      let next = Number.POSITIVE_INFINITY;
      for (const entry of storedPendingTimedTurns()) if (entry.deliverAt! > now) next = Math.min(next, entry.deliverAt!);
      for (const prompts of Object.values(useNewThreadTimedPrompts.getState().prompts)) {
        for (const prompt of prompts) if (prompt.status === "queued" && prompt.deliverAt > now) next = Math.min(next, prompt.deliverAt);
      }
      if (Number.isFinite(next)) timer = window.setTimeout(check, Math.min(TIMED_PROMPT_MAX_TIMER_MS, next - now + 5));
    };
    const check = () => {
      checkPending = false;
      releaseDueTimedPrompts();
      arm();
    };
    const scheduleCheck = () => {
      if (checkPending) return;
      checkPending = true;
      queueMicrotask(check);
    };
    const unsubscribeQueue = useTaskStore.subscribe((state, previous) => {
      if (state.queueRevision !== previous.queueRevision) scheduleCheck();
    });
    const unsubscribeNewThread = useNewThreadTimedPrompts.subscribe((state, previous) => {
      if (state.prompts !== previous.prompts) scheduleCheck();
    });
    const onVisibility = () => { if (document.visibilityState === "visible") scheduleCheck(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", scheduleCheck);
    window.addEventListener("pageshow", scheduleCheck);
    window.addEventListener("online", scheduleCheck);
    check();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribeQueue();
      unsubscribeNewThread();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", scheduleCheck);
      window.removeEventListener("pageshow", scheduleCheck);
      window.removeEventListener("online", scheduleCheck);
    };
  }, [releaseDueTimedPrompts]);

  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      if (state.workflowOwners !== previous.workflowOwners) {
        for (const threadId in previous.workflowOwners) {
          if (!state.workflowOwners[threadId] && state.tasks[threadId]?.queuedTurns.some((entry) => entry.status === "queued")) {
            void pumpQueuedThread(threadId);
          }
        }
      }
      // This fires for every store write, which during a turn means every
      // streamed delta flush. A task's status only ever changes together with
      // its `statuses` entry, so an unchanged statuses map means no completion
      // to react to — and scanning every task's queue per animation frame is
      // pure waste.
      if (state.statuses === previous.statuses) return;
      for (const threadId in state.statuses) {
        if (state.statuses[threadId] !== "completed" || previous.statuses[threadId] === "completed") continue;
        if (state.tasks[threadId]?.queuedTurns.some((entry) => entry.status === "queued")) {
          void pumpQueuedThread(threadId);
        }
      }
    });
    return unsubscribe;
  }, [pumpQueuedThread]);

  // Opening a task is the moment a queue restored from a previous app session
  // gains a live delivery context (attached during the render above), so it is
  // also the moment those follow-ups become startable.
  useEffect(() => {
    // Release first: a restored timed prompt may have just gained its context.
    releaseDueTimedPrompts();
    if (activeThreadId) void pumpQueuedThread(activeThreadId);
  }, [activeThreadId, scheduledWorkspacePath, pumpQueuedThread, releaseDueTimedPrompts]);

  const queueFollowUp = useCallback((ctx: TurnRunnerContext, text: string): boolean => {
    const thread = ctx.activeThread;
    if (!thread) return false;
    if (archiveOwnsThread(thread.id)) return false;
    const sentAttachments = [...ctx.attachments];
    const queuedTurn = useTaskStore.getState().enqueueTurn(thread.id, text, sentAttachments, {
      ...(ctx.resolveSkillMentions === false ? { resolveSkillMentions: false } : {}),
      ...(ctx.skillInvocationText !== undefined ? { skillInvocationText: ctx.skillInvocationText } : {}),
    });
    queuedDeliveries.set(queuedTurn.id, {
      threadId: thread.id,
      context: queuedDeliveryContext(ctx, thread.id, sentAttachments, queuedTurn.resolveSkillMentions, queuedTurn.skillInvocationText),
    });
    ctx.setAttachments((current) => withoutSentAttachments(current, sentAttachments));
    ctx.setError(null);
    ctx.setTransientStatus("Message queued for the next turn");

    // Completion may have landed immediately before this enqueue, after the
    // status subscriber already had its chance to pump. Re-check after the
    // durable entry exists so this race cannot strand the follow-up.
    const status = useTaskStore.getState().tasks[thread.id]?.status;
    if (status !== "starting" && status !== "running") {
      queueMicrotask(() => { void pumpQueuedThread(thread.id); });
    }
    return true;
  }, [archiveOwnsThread, pumpQueuedThread]);

  const answerQuestions = useCallback(async (threadId: string, text: string, submission?: AgentQuestionSubmission): Promise<boolean> => {
    const current = contextRef.current;
    if (archiveOwnsThread(threadId)) return false;
    const requestId = submission?.message.questionRequestId;
    const pending = submission && requestId !== undefined ? useTaskStore.getState().tasks[threadId]?.approvals.find((entry) => entry.id === requestId
      && entry.method === "item/tool/requestUserInput"
      && typeof submission.message.turnId === "string" && entry.params.turnId === submission.message.turnId
      && typeof submission.message.questionRequestItemId === "string" && entry.params.itemId === submission.message.questionRequestItemId) : undefined;
    const resolvePending = () => {
      if (pending && useTaskStore.getState().tasks[threadId]?.approvals.includes(pending)) useTaskStore.getState().resolveApproval(threadId, pending.id);
    };
    if (submission && pending) {
      try {
        await respond(pending.id, { answers: Object.fromEntries(Object.entries(submission.answers).map(([id, answers]) => [id, { answers }])) },
          { method: "item/tool/requestUserInput", threadId, turnId: submission.message.turnId, itemId: submission.message.questionRequestItemId });
        resolvePending();
        return true;
      } catch (reason) {
        if (!/unknown request|not found|no longer|closed/i.test(friendlyError(reason))) throw reason;
        resolvePending();
      }
    }
    if (requestId !== undefined && submission?.message.questions?.some((question) => question.secret)) {
      throw new Error("This private question has expired. Ask the agent to request it again.");
    }
    if (current.activeThread?.id !== threadId) throw new Error("Open the conversation that asked these questions before answering.");
    const status = useTaskStore.getState().tasks[threadId]?.status;
    // Answers belong to this request, not the composer's unrelated draft or
    // attachments. Treat any @ words in answers literally.
    const ctx = { ...current, attachments: [], running: status === "running" || status === "starting", resolveSkillMentions: false as const, resolveSkillPrompt: async (message: string) => message };
    if (useTaskStore.getState().workflowOwners[threadId]) return queueFollowUp(ctx, text);
    if (status === "starting" || (!ctx.running && hasEligibleQueuedTurns(useTaskStore.getState().tasks[threadId]?.queuedTurns))) return queueFollowUp(ctx, text);
    let unavailable = false;
    const delivered = await deliverMessage(ctx, text, ctx.running ? "steer" : "turn", () => { unavailable = true; });
    return !delivered && unavailable ? queueFollowUp(ctx, text) : delivered;
  }, [archiveOwnsThread, deliverMessage, queueFollowUp]);

  const sendMessage = useCallback(async (text: string, options?: SendMessageOptions): Promise<boolean> => {
    const current = contextRef.current;
    const acknowledgedAttempt = options?.firstPromptAttemptId ? firstPromptAttemptsRef.current.get(options.firstPromptAttemptId) : undefined;
    if (options?.firstPromptAttemptId && (!acknowledgedAttempt || acknowledgedAttempt.status !== "starting"
      || acknowledgedAttempt.text !== text || deliveringFirstPromptIdsRef.current.has(acknowledgedAttempt.id))) return false;
    const captured = acknowledgedAttempt ? firstPromptContextsRef.current.get(acknowledgedAttempt.id) ?? current : current;
    const ctx = {
      ...captured,
      attachments: options?.attachments ?? current.attachments,
      ...(options?.useComposerAttachments === false ? { attachments: [], setAttachments: () => undefined } : {}),
      ...(options?.resolveSkillMentions === false ? { resolveSkillMentions: false as const, resolveSkillPrompt: async (message: string) => message } : {}),
      ...(options?.skillInvocationText !== undefined ? { skillInvocationText: options.skillInvocationText } : {}),
    };
    if (!text || !ctx.activeWorkspace) return false;
    const workspacePath = normalizedProjectPath(ctx.activeWorkspace.path);
    if (ctx.activeThread && useTaskStore.getState().workflowOwners[ctx.activeThread.id]) return queueFollowUp(ctx, text);
    if (ctx.running && !ctx.activeThread && !acknowledgedAttempt) return false;
    if (ctx.activeThread && (ctx.running || hasEligibleQueuedTurns(useTaskStore.getState().tasks[ctx.activeThread.id]?.queuedTurns))) return queueFollowUp(ctx, text);
    if (ctx.activeThread || ctx.deferredDelivery) return deliverMessage(ctx, text, "turn");
    const id = acknowledgedAttempt?.id ?? beginFirstPrompt(text);
    if (!id) return false;
    deliveringFirstPromptIdsRef.current.add(id);
    let delivered = false;
    try {
      delivered = await deliverMessage({ ...ctx, firstPromptAttemptId: id }, text, "turn");
      return delivered;
    } finally {
      const createdThreadId = createdFirstPromptThreadsRef.current.get(id);
      // Composer restores a rejected first prompt to its original draft key.
      // Return there only while this attempt still owns the visible selection.
      if (!delivered && createdThreadId && useTaskStore.getState().activeThreadId === createdThreadId
        && ctx.activeWorkspacePathRef.current === workspacePath) {
        ctx.setActiveThread(null);
        useTaskStore.getState().setActiveThread(null);
      }
      createdFirstPromptThreadsRef.current.delete(id);
      deliveringFirstPromptIdsRef.current.delete(id);
      finishFirstPrompt(id);
    }
  }, [beginFirstPrompt, deliverMessage, finishFirstPrompt, queueFollowUp]);

  const steerMessage = useCallback(async (text: string, options?: { resolveSkillMentions?: boolean; skillInvocationText?: string; expectedThreadId?: string; expectedTurnId?: string; expectedRunStartedAt?: number; deliveryGuard?: () => boolean }): Promise<boolean> => {
    const current = contextRef.current;
    const deliveryGuard = options?.expectedThreadId ? (ownedRunStartedAt?: number) => {
      const state = useTaskStore.getState();
      const task = state.tasks[options.expectedThreadId!];
      return (!options.deliveryGuard || options.deliveryGuard()) && contextRef.current.activeThread?.id === options.expectedThreadId
        && state.activeThreadId === options.expectedThreadId
        && task?.activeTurnId === options.expectedTurnId
        && task?.agentRunStartedAt === (ownedRunStartedAt ?? options.expectedRunStartedAt);
    } : undefined;
    if (deliveryGuard && !deliveryGuard()) return false;
    const ctx = {
      ...current,
      ...(deliveryGuard ? { deliveryGuard } : {}),
      ...(options?.resolveSkillMentions === false ? { resolveSkillMentions: false as const, resolveSkillPrompt: async (message: string) => message } : {}),
      ...(options?.skillInvocationText !== undefined ? { skillInvocationText: options.skillInvocationText } : {}),
    };
    if (ctx.activeThread && useTaskStore.getState().workflowOwners[ctx.activeThread.id]) return queueFollowUp(ctx, text);
    if (ctx.running && !ctx.activeThread) return false;
    const task = ctx.activeThread ? useTaskStore.getState().tasks[ctx.activeThread.id] : undefined;
    if (ctx.activeThread && task?.status === "starting") return queueFollowUp(ctx, text);
    let resolutionFailed = false;
    const resolutionFailure = () => { resolutionFailed = true; };
    if (ctx.activeThread && task?.status === "running") {
      const delivered = await deliverMessage(
        { ...ctx, running: true },
        text,
        "steer",
        undefined,
        resolutionFailure,
      );
      // Steering is an intent, not a lossy transport operation. If the runtime
      // crosses a lifecycle boundary or rejects the transport insertion,
      // retain the instruction as the next turn. A failed dependency preflight
      // remains blocked so it cannot be hidden by this fallback.
      if (!delivered && !resolutionFailed && (!deliveryGuard || deliveryGuard())) return queueFollowUp(ctx, text);
      return delivered;
    }
    if (ctx.activeThread && ctx.running && !task) {
      const delivered = await deliverMessage(ctx, text, "steer", undefined, resolutionFailure);
      return delivered || (!resolutionFailed && (!deliveryGuard || deliveryGuard()) && queueFollowUp(ctx, text));
    }
    if (hasEligibleQueuedTurns(task?.queuedTurns)) return queueFollowUp({ ...ctx, running: false }, text);
    return deliverMessage({ ...ctx, running: false }, text, "turn");
  }, [deliverMessage, queueFollowUp]);

  const steerQueuedMessage = useCallback(async (queuedTurnId: string): Promise<void> => {
    const ctx = contextRef.current;
    const threadId = ctx.activeThread?.id;
    if (!threadId) return;
    if (useTaskStore.getState().workflowOwners[threadId]) return;
    const task = useTaskStore.getState().tasks[threadId];
    if (task?.status !== "running") return;
    const queuedTurn = task.queuedTurns.find((entry) => entry.id === queuedTurnId);
    if (!queuedTurn || queuedTurn.status === "sending" || queuedTurn.editing) return;
    // A timed prompt waiting for its time can never be pushed into a turn.
    if (queuedTurn.deliverAt !== undefined && queuedTurn.releasedAt === undefined) return;
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "sending");
    let steerUnavailable = false;
    let resolutionFailure: { reason: unknown } | undefined;
    const delivered = await deliverMessage(
      { ...ctx, running: true, attachments: queuedTurn.attachments, setAttachments: () => undefined,
        skillInvocationText: queuedTurn.skillInvocationText,
        ...(queuedTurn.resolveSkillMentions === false ? { resolveSkillMentions: false as const, resolveSkillPrompt: async (message: string) => message } : {}) },
      queuedTurn.text,
      "steer",
      () => { steerUnavailable = true; },
      (reason) => { resolutionFailure = { reason }; },
    );
    if (delivered) {
      useTaskStore.getState().removeQueuedTurn(threadId, queuedTurn.id);
      queuedDeliveries.delete(queuedTurn.id);
      queuedBusyRetries.delete(queuedTurn.id);
    } else if (resolutionFailure) {
      // A broken dependency is configuration failure, not a provider lifecycle
      // boundary. Keep the source entry for correction and preserve its banner.
      useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "failed", friendlyError(resolutionFailure.reason));
    } else {
      // Whether the provider crossed a lifecycle boundary or rejected the
      // insertion, the user's queued instruction remains durable and will run
      // next. A steering attempt must never turn a valid queued message red or
      // require the user to retype it.
      useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurn.id, "queued");
      ctx.setError(null);
      ctx.setTransientStatus(steerUnavailable
        ? "Steering was unavailable; message kept for the next turn"
        : "Steer could not be inserted; message kept for the next turn");
      const status = useTaskStore.getState().tasks[threadId]?.status;
      if (status !== "starting" && status !== "running") {
        queueMicrotask(() => { void pumpQueuedThread(threadId); });
      }
    }
  }, [deliverMessage, pumpQueuedThread]);

  const retryQueuedMessage = useCallback((queuedTurnId: string) => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId) return;
    const head = eligibleQueueHead(useTaskStore.getState().tasks[threadId]?.queuedTurns ?? []);
    if (head?.id !== queuedTurnId || head.status === "sending" || head.editing) return;
    queuedBusyRetries.delete(queuedTurnId);
    useTaskStore.getState().setQueuedTurnStatus(threadId, queuedTurnId, "queued");
    void pumpQueuedThread(threadId, true);
  }, [pumpQueuedThread]);

  const beginEditQueuedMessage = useCallback((queuedTurnId: string): boolean => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId || archiveOwnsThread(threadId)) return false;
    return useTaskStore.getState().beginQueuedTurnEdit(threadId, queuedTurnId);
  }, [archiveOwnsThread]);

  const finishEditQueuedMessage = useCallback((queuedTurnId: string, text?: string): boolean => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId || !useTaskStore.getState().finishQueuedTurnEdit(threadId, queuedTurnId, text)) return false;
    // A completed turn may have tried to pump while the editor held the head.
    // Preserve stopped/failed queues: saving an edit is not an explicit retry.
    void pumpQueuedThread(threadId);
    return true;
  }, [pumpQueuedThread]);

  const removeQueuedMessage = useCallback((queuedTurnId: string) => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId) return;
    const entries = useTaskStore.getState().tasks[threadId]?.queuedTurns;
    if (entries?.find((entry) => entry.id === queuedTurnId)?.status === "sending") return;
    const wasHead = eligibleQueueHead(entries ?? [])?.id === queuedTurnId;
    useTaskStore.getState().removeQueuedTurn(threadId, queuedTurnId);
    queuedDeliveries.delete(queuedTurnId);
    queuedBusyRetries.delete(queuedTurnId);
    if (wasHead) void pumpQueuedThread(threadId);
  }, [pumpQueuedThread]);

  const scheduleMessage = useCallback(async (text: string, deliverAt: number, options?: { useComposerAttachments?: boolean; skillInvocationText?: string }): Promise<boolean> => {
    const current = contextRef.current;
    const ctx: TurnRunnerContext = {
      ...current,
      ...(options?.useComposerAttachments === false ? { attachments: [], setAttachments: () => undefined } : {}),
      ...(options?.skillInvocationText !== undefined ? { skillInvocationText: options.skillInvocationText } : {}),
    };
    if (!text.trim() || !ctx.activeWorkspace) return false;
    if (!Number.isFinite(deliverAt) || deliverAt <= Date.now()) {
      ctx.setError("Choose a delivery time in the future.");
      return false;
    }
    for (const attachment of ctx.attachments) {
      const reason = attachment.kind === "image" ? unsupportedImageReason(attachment.path) : undefined;
      if (reason) {
        ctx.setError(reason);
        return false;
      }
    }
    const sentAttachments = [...ctx.attachments];
    if (ctx.activeThread) {
      const thread = ctx.activeThread;
      if (archiveOwnsThread(thread.id)) return false;
      const queuedTurn = useTaskStore.getState().enqueueTurn(thread.id, text, sentAttachments, {
        ...(ctx.skillInvocationText !== undefined ? { skillInvocationText: ctx.skillInvocationText } : {}),
        deliverAt,
      });
      queuedDeliveries.set(queuedTurn.id, {
        threadId: thread.id,
        context: queuedDeliveryContext(ctx, thread.id, sentAttachments, undefined, queuedTurn.skillInvocationText),
      });
    } else {
      if (ctx.draftThreadIsolated && (!ctx.workspaceGitInfo?.isRepo || !ctx.workspaceGitInfo.isRoot || !ctx.workspaceGitInfo.hasCommit)) {
        ctx.setError("Isolated threads require a Git repository root with at least one commit.");
        return false;
      }
      const prompt = useNewThreadTimedPrompts.getState().add({
        workspacePath: ctx.activeWorkspace.path,
        workspaceName: ctx.activeWorkspace.name,
        text,
        attachments: sentAttachments,
        deliverAt,
        snapshot: newThreadSnapshot(ctx.effectiveSettings, ctx.draftThreadIsolated),
        skillInvocationText: ctx.skillInvocationText,
      });
      newThreadDeliveries.set(prompt.id, newThreadDeliveryContext(ctx, prompt));
    }
    ctx.setAttachments((existing) => withoutSentAttachments(existing, sentAttachments));
    ctx.setError(null);
    ctx.setTransientStatus(`Scheduled for ${formatDeliveryTime(deliverAt)}`);
    return true;
  }, [archiveOwnsThread]);

  const rescheduleQueuedMessage = useCallback((queuedTurnId: string, deliverAt: number): boolean => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId || archiveOwnsThread(threadId)) return false;
    if (!useTaskStore.getState().rescheduleQueuedTurn(threadId, queuedTurnId, deliverAt)) return false;
    queuedBusyRetries.delete(queuedTurnId);
    contextRef.current.setTransientStatus(`Rescheduled for ${formatDeliveryTime(deliverAt)}`);
    // A released head may have just left the FIFO; let the next entry move.
    void pumpQueuedThread(threadId);
    return true;
  }, [archiveOwnsThread, pumpQueuedThread]);

  const queueTimedMessageNow = useCallback((queuedTurnId: string): boolean => {
    const threadId = contextRef.current.activeThread?.id;
    if (!threadId || archiveOwnsThread(threadId)) return false;
    if (!useTaskStore.getState().releaseTimedTurnNow(threadId, queuedTurnId)) return false;
    const task = useTaskStore.getState().tasks[threadId];
    const isHead = eligibleQueueHead(task?.queuedTurns ?? [])?.id === queuedTurnId;
    // An explicit "queue now" is the user's go-ahead for this entry, like Start.
    void pumpQueuedThread(threadId, isHead);
    return true;
  }, [archiveOwnsThread, pumpQueuedThread]);

  const beginEditNewThreadPrompt = useCallback((id: string) => useNewThreadTimedPrompts.getState().beginEdit(id), []);
  const finishEditNewThreadPrompt = useCallback((id: string, text?: string) => useNewThreadTimedPrompts.getState().finishEdit(id, text), []);
  const rescheduleNewThreadPrompt = useCallback((id: string, deliverAt: number): boolean => {
    if (!useNewThreadTimedPrompts.getState().reschedule(id, deliverAt)) return false;
    contextRef.current.setTransientStatus(`Rescheduled for ${formatDeliveryTime(deliverAt)}`);
    return true;
  }, []);
  const sendNewThreadPromptNow = useCallback((id: string): boolean => {
    const prompt = findNewThreadTimedPrompt(id);
    if (!prompt || prompt.status === "sending" || prompt.editing) return false;
    if (!newThreadDeliveries.has(id)) {
      useNewThreadTimedPrompts.getState().setStatus(id, "failed", "Open the workspace this prompt was scheduled from, then try again.");
      return false;
    }
    // Clearing the missed mark and starting happen in one tick, so no clock
    // check can observe the overdue entry in between and re-mark it.
    if (!useNewThreadTimedPrompts.getState().prepareManualStart(id)) return false;
    if (startNewThreadPrompt(id)) return true;
    useNewThreadTimedPrompts.getState().setStatus(id, "failed", "The scheduled prompt could not be prepared. Open its workspace and try again.");
    return false;
  }, [startNewThreadPrompt]);
  const removeNewThreadPrompt = useCallback((id: string) => {
    if (findNewThreadTimedPrompt(id)?.status === "sending") return;
    useNewThreadTimedPrompts.getState().remove(id);
    newThreadDeliveries.delete(id);
  }, []);

  const stopTurn = useCallback(async () => {
    const ctx = contextRef.current;
    const { activeThread, running, pendingTurnStartsRef, setError, setStatus, setStartingDraftTurn, setTransientStatus } = ctx;
    if (!running) return;
    const selectedAttemptId = ctx.activeFirstPromptIdRef?.current;
    const ownsPrompt = (id: string, prompt: PendingFirstPrompt) => activeThread
      ? prompt.threadId === activeThread.id
      : !prompt.threadId && (ctx.activeFirstPromptIdRef ? id === selectedAttemptId
        : prompt.workspacePath === normalizedProjectPath(ctx.activeWorkspace?.path ?? ""));
    for (const [id, prompt] of firstPromptAttemptsRef.current) {
      if (ownsPrompt(id, prompt)) {
        firstPromptAttemptsRef.current.set(id, { ...prompt, status: "stopping" });
      }
    }
    setPendingFirstPrompts((current) => current.map((prompt) => ownsPrompt(prompt.id, prompt)
      ? { ...prompt, status: "stopping" } : prompt));
    // A draft send has no thread to interrupt yet, and its runtime call may not
    // even have been made. Advancing the generation is the cutoff: whichever
    // point the send has reached, it aborts as soon as it learns its thread id.
    if (!activeThread) {
      draftGenerationRef.current += 1;
      // A stopped draft cannot dispatch after its preparation resumes. Release
      // its folder now even if a skill scan remains pending; scheduled starts
      // have separate ownership and are unaffected by the visible draft Stop.
      for (const [token, id] of ordinarySharedDraftStartsRef.current) {
        if (ctx.activeFirstPromptIdRef && id !== selectedAttemptId) continue;
        pendingSharedDraftStarts.delete(token);
        ordinarySharedDraftStartsRef.current.delete(token);
      }
      setStartingDraftTurn(false);
      setTransientStatus("Stopped");
      return;
    }
    const turnId = useTaskStore.getState().tasks[activeThread.id]?.activeTurnId;
    if (!turnId) {
      // If this thread's turn/start RPC is still in flight, flag that exact
      // pending start so sendMessage interrupts the turn the moment its id is
      // known. When this thread has no start in flight (e.g. the user
      // navigated here while another thread was starting), there is nothing
      // to stop and no intent must be recorded.
      const pendingCancelled = pendingTurnStartsRef.current.requestCancel(activeThread.id);
      const nativeStart = localStartRequestsRef.current.get(activeThread.id);
      const task = useTaskStore.getState().tasks[activeThread.id];
      if ((isClaudeThread(activeThread) || isCursorThread(activeThread)) && nativeStart
        && nativeStart.runStartedAt === task?.agentRunStartedAt) {
        setStatus("Stopping");
        const announcedTurnId = nativeStart.turnId ?? cursorTurnOwner(activeThread.id)?.turnId;
        if (announcedTurnId) markProviderStopIntent(activeThread.id, announcedTurnId);
        try {
          if (isClaudeThread(activeThread)) await killClaudeTurn(activeThread.id, { startRequestId: nativeStart.startRequestId });
          else await killCursorTurn(activeThread.id, { startRequestId: nativeStart.startRequestId });
          if (localStartRequestsRef.current.get(activeThread.id) === nativeStart
            && useTaskStore.getState().tasks[activeThread.id]?.agentRunStartedAt === nativeStart.runStartedAt) {
            const latest = useTaskStore.getState().tasks[activeThread.id];
            const stoppedTurnId = latest?.activeTurnId ?? nativeStart.turnId;
            if (stoppedTurnId) sealStoppedTurn(activeThread.id, stoppedTurnId);
            else if (latest?.status === "starting" || latest?.status === "running") {
              useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
            }
            if (isClaudeThread(activeThread)) ctx.scheduleClaudeThreadSave(activeThread.id);
            else ctx.scheduleCursorThreadSave(activeThread.id);
            setTransientStatus("Stopped");
          }
        } catch (reason) {
          setError(friendlyError(reason));
          throw reason;
        } finally {
          if (announcedTurnId) clearProviderStopIntent(activeThread.id, announcedTurnId);
        }
      } else if (pendingCancelled) {
        setStatus("Stopping");
      } else {
        const message = "This provider start has no confirmed turn or owned startup identity. Its cutoff could not be confirmed; reopen its current conversation before retrying Stop.";
        setError(message);
        throw new Error(message);
      }
      return;
    }
    const localProvider = isClaudeThread(activeThread) || isCursorThread(activeThread);
    const cursorStopOwner = isCursorThread(activeThread) ? cursorTurnOwner(activeThread.id, turnId) : undefined;
    if (localProvider) markProviderStopIntent(activeThread.id, turnId);
    try {
      if (isClaudeThread(activeThread)) await killClaudeTurn(activeThread.id, { turnId });
      else if (isCursorThread(activeThread)) await killCursorTurn(activeThread.id, { turnId, startRequestId: cursorStopOwner?.startRequestId });
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      const stopped = sealStoppedTurn(activeThread.id, turnId);
      if (isClaudeThread(activeThread)) ctx.scheduleClaudeThreadSave(activeThread.id);
      else if (isCursorThread(activeThread)) ctx.scheduleCursorThreadSave(activeThread.id);
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      if (stopped && contextRef.current.activeThread?.id === activeThread.id) {
        setStartingDraftTurn(false);
        setTransientStatus("Stopped");
      }
    } catch (reason) {
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      if (cursorStopOwner && cursorTurnOwner(activeThread.id) !== cursorStopOwner) return;
      setError(friendlyError(reason));
      throw reason;
    }
  }, []);

  return {
    pendingFirstPrompts, beginFirstPrompt, finishFirstPrompt,
    sendMessage, answerQuestions, steerMessage, steerQueuedMessage, retryQueuedMessage, removeQueuedMessage, beginEditQueuedMessage, finishEditQueuedMessage,
    scheduleMessage, rescheduleQueuedMessage, queueTimedMessageNow,
    beginEditNewThreadPrompt, finishEditNewThreadPrompt, rescheduleNewThreadPrompt, sendNewThreadPromptNow, removeNewThreadPrompt,
    stopTurn, getSubagentPreparationLockedReason, subagentPreparationLockRevision,
  };
}

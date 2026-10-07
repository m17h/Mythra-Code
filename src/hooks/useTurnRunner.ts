import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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
  saveCursorTranscript,
  startCursorTurn,
  steerCursorTurn,
  type CursorRuntimeStatus,
} from "../lib/cursor";
import type { AgentQuestionSubmission } from "../lib/agentQuestionContext";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL } from "../lib/appConfig";
import { cacheChildAgentPolicy, ensureChildAgentBridge, releaseChildAgentSession, type ChildAgentBridgeResult } from "../lib/childAgentSessions";
import { childAgentPolicyForThread, type ChildAgentLink, type ChildAgentPolicy, type ChildAgentReadiness } from "../lib/childAgents";
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
import { friendlyError } from "../lib/errors";
import { SkillDependencyError } from "../lib/skillDependencies";
import { confirmDialog } from "../lib/confirmDialog";
import { clearProviderStopIntent, markProviderStopIntent } from "../lib/providerStopIntent";
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
import { PendingTurnStarts, type PendingTurnStart } from "../lib/pendingTurnStarts";
import type { SetPersisted } from "./usePersistedState";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { LMStudioModel } from "../lib/lmStudio";
import type { AttachmentRecord } from "../components/StudioDock";
import type { Account, AppSettings, ChatMessage, CustomAgentProfile, Project, Provider, SettingsSection, Thread, ThreadReasoning, Turn } from "../types";

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
    /no active turn|active turn is still starting|expected turn(?: id)?.*(?:does not match|mismatch)/i,
  ].some((pattern) => pattern.test(raw));
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

/** Global connection state stays live; captured thread/workspace policy stays owned. */
function withLiveDeliveryReadiness(captured: TurnRunnerContext, live: TurnRunnerContext): TurnRunnerContext {
  return {
    ...captured,
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
  attachments: AttachmentRecord[];
  effectiveSettings: AppSettings;
  subscriptionSystemPrompts: Record<"openai" | "claude", string> & Partial<Record<Provider, string>>;
  customAgents: CustomAgentProfile[];
  openRouterModels: OpenRouterModel[];
  lmStudioModels?: LMStudioModel[];
  runtimeStatus: CodexRuntimeStatus | null;
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
  /** `deferred` marks a scheduled first prompt, which must not consume the
   * visible draft's pending handoff; `subagentsEnabled` is its snapshot. */
  onThreadCreated: (threadId: string, options?: { deferred?: boolean; subagentsEnabled?: boolean }) => void;
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
  restartRuntimeForCapabilities: (threadId: string) => Promise<string>;
  /** Wait for view-first OpenAI navigation to finish preparing its runtime. */
  waitForThreadPreparation: (threadId: string) => Promise<void>;
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  discardRunCheckpoint: (threadId: string) => void;
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

/**
 * Owns the send/steer/stop turn lifecycle for all providers. The context is
 * rebuilt by App on every render and read through a ref, so the stable
 * callbacks always see fresh state; each call snapshots the context once at
 * entry, mirroring the closure captures of the original inline handlers, so
 * mid-flight awaits keep operating on the workspace the send started in.
 */
export function useTurnRunner(context: TurnRunnerContext): {
  sendMessage: (text: string, options?: { useComposerAttachments?: boolean; resolveSkillMentions?: boolean; skillInvocationText?: string }) => Promise<boolean>;
  answerQuestions: (threadId: string, text: string, submission?: AgentQuestionSubmission) => Promise<boolean>;
  steerMessage: (text: string, options?: { resolveSkillMentions?: boolean; skillInvocationText?: string }) => Promise<boolean>;
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
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  const draftGenerationRef = useRef(0);
  const ordinarySharedDraftStartsRef = useRef(new Set<symbol>());

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
      effectiveSettings, subscriptionSystemPrompts, customAgents, openRouterModels, lmStudioModels = [],
      runtimeStatus, claudeStatus, cursorStatus, account, openRouterReady, lmStudioReady,
      workspaceGitInfo, draftThreadIsolated, worktreeBusy, skillsFolder, resolveSkillPrompt,
      childAgentPolicies, childAgentLinks, activeThreadIsChild, childAgentReadiness, persistChildAgentPolicies,
      threadWorktreesRef, threadProjectBindingsRef, activeWorkspacePathRef,
      pendingTurnStartsRef, skillRuntimeRootRef, cursorSessionIdsRef,
      executionPathFor, bindThreadToProject, rememberThread, onThreadCreated, persistThreadModel, persistThreadReasoning,
      persistThreadWorktrees, restartRuntimeForCapabilities, waitForThreadPreparation, beginRunCheckpoint, discardRunCheckpoint,
      refreshLocalSkills, ensureSkillRoots, scheduleClaudeThreadSave, scheduleCursorThreadSave,
      setThreads, setActiveThread, setAttachments, setDraftThreadIsolated,
      setStartingDraftTurn, setError, setStatus, setTransientStatus,
      setRuntimeSetupOpen, setAuthRequiredOpen, openSettings,
    } = ctx;
    if (!text || !activeWorkspace) return false;
    if (activeThread && archiveOwnsThread(activeThread.id)) return false;
    if (isPullRequestMutationRunning(executionPathFor(activeThread?.id, activeWorkspace.path))) {
      setError("Wait for the pull request operation to finish before starting another model turn.");
      return false;
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
      setError(cursorStatus?.available ? "Sign in to Cursor Agent before using your Cursor subscription." : "Install Cursor Agent, then sign in before using the Cursor provider.");
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
    if (mode === "steer" && running && activeThread) {
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
          );
          scheduleClaudeThreadSave(activeThread.id);
        } else if (isCursorThread(activeThread)) {
          await steerCursorTurn(
            activeThread.id,
            providerText,
            sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
          );
          scheduleCursorThreadSave(activeThread.id);
        } else {
          const expectedTurnId = useTaskStore.getState().tasks[activeThread.id]?.activeTurnId;
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

    const willUseSharedFolder = !currentIsolation && !(draftThreadIsolated && !activeThread);
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
    const selectedThreadAtSend = useTaskStore.getState().activeThreadId;
    let activatedCreatedThreadId: string | undefined;
    const workspaceChangedMidSend = () => activeWorkspacePathRef.current !== sendWorkspacePath;
    const threadSelectionChangedMidSend = () => {
      const selectedThread = useTaskStore.getState().activeThreadId;
      return selectedThread !== selectedThreadAtSend && selectedThread !== activatedCreatedThreadId;
    };
    let pendingStart: PendingTurnStart | undefined;
    let draftGeneration: number | undefined;
    // Mark the start synchronously, before the first await, so Stop and the
    // composer reflect it immediately — and only on the thread actually
    // starting. A send with no active thread yet is tracked by the draft
    // flag until the created thread's own status takes over.
    const startingThreadId = activeThread?.id;
    if (startingThreadId) {
      useTaskStore.getState().beginAgentRun(startingThreadId);
      useTaskStore.getState().setTaskStatus(startingThreadId, "starting");
      pendingStart = pendingTurnStartsRef.current.begin(startingThreadId);
    } else if (!deferredDelivery) {
      // A scheduled first prompt is not the visible draft: it must neither
      // cancel the user's own draft send nor be cancelled by its Stop.
      draftGeneration = ++draftGenerationRef.current;
      setStartingDraftTurn(true);
    }
    const draftCancelled = () => draftGeneration !== undefined && draftGeneration !== draftGenerationRef.current;
    setStatus("Starting");

    let startedThreadId: string | undefined;
    let sentMessageId: string | undefined;
    let provisionalWorktree: CreatedWorktree | undefined;
    let provisionalPersisted = false;
    let childBridge: ChildAgentBridgeResult | null = null;
    const sentAttachments = [...attachments];
    const assertCanStart = () => {
      if (pendingStart?.cancelRequested || (!activeThread && draftCancelled())) {
        throw new CancelledTurnStart("Stopped before starting the model turn");
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
        startTurn: (thread: Thread) => Promise<{ turnId: string }>;
        afterStart?: (threadId: string) => void;
        hardStop: (threadId: string) => Promise<unknown>;
      },
    ): Promise<boolean> => {
      let thread = activeThread;
      if (!thread) {
        thread = { id: crypto.randomUUID(), name: null, preview: text.slice(0, 140), cwd: executionPath, updatedAt: Math.floor(Date.now() / 1000), modelProvider: provider };
        startedThreadId = thread.id;
        bindThreadToProject(thread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(thread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [thread!.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(thread);
        contextRef.current.onThreadTitlePending?.(thread.id, text);
        onThreadCreated(thread.id, { deferred: Boolean(deferredDelivery), subagentsEnabled: effectiveSettings.subagentsEnabled });
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
      if (!activeThread) useTaskStore.getState().beginAgentRun(thread.id);
      useTaskStore.getState().setTaskStatus(thread.id, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(thread.id);
      await beginRunCheckpoint(thread.id, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      assertCanStart();
      // Persist the owned thread/prior history before dispatch, not the new
      // optimistic prompt. A Stop or failed save must not leave undelivered
      // skill provenance in a durable (possibly paged) transcript. No await
      // separates the final check, optimistic append and model request.
      await strategy.prepareTurn(thread, updatedThread);
      assertCanStart();
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(thread.id, {
        id: sentMessageId,
        role: "user",
        text,
        ...userSkillMetadata,
        attachments: messageImageAttachments(sentAttachments),
      });
      const result = await strategy.startTurn(thread);
      recordAuthoredPrompt(thread.id, sentMessageId);
      // Provider events can race ahead of the start RPC response. If a very
      // short turn already delivered its result, reinstalling it here would
      // resurrect the completed thread as permanently running.
      const completedBeforeStartReturned = useTaskStore.getState().tasks[thread.id]?.lastCompletedTurnId === result.turnId;
      if (!completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(thread.id, result.turnId);
        useTaskStore.getState().setTaskStatus(thread.id, "running");
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      strategy.afterStart?.(thread.id);
      if (pendingTurnStartsRef.current.finish(thread.id, pendingStart) && !completedBeforeStartReturned) {
        markProviderStopIntent(thread.id, result.turnId);
        try {
          await strategy.hardStop(thread.id);
        } catch (reason) {
          clearProviderStopIntent(thread.id, result.turnId);
          throw reason;
        }
        useTaskStore.getState().setActiveTurn(thread.id, undefined);
        useTaskStore.getState().setTaskStatus(thread.id, "interrupted");
        clearProviderStopIntent(thread.id, result.turnId);
        setTransientStatus("Stopped");
      }
      if (!activeThread) contextRef.current.onThreadTitleRequested?.(thread.id, text);
      return true;
    };

    try {
      if (sharedDraftStart) {
        // Reserve synchronously before any preparation await. The draft flag
        // alone is invisible to other background deliveries until a thread id
        // exists; the reservation bridges that identity gap.
        pendingSharedDraftStarts.set(sharedDraftStart, sendWorkspacePath);
        if (!deferredDelivery) ordinarySharedDraftStartsRef.current.add(sharedDraftStart);
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
      // Learned documents never enter authored skill resolution or saved
      // settings/child baselines. Read the captured target's current documents
      // once for this new turn; steering keeps its running policy frozen.
      resolvedSystemPrompt = appendCurrentLearnedPreferences(resolvedSystemPrompt, activeProject?.id ?? null);
      assertCanStart();
      let executionPath = activeWorkspace.path;
      if (!activeThread && draftThreadIsolated && activeProject) {
        provisionalWorktree = await createThreadWorktree(activeProject.path, text);
        executionPath = provisionalWorktree.path;
      } else if (activeThread) {
        executionPath = executionPathFor(activeThread.id, activeWorkspace.path);
      }
      assertCanStart();
      if (isPullRequestMutationRunning(executionPath)) {
        throw new Error("Wait for the pull request operation to finish before starting another model turn.");
      }
      const isolationGitDir = provisionalWorktree?.gitDir ?? currentIsolation?.gitDir;
      const additionalWorkspaceRoots = isolationGitDir ? [isolationGitDir] : [];
      if (activeThread && effectiveSettings.provider !== "claude" && effectiveSettings.provider !== "cursor") {
        await waitForThreadPreparation(activeThread.id);
        assertCanStart();
      }
      childBridge = await ensureChildAgentBridge({
        threadId: activeThread?.id,
        policies: childAgentPolicies,
        links: childAgentLinks,
        isChildThread: Boolean(activeThread && activeThreadIsChild),
        settings: effectiveSettings,
        permission: effectiveSettings.permission,
        systemPrompt: effectiveSettings.systemPrompt,
        providerSystemPrompts: subscriptionSystemPrompts,
        projectInstructionsEnabled: effectiveSettings.projectInstructionsEnabled,
        reasoningEffort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
        serviceTier: effectiveSettings.serviceTier,
        readiness: childAgentReadiness,
        settingsProposalsEnabled: Boolean(activeProject),
        // Thread selection may attach a bridge, but only sending a prompt is
        // allowed to consume a staged thread-local crew edit.
        promoteStagedEdits: true,
      });
      assertCanStart();
      // A captured cross-provider policy freezes one concurrency budget for
      // the whole conversation. Use that same budget for provider-native
      // sub-agents too, so the number displayed by the command center is the
      // number Claude/Codex actually receives. Threads that never captured a
      // roster continue to use the live project setting.
      const capturedPolicy = childAgentPolicyForThread(childAgentPolicies, activeThread?.id);
      const runtimeSubagentMax = childBridge?.policy.maxConcurrent
        ?? capturedPolicy?.maxConcurrent
        ?? effectiveSettings.subagentMax;
      const runtimeSettings = { ...effectiveSettings, systemPrompt: resolvedSystemPrompt, subagentMax: runtimeSubagentMax };
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
            const result = await startClaudeTurn({ threadId: thread.id, cwd: executionPath, prompt: providerText, model: effectiveSettings.model || DEFAULT_CLAUDE_MODEL, effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort, permission: effectiveSettings.permission, systemPrompt: withMythraCodeCompletionInstructions(resolvedSystemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")), runButton, checkButton), resume: canResumeClaude, attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })), subagentMax: runtimeSubagentMax, customAgents, skillsPluginPath: skillRuntimeRootRef.current || undefined, childAgentBridgeConfig: childBridge?.launch.configPath });
            return { turnId: result.turnId };
          },
          afterStart: (threadId) => scheduleClaudeThreadSave(threadId),
          hardStop: (threadId) => killClaudeTurn(threadId),
        });
      }

      if (effectiveSettings.provider === "cursor") {
        return await runLocalTurn("cursor", executionPath, {
          prepareTurn: (thread, updatedThread) => saveCursorTranscript({ thread: updatedThread, cursorSessionId: cursorSessionIdsRef.current[thread.id] ?? "", messages: useTaskStore.getState().tasks[thread.id]?.messages ?? [], activities: useTaskStore.getState().tasks[thread.id]?.activities ?? [] }),
          startTurn: async (thread) => {
            const priorSessionId = cursorSessionIdsRef.current[thread.id];
            const result = await startCursorTurn({
              threadId: thread.id,
              cwd: executionPath,
              prompt: providerText,
              model: effectiveSettings.model || DEFAULT_CURSOR_MODEL,
              effort: effectiveSettings.ultra ? "ultra" : effectiveSettings.reasoningEffort,
              permission: effectiveSettings.permission,
              systemPrompt: withMythraCodeCompletionInstructions(resolvedSystemPrompt, Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")), Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")), runButton, checkButton),
              resumeSessionId: priorSessionId || undefined,
              attachments: sentAttachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind === "image" ? "image" : "file" })),
              childAgentBridge: childBridge
                ? { name: childBridge.launch.name, command: childBridge.launch.command, args: childBridge.launch.args }
                : undefined,
            });
            cursorSessionIdsRef.current[thread.id] = result.cursorSessionId;
            return { turnId: result.turnId };
          },
          afterStart: (threadId) => scheduleCursorThreadSave(threadId),
          hardStop: (threadId) => killCursorTurn(threadId),
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
        subagentsEnabled: Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")),
        subagentMax: runtimeSubagentMax,
        // The same policy receives a new token/config path whenever its bridge
        // is rebuilt. App-server must be refreshed so it starts that process,
        // rather than retaining an MCP process holding the revoked old token.
        bridgeInstanceId: childBridge?.launch.configPath,
      });
      let threadId = activeThread?.id;
      let runtimeTurnModel: unknown;
      startedThreadId = threadId;
      if (!threadId) {
        const result = await rpc<{ thread: Thread; model?: unknown }>("thread/start", threadStartParams(runtimeSettings, executionPath, { serviceName: activeWorkspace.isChat ? "Mythra Code Chat" : "Mythra Code", customAgents, modelContextWindow, interactive: true, perTurnSystemPrompt: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch, projectRunCommand: runButton.run, projectCheckCommand: checkButton.check }));
        const startedThread = optimisticStartedThread(result.thread, text);
        runtimeTurnModel = result.model;
        threadId = startedThread.id;
        startedThreadId = threadId;
        bindThreadToProject(startedThread.id, activeWorkspace.path);
        if (provisionalWorktree && activeProject) {
          const record = threadWorktreeRecord(startedThread.id, activeProject, provisionalWorktree);
          persistThreadWorktrees((current) => ({ ...current, [startedThread.id]: record }));
          provisionalPersisted = true;
          setDraftThreadIsolated(false);
        }
        rememberThread(startedThread);
        contextRef.current.onThreadTitlePending?.(startedThread.id, text);
        onThreadCreated(startedThread.id, { deferred: Boolean(deferredDelivery), subagentsEnabled: effectiveSettings.subagentsEnabled });
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
        if (plan.restartRuntime) runtimeInstance = await restartRuntimeForCapabilities(threadId);
        assertCanStart();
        if (effectiveSettings.provider === "openrouter" || effectiveSettings.provider === "lmstudio" || plan.resume) {
          const resume = threadResumeParams(runtimeSettings, threadId, executionPath, { customAgents, modelContextWindow, excludeTurns: true, perTurnSystemPrompt: true, additionalWorkspaceRoots, childAgentBridge: childBridge?.launch, refreshRuntimeConfig: true, projectRunCommand: runButton.run, projectCheckCommand: checkButton.check });
          const resumed = await rpc<{ model?: unknown }>("thread/resume", effectiveSettings.provider === "openrouter" || effectiveSettings.provider === "lmstudio" ? { ...resume, model: effectiveSettings.model } : resume);
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
      if (!activeThread) useTaskStore.getState().beginAgentRun(threadId);
      useTaskStore.getState().setTaskStatus(threadId, "starting");
      if (!pendingStart) pendingStart = pendingTurnStartsRef.current.begin(threadId);
      await beginRunCheckpoint(threadId, executionPath, text, effectiveSettings.provider, effectiveSettings.model);
      assertCanStart();
      sentMessageId = `local-${crypto.randomUUID()}`;
      useTaskStore.getState().appendUserMessage(threadId, {
        id: sentMessageId,
        role: "user",
        text,
        ...userSkillMetadata,
        attachments: messageImageAttachments(sentAttachments),
      });

      const result = await rpc<{ turn: Turn }>("turn/start", turnStartParams(runtimeSettings, threadId, executionPath, input, additionalWorkspaceRoots, true, {
        systemPrompt: resolvedSystemPrompt,
        model: typeof runtimeTurnModel === "string" ? runtimeTurnModel : undefined,
        developerInstructions: mythraCodeDeveloperInstructions(
          Boolean(childBridge?.launch.toolNames.includes("spawn_mythra_agent")),
          Boolean(childBridge?.launch.toolNames.includes("propose_agent_settings")),
          runButton,
          checkButton,
        ),
      }));
      recordAuthoredPrompt(threadId, sentMessageId);
      const resultTurnId = result.turn?.id;
      const completedBeforeStartReturned = Boolean(
        resultTurnId
        && useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId === resultTurnId,
      );
      if (resultTurnId && !completedBeforeStartReturned) {
        useTaskStore.getState().setActiveTurn(threadId, resultTurnId);
      }
      setStartingDraftTurn(false);
      setAttachments((current) => withoutSentAttachments(current, sentAttachments));
      if (pendingTurnStartsRef.current.finish(threadId, pendingStart) && !completedBeforeStartReturned) {
        // The user pressed stop while the turn was still starting.
        if (resultTurnId) await rpc("turn/interrupt", { threadId, turnId: resultTurnId });
        useTaskStore.getState().setActiveTurn(threadId, undefined);
        useTaskStore.getState().setTaskStatus(threadId, "interrupted");
        setTransientStatus("Stopped");
      }
      if (!activeThread) contextRef.current.onThreadTitleRequested?.(threadId, text);
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
        discardRunCheckpoint(failedThreadId);
        if (pendingStart) pendingTurnStartsRef.current.finish(failedThreadId, pendingStart);
        if (sentMessageId) useTaskStore.getState().removeMessage(failedThreadId, sentMessageId);
        useTaskStore.getState().setTaskStatus(failedThreadId, cancelled ? "interrupted" : "error", cancelled ? undefined : friendlyError(reason));
        if (isClaudeThreadBusyError(reason)) {
          // The backend slot is held by a Claude process the UI no longer
          // tracks (e.g. after an event loss). Free it so a retry succeeds
          // instead of failing until Mythra Code restarts.
          await killClaudeTurn(failedThreadId).catch(() => undefined);
        } else if (effectiveSettings.provider === "cursor" && /already working/i.test(friendlyError(reason))) {
          void killCursorTurn(failedThreadId).catch(() => undefined);
        }
      }
      setStatus("Ready");
      if (cancelled) setTransientStatus("Stopped");
      else setError(friendlyError(reason));
      return false;
    } finally {
      if (sharedDraftStart) {
        pendingSharedDraftStarts.delete(sharedDraftStart);
        ordinarySharedDraftStartsRef.current.delete(sharedDraftStart);
      }
    }
  }, [archiveOwnsThread]);

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

  const sendMessage = useCallback(async (text: string, options?: { useComposerAttachments?: boolean; resolveSkillMentions?: boolean; skillInvocationText?: string }): Promise<boolean> => {
    const current = contextRef.current;
    const ctx = {
      ...current,
      ...(options?.useComposerAttachments === false ? { attachments: [], setAttachments: () => undefined } : {}),
      ...(options?.resolveSkillMentions === false ? { resolveSkillMentions: false as const, resolveSkillPrompt: async (message: string) => message } : {}),
      ...(options?.skillInvocationText !== undefined ? { skillInvocationText: options.skillInvocationText } : {}),
    };
    if (!text || !ctx.activeWorkspace) return false;
    if (ctx.activeThread && useTaskStore.getState().workflowOwners[ctx.activeThread.id]) return queueFollowUp(ctx, text);
    if (ctx.running && !ctx.activeThread) return false;
    if (ctx.activeThread && (ctx.running || hasEligibleQueuedTurns(useTaskStore.getState().tasks[ctx.activeThread.id]?.queuedTurns))) return queueFollowUp(ctx, text);
    return deliverMessage(ctx, text, "turn");
  }, [deliverMessage, queueFollowUp]);

  const steerMessage = useCallback(async (text: string, options?: { resolveSkillMentions?: boolean; skillInvocationText?: string }): Promise<boolean> => {
    const current = contextRef.current;
    const ctx = {
      ...current,
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
      if (!delivered && !resolutionFailed) return queueFollowUp(ctx, text);
      return delivered;
    }
    if (ctx.activeThread && ctx.running && !task) {
      const delivered = await deliverMessage(ctx, text, "steer", undefined, resolutionFailure);
      return delivered || (!resolutionFailed && queueFollowUp(ctx, text));
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
    // A draft send has no thread to interrupt yet, and its runtime call may not
    // even have been made. Advancing the generation is the cutoff: whichever
    // point the send has reached, it aborts as soon as it learns its thread id.
    if (!activeThread) {
      draftGenerationRef.current += 1;
      // A stopped draft cannot dispatch after its preparation resumes. Release
      // its folder now even if a skill scan remains pending; scheduled starts
      // have separate ownership and are unaffected by the visible draft Stop.
      for (const token of ordinarySharedDraftStartsRef.current) pendingSharedDraftStarts.delete(token);
      ordinarySharedDraftStartsRef.current.clear();
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
      if (pendingTurnStartsRef.current.requestCancel(activeThread.id)) {
        setStatus("Stopping");
      }
      return;
    }
    const localProvider = isClaudeThread(activeThread) || isCursorThread(activeThread);
    if (localProvider) markProviderStopIntent(activeThread.id, turnId);
    try {
      if (isClaudeThread(activeThread)) await killClaudeTurn(activeThread.id);
      else if (isCursorThread(activeThread)) await killCursorTurn(activeThread.id);
      else await rpc("turn/interrupt", { threadId: activeThread.id, turnId });
      useTaskStore.getState().setActiveTurn(activeThread.id, undefined);
      useTaskStore.getState().setTaskStatus(activeThread.id, "interrupted");
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      setStartingDraftTurn(false);
      setTransientStatus("Stopped");
    } catch (reason) {
      if (localProvider) clearProviderStopIntent(activeThread.id, turnId);
      setError(friendlyError(reason));
      throw reason;
    }
  }, []);

  return {
    sendMessage, answerQuestions, steerMessage, steerQueuedMessage, retryQueuedMessage, removeQueuedMessage, beginEditQueuedMessage, finishEditQueuedMessage,
    scheduleMessage, rescheduleQueuedMessage, queueTimedMessageNow,
    beginEditNewThreadPrompt, finishEditNewThreadPrompt, rescheduleNewThreadPrompt, sendNewThreadPromptNow, removeNewThreadPrompt,
    stopTurn,
  };
}

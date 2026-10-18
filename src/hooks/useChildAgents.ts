import { latestCodexTurn, terminalTurnStatus } from "./useThreadHealth";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  onChildAgentRequest,
  claimChildAgentSpawn,
  isChildAgentRequestActive,
  reactivateChildAgent,
  reportChildAgentFinished,
  respondToChildAgentRequest,
  retireUnclaimedChildAgentSpawns,
  type ChildAgentRequest,
  type PreservedSpawn,
  type RetiredSpawnReceipt,
} from "../lib/agentBridge";
import {
  childAgentModel,
  childAgentPolicyForThread,
  childAgentAutoCompactIssue,
  childAgentReasoningEffort,
  childAgentTargetIssue,
  childLifecycle,
  childLifecycleForLink,
  childReviewPhase,
  isChildActive,
  sanitizeProjectSubagentSettings,
  type ChildAgentReadiness,
  type ChildAgentLink,
  type ChildAgentPolicy,
} from "../lib/childAgents";
import { childAgentPolicyForSession, childAgentRegistrationForSession, childThreadForBridgeSession, projectTerminalScopeForSession, revokeRootChildAgentRegistration } from "../lib/childAgentSessions";
import { ChildAgentStartUncertainError, continueChildAgentTurn, definitelyNotDispatched, startChildAgentTurn } from "../lib/childRun";
import {
  cancelQueuedForChild,
  cancelQueuedForRoot,
  closeChildMailboxQuestions,
  deliverableGuidance,
  getChildMailbox,
  hasChildReadReplay,
  guidanceOutcomeForModel,
  MAX_QUEUED_FOR_CHILD,
  guidanceRevision,
  mailMessageForModel,
  postMessageToParent,
  queueMessageToChild,
  queuedForChild,
  replayReadForChild,
  resolveGuidanceOutcomes,
  retainedMessageToChild,
  retainedMessageToParent,
  subscribeChildMailboxes,
  summarizeChildMailbox,
  takeQueuedForChild,
  takeUnreadForParent,
  takeUnreadForParentMany,
  transitionChildMessage,
  unresolvedGuidanceOutcomes,
  waitForMailbox,
  type ChildMailMessage,
} from "../lib/childAgentMailbox";
import { auditEvent, rpc, type JsonObject } from "../lib/codex";
import { isClaudeTurnActive, killClaudeTurn, loadClaudeTranscript, steerClaudeTurn } from "../lib/claude";
import { cursorTurnState, isCursorTurnActive, killCursorTurn, loadCursorTranscript, steerCursorTurn } from "../lib/cursor";
import { restoreCursorTurnOwner } from "../lib/cursorTurnOwnership";
import { recoverCursorAssistantSegments } from "../lib/cursorEvents";
import { buildTurnInput } from "../lib/turnInput";
import { cursorTurnCanSettle } from "../lib/cursorTurnOwnership";
import { friendlyError } from "../lib/errors";
import type { ResolvedSkillPrompts } from "../lib/skills";
import { isActiveAgentRecord } from "../lib/subAgentActivity";
import { decodeHtmlEntities } from "../lib/text";
import { upsertThread } from "../lib/threadList";
import { timelineFromTurns } from "../lib/threadTimeline";
import { captureHistoryReadBoundary, useTaskStore, type TaskStatus } from "../lib/taskStore";
import { clearProviderStopIntent, markProviderStopIntent } from "../lib/providerStopIntent";
import { sealStoppedTurn } from "../lib/stopTurnHistory";
import type { OpenRouterModel } from "../components/OpenRouterModelControl";
import type { LMStudioModel } from "../lib/lmStudio";
import type { SetPersisted } from "./usePersistedState";
import { MAX_RUN_COMMAND_LENGTH, sanitizeProjectRunCommand } from "../lib/projectRun";
import { MAX_CHECK_COMMAND_LENGTH, sanitizeProjectCheckCommand } from "../lib/projectChecks";
import type { ProjectTerminalSnapshot } from "../lib/terminalSnapshot";
import { nativeDescendantIds, type NativeAgentLink } from "../lib/nativeAgentLinks";
import type { AgentRecord } from "../components/StudioDock";
import type { PendingApproval, PermissionMode, ProjectCheckCommand, ProjectRunCommand, ProjectSubagentSettings, Provider, Thread, ThreadReasoning } from "../types";

/**
 * Routes the delegation requests a root agent makes through the Mythra Code
 * bridge into real per-provider turns.
 *
 * Every decision that could be abused lives here or in the backend, never in
 * the model's hands: the destination must be one the frozen policy approved,
 * the child inherits the parent's folder and permission mode, a child may
 * never delegate again, and the concurrency budget is the same one the
 * composer shows.
 */

/** Longest a single `collect_agent` call blocks before reporting progress. */
const DEFAULT_COLLECT_SECONDS = 45;
const MAX_COLLECT_SECONDS = 45;

/** Cap on the result text handed back to a parent model. */
const MAX_RESULT_CHARACTERS = 24_000;
/** Child messages one status/collect answer may carry, and children listed. */
const MAX_MESSAGES_PER_CHILD_RESPONSE = 4;
const MAX_MESSAGES_PER_STATUS = 12;
const MAX_STATUS_CHILDREN = 40;
const MAX_READ_WAIT_SECONDS = 30;
/** Renderer-side slot held by a same-child follow-up while it starts. */
const FOLLOW_UP_RESERVATION = "pending-followup-";

export interface ChildAgentContext {
  /** Bridge sessions keyed by session id, frozen when each root thread started. */
  policies: Record<string, ChildAgentPolicy>;
  links: Record<string, ChildAgentLink>;
  /** Durable ownership for native children, including nested V2 descendants. */
  nativeLinks?: Record<string, NativeAgentLink>;
  persistNativeAgentLinks?: SetPersisted<Record<string, NativeAgentLink>>;
  persistChildAgentLinks: SetPersisted<Record<string, ChildAgentLink>>;
  openRouterModels: OpenRouterModel[];
  lmStudioModels?: LMStudioModel[];
  lmStudioBaseUrl?: string;
  readiness: ChildAgentReadiness;
  /** Logical project path a thread is bound to, before worktree resolution. */
  projectPathForThread: (threadId: string) => string | undefined;
  /** Saved-project scope for a root, never the currently selected project. */
  projectIdForThread?: (threadId: string) => string | null;
  executionPathFor: (threadId: string | null | undefined, logicalPath: string) => string;
  /** Shared Git directory of a thread's isolated worktree, when it has one. */
  isolationGitDirFor: (threadId: string) => string | undefined;
  /** Recheck unavailable or mutating worktrees after asynchronous preparation. */
  executionTargetUnavailable?: (threadId: string) => boolean;
  serviceNameFor: (threadId: string) => string;
  bindThreadToProject: (threadId: string, projectPath: string) => void;
  rememberThread: (thread: Thread) => void;
  persistThreadModel: (threadId: string, model: string) => void;
  persistThreadReasoning: (threadId: string, reasoning: ThreadReasoning) => void;
  /** Capture this child's own context policy for later turns and renderer reloads. */
  persistThreadAutoCompactTokens?: (threadId: string, tokens?: number) => void;
  setThreads: Dispatch<SetStateAction<Thread[]>>;
  cursorSessionIdsRef: MutableRefObject<Record<string, string>>;
  scheduleClaudeThreadSave: (threadId: string) => void;
  scheduleCursorThreadSave: (threadId: string) => void;
  projectSubagentSettingsForThread: (rootThreadId: string) => ProjectSubagentSettings;
  applyProjectSubagentSettings: (rootThreadId: string, settings: ProjectSubagentSettings) => void | Promise<void>;
  /** Save (or clear, with null) the project's top-bar Run button command. */
  applyProjectRunCommand: (rootThreadId: string, run: ProjectRunCommand | null) => void | Promise<void>;
  projectRunCommandForThread: (rootThreadId: string) => ProjectRunCommand | undefined;
  /** Save or clear the project's Checks button command without running it. */
  applyProjectCheckCommand: (rootThreadId: string, check: ProjectCheckCommand | null) => void | Promise<void>;
  projectCheckCommandForThread: (rootThreadId: string) => ProjectCheckCommand | undefined;
  /**
   * Start a run command in the Terminal panel for the thread's project.
   * Resolves once the process has either exited quickly or run for a moment,
   * with the output so far, so the model can report an immediate failure.
   */
  runProjectCommand: (rootThreadId: string, run: ProjectRunCommand, permission: PermissionMode, validateDispatch?: () => Promise<void>) => Promise<ProjectRunOutcome>;
  /** Inspect an existing terminal at the bridge's captured execution folder. */
  readProjectTerminal?: (scope: string, maxCharacters: number) => ProjectTerminalSnapshot | Promise<ProjectTerminalSnapshot>;
  /** Automatic pre-turn file snapshots for child turns, same as user turns. */
  beginRunCheckpoint: (threadId: string, workspacePath: string, prompt: string, provider: Provider, model: string) => Promise<string | undefined>;
  /** With an id, discard only that exact checkpoint; a newer run's is kept. */
  discardRunCheckpoint: (threadId: string, expectedCheckpointId?: string) => void;
  /** Materialize enabled selected-folder skills for any child-provider prompt. */
  resolveSkillPrompt: (message: string) => Promise<string>;
  resolveSkillPrompts?: (message: string, systemPrompt: string, mentionSource?: string) => Promise<ResolvedSkillPrompts>;
  /** Archived, archiving or deleted conversations never receive follow-ups. */
  threadUnavailable?: (threadId: string) => boolean;
  /** Temporary archive/delete work keeps queued guidance waiting. */
  threadBusy?: (threadId: string) => boolean;
  /** A managed child was signed off; the app applies its archive policy. */
  onChildAccepted?: (childThreadId: string) => void;
  /**
   * An exact never-dispatched initial child is about to be discarded. Cancel
   * pending local saves and sidebar identity before its transcript/task go.
   */
  onDiscardUnusedChild?: (childThreadId: string) => void;
  /**
   * The user's own explicit per-thread execution choice for a conversation,
   * when one exists. A parent follow-up never silently overrides it.
   */
  explicitThreadExecutionFor?: (threadId: string) => { provider?: Provider; model?: string; reasoningEffort?: string } | undefined;
  /** Live engine choice also scopes older captured policies to Mythra work. */
  subagentWorkflowForThread?: (threadId: string) => { enabled: boolean; native: boolean };
  /** Optional setup for an identified new child before its first dispatch. */
  prepareNewThreadGit?: (threadId: string, projectId: string, projectPath: string) => Promise<boolean>;
}

export interface ProjectRunOutcome {
  started: boolean;
  /** Why it did not start, in words the model can relay. */
  reason?: string;
  /** True when the process already exited during the short wait. */
  exited?: boolean;
  output?: string;
}

/**
 * One Stop operation's immutable child frontier. Both Stop waves act only on
 * this work (or children the stopped root was still starting), never on a
 * later user-typed continuation, follow-up or newer root turn.
 */
export interface ChildStopFrontier {
  rootThreadId: string;
  rootTurnId?: string;
  /** Root run start identity; a newer user run is not this Stop's work. */
  rootRunStartedAt?: number;
  /** Root stop generation before this Stop's own increment. */
  rootGeneration: number;
  managed: ReadonlyMap<string, { createdAt: number; resultRevision: number; activationId?: string }>;
  native: ReadonlyMap<string, string | undefined>;
  /**
   * Turn/run identity of every thread that may host a shared native process
   * (the root and each native parent), frozen when the Stop began.
   */
  processTurns: ReadonlyMap<string, { turnId?: string; runStartedAt?: number }>;
  /** The root was working when this Stop began; that run may not start new child work. */
  rootActive?: boolean;
  /** V2 root authority captured before cutoff; registration may be uncached after reload. */
  rootBridge?: { sessionId: string; registrationId?: string };
}

function taskStatusOf(threadId: string): TaskStatus {
  return useTaskStore.getState().statuses[threadId] ?? "idle";
}

// Re-exported from the policy module, where the UI can reach them without
// pulling in the delegation transport.
export { childLifecycle, childLifecycleForLink, isChildActive };

/** Children of one bridge session that still hold a concurrency slot. */
export function activeChildThreadIds(sessionId: string, links: Record<string, ChildAgentLink>): string[] {
  return Object.values(links)
    .filter((link) => link.sessionId === sessionId
      && link.childThreadId !== link.rootThreadId
      && isChildActive(taskStatusOf(link.childThreadId)))
    .map((link) => link.childThreadId);
}

function lastAssistantText(threadId: string, turnId?: string): string {
  const messages = useTaskStore.getState().tasks[threadId]?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.text.trim() && (!turnId || message.turnId === turnId)) return message.text;
  }
  return "";
}

async function restoreChildTimeline(link: ChildAgentLink, assertCurrent?: () => void, requireSavedTranscript = false): Promise<string> {
  const readBoundary = captureHistoryReadBoundary(useTaskStore.getState().tasks[link.childThreadId]);
  if (link.provider === "claude" || link.provider === "cursor") {
    const transcript = link.provider === "claude"
      ? await loadClaudeTranscript(link.childThreadId)
      : await loadCursorTranscript(link.childThreadId);
    assertCurrent?.();
    if (!transcript) {
      if (requireSavedTranscript) throw new Error("The sub-agent's saved conversation could not be loaded. Its transcript was left unchanged.");
      return "";
    }
    if (link.provider === "cursor" && "cursorSessionId" in transcript
      && typeof transcript.cursorSessionId === "string" && transcript.cursorSessionId) {
      managedCursorSessionIds.set(link.childThreadId, { createdAt: link.createdAt, sessionId: transcript.cursorSessionId });
    }
    useTaskStore.getState().hydrateTask(
      link.childThreadId,
      transcript.messages,
      transcript.activities,
      transcript.thread.cwd,
      undefined,
      readBoundary,
      // Disk history must merge with, not overwrite, unsaved live rows the
      // provider streamed before this read (and their streaming truth).
      { source: "local" },
    );
    return lastAssistantText(link.childThreadId);
  }
  const result = await rpc<{ thread: Thread }>("thread/read", { threadId: link.childThreadId, includeTurns: true });
  assertCurrent?.();
  const timeline = timelineFromTurns(result.thread.turns, { includeContextCompaction: link.provider === "openai" });
  useTaskStore.getState().hydrateTask(link.childThreadId, timeline.messages, timeline.activities, result.thread.cwd, undefined, readBoundary);
  return lastAssistantText(link.childThreadId);
}

/** Shared with event-driven local saves: streamed items alone are not history. */
const managedLocalTranscriptProofs = new Map<string, { createdAt: number; anchorId?: string; fresh?: boolean }>();
type ManagedLocalTranscript = Awaited<ReturnType<typeof loadClaudeTranscript>> | Awaited<ReturnType<typeof loadCursorTranscript>>;
/** Only the raw disk read is shared; admission and merge belong to each caller. */
const managedLocalTranscriptReads = new Map<string, Promise<ManagedLocalTranscript>>();
const managedCursorSessionIds = new Map<string, { createdAt: number; sessionId: string }>();

export function managedChildCursorSessionId(link: ChildAgentLink): string | undefined {
  const saved = managedCursorSessionIds.get(link.childThreadId);
  return saved?.createdAt === link.createdAt ? saved.sessionId : undefined;
}

function managedLocalTranscriptReady(link: ChildAgentLink): boolean {
  const proof = managedLocalTranscriptProofs.get(link.childThreadId);
  return Boolean(proof?.createdAt === link.createdAt && (proof.fresh || proof.anchorId
    && useTaskStore.getState().tasks[link.childThreadId]?.messages.some((message) => message.id === proof.anchorId)));
}

export async function ensureManagedChildTranscriptHydrated(link: ChildAgentLink, isCurrent: () => boolean): Promise<void> {
  if (link.provider !== "claude" && link.provider !== "cursor") return;
  if (!isCurrent()) throw new Error("The sub-agent's ownership changed before its conversation could be loaded.");
  const satisfied = () => {
    const task = useTaskStore.getState().tasks[link.childThreadId];
    const proof = managedLocalTranscriptProofs.get(link.childThreadId);
    if (proof?.createdAt !== link.createdAt || !(proof.fresh || proof.anchorId && task?.messages.some((message) => message.id === proof.anchorId))) return false;
    if (proof.fresh && task?.messages.length) managedLocalTranscriptProofs.set(link.childThreadId, { createdAt: link.createdAt, anchorId: task.messages[0].id });
    return true;
  };
  if (satisfied()) return;
  // Each caller merges under its own read boundary and its own guard. A
  // stale first observer can no longer reject a current joiner's read.
  const readBoundary = captureHistoryReadBoundary(useTaskStore.getState().tasks[link.childThreadId]);
  const key = `${link.childThreadId}:${link.createdAt}`;
  let pending = managedLocalTranscriptReads.get(key);
  if (!pending) {
    const read: Promise<ManagedLocalTranscript> = link.provider === "claude" ? loadClaudeTranscript(link.childThreadId) : loadCursorTranscript(link.childThreadId);
    pending = read;
    managedLocalTranscriptReads.set(key, read);
    void read.finally(() => { if (managedLocalTranscriptReads.get(key) === read) managedLocalTranscriptReads.delete(key); }).catch(() => undefined);
  }
  const transcript = await pending;
  if (!isCurrent()) throw new Error("The sub-agent's ownership changed while its saved conversation was loading.");
  // Another current caller may already have merged this same read.
  if (satisfied()) return;
  if (!transcript) throw new Error("The sub-agent's saved conversation could not be loaded. Its transcript was left unchanged.");
  if (link.provider === "cursor" && "cursorSessionId" in transcript
    && typeof transcript.cursorSessionId === "string" && transcript.cursorSessionId) {
    managedCursorSessionIds.set(link.childThreadId, { createdAt: link.createdAt, sessionId: transcript.cursorSessionId });
  }
  useTaskStore.getState().hydrateTask(link.childThreadId, transcript.messages, transcript.activities, transcript.thread.cwd,
    undefined, readBoundary, { source: "local" });
  const loaded = useTaskStore.getState().tasks[link.childThreadId];
  if (!loaded?.messages.length) throw new Error("The sub-agent's saved conversation could not be loaded. Its transcript was left unchanged.");
  managedLocalTranscriptProofs.set(link.childThreadId, { createdAt: link.createdAt, anchorId: loaded.messages[0].id });
}

function truncateResult(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARACTERS) return { text, truncated: false };
  const marker = "\n… [middle omitted] …\n";
  return { text: text.slice(0, 4000) + marker + text.slice(-(MAX_RESULT_CHARACTERS - 4000 - marker.length)), truncated: true };
}

/**
 * A persisted link with no local status after a reload proves nothing. Ask
 * the runtime before treating the child as finished or idle.
 */
async function recoverChildStatus(link: ChildAgentLink, assertCurrent: () => void): Promise<"running" | "unknown" | null> {
  const childId = link.childThreadId;
  if (!link.activationPending && (taskStatusOf(childId) !== "idle" || link.terminalStatus)) return null;
  let recovered: TaskStatus | null = null;
  let recoveredTurnId: string | undefined;
  if (link.provider === "claude" || link.provider === "cursor") {
    // Cursor: the backend's exact native identity (turn, start, session) is
    // the evidence for this reload; install it before admitting live events.
    const native = link.provider === "cursor" ? await cursorTurnState(childId).catch(() => null) : null;
    assertCurrent();
    if (native?.cursorSessionId) managedCursorSessionIds.set(childId, { createdAt: link.createdAt, sessionId: native.cursorSessionId });
    // Cursor reports when the requested reasoning effort was unsupported and
    // the provider default ran instead. Keep that visible after recovery.
    if (native?.effortStatus === "unsupported") {
      useTaskStore.getState().upsertActivity(childId, {
        id: `cursor-effort-${native.turnId}`, kind: "warning", status: "completed",
        title: "Requested reasoning effort was not applied",
        detail: `Cursor did not support the requested effort${native.requestedEffort ? ` (${native.requestedEffort})` : ""} for this turn; the provider default was used.`,
      });
    }
    const active = await (link.provider === "claude" ? isClaudeTurnActive(childId) : isCursorTurnActive(childId));
    assertCurrent();
    if (active) {
      // A reload may already have received one streamed item. That partial
      // task is not proof the earlier conversation was hydrated.
      await ensureChildHydrated(link, assertCurrent);
      assertCurrent();
      if (native && native.phase !== "completed") {
        const restored = restoreCursorTurnOwner(childId, native.turnId, native.startRequestId, native.phase);
        const store = useTaskStore.getState();
        if (restored.restored && native.phase !== "stopping" && (!store.tasks[childId]?.activeTurnId || store.tasks[childId]?.activeTurnId === native.turnId)) {
          store.setActiveTurn(childId, native.turnId);
          recoverCursorAssistantSegments(childId, native.turnId);
        }
      }
      if (taskStatusOf(childId) === "idle") useTaskStore.getState().setTaskStatus(childId, "running");
      return "running";
    }
    await restoreChildTimeline(link, assertCurrent);
    assertCurrent();
    const last = useTaskStore.getState().tasks[childId]?.messages.at(-1)?.turnStatus;
    const lastTurnId = useTaskStore.getState().tasks[childId]?.messages.at(-1)?.turnId;
    if (link.activationPending && (!lastTurnId || lastTurnId === link.activationPreviousTurnId
      || (link.activationTurnId && lastTurnId !== link.activationTurnId))) return "unknown";
    recovered = last === "completed" ? "completed" : last === "failed" ? "error" : last === "interrupted" ? "interrupted" : null;
    if (!recovered) return "unknown";
    recoveredTurnId = lastTurnId;
  } else {
    const turn = await latestCodexTurn(childId);
    assertCurrent();
    if (link.activationPending && (!turn?.id || turn.id === link.activationPreviousTurnId
      || (link.activationTurnId && turn.id !== link.activationTurnId))) return "unknown";
    recovered = confirmedRuntimeTerminal(turn);
    if (!recovered) {
      if (turn?.status === "inProgress") {
        const store = useTaskStore.getState();
        if (!store.tasks[childId]?.activeTurnId || store.tasks[childId]?.activeTurnId === turn.id) {
          store.setActiveTurn(childId, turn.id);
          store.setTaskStatus(childId, "running");
        }
        return "running";
      }
      return "unknown";
    }
    recoveredTurnId = turn?.id;
  }
  const store = useTaskStore.getState();
  const activeTurnId = store.tasks[childId]?.activeTurnId;
  if (activeTurnId && activeTurnId !== recoveredTurnId) return "running";
  if (taskStatusOf(childId) === "idle" || link.activationPending) {
    if (recoveredTurnId) store.completeTurn(childId, recoveredTurnId, recovered);
    else if (!link.activationPending) store.setTaskStatus(childId, recovered);
    else return "unknown";
  }
  return null;
}

/** Never rewrite a transcript from an unloaded (empty) task. */
async function ensureChildHydrated(link: ChildAgentLink, assertCurrent?: () => void): Promise<void> {
  if (link.provider === "claude" || link.provider === "cursor") {
    return ensureManagedChildTranscriptHydrated(link, () => {
      assertCurrent?.();
      return true;
    });
  }
  if (useTaskStore.getState().tasks[link.childThreadId]?.messages.length) return;
  await restoreChildTimeline(link, assertCurrent);
  if (!useTaskStore.getState().tasks[link.childThreadId]?.messages.length) {
    throw new Error("The sub-agent's saved conversation could not be loaded. Its transcript was left unchanged.");
  }
}

/** What the child sees for parent guidance, whether steered or a new turn. */
export function formatParentMessages(messages: readonly ChildMailMessage[]): string {
  const body = messages.map((message) => [
    messages.length > 1 ? `[${message.id}] ` : "",
    message.replyTo ? `(Reply to your ${message.replyTo}) ` : "",
    message.text,
  ].join("")).join("\n\n");
  return `${messages.length > 1 ? "Messages" : "Message"} from your parent agent (via Mythra Code):\n\n${body}`;
}

/** Questions remain recoverable until an answer reaches the child or work is accepted. */
function unresolvedChildQuestions(childThreadId: string, limit: number, exclude: readonly ChildMailMessage[] = []): ChildMailMessage[] {
  const seen = new Set(exclude.map((message) => message.id));
  return (getChildMailbox(childThreadId)?.messages ?? [])
    .filter((message) => message.direction === "toParent" && message.kind === "question"
      && !message.answeredAt && !message.closedAt && !seen.has(message.id))
    .slice(0, Math.max(0, limit));
}

/**
 * The provider turn whose output belongs to the current result revision.
 * The turn that was settled when an explicit activation began is never
 * evidence for that newer attempt, even if the attempt failed before a turn.
 */
export function childReviewedTurnId(link: ChildAgentLink): string | undefined {
  const base = link.resultRevision ? link.revisionBaseTurnId : undefined;
  // The exact acknowledged/reconciled turn of the current revision wins; a
  // late completion event for an older turn must not become the result.
  if (link.activationTurnId && link.activationTurnId !== base) return link.activationTurnId;
  // Without an explicit revision (initial or legacy links), the latest
  // completed turn is the only evidence. A newer revision needs its own turn.
  if (link.resultRevision) return undefined;
  return useTaskStore.getState().tasks[link.childThreadId]?.lastCompletedTurnId;
}

/** Parent sign-off names the exact settled result it reviewed, not merely a child. */
export function childReviewToken(link: ChildAgentLink): string | undefined {
  const status = taskStatusOf(link.childThreadId);
  if (isChildActive(status) || link.activationPending || childLifecycleForLink(link, status) === "unknown") return;
  const turnId = childReviewedTurnId(link);
  const resultId = turnId ?? (link.terminalStatus && link.finishedAt
    ? `cutoff:${link.activationId ?? "initial"}:${link.terminalStatus}:${link.finishedAt}` : undefined);
  if (!resultId) return;
  // Undelivered guidance is part of what a parent reviews: a correction that
  // fails after collection changes the token, so the old one cannot accept.
  return `${link.childThreadId}:${link.createdAt}:${link.followUps ?? 0}:r${link.resultRevision ?? 0}:g${guidanceRevision(link.childThreadId)}:${resultId}`;
}

/**
 * Insert guidance into a child's running turn. Resolves only when the
 * runtime acknowledged it; any refusal leaves the caller to queue it.
 */
async function steerChild(link: ChildAgentLink, text: string): Promise<void> {
  const threadId = link.childThreadId;
  if (link.provider === "claude") return steerClaudeTurn(threadId, text, []);
  if (link.provider === "cursor") return steerCursorTurn(threadId, text, []);
  const expectedTurnId = useTaskStore.getState().tasks[threadId]?.activeTurnId;
  if (!expectedTurnId) throw new Error("The sub-agent's active turn is still starting");
  await rpc("turn/steer", { threadId, expectedTurnId, input: buildTurnInput(text, []) });
}

/** Resolve on this child's next status or mailbox change, an extra wake condition, or the deadline. */
function waitForChildChange(childThreadId: string, timeoutMs: number, wake?: () => boolean, subscribeLifecycle?: (listener: () => void) => () => void): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();
  const initialMailbox = getChildMailbox(childThreadId);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribeTask();
      unsubscribeMailbox();
      unsubscribeLifecycle?.();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribeTask = useTaskStore.subscribe((state, previous) => {
      if (state.statuses[childThreadId] !== previous.statuses[childThreadId]) finish();
    });
    const unsubscribeMailbox = subscribeChildMailboxes(() => {
      if (getChildMailbox(childThreadId) !== initialMailbox || wake?.()) finish();
    });
    const unsubscribeLifecycle = subscribeLifecycle?.(finish);
  });
}

/** Refusal that decides what happens to the guidance it held. */
class FollowUpRefused extends Error {
  constructor(message: string, readonly disposition: "cancel" | "keep") {
    super(message);
  }
}

const DELIVERY_UNCERTAIN_PREFIX = "MYTHRA_DELIVERY_UNCERTAIN:";

/**
 * A steering failure after the request was issued that does not prove the
 * runtime refused it: the native uncertain marker, or a transport loss.
 * A runtime's explicit error response (no active turn, mismatch) is a refusal.
 */
function deliveryUncertain(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return text.includes(DELIVERY_UNCERTAIN_PREFIX)
    || /timed? ?out|timeout|disconnect|connection (?:closed|reset|lost|refused)|broken pipe|stream (?:closed|ended)|stopped tracking/i.test(text);
}

/** Permanent reasons a parent may not continue this child. */
function followUpRefusal(link: ChildAgentLink): string | null {
  if (link.signoff !== "required") {
    return "This sub-agent uses V1 delegation. Collect its result or spawn a new sub-agent for more work.";
  }
  if (link.acceptedAt) {
    return "This sub-agent's work was already accepted, and accepted sub-agents are closed to the parent. Spawn a new sub-agent for more work.";
  }
  if (link.stopOrigin === "user") {
    return "The user stopped this sub-agent. Mythra Code never resumes a user-stopped sub-agent automatically; spawn a replacement if the work is still needed.";
  }
  return null;
}

/**
 * Resolve once the child reaches a terminal state, or when the wait elapses.
 * Never rejects: a timeout is a legitimate answer the parent can act on.
 */
export function waitForChildTerminalStatus(threadId: string, timeoutMs: number): Promise<TaskStatus> {
  const current = taskStatusOf(threadId);
  if (!isChildActive(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: TaskStatus) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => finish(taskStatusOf(threadId)), timeoutMs);
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      if (state.statuses === previous.statuses) return;
      const status = state.statuses[threadId];
      if (status && !isChildActive(status)) finish(status);
    });
  });
}

/**
 * Cut a child off now.
 *
 * Stop is a promise to the user, so the subscription providers get a process
 * kill rather than a cooperative interrupt a wedged CLI could ignore; both
 * kill commands are idempotent, so a child that already exited settles quietly.
 * Codex-hosted children are real runtime threads, and `turn/interrupt` is the
 * only cutoff their runtime exposes.
 */
async function hardStopChild(provider: ChildAgentLink["provider"], childThreadId: string, turnId?: string, ctx?: ChildAgentContext, expectedLink?: ChildAgentLink, assertManagedActivation?: () => void): Promise<TaskStatus> {
  if (provider !== "claude" && provider !== "cursor") return stopCodexChild(childThreadId, turnId, assertManagedActivation, expectedLink);
  const initialTask = useTaskStore.getState().tasks[childThreadId];
  const targetTurnId = turnId ?? initialTask?.activeTurnId;
  if (targetTurnId) markProviderStopIntent(childThreadId, targetTurnId);
  try {
    // Target exactly the turn this Stop observed; the backend refuses a
    // different current owner instead of killing newer work.
    const expected = targetTurnId ? { turnId: targetTurnId }
      : expectedLink?.activationStartRequestId ? { startRequestId: expectedLink.activationStartRequestId } : undefined;
    if (provider === "claude") await killClaudeTurn(childThreadId, expected);
    else await killCursorTurn(childThreadId, expected);
    assertManagedActivation?.();
    const store = useTaskStore.getState();
    const current = store.tasks[childThreadId];
    if (current?.activeTurnId && current.activeTurnId !== targetTurnId
      || !assertManagedActivation && current !== initialTask && current && !current.activeTurnId && isChildActive(current.status)
      || current?.lastCompletedTurnId && current.lastCompletedTurnId !== targetTurnId
        && current.lastCompletedTurnId !== initialTask?.lastCompletedTurnId) {
      throw new Error("The sub-agent started another turn before Stop settled. Its current turn remains active.");
    }
    const terminal = confirmedLocalTerminal(childThreadId);
    if (!terminal) {
      if (targetTurnId) sealStoppedTurn(childThreadId, targetTurnId);
      else {
        store.flushDeltas();
        store.completeTurn(childThreadId, undefined, "interrupted");
      }
    }
    // A cutoff can succeed even when history is unavailable. Never replace
    // the saved conversation with a task created solely to seal that cutoff.
    if (initialTask?.messages.length && (!expectedLink || managedLocalTranscriptReady(expectedLink))) {
      if (provider === "claude") ctx?.scheduleClaudeThreadSave(childThreadId);
      else ctx?.scheduleCursorThreadSave(childThreadId);
    }
    return confirmedLocalTerminal(childThreadId) ?? "interrupted";
  } finally {
    if (targetTurnId) clearProviderStopIntent(childThreadId, targetTurnId);
  }
}

function cutoffAlreadySettled(reason: unknown): boolean {
  return /not currently running|no active task|unknown (?:thread|turn)|not found|already (?:finished|stopped|completed)|connection closed/i
    .test(friendlyError(reason));
}

function confirmedLocalTerminal(threadId: string): TaskStatus | null {
  const status = useTaskStore.getState().statuses[threadId];
  return status === "completed" || status === "interrupted" || status === "error" ? status : null;
}

function confirmedRuntimeTerminal(turn: Awaited<ReturnType<typeof latestCodexTurn>>): TaskStatus | null {
  return turn?.status === "completed" || turn?.status === "failed" || turn?.status === "interrupted"
    ? terminalTurnStatus(turn) : null;
}

/** Interrupt only a known running turn; a stale/absent turn is not a cutoff. */
async function stopCodexChild(threadId: string, knownTurnId?: string, assertNativeActivation?: () => void, expectedLink?: ChildAgentLink): Promise<TaskStatus> {
  // A resumed native agent can still carry the previous turn's terminal task.
  // Only a fresh local terminal event or a runtime read proves this turn ended.
  const initialTask = useTaskStore.getState().tasks[threadId];
  const freshLocalTerminal = () => {
    const current = useTaskStore.getState().tasks[threadId];
    if (!current || current === initialTask) return null;
    const terminal = confirmedLocalTerminal(threadId);
    // Roster/usage updates also replace the task object; that cannot make a
    // previous terminal status evidence of a new completion.
    return terminal && (current.status !== initialTask?.status
      || Boolean(initialTask?.activeTurnId && !current.activeTurnId)) ? terminal : null;
  };
  const readLatest = async () => {
    try {
      const latest = await latestCodexTurn(threadId);
      if (expectedLink && (expectedLink.activationPending && (!latest?.id || latest.id === expectedLink.activationPreviousTurnId)
        || expectedLink.activationTurnId && latest?.id !== expectedLink.activationTurnId)) {
        throw new Error("The runtime did not expose the sub-agent's current activation; an older turn cannot prove this Stop succeeded.");
      }
      return latest;
    } catch (reason) {
      throw new Error(`Could not confirm the native sub-agent's current turn: ${friendlyError(reason)}`);
    }
  };
  let turnId = knownTurnId ?? useTaskStore.getState().tasks[threadId]?.activeTurnId;
  let activationTask = initialTask;
  const assertSameActivation = () => {
    assertNativeActivation?.();
    const current = useTaskStore.getState().tasks[threadId];
    const replacedTurn = Boolean(current?.activeTurnId && current.activeTurnId !== turnId);
    // Without a local turn ID, any changed active task is uncertain. Native
    // reactivation always calls setActiveTurn(undefined), which replaces it
    // even when the repeated status/ID values are unchanged.
    const clearedForNewActivation = Boolean(!(expectedLink && assertNativeActivation) && current !== activationTask
      && current && !current.activeTurnId && isChildActive(current.status));
    const newerCompletedTurn = Boolean(current?.lastCompletedTurnId && current.lastCompletedTurnId !== turnId
      && current.lastCompletedTurnId !== activationTask?.lastCompletedTurnId);
    if (replacedTurn || clearedForNewActivation || newerCompletedTurn) {
      throw new Error("The native sub-agent started another turn before Stop settled. Its current turn remains active.");
    }
  };
  if (!turnId) {
    const latest = await readLatest();
    const discoveredLocalTurn = useTaskStore.getState().tasks[threadId]?.activeTurnId;
    if (discoveredLocalTurn && discoveredLocalTurn !== latest?.id) {
      turnId = discoveredLocalTurn;
    }
    turnId ??= latest?.status === "inProgress" ? latest.id : undefined;
    assertSameActivation();
    const terminal = confirmedRuntimeTerminal(latest);
    if (!turnId && terminal) {
      const freshTerminal = freshLocalTerminal();
      if (freshTerminal) return freshTerminal;
      const currentTask = useTaskStore.getState().tasks[threadId];
      if (isChildActive(initialTask?.status ?? "idle") || isChildActive(currentTask?.status ?? "idle")) {
        throw new Error("Could not confirm the newly active native sub-agent's turn. The runtime only exposed an older terminal turn.");
      }
      return terminal;
    }
    if (!turnId && (latest?.status !== "inProgress" || !latest.id)) {
      throw new Error("Could not confirm an active turn for this native sub-agent. Its stop status remains unknown.");
    }
    turnId ??= latest?.id;
  }
  activationTask = useTaskStore.getState().tasks[threadId];
  try {
    await rpc("turn/interrupt", { threadId, turnId });
  } catch (reason) {
    assertSameActivation();
    const terminal = freshLocalTerminal();
    if (terminal) return terminal;
    if (cutoffAlreadySettled(reason)) {
      const latest = await readLatest();
      assertSameActivation();
      const settled = confirmedRuntimeTerminal(latest);
      if (settled && latest?.id === turnId) {
        const store = useTaskStore.getState();
        store.flushDeltas();
        store.completeTurn(threadId, turnId, settled);
        return settled;
      }
    }
    throw new Error(`Could not confirm the native sub-agent stopped: ${friendlyError(reason)}`);
  }
  assertSameActivation();
  const terminal = freshLocalTerminal();
  if (terminal) return terminal;
  sealStoppedTurn(threadId, turnId!);
  return "interrupted";
}

type NativeChild = AgentRecord & { rootThreadId: string };

function assertNativeChildActivation(agent: NativeChild): void {
  const current = useTaskStore.getState().tasks[agent.rootThreadId]?.agents.find((entry) => entry.id === agent.id);
  if (current?.activationId !== agent.activationId) {
    throw new Error("The native sub-agent received another activation before Stop settled. Its current work remains active.");
  }
}

/** Include durable descendants even when their conversations are not loaded. */
function nativeChildrenFor(rootThreadId: string, links: Record<string, NativeAgentLink> = {}): NativeChild[] {
  const tasks = useTaskStore.getState().tasks;
  const children = new Map<string, NativeChild>();
  const parents = [rootThreadId, ...nativeDescendantIds(links, rootThreadId)];
  const seen = new Set<string>();
  for (let index = 0; index < parents.length; index += 1) {
    const parent = parents[index];
    if (seen.has(parent)) continue;
    seen.add(parent);
    const link = links[parent];
    if (parent !== rootThreadId && link) {
      children.set(parent, {
        id: parent, rootThreadId: link.rootThreadId, prompt: link.title,
        status: link.status ?? "unknown", provider: link.provider, runtime: link.runtime, model: link.model, createdAt: link.createdAt,
      });
    }
    for (const agent of tasks[parent]?.agents ?? []) {
      if (agent.id === rootThreadId || agent.id === parent) continue;
      const owner = links[agent.id]?.rootThreadId ?? parent;
      if (owner !== parent) continue;
      children.set(agent.id, { ...children.get(agent.id), ...agent, rootThreadId: owner });
      if (!seen.has(agent.id)) parents.push(agent.id);
    }
  }
  // Prefer hydrated records to durable status, regardless of graph traversal order.
  return [...children.values()].map((child) => {
    const hydrated = { ...child, ...tasks[child.rootThreadId]?.agents.find((agent) => agent.id === child.id) };
    const ownStatus = tasks[child.id]?.status;
    // A user can reopen and run the child independently of its parent. The
    // child's current activation outranks a settled parent roster/link.
    return { ...hydrated, ...(ownStatus && isChildActive(ownStatus) ? { status: ownStatus } : {}), rootThreadId: child.rootThreadId };
  });
}

function settleStoppedChild(rootThreadId: string, childThreadId: string, prompt: string, status: TaskStatus): void {
  const store = useTaskStore.getState();
  store.setTaskStatus(childThreadId, status);
  const activityStatus = status === "interrupted" ? "cancelled" : status === "error" ? "failed" : "completed";
  settleChildInParent(rootThreadId, childThreadId, prompt, status, activityStatus);
}

/**
 * Make the parent roster and every Relay card representing a child agree with
 * the provider cutoff. Spawn waves remain live while one represented sibling
 * is genuinely active, then settle when the last worker stops.
 */
function settleChildInParent(
  rootThreadId: string,
  childThreadId: string,
  prompt: string,
  agentStatus: string,
  activityStatus: "completed" | "cancelled" | "failed",
): void {
  const store = useTaskStore.getState();
  const existing = store.tasks[rootThreadId]?.agents.find((entry) => entry.id === childThreadId);
  store.upsertAgent(rootThreadId, {
    ...existing,
    id: childThreadId,
    prompt,
    status: agentStatus,
    path: existing?.path,
  });

  const latest = useTaskStore.getState();
  const rootTask = latest.tasks[rootThreadId];
  if (!rootTask) return;
  const activeAgentIds = new Set(rootTask.agents
    .filter((agent) => isActiveAgentRecord(agent.status))
    .map((agent) => agent.id));
  for (const activity of rootTask.activities) {
    if (activity.kind !== "agent" || activity.agent?.action !== "spawn") continue;
    const represented = activity.agent.threadIds ?? [];
    const representsChild = activity.id === `child-agent-${childThreadId}`
      || represented.includes(childThreadId);
    if (!representsChild) continue;
    const siblingStillActive = represented.some((id) => activeAgentIds.has(id)
      || isChildActive(latest.statuses[id] ?? "idle"));
    if (!siblingStillActive) store.upsertActivity(rootThreadId, { ...activity, status: activityStatus });
  }
}

export function useChildAgents(context: ChildAgentContext): {
  /** Stop a root's children; pass one Stop's frontier to both waves. */
  cancelChildAgentsFor: (rootThreadId: string, frontier?: ChildStopFrontier) => Promise<void>;
  /** Capture the exact child work a Stop targets, before stopping the root. */
  captureChildStopFrontier: (rootThreadId: string) => ChildStopFrontier;
  stopChildAgent: (rootThreadId: string, childThreadId: string) => Promise<void>;
  respondToSettingsProposal: (approval: PendingApproval, result: JsonObject) => Promise<void>;
  /** User sign-off from the command center, equivalent to the parent's accept_agent. */
  acceptChildAgent: (rootThreadId: string, childThreadId: string, expectedReviewToken?: string) => Promise<void>;
  /** Synchronous archive/delete invalidation before a provider operation awaits. */
  invalidateChildAgentGuidance: (threadId: string, reason: string) => void;
  /** Offer retained guidance again after a busy/unavailable condition cleared. */
  retryChildAgentGuidance: (threadId: string) => void;
  /** User-typed turn admitted on a thread (pre-dispatch); reopens a managed child under a new revision. */
  noteExplicitChildStart: (threadId: string, attemptId: string) => void;
  /** That attempt reached dispatch, or was refused before any provider request (`false` restores). */
  settleExplicitChildStart: (threadId: string, attemptId: string, dispatched: boolean) => void;
  /**
   * Whether a provider is still starting a child for this root, before the
   * child's durable ownership link exists. Archive and delete must treat such
   * a root as busy: its link map and agent roster cannot see the child yet.
   */
  hasChildStartInFlight: (rootThreadId: string) => boolean;
  /** Fresh authority check; call again when saving the preview setting. */
  getManagedSubagentV2LockedReason: () => string | undefined;
  /** Re-renders callers when preparation changes before a task/link exists. */
  managedSubagentV2LockRevision: number;
} {
  const contextRef = useRef(context);
  contextRef.current = context;
  const [managedSubagentV2LockRevision, setManagedSubagentV2LockRevision] = useState(0);
  const notifyModeLockChanged = useCallback(() => setManagedSubagentV2LockRevision((revision) => revision + 1), []);
  /** Roots already reported finished, so a slot is released exactly once. */
  const releasedRef = useRef(new Set<string>());
  /** Pending slot releases keyed by child and activation, retried on failure. */
  const releases = useRef(new Map<string, { link: ChildAgentLink; activationId?: string }>());
  const releasing = useRef(new Set<string>());
  /** Latest release attempt per child; a follow-up reservation awaits it. */
  const releaseAttemptsRef = useRef(new Map<string, Promise<void>>());
  /** Deferred pump entry, assigned once the pump callbacks exist. */
  const schedulePumpRef = useRef<(sessionId: string) => void>(() => undefined);
  /** Children whose slot release failed and is being retried (bounded). */
  const releaseFailuresRef = useRef(new Map<string, string>());
  const releaseSlot = useCallback((link: ChildAgentLink, activationId: string | undefined = link.activationId, attempt = 0) => {
    const id = link.childThreadId;
    // An activation token releases only the follow-up it reserved; an
    // unversioned release covers the initial spawn slot alone.
    const key = `${id}\u0000${activationId ?? "initial"}`;
    releases.current.set(key, { link, activationId });
    if (releasing.current.has(key)) return;
    releasing.current.add(key);
    const request = reportChildAgentFinished(link.sessionId, id, activationId).then(() => {
      releases.current.delete(key);
      releaseFailuresRef.current.delete(key);
      // A freed slot may let queued follow-ups in this session start.
      schedulePumpRef.current(link.sessionId);
    }).catch((reason) => {
      // Never swallow silently: keep it visible and retry a few times with
      // backoff. Later pumps still retry after the bounded attempts end.
      releaseFailuresRef.current.set(key, friendlyError(reason));
      if (attempt < 3) {
        window.setTimeout(() => {
          if (releases.current.has(key) && !releasing.current.has(key)) releaseSlot(link, activationId, attempt + 1);
        }, 1_000 * 4 ** attempt);
      }
    }).finally(() => releasing.current.delete(key));
    releaseAttemptsRef.current.set(id, request);
    void request.finally(() => {
      if (releaseAttemptsRef.current.get(id) === request) releaseAttemptsRef.current.delete(id);
    });
  }, []);
  /**
   * Children this hook created that the rendered link map has not caught up
   * with yet, keyed by bridge session. Two tool calls can arrive between
   * renders, and without this both would read the same stale map and both pass
   * the concurrency check. Entries are dropped once the link map has them.
   */
  const pendingChildrenRef = useRef<Map<string, Set<string>>>(new Map());
  /** Links written by a spawn response before React has rendered persistence. */
  const pendingLinksRef = useRef<Map<string, ChildAgentLink>>(new Map());
  /** Monotonic per-root stop generation. A child whose provider start resolves
   * after Stop was pressed is killed before it can escape into the background. */
  const stopGenerationRef = useRef<Map<string, number>>(new Map());
  /**
   * Provider starts in progress per root. A start holds this from the moment
   * the provider is asked until the child's ownership link is persisted, the
   * window in which neither the link map nor the agent roster knows the child.
   */
  const inFlightStartsRef = useRef<Map<string, number>>(new Map());
  const hasChildStartInFlight = useCallback(
    (rootThreadId: string): boolean => (inFlightStartsRef.current.get(rootThreadId) ?? 0) > 0,
    [],
  );
  /** Owner of a child whose thread exists but whose link has not rendered. */
  const provisionalOwnersRef = useRef(new Map<string, { rootThreadId: string; sessionId: string }>());
  /** Children whose same-conversation follow-up is being started. */
  const followUpsInFlightRef = useRef(new Set<string>());
  /** Children currently blocked in read_parent_messages. */
  const childReadersRef = useRef(new Map<string, number>());
  /** Wake outstanding collection/read waits when ownership or Stop changes. */
  const childWaitersRef = useRef(new Set<() => void>());
  const notifyChildWaiters = useCallback(() => {
    for (const listener of [...childWaitersRef.current]) listener();
  }, []);
  /** Per-child stop generation; any stop invalidates an in-flight follow-up. */
  const childStopGenerationRef = useRef(new Map<string, number>());
  const childRunGenerationRef = useRef(new Map<string, number>());
  /** Recovery is observation of existing work, never a new user activation. */
  const recoveringChildrenRef = useRef(new Map<string, number>());
  /** Why queued guidance for an idle child is still waiting, for honest reporting. */
  const followUpWaitReasonRef = useRef(new Map<string, string>());
  /** A reservation preparing or ambiguously dispatched cannot settle from old task status. */
  const pendingActivationsRef = useRef(new Map<string, { activationId?: string; previousTurnId?: string; turnId?: string; uncertain?: boolean }>());
  const reconcileChildrenRef = useRef<() => void>(() => undefined);
  const scheduledPumpsRef = useRef(new Set<string>());
  const lifecycleRef = useRef({ mounted: true, generation: 0 });
  /** Historic unclaimed relays are retired before new renderer work starts. */
  const bridgeReadyRef = useRef<Promise<void>>(Promise.resolve());
  /** Exact backend receipts for initial relays retired/preserved at attach. */
  const spawnReceiptsRef = useRef<{ retired: RetiredSpawnReceipt[]; preserved: PreservedSpawn[] }>({ retired: [], preserved: [] });
  /** Pre-attempt link for each user-typed child start, for exact pre-dispatch rollback. */
  const explicitStartsRef = useRef(new Map<string, {
    attemptId: string; before: ChildAgentLink; revision: number; notedAt: number; beforeCompleted?: string; beforeStatus: TaskStatus;
    /** The attempt entered starting/running at least once: never rolled back after that. */
    admitted?: boolean;
  }>());
  /** Root stop generation each spawned child's start began under. */
  const spawnGenerationsRef = useRef(new Map<string, number>());
  /**
   * Unconfirmed follow-up activation superseded by newer work: its request
   * may still be running, so its slot token stays reserved until a cutoff.
   */
  const supersededUncertainRef = useRef(new Map<string, string>());
  /** Initial spawns between child identification and their start outcome. */
  const initialStartsRef = useRef(new Map<string, ChildAgentLink>());
  const initialStartPending = useCallback((link: ChildAgentLink): boolean => {
    const initial = initialStartsRef.current.get(link.childThreadId);
    return Boolean(initial && link.signoff === "required" && initial.createdAt === link.createdAt
      && initial.sessionId === link.sessionId && initial.rootThreadId === link.rootThreadId
      && initial.activationId === link.activationId && initial.resultRevision === link.resultRevision
      && initial.manualAttemptId === link.manualAttemptId && initial.stopOrigin === link.stopOrigin);
  }, []);
  /**
   * Roots whose working run a Stop targeted. Tool calls that run emits while
   * its cutoff settles cannot start new child work. A newer app-owned run
   * clears the mark only after revocation or replacement authority exists.
   * Late status events do not.
   */
  const stoppedRootRunsRef = useRef(new Map<string, {
    runStartedAt?: number;
    sessionId?: string;
    registrationId?: string;
    revocation: "pending" | "revoked" | "failed";
  }>());
  const rootRunStopped = useCallback((rootThreadId: string, requestRegistrationId?: string): boolean => {
    const stopped = stoppedRootRunsRef.current.get(rootThreadId);
    if (!stopped) return false;
    const currentRun = useTaskStore.getState().tasks[rootThreadId]?.agentRunStartedAt;
    const newerAdmission = currentRun !== undefined && currentRun !== stopped.runStartedAt;
    // Admission alone cannot release the old bridge while its queued Stop
    // still waits: the new attempt might fail before rotating registration.
    // After a failed revoke, require an authenticated request through the
    // replacement launch. Queued revocation invalidates the old cache before
    // its native call, including when no descriptor was cached at capture.
    const replacement = stopped.revocation === "failed" && requestRegistrationId !== undefined
      && requestRegistrationId !== stopped.registrationId
      && stopped.sessionId !== undefined && requestRegistrationId === childAgentRegistrationForSession(stopped.sessionId);
    if (newerAdmission && (stopped.revocation === "revoked" || replacement)) {
      stoppedRootRunsRef.current.delete(rootThreadId);
      return false;
    }
    return true;
  }, []);

  const getManagedSubagentV2LockedReason = useCallback((): string | undefined => {
    const ctx = contextRef.current;
    const store = useTaskStore.getState();
    if ([...inFlightStartsRef.current.values()].some((count) => count > 0)
      || followUpsInFlightRef.current.size || explicitStartsRef.current.size) {
      return "Wait for sub-agent preparation to finish before changing this preview.";
    }
    if (pendingActivationsRef.current.size || supersededUncertainRef.current.size) {
      return "Confirm or stop sub-agents whose activation is uncertain before changing this preview.";
    }
    const links = { ...ctx.links, ...Object.fromEntries(pendingLinksRef.current) };
    for (const link of Object.values(links)) {
      const status = store.statuses[link.childThreadId] ?? "idle";
      if (link.activationPending || isChildActive(status) || childLifecycleForLink(link, status) === "unknown") {
        return `Finish or stop active sub-agents before changing this preview. Still unsettled: “${link.title}”.`;
      }
      if (getChildMailbox(link.childThreadId)?.messages.some((message) => message.direction === "toChild"
        && (message.state === "queued" || message.state === "delivering"))) {
        return "Let queued sub-agent guidance settle before changing this preview.";
      }
    }
    // Provider-native delegation never reads this preview. Neither its live
    // workers nor durable records (including legacy links with no status)
    // may block a Mythra-only preference. Native Stop and slot accounting
    // deliberately keep their separate conservative unknown-state handling.
    for (const stored of Object.values(ctx.policies)) {
      const policy = childAgentPolicyForSession(ctx.policies, stored.sessionId);
      // A saved Mythra roster can remain after this thread switched engines;
      // it is not evidence that its current native turn can use that roster.
      if (policy?.targets.length && isChildActive(store.statuses[policy.rootThreadId] ?? "idle")
        && !ctx.subagentWorkflowForThread?.(policy.rootThreadId).native) {
        return "Finish the running parent turn before changing this preview.";
      }
    }
    for (const [threadId, status] of Object.entries(store.statuses)) {
      const workflow = isChildActive(status) ? ctx.subagentWorkflowForThread?.(threadId) : undefined;
      if (!links[threadId] && !ctx.nativeLinks?.[threadId] && isChildActive(status)
        && workflow?.enabled && !workflow.native) {
        return "Finish the running parent turn before changing this preview.";
      }
    }
    return undefined;
  }, []);

  useEffect(() => subscribeChildMailboxes(notifyModeLockChanged), [notifyModeLockChanged]);

  /** Immediate link update visible to tool calls before React re-renders. */
  const updateLink = useCallback((childThreadId: string, update: (link: ChildAgentLink) => ChildAgentLink) => {
    const ctx = contextRef.current;
    ctx.persistChildAgentLinks((current) => {
      const latest = current[childThreadId];
      if (!latest) {
        pendingLinksRef.current.delete(childThreadId);
        return current;
      }
      const updated = update(latest);
      pendingLinksRef.current.set(childThreadId, updated);
      if (updated !== latest) notifyChildWaiters();
      return updated === latest ? current : { ...current, [childThreadId]: updated };
    });
  }, [notifyChildWaiters]);

  const linksIncludingPending = useCallback((links: Record<string, ChildAgentLink>): Record<string, ChildAgentLink> => {
    if (!pendingLinksRef.current.size) return links;
    return { ...links, ...Object.fromEntries(pendingLinksRef.current) };
  }, []);

  /** Authority comes from this root's captured crew, never the global toggle. */
  const assertParentCollaboration = useCallback((link: ChildAgentLink, sessionId = link.sessionId): void => {
    const policy = childAgentPolicyForSession(contextRef.current.policies, sessionId);
    if (link.sessionId !== sessionId || policy?.rootThreadId !== link.rootThreadId) {
      throw new Error("This sub-agent does not belong to the requesting parent conversation.");
    }
    if (policy.collaborationV2 !== true || link.signoff !== "required") {
      throw new Error("Parent messaging and acceptance require a captured V2 crew and a V2 sub-agent. Use agent_status, collect_agent or cancel_agent for this assignment.");
    }
  }, []);

  /**
   * A user typed a turn into a managed child (pre-start admission, before any
   * provider request). The assignment reopens under a new durable result
   * revision: acceptance, user/parent stop and the previous outcome no longer
   * describe it, and earlier review tokens cannot accept it.
   */
  const noteExplicitChildStart = useCallback((threadId: string, attemptId: string): void => {
    const link = linksIncludingPending(contextRef.current.links)[threadId];
    if (!link || !attemptId) return;
    const task = useTaskStore.getState().tasks[threadId];
    const revision = (link.resultRevision ?? 0) + 1;
    explicitStartsRef.current.set(threadId, { attemptId, before: link, revision, notedAt: Date.now(), beforeCompleted: task?.lastCompletedTurnId, beforeStatus: taskStatusOf(threadId) });
    notifyModeLockChanged();
    releasedRef.current.delete(threadId);
    // A follow-up reservation left by an earlier renderer that never
    // dispatched cannot coexist with this user turn: release its exact
    // token now (a same-renderer preparation refuses on the new revision).
    const staleToken = link.activationPending && link.activationDispatched === false
      && !followUpsInFlightRef.current.has(threadId) && !pendingActivationsRef.current.has(threadId) ? link.activationId : undefined;
    if (staleToken) releaseSlot(link, staleToken);
    updateLink(threadId, (current) => {
      const { acceptedAt: _accepted, acceptedBy: _by, acceptNote: _note, stopOrigin: _stop,
        terminalStatus: _terminal, finishedAt: _finished, activationTurnId: _turn,
        activationStartRequestId: _start, ...reopened } = current;
      const cleared: Record<string, unknown> = { ...reopened };
      if (staleToken && current.activationId === staleToken) {
        delete cleared.activationPending;
        delete cleared.activationDispatched;
        delete cleared.activationPreviousTurnId;
      }
      return { ...(cleared as unknown as ChildAgentLink), resultRevision: revision, manualAttemptId: attemptId,
        ...(task?.lastCompletedTurnId ?? current.activationTurnId ? { revisionBaseTurnId: task?.lastCompletedTurnId ?? current.activationTurnId } : {}) };
    });
  }, [linksIncludingPending, notifyModeLockChanged, releaseSlot, updateLink]);

  /** The explicit attempt reached dispatch (no-op) or was refused before any provider request. */
  const settleExplicitChildStart = useCallback((threadId: string, attemptId: string, dispatched: boolean): void => {
    const noted = explicitStartsRef.current.get(threadId);
    if (!noted || noted.attemptId !== attemptId) return;
    explicitStartsRef.current.delete(threadId);
    notifyModeLockChanged();
    // Refused before any provider request: restore the pre-attempt record,
    // unless real work happened since (active now, or a newer completed
    // turn). If the refusal left a visible error/interruption on the task,
    // it stays a truthful failed attempt under its new revision instead.
    if (dispatched || noted.admitted || isChildActive(taskStatusOf(threadId))
      || useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId !== noted.beforeCompleted
      || taskStatusOf(threadId) !== noted.beforeStatus) return;
    const fields = ["acceptedAt", "acceptedBy", "acceptNote", "stopOrigin", "terminalStatus", "finishedAt",
      "activationTurnId", "resultRevision", "revisionBaseTurnId", "manualAttemptId"] as const;
    let rolledBack = false;
    updateLink(threadId, (current) => {
      // Restore only this exact attempt; anything newer keeps its own state.
      if (current.manualAttemptId !== attemptId || current.resultRevision !== noted.revision || current.activationPending) return current;
      rolledBack = true;
      const restored: Record<string, unknown> = { ...current };
      for (const field of fields) {
        if (noted.before[field] === undefined) delete restored[field];
        else restored[field] = noted.before[field];
      }
      return restored as unknown as ChildAgentLink;
    });
    // Only an exact rollback restores the released marker of the old outcome.
    if (rolledBack && noted.before.terminalStatus) releasedRef.current.add(threadId);
  }, [notifyModeLockChanged, updateLink]);

  /** Capture the exact child boundary before any asynchronous observation. */
  const childObservationGuard = useCallback((link: ChildAgentLink): (() => void) => {
    const id = link.childThreadId;
    const rendererGeneration = lifecycleRef.current.generation;
    const childGeneration = childStopGenerationRef.current.get(id) ?? 0;
    const rootGeneration = stopGenerationRef.current.get(link.rootThreadId) ?? 0;
    const task = useTaskStore.getState().tasks[id];
    const status = taskStatusOf(id);
    return () => {
      const live = linksIncludingPending(contextRef.current.links)[id];
      const currentTask = useTaskStore.getState().tasks[id];
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
        || !live || live.createdAt !== link.createdAt || live.rootThreadId !== link.rootThreadId || live.sessionId !== link.sessionId
        || live.languageSessionId !== link.languageSessionId || live.activationId !== link.activationId
        || live.activationTurnId !== link.activationTurnId || live.activationPreviousTurnId !== link.activationPreviousTurnId
        || live.activationPending !== link.activationPending || live.acceptedAt !== link.acceptedAt || live.stopOrigin !== link.stopOrigin
        || link.signoff === "required" && (live.resultRevision !== link.resultRevision || live.manualAttemptId !== link.manualAttemptId)
        || taskStatusOf(id) !== status || currentTask?.activeTurnId !== task?.activeTurnId
        || currentTask?.lastCompletedTurnId !== task?.lastCompletedTurnId
        || (childStopGenerationRef.current.get(id) ?? 0) !== childGeneration
        || (stopGenerationRef.current.get(link.rootThreadId) ?? 0) !== rootGeneration
        || contextRef.current.threadUnavailable?.(id) || contextRef.current.threadUnavailable?.(link.rootThreadId)
        || contextRef.current.threadBusy?.(id) || contextRef.current.threadBusy?.(link.rootThreadId)) {
        throw new Error("The sub-agent's conversation or current turn changed while the request was waiting. Read its current state again.");
      }
    };
  }, [linksIncludingPending]);

  /**
   * A follow-up reservation persisted by an earlier renderer that never
   * reached its provider request (activationDispatched === false) cannot be
   * running. Release exactly its token and restore the settled outcome it
   * kept, instead of leaving the child "unknown" until a user Stop closes it
   * to its parent for good. Dispatched or legacy reservations stay uncertain.
   */
  const retireUndispatchedActivation = useCallback((link: ChildAgentLink): ChildAgentLink => {
    const id = link.childThreadId;
    const token = link.activationId;
    if (!token || !link.activationPending || link.activationDispatched !== false
      || followUpsInFlightRef.current.has(id) || pendingActivationsRef.current.has(id)) return link;
    releaseSlot(link, token);
    // The marker proves the parent follow-up never dispatched, not that no
    // user-typed work started meanwhile. Live work keeps its own (open)
    // outcome under a new revision; the old terminal record is never revived.
    const liveWork = isChildActive(taskStatusOf(id));
    updateLink(id, (current) => {
      if (current.activationId !== token || !current.activationPending || current.activationDispatched !== false) return current;
      const { activationPending: _pending, activationPreviousTurnId: _previous, activationDispatched: _dispatched, ...settled } = current;
      if (!liveWork) return settled;
      const { terminalStatus: _terminal, finishedAt: _finished, activationTurnId: _turn, acceptedAt: _accepted,
        acceptedBy: _by, acceptNote: _note, ...reopened } = settled;
      return { ...reopened, resultRevision: (current.resultRevision ?? 0) + 1,
        ...(current.activationPreviousTurnId ? { revisionBaseTurnId: current.activationPreviousTurnId } : {}) };
    });
    void auditEvent("childAgent.followUpRetired", { childThreadId: id, reason: "undispatched-after-reload" }, link.rootThreadId);
    return linksIncludingPending(contextRef.current.links)[id] ?? link;
  }, [linksIncludingPending, releaseSlot, updateLink]);

  const recoverCurrentChild = useCallback(async (observed: ChildAgentLink): Promise<"running" | "unknown" | null> => {
    // A start this renderer is still preparing is not unconfirmed work yet.
    if (followUpsInFlightRef.current.has(observed.childThreadId) || initialStartPending(observed)) return null;
    const link = retireUndispatchedActivation(observed);
    const assertCurrent = childObservationGuard(link);
    const recovering = recoveringChildrenRef.current;
    recovering.set(link.childThreadId, (recovering.get(link.childThreadId) ?? 0) + 1);
    try {
      return await recoverChildStatus(link, assertCurrent);
    } finally {
      const remaining = (recovering.get(link.childThreadId) ?? 1) - 1;
      if (remaining > 0) recovering.set(link.childThreadId, remaining);
      else recovering.delete(link.childThreadId);
    }
  }, [childObservationGuard, initialStartPending, retireUndispatchedActivation]);

  const managedCutoffGuard = useCallback((link: ChildAgentLink): (() => void) => {
    const runGeneration = childRunGenerationRef.current.get(link.childThreadId) ?? 0;
    const rendererGeneration = lifecycleRef.current.generation;
    return () => {
      const current = linksIncludingPending(contextRef.current.links)[link.childThreadId];
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
        || !current || current.createdAt !== link.createdAt || current.rootThreadId !== link.rootThreadId
        || current.sessionId !== link.sessionId || current.activationId !== link.activationId
        || (childRunGenerationRef.current.get(link.childThreadId) ?? 0) !== runGeneration) {
        throw new Error("The sub-agent started different work while Stop was settling. Its current activation was preserved.");
      }
    };
  }, [linksIncludingPending]);

  /** A confirmed hard cutoff releases its own slot even without a turn ID. */
  const settleManagedCutoff = useCallback((link: ChildAgentLink, status: TaskStatus) => {
    const current = linksIncludingPending(contextRef.current.links)[link.childThreadId];
    if (!current || current.createdAt !== link.createdAt || current.rootThreadId !== link.rootThreadId
      || current.sessionId !== link.sessionId || current.activationId !== link.activationId
      || link.activationTurnId && current.activationTurnId !== link.activationTurnId || current.activationPreviousTurnId !== link.activationPreviousTurnId) {
      throw new Error("The sub-agent started different work while Stop was settling. Its current slot was preserved.");
    }
    const id = link.childThreadId;
    pendingActivationsRef.current.delete(id);
    releasedRef.current.add(id);
    const terminalStatus = status === "interrupted" ? "cancelled" : status === "error" ? "failed" : "completed";
    updateLink(id, (latest) => ({ ...latest, activationPending: false, terminalStatus, finishedAt: latest.finishedAt ?? Date.now() }));
    releaseSlot(current);
    // A confirmed hard cutoff also ends any older unconfirmed request.
    const superseded = supersededUncertainRef.current.get(id);
    if (superseded && superseded !== current.activationId) releaseSlot(current, superseded);
    supersededUncertainRef.current.delete(id);
    settleStoppedChild(current.rootThreadId, id, current.title, status);
  }, [linksIncludingPending, releaseSlot, updateLink]);

  const invalidateChildAgentGuidance = useCallback((threadId: string, reason: string): void => {
    stopGenerationRef.current.set(threadId, (stopGenerationRef.current.get(threadId) ?? 0) + 1);
    const links = linksIncludingPending(contextRef.current.links);
    for (const link of Object.values(links)) {
      if (link.childThreadId !== threadId && link.rootThreadId !== threadId) continue;
      const id = link.childThreadId;
      childStopGenerationRef.current.set(id, (childStopGenerationRef.current.get(id) ?? 0) + 1);
      // In-flight entries remain protected history until the provider proves
      // acceptance/refusal; Stop invalidates their preparation via generation.
      cancelQueuedForChild(id, reason);
    }
    notifyChildWaiters();
  }, [linksIncludingPending, notifyChildWaiters]);

  const persistNativeSettlement = useCallback((expected: NativeAgentLink | undefined, status: TaskStatus) => {
    if (!expected) return;
    contextRef.current.persistNativeAgentLinks?.((current) => {
      const latest = current[expected.childThreadId];
      if (!latest || latest.rootThreadId !== expected.rootThreadId || latest.rootTurnId !== expected.rootTurnId || latest.createdAt !== expected.createdAt
        || latest.activationId !== expected.activationId || latest.status !== expected.status) return current;
      return {
        ...current,
        [expected.childThreadId]: { ...latest, status, finishedAt: isActiveAgentRecord(expected.status ?? "unknown") ? latest.finishedAt ?? Date.now() : Date.now() },
      };
    });
  }, []);

  /** Live child count for a session, counting spawns still settling. */
  const reservedChildCount = useCallback((
    sessionId: string,
    rootThreadId: string,
    links: Record<string, ChildAgentLink>,
  ): number => {
    const pending = pendingChildrenRef.current.get(sessionId);
    if (pending) {
      for (const childThreadId of [...pending]) {
        if (!childThreadId.startsWith("pending-")
          && (links[childThreadId] || !isChildActive(taskStatusOf(childThreadId)))) pending.delete(childThreadId);
      }
      if (!pending.size) pendingChildrenRef.current.delete(sessionId);
    }
    const crossProviderIds = new Set([
      ...Object.values(links).filter((link) => link.sessionId === sessionId).map((link) => link.childThreadId),
      ...(pending ?? []),
    ]);
    // The budget counts children, never the root. A runtime that reported the
    // root as one of its own agents would otherwise burn a slot the user's
    // limit was meant to give to real delegated work.
    const nativeActive = (useTaskStore.getState().tasks[rootThreadId]?.agents ?? []).filter((agent) => (
      agent.id !== rootThreadId && !crossProviderIds.has(agent.id) && isActiveAgentRecord(agent.status)
    )).length;
    // A dispatched follow-up is already counted by its child's active status;
    // its reservation must not take a second slot until its start settles.
    const activeIds = activeChildThreadIds(sessionId, links);
    const pendingCount = [...(pending ?? [])].filter((id) => !(id.startsWith(FOLLOW_UP_RESERVATION)
      && activeIds.includes(id.slice(FOLLOW_UP_RESERVATION.length)))).length;
    return activeIds.length + pendingCount + nativeActive;
  }, []);

  const spawnChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const currentLinks = linksIncludingPending(ctx.links);
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy) throw new Error("This thread is not allowed to start sub-agents.");
    const rootThreadId = policy.rootThreadId;
    if (!rootThreadId) throw new Error("This thread has not finished starting yet.");
    // Depth one. A thread that is itself a child never receives a bridge, so
    // this only fires if a stale bridge process outlived its root thread.
    if (currentLinks[rootThreadId]) throw new Error("A sub-agent cannot start further sub-agents.");
    // A spawn emitted by a run the user stopped can reach the app while that
    // run's cutoff settles. It belongs to the stopped run, not new work.
    if (policy.collaborationV2 === true && rootRunStopped(rootThreadId, request.registrationId)) throw new Error("The user stopped this run, so no sub-agent was started.");

    const targetId = String(request.arguments.target ?? "");
    const target = policy.targets.find((entry) => entry.id === targetId);
    if (!target || !target.enabled) {
      throw new Error(`\`${targetId}\` is not an approved destination for this thread.`);
    }
    const compactionError = childAgentAutoCompactIssue(target);
    if (compactionError) throw new Error(compactionError);
    const prompt = String(request.arguments.prompt ?? "").trim();
    if (!prompt) throw new Error("`prompt` is required.");
    const title = decodeHtmlEntities(String(request.arguments.title ?? "").trim() || prompt.slice(0, 80));
    const reasoningEffort = childAgentReasoningEffort(
      target,
      policy.reasoningEffort,
      request.arguments.reasoningEffort,
    );
    const targetSystemPrompt = policy.providerSystemPrompts?.[target.provider];
    const policyChanged = () => {
      const current = childAgentPolicyForSession(contextRef.current.policies, request.sessionId);
      return !current || current.rootThreadId !== rootThreadId || !current.targets.length
        || current.permission !== policy.permission || current.systemPrompt !== policy.systemPrompt
        || current.collaborationV2 !== policy.collaborationV2
        || JSON.stringify(current.providerSystemPrompts) !== JSON.stringify(policy.providerSystemPrompts)
        || current.projectInstructionsEnabled !== policy.projectInstructionsEnabled
        || current.projectClaudeInstructionsEnabled !== policy.projectClaudeInstructionsEnabled
        || current.serviceTier !== policy.serviceTier || current.reasoningEffort !== policy.reasoningEffort
        || JSON.stringify(current.targets) !== JSON.stringify(policy.targets);
    };

    const reservation = `pending-${crypto.randomUUID()}`;
    const stopGeneration = stopGenerationRef.current.get(rootThreadId) ?? 0;
    const rendererGeneration = lifecycleRef.current.generation;
    const active = reservedChildCount(policy.sessionId, rootThreadId, currentLinks);
    if (active >= policy.maxConcurrent) {
      throw new Error(
        `This thread already has ${active} sub-agent${active === 1 ? "" : "s"} running, which is its configured maximum.`,
      );
    }

    const logicalPath = ctx.projectPathForThread(rootThreadId);
    if (!logicalPath) throw new Error("Mythra Code no longer knows which project folder this thread belongs to.");
    const executionPath = ctx.executionPathFor(rootThreadId, logicalPath);
    const gitDir = ctx.isolationGitDirFor(rootThreadId);
    const projectId = ctx.projectIdForThread?.(rootThreadId) ?? null;
    const executionTargetChanged = () => {
      const live = contextRef.current;
      return live.projectPathForThread(rootThreadId) !== logicalPath
        || live.executionPathFor(rootThreadId, logicalPath) !== executionPath
        || live.isolationGitDirFor(rootThreadId) !== gitDir
        || live.executionTargetUnavailable?.(rootThreadId) === true
        || (live.projectIdForThread?.(rootThreadId) ?? null) !== projectId;
    };

    const pending = pendingChildrenRef.current.get(policy.sessionId) ?? new Set<string>();
    pending.add(reservation);
    pendingChildrenRef.current.set(policy.sessionId, pending);
    const inFlight = inFlightStartsRef.current;
    inFlight.set(rootThreadId, (inFlight.get(rootThreadId) ?? 0) + 1);
    notifyModeLockChanged();
    let startSettled = false;
    const settleStart = () => {
      if (startSettled) return;
      startSettled = true;
      const remaining = (inFlight.get(rootThreadId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(rootThreadId, remaining);
      else inFlight.delete(rootThreadId);
      notifyModeLockChanged();
    };
    let result;
    let startUncertain = false;
    let provisionalChild: string | undefined;
    let childStartGeneration = 0;
    let publishedRunGeneration: number | undefined;
    let publishedLink: ChildAgentLink | undefined;
    const initialMessageId = `local-${crypto.randomUUID()}`;
    const canDiscardUnusedChild = (childId: string) => {
      const current = linksIncludingPending(contextRef.current.links)[childId];
      const task = useTaskStore.getState().tasks[childId];
      return Boolean(lifecycleRef.current.mounted && lifecycleRef.current.generation === rendererGeneration
        && publishedLink && current && current.createdAt === publishedLink.createdAt
        && current.rootThreadId === rootThreadId && current.sessionId === policy.sessionId
        && current.spawnRequestId === request.requestId && !current.activationId && !current.acceptedAt
        && (childRunGenerationRef.current.get(childId) ?? 0) === publishedRunGeneration
        && !task?.activeTurnId && !task?.lastCompletedTurnId);
    };
    try {
      result = await startChildAgentTurn(target, prompt, {
        policy,
        executionPath,
        additionalWorkspaceRoots: gitDir ? [gitDir] : [],
        systemPrompt: targetSystemPrompt ?? policy.systemPrompt,
        projectId,
        projectInstructionsEnabled: policy.projectInstructionsEnabled,
        projectClaudeInstructionsEnabled: policy.projectClaudeInstructionsEnabled === true,
        reasoningEffort,
        serviceTier: policy.serviceTier,
        serviceName: ctx.serviceNameFor(rootThreadId),
        modelContextWindow: target.provider === "openrouter"
          ? ctx.openRouterModels.find((entry) => entry.id === childAgentModel(target))?.context_length
          : target.provider === "lmstudio"
            ? ctx.lmStudioModels?.find((entry) => entry.id === childAgentModel(target))?.maxContextLength
            : undefined,
        lmStudioBaseUrl: ctx.lmStudioBaseUrl,
        initialMessageId,
        resolveSkillPrompt: ctx.resolveSkillPrompt,
        resolveSkillPrompts: ctx.resolveSkillPrompts,
        isStartCancelled: () => !lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
          || (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration
          || policy.collaborationV2 === true && rootRunStopped(rootThreadId, request.registrationId)
          || provisionalChild !== undefined && ((childStopGenerationRef.current.get(provisionalChild) ?? 0) !== childStartGeneration
            || linksIncludingPending(contextRef.current.links)[provisionalChild]?.stopOrigin !== undefined
            || contextRef.current.threadUnavailable?.(provisionalChild) === true
            || contextRef.current.threadBusy?.(provisionalChild) === true)
          || policyChanged()
          || contextRef.current.threadUnavailable?.(rootThreadId) === true
          || contextRef.current.threadBusy?.(rootThreadId) === true
          || executionTargetChanged(),
        validateDispatch: async () => {
          if (!await isChildAgentRequestActive(request)) throw new Error("This sub-agent request belongs to a retired bridge registration.");
        },
        claimDispatch: async (childThreadId) => {
          await claimChildAgentSpawn(request, childThreadId);
        },
        prepareNewThreadGit: projectId ? (childThreadId) => ctx.prepareNewThreadGit?.(childThreadId, projectId, logicalPath) ?? Promise.resolve(false) : undefined,
        canDiscardUnusedChild,
        onDiscardUnusedChild: (childThreadId) => contextRef.current.onDiscardUnusedChild?.(childThreadId),
        beginCheckpoint: async (childThreadId) => {
          return ctx.beginRunCheckpoint(childThreadId, executionPath, prompt, target.provider, childAgentModel(target));
        },
        discardCheckpoint: ctx.discardRunCheckpoint,
        // The child's first tool call can be a parent message that lands
        // before its ownership link exists.
        onChildIdentified: (thread, languageSessionId, provenance, startRequestId) => {
          const childThreadId = thread.id;
          provisionalChild = childThreadId;
          childStartGeneration = childStopGenerationRef.current.get(childThreadId) ?? 0;
          spawnGenerationsRef.current.set(childThreadId, stopGeneration);
          provisionalOwnersRef.current.set(childThreadId, { rootThreadId, sessionId: policy.sessionId });
          const provisional: ChildAgentLink = {
            childThreadId, languageSessionId, spawnRequestId: request.requestId,
            rootThreadId, sessionId: policy.sessionId, targetId: target.id,
            provider: target.provider, model: childAgentModel(target), reasoningEffort, title,
            createdAt: Date.now(), ...(policy.collaborationV2 === true ? { signoff: "required" as const } : {}), activationPending: true,
            executionPath, executionProjectId: projectId, executionAdditionalWorkspaceRoots: gitDir ? [gitDir] : [],
            ...(target.autoCompactTokens !== undefined ? { autoCompactTokens: target.autoCompactTokens } : {}),
            ...(startRequestId ? { activationStartRequestId: startRequestId } : {}),
          };
          publishedLink = provisional;
          if (policy.collaborationV2 === true) initialStartsRef.current.set(childThreadId, provisional);
          managedLocalTranscriptProofs.set(childThreadId, { createdAt: provisional.createdAt, fresh: true });
          pendingLinksRef.current.set(childThreadId, provisional);
          ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: provisional }));
          ctx.bindThreadToProject(childThreadId, logicalPath);
          ctx.rememberThread(thread);
          ctx.setThreads((current) => upsertThread(current, thread));
          pending.delete(reservation);
          pending.add(childThreadId);
          useTaskStore.getState().ensureTask(childThreadId, executionPath);
          useTaskStore.getState().setTaskStatus(childThreadId, "starting");
          publishedRunGeneration = childRunGenerationRef.current.get(childThreadId) ?? 0;
          useTaskStore.getState().appendUserMessage(childThreadId, { id: initialMessageId, role: "user", text: prompt, ...provenance });
          if (target.provider === "claude") ctx.scheduleClaudeThreadSave(childThreadId);
          if (target.provider === "cursor") ctx.scheduleCursorThreadSave(childThreadId);
        },
      });
    } catch (reason) {
      if (reason instanceof ChildAgentStartUncertainError) {
        // The provider request may have reached a real child. Retain its
        // ownership, bridge, checkpoint and slot until a terminal event/cutoff.
        result = reason.child;
        startUncertain = true;
        if (!result.superseded) pendingActivationsRef.current.set(result.thread.id, { uncertain: true });
      } else {
        if (provisionalChild) {
          const abandonedId = provisionalChild;
          pending.delete(abandonedId);
          provisionalOwnersRef.current.delete(abandonedId);
          // Claiming may already have adopted a named initial slot. An error
          // response alone cannot prove that slot is finished to the backend.
          // No model request was dispatched on this path. Release only while
          // this unused activation is still ours; manual newer work can take
          // over the initial slot, and follow-up tokens are protected in Rust.
          if (canDiscardUnusedChild(abandonedId)) {
            try {
              await reportChildAgentFinished(policy.sessionId, abandonedId);
            } catch {
              if (publishedLink) releaseSlot(publishedLink, undefined);
              settleStart();
              throw new Error(`The initial sub-agent did not start, but its reserved slot could not be released. Its ownership was retained: ${friendlyError(reason)}`);
            }
          }
          // Stop followed by a manual child turn can supersede us during the
          // claim/release waits. Keep that conversation and its latest state.
          if (canDiscardUnusedChild(abandonedId)) {
            contextRef.current.onDiscardUnusedChild?.(abandonedId);
            pendingLinksRef.current.delete(abandonedId);
            ctx.persistChildAgentLinks((current) => {
              if (current[abandonedId]?.spawnRequestId !== request.requestId
                || current[abandonedId]?.createdAt !== publishedLink?.createdAt) return current;
              const next = { ...current };
              delete next[abandonedId];
              return next;
            });
            ctx.setThreads((current) => current.filter((thread) => thread.id !== abandonedId));
            useTaskStore.getState().removeTask(abandonedId);
            managedLocalTranscriptProofs.delete(abandonedId);
          } else {
            const retained = linksIncludingPending(contextRef.current.links)[abandonedId];
            updateLink(abandonedId, (current) => {
              if (current.spawnRequestId !== request.requestId) return current;
              const { spawnRequestId: _request, ...newer } = current;
              return newer;
            });
            settleStart();
            return { childId: abandonedId,
              status: retained ? childLifecycleForLink(retained, taskStatusOf(abandonedId)) : "unknown",
              note: "The initial preparation was superseded while cleanup was settling. This owned child's current conversation and slot were preserved." };
          }
        }
        settleStart();
        throw reason;
      }
    } finally {
      pending.delete(reservation);
      if (provisionalChild && initialStartsRef.current.get(provisionalChild) === publishedLink) initialStartsRef.current.delete(provisionalChild);
    }
    if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) {
      settleStart();
      return { childId: result.thread.id, status: "unknown", note: "The child is durably owned; the current renderer recovers its provider status." };
    }
    // Hold the slot under the real child id until the rendered link map has it.
    pending.add(result.thread.id);
    pendingChildrenRef.current.set(policy.sessionId, pending);

    const childThreadId = result.thread.id;
    const stoppedWhileStarting = (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration
      || (childStopGenerationRef.current.get(childThreadId) ?? 0) !== childStartGeneration;
    const priorLink = linksIncludingPending(contextRef.current.links)[childThreadId];
    const priorTask = useTaskStore.getState().tasks[childThreadId];
    if (result.superseded || priorLink && (priorLink.activationId || !priorLink.activationPending && (
      startUncertain || isChildActive(taskStatusOf(childThreadId)) && (priorTask?.activeTurnId !== result.turnId || stoppedWhileStarting && !priorLink.stopOrigin)
      || result.turnId && priorTask?.lastCompletedTurnId && priorTask.lastCompletedTurnId !== result.turnId))) {
      if (pendingActivationsRef.current.get(childThreadId)?.activationId === undefined) pendingActivationsRef.current.delete(childThreadId);
      settleStart();
      return { childId: childThreadId, status: priorLink ? childLifecycleForLink(priorLink, taskStatusOf(childThreadId)) : childLifecycle(taskStatusOf(childThreadId)),
        note: "The initial start was superseded by newer work in this child conversation; its current turn was preserved." };
    }
    // The root was deleted while the provider was starting: its frozen policy
    // (and the live session cache) are gone. The child is still recorded and
    // cut off below, exactly like a Stop, so it can never run unowned.
    const rootForgotten = !childAgentPolicyForSession(contextRef.current.policies, request.sessionId);
    const targetChangedWhileStarting = executionTargetChanged();
    ctx.bindThreadToProject(childThreadId, logicalPath);
    ctx.rememberThread(result.thread);
    ctx.setThreads((current) => upsertThread(current, result.thread));
    ctx.persistThreadModel(childThreadId, result.model);
    ctx.persistThreadReasoning(childThreadId, { reasoningEffort, ultra: false });
    ctx.persistThreadAutoCompactTokens?.(childThreadId, target.autoCompactTokens);
    if (result.cursorSessionId && !result.superseded && (!result.stopped || (result.turnId && cursorTurnCanSettle(childThreadId, result.turnId)))) ctx.cursorSessionIdsRef.current[childThreadId] = result.cursorSessionId;

    const taskStore = useTaskStore.getState();
    const provisionalLink = linksIncludingPending(contextRef.current.links)[childThreadId];
    taskStore.ensureTask(childThreadId, executionPath);
    taskStore.appendUserMessage(childThreadId, { id: initialMessageId, role: "user", text: prompt, turnId: result.turnId, skillReferences: result.skillReferences, skillsFolder: result.skillsFolder, skillDependencies: result.skillDependencies });
    if (result.turnId) taskStore.bindUserMessageTurn(childThreadId, initialMessageId, result.turnId);
    const completedBeforeStartReturned = Boolean(
      result.turnId && taskStore.tasks[childThreadId]?.lastCompletedTurnId === result.turnId
      || startUncertain && confirmedLocalTerminal(childThreadId) && taskStore.tasks[childThreadId]?.lastCompletedTurnId,
    );
    if (result.turnId && !completedBeforeStartReturned && !result.superseded && !result.stopped) taskStore.setActiveTurn(childThreadId, result.turnId);
    if (!completedBeforeStartReturned && !result.superseded && !result.stopped) {
      taskStore.setTaskStatus(childThreadId, startUncertain ? "starting" : "running",
        startUncertain ? "The provider request failed after dispatch. The child may be working; its slot remains reserved until a confirmed finish or Stop." : undefined);
    }
    const lifecycle = childLifecycle(taskStatusOf(childThreadId));
    taskStore.upsertAgent(rootThreadId, {
      id: childThreadId,
      prompt: title,
      status: isChildActive(taskStatusOf(childThreadId)) ? "inProgress" : lifecycle,
      path: `${target.provider} · ${childAgentModel(target) || "default"}`,
    });
    taskStore.upsertActivity(rootThreadId, {
      id: `child-agent-${childThreadId}`,
      kind: "agent",
      title: `Spawned ${target.label || target.id} sub-agent`,
      detail: `${target.provider} · ${childAgentModel(target) || "provider default"}\n${title}`,
      status: isChildActive(taskStatusOf(childThreadId)) ? "inProgress" : lifecycle,
      agent: {
        action: "spawn",
        provider: target.provider,
        model: childAgentModel(target),
        task: title,
        count: 1,
        threadIds: [childThreadId],
      },
    });
    if (result.provider === "claude") ctx.scheduleClaudeThreadSave(childThreadId);
    if (result.provider === "cursor") ctx.scheduleCursorThreadSave(childThreadId);

    const link: ChildAgentLink = {
      ...provisionalLink,
      ...(result.languageSessionId ? { languageSessionId: result.languageSessionId } : {}),
      childThreadId,
      rootThreadId,
      sessionId: policy.sessionId,
      targetId: target.id,
      provider: target.provider,
      model: childAgentModel(target),
      reasoningEffort,
      title,
      createdAt: provisionalLink?.createdAt ?? Date.now(),
      spawnRequestId: request.requestId,
      executionPath,
      executionProjectId: projectId,
      executionAdditionalWorkspaceRoots: gitDir ? [gitDir] : [],
      // V2 assignments retain their review contract in their durable link.
      ...(policy.collaborationV2 === true ? { signoff: "required" as const } : {}),
      ...(provisionalLink?.stopOrigin ? { stopOrigin: provisionalLink.stopOrigin } : {}),
      ...(result.turnId ? { activationTurnId: result.turnId } : {}),
      activationPending: startUncertain && !completedBeforeStartReturned,
      ...(target.autoCompactTokens !== undefined ? { autoCompactTokens: target.autoCompactTokens } : {}),
      ...(result.startRequestId ? { activationStartRequestId: result.startRequestId } : {}),
      ...(!isChildActive(taskStatusOf(childThreadId))
        ? { terminalStatus: lifecycle as "completed" | "cancelled" | "failed", finishedAt: Date.now() }
        : {}),
    };
    releasedRef.current.delete(childThreadId);
    pendingLinksRef.current.set(childThreadId, link);
    ctx.persistChildAgentLinks((current) => ({ ...current, [childThreadId]: link }));
    provisionalOwnersRef.current.delete(childThreadId);
    // The durable ownership record now exists, so archive and delete can see
    // this child through the link map from here on.
    settleStart();
    void auditEvent("childAgent.spawned", {
      target: target.id,
      provider: target.provider,
      model: link.model,
      reasoningEffort,
      childThreadId,
    }, rootThreadId);

    // Stop landed while the provider was still starting this child. Install
    // the ownership record before the cutoff so a provider failure can never
    // leave invisible work editing the project. Only claim success after the
    // provider confirms the hard cutoff; otherwise the still-live child stays
    // in the roster for the user to see and retry stopping.
    let cutoffNote: string | undefined;
    if (stoppedWhileStarting || rootForgotten || targetChangedWhileStarting) {
      updateLink(childThreadId, (current) => ({ ...current, stopOrigin: "user" }));
      try {
        if (isChildActive(taskStatusOf(childThreadId))) {
          const current = linksIncludingPending(contextRef.current.links)[childThreadId] ?? link;
          const status = await hardStopChild(target.provider, childThreadId, result.turnId, ctx, current, managedCutoffGuard(current));
          const cutoffLink = linksIncludingPending(contextRef.current.links)[childThreadId];
          if (cutoffLink) settleManagedCutoff(cutoffLink, status);
        }
      } catch (reason) {
        cutoffNote = `Stop could not confirm the ${target.label || target.id} sub-agent cutoff: ${friendlyError(reason)}. The owned child remains visible with its slot reserved; stop it again.`;
      }
      cutoffNote ??= rootForgotten
        ? "The parent was removed while the child was starting; the child was stopped."
        : targetChangedWhileStarting ? "The execution folder changed while the child was starting; the child was stopped."
        : "The user stopped this run while the child was starting; the child was stopped.";
    }

    return {
      childId: childThreadId,
      target: target.id,
      provider: target.provider,
      model: link.model,
      reasoningEffort,
      status: cutoffNote ? isChildActive(taskStatusOf(childThreadId)) ? "unknown" : childLifecycle(taskStatusOf(childThreadId)) : startUncertain ? "unknown" : lifecycle,
      ...(startUncertain ? { note: "The provider did not confirm startup. The owned child may still be working and remains visible with its slot reserved. Collect it or Stop it; do not spawn a duplicate based on this uncertainty." } : {}),
      ...(!startUncertain ? { note: "The child runs in this thread's workspace under the same permission policy. Use collect_agent to read its result." } : {}),
      ...(cutoffNote ? { note: cutoffNote } : {}),
    };
  }, [linksIncludingPending, managedCutoffGuard, notifyModeLockChanged, releaseSlot, reservedChildCount, rootRunStopped, settleManagedCutoff, updateLink]);

  /** Follow-up guidance for this child is queued or starting, not yet delivered. */
  const followUpPending = useCallback((childThreadId: string): boolean => (
    followUpsInFlightRef.current.has(childThreadId)
    || Boolean(getChildMailbox(childThreadId)?.messages.some((message) => message.direction === "toChild"
      && (message.state === "queued" || message.state === "delivering")))
  ), []);

  /**
   * Whether Stop must ask the provider for a cutoff. An unconfirmed activation
   * (for example after a renderer reload) may be running with idle local
   * status; skipping its cutoff would also leave its slot and pending
   * activation wedged, because only terminal evidence or Stop clears them.
   */
  const childNeedsCutoff = useCallback((link: ChildAgentLink): boolean => {
    const id = link.childThreadId;
    return isChildActive(taskStatusOf(id)) || (!followUpsInFlightRef.current.has(id)
      && (childLifecycleForLink(link, taskStatusOf(id)) === "unknown" || Boolean(pendingActivationsRef.current.get(id)?.uncertain)
        || supersededUncertainRef.current.has(id)));
  }, []);

  /**
   * Model-facing summary of one child, including its review phase. Pure: it
   * repeats unresolved undelivered guidance on every read (until later
   * guidance is delivered or the work is accepted), so a lost response can
   * never hide that a collected result lacks a correction.
   */
  const describeChild = useCallback((link: ChildAgentLink, focused = false, guidanceOffset = 0): Record<string, unknown> => {
    const childId = link.childThreadId;
    const taskStatus = taskStatusOf(childId);
    const uncertain = pendingActivationsRef.current.get(childId)?.uncertain
      || link.activationPending && !followUpsInFlightRef.current.has(childId) && !initialStartPending(link);
    const status = uncertain ? "unknown" : childLifecycleForLink(link, taskStatus);
    const phase = uncertain ? "unknown" : childReviewPhase(link, taskStatus);
    const error = useTaskStore.getState().tasks[childId]?.error;
    const summary = summarizeChildMailbox(getChildMailbox(childId));
    const waiting = !isChildActive(taskStatus) && followUpPending(childId);
    const waitReason = followUpWaitReasonRef.current.get(childId);
    const releaseFailure = [...releaseFailuresRef.current].find(([key]) => key.startsWith(`${childId}\u0000`))?.[1];
    const outcomes = link.acceptedAt ? { messages: [], remaining: 0, ids: [] as string[], trimmed: false, total: 0, nextOffset: undefined }
      : unresolvedGuidanceOutcomes(childId, focused ? MAX_QUEUED_FOR_CHILD : MAX_MESSAGES_PER_CHILD_RESPONSE, focused ? guidanceOffset : 0);
    return {
      childId,
      target: link.targetId,
      provider: link.provider,
      model: link.model,
      reasoningEffort: link.reasoningEffort,
      title: link.title,
      status,
      phase,
      ...(link.signoff === "required" && !link.acceptedAt ? { awaitsSignoff: true } : {}),
      ...(link.followUps ? { followUps: link.followUps } : {}),
      ...(link.acceptedAt ? { acceptedBy: link.acceptedBy ?? "parent", ...(link.acceptNote ? { acceptNote: link.acceptNote } : {}) } : {}),
      ...(summary.queuedForChild ? { undeliveredMessagesToChild: summary.queuedForChild } : {}),
      ...(summary.unansweredQuestions ? { unansweredQuestions: summary.unansweredQuestions, needsResponse: true } : {}),
      ...(uncertain ? { note: "The provider did not confirm this activation. It may still be working; its slot remains reserved until confirmed terminal evidence or Stop." } : {}),
      ...(waiting ? { followUpPending: true, ...(waitReason ? { followUpWaiting: waitReason } : {}) } : {}),
      ...(releaseFailure ? { slotReleasePending: `Mythra Code could not yet release this child's concurrency slot (${releaseFailure}); it keeps retrying, and the slot may count against the limit until it succeeds.` } : {}),
      ...(supersededUncertainRef.current.has(childId) ? { earlierFollowUpUncertain: "An earlier follow-up request was never confirmed and may still be running alongside newer work. Its slot stays reserved until the child is stopped." } : {}),
      ...(outcomes.total || outcomes.trimmed ? {
        guidanceNotDelivered: outcomes.messages.map(guidanceOutcomeForModel),
        guidanceNotDeliveredTotal: outcomes.total,
        ...(outcomes.remaining ? { guidanceNotDeliveredRemaining: outcomes.remaining, guidanceNotDeliveredIds: outcomes.ids } : {}),
        ...(outcomes.nextOffset !== undefined ? { guidanceNextOffset: outcomes.nextOffset } : {}),
        guidanceNote: outcomes.trimmed
          ? "Guidance you sent later failed or was cancelled, and its entry was trimmed from bounded history. The child's result may not reflect it; resend anything still needed."
          : "Guidance you sent failed or was cancelled. \"not_delivered\" entries never reached the child; \"uncertain\" ones may or may not have. Do not assume the child's result reflects them. They stay listed until you accept the work or a resend of the same text is delivered; the reviewToken already accounts for them. Use agent_status with childId and guidanceNextOffset as guidanceOffset to inspect later outcome pages.",
      } : {}),
      ...(error ? { error } : {}),
      ...(status === "failed" && !link.acceptedAt ? {
        retryable: true,
        recovery: link.signoff === "required"
          ? "Inspect the error. Continue this same child with send_agent_message, or spawn a replacement with a corrected self-contained prompt or another approved destination. Collect it before finishing."
          : "Inspect the error, then spawn a replacement with a corrected self-contained prompt or another approved destination. Collect it before finishing.",
      } : {}),
    };
  }, [followUpPending, initialStartPending]);

  const reportStatus = useCallback((request: ChildAgentRequest): Record<string, unknown> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const rawCursor = request.arguments.cursor;
    if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^p1:\d{1,6}$/.test(rawCursor))) {
      throw new Error("`cursor` must be the exact nextCursor value from an earlier agent_status result.");
    }
    const offset = typeof rawCursor === "string" ? Number(rawCursor.slice(3)) : 0;
    // Attention first: children needing a response or with unknown state
    // can never be hidden behind settled history.
    const rank: Record<string, number> = { unknown: 1, running: 2, awaiting_review: 3, failed: 4, cancelled: 5, accepted: 6 };
    const attention = (link: ChildAgentLink) => {
      const summary = summarizeChildMailbox(getChildMailbox(link.childThreadId));
      return summary.unansweredQuestions || summary.unreadQuestions || summary.unreadUpdates ? 0
        : rank[childReviewPhase(link, taskStatusOf(link.childThreadId))] ?? 9;
    };
    const ranked = Object.values(linksIncludingPending(ctx.links))
      .filter((link) => link.sessionId === request.sessionId && (!childId || link.childThreadId === childId))
      .map((link) => ({ link, rank: attention(link) }))
      .sort((left, right) => left.rank - right.rank || right.link.createdAt - left.link.createdAt
        || left.link.childThreadId.localeCompare(right.link.childThreadId));
    const page = ranked.slice(offset, offset + MAX_STATUS_CHILDREN);
    // Fresh unread mail gets the shared budget before repeated reminders of
    // already-read open questions, and every child's reads commit together.
    let budget = MAX_MESSAGES_PER_STATUS;
    const plans = page.map(({ link }) => {
      const summary = summarizeChildMailbox(getChildMailbox(link.childThreadId));
      const unread = summary.unreadQuestions + summary.unreadUpdates;
      const limit = Math.min(budget, MAX_MESSAGES_PER_CHILD_RESPONSE, unread);
      budget -= limit;
      return { link, summary, unread, limit };
    });
    const taken = takeUnreadForParentMany(plans.filter((plan) => plan.limit > 0)
      .map((plan) => ({ childThreadId: plan.link.childThreadId, limit: plan.limit })));
    let delivered = 0;
    const children = plans.map(({ link, summary, unread }) => {
      const entry = describeChild(link, Boolean(childId), Number(request.arguments.guidanceOffset ?? 0));
      const newlyRead = taken[link.childThreadId]?.messages ?? [];
      const reminderLimit = Math.min(budget, MAX_MESSAGES_PER_CHILD_RESPONSE - newlyRead.length);
      const reminders = reminderLimit > 0 ? unresolvedChildQuestions(link.childThreadId, reminderLimit, newlyRead) : [];
      budget -= reminders.length;
      const messages = [...newlyRead, ...reminders];
      delivered += messages.length;
      if (messages.length) entry.messages = messages.map(mailMessageForModel);
      const unreadLeft = unread - newlyRead.length;
      if (unreadLeft > 0) entry.unreadRemaining = unreadLeft;
      const shownQuestions = messages.filter((message) => message.kind === "question").length;
      if (summary.unansweredQuestions > shownQuestions) entry.unansweredRemaining = summary.unansweredQuestions - shownQuestions;
      return entry;
    });
    const rest = ranked.slice(offset + page.length);
    const omittedByPhase: Record<string, number> = {};
    for (const { link, rank: priority } of rest) {
      const phase = priority === 0 ? "needs_response" : childReviewPhase(link, taskStatusOf(link.childThreadId));
      omittedByPhase[phase] = (omittedByPhase[phase] ?? 0) + 1;
    }
    return {
      children,
      ...(rest.length ? { omittedChildren: rest.length, omittedByPhase, nextCursor: `p1:${offset + page.length}`,
        omittedNote: "More children follow. Pass nextCursor to agent_status for the next page, or childId to inspect one." } : {}),
      ...(offset ? { pageOffset: offset, pageNote: "Paging is by current attention order; children can move between pages as their state changes." } : {}),
      ...(delivered ? { messagesNote: "Unanswered questions remain available until an answer is delivered or the work is accepted. Answer with send_agent_message using replyTo; repeatedly polling is not an answer." } : {}),
    };
  }, [describeChild, linksIncludingPending]);

  /**
   * Other children of the same parent session whose questions still need a
   * response. With `known` (message keys present when a collection began),
   * only new unread questions count, so a collection wakes at most once per
   * new question instead of spinning. IDs, not clocks, decide novelty.
   */
  const siblingsNeedingResponse = useCallback((link: ChildAgentLink, known?: ReadonlySet<string>): Array<Record<string, unknown>> => {
    const siblings: Array<Record<string, unknown>> = [];
    for (const sibling of Object.values(linksIncludingPending(contextRef.current.links))) {
      if (sibling.sessionId !== link.sessionId || sibling.childThreadId === link.childThreadId) continue;
      const open = (getChildMailbox(sibling.childThreadId)?.messages ?? []).filter((message) => message.direction === "toParent"
        && message.kind === "question" && !message.answeredAt && !message.closedAt
        && (known === undefined || message.state === "unread" && !known.has(`${sibling.childThreadId}\u0000${message.id}`))).length;
      if (open) siblings.push({ childId: sibling.childThreadId, title: sibling.title, unansweredQuestions: open });
      if (siblings.length >= MAX_MESSAGES_PER_STATUS) break;
    }
    return siblings;
  }, [linksIncludingPending]);

  const collectChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(ctx.links)[childId];
    if (!link || link.sessionId !== request.sessionId) {
      throw new Error(`\`${childId}\` was not started from this thread.`);
    }
    const rendererGeneration = lifecycleRef.current.generation;
    const childGeneration = childStopGenerationRef.current.get(childId) ?? 0;
    const rootGeneration = stopGenerationRef.current.get(link.rootThreadId) ?? 0;
    const assertCollectionCurrent = () => {
      if (link.signoff !== "required") return;
      const current = linksIncludingPending(contextRef.current.links)[childId];
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
        || !current || current.createdAt !== link.createdAt || current.sessionId !== link.sessionId
        || current.rootThreadId !== link.rootThreadId
        || current.manualAttemptId !== undefined && current.manualAttemptId !== link.manualAttemptId
        || current.acceptedAt !== link.acceptedAt
        || (childStopGenerationRef.current.get(childId) ?? 0) !== childGeneration
        || (stopGenerationRef.current.get(link.rootThreadId) ?? 0) !== rootGeneration
        || contextRef.current.threadUnavailable?.(childId) || contextRef.current.threadUnavailable?.(link.rootThreadId)) {
        throw new Error("This collection was superseded by Stop or a changed conversation. Collect the current child again.");
      }
    };
    const recovery = await recoverCurrentChild(link);
    if (!await isChildAgentRequestActive(request)) throw new Error("This collection belongs to a retired bridge registration.");
    assertCollectionCurrent();
    if (recovery) {
      const unread = takeUnreadForParent(childId, MAX_MESSAGES_PER_CHILD_RESPONSE);
      const messages = [...unread.messages, ...unresolvedChildQuestions(childId, MAX_MESSAGES_PER_CHILD_RESPONSE - unread.messages.length, unread.messages)];
      return {
        ...describeChild(linksIncludingPending(contextRef.current.links)[childId] ?? link, true),
        childId, status: recovery, phase: recovery, result: "",
        ...(messages.length ? { messages: messages.map(mailMessageForModel) } : {}),
        ...(unread.remaining ? { unreadRemaining: unread.remaining } : {}),
        note: messages.some((message) => message.kind === "question")
          ? "The child needs a response to its unanswered question. Answer with send_agent_message using replyTo; repeatedly collecting is not an answer."
          : recovery === "running" ? "The runtime confirms this child is still working. Collect again to wait for its result."
            : "The runtime cannot confirm this child's current activation. Its slot remains reserved; collect later or Stop it.",
      };
    }
    const requested = Number(request.arguments.timeoutSeconds);
    const seconds = Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_COLLECT_SECONDS, requested)
      : DEFAULT_COLLECT_SECONDS;
    const deadline = Date.now() + seconds * 1000;
    const knownSiblingQuestions = new Set(Object.values(linksIncludingPending(contextRef.current.links))
      .filter((sibling) => sibling.sessionId === link.sessionId && sibling.childThreadId !== childId)
      .flatMap((sibling) => (getChildMailbox(sibling.childThreadId)?.messages ?? [])
        .filter((message) => message.direction === "toParent" && message.kind === "question")
        .map((message) => `${sibling.childThreadId}\u0000${message.id}`)));
    const waitId = `child-wait-${request.requestId}`;
    let waiting = false;
    let settledMessages: ChildMailMessage[] = [];
    let settledUnreadRemaining = 0;
    try {
      for (;;) {
        assertCollectionCurrent();
        // A child's question ends the wait at once: the parent must be able
        // to answer while the child is still working, or both would stall.
        const unread = takeUnreadForParent(childId, MAX_MESSAGES_PER_CHILD_RESPONSE);
        const messages = [...unread.messages, ...unresolvedChildQuestions(childId, MAX_MESSAGES_PER_CHILD_RESPONSE - unread.messages.length, unread.messages)];
        const current = linksIncludingPending(contextRef.current.links)[childId] ?? link;
        const status = taskStatusOf(childId);
        const pending = followUpPending(childId);
        const lifecycle = childLifecycleForLink(current, status);
        const settled = !isChildActive(status) && !pending
          && (lifecycle === "completed" || lifecycle === "failed" || lifecycle === "cancelled");
        if (settled) {
          // A terminal child's unresolved questions accompany the exact final
          // result. Acceptance may explicitly close them without starting a
          // needless additional turn just to obtain a review token.
          settledMessages = messages;
          settledUnreadRemaining = unread.remaining;
          break;
        }
        if (messages.length) {
          return {
            ...describeChild(current, true),
            result: "",
            messages: messages.map(mailMessageForModel),
            ...(unread.remaining ? { unreadRemaining: unread.remaining } : {}),
            note: "The sub-agent needs your response to any unanswered question. Answer with send_agent_message (replyTo its id), then collect again. Repeatedly collecting is not an answer; unresolved questions remain available.",
          };
        }
        if (!isChildActive(status) && !pending) break;
        // A sibling's new question must not wait behind this collection: the
        // parent may otherwise keep re-collecting this child while it stalls.
        const siblingQuestions = siblingsNeedingResponse(link, knownSiblingQuestions);
        if (siblingQuestions.length) {
          return {
            ...describeChild(current, true),
            result: "",
            siblingsNeedingResponse: siblingQuestions,
            note: "Another child asked you a question while you were waiting. Read it with agent_status (pass its childId), answer with send_agent_message using replyTo, then collect this child again. This child is still working.",
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const current = linksIncludingPending(contextRef.current.links)[childId] ?? link;
          const siblings = siblingsNeedingResponse(link);
          return {
            ...describeChild(current, true),
            result: "",
            ...(siblings.length ? { siblingsNeedingResponse: siblings } : {}),
            note: pending
              ? "Your follow-up for this child is not running yet (it is starting or waiting for a free concurrency slot). Its previous result is unchanged. Collect again later; do not resend the message."
              : "Still working. Call collect_agent again to keep waiting.",
          };
        }
        if (!waiting) {
          waiting = true;
          useTaskStore.getState().upsertActivity(link.rootThreadId, {
            id: waitId, kind: "agent", title: `Waiting for sub-agent: ${link.title}`, status: "inProgress",
            agent: { action: "wait", threadIds: [childId] },
          });
        }
        await waitForChildChange(childId, remaining, () => siblingsNeedingResponse(link, knownSiblingQuestions).length > 0,
          link.signoff === "required" ? (listener) => {
            const wakeIfSuperseded = () => {
              try { assertCollectionCurrent(); } catch { listener(); }
            };
            childWaitersRef.current.add(wakeIfSuperseded);
            return () => { childWaitersRef.current.delete(wakeIfSuperseded); };
          } : undefined);
        if (!await isChildAgentRequestActive(request)) throw new Error("This collection belongs to a retired bridge registration.");
      }
    } finally {
      if (waiting && (link.signoff !== "required" || lifecycleRef.current.mounted && lifecycleRef.current.generation === rendererGeneration)) useTaskStore.getState().upsertActivity(link.rootThreadId, {
        id: waitId, kind: "agent", title: `Checked sub-agent: ${link.title}`, status: "completed",
        agent: { action: "wait", threadIds: [childId] },
      });
    }
    const current = linksIncludingPending(contextRef.current.links)[childId] ?? link;
    const status = taskStatusOf(childId);
    const lifecycle = childLifecycleForLink(current, status);
    if (status === "idle" && !current.terminalStatus) {
      return { childId, status: lifecycle, phase: "unknown", result: "", note: "Still working. Call collect_agent again to keep waiting." };
    }
    const reviewedToken = childReviewToken(current);
    const snapshotTask = useTaskStore.getState().tasks[childId];
    const reviewedTurnId = childReviewedTurnId(current);
    // An explicit attempt that settled without its own turn has no output of
    // its own; the previous turn's text must not be presented as its result.
    const attemptWithoutTurn = !reviewedTurnId && Boolean(current.resultRevision);
    const snapshot = {
      status,
      activeTurnId: snapshotTask?.activeTurnId,
      completedTurnId: snapshotTask?.lastCompletedTurnId,
      completedTurnStatus: snapshotTask?.lastCompletedTurnStatus,
      activationId: current.activationId,
      activationTurnId: current.activationTurnId,
      activationPreviousTurnId: current.activationPreviousTurnId,
      activationPending: current.activationPending,
      terminalStatus: current.terminalStatus,
      finishedAt: current.finishedAt,
      followUps: current.followUps,
      acceptedAt: current.acceptedAt,
      childGeneration: childStopGenerationRef.current.get(childId) ?? 0,
      rootGeneration: stopGenerationRef.current.get(current.rootThreadId) ?? 0,
    };
    let storedText = attemptWithoutTurn ? "" : lastAssistantText(childId, reviewedTurnId);
    if (!storedText && !attemptWithoutTurn) {
      await restoreChildTimeline(current, childObservationGuard(current)).catch(() => "");
      storedText = lastAssistantText(childId, reviewedTurnId);
    }
    const latestLink = linksIncludingPending(contextRef.current.links)[childId];
    const latestTask = useTaskStore.getState().tasks[childId];
    const changed = !latestLink || latestLink.sessionId !== current.sessionId || latestLink.rootThreadId !== current.rootThreadId
      || taskStatusOf(childId) !== snapshot.status || latestTask?.activeTurnId !== snapshot.activeTurnId
      || latestTask?.lastCompletedTurnId !== snapshot.completedTurnId || latestTask?.lastCompletedTurnStatus !== snapshot.completedTurnStatus
      || latestLink.activationId !== snapshot.activationId || latestLink.activationTurnId !== snapshot.activationTurnId
      || latestLink.activationPreviousTurnId !== snapshot.activationPreviousTurnId || latestLink.activationPending !== snapshot.activationPending
      || latestLink.terminalStatus !== snapshot.terminalStatus || latestLink.finishedAt !== snapshot.finishedAt
      || latestLink.followUps !== snapshot.followUps || latestLink.acceptedAt !== snapshot.acceptedAt
      || (childStopGenerationRef.current.get(childId) ?? 0) !== snapshot.childGeneration
      || (stopGenerationRef.current.get(current.rootThreadId) ?? 0) !== snapshot.rootGeneration
      || reviewedToken !== childReviewToken(latestLink) || isChildActive(taskStatusOf(childId)) || followUpPending(childId)
      || contextRef.current.threadUnavailable?.(childId) || contextRef.current.threadUnavailable?.(current.rootThreadId);
    if (changed) {
      return { ...(latestLink ? describeChild(latestLink, true) : { childId, phase: "unknown" }), result: "", superseded: true,
        ...(settledMessages.length ? { messages: settledMessages.map(mailMessageForModel) } : {}),
        ...(settledUnreadRemaining ? { unreadRemaining: settledUnreadRemaining } : {}),
        note: current.signoff === "required"
          ? "The child's result changed while it was loading. Collect the current settled turn before accepting its work."
          : "The child's result changed while it was loading. Collect the current settled turn before using its result." };
    }
    const { text, truncated } = truncateResult(storedText);
    const phase = childReviewPhase(current, status);
    const siblings = siblingsNeedingResponse(current);
    return {
      ...describeChild(current, true),
      result: text,
      ...(siblings.length ? { siblingsNeedingResponse: siblings } : {}),
      ...(settledMessages.length ? { messages: settledMessages.map(mailMessageForModel) } : {}),
      ...(settledUnreadRemaining ? { unreadRemaining: settledUnreadRemaining } : {}),
      ...(settledMessages.some((message) => message.kind === "question") ? {
        questionsNote: "Unanswered questions accompany this finished result. Answer with send_agent_message using replyTo if more work is needed, or accept this exact result to explicitly close them.",
      } : {}),
      ...(current.signoff !== "required" ? {} : reviewedToken ? { reviewToken: reviewedToken } : {
        acceptanceNote: "A stable identity for this settled result is not yet available. Collect again once runtime evidence is available; do not accept an older result.",
      }),
      ...(attemptWithoutTurn ? { note: current.signoff === "required"
        ? "The latest attempt ended without producing a turn of its own; earlier output is not its result. Inspect the error, then continue or accept knowingly."
        : "The latest attempt ended without producing a turn of its own; earlier output is not its result. Inspect the error and spawn a replacement if more work is needed." }
        : !text ? { note: "No final text was returned. Inspect the sub-agent task for tool activity or errors." } : {}),
      truncated,
      ...(phase === "awaiting_review" ? {
        nextStep: "This turn is finished and awaiting your review. Accept it with accept_agent when satisfied, or continue the same child with send_agent_message.",
      } : {}),
    };
  }, [childObservationGuard, describeChild, followUpPending, linksIncludingPending, recoverCurrentChild, siblingsNeedingResponse]);

  /**
   * Stop exactly one child from the command center or the model bridge.
   *
   * Cross-provider children have a durable ownership link and use their
   * provider-specific interrupt path. Codex-native children are first-class
   * runtime threads, so their latest turn can be discovered before interrupting.
   * Claude native children share the root process and cannot be stopped alone.
   */
  const stopChildAgent = useCallback(async (rootThreadId: string, childThreadId: string, origin: "user" | "parent" = "user", request?: ChildAgentRequest): Promise<void> => {
    const ctx = contextRef.current;
    const link = linksIncludingPending(ctx.links)[childThreadId];
    let status: TaskStatus;
    let parentThreadId = rootThreadId;
    let prompt = link?.title ?? "Delegated task";
    if (link) {
      if (link.rootThreadId !== rootThreadId) {
        throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      }
      // Settle the parent's pending guidance before any cutoff: a stop must
      // never be followed by an automatic follow-up turn, and an in-flight
      // follow-up start sees this generation change and aborts.
      childStopGenerationRef.current.set(childThreadId, (childStopGenerationRef.current.get(childThreadId) ?? 0) + 1);
      cancelQueuedForChild(childThreadId, origin === "user" ? "The user stopped this sub-agent." : "The parent cancelled this sub-agent.");
      updateLink(childThreadId, (current) => ({ ...current, stopOrigin: origin }));
      // A follow-up still preparing aborts on the generation change above and
      // restores its previous outcome itself; its link is transiently pending.
      if (followUpsInFlightRef.current.has(childThreadId) && !isChildActive(taskStatusOf(childThreadId))) return;
      if (!childNeedsCutoff(linksIncludingPending(contextRef.current.links)[childThreadId] ?? link)) {
        const terminalStatus = childLifecycleForLink(link, taskStatusOf(childThreadId)) as "completed" | "cancelled" | "failed";
        settleChildInParent(rootThreadId, childThreadId, link.title, terminalStatus, terminalStatus);
        return;
      }
      // An unconfirmed idle activation may belong to an unloaded conversation.
      // The cutoff seals and saves its transcript, so never from an empty task.
      const current = linksIncludingPending(contextRef.current.links)[childThreadId] ?? link;
      const assertCurrent = childObservationGuard(current);
      await ensureChildHydrated(current, assertCurrent).catch(() => undefined);
      if (request && !await isChildAgentRequestActive(request)) throw new Error("This cancellation belongs to a retired bridge registration.");
      assertCurrent();
      status = await hardStopChild(link.provider, childThreadId, undefined, ctx, current, managedCutoffGuard(current));
      settleManagedCutoff(current, status);
      void auditEvent("childAgent.stopped", { rootThreadId, childThreadId, kind: "cross-provider", origin });
      return;
    } else {
      const agent = nativeChildrenFor(rootThreadId, ctx.nativeLinks).find((entry) => entry.id === childThreadId);
      if (!agent) throw new Error(`\`${childThreadId}\` was not started from this thread.`);
      if (agent.runtime === "claude" || agent.provider === "claude" || childThreadId.startsWith("claude-native:")) {
        throw new Error("Claude native sub-agents share their root process. Stop the root thread to stop them.");
      }
      parentThreadId = agent.rootThreadId;
      prompt = agent.prompt;
      status = await stopCodexChild(childThreadId, undefined, () => assertNativeChildActivation(agent));
    }

    settleStoppedChild(parentThreadId, childThreadId, prompt, status);
    if (!link) persistNativeSettlement(ctx.nativeLinks?.[childThreadId], status);
    void auditEvent("childAgent.stopped", { rootThreadId, childThreadId, kind: link ? "cross-provider" : "native", origin });
  }, [childNeedsCutoff, childObservationGuard, linksIncludingPending, managedCutoffGuard, persistNativeSettlement, settleManagedCutoff, updateLink]);

  const cancelChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(ctx.links)[childId];
    if (!link || link.sessionId !== request.sessionId) {
      throw new Error(`\`${childId}\` was not started from this thread.`);
    }
    // An unconfirmed activation may still be running; it needs a real cutoff.
    if (!childNeedsCutoff(link)) {
      const cancelled = cancelQueuedForChild(childId, "The parent cancelled this sub-agent.");
      if (followUpsInFlightRef.current.has(childId)) {
        await stopChildAgent(link.rootThreadId, childId, "parent", request);
        return { childId, status: "cancelled", note: "The follow-up that was starting was cancelled." };
      }
      return {
        childId,
        status: childLifecycleForLink(link, taskStatusOf(childId)),
        note: cancelled ? `That sub-agent had already finished; ${cancelled} undelivered message${cancelled === 1 ? " was" : "s were"} cancelled.` : "That sub-agent had already finished.",
      };
    }
    await stopChildAgent(link.rootThreadId, childId, "parent", request);
    return { childId, status: "cancelled" };
  }, [childNeedsCutoff, linksIncludingPending, stopChildAgent]);

  /** One entry in the parent's work history; never a parent turn. */
  const recordParentActivity = useCallback((rootThreadId: string, id: string, title: string, detail: string, childThreadId: string, action: "sendInput" | "resume" | "status" | "close", kind: "agent" | "warning" = "agent") => {
    useTaskStore.getState().upsertActivity(rootThreadId, {
      id, kind, title, detail: detail.length > 600 ? `${detail.slice(0, 600)}…` : detail, status: "completed",
      agent: { action, threadIds: [childThreadId] },
    });
  }, []);

  /**
   * Continue an idle child on its own conversation with its queued guidance.
   *
   * Order matters and every step is guarded: the guidance moves to
   * `delivering` (compare-and-set), a prior slot release finishes, the
   * backend reserves a slot and returns an activation token that is persisted
   * at once, then the provider is asked. Guidance becomes `delivered` only
   * when the provider accepts the turn. Any refusal before dispatch returns
   * it to the queue or cancels it with a reason; the token always releases
   * exactly its own reservation.
   */
  const startFollowUp = useCallback(async (childThreadId: string): Promise<void> => {
    if (followUpsInFlightRef.current.has(childThreadId)) return;
    const ctx = contextRef.current;
    const link = linksIncludingPending(ctx.links)[childThreadId];
    const waitFor = (reason: string) => { followUpWaitReasonRef.current.set(childThreadId, reason); };
    // Same ordered prefix as steering and pulls: never start a follow-up
    // with later guidance while an earlier message is still being delivered.
    const { messages: queued, blockedBy } = deliverableGuidance(childThreadId);
    if (!queued.length) {
      if (blockedBy && queuedForChild(childThreadId).length) waitFor(`Earlier guidance ${blockedBy} is still being delivered; later messages wait behind it.`);
      return;
    }
    if (!link) {
      cancelQueuedForChild(childThreadId, "This sub-agent is no longer owned by a parent thread.");
      return;
    }
    const initialStatus = taskStatusOf(childThreadId);
    const permanent = followUpRefusal(link)
      ?? (ctx.threadUnavailable?.(childThreadId) ? "This sub-agent's conversation was archived or removed." : null);
    if (permanent) {
      cancelQueuedForChild(childThreadId, permanent);
      return;
    }
    // Human authority outranks the frozen parent link: if the user explicitly
    // re-configured this child, do not revert it behind their back.
    const manual = ctx.explicitThreadExecutionFor?.(childThreadId);
    if (manual && (manual.provider !== undefined && manual.provider !== link.provider
      || manual.model !== undefined && manual.model !== link.model
      || manual.reasoningEffort !== undefined && manual.reasoningEffort !== link.reasoningEffort)) {
      cancelQueuedForChild(childThreadId, "The user changed this sub-agent's model or reasoning setting. Parent follow-ups only use its original settings, so this was not sent; spawn a new sub-agent, or ask the user to continue it or restore its settings.");
      return;
    }
    if (ctx.threadBusy?.(childThreadId) || ctx.threadBusy?.(link.rootThreadId)) {
      return waitFor("The child or parent conversation is temporarily busy; guidance stays queued.");
    }
    // A running child receives guidance at its own boundary or by pulling it.
    if (isChildActive(initialStatus)) return;
    // After a reload a missing local status proves nothing; wait for evidence.
    if (initialStatus === "idle" && !link.terminalStatus) {
      return waitFor("Mythra Code cannot yet confirm this sub-agent's last turn finished; it starts once its status is known.");
    }
    const rootThreadId = link.rootThreadId;
    const policy = childAgentPolicyForSession(ctx.policies, link.sessionId);
    if (!policy || policy.rootThreadId !== rootThreadId || policy.collaborationV2 !== true) {
      cancelQueuedForChild(childThreadId, "The parent thread's sub-agent session no longer exists.");
      return;
    }
    if (!policy.targets.length || ctx.threadUnavailable?.(rootThreadId)) {
      cancelQueuedForChild(childThreadId, "The parent thread is unavailable or its sub-agent policy was switched off.");
      return;
    }
    const logicalPath = ctx.projectPathForThread(rootThreadId);
    if (!logicalPath) return waitFor("Mythra Code no longer knows the parent thread's project folder.");
    const active = reservedChildCount(policy.sessionId, rootThreadId, linksIncludingPending(ctx.links));
    if (active >= policy.maxConcurrent) return waitFor(`All ${policy.maxConcurrent} concurrency slot${policy.maxConcurrent === 1 ? " is" : "s are"} in use; it starts when one frees.`);
    const ids = queued.map((message) => message.id);
    if (!transitionChildMessage(childThreadId, ids, ["queued"], "delivering")) return;
    followUpWaitReasonRef.current.delete(childThreadId);

    // Synchronous reservation: concurrent pumps see this slot immediately.
    followUpsInFlightRef.current.add(childThreadId);
    const reservation = `${FOLLOW_UP_RESERVATION}${childThreadId}`;
    const pending = pendingChildrenRef.current.get(policy.sessionId) ?? new Set<string>();
    pending.add(reservation);
    pendingChildrenRef.current.set(policy.sessionId, pending);
    const inFlight = inFlightStartsRef.current;
    inFlight.set(rootThreadId, (inFlight.get(rootThreadId) ?? 0) + 1);
    notifyModeLockChanged();

    const stopGeneration = stopGenerationRef.current.get(rootThreadId) ?? 0;
    const childGeneration = childStopGenerationRef.current.get(childThreadId) ?? 0;
    const rendererGeneration = lifecycleRef.current.generation;
    const executionPath = ctx.executionPathFor(rootThreadId, logicalPath);
    const gitDir = ctx.isolationGitDirFor(rootThreadId);
    const projectId = ctx.projectIdForThread?.(rootThreadId) ?? null;
    if (link.executionPath !== undefined && link.executionPath !== executionPath
      || link.executionProjectId !== undefined && link.executionProjectId !== projectId
      || link.executionAdditionalWorkspaceRoots !== undefined
        && JSON.stringify(link.executionAdditionalWorkspaceRoots) !== JSON.stringify(gitDir ? [gitDir] : [])) {
      transitionChildMessage(childThreadId, ids, ["delivering"], "cancelled", {
        reason: "The parent moved to a different execution folder or project. This child stays bound to its original workspace; spawn a new child for the new workspace.",
      });
      // Release the synchronous renderer reservation before any async work.
      followUpsInFlightRef.current.delete(childThreadId);
      pending.delete(reservation);
      if (!pending.size) pendingChildrenRef.current.delete(policy.sessionId);
      const remaining = (inFlight.get(rootThreadId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(rootThreadId, remaining);
      else inFlight.delete(rootThreadId);
      notifyModeLockChanged();
      return;
    }
    const prompt = formatParentMessages(queued);
    let activationId: string | undefined;
    // The baseline is frozen only after hydration, and any newer child work
    // during preparation (a user-typed turn, its completion, a new revision)
    // refuses this follow-up instead of being mistaken for its evidence.
    let previousTurnId: string | undefined;
    let baselineCompleted: string | undefined;
    let baselineFrozen = false;
    const startRunGeneration = childRunGenerationRef.current.get(childThreadId) ?? 0;
    const startRevision = link.resultRevision ?? 0;
    let checkpointId: string | undefined;
    pendingActivationsRef.current.set(childThreadId, {});
    let dispatched = false;
    let accepted = false;
    let sentMessageId: string | undefined;
    let dispatchRunGeneration: number | undefined;
    let dispatchRevision: number | undefined;
    const stopped = () => (stopGenerationRef.current.get(rootThreadId) ?? 0) !== stopGeneration
      || (childStopGenerationRef.current.get(childThreadId) ?? 0) !== childGeneration;
    const assertCanStart = () => {
      const live = contextRef.current;
      const current = linksIncludingPending(live.links)[childThreadId];
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) {
        throw new FollowUpRefused("The renderer was detached before this follow-up started.", "keep");
      }
      if (stopped()) throw new FollowUpRefused("The sub-agent was stopped before the follow-up started.", "cancel");
      if (!current || current.rootThreadId !== rootThreadId || current.sessionId !== link.sessionId
        || current.provider !== link.provider || current.model !== link.model || current.reasoningEffort !== link.reasoningEffort
        || current.autoCompactTokens !== link.autoCompactTokens || (activationId && current.activationId !== activationId)) {
        throw new FollowUpRefused("This sub-agent's ownership or frozen execution settings changed.", "cancel");
      }
      const refusal = followUpRefusal(current);
      if (refusal) throw new FollowUpRefused(refusal, "cancel");
      if (live.threadUnavailable?.(childThreadId)) throw new FollowUpRefused("This sub-agent's conversation was archived or removed.", "cancel");
      if (live.threadBusy?.(childThreadId) || live.threadBusy?.(rootThreadId)) {
        throw new FollowUpRefused("The child or parent conversation is temporarily busy.", "keep");
      }
      const livePolicy = childAgentPolicyForSession(live.policies, link.sessionId);
      if (!livePolicy?.targets.length || livePolicy.rootThreadId !== rootThreadId || livePolicy.collaborationV2 !== true || live.threadUnavailable?.(rootThreadId)) {
        throw new FollowUpRefused("The parent thread is unavailable or its sub-agent policy was switched off.", "cancel");
      }
      if (livePolicy.permission !== policy.permission || livePolicy.systemPrompt !== policy.systemPrompt
        || JSON.stringify(livePolicy.providerSystemPrompts) !== JSON.stringify(policy.providerSystemPrompts)
        || livePolicy.projectInstructionsEnabled !== policy.projectInstructionsEnabled
        || livePolicy.projectClaudeInstructionsEnabled !== policy.projectClaudeInstructionsEnabled
        || livePolicy.serviceTier !== policy.serviceTier) {
        throw new FollowUpRefused("The parent's execution policy changed while the follow-up was preparing.", "cancel");
      }
      if (!dispatched && isChildActive(taskStatusOf(childThreadId))) {
        throw new FollowUpRefused("The sub-agent started another turn; the message waits for its next boundary.", "keep");
      }
      if (!dispatched && ((childRunGenerationRef.current.get(childThreadId) ?? 0) !== startRunGeneration
        || (current.resultRevision ?? 0) !== startRevision
        || baselineFrozen && useTaskStore.getState().tasks[childThreadId]?.lastCompletedTurnId !== baselineCompleted)) {
        throw new FollowUpRefused("The conversation received newer work while this follow-up was preparing; the message waits for its next boundary.", "keep");
      }
      if (live.projectPathForThread(rootThreadId) !== logicalPath
        || live.executionPathFor(rootThreadId, logicalPath) !== executionPath
        || live.isolationGitDirFor(rootThreadId) !== gitDir
        || (live.projectIdForThread?.(rootThreadId) ?? null) !== projectId) {
        throw new FollowUpRefused("The parent thread's execution folder changed, so the follow-up was not started.", "cancel");
      }
      if (!dispatched && live.executionTargetUnavailable?.(rootThreadId) === true) {
        // A worktree operation in progress (or a missing worktree) is not a
        // reason to drop the parent's guidance; it waits for the next pump.
        throw new FollowUpRefused("The parent thread's isolated worktree is busy or unavailable.", "keep");
      }
      const mailbox = getChildMailbox(childThreadId);
      if (!ids.every((id) => mailbox?.messages.some((message) => message.id === id && message.state === "delivering"))) {
        throw new FollowUpRefused("The message was cancelled before the follow-up started.", "cancel");
      }
    };
    try {
      // A previous release for this child must land before a new reservation:
      // the backend refuses a child that still holds its old slot.
      await releaseAttemptsRef.current.get(childThreadId);
      assertCanStart();
      // Hydrate (guarded) before freezing the baseline: an unloaded history
      // would otherwise make an older turn look like the latest.
      await ensureChildHydrated(link, assertCanStart);
      assertCanStart();
      baselineCompleted = useTaskStore.getState().tasks[childThreadId]?.lastCompletedTurnId;
      previousTurnId = baselineCompleted ?? link.activationTurnId;
      baselineFrozen = true;
      pendingActivationsRef.current.set(childThreadId, { previousTurnId });
      try {
        activationId = await reactivateChildAgent(link.sessionId, childThreadId);
      } catch (reason) {
        const message = friendlyError(reason);
        throw new FollowUpRefused(message, /maximum|still holds|already owns|not active|re-register/i.test(message) ? "keep" : "cancel");
      }
      // Persist the token before any provider work, so every later
      // completion or failure release names exactly this reservation.
      const token = activationId;
      pendingActivationsRef.current.set(childThreadId, { activationId: token, previousTurnId });
      // Keep the settled outcome until dispatch: a reload during preparation
      // proves (through activationDispatched: false) that it still applies.
      updateLink(childThreadId, (current) => ({
        ...current, activationId: token, activationPreviousTurnId: previousTurnId, activationPending: true, activationDispatched: false,
      }));
      assertCanStart();
      if (link.provider === "cursor" && !ctx.cursorSessionIdsRef.current[childThreadId]) {
        const sessionId = managedChildCursorSessionId(link);
        if (sessionId) ctx.cursorSessionIdsRef.current[childThreadId] = sessionId;
      }
      const reserved = linksIncludingPending(contextRef.current.links)[childThreadId] ?? { ...link, activationId: token };
      const result = await continueChildAgentTurn(prompt, {
        link: reserved,
        policy,
        links: linksIncludingPending(contextRef.current.links),
        executionPath,
        additionalWorkspaceRoots: gitDir ? [gitDir] : [],
        projectId,
        serviceName: ctx.serviceNameFor(rootThreadId),
        modelContextWindow: link.provider === "openrouter"
          ? ctx.openRouterModels.find((entry) => entry.id === link.model)?.context_length
          : link.provider === "lmstudio"
            ? ctx.lmStudioModels?.find((entry) => entry.id === link.model)?.maxContextLength
            : undefined,
        lmStudioBaseUrl: ctx.lmStudioBaseUrl,
        cursorSessionId: ctx.cursorSessionIdsRef.current[childThreadId],
        resolveSkillPrompts: ctx.resolveSkillPrompts,
        assertCanStart,
        beginCheckpoint: async (threadId) => {
          checkpointId = await ctx.beginRunCheckpoint(threadId, executionPath, prompt, link.provider, link.model);
        },
        onDispatch: (startRequestId) => {
          assertCanStart();
          dispatched = true;
          // Fresh parent work reopens a parent-cancelled assignment before
          // its first immediate mailbox tool can arrive. Written synchronously
          // (cached storage) before the provider request: from here on a
          // reload cannot prove whether the model received it. The dispatch
          // opens a new result revision based on the frozen baseline.
          updateLink(childThreadId, (current) => {
            const { terminalStatus: _terminal, finishedAt: _finished, activationTurnId: _turn, stopOrigin: _stop,
              manualAttemptId: _attempt, revisionBaseTurnId: _base, activationStartRequestId: _start, ...dispatching } = current;
            return { ...dispatching, activationDispatched: true, resultRevision: (current.resultRevision ?? 0) + 1,
              ...(startRequestId ? { activationStartRequestId: startRequestId } : {}),
              ...(previousTurnId ? { revisionBaseTurnId: previousTurnId } : {}) };
          });
          releasedRef.current.delete(childThreadId);
          useTaskStore.getState().setActiveTurn(childThreadId, undefined);
          useTaskStore.getState().setTaskStatus(childThreadId, "starting");
          dispatchRunGeneration = childRunGenerationRef.current.get(childThreadId) ?? 0;
          dispatchRevision = linksIncludingPending(contextRef.current.links)[childThreadId]?.resultRevision ?? 0;
          sentMessageId = `local-${crypto.randomUUID()}`;
          useTaskStore.getState().appendUserMessage(childThreadId, { id: sentMessageId, role: "user", text: prompt });
        },
      });
      accepted = true;
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) {
        // The durable activation is already owned. A replacement renderer
        // recovers its provider status; this retired closure must not replace
        // that renderer's link or interrupt work it can reattach.
        transitionChildMessage(childThreadId, ids, ["delivering", "cancelled"], "delivered", { via: "turn" });
        return;
      }
      if (result.turnId && sentMessageId) useTaskStore.getState().bindUserMessageTurn(childThreadId, sentMessageId, result.turnId);
      const latest = linksIncludingPending(contextRef.current.links)[childThreadId];
      const latestTask = useTaskStore.getState().tasks[childThreadId];
      if (!latest || latest.activationId !== token || result.superseded
        || dispatchRunGeneration !== (childRunGenerationRef.current.get(childThreadId) ?? 0)
        || result.turnId && latestTask?.activeTurnId && latestTask.activeTurnId !== result.turnId) {
        // Provider receipt remains true, but this acknowledgement cannot
        // replace a user's newer activation or give it the old slot token.
        transitionChildMessage(childThreadId, ids, ["delivering", "cancelled"], "delivered", { via: "turn" });
        releaseSlot({ ...link, activationId: token }, token);
        if (pendingActivationsRef.current.get(childThreadId)?.activationId === token) pendingActivationsRef.current.delete(childThreadId);
        if (latest?.activationId === token) updateLink(childThreadId, (current) => {
          const { acceptedAt: _accepted, acceptedBy: _by, acceptNote: _note, stopOrigin: _stop,
            activationId: _activation, activationPending: _pending, activationPreviousTurnId: _previous,
            activationTurnId: _turn, terminalStatus: _terminal, finishedAt: _finished, ...reopened } = current;
          const status = taskStatusOf(childThreadId);
          const turnId = latestTask?.activeTurnId ?? latestTask?.lastCompletedTurnId;
          return { ...reopened, followUps: (current.followUps ?? 0) + 1,
            ...(turnId ? { activationTurnId: turnId } : {}),
            ...(!isChildActive(status) && status !== "idle"
              ? { terminalStatus: childLifecycle(status) as "completed" | "cancelled" | "failed", finishedAt: Date.now() } : {}) };
        });
        return;
      }
      pendingActivationsRef.current.set(childThreadId, { activationId: token, previousTurnId, turnId: result.turnId });
      if (result.cursorSessionId && !result.superseded) ctx.cursorSessionIdsRef.current[childThreadId] = result.cursorSessionId;
      // The provider accepted this turn. A root Stop/archive that cancelled
      // the in-flight guidance cannot undo that; the cutoff below follows.
      transitionChildMessage(childThreadId, ids, ["delivering", "cancelled"], "delivered", { via: "turn" });
      const store = useTaskStore.getState();
      const completedBeforeStartReturned = Boolean(result.turnId && store.tasks[childThreadId]?.lastCompletedTurnId === result.turnId);
      if (!completedBeforeStartReturned && !result.superseded && !result.stopped) {
        if (result.turnId) store.setActiveTurn(childThreadId, result.turnId);
        store.setTaskStatus(childThreadId, "running");
      }
      // Reopen the link for the new turn. If that turn already settled, the
      // transition handler has written its outcome; keep it.
      updateLink(childThreadId, (current) => {
        const { terminalStatus: _terminal, finishedAt: _finished, ...reopened } = current;
        return {
          ...reopened,
          ...(stopped() ? {} : { stopOrigin: undefined }),
          activationId: token,
          activationTurnId: result.turnId,
          activationPending: !result.turnId,
          followUps: (current.followUps ?? 0) + 1,
        };
      });
      const live = isChildActive(taskStatusOf(childThreadId));
      store.upsertAgent(rootThreadId, {
        id: childThreadId, prompt: link.title, status: live ? "inProgress" : childLifecycle(taskStatusOf(childThreadId)),
        path: `${link.provider} · ${link.model || "default"}`,
      });
      const spawnActivity = store.tasks[rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${childThreadId}`);
      if (spawnActivity && live) store.upsertActivity(rootThreadId, { ...spawnActivity, status: "running" });
      if (link.provider === "claude") ctx.scheduleClaudeThreadSave(childThreadId);
      if (link.provider === "cursor") ctx.scheduleCursorThreadSave(childThreadId);
      recordParentActivity(rootThreadId, `child-followup-${childThreadId}-${ids[0]}`, `Continued sub-agent: ${link.title}`, queued.map((message) => message.text).join("\n\n"), childThreadId, "resume");
      if (result.bridgeMayBeStale) {
        recordParentActivity(rootThreadId, `child-followup-bridge-${childThreadId}-${ids[0]}`, "Sub-agent messaging may be unavailable this turn",
          "The runtime already had this sub-agent loaded with an older Mythra Code bridge and could not refresh it while other work is active.", childThreadId, "status", "warning");
      }
      void auditEvent("childAgent.followUp", { childThreadId, messages: ids.length, provider: link.provider }, rootThreadId);
      // Stop or removal landed while the provider was starting: cut it off.
      const livePolicy = childAgentPolicyForSession(contextRef.current.policies, link.sessionId);
      if ((stopped() || contextRef.current.threadUnavailable?.(childThreadId)
        || contextRef.current.threadUnavailable?.(rootThreadId) || !livePolicy?.targets.length)
        && isChildActive(taskStatusOf(childThreadId))) {
        try {
          const current = linksIncludingPending(contextRef.current.links)[childThreadId] ?? link;
          const status = await hardStopChild(link.provider, childThreadId, result.turnId, ctx, current, managedCutoffGuard(current));
          const cutoffLink = linksIncludingPending(contextRef.current.links)[childThreadId];
          if (cutoffLink) settleManagedCutoff(cutoffLink, status);
        } catch (reason) {
          recordParentActivity(rootThreadId, `child-followup-stop-${childThreadId}-${ids[0]}`, `Could not stop ${link.title}`,
            `The follow-up started while Stop was settling: ${friendlyError(reason)}. Stop it again from Live sub-agents.`, childThreadId, "status", "warning");
        }
      }
    } catch (reason) {
      if (accepted) return;
      // A native start that proves it refused before writing any prompt is
      // not an uncertain dispatch, provided no newer run took the child.
      const refusedBeforeWrite = dispatched && definitelyNotDispatched(reason)
        && dispatchRunGeneration === (childRunGenerationRef.current.get(childThreadId) ?? 0);
      const neverSent = !dispatched || refusedBeforeWrite;
      const currentOutcome = linksIncludingPending(contextRef.current.links)[childThreadId];
      const confirmedCutoff = currentOutcome?.activationId === activationId
        && (currentOutcome.resultRevision ?? 0) === dispatchRevision
        && !currentOutcome.activationPending && Boolean(currentOutcome.terminalStatus)
        && releasedRef.current.has(childThreadId);
      if (!neverSent && (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration)) {
        transitionChildMessage(childThreadId, ids, ["delivering"], "failed", {
          uncertain: true,
          reason: "The renderer detached while the provider request was pending. The request may have reached the child; recover its runtime status before retrying.",
        });
        return;
      }
      if (neverSent) {
        if (sentMessageId) useTaskStore.getState().removeMessage(childThreadId, sentMessageId);
        // Exact rollback: only this follow-up's own checkpoint, pending
        // activation and link fields. A newer manual start keeps its state.
        if (checkpointId) ctx.discardRunCheckpoint(childThreadId, checkpointId);
        const ownPending = pendingActivationsRef.current.get(childThreadId);
        if (ownPending && (ownPending.activationId === undefined || ownPending.activationId === activationId)) pendingActivationsRef.current.delete(childThreadId);
        let rolledBack = false;
        if (activationId) {
          const token = activationId;
          updateLink(childThreadId, (current) => {
            if (current.activationId !== token) return current;
            const { activationPending: _pending, activationDispatched: _dispatched, activationPreviousTurnId: _previous, ...rest } = current;
            // This preparation sent nothing. Retire only its transient
            // metadata even if Stop or manual work changed the outcome;
            // preserve those newer fields rather than restoring old ones.
            if (!dispatched && current.activationDispatched === false) {
              rolledBack = true;
              return rest;
            }
            if (confirmedCutoff || stopped()
              || current.stopOrigin || (dispatched && ((current.resultRevision ?? 0) !== dispatchRevision
                || (childRunGenerationRef.current.get(childThreadId) ?? 0) !== dispatchRunGeneration))) return current;
            rolledBack = true;
            if (!refusedBeforeWrite) return rest;
            // onDispatch already opened a revision; restore the settled one.
            const restored: Record<string, unknown> = { ...rest };
            for (const field of ["terminalStatus", "finishedAt", "activationTurnId", "stopOrigin", "resultRevision", "revisionBaseTurnId", "manualAttemptId"] as const) {
              if (link[field] === undefined) delete restored[field];
              else restored[field] = link[field];
            }
            return restored as unknown as ChildAgentLink;
          });
          releaseSlot(linksIncludingPending(contextRef.current.links)[childThreadId] ?? link, token);
        }
        if (refusedBeforeWrite && rolledBack && taskStatusOf(childThreadId) === "starting") {
          useTaskStore.getState().setTaskStatus(childThreadId, initialStatus);
          if (link.terminalStatus) releasedRef.current.add(childThreadId);
        }
      } else {
        // Only the exact activation this follow-up dispatched may be marked
        // uncertain. If the user stopped it and newer work took the child,
        // that newer task/link stays as it is; the old guidance is recorded
        // uncertain below and its slot token stays reserved until Stop.
        const current = linksIncludingPending(contextRef.current.links)[childThreadId];
        const stillOwned = current?.activationId === activationId
          && (current?.resultRevision ?? 0) === dispatchRevision
          && (childRunGenerationRef.current.get(childThreadId) ?? 0) === dispatchRunGeneration;
        if (stillOwned && !confirmedCutoff) {
          pendingActivationsRef.current.set(childThreadId, { activationId, previousTurnId, uncertain: true });
          updateLink(childThreadId, (latest) => latest.activationId === activationId ? { ...latest, activationPending: true } : latest);
          const completedId = useTaskStore.getState().tasks[childThreadId]?.lastCompletedTurnId;
          if (!isChildActive(taskStatusOf(childThreadId)) && !(confirmedLocalTerminal(childThreadId)
            && completedId && completedId !== previousTurnId)) {
            useTaskStore.getState().setTaskStatus(childThreadId, "starting",
              "The provider did not confirm this follow-up. It may be working; Stop it or collect confirmed runtime evidence before continuing.");
          }
        } else if (activationId && !confirmedCutoff) {
          supersededUncertainRef.current.set(childThreadId, activationId);
        }
      }
      const message = friendlyError(reason);
      if (reason instanceof FollowUpRefused && neverSent) {
        if (reason.disposition === "keep") {
          transitionChildMessage(childThreadId, ids, ["delivering"], "queued");
          waitFor(message);
        } else {
          transitionChildMessage(childThreadId, ids, ["delivering"], "cancelled", { reason: message });
        }
        return;
      }
      // A failure after dispatch cannot prove the provider never saw it.
      const detail = confirmedCutoff
        ? `The provider's startup response was lost, but this exact activation already finished or was stopped. Its confirmed result or cutoff was preserved; the instruction was not resent: ${message}`
        : !neverSent
        ? `The provider did not confirm startup and may be working. Its slot and checkpoint remain reserved until a confirmed finish or Stop: ${message}`
        : `The follow-up could not start: ${message}`;
      transitionChildMessage(childThreadId, ids, ["delivering"], neverSent && stopped() ? "cancelled" : "failed", { reason: detail, uncertain: !neverSent });
      recordParentActivity(rootThreadId, `child-followup-failed-${childThreadId}-${ids[0]}`, `Could not continue ${link.title}`, detail, childThreadId, "resume", "warning");
    } finally {
      followUpsInFlightRef.current.delete(childThreadId);
      pending.delete(reservation);
      if (!pending.size) pendingChildrenRef.current.delete(policy.sessionId);
      const remaining = (inFlight.get(rootThreadId) ?? 1) - 1;
      if (remaining > 0) inFlight.set(rootThreadId, remaining);
      else inFlight.delete(rootThreadId);
      if (lifecycleRef.current.mounted) notifyModeLockChanged();
      if (lifecycleRef.current.mounted && lifecycleRef.current.generation === rendererGeneration) reconcileChildrenRef.current();
    }
  }, [linksIncludingPending, managedCutoffGuard, notifyModeLockChanged, recordParentActivity, releaseSlot, reservedChildCount, settleManagedCutoff, updateLink]);

  /** Start queued follow-ups that can run now. Event-driven; never polls. */
  const pumpSession = useCallback((sessionId: string) => {
    for (const { link, activationId } of releases.current.values()) {
      if (link.sessionId === sessionId) releaseSlot(link, activationId);
    }
    // Fair order: the oldest waiting guidance gets the next free slot, so a
    // child that keeps receiving work cannot starve the others.
    const waiting = Object.values(linksIncludingPending(contextRef.current.links))
      .flatMap((link) => {
        if (link.sessionId !== sessionId) return [];
        const oldest = deliverableGuidance(link.childThreadId).messages[0];
        return oldest ? [{ link, oldest: Number(oldest.id.slice(1)), createdAt: oldest.createdAt }] : [];
      })
      .sort((left, right) => left.createdAt - right.createdAt || left.oldest - right.oldest);
    for (const { link } of waiting) void startFollowUp(link.childThreadId);
  }, [linksIncludingPending, releaseSlot, startFollowUp]);
  schedulePumpRef.current = (sessionId: string) => {
    if (!lifecycleRef.current.mounted) return;
    if (scheduledPumpsRef.current.has(sessionId)) return;
    scheduledPumpsRef.current.add(sessionId);
    const generation = lifecycleRef.current.generation;
    queueMicrotask(() => {
      scheduledPumpsRef.current.delete(sessionId);
      void bridgeReadyRef.current.then(() => {
        if (lifecycleRef.current.mounted && lifecycleRef.current.generation === generation) pumpSession(sessionId);
      }).catch(() => undefined);
    });
  };

  /**
   * Try to insert queued guidance into a running child's turn. `delivered`
   * is recorded only after the runtime acknowledged it; a refusal returns it
   * to the queue for the child's next boundary or its own pull.
   */
  const steerQueued = useCallback(async (link: ChildAgentLink, messages: ChildMailMessage[]): Promise<void> => {
    const refusal = followUpRefusal(link);
    if (refusal) {
      cancelQueuedForChild(link.childThreadId, refusal);
      return;
    }
    assertParentCollaboration(link);
    const childThreadId = link.childThreadId;
    const ids = messages.map((message) => message.id);
    if (!transitionChildMessage(childThreadId, ids, ["queued"], "delivering")) return;
    const childGeneration = childStopGenerationRef.current.get(childThreadId) ?? 0;
    const rootGeneration = stopGenerationRef.current.get(link.rootThreadId) ?? 0;
    const assertCurrent = childObservationGuard(link);
    const text = formatParentMessages(messages);
    const store = useTaskStore.getState();
    const messageId = `local-${crypto.randomUUID()}`;
    let requested = false;
    try {
      await ensureChildHydrated(link, assertCurrent);
      assertCurrent();
      assertParentCollaboration(link);
      store.appendUserMessage(childThreadId, { id: messageId, role: "user", text, steerStatus: "sending" });
      requested = true;
      await steerChild(link, text);
      if (!transitionChildMessage(childThreadId, ids, ["delivering"], "delivered", { via: "steer" })) {
        // The child was stopped while the runtime accepted it; keep the
        // timeline truthful about what the runtime received.
        transitionChildMessage(childThreadId, ids, ["cancelled"], "delivered", { via: "steer" });
      }
      useTaskStore.getState().setMessageSteerStatus(childThreadId, messageId, "accepted");
      if (link.provider === "claude") contextRef.current.scheduleClaudeThreadSave(childThreadId);
      if (link.provider === "cursor") contextRef.current.scheduleCursorThreadSave(childThreadId);
    } catch (reason) {
      // Written but unconfirmed: the runtime may act on it. Keep it visible,
      // never requeue it (that would resend it automatically).
      if (requested && deliveryUncertain(reason)) {
        useTaskStore.getState().setMessageSteerStatus(childThreadId, messageId, "unconfirmed");
        transitionChildMessage(childThreadId, ids, ["delivering"], "failed", {
          uncertain: true,
          reason: `The runtime did not confirm this message (${friendlyError(reason).replace(DELIVERY_UNCERTAIN_PREFIX, "").trim()}); it may have reached the sub-agent. It was not resent automatically.`,
        });
        if (link.provider === "claude") contextRef.current.scheduleClaudeThreadSave(childThreadId);
        if (link.provider === "cursor") contextRef.current.scheduleCursorThreadSave(childThreadId);
        return;
      }
      useTaskStore.getState().removeMessage(childThreadId, messageId);
      // Stop or cancel landed while the runtime was refusing it. Returning it
      // to the queue would let the boundary pump re-prompt a stopped child.
      const current = linksIncludingPending(contextRef.current.links)[childThreadId];
      if (!current || current.rootThreadId !== link.rootThreadId || current.sessionId !== link.sessionId
        || current.acceptedAt || current.stopOrigin || contextRef.current.threadUnavailable?.(childThreadId)
        || contextRef.current.threadUnavailable?.(link.rootThreadId)
        || (childStopGenerationRef.current.get(childThreadId) ?? 0) !== childGeneration
        || (stopGenerationRef.current.get(link.rootThreadId) ?? 0) !== rootGeneration) {
        transitionChildMessage(childThreadId, ids, ["delivering"], "cancelled", { reason: "The sub-agent was stopped before the runtime accepted this message." });
        return;
      }
      transitionChildMessage(childThreadId, ids, ["delivering"], "queued");
      followUpWaitReasonRef.current.set(childThreadId, `Live steering was unavailable (${friendlyError(reason)}); it is delivered at the child's next turn boundary.`);
      // The turn may have ended while steering was refused; its boundary
      // pump saw `delivering` and skipped, so retry delivery now.
      if (!isChildActive(taskStatusOf(childThreadId))) schedulePumpRef.current(link.sessionId);
    }
  }, [assertParentCollaboration, childObservationGuard, linksIncludingPending]);

  /**
   * Live guidance is serialized per child and batched: each pass steers the
   * queued prefix in order, so a later correction never overtakes an earlier
   * one still in flight.
   */
  const steerChainsRef = useRef(new Map<string, Promise<void>>());
  const steerPendingGuidance = useCallback((childThreadId: string): Promise<void> => {
    const chains = steerChainsRef.current;
    const run = async () => {
      const link = linksIncludingPending(contextRef.current.links)[childThreadId];
      if (!link || !isChildActive(taskStatusOf(childThreadId)) || followUpsInFlightRef.current.has(childThreadId)) return;
      const batch = deliverableGuidance(childThreadId).messages;
      if (batch.length) await steerQueued(link, batch);
    };
    const next = (chains.get(childThreadId) ?? Promise.resolve()).then(run, run).catch(() => undefined);
    chains.set(childThreadId, next);
    void next.finally(() => { if (chains.get(childThreadId) === next) chains.delete(childThreadId); });
    return next;
  }, [linksIncludingPending, steerQueued]);

  /** Model-facing delivery state of one guidance entry. Never optimistic. */
  const describeDelivery = useCallback((childThreadId: string, messageId: string, duplicate: boolean): Record<string, unknown> => {
    const message = getChildMailbox(childThreadId)?.messages.find((entry) => entry.id === messageId);
    const base = { childId: childThreadId, messageId, ...(duplicate ? { duplicate: true } : {}) };
    if (!message) return { ...base, state: "unknown", note: "The message is no longer in the bounded mailbox history." };
    const active = isChildActive(taskStatusOf(childThreadId));
    if (message.state === "delivered") {
      if (message.via === "turn") return { ...base, state: "started", note: "The provider accepted a follow-up turn on the child's same conversation. Collect it again for the result." };
      if (message.via === "read") return { ...base, state: "delivered", via: "read", note: "The child's own read_parent_messages call returned this message." };
      return { ...base, state: "delivered", via: "steer", note: "The runtime accepted this message into the child's running turn (written to its input). That does not prove the model has acted on it yet." };
    }
    if (message.state === "delivering") return { ...base, state: "starting", note: "Delivery is in progress. Collect the child or check agent_status; do not resend." };
    if (message.state === "queued") {
      const reason = followUpWaitReasonRef.current.get(childThreadId);
      return {
        ...base,
        state: "queued",
        note: active
          ? `Not delivered yet. ${reason ?? "The child is busy."} The child can also pull it with read_parent_messages. Do not resend.`
          : `Not delivered yet. ${reason ?? "It starts on the child's same conversation when possible."} Do not resend.`,
      };
    }
    return { ...base, state: message.state, delivery: message.uncertain ? "uncertain" : "not_delivered", ...(message.reason ? { reason: message.reason } : {}) };
  }, []);

  const sendToChild = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const rendererGeneration = lifecycleRef.current.generation;
    const ctx = contextRef.current;
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(ctx.links)[childId];
    if (!link || link.sessionId !== request.sessionId) throw new Error(`\`${childId}\` was not started from this thread.`);
    assertParentCollaboration(link, request.sessionId);
    const text = typeof request.arguments.message === "string" ? request.arguments.message : "";
    const replyTo = typeof request.arguments.replyTo === "string" && request.arguments.replyTo ? request.arguments.replyTo : undefined;
    const clientRequestId = typeof request.arguments.clientRequestId === "string" ? request.arguments.clientRequestId : undefined;
    // An uncertain keyed send is retried exactly when the child's state is
    // unclear or has moved on; answer with the retained message, not a refusal.
    const retained = retainedMessageToChild(childId, text, replyTo, clientRequestId);
    if (retained) return describeDelivery(childId, retained.id, true);
    const recovery = await recoverCurrentChild(link);
    if (!await isChildAgentRequestActive(request)) throw new Error("This message belongs to a retired bridge registration.");
    if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) throw new Error("The renderer detached while this message was preparing.");
    if (recovery === "unknown") throw new Error("Mythra Code cannot confirm whether this sub-agent is still running. Collect it again before messaging it.");
    const current = linksIncludingPending(contextRef.current.links)[childId];
    if (!current || current.rootThreadId !== link.rootThreadId || current.sessionId !== link.sessionId) {
      throw new Error("This sub-agent's ownership changed while the message was preparing.");
    }
    assertParentCollaboration(current, request.sessionId);
    const refusal = followUpRefusal(current);
    if (refusal) throw new Error(refusal);
    if (contextRef.current.threadUnavailable?.(childId)) throw new Error("This sub-agent's conversation was archived or removed.");
    if (contextRef.current.threadBusy?.(childId) || contextRef.current.threadBusy?.(current.rootThreadId)) {
      throw new Error("The child or parent conversation is temporarily busy. Retry this message after the operation settles.");
    }
    const livePolicy = childAgentPolicyForSession(contextRef.current.policies, current.sessionId);
    if (contextRef.current.threadUnavailable?.(current.rootThreadId) || !livePolicy?.targets.length) {
      throw new Error("The parent thread is unavailable or its sub-agent policy was switched off.");
    }
    if (rootRunStopped(current.rootThreadId, request.registrationId)) {
      throw new Error("The user stopped this parent run, so this message was not saved. The parent's next user-initiated turn can message this sub-agent.");
    }
    const { message, duplicate } = queueMessageToChild(childId, current.rootThreadId, text, replyTo, clientRequestId);
    if (duplicate) return describeDelivery(childId, message.id, true);
    recordParentActivity(current.rootThreadId, `child-guidance-${childId}-${message.id}`, `Message to sub-agent: ${current.title}`, message.text, childId, "sendInput");
    const running = isChildActive(taskStatusOf(childId)) || recovery === "running";
    if (running) {
      if ((childReadersRef.current.get(childId) ?? 0) > 0) {
        // The child is blocked in read_parent_messages and pulls it now.
        const pulled = await waitForMailbox(() => getChildMailbox(childId)?.messages.find((entry) => entry.id === message.id)?.state !== "queued", 2_000);
        // A read superseded before consuming it must not strand live guidance.
        if (!pulled) {
          if (!await isChildAgentRequestActive(request)) throw new Error("This message belongs to a retired bridge registration.");
          if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) throw new Error("The renderer detached while this message was waiting for its child.");
          await steerPendingGuidance(childId);
        }
      } else if (!followUpsInFlightRef.current.has(childId)) {
        await steerPendingGuidance(childId);
      }
      return describeDelivery(childId, message.id, false);
    }
    await startFollowUp(childId);
    return describeDelivery(childId, message.id, false);
  }, [assertParentCollaboration, describeDelivery, linksIncludingPending, recordParentActivity, recoverCurrentChild, rootRunStopped, startFollowUp, steerPendingGuidance]);

  /** Explicit sign-off by the parent model or by the user. */
  const acceptChild = useCallback(async (rootThreadId: string, childId: string, by: "parent" | "user", note?: string, expectedReviewToken?: string, request?: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const rendererGeneration = lifecycleRef.current.generation;
    const link = linksIncludingPending(contextRef.current.links)[childId];
    if (!link || link.rootThreadId !== rootThreadId) throw new Error(`\`${childId}\` was not started from this thread.`);
    if (link.signoff !== "required") throw new Error("This V1 sub-agent does not require acceptance. Collect its result instead.");
    if (by === "parent") assertParentCollaboration(link, request?.sessionId);
    if (contextRef.current.threadUnavailable?.(childId) || by === "parent"
      && (contextRef.current.threadUnavailable?.(rootThreadId)
        || !childAgentPolicyForSession(contextRef.current.policies, link.sessionId)?.targets.length)) {
      throw new Error("The child or parent conversation is unavailable for acceptance.");
    }
    if (link.acceptedAt) return { childId, phase: "accepted", note: "This sub-agent was already accepted." };
    if (supersededUncertainRef.current.has(childId) || explicitStartsRef.current.has(childId)) {
      throw new Error("This sub-agent has preparing or unconfirmed work. Confirm or stop it before accepting its result.");
    }
    const clickedReviewToken = by === "user" ? expectedReviewToken ?? childReviewToken(link) : expectedReviewToken;
    if (followUpsInFlightRef.current.has(childId)) throw new Error("A follow-up for this sub-agent is starting. Collect it before accepting its work.");
    if (by === "parent" && !expectedReviewToken) throw new Error("Collect this child's settled result and pass its reviewToken before accepting it.");
    const recovery = await recoverCurrentChild(link);
    if (request && !await isChildAgentRequestActive(request)) throw new Error("This acceptance belongs to a retired bridge registration.");
    if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) throw new Error("The renderer detached while this acceptance was preparing.");
    if (recovery) throw new Error("This sub-agent may still be running. Collect it before accepting its work.");
    if (isChildActive(taskStatusOf(childId))) throw new Error("This sub-agent is still working. Collect it (or cancel it) before accepting its work.");
    if (followUpsInFlightRef.current.has(childId)) throw new Error("A follow-up for this sub-agent is starting. Collect it before accepting its work.");
    const current = linksIncludingPending(contextRef.current.links)[childId];
    if (!current || current.rootThreadId !== rootThreadId || current.sessionId !== link.sessionId
      || current.activationPending || pendingActivationsRef.current.has(childId)
      || supersededUncertainRef.current.has(childId) || explicitStartsRef.current.has(childId)) {
      throw new Error("The child's current result is unknown or changed while acceptance was preparing. Collect it again.");
    }
    if (current.signoff !== "required") throw new Error("This assignment no longer has a V2 review contract.");
    if (by === "parent") assertParentCollaboration(current, request?.sessionId);
    if (contextRef.current.threadUnavailable?.(childId) || by === "parent"
      && (contextRef.current.threadUnavailable?.(rootThreadId)
        || !childAgentPolicyForSession(contextRef.current.policies, current.sessionId)?.targets.length)) {
      throw new Error("The child or parent conversation became unavailable while acceptance was preparing.");
    }
    if (!clickedReviewToken || childReviewToken(current) !== clickedReviewToken) {
      throw new Error("That reviewToken describes an older or unknown child result. Collect the current settled result before accepting it.");
    }
    if (getChildMailbox(childId)?.messages.some((message) => message.direction === "toChild" && message.state === "delivering")) {
      throw new Error("Guidance is still being delivered to this child. Collect it before accepting its work.");
    }
    // A correction that failed after this token was collected changed the
    // guidance revision inside the token, so the comparison above refused
    // it; a token collected alongside the reported outcome accepts as is.
    const cancelled = cancelQueuedForChild(childId, `Cancelled because the ${by === "user" ? "user" : "parent"} accepted the sub-agent's work.`);
    // Explicit acceptance is the resolution of every undelivered outcome the
    // accepted token covered (and of the cancellations it just caused).
    resolveGuidanceOutcomes(childId);
    // Sign-off closes open questions without pretending they were answered.
    closeChildMailboxQuestions(childId);
    const acceptNote = note?.replace(/\s+/g, " ").trim().slice(0, 400);
    updateLink(childId, (current) => ({
      ...current,
      acceptedAt: Date.now(),
      acceptedBy: by,
      ...(acceptNote ? { acceptNote } : {}),
    }));
    followUpWaitReasonRef.current.delete(childId);
    recordParentActivity(rootThreadId, `child-accepted-${childId}-${Date.now()}`, `Accepted sub-agent work: ${link.title}`,
      acceptNote || (by === "user" ? "Signed off by the user." : "Signed off by the parent agent."), childId, "close");
    void auditEvent("childAgent.accepted", { childThreadId: childId, by }, rootThreadId);
    contextRef.current.onChildAccepted?.(childId);
    return {
      childId,
      phase: "accepted",
      ...(cancelled ? { cancelledMessages: cancelled } : {}),
      note: "Accepted. This sub-agent is done and can no longer be re-prompted; spawn a new one for more work.",
    };
  }, [assertParentCollaboration, linksIncludingPending, recordParentActivity, recoverCurrentChild, updateLink]);

  const acceptFromBridge = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const childId = String(request.arguments.childId ?? "");
    const link = linksIncludingPending(contextRef.current.links)[childId];
    if (!link || link.sessionId !== request.sessionId) throw new Error(`\`${childId}\` was not started from this thread.`);
    const note = typeof request.arguments.note === "string" ? request.arguments.note : undefined;
    const reviewToken = typeof request.arguments.reviewToken === "string" ? request.arguments.reviewToken : undefined;
    return acceptChild(link.rootThreadId, childId, "parent", note, reviewToken, request);
  }, [acceptChild, linksIncludingPending]);

  const acceptChildAgent = useCallback(async (rootThreadId: string, childThreadId: string, expectedReviewToken?: string): Promise<void> => {
    await acceptChild(rootThreadId, childThreadId, "user", undefined, expectedReviewToken);
  }, [acceptChild]);

  /** The child conversation and root behind an authenticated child session. */
  const childOwnerForSession = useCallback((sessionId: string) => {
    const links = linksIncludingPending(contextRef.current.links);
    const childId = childThreadForBridgeSession(sessionId, links);
    if (!childId) return null;
    const link = links[childId];
    // The durable V2 marker survives switching the global preview off.
    // Legacy/V1 children never gain mailbox authority from a root's mode.
    if (link?.signoff !== "required") return null;
    const provisional = provisionalOwnersRef.current.get(childId);
    const rootThreadId = link?.rootThreadId ?? provisional?.rootThreadId;
    const parentSessionId = link?.sessionId ?? provisional?.sessionId;
    return rootThreadId && parentSessionId ? { childId, rootThreadId, parentSessionId, link } : null;
  }, [linksIncludingPending]);

  const assertChildMailboxOpen = useCallback((owner: NonNullable<ReturnType<typeof childOwnerForSession>>) => {
    const live = contextRef.current;
    if (live.threadUnavailable?.(owner.childId) || live.threadUnavailable?.(owner.rootThreadId)) {
      throw new Error("The child or parent conversation was archived or removed.");
    }
    if (live.threadBusy?.(owner.childId) || live.threadBusy?.(owner.rootThreadId)) {
      throw new Error("The child or parent conversation is temporarily busy.");
    }
    if (!childAgentPolicyForSession(live.policies, owner.parentSessionId)) {
      throw new Error("Your parent conversation no longer exists, so this message was not saved. Finish your turn with a summary.");
    }
    if (owner.link?.acceptedAt) throw new Error("This assignment was already accepted. Its parent mailbox is closed until the user starts new work.");
    if (owner.link?.stopOrigin) throw new Error("This sub-agent was stopped. A retired turn cannot admit or consume new parent messages.");
  }, []);

  /** Comparable identity of the child turn a child mailbox request belongs to. */
  const childRequestIdentity = useCallback((request: ChildAgentRequest): string | undefined => {
    const owner = childOwnerForSession(request.sessionId);
    if (!owner) return undefined;
    const link = owner.link;
    return JSON.stringify([
      owner.childId, owner.rootThreadId, owner.parentSessionId, link?.createdAt, link?.activationId,
      link?.resultRevision ?? 0, link?.stopOrigin ?? "", link?.acceptedAt ?? 0,
      childRunGenerationRef.current.get(owner.childId) ?? 0,
      childStopGenerationRef.current.get(owner.childId) ?? 0,
      stopGenerationRef.current.get(owner.rootThreadId) ?? 0,
    ]);
  }, [childOwnerForSession]);

  const messageParent = useCallback((request: ChildAgentRequest): Record<string, unknown> => {
    const owner = childOwnerForSession(request.sessionId);
    if (!owner) throw new Error("This conversation is not a Mythra Code sub-agent with a parent.");
    const kind = request.arguments.kind === "question" ? "question" : "update";
    const text = typeof request.arguments.message === "string" ? request.arguments.message : "";
    const clientRequestId = typeof request.arguments.clientRequestId === "string" ? request.arguments.clientRequestId : undefined;
    const retained = retainedMessageToParent(owner.childId, kind, text, clientRequestId);
    if (!retained) assertChildMailboxOpen(owner);
    const { message, duplicate } = retained ? { message: retained, duplicate: true }
      : postMessageToParent(owner.childId, owner.rootThreadId, kind, text, clientRequestId);
    const title = owner.link?.title ?? "Sub-agent";
    if (!duplicate) {
      recordParentActivity(owner.rootThreadId, `child-message-${owner.childId}-${message.id}`,
        `${kind === "question" ? "Question" : "Update"} from sub-agent: ${title}`, message.text, owner.childId, "status");
    }
    // A child message never starts a parent turn. A working parent reads it
    // through agent_status/collect_agent; otherwise it waits, visible to the user.
    const parentWorking = isChildActive(taskStatusOf(owner.rootThreadId));
    return {
      messageId: message.id,
      kind,
      state: message.state,
      ...(duplicate ? { duplicate: true } : {}),
      parentWorking,
      note: duplicate ? "This earlier message remains in bounded mailbox history; its current state is returned. This retry did not send a new message." : parentWorking
        ? "Stored in your parent's mailbox. The parent is working and reads it through its own tools; this is not an instant reply. Keep working when you can."
        : "Stored in your parent's mailbox and shown to the user. The parent is not running a turn now, so it reads this only when it next works. Continue with what you can, or end your turn with a clear summary of what you need.",
    };
  }, [assertChildMailboxOpen, childOwnerForSession, recordParentActivity]);

  const readParentMessages = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const owner = childOwnerForSession(request.sessionId);
    if (!owner) throw new Error("This conversation is not a Mythra Code sub-agent with a parent.");
    assertChildMailboxOpen(owner);
    const initialTask = useTaskStore.getState().tasks[owner.childId];
    const runGeneration = childRunGenerationRef.current.get(owner.childId) ?? 0;
    const rendererGeneration = lifecycleRef.current.generation;
    const childGeneration = childStopGenerationRef.current.get(owner.childId) ?? 0;
    const rootGeneration = stopGenerationRef.current.get(owner.rootThreadId) ?? 0;
    const requested = Number(request.arguments.waitSeconds ?? 0);
    const seconds = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_READ_WAIT_SECONDS, requested)) : 0;
    const readers = childReadersRef.current;
    const replayKey = typeof request.arguments.replayKey === "string" ? request.arguments.replayKey : undefined;
    // A retried read with the same key returns the batch an earlier response
    // may have lost. It is a response replay, never a re-delivery or resend.
    const replay = replayKey ? replayReadForChild(owner.childId, replayKey) : [];
    if (replayKey !== undefined && hasChildReadReplay(owner.childId, replayKey)) {
      return { messages: replay.map(mailMessageForModel), replayed: true,
        note: replay.length ? "These messages were already delivered to you by an earlier read with this replayKey; they are repeated because that response may have been lost."
          : "This pull previously returned no guidance. Use a fresh replayKey to read new messages." };
    }
    const readStillCurrent = () => {
      const current = childOwnerForSession(request.sessionId);
      const currentTask = useTaskStore.getState().tasks[owner.childId];
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
        || !current || current.childId !== owner.childId || current.parentSessionId !== owner.parentSessionId
        || current.rootThreadId !== owner.rootThreadId || current.link?.createdAt !== owner.link?.createdAt
        || current.link?.activationId !== owner.link?.activationId || current.link?.acceptedAt !== owner.link?.acceptedAt
        || current.link?.resultRevision !== owner.link?.resultRevision || current.link?.manualAttemptId !== owner.link?.manualAttemptId
        || (childRunGenerationRef.current.get(owner.childId) ?? 0) !== runGeneration
        || (childStopGenerationRef.current.get(owner.childId) ?? 0) !== childGeneration
        || (stopGenerationRef.current.get(owner.rootThreadId) ?? 0) !== rootGeneration
        || initialTask?.activeTurnId && currentTask?.activeTurnId !== initialTask.activeTurnId
        || currentTask?.lastCompletedTurnId !== initialTask?.lastCompletedTurnId) return false;
      try { assertChildMailboxOpen(current); return true; } catch { return false; }
    };
    const abort = new AbortController();
    const cancelSupersededRead = () => { if (!readStillCurrent()) abort.abort(); };
    childWaitersRef.current.add(cancelSupersededRead);
    const unsubscribeTask = useTaskStore.subscribe((state, previous) => {
      const currentTask = state.tasks[owner.childId];
      const previousTask = previous.tasks[owner.childId];
      // Streaming rows and unrelated threads do not change this read's
      // turn identity. Local Stop/ownership changes notify separately.
      if (state.statuses[owner.childId] !== previous.statuses[owner.childId]
        || currentTask?.activeTurnId !== previousTask?.activeTurnId
        || currentTask?.lastCompletedTurnId !== previousTask?.lastCompletedTurnId) cancelSupersededRead();
    });
    readers.set(owner.childId, (readers.get(owner.childId) ?? 0) + 1);
    try {
      if (!deliverableGuidance(owner.childId).messages.length && seconds > 0) {
        await waitForMailbox(() => !readStillCurrent() || deliverableGuidance(owner.childId).messages.length > 0
          || replayKey !== undefined && hasChildReadReplay(owner.childId, replayKey), seconds * 1000, abort.signal);
      }
    } finally {
      childWaitersRef.current.delete(cancelSupersededRead);
      unsubscribeTask();
      const remaining = (readers.get(owner.childId) ?? 1) - 1;
      if (remaining > 0) readers.set(owner.childId, remaining);
      else readers.delete(owner.childId);
    }
    if (!await isChildAgentRequestActive(request)) throw new Error("This mailbox read belongs to a retired bridge registration.");
    const current = childOwnerForSession(request.sessionId);
    if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration
      || !current || current.childId !== owner.childId || current.rootThreadId !== owner.rootThreadId
      || current.parentSessionId !== owner.parentSessionId
      || (childStopGenerationRef.current.get(owner.childId) ?? 0) !== childGeneration
      || (stopGenerationRef.current.get(owner.rootThreadId) ?? 0) !== rootGeneration) {
      throw new Error("This mailbox read was superseded by Stop or changed conversation ownership.");
    }
    const currentTask = useTaskStore.getState().tasks[owner.childId];
    if ((childRunGenerationRef.current.get(owner.childId) ?? 0) !== runGeneration
      || current.link?.createdAt !== owner.link?.createdAt || current.link?.activationId !== owner.link?.activationId
      || current.link?.acceptedAt !== owner.link?.acceptedAt
      || current.link?.resultRevision !== owner.link?.resultRevision || current.link?.manualAttemptId !== owner.link?.manualAttemptId
      || initialTask?.activeTurnId && currentTask?.activeTurnId !== initialTask.activeTurnId
      || currentTask?.lastCompletedTurnId !== initialTask?.lastCompletedTurnId) {
      throw new Error("This mailbox read belongs to an older child turn. The newer turn's guidance was left queued.");
    }
    assertChildMailboxOpen(current);
    // Another pull with the same key may have consumed its batch during our
    // wait/admission await. Replay it before any new atomic consumption.
    const completedReplay = replayKey ? replayReadForChild(owner.childId, replayKey) : [];
    if (replayKey !== undefined && hasChildReadReplay(owner.childId, replayKey)) return {
      messages: completedReplay.map(mailMessageForModel),
      replayed: true,
      note: completedReplay.length ? "This retained batch was already delivered by an earlier read with the same replayKey; no new guidance was consumed."
        : "This pull previously returned no guidance. Use a fresh replayKey to read new messages.",
    };
    const taken = takeQueuedForChild(owner.childId, replayKey, owner.rootThreadId);
    const blocked = !taken.length ? deliverableGuidance(owner.childId).blockedBy : undefined;
    return {
      messages: taken.map(mailMessageForModel),
      note: taken.length
        ? `These parent messages are now marked delivered.${replayKey ? " If this response is lost, read again with the same replayKey to see them again." : ""}`
        : blocked ? `Parent guidance is waiting behind an earlier message (${blocked}) that is still being delivered into your conversation. Continue; it arrives in order.`
        : seconds > 0 ? "No parent message arrived during the wait. That is not an answer; continue or end your turn with a summary." : "No parent messages are waiting.",
    };
  }, [assertChildMailboxOpen, childOwnerForSession]);

  const proposeSettings = useCallback((request: ChildAgentRequest): Record<string, unknown> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This thread is not attached to a project sub-agent policy.");
    const current = ctx.projectSubagentSettingsForThread(policy.rootThreadId);
    const proposedEnabled = typeof request.arguments.enabled === "boolean" ? request.arguments.enabled : current.enabled;
    const rawTargets = Array.isArray(request.arguments.targets)
      ? request.arguments.targets.map((target) => ({ ...(target as Record<string, unknown>), enabled: true }))
      : current.childAgents.targets;
    if (Array.isArray(request.arguments.targets)) {
      for (const candidate of rawTargets) {
        const error = childAgentAutoCompactIssue(candidate as unknown as import("../types").ChildAgentTarget);
        if (error) throw new Error(error);
      }
    }
    const next = sanitizeProjectSubagentSettings({
      // Older tool clients can still send the removed secondary switch.
      // Treat an explicit revocation as the single main switch being off.
      enabled: proposedEnabled && request.arguments.crossProviderEnabled !== false,
      maxConcurrent: request.arguments.maxConcurrent ?? current.maxConcurrent,
      childAgents: { targets: rawTargets },
    });
    if (!next) throw new Error("The proposed project sub-agent settings were invalid.");
    // Only the destinations this proposal would actually switch on have to be
    // usable. A project that keeps a signed-out destination parked and
    // disabled must not block an unrelated change to the parallel limit.
    const proposedCrew = next.childAgents.targets.filter((target) => target.enabled);
    if (next.enabled && next.childAgents.enabled) {
      for (const target of proposedCrew) {
        const issue = childAgentTargetIssue(target, ctx.readiness);
        if (issue) throw new Error(`The proposed \`${target.id}\` destination is not ready: ${issue}`);
      }
    }
    if (next.enabled && next.childAgents.enabled && !proposedCrew.length) {
      throw new Error("Enable at least one configured sub-agent, or propose `enabled: false` to switch sub-agents off.");
    }
    // One project change can be in front of the user at a time. Without this a
    // model that re-proposes on every tool result would bury the approval it
    // is waiting for under its own retries.
    const outstanding = (useTaskStore.getState().tasks[policy.rootThreadId]?.approvals ?? [])
      .some((approval) => approval.method === "openkiwi/subagents/change");
    if (outstanding) {
      throw new Error("A sub-agent settings change is already waiting for the user. Continue with the approved crew until they answer it.");
    }

    const approvalId = `openkiwi-subagents-${request.requestId}`;
    // The reason is the one free-text field a model controls in this dialog.
    // Collapsing its whitespace keeps it a single explanatory line, so it
    // cannot be laid out to imitate the settings block below it.
    const reason = String(request.arguments.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
    const crew = proposedCrew
      .map((target) => {
        const reasoning = target.reasoningMode === "fixed"
          ? `fixed ${target.reasoningEffort}`
          : target.reasoningMode === "agent"
            ? `agent decides up to ${target.reasoningMaxEffort}`
            : "inherits parent";
        const compaction = target.autoCompactTokens === undefined ? "auto-compaction: provider default" : `auto-compaction: ${target.autoCompactTokens.toLocaleString("en-US")} tokens`;
        return `${target.label || target.id}: ${target.provider} / ${childAgentModel(target) || "provider default"} / ${reasoning} / ${compaction}`;
      })
      .join("\n") || "No configured sub-agents";
    useTaskStore.getState().enqueueApproval({
      id: approvalId,
      method: "openkiwi/subagents/change",
      threadId: policy.rootThreadId,
      receivedAt: Date.now(),
      params: {
        title: "Update this project's sub-agents?",
        reason: reason || "The agent requested a project sub-agent crew change.",
        // Everything below the reason is written by Mythra Code from the
        // sanitized settings, so the model cannot dress up what it is asking
        // for — including how long the change lasts.
        command: [
          "Scope: crew and limit saved for this project; spawning switch applies only to this thread, from your next message onward",
          `Sub-agents in this thread: ${next.enabled ? "on" : "off"}`,
          `Parallel limit: ${next.maxConcurrent}`,
          crew,
        ].join("\n"),
        settings: next,
      },
    });
    return {
      approved: false,
      status: "awaiting_user",
      proposalId: approvalId,
      note: "Mythra Code is asking the user to approve this project change. Do not claim it was applied; continue only with the destinations already approved for this turn.",
    };
  }, []);

  /**
   * Apply a project sub-agent change the user just approved. The proposal is
   * re-sanitized here rather than trusted from the queued approval, so the only
   * thing the model ever influenced is what the user was shown.
   */
  const respondToSettingsProposal = useCallback(async (approval: PendingApproval, result: JsonObject): Promise<void> => {
    const decision = String(result.decision ?? "decline");
    const approved = decision === "accept" || decision === "acceptForSession" || decision === "approved" || decision === "approved_for_session";
    const note = (title: string, detail: string) => useTaskStore.getState().upsertActivity(approval.threadId, {
      id: `subagent-settings-${approval.id}`,
      kind: approved ? "agent" : "warning",
      title,
      detail,
      status: "completed",
    });
    if (!approved) {
      note("Sub-agent change declined", "The configured crew, parallel limit, and this thread's spawning switch are unchanged.");
      return;
    }
    const next = sanitizeProjectSubagentSettings(approval.params.settings);
    if (!next) throw new Error("This sub-agent settings proposal is no longer valid.");
    await contextRef.current.applyProjectSubagentSettings(approval.threadId, next);
    note(
      "Sub-agent settings updated",
      "The current turn keeps the crew it started with. Your next message runs with the approved settings.",
    );
  }, []);

  /**
   * Save what the top-bar Run button executes for this thread's project. This
   * is deliberately not an approval: nothing runs until the user clicks the
   * button, and the saved command is shown on it and in its editor.
   */
  const setRunCommand = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This conversation is not inside a saved project, so it has no Run button.");
    const rootThreadId = policy.rootThreadId;
    const command = typeof request.arguments.command === "string" ? request.arguments.command.trim() : "";
    const setupCommand = typeof request.arguments.setupCommand === "string" ? request.arguments.setupCommand.trim() : "";
    const label = typeof request.arguments.label === "string" ? request.arguments.label : "";
    const wantsRun = request.arguments.run === true;
    const existing = ctx.projectRunCommandForThread(rootThreadId);
    const activity = (title: string, detail: string, kind: "agent" | "warning" = "agent") => useTaskStore.getState().upsertActivity(rootThreadId, {
      id: `run-command-${request.requestId}`,
      kind,
      title,
      detail,
      status: "completed",
    });

    let run: ProjectRunCommand | null;
    let saved = false;
    if (command) {
      const next = sanitizeProjectRunCommand({ command, setupCommand, label });
      if (!next) throw new Error(`\`command\` must be a shell command of at most ${MAX_RUN_COMMAND_LENGTH} characters.`);
      // Re-saving an identical command is harmless, but a run request must
      // never silently replace a different saved command with a label-less
      // copy of it; the model passed a new command, so that is what it wants.
      if (!existing || existing.command !== next.command || existing.setupCommand !== next.setupCommand || (existing.label ?? "") !== (next.label ?? "")) {
        await ctx.applyProjectRunCommand(rootThreadId, next);
        saved = true;
      }
      run = next;
    } else if (wantsRun) {
      if (!existing) throw new Error("Nothing is saved for the Run button yet. Pass the command to run; it is saved for next time.");
      run = existing;
    } else {
      await ctx.applyProjectRunCommand(rootThreadId, null);
      activity("Run button cleared", "The top-bar Run button has no command for this project now.");
      void auditEvent("project.runCommand.set", { command: null }, rootThreadId);
      return { saved: true, command: null, note: "The Run button is now cleared for this project." };
    }
    if (saved) void auditEvent("project.runCommand.set", { command: run.command }, rootThreadId);

    if (!wantsRun) {
      activity("Run button updated", `Click Run in the top bar to execute: ${run.command}`);
      return { saved: true, command: run.command, setupCommand: run.setupCommand ?? null, label: run.label ?? null, note: "Saved for this project. Nothing was executed; the user runs it by clicking the Run button in the top bar." };
    }

    // Execution uses the permission captured by this bridge registration,
    // never whichever conversation or composer setting is currently visible.
    const outcome = await ctx.runProjectCommand(rootThreadId, run, policy.permission, async () => {
      if (!await isChildAgentRequestActive(request)) throw new Error("This run request belongs to a retired bridge registration.");
      const live = childAgentPolicyForSession(contextRef.current.policies, request.sessionId);
      if (live?.rootThreadId !== rootThreadId || live.permission !== policy.permission) {
        throw new Error("This conversation's sub-agent policy changed before the command could start.");
      }
    }).catch((reason) => ({ started: false, reason: friendlyError(reason) } as ProjectRunOutcome));
    if (!outcome.started) {
      activity("Run command not started", outcome.reason ?? "The Terminal panel could not start it.", "warning");
      return { saved, command: run.command, setupCommand: run.setupCommand ?? null, label: run.label ?? null, started: false, reason: outcome.reason ?? "The Terminal panel could not start it." };
    }
    activity(saved ? "Run button set and started" : "Run button started", `Running in the Terminal panel: ${run.command}`);
    void auditEvent("project.run", { command: run.command, source: "model" }, rootThreadId);
    return {
      saved,
      command: run.command,
      setupCommand: run.setupCommand ?? null,
      label: run.label ?? null,
      started: true,
      exited: Boolean(outcome.exited),
      output: (outcome.output ?? "").slice(-1_500),
      note: outcome.exited
        ? "The command already exited; read the output above before telling the user it works."
        : "Running in the app's Terminal panel. Use `read_project_terminal` to inspect retained output. The user can stop it with the Stop button next to Run in the top bar.",
    };
  }, []);

  const setCheckCommand = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    if (!policy?.rootThreadId) throw new Error("This conversation is not inside a saved project, so it has no Checks button.");
    const rootThreadId = policy.rootThreadId;
    if (typeof request.arguments.command !== "string") throw new Error("`command` must be a string.");
    const command = request.arguments.command.trim();
    if (command.length > MAX_CHECK_COMMAND_LENGTH) throw new Error("`command` is too long for the Checks button.");
    const current = ctx.projectCheckCommandForThread(rootThreadId);
    if (current?.command === command) return { saved: false, command, note: "This command is already saved for the project." };
    const next = command ? sanitizeProjectCheckCommand({ command }) : null;
    if (command && !next) throw new Error("`command` is not a valid shell command.");
    await ctx.applyProjectCheckCommand(rootThreadId, next ?? null);
    useTaskStore.getState().upsertActivity(rootThreadId, {
      id: `check-command-${request.requestId}`,
      kind: "agent",
      title: next ? "Checks command updated" : "Checks command cleared",
      detail: next ? `Checks button will run: ${next.command}` : "No check command is saved for this project.",
      status: "completed",
    });
    void auditEvent("project.checkCommand.set", { command: next?.command ?? null }, rootThreadId);
    return { saved: true, command: next?.command ?? null, note: "Saved for this project. Nothing was executed." };
  }, []);

  const readTerminal = useCallback(async (request: ChildAgentRequest): Promise<Record<string, unknown>> => {
    const ctx = contextRef.current;
    const policy = childAgentPolicyForSession(ctx.policies, request.sessionId);
    const scope = projectTerminalScopeForSession(request.sessionId);
    if (!policy?.rootThreadId || !scope || ctx.links[policy.rootThreadId] || ctx.nativeLinks?.[policy.rootThreadId]) {
      throw new Error("No active root project terminal bridge is registered for this conversation.");
    }
    if (request.terminalScope !== scope) throw new Error("The terminal request does not match this conversation's captured execution folder.");
    if (Object.keys(request.arguments).some((key) => key !== "maxCharacters")) {
      throw new Error("Only `maxCharacters` is accepted; terminal scope is assigned by the app.");
    }
    const maxCharacters = request.arguments.maxCharacters === undefined ? 12_000 : request.arguments.maxCharacters;
    if (typeof maxCharacters !== "number" || !Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 20_000) {
      throw new Error("`maxCharacters` must be a whole number from 1 to 20000.");
    }
    if (!ctx.readProjectTerminal) throw new Error("The app's Terminal panel is not available to inspect.");
    const snapshot = await ctx.readProjectTerminal(scope, maxCharacters);
    // A session can be revoked or rebound while a controller is resolving.
    const current = contextRef.current;
    if (projectTerminalScopeForSession(request.sessionId) !== scope
      || childAgentPolicyForSession(current.policies, request.sessionId)?.rootThreadId !== policy.rootThreadId
      || current.links[policy.rootThreadId] || current.nativeLinks?.[policy.rootThreadId]) {
      throw new Error("This conversation's terminal bridge changed while its output was being read.");
    }
    if (snapshot.scope !== scope || snapshot.text.length > maxCharacters) {
      throw new Error("The Terminal panel returned output outside the requested scope or character limit.");
    }
    return {
      ...snapshot,
      note: !snapshot.available
        ? "No terminal output is retained for this project in the current app session. Commands outside this Terminal panel or before an app restart are not represented."
        : snapshot.truncated
          ? "This is the retained terminal output tail for the current app session; earlier output was omitted."
          : "This is the retained terminal output for the current app session. Commands outside this Terminal panel or before an app restart are not represented.",
    };
  }, []);

  const handleRequest = useCallback(async (request: ChildAgentRequest): Promise<void> => {
    const rendererGeneration = lifecycleRef.current.generation;
    // Child mailbox tools bind to the child turn that was current when the
    // request arrived. A Stop plus manual continuation during the admission
    // await must not let this older request act on the newer turn.
    const childTool = request.tool === "message_parent" || request.tool === "read_parent_messages";
    const entry = childTool ? childRequestIdentity(request) : undefined;
    try {
      if (!lifecycleRef.current.mounted || !await isChildAgentRequestActive(request)) {
        throw new Error("This request belongs to a retired project bridge registration.");
      }
      if (!lifecycleRef.current.mounted || lifecycleRef.current.generation !== rendererGeneration) throw new Error("The renderer detached before this bridge request was handled.");
      if (childTool && entry !== childRequestIdentity(request)) {
        throw new Error("This request was superseded: the sub-agent was stopped, continued or reassigned while it was being admitted.");
      }
      let result: Record<string, unknown>;
      if (request.tool === "spawn_mythra_agent") result = await spawnChild(request);
      else if (request.tool === "agent_status") result = reportStatus(request);
      else if (request.tool === "collect_agent") result = await collectChild(request);
      else if (request.tool === "cancel_agent") result = await cancelChild(request);
      else if (request.tool === "send_agent_message") result = await sendToChild(request);
      else if (request.tool === "accept_agent") result = await acceptFromBridge(request);
      else if (request.tool === "message_parent") result = messageParent(request);
      else if (request.tool === "read_parent_messages") result = await readParentMessages(request);
      else if (request.tool === "propose_agent_settings") result = await proposeSettings(request);
      else if (request.tool === "set_project_run_command") result = await setRunCommand(request);
      else if (request.tool === "set_project_check_command") result = await setCheckCommand(request);
      else if (request.tool === "read_project_terminal") result = await readTerminal(request);
      else throw new Error(`\`${request.tool}\` is not a sub-agent tool.`);
      await respondToChildAgentRequest(request.requestId, result);
      if (request.tool === "spawn_mythra_agent" && lifecycleRef.current.mounted && typeof result.childId === "string") {
        updateLink(result.childId, (link) => {
          if (link.spawnRequestId !== request.requestId) return link;
          const { spawnRequestId: _request, ...adopted } = link;
          return adopted;
        });
      }
    } catch (reason) {
      const message = friendlyError(reason);
      void auditEvent("childAgent.rejected", { tool: request.tool, reason: message });
      // A refusal is delivered as a tool result, not a transport failure, so
      // the parent model can read why and choose a different destination.
      await respondToChildAgentRequest(request.requestId, null, message).catch(() => undefined);
    } finally {
      // A root bridge request proves its session is registered again (for
      // example after a reload): retry guidance that was waiting for it.
      if (["spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent", "send_agent_message", "accept_agent"].includes(request.tool)
        && childAgentPolicyForSession(contextRef.current.policies, request.sessionId)?.targets.length) {
        schedulePumpRef.current(request.sessionId);
      }
    }
  }, [acceptFromBridge, cancelChild, childRequestIdentity, collectChild, messageParent, proposeSettings, readParentMessages, readTerminal, reportStatus, sendToChild, setCheckCommand, setRunCommand, spawnChild, updateLink]);

  // Tauri events are fire-and-forget. Re-subscribing this listener whenever a
  // child changes state creates a small window with no receiver at all; a tool
  // call emitted in that window then waits until the backend relay timeout and
  // can strand the parent provider inside `collect_agent`. Keep one listener
  // for the lifetime of the hook and route it through the newest callback.
  const handleRequestRef = useRef(handleRequest);
  handleRequestRef.current = handleRequest;

  useEffect(() => {
    lifecycleRef.current.mounted = true;
    return () => {
      lifecycleRef.current.mounted = false;
      lifecycleRef.current.generation += 1;
      scheduledPumpsRef.current.clear();
      notifyChildWaiters();
    };
  }, [notifyChildWaiters]);

  // App-owned availability and persisted ownership may change without a task
  // status event. Existing waits reevaluate their captured identity on render.
  useEffect(() => { notifyChildWaiters(); });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const generation = lifecycleRef.current.generation;
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    bridgeReadyRef.current = ready;
    void ready.catch(() => undefined);
    // Attach first so tools emitted during cleanup have a receiver. They wait
    // behind this renderer's retirement barrier before preparing new work.
    void onChildAgentRequest((request) => {
      void ready.then(() => {
        if (!cancelled && lifecycleRef.current.mounted && lifecycleRef.current.generation === generation) {
          return handleRequestRef.current(request);
        }
      }).catch((reason) => {
        if (!cancelled) void respondToChildAgentRequest(request.requestId, null, `The sub-agent bridge could not finish reload recovery: ${friendlyError(reason)}`).catch(() => undefined);
      });
    }).then(async (dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
      const candidates = Object.values(contextRef.current.links).flatMap((link) => link.spawnRequestId
        ? [{ requestId: link.spawnRequestId, sessionId: link.sessionId, childThreadId: link.childThreadId }] : []);
      spawnReceiptsRef.current = await retireUnclaimedChildAgentSpawns(candidates);
      if (cancelled || !lifecycleRef.current.mounted || lifecycleRef.current.generation !== generation) {
        throw new Error("The renderer detached while its sub-agent bridge was recovering.");
      }
      resolveReady();
    }).catch(rejectReady);
    return () => {
      cancelled = true;
      rejectReady(new Error("The renderer detached before its sub-agent bridge was ready."));
      unlisten?.();
    };
  }, []);

  // Once React sees a just-created persisted link, the temporary mirror is no
  // longer needed. Keeping the mirror until then makes spawn → collect/status
  // calls safe even when both arrive before the next render.
  useEffect(() => {
    for (const [childThreadId, latest] of pendingLinksRef.current) {
      if (context.links[childThreadId] === latest) pendingLinksRef.current.delete(childThreadId);
    }
  }, [context.links, releaseSlot]);

  /** Terminal evidence must belong to this activation before its slot is released. */
  const reconcileChildren = useCallback(() => {
    const links = linksIncludingPending(contextRef.current.links);
    for (const link of Object.values(links)) {
      const id = link.childThreadId;
      const status = taskStatusOf(id);
      if (followUpsInFlightRef.current.has(id) || isChildActive(status) || releasedRef.current.has(id)
        || (status === "idle" && !link.terminalStatus)) continue;
      const activation = pendingActivationsRef.current.get(id);
      const completedId = useTaskStore.getState().tasks[id]?.lastCompletedTurnId;
      const expectedId = activation?.turnId ?? link.activationTurnId;
      const previousId = activation?.previousTurnId ?? link.activationPreviousTurnId;
      if (activation || link.activationPending) {
        if (!completedId || completedId === previousId || (expectedId && completedId !== expectedId)) continue;
      } else if (expectedId && completedId && completedId !== expectedId) continue;
      const terminalStatus = status === "idle" ? childLifecycleForLink(link, status) : childLifecycle(status);
      if (terminalStatus !== "completed" && terminalStatus !== "cancelled" && terminalStatus !== "failed") continue;
      pendingActivationsRef.current.delete(id);
      releasedRef.current.add(id);
      // The turn settled before the current revision began is not this
      // attempt's evidence: never stamp it onto a newer failed attempt.
      const ownTurn = completedId && completedId !== previousId
        && !(link.resultRevision && completedId === link.revisionBaseTurnId) ? completedId : undefined;
      updateLink(id, (current) => ({ ...current, terminalStatus, finishedAt: current.finishedAt ?? Date.now(),
        activationPending: false, ...(ownTurn ? { activationTurnId: ownTurn } : {}) }));
      releaseSlot(link);
      settleChildInParent(link.rootThreadId, id, link.title, terminalStatus, terminalStatus);
      const queued = queuedForChild(id);
      // After a reload local status is idle; the reconciled outcome decides.
      if (queued.length && terminalStatus !== "completed") {
        transitionChildMessage(id, queued.map((message) => message.id), ["queued"], "failed", {
          reason: `The sub-agent's turn ended (${terminalStatus}) before this message was delivered. Send it again to continue the same conversation.`,
        });
      }
      schedulePumpRef.current(link.sessionId);
    }
  }, [linksIncludingPending, releaseSlot, updateLink]);
  reconcileChildrenRef.current = reconcileChildren;

  // Release the backend's concurrency slot as soon as a child's turn reaches a
  // terminal state, and mirror the outcome onto the parent's agent list.
  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, previous) => {
      // beginAgentRun is app-owned admission. Status changes alone may be
      // stale startup events from the stopped run, even after it settled.
      for (const [rootThreadId, stoppedRun] of stoppedRootRunsRef.current) {
        const currentRun = state.tasks[rootThreadId]?.agentRunStartedAt;
        if (stoppedRun.revocation === "revoked" && currentRun !== undefined && currentRun !== stoppedRun.runStartedAt
          && currentRun !== previous.tasks[rootThreadId]?.agentRunStartedAt) {
          stoppedRootRunsRef.current.delete(rootThreadId);
        }
      }
      if (state.statuses === previous.statuses) return;
      // Include links written this tick: a follow-up's activation token must
      // reach its completion release even before React renders it.
      const links = linksIncludingPending(contextRef.current.links);
      for (const link of Object.values(links)) {
        const status = state.statuses[link.childThreadId];
        if (!status || status === "idle") continue;
        if (isChildActive(status)) {
          const newActivation = !isChildActive(previous.statuses[link.childThreadId] ?? "idle");
          if (newActivation && !recoveringChildrenRef.current.has(link.childThreadId)) {
            childRunGenerationRef.current.set(link.childThreadId, (childRunGenerationRef.current.get(link.childThreadId) ?? 0) + 1);
          }
          // A user-typed start already reopened this assignment explicitly
          // (noteExplicitChildStart). Without that evidence, activity on a
          // stopped child is late startup from the stopped work, never a
          // continuation: it keeps its stop. An unstopped child that becomes
          // active by other means falls back to reopening under a new revision.
          const explicit = explicitStartsRef.current.get(link.childThreadId);
          // Any activation while a note is open admits that attempt: a later
          // pre-dispatch refusal can no longer restore the older outcome.
          if (explicit && newActivation) explicit.admitted = true;
          if (newActivation && !recoveringChildrenRef.current.has(link.childThreadId)
            && !followUpsInFlightRef.current.has(link.childThreadId)
            && !link.activationPending && !pendingActivationsRef.current.has(link.childThreadId)) {
            // The note stays until its attempt settles (a pre-dispatch refusal
            // may still roll back). An admission never settled within two
            // minutes is not evidence for activity that begins much later.
            if (explicit && Date.now() - explicit.notedAt < 120_000) { /* reopened at admission */ }
            else if (!link.stopOrigin) {
              if (explicit) explicitStartsRef.current.delete(link.childThreadId);
              const baseTurnId = previous.tasks[link.childThreadId]?.lastCompletedTurnId ?? link.activationTurnId;
              updateLink(link.childThreadId, (current) => {
                const { acceptedAt: _accepted, acceptedBy: _by, acceptNote: _note,
                  terminalStatus: _terminal, finishedAt: _finished, activationTurnId: _turn,
                  activationPreviousTurnId: _previous, manualAttemptId: _attempt, activationStartRequestId: _start, ...reopened } = current;
                return { ...reopened, resultRevision: (current.resultRevision ?? 0) + 1,
                  ...(baseTurnId ? { revisionBaseTurnId: baseTurnId } : {}) };
              });
            }
          }
          // A resumed child can become active after a persisted terminal
          // record. Reopen it so the new turn's actual outcome can settle.
          if (releasedRef.current.has(link.childThreadId)) {
            releasedRef.current.delete(link.childThreadId);
            updateLink(link.childThreadId, (current) => {
              const { terminalStatus: _settled, finishedAt: _finishedAt, ...reopened } = current;
              return reopened;
            });
            const store = useTaskStore.getState();
            store.upsertAgent(link.rootThreadId, {
              id: link.childThreadId,
              prompt: link.title,
              status: childLifecycle(status),
            });
            const spawnActivity = store.tasks[link.rootThreadId]?.activities.find((activity) => activity.id === `child-agent-${link.childThreadId}`);
            if (spawnActivity) store.upsertActivity(link.rootThreadId, { ...spawnActivity, status: "running" });
          }
          continue;
        }
      }
      reconcileChildren();
    });
    return unsubscribe;
  }, [linksIncludingPending, reconcileChildren, updateLink]);

  // A very fast child can finish before its persisted ownership link reaches
  // this hook. Reconcile on every link update so that early completion still
  // releases the backend slot and updates the parent's roster.
  useEffect(() => {
    reconcileChildren();
  }, [context.links, reconcileChildren]);

  // Guidance can survive a reload. Offer it once to every session at mount;
  // sessions that are not registered yet keep it queued until they are.
  useEffect(() => {
    const sessions = new Set(Object.values(contextRef.current.links)
      .filter((link) => queuedForChild(link.childThreadId).length)
      .map((link) => link.sessionId));
    for (const sessionId of sessions) schedulePumpRef.current(sessionId);
  }, []);

  // One bounded mount pass recovers only unresolved links. Adopt a durable
  // initial relay before releasing its slot: until the renderer acknowledges
  // childId, the backend still owns an anonymous spawn reservation.
  useEffect(() => {
    let disposed = false;
    const generation = lifecycleRef.current.generation;
    const candidates = Object.values(contextRef.current.links).filter((link) => link.spawnRequestId
      || link.activationPending || childLifecycleForLink(link, taskStatusOf(link.childThreadId)) === "unknown");
    let next = 0;
    const currentRenderer = () => !disposed && lifecycleRef.current.mounted && lifecycleRef.current.generation === generation;
    const recover = async () => {
      const ready = await bridgeReadyRef.current.then(() => true, () => false);
      if (!ready || !currentRenderer()) return;
      while (currentRenderer() && next < candidates.length) {
        const original = candidates[next++];
        try {
          let link = linksIncludingPending(contextRef.current.links)[original.childThreadId];
          if (!link || link.createdAt !== original.createdAt) continue;
          if (link.spawnRequestId) {
            const requestId = link.spawnRequestId;
            const createdAt = link.createdAt;
            const childId = link.childThreadId;
            const retired = spawnReceiptsRef.current.retired.find((receipt) => receipt.requestId === requestId
              && receipt.sessionId === link!.sessionId && (!receipt.childThreadId || receipt.childThreadId === childId));
            const task = useTaskStore.getState().tasks[childId];
            if (retired && link.activationPending && !link.activationId && !isChildActive(taskStatusOf(childId))
              && !task?.activeTurnId && !task?.lastCompletedTurnId) {
              // The backend retired this exact relay before any dispatch
              // claim: the provisional child never started. Settle it as a
              // visible failure instead of leaving it unknown forever.
              updateLink(childId, (current) => {
                if (current.spawnRequestId !== requestId || current.createdAt !== createdAt || current.activationId || !current.activationPending) return current;
                const { spawnRequestId: _request, activationPending: _pending, ...settled } = current;
                return { ...settled, terminalStatus: "failed", finishedAt: Date.now() };
              });
              useTaskStore.getState().setTaskStatus(childId, "error", "The app reloaded before this sub-agent's first turn was sent. It never started; spawn it again if the work is still needed.");
              releasedRef.current.add(childId);
              settleChildInParent(link.rootThreadId, childId, link.title, "failed", "failed");
              continue;
            }
            // Only a relay the backend still holds as claimed receives this
            // acknowledgement; an unknown relay keeps its pending marker.
            const claimed = spawnReceiptsRef.current.preserved.some((entry) => entry.requestId === requestId && entry.reason === "claimed");
            if (claimed) {
              await respondToChildAgentRequest(requestId, { childId, status: childLifecycleForLink(link, taskStatusOf(childId)) });
              if (!currentRenderer()) return;
              updateLink(childId, (current) => {
                if (current.spawnRequestId !== requestId || current.createdAt !== createdAt) return current;
                const { spawnRequestId: _request, ...adopted } = current;
                return adopted;
              });
            }
            link = linksIncludingPending(contextRef.current.links)[link.childThreadId];
            if (!link) continue;
          }
          if (contextRef.current.threadUnavailable?.(link.childThreadId) || contextRef.current.threadUnavailable?.(link.rootThreadId)
            || contextRef.current.threadBusy?.(link.childThreadId) || contextRef.current.threadBusy?.(link.rootThreadId)) continue;
          // Restore the frozen identity only when the user has not chosen
          // their own settings for this conversation.
          if (!contextRef.current.explicitThreadExecutionFor?.(link.childThreadId)) {
            contextRef.current.persistThreadModel(link.childThreadId, link.model);
            contextRef.current.persistThreadReasoning(link.childThreadId, { reasoningEffort: link.reasoningEffort, ultra: false });
          }
          contextRef.current.persistThreadAutoCompactTokens?.(link.childThreadId, link.autoCompactTokens);
          await recoverCurrentChild(link);
          if (!currentRenderer()) return;
          reconcileChildrenRef.current();
          schedulePumpRef.current(link.sessionId);
        } catch {
          // Transient/ambiguous evidence preserves visible ownership. Parent
          // collection or Stop can explicitly try recovery again.
        }
      }
    };
    void Promise.all([recover(), recover()]);
    return () => { disposed = true; };
  }, [linksIncludingPending, recoverCurrentChild, updateLink]);

  const retryChildAgentGuidance = useCallback((threadId: string): void => {
    const sessions = new Set(Object.values(linksIncludingPending(contextRef.current.links))
      .filter((link) => link.rootThreadId === threadId || link.childThreadId === threadId).map((link) => link.sessionId));
    for (const sessionId of sessions) schedulePumpRef.current(sessionId);
  }, [linksIncludingPending]);

  /** Snapshot exactly the work one Stop targets, before any cutoff is requested. */
  const captureChildStopFrontier = useCallback((rootThreadId: string): ChildStopFrontier => {
    const ctx = contextRef.current;
    const storedPolicy = childAgentPolicyForThread(ctx.policies, rootThreadId);
    const rootPolicy = storedPolicy && childAgentPolicyForSession(ctx.policies, storedPolicy.sessionId);
    const managed = new Map<string, { createdAt: number; resultRevision: number; activationId?: string }>();
    for (const link of Object.values(linksIncludingPending(ctx.links))) {
      if (link.rootThreadId !== rootThreadId && link.childThreadId !== rootThreadId) continue;
      managed.set(link.childThreadId, { createdAt: link.createdAt, resultRevision: link.resultRevision ?? 0, activationId: link.activationId });
    }
    const tasks = useTaskStore.getState().tasks;
    const nativeChildren = nativeChildrenFor(rootThreadId, ctx.nativeLinks);
    const processTurns = new Map<string, { turnId?: string; runStartedAt?: number }>();
    for (const threadId of new Set([rootThreadId, ...nativeChildren.map((agent) => agent.rootThreadId), ...nativeChildren.map((agent) => agent.id)])) {
      const witnessedTurns = new Set(nativeChildren.filter((agent) => agent.rootThreadId === threadId)
        .flatMap((agent) => {
          const turn = ctx.nativeLinks?.[agent.id]?.rootTurnId ?? agent.rootTurnId;
          return turn ? [turn] : [];
        }));
      const durableTurn = witnessedTurns.size === 1 ? [...witnessedTurns][0] : undefined;
      processTurns.set(threadId, { turnId: tasks[threadId]?.activeTurnId ?? durableTurn, runStartedAt: tasks[threadId]?.agentRunStartedAt });
    }
    return {
      rootThreadId,
      rootTurnId: useTaskStore.getState().tasks[rootThreadId]?.activeTurnId,
      rootRunStartedAt: useTaskStore.getState().tasks[rootThreadId]?.agentRunStartedAt,
      rootGeneration: stopGenerationRef.current.get(rootThreadId) ?? 0,
      managed,
      native: new Map(nativeChildren.map((agent) => [agent.id, agent.activationId])),
      processTurns,
      rootActive: rootPolicy?.collaborationV2 === true
        && (isChildActive(taskStatusOf(rootThreadId)) || Boolean(useTaskStore.getState().workflowOwners[rootThreadId])),
      ...(rootPolicy?.collaborationV2 === true ? { rootBridge: {
        sessionId: rootPolicy.sessionId, registrationId: childAgentRegistrationForSession(rootPolicy.sessionId),
      } } : {}),
    };
  }, [linksIncludingPending]);
  /** Invalidation/cancellation runs once per Stop operation, not once per wave. */
  const appliedFrontiersRef = useRef(new WeakSet<ChildStopFrontier>());
  const rootRevocationsRef = useRef(new WeakMap<ChildStopFrontier, Promise<string | undefined>>());

  const cancelChildAgentsFor = useCallback(async (rootThreadId: string, frontier?: ChildStopFrontier): Promise<void> => {
    const stop = frontier && frontier.rootThreadId === rootThreadId ? frontier : captureChildStopFrontier(rootThreadId);
    const rootAdvanced = () => {
      const task = useTaskStore.getState().tasks[rootThreadId];
      return Boolean(task?.activeTurnId && task.activeTurnId !== stop.rootTurnId)
        || task?.agentRunStartedAt !== undefined && task.agentRunStartedAt !== stop.rootRunStartedAt;
    };
    // A turn/start acknowledgement can supply a turn ID after Stop captured
    // the original starting run. Only app-owned admission stamps new work.
    const rootAdmissionAdvanced = () => {
      const startedAt = useTaskStore.getState().tasks[rootThreadId]?.agentRunStartedAt;
      return startedAt !== undefined && startedAt !== stop.rootRunStartedAt;
    };
    // Captured work, or a child the stopped root was still starting. A later
    // explicit activation (new revision/follow-up token) or a newer root
    // turn's spawn is not this Stop's work.
    const managedInStop = (link: ChildAgentLink) => {
      const entry = stop.managed.get(link.childThreadId);
      if (entry) return entry.createdAt === link.createdAt && entry.resultRevision === (link.resultRevision ?? 0) && entry.activationId === link.activationId;
      if (rootAdvanced()) return false;
      const generation = spawnGenerationsRef.current.get(link.childThreadId);
      return generation === undefined || generation <= stop.rootGeneration;
    };
    const nativeInStop = (agent: NativeChild) => stop.native.has(agent.id)
      ? stop.native.get(agent.id) === agent.activationId : !rootAdvanced();
    if (!appliedFrontiersRef.current.has(stop)) {
      appliedFrontiersRef.current.add(stop);
      if (stop.rootActive && !rootAdmissionAdvanced()) {
        const stoppedRun = {
          runStartedAt: stop.rootRunStartedAt, sessionId: stop.rootBridge?.sessionId, registrationId: stop.rootBridge?.registrationId,
          revocation: "pending" as "pending" | "revoked" | "failed",
        };
        stoppedRootRunsRef.current.set(rootThreadId, stoppedRun);
        if (stop.rootBridge) {
          rootRevocationsRef.current.set(stop, revokeRootChildAgentRegistration(
            stop.rootBridge.sessionId, stop.rootBridge.registrationId, () => !rootAdmissionAdvanced(),
          ).then(() => {
            stoppedRun.revocation = "revoked";
            if (stoppedRootRunsRef.current.get(rootThreadId) === stoppedRun) rootRunStopped(rootThreadId);
            return undefined;
          }, (reason) => {
            stoppedRun.revocation = "failed";
            return `Could not revoke the stopped parent's sub-agent registration: ${friendlyError(reason)}`;
          }));
        }
      }
      invalidateChildAgentGuidance(rootThreadId, "The user stopped this run.");
      // Settle queued guidance before any cutoff so Stop cannot trigger a
      // boundary follow-up.
      cancelQueuedForRoot(rootThreadId, "The user stopped this run.");
    }
    const rootRevocation = rootRevocationsRef.current.get(stop) ?? Promise.resolve(undefined);
    // Mark every live managed child of this Stop as user-stopped. A child
    // that had already settled (awaiting review or accepted) was not
    // stopped: its queued guidance is cancelled above and nothing can restart
    // it without a new, user-initiated parent turn. Marking it user-stopped
    // would close it to that next turn for good. This includes a settled
    // child whose own conversation is archived or deleted.
    for (const link of Object.values(linksIncludingPending(contextRef.current.links))) {
      if (link.rootThreadId !== rootThreadId && link.childThreadId !== rootThreadId) continue;
      if (!managedInStop(link)) continue;
      if ((link.childThreadId !== rootThreadId || link.signoff === "required") && !childNeedsCutoff(link) && !link.activationPending
        && !followUpsInFlightRef.current.has(link.childThreadId) && !pendingActivationsRef.current.has(link.childThreadId)) continue;
      updateLink(link.childThreadId, (current) => ({ ...current, stopOrigin: "user" }));
    }
    const attempted = new Set<string>();
    // Runtime-native spawns can arrive while the first cutoff wave settles.
    // Rescan a bounded number of waves, retaining visible uncertainty if the
    // runtime continues to create or reactivate work after Stop.
    for (let wave = 0; wave <= 3; wave += 1) {
      const ctx = contextRef.current;
      const allLinks = linksIncludingPending(ctx.links);
      const running = Object.values(allLinks).filter((link) => (link.rootThreadId === rootThreadId || link.childThreadId === rootThreadId)
        && managedInStop(link) && childNeedsCutoff(link));
      const ownedIds = new Set(Object.values(allLinks)
        .filter((link) => link.rootThreadId === rootThreadId)
        .map((link) => link.childThreadId));
      const nativeChildren = nativeChildrenFor(rootThreadId, ctx.nativeLinks);
      const native = nativeChildren.filter((agent) => (
        !ownedIds.has(agent.id) && isActiveAgentRecord(agent.status) && nativeInStop(agent)
      ));
      if (!running.length && !native.length) {
        const failure = await rootRevocation;
        if (failure) throw new Error(failure);
        return;
      }
      if (wave === 3 || [...running.map((link) => link.childThreadId), ...native.map((agent) => agent.id)].some((id) => attempted.has(id))) {
        throw new Error("Could not confirm every sub-agent stopped: the runtime created or reactivated work while Stop was settling. Remaining workers are still visible.");
      }
      for (const id of [...running.map((link) => link.childThreadId), ...native.map((agent) => agent.id)]) attempted.add(id);
      const claudeNative = native.filter((agent) => agent.runtime === "claude" || agent.provider === "claude" || agent.id.startsWith("claude-native:"));
      const claudeNativeIds = new Set(claudeNative.map((agent) => agent.id));
      const claudeParents = new Map(nativeChildren
        .filter((agent) => !ownedIds.has(agent.id) && (agent.runtime === "claude" || agent.provider === "claude" || agent.id.startsWith("claude-native:")))
        .map((agent) => [agent.id, agent.rootThreadId]));
      const claudeRoots = new Map<string, NativeChild[]>();
      for (const agent of claudeNative) {
        let processThreadId = agent.rootThreadId;
        const seen = new Set([agent.id]);
        while (claudeParents.has(processThreadId) && !seen.has(processThreadId)) {
          seen.add(processThreadId);
          processThreadId = claudeParents.get(processThreadId)!;
        }
        claudeRoots.set(processThreadId, [...(claudeRoots.get(processThreadId) ?? []), agent]);
      }
      // Dispatch every provider cutoff before awaiting any one runtime.
      const results = await Promise.allSettled([
        rootRevocation.then((failure) => { if (failure) throw new Error(failure); }),
        ...running.map(async (link) => {
          try {
            const assertCurrent = childObservationGuard(link);
            await ensureChildHydrated(link, assertCurrent).catch(() => undefined);
            assertCurrent();
            const status = await hardStopChild(link.provider, link.childThreadId, undefined, ctx, link, managedCutoffGuard(link));
            settleManagedCutoff(link, status);
          } catch (reason) {
            throw new Error(`Could not stop ${link.title}: ${friendlyError(reason)}`);
          }
        }),
        ...native.filter((agent) => !claudeNativeIds.has(agent.id)).map(async (agent) => {
          try {
            const status = await stopCodexChild(agent.id, undefined, () => assertNativeChildActivation(agent));
            settleStoppedChild(agent.rootThreadId, agent.id, agent.prompt, status);
            persistNativeSettlement(ctx.nativeLinks?.[agent.id], status);
          } catch (reason) {
            throw new Error(`Could not stop ${agent.prompt || "native sub-agent"}: ${friendlyError(reason)}`);
          }
        }),
        ...[...claudeRoots].map(async ([processThreadId, agents]) => {
          // Target the process turn this Stop froze, never whatever turn the
          // process runs now: a newer user turn must survive a later wave.
          const frozen = stop.processTurns.get(processThreadId);
          const live = useTaskStore.getState().tasks[processThreadId];
          if (!frozen?.turnId) {
            throw new Error("The original Claude process identity is unavailable. It was not stopped by this older request; open its parent conversation and stop the current run explicitly.");
          }
          if (!frozen || live?.activeTurnId && live.activeTurnId !== frozen.turnId
            || live?.agentRunStartedAt !== undefined && live.agentRunStartedAt !== frozen.runStartedAt) {
            throw new Error("A newer turn now owns this Claude process, so it was not stopped. The earlier native worker's status remains unknown.");
          }
          const rootTurnId = frozen.turnId;
          try {
            await hardStopChild("claude", processThreadId, rootTurnId, ctx);
          } catch (reason) {
            const currentTurnId = useTaskStore.getState().tasks[processThreadId]?.activeTurnId;
            if (currentTurnId && currentTurnId !== rootTurnId) {
              throw new Error("Claude started another root turn while Stop was settling. Native worker status remains unknown.");
            }
            throw reason;
          }
          const currentTurnId = useTaskStore.getState().tasks[processThreadId]?.activeTurnId;
          if (currentTurnId && currentTurnId !== rootTurnId) {
            throw new Error("Claude started another root turn while Stop was settling. Native worker status remains unknown.");
          }
          for (const agent of agents) {
            const current = useTaskStore.getState().tasks[agent.rootThreadId]?.agents.find((entry) => entry.id === agent.id);
            if (current && !isActiveAgentRecord(current.status)) continue;
            if (current?.createdAt !== undefined && agent.createdAt !== undefined && current.createdAt !== agent.createdAt) {
              throw new Error("A newer Claude native worker appeared while Stop was settling. Its status remains unknown.");
            }
            // Synthetic Claude IDs never create independent app thread state.
            settleChildInParent(agent.rootThreadId, agent.id, agent.prompt, "interrupted", "cancelled");
            persistNativeSettlement(ctx.nativeLinks?.[agent.id], "interrupted");
          }
        }),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [friendlyError(result.reason)] : []);
      if (failures.length) throw new Error(failures.join("\n"));
    }
  }, [captureChildStopFrontier, childNeedsCutoff, childObservationGuard, invalidateChildAgentGuidance, linksIncludingPending, managedCutoffGuard, persistNativeSettlement, rootRunStopped, settleManagedCutoff, updateLink]);

  return {
    acceptChildAgent, cancelChildAgentsFor, captureChildStopFrontier, getManagedSubagentV2LockedReason,
    hasChildStartInFlight, invalidateChildAgentGuidance, managedSubagentV2LockRevision,
    noteExplicitChildStart, respondToSettingsProposal, retryChildAgentGuidance, settleExplicitChildStart, stopChildAgent,
  };
}

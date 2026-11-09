import type { TaskStatus } from "./taskStore";
import type { PermissionMode, Provider, SubagentEngine } from "../types";

/**
 * One managed parent run: the record that keeps a parent responsible for the
 * work it delegated after its own provider turn ended.
 *
 * A parent's model can end its turn while its sub-agents still work. Nothing
 * here depends on what the model said. Only durable child state can wake the
 * parent, through one bounded, visible continuation turn on its own captured
 * execution identity, and no provider process stays alive in the meantime.
 *
 * This module is pure and imports only types, so the task store can use it
 * without an import cycle. Every transition returns a new record, the same
 * record for no change, or null to delete the run.
 */

export const PARENT_RUN_CHECKPOINT_LABEL = "Review sub-agent results";
export const PARENT_NOTICE_PROVENANCE = "mythra-notice" as const;

export type ParentRunPhase = "active" | "waiting" | "continuing" | "paused";

export type ParentRunPauseReason =
  | "restart"
  | "start_uncertain"
  | "parent_failed"
  | "delivery_failed"
  | "no_progress"
  | "budget"
  | "execution_changed";

/** The exact identity an automatic continuation must keep, or pause. */
export interface ParentExecution {
  provider: Provider;
  model: string;
  reasoningEffort: string;
  ultra: boolean;
  serviceTier: string | null;
  permission: PermissionMode;
  engine: SubagentEngine;
  subagentsEnabled: boolean;
  executionPath: string;
  sessionId: string;
  policyCapturedAt: number;
  /** LM Studio's server. Other providers keep this empty. */
  endpoint: string;
  /** Null when the account or billing mode could not be established. */
  authKey: string | null;
  authGeneration: number;
}

export interface ParentRun {
  id: string;
  rootThreadId: string;
  sessionId: string;
  phase: ParentRunPhase;
  /** `agentRunId` of the root run this record currently follows. */
  ownerRunId?: string;
  /** Turn presented as waiting or paused while this run stays open. */
  yieldedTurnId?: string;
  resumesUsed: number;
  dispatchId?: string;
  /** Latest settled root turn when the dispatch was claimed. */
  dispatchBaseTurnId?: string;
  /** Progress fingerprint when the last continuation was claimed. */
  progress?: string;
  /**
   * Attention signals already announced to the parent, each kept only while
   * its evidence is current: `childId:messageId` for an open question and
   * `childId#result:reviewToken` for a result to collect. Undelivered
   * guidance has its own message key. The original field name keeps saved
   * runs compatible.
   */
  wokenQuestions: string[];
  execution: ParentExecution;
  pause?: { reason: ParentRunPauseReason; detail?: string };
  /**
   * True only in the renderer session that captured this run's delivery
   * context. It is never read back from storage, so a loaded run can never
   * start a model turn on its own.
   */
  autoResume?: true;
}

export type ParentObligationState = "none" | "working" | "unknown" | "needs_collect" | "needs_signoff" | "needs_response" | "needs_wrapup" | "resolved";

export interface ParentObligationEvidence {
  childId: string;
  title: string;
  accepted: boolean;
  /** The user signed this off in the crew panel, not the parent. */
  acceptedByUser: boolean;
  userStopped: boolean;
  /** Active status, a start being prepared, or guidance still to deliver. */
  working: boolean;
  lifecycle: string;
  reviewToken?: string;
  collectedToken?: string;
  /** A V2 assignment requires an explicit parent or user sign-off. */
  signoffRequired: boolean;
  openQuestions: string[];
  /** Open questions with replies already queued or being delivered. */
  pendingQuestionReplies?: string[];
  /** Exact unresolved guidance messages, including a marker for trimmed history. */
  undeliveredGuidance?: string[];
  resultRevision: number;
  followUps: number;
  /** Guidance admission/delivery advances work even before a new turn starts. */
  guidanceProgress?: string[];
  /** Initial assignment preparation has not confirmed the child start yet. */
  pendingStart?: true;
  /** A real child's provider activation has not been confirmed. */
  unconfirmedStart?: true;
  /** The user is taking this conversation over; a rollback can still restore it. */
  manualTakeover?: true;
}

export interface ParentObligation extends ParentObligationEvidence {
  state: ParentObligationState;
}

/**
 * What a child still needs from its parent.
 *
 * Successful V2 work needs an explicit sign-off of the exact collected result.
 * Collecting failed or cancelled work settles the result review. An open
 * question still needs a response. A user stop clears both obligations, and
 * a stopped child is never restarted automatically.
 */
export function classifyParentObligation(evidence: ParentObligationEvidence): ParentObligationState {
  if (evidence.userStopped) return "none";
  if (evidence.accepted) {
    // The user's sign-off settles the child, not the parent's answer. A parent
    // that never read this result still owes one, usually its last words being
    // a status line. One that already read it owes nothing: no bookkeeping turn.
    return evidence.acceptedByUser && evidence.reviewToken && evidence.reviewToken !== evidence.collectedToken ? "needs_wrapup" : "none";
  }
  if (evidence.working) return "working";
  if (evidence.lifecycle === "unknown" || !evidence.reviewToken) return "unknown";
  if (evidence.reviewToken !== evidence.collectedToken) return "needs_collect";
  if (evidence.signoffRequired && evidence.lifecycle === "completed") return "needs_signoff";
  return evidence.openQuestions.length ? "needs_response" : "resolved";
}

function isBlocking(obligation: ParentObligation): boolean {
  return obligation.state !== "none" && obligation.state !== "resolved" && obligation.state !== "needs_wrapup";
}

function owesTurn(entry: ParentObligation): boolean {
  return isBlocking(entry) || entry.state === "needs_wrapup";
}

/** A child still needs something. Nothing here can be settled by the user alone. */
export function parentRunBlocked(obligations: readonly ParentObligation[]): boolean {
  return obligations.some(isBlocking);
}

/**
 * The parent still owes a turn. Wider than blocked: a user sign-off leaves a
 * wrap-up owed while the run is followed. It is never a reason to hold a pause
 * open, because automatic work has already ended by then.
 */
function parentRunOwesTurn(obligations: readonly ParentObligation[]): boolean {
  return obligations.some(owesTurn);
}

/**
 * A stable digest of everything a continuation can advance: collecting,
 * accepting, answering, continuing or spawning all change it.
 */
export function parentRunProgress(obligations: readonly ParentObligation[]): string {
  return JSON.stringify([...obligations]
    .sort((left, right) => left.childId.localeCompare(right.childId))
    .map((entry) => [entry.childId, entry.lifecycle, entry.resultRevision, entry.followUps,
      entry.reviewToken ?? "", entry.collectedToken ?? "", entry.accepted, entry.userStopped, [...entry.openQuestions].sort(),
      entry.guidanceProgress ?? [], entry.undeliveredGuidance ?? []]));
}

function questionKey(entry: ParentObligation, message: string): string {
  return `${entry.childId}:${message}`;
}

function resultKey(entry: ParentObligation): string | undefined {
  return entry.reviewToken ? `${entry.childId}#result:${entry.reviewToken}` : undefined;
}

function guidanceKey(entry: ParentObligation, message: string): string {
  return `${entry.childId}#guidance:${message}`;
}

/** Only the user can unblock this child right now. */
function heldForUser(entry: ParentObligation, approvalChildren: readonly string[]): boolean {
  return approvalChildren.includes(entry.childId);
}

function canActOn(entry: ParentObligation, approvalChildren: readonly string[]): boolean {
  return owesTurn(entry) && !entry.manualTakeover && !entry.pendingStart && !entry.unconfirmedStart && entry.lifecycle !== "unknown"
    && !heldForUser(entry, approvalChildren);
}

function questionsNeedingReply(entry: ParentObligation): string[] {
  return isBlocking(entry) ? entry.openQuestions.filter((id) => !entry.pendingQuestionReplies?.includes(id)) : [];
}

function isSettled(entry: ParentObligation): boolean {
  return entry.state === "needs_collect" || entry.state === "needs_signoff" || entry.state === "needs_response" || entry.state === "needs_wrapup";
}

function guidanceNeedingReview(entry: ParentObligation): readonly string[] {
  return entry.state === "working" || entry.state === "needs_collect" ? entry.undeliveredGuidance ?? [] : [];
}

/**
 * Signals that each need the parent on their own, even while siblings work:
 * an open question needing a reply, undelivered guidance while the child is
 * still working, and a result it has not collected. A collected result already
 * binds to its undelivered guidance, and sign-off on it waits for the settled
 * check instead.
 */
function attentionKeys(obligations: readonly ParentObligation[], approvalChildren: readonly string[]): string[] {
  return obligations.flatMap((entry) => {
    if (!canActOn(entry, approvalChildren)) return [];
    const result = entry.state === "needs_collect" ? resultKey(entry) : undefined;
    return [
      ...questionsNeedingReply(entry).map((message) => questionKey(entry, message)),
      ...guidanceNeedingReview(entry).map((message) => guidanceKey(entry, message)),
      ...(result ? [result] : []),
    ];
  });
}

function hasNewAttention(run: ParentRun, keys: readonly string[]): boolean {
  return keys.some((key) => !run.wokenQuestions.includes(key));
}

/** Every key whose evidence is still current, whether or not it can wake now. */
function currentAttentionKeys(obligations: readonly ParentObligation[]): Set<string> {
  return new Set(obligations.flatMap((entry) => {
    if (entry.state === "none") return [];
    const result = resultKey(entry);
    return [
      ...entry.openQuestions.map((message) => questionKey(entry, message)),
      ...(entry.undeliveredGuidance ?? []).map((message) => guidanceKey(entry, message)),
      ...(result ? [result] : []),
    ];
  }));
}

/**
 * What one continuation announces and consumes: the signals it can act on
 * now, plus earlier announcements whose evidence is unchanged. A signal held
 * on the user's approval is neither announced nor consumed, so it can still
 * wake the parent once the approval clears. Retired evidence drops out, which
 * keeps this list bounded.
 */
export function wokenParentQuestions(obligations: readonly ParentObligation[], approvalChildren: readonly string[] = [], previous: readonly string[] = []): string[] {
  const current = currentAttentionKeys(obligations);
  return [...new Set([...previous.filter((key) => current.has(key)), ...attentionKeys(obligations, approvalChildren)])];
}

export interface ParentAttention {
  notice: string;
  progress: string;
  wokenQuestions: string[];
}

/** One snapshot decides the notice, the progress digest and what is consumed. */
export function parentRunAttention(noticeId: string, run: ParentRun, obligations: readonly ParentObligation[], approvalChildren: readonly string[]): ParentAttention {
  return {
    notice: buildParentNotice(noticeId, obligations, approvalChildren),
    progress: parentRunProgress(obligations),
    wokenQuestions: wokenParentQuestions(obligations, approvalChildren, run.wokenQuestions),
  };
}

function pausedRun(run: ParentRun, reason: ParentRunPauseReason, detail?: string): ParentRun {
  const { dispatchId: _dispatch, dispatchBaseTurnId: _base, ...settled } = run;
  return { ...settled, phase: "paused", pause: { reason, ...(detail ? { detail } : {}) } };
}

export { pausedRun as pausedParentRun };

/**
 * Whether the user's typed message keeps following this paused run instead of
 * retiring it. Typing is the user acting in this conversation, so automatic
 * follow-up may resume for work that is still running, as it already does for a
 * message sent while waiting. Settled work gives no such reason: the parent can
 * collect it in this turn, and nothing should stay armed behind a new request.
 *
 * A loaded run never qualifies, and neither does a start nobody can confirm.
 * This is called only for typed messages. Queued, timed and generated prompts
 * are not the user answering this pause, so they never reach it.
 */
export function pausedRunFollowsTypedTurn(run: ParentRun, obligations: readonly ParentObligation[]): boolean {
  return Boolean(run.autoResume) && run.phase === "paused" && run.pause?.reason !== "start_uncertain"
    && obligations.some((entry) => entry.state === "working" && !entry.pendingStart && !entry.unconfirmedStart && !entry.manualTakeover);
}

/** A new root run begins. Pure: the store owns the write. */
export function parentRunAtRunStart(run: ParentRun, agentRunId: string, dispatchId?: string, keepPaused = false): ParentRun | null {
  if (dispatchId) return run.dispatchId === dispatchId ? { ...run, ownerRunId: agentRunId } : run;
  // A loaded or paused run does not follow new work by default: its obligations
  // end here rather than attaching to a later, possibly unrelated, request.
  // `resumesUsed` survives a kept run: only Continue grants a fresh limit.
  if (!run.autoResume || (run.phase === "paused" && !keepPaused)) return null;
  const { dispatchId: _dispatch, dispatchBaseTurnId: _base, pause: _pause, ...followed } = run;
  return { ...followed, phase: "active", ownerRunId: agentRunId };
}

export interface ParentTurnEnd {
  status: TaskStatus;
  completedTurnId?: string;
  agentRunId?: string;
  obligations: readonly ParentObligation[];
  approvalChildren: readonly string[];
}

/** Runs inside the same store transaction that completes the turn. */
export function parentRunAtTurnEnd(run: ParentRun, end: ParentTurnEnd): ParentRun | null {
  // An unconfirmed start that turns out to have run is an ordinary continuation.
  const confirmedStart = run.phase === "paused" && run.pause?.reason === "start_uncertain"
    && Boolean(run.autoResume) && run.ownerRunId === end.agentRunId;
  if (run.phase !== "active" && run.phase !== "continuing" && !confirmedStart) return run;
  // A reservation has no root run yet. A loaded run has no captured owner, and
  // any run that started after loading has already replaced it.
  if (run.phase === "continuing" && !run.ownerRunId) return run;
  if (run.autoResume && run.ownerRunId !== end.agentRunId) return run;
  // A repeated terminal event for the turn before this dispatch is not this
  // continuation ending.
  if (end.completedTurnId && end.completedTurnId === run.dispatchBaseTurnId) return run;
  if (!parentRunOwesTurn(end.obligations)) return null;
  const { dispatchId: _dispatch, dispatchBaseTurnId: _base, pause: _pause, ...open } = run;
  const settled: ParentRun = { ...open, ...(end.completedTurnId ? { yieldedTurnId: end.completedTurnId } : {}) };
  if (!run.autoResume) return pausedRun(settled, "restart");
  if (end.status !== "completed") return pausedRun(settled, "parent_failed");
  if ((run.phase === "continuing" || confirmedStart) && parentRunProgress(end.obligations) === run.progress) {
    // A running child can keep this run waiting if it can move forward on its
    // own, including when an answer is already on its way. An unanswered
    // question on that same child can otherwise leave both sides waiting.
    const canProgress = end.obligations.some((entry) => entry.state === "working"
      && !entry.manualTakeover && !entry.unconfirmedStart && entry.lifecycle !== "unknown"
      && !heldForUser(entry, end.approvalChildren) && !questionsNeedingReply(entry).length && !guidanceNeedingReview(entry).length);
    const attention = attentionKeys(end.obligations, end.approvalChildren);
    const needsParent = attention.length > 0 || end.obligations.some((entry) => canActOn(entry, end.approvalChildren) && isSettled(entry));
    if (needsParent && !canProgress && !hasNewAttention(run, attention)) {
      return pausedRun(settled, "no_progress");
    }
  }
  return { ...settled, phase: "waiting" };
}

export interface ParentRunClaim {
  dispatchId: string;
  dispatchBaseTurnId?: string;
  progress: string;
  wokenQuestions: string[];
  /** The user pressed Continue: a fresh authorization, not an automatic resume. */
  explicit?: boolean;
}

export function claimParentRun(run: ParentRun, claim: ParentRunClaim): ParentRun {
  const { pause: _pause, ownerRunId: _owner, ...open } = run;
  return {
    ...open,
    phase: "continuing",
    dispatchId: claim.dispatchId,
    ...(claim.dispatchBaseTurnId ? { dispatchBaseTurnId: claim.dispatchBaseTurnId } : {}),
    progress: claim.progress,
    wokenQuestions: claim.wokenQuestions,
    // Unlimited runs still count, bounded so the count stays an exact integer.
    resumesUsed: claim.explicit ? 0 : Math.min(run.resumesUsed + 1, Number.MAX_SAFE_INTEGER),
    ...(claim.explicit ? { autoResume: true as const } : {}),
  };
}

/** Whether another automatic continuation fits the current host limit. */
export function parentResumesRemain(run: ParentRun, limit: number | null): boolean {
  return limit === null || run.resumesUsed < limit;
}

export interface ParentRunEnvironment {
  obligations: readonly ParentObligation[];
  rootActive: boolean;
  /** The root ended in a state the queue will not continue from by itself. */
  rootStopped: boolean;
  workflowOwned: boolean;
  unavailable: boolean;
  /** Children only the user can unblock. Their questions cannot wake the parent. */
  approvalChildren: readonly string[];
  /** A different conversation is working in this shared folder right now. */
  folderBusy: boolean;
  /** Head of the user's FIFO queue, ignoring timed prompts not yet released. */
  queue: "none" | "pending" | "held";
  hasDelivery: boolean;
  hydrated: boolean;
  /** The saved app-wide follow-up limit now; null is unlimited. */
  resumeLimit: number | null;
}

export type ParentRunDecision =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "pause"; reason: ParentRunPauseReason }
  | { kind: "resume" };

function shouldWake(run: ParentRun, obligations: readonly ParentObligation[], approvalChildren: readonly string[]): boolean {
  if (hasNewAttention(run, attentionKeys(obligations, approvalChildren))) return true;
  const open = obligations.filter(owesTurn);
  return open.length > 0 && open.every(isSettled)
    && open.some((entry) => canActOn(entry, approvalChildren));
}

/** What this run should do now. Holds return "none" and re-evaluate on events. */
export function decideParentRun(run: ParentRun, environment: ParentRunEnvironment): ParentRunDecision {
  const blocked = parentRunBlocked(environment.obligations);
  if (run.phase === "continuing") return { kind: "none" };
  if (run.phase === "active") {
    return !run.autoResume && blocked ? { kind: "pause", reason: "restart" } : { kind: "none" };
  }
  // Keep an unresolved provider dispatch visible until its ownership settles,
  // even if the user signed off the last child while it was being sent.
  if (run.phase === "paused" && run.pause?.reason === "start_uncertain" && environment.rootActive) return { kind: "none" };
  if (run.phase === "paused") return blocked ? { kind: "none" } : { kind: "clear" };
  if (!parentRunOwesTurn(environment.obligations)) return { kind: "clear" };
  if (environment.rootActive || environment.workflowOwned || environment.unavailable) return { kind: "none" };
  if (environment.rootStopped) return { kind: "pause", reason: "parent_failed" };
  if (environment.queue !== "none" || environment.folderBusy || !shouldWake(run, environment.obligations, environment.approvalChildren)) return { kind: "none" };
  if (!run.autoResume) return { kind: "pause", reason: "restart" };
  if (!parentResumesRemain(run, environment.resumeLimit)) return { kind: "pause", reason: "budget" };
  if (!environment.hasDelivery || !environment.hydrated) return { kind: "pause", reason: "execution_changed" };
  return { kind: "resume" };
}

function validExecution(value: unknown): ParentExecution | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ParentExecution>;
  if (typeof entry.provider !== "string" || typeof entry.model !== "string" || typeof entry.sessionId !== "string") return null;
  return entry as ParentExecution;
}

const PHASES: readonly string[] = ["active", "waiting", "continuing", "paused"];

/**
 * Rebuild runs from storage. A stored record never carries automatic-resume
 * authority, and live phases cannot survive a reload as they were: nothing can
 * prove what happened after the session that owned them ended.
 */
export function sanitizeStoredParentRuns(stored: unknown): Record<string, ParentRun> {
  if (!stored || typeof stored !== "object") return {};
  const runs: Record<string, ParentRun> = {};
  for (const [threadId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Partial<ParentRun>;
    const execution = validExecution(entry.execution);
    if (typeof entry.id !== "string" || !entry.id || entry.rootThreadId !== threadId || typeof entry.sessionId !== "string"
      || !execution || !PHASES.includes(String(entry.phase))) continue;
    const base: ParentRun = {
      id: entry.id,
      rootThreadId: threadId,
      sessionId: entry.sessionId,
      phase: "active",
      ...(typeof entry.yieldedTurnId === "string" ? { yieldedTurnId: entry.yieldedTurnId } : {}),
      resumesUsed: typeof entry.resumesUsed === "number" && Number.isSafeInteger(entry.resumesUsed) && entry.resumesUsed >= 0 ? entry.resumesUsed : 0,
      wokenQuestions: Array.isArray(entry.wokenQuestions) ? entry.wokenQuestions.filter((key) => typeof key === "string") : [],
      execution,
    };
    if (entry.phase === "active") runs[threadId] = base;
    else if (entry.phase === "paused" && entry.pause) runs[threadId] = { ...base, phase: "paused", pause: entry.pause };
    else runs[threadId] = pausedRun(base, entry.phase === "continuing" ? "start_uncertain" : "restart");
  }
  return runs;
}

export interface ParentAuthEvidence {
  provider: Provider;
  claude?: { loggedIn: boolean; authVerified?: boolean; billing?: string | null; authMethod: string | null; email: string | null; subscriptionType: string | null } | null;
  cursor?: { loggedIn: boolean; authVerified?: boolean; email: string | null; subscriptionType: string | null } | null;
  account?: { type?: string; email?: string | null; planType?: string | null } | null;
  /** OpenRouter: a key is saved. LM Studio: the server lists this model. */
  ready?: boolean;
}

/**
 * What identifies this credential, or null when nothing does.
 *
 * A saved API key has no email or plan by nature, so its billing mode and the
 * app's key generation are the evidence. A signed-in account must report
 * something that tells it apart from another account: two accounts that both
 * report nothing would otherwise compare equal and pass as unchanged.
 */
export function parentAuthKey(evidence: ParentAuthEvidence): string | null {
  if (evidence.provider === "claude") {
    const status = evidence.claude;
    if (!status?.loggedIn || status.authVerified === false) return null;
    if (status.billing === "apiKey") return JSON.stringify(["claude", "apiKey"]);
    if (status.billing !== "subscription" || !(status.email || status.subscriptionType)) return null;
    return JSON.stringify(["claude", "subscription", status.authMethod, status.email, status.subscriptionType]);
  }
  if (evidence.provider === "cursor") {
    const status = evidence.cursor;
    if (!status?.loggedIn || status.authVerified === false || !(status.email || status.subscriptionType)) return null;
    return JSON.stringify(["cursor", status.email, status.subscriptionType]);
  }
  if (evidence.provider === "openai") {
    const account = evidence.account;
    if (account?.type === "apiKey") return JSON.stringify(["openai", "apiKey"]);
    if (!account?.type || !(account.email || account.planType)) return null;
    return JSON.stringify(["openai", account.type, account.email ?? null, account.planType ?? null]);
  }
  return evidence.ready ? evidence.provider : null;
}

/** What a thrown or missing identity read reports: nothing was proven either way. */
export const PARENT_EXECUTION_UNCONFIRMED = "execution";

/** The first thing that differs, or null when the identity is provably the same. */
export function parentExecutionDifference(captured: ParentExecution, live: ParentExecution | null): string | null {
  if (!live) return PARENT_EXECUTION_UNCONFIRMED;
  const fields: Array<keyof ParentExecution> = ["provider", "model", "reasoningEffort", "ultra", "serviceTier", "permission",
    "engine", "subagentsEnabled", "executionPath", "sessionId", "policyCapturedAt", "endpoint", "authGeneration"];
  for (const field of fields) if (captured[field] !== live[field]) return field;
  // A missing identity is not evidence of a different account. It still fails
  // closed: only two present, equal identities count as unchanged.
  if (!captured.authKey || !live.authKey) return PARENT_EXECUTION_UNCONFIRMED;
  return captured.authKey === live.authKey ? null : "authKey";
}

const NOTICE_TAG = "mythra_coordination_notice";
const NOTICE_INTRO = "Automatic Mythra Code notice, not a message from the user.";
const NOTICE_HEADING = "Sub-agent work you assigned needs your attention:";
const NOTICE_REQUEST = "Use agent_status with the childId to read a child's status and messages. For a question listed here, reply with send_agent_message using replyTo. If you are satisfied with the exact result, explicitly accepting it also closes the question. Read results with collect_agent, review them, and continue the user's original request. If other sub-agents are still working and nothing else needs you now, you may end your turn. Mythra Code can continue this conversation when they need you while this run stays open. Give your final response only after the delegated work is reviewed. If you need an answer from the user, ask them and end your turn.";
// Earlier notices used the same v1 envelope. Keep recognizing only their exact
// generated request lines when provider history no longer carries provenance.
const LEGACY_NOTICE_REQUESTS: readonly string[] = [
  "Read a child's questions and status with agent_status and its childId, answer each question with send_agent_message using replyTo, and read results with collect_agent. Review them and continue the user's original request. If other sub-agents are still working and nothing else needs you now, you may end your turn: Mythra Code can continue this conversation when they need you, while this run stays open. Give your final response only after the delegated work is reviewed. If you still need an answer from the user, do not guess or decide for them: state what you need and end your turn.",
  "Use collect_agent and agent_status to read results, review them, and continue the user's original request. Give your final response only after the delegated work is reviewed. If you still need an answer from the user, do not guess or decide for them: state what you need and end your turn.",
  "Use collect_agent and agent_status to read results, review them, and continue the user's original request. Give your final response only after the delegated work is reviewed.",
];
const NOTICE_LINE_STATES: Record<string, string> = {
  question: "asked a question; answer it with send_agent_message",
  approval: "waiting for the user's approval; do not answer it for the user",
  guidance: "has guidance whose delivery failed or could not be confirmed. Check it with agent_status before deciding whether to resend",
  needs_collect: "finished; collect its result",
  needs_signoff: "collected; accept it with accept_agent if you are satisfied, otherwise continue it or tell the user why not",
  needs_wrapup: "accepted by the user; collect its result before your final response",
  working: "still working",
  unknown: "status unconfirmed; check it with agent_status",
  user_stopped: "stopped by the user; do not restart it",
};
const NOTICE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NOTICE_OPENING = new RegExp(`^<${NOTICE_TAG} v="1" id="${NOTICE_UUID}">$`);
const NOTICE_STATE_PATTERN = Object.values(NOTICE_LINE_STATES)
  .map((value) => value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")).join("|");
const NOTICE_LINE = new RegExp("^- [^<>()\\s]{1,200} \\([^<>\\n]{1,80}\\): (?:" + NOTICE_STATE_PATTERN + ")$", "u");
const MAX_NOTICE_TITLE = 80;

function noticeTitle(title: string): string {
  // Preserve surrogate pairs when the title limit falls inside an emoji.
  return Array.from(title.replace(/[<>]/g, "").replace(/\s+/g, " ").trim())
    .slice(0, MAX_NOTICE_TITLE).join("").trim() || "Sub-agent";
}

const FOLLOW_UP_NOTES: Partial<Record<ParentObligationState, string>> = {
  working: "Mythra Code is currently following this child. It can continue automatically when the followed work is ready for review or a new question arrives, provided the run stays open and its continuation checks pass.",
  unknown: "Mythra Code is currently following this child. Its status must be confirmed before automatic continuation, and the run must stay open and pass its continuation checks.",
  needs_response: "The result was collected and a question still needs your response. Use agent_status to read it and send_agent_message with replyTo to answer it.",
};
const FOLLOW_UP_REVIEW_NOTE = "Review this result now. If you end your turn first, Mythra Code can continue to review it while this run stays open and its continuation checks pass.";
const NO_FOLLOW_UP_NOTE = "Mythra Code is not following this child, so nothing continues this conversation for it automatically. Never promise that it will. Keep collecting or reviewing it yourself, or tell the user it is still unreviewed.";
/** List status omits the per-child note, so one line covers the whole page. */
export const NO_FOLLOW_UP_LIST_NOTE = "A child with automaticFollowUp false is not being followed: nothing continues this conversation for it automatically, so never promise that it will.";

/**
 * What a tool may truthfully tell the parent about one child. Read-only: this
 * reports `followed`, and reading it never changes who reviews the child. With
 * nothing outstanding there is nothing to promise, so nothing is reported.
 */
export function parentFollowUpReport(state: ParentObligationState, followed: boolean, focused = true): { automaticFollowUp?: boolean; followUpNote?: string } {
  if (state === "none" || state === "resolved") return {};
  if (!focused) return { automaticFollowUp: followed };
  return { automaticFollowUp: followed, followUpNote: followed ? FOLLOW_UP_NOTES[state] ?? FOLLOW_UP_REVIEW_NOTE : NO_FOLLOW_UP_NOTE };
}

/**
 * Identities and states only. Child output must never gain this notice's
 * authority, so results still reach the parent through collect_agent.
 */
export function buildParentNotice(id: string, obligations: readonly ParentObligation[], approvalChildren: readonly string[] = []): string {
  const lines = obligations.flatMap((entry) => {
    if (entry.pendingStart || entry.manualTakeover) return [];
    const child = `- ${entry.childId} (${noticeTitle(entry.title)}): `;
    if (entry.userStopped) return [child + NOTICE_LINE_STATES.user_stopped];
    if (!owesTurn(entry)) return [];
    if (heldForUser(entry, approvalChildren)) return [child + NOTICE_LINE_STATES.approval];
    if (!canActOn(entry, approvalChildren)) return [child + NOTICE_LINE_STATES.unknown];
    const states: string[] = [];
    if (questionsNeedingReply(entry).length) states.push("question");
    if (guidanceNeedingReview(entry).length) states.push("guidance");
    if (entry.state !== "needs_response" && (isSettled(entry) || !states.length)) states.push(entry.state);
    return states.map((state) => child + NOTICE_LINE_STATES[state]);
  });
  return [`<${NOTICE_TAG} v="1" id="${id}">`, NOTICE_INTRO, NOTICE_HEADING, ...lines, NOTICE_REQUEST, `</${NOTICE_TAG}>`].join("\n");
}

/**
 * Provider history can lose message metadata. Only the whole generated format
 * qualifies: text that quotes or contains this tag stays ordinary user text.
 */
export function isParentNoticeText(text: string): boolean {
  if (!text.startsWith(`<${NOTICE_TAG} v="1" id="`)) return false;
  const lines = text.split("\n");
  if (lines.length < 5 || !NOTICE_OPENING.test(lines[0]) || lines[1] !== NOTICE_INTRO || lines[2] !== NOTICE_HEADING
    || (lines.at(-2) !== NOTICE_REQUEST && !LEGACY_NOTICE_REQUESTS.includes(lines.at(-2) ?? ""))
    || lines.at(-1) !== `</${NOTICE_TAG}>`) return false;
  return lines.slice(3, -2).every((line) => NOTICE_LINE.test(line));
}

export interface ParentRunView {
  kind: "waiting" | "paused";
  title: string;
  detail?: string;
  /** Short status for the top bar. */
  status: string;
  /** Replaces "Work completed" on the turn that yielded. */
  turnLabel: string;
  turnId?: string;
  /** An unacknowledged provider start must settle or be stopped before retry. */
  continueBlocked?: true;
  /** Waiting on the user or on evidence, rather than on work in progress. */
  attention?: boolean;
}

function waitingTitle(obligations: readonly ParentObligation[], input: { approvalChild?: string; queueHeld: boolean; queuePending: boolean; folderBusy: boolean }): string {
  if (input.approvalChild) return `${input.approvalChild} needs your approval`;
  if (input.queueHeld) return "A queued message needs attention";
  const working = obligations.filter((entry) => entry.state === "working");
  if (working.length > 1) return `Waiting for ${working.length} sub-agents`;
  if (working.length === 1) return `Waiting for ${working[0].title}`;
  const unknown = obligations.find((entry) => entry.state === "unknown");
  if (unknown) return `${unknown.title}'s status can't be confirmed`;
  if (input.folderBusy) return "Waiting for another conversation in this folder";
  return input.queuePending ? "Queued messages run first" : "Preparing the parent's follow-up";
}

export type ParentExecutionChange = "model" | "permission" | "crew" | "folder" | "account" | "unconfirmed";

/** What changed, as a category. Field names never reach the UI or diagnostics. */
export function parentExecutionChange(difference: string | undefined): ParentExecutionChange {
  switch (difference) {
    case "provider": case "model": case "reasoningEffort": case "ultra": case "serviceTier": return "model";
    case "permission": return "permission";
    case "engine": case "subagentsEnabled": case "sessionId": case "policyCapturedAt": return "crew";
    case "executionPath": return "folder";
    case "endpoint": case "authKey": case "authGeneration": return "account";
    default: return "unconfirmed";
  }
}

const EXECUTION_CHANGE_TITLES: Record<ParentExecutionChange, string> = {
  model: "The model settings changed while waiting",
  permission: "Permissions changed while waiting",
  crew: "The sub-agent setup changed while waiting",
  folder: "The project folder changed while waiting",
  account: "The account changed while waiting",
  unconfirmed: "Mythra Code couldn't confirm the model or account",
};

const FOLLOWS_AUTOMATICALLY = "Parent continues automatically when results or questions need attention.";

/** What happens next, in the same order `waitingTitle` chooses what to name. */
function waitingDetail(obligations: readonly ParentObligation[], input: { approvalChild?: string; queueHeld: boolean; queuePending: boolean; folderBusy: boolean }): string {
  if (input.approvalChild) return `After you respond: ${FOLLOWS_AUTOMATICALLY.charAt(0).toLowerCase()}${FOLLOWS_AUTOMATICALLY.slice(1)}`;
  if (input.queueHeld) return "Resolve it, and the parent can continue automatically.";
  if (obligations.some((entry) => entry.state === "working")) return FOLLOWS_AUTOMATICALLY;
  if (obligations.some((entry) => entry.state === "unknown")) return "Automatic follow-up waits for confirmed results or questions.";
  if (input.folderBusy) return "Parent continues automatically when that conversation finishes.";
  return input.queuePending ? "Parent continues automatically after them." : "Results or questions are ready. Parent continues automatically.";
}

function pausedTitle(run: ParentRun, obligations: readonly ParentObligation[]): string {
  switch (run.pause?.reason) {
    case "restart": return "Automatic follow-up paused after Mythra Code restarted";
    case "start_uncertain": return "Mythra Code couldn't confirm the parent received this";
    case "parent_failed": return "The parent stopped with an error";
    case "delivery_failed": return "The parent couldn't continue";
    case "budget": return "Automatic follow-ups reached their limit";
    case "execution_changed": return EXECUTION_CHANGE_TITLES[parentExecutionChange(run.pause?.detail)];
    default: break;
  }
  const open = obligations.find((entry) => entry.state === "needs_collect" || entry.state === "needs_signoff")
    ?? obligations.find((entry) => entry.state !== "none" && entry.openQuestions.length);
  if (!open) return "The parent ended without finishing its review";
  if (open.state === "needs_signoff") return `The parent ended without signing off ${open.title}`;
  if (open.state === "needs_collect") return `The parent ended without reviewing ${open.title}`;
  return `The parent ended without answering ${open.title}`;
}

/** Confirmed parent work supplies its own activity; an uncertain start needs an explanation. */
export function parentRunView(
  run: ParentRun | undefined,
  obligations: readonly ParentObligation[],
  input: { rootRunning: boolean; rootStarting: boolean; approvalChild?: string; queueHeld: boolean; queuePending: boolean; folderBusy: boolean },
): ParentRunView | null {
  if (!run) return null;
  const uncertainStart = input.rootStarting && run.phase === "paused" && run.pause?.reason === "start_uncertain";
  if (input.rootRunning && !uncertainStart) return null;
  if (run.phase === "paused") {
    if (!parentRunBlocked(obligations) && !uncertainStart) return null;
    return {
      kind: "paused",
      title: pausedTitle(run, obligations),
      ...(uncertainStart ? { detail: "Waiting for the provider to confirm whether the prompt started.", continueBlocked: true as const }
        : run.pause?.reason === "delivery_failed" && run.pause.detail ? { detail: run.pause.detail } : {}),
      status: uncertainStart ? "Status unknown" : "Needs your input",
      turnLabel: "Paused",
      ...(run.yieldedTurnId ? { turnId: run.yieldedTurnId } : {}),
    };
  }
  if (run.phase !== "waiting" || !parentRunOwesTurn(obligations)) return null;
  const working = obligations.some((entry) => entry.state === "working");
  const blocked = Boolean(input.approvalChild) || input.queueHeld
    || !working && (input.queuePending || input.folderBusy || obligations.some((entry) => entry.state === "unknown"));
  // Nothing is left to wait on: the identity check before the follow-up is running.
  const status = working || blocked ? "Waiting for sub-agents" : "Preparing the follow-up";
  return {
    kind: "waiting",
    title: waitingTitle(obligations, input),
    detail: waitingDetail(obligations, input),
    ...(blocked ? { attention: true } : {}),
    status,
    turnLabel: status,
    ...(run.yieldedTurnId ? { turnId: run.yieldedTurnId } : {}),
  };
}

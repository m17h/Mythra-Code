import { claudeTurnState, isClaudeTurnSettled, killClaudeTurn } from "./claude";
import { rpc, runtimeThreadState } from "./codex";
import { cursorTurnState, isCursorTurnSettled, killCursorTurn } from "./cursor";
import { parentRunAfterSettledProof, type ParentRun } from "./parentRun";
import { confirmRemoteEngineOwnerSettled, remoteEngineStopped, remoteOwnersSettledForThread, remoteThreadOwner, retryClosedRemoteOwnersForThread } from "./remote/host/engineOwners";
import { parentRunStopEpoch, useTaskStore } from "./taskStore";
import { latestCodexTurn } from "../hooks/useThreadHealth";
import { hasPendingTurnStart, pendingTurnStartRevision } from "./pendingTurnStarts";
import { isLmStudioProviderId } from "./providerIds";
import type { Provider, Thread } from "../types";

/**
 * Recovery for a parent run held by an unconfirmed provider start or Stop
 * (`paused` / `start_uncertain`). After a reload, a lost start or a native
 * owner whose retirement failed, no live identity may remain for Stop to cut
 * off, so the latch could never clear even when the work really ended.
 *
 * Only native/provider evidence for this exact thread can release it: the
 * renderer's idle status is never proof. A latch is released only if the same
 * run, Stop epoch and root attempt are still current after the evidence was
 * read, and never while a Stop for the thread is still awaiting its cutoff.
 */

/** Background evidence cadence for held threads; each probe is a few native reads. */
export const PARENT_RUN_RECOVERY_INTERVAL_MS = 30_000;

/** Threads whose Stop is awaiting its cutoff. Recovery never races one. */
const stopCutoffs = new Map<string, number>();

export function beginParentStopCutoff(threadId: string): () => void {
  stopCutoffs.set(threadId, (stopCutoffs.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (stopCutoffs.get(threadId) ?? 1) - 1;
    if (count > 0) stopCutoffs.set(threadId, count);
    else stopCutoffs.delete(threadId);
  };
}

export function parentStopCutoffActive(threadId: string): boolean {
  return stopCutoffs.has(threadId);
}

export function isUncertainParentRun(run: ParentRun | undefined): run is ParentRun {
  return run?.phase === "paused" && run.pause?.reason === "start_uncertain";
}

export type ThreadWorkProof =
  | { settled: true }
  /** `active`: evidence shows work still running; otherwise proof is
   * unavailable. `owner`: the running work belongs to an engine owner. */
  | { settled: false; active: boolean; owner?: true; message: string };

const ACTIVE_MESSAGE = "This conversation’s provider work is still running. Stop it, or wait for it to finish, before removing the conversation.";
const UNAVAILABLE_MESSAGE = "Mythra Code couldn’t confirm with the provider that this work ended. Removal stays blocked; retry Stop when the provider is available.";
const OWNER_MESSAGE = "Work started from another device for this conversation is still running or its status is unknown. Retry Stop after it ends.";

/** Recovery must never guess which runtime owns this thread. The captured
 * parent execution is useful after reload, but conflicting metadata is not
 * authority to release or interrupt either provider. */
export function parentRecoveryProvider(thread: Pick<Thread, "modelProvider"> | null | undefined, run?: ParentRun): Provider | undefined {
  const known = (value: unknown): Provider | undefined => {
    if (typeof value !== "string") return undefined;
    const provider = value.toLowerCase();
    if (isLmStudioProviderId(provider)) return "lmstudio";
    if (provider === "openai" || provider === "claude" || provider === "cursor" || provider === "openrouter") return provider;
    return undefined;
  };
  const threadProvider = known(thread?.modelProvider), captured = known(run?.execution.provider);
  if (thread?.modelProvider && !threadProvider) return undefined;
  if (threadProvider && captured && threadProvider !== captured) return undefined;
  return threadProvider ?? captured;
}

/** A probe and any fallback cutoff belong to one exact renderer lifetime. */
function captureRecoveryGuard(threadId: string): () => boolean {
  const before = useTaskStore.getState(), run = before.parentRuns[threadId], task = before.tasks[threadId];
  const epoch = parentRunStopEpoch(threadId), startRevision = pendingTurnStartRevision(threadId);
  return () => {
    const live = useTaskStore.getState(), current = live.tasks[threadId];
    return live.parentRuns[threadId] === run && parentRunStopEpoch(threadId) === epoch
      && pendingTurnStartRevision(threadId) === startRevision
      && current?.agentRunId === task?.agentRunId && current?.agentRunStartedAt === task?.agentRunStartedAt
      && current?.activeTurnId === task?.activeTurnId && current?.pendingNativeActivationId === task?.pendingNativeActivationId;
  };
}

function rendererPreparing(threadId: string): boolean {
  return hasPendingTurnStart(threadId) || Boolean(useTaskStore.getState().workflowOwners[threadId]);
}

/** Called synchronously only after the exact attempt passed native proof and
 * its guard. Old UI start/turn markers may have survived a missed native event;
 * seal those markers without asserting that the provider completed normally. */
function settleProvenRendererTask(threadId: string): void {
  const state = useTaskStore.getState(), task = state.tasks[threadId];
  if (!task || rendererPreparing(threadId)) return;
  if (task.activeTurnId || task.pendingNativeActivationId || task.status === "starting" || task.status === "running") {
    state.completeTurn(threadId, task.activeTurnId, state.parentRuns[threadId]?.pause?.stop ? "interrupted" : "error");
  }
}

/**
 * Whether every piece of work this thread could own has ended, from native
 * evidence only: engine owners recorded natively for the thread (open or
 * closed, with or without a renderer handle), then the provider runtime that
 * would run its turn. Only after both prove nothing runs is a renderer-held
 * owner finished, which closes its admission but never kills work.
 */
export async function proveThreadWorkSettled(threadId: string, provider: Provider | undefined, isCurrent: () => boolean = () => true): Promise<ThreadWorkProof> {
  if (!provider || !isCurrent()) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
  if (rendererPreparing(threadId)) return { settled: false, active: true, message: ACTIVE_MESSAGE };
  const handle = remoteThreadOwner(threadId)?.ownerHandle;
  const ownerCurrent = () => isCurrent() && remoteThreadOwner(threadId)?.ownerHandle === handle;
  const owners = await remoteOwnersSettledForThread(threadId);
  if (!ownerCurrent() || !owners) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
  if (!owners.settled) return { settled: false, active: true, owner: true, message: OWNER_MESSAGE };
  const providerProof = await proveProviderSettled(threadId, provider);
  if (!ownerCurrent()) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
  if (!providerProof.settled) return providerProof;
  if (handle) {
    if (owners.owners === 0) {
      // The native thread proof has atomically finalized all its idle owners.
      // Forget only the same renderer handle the proof began with.
      if (!ownerCurrent()) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
      remoteEngineStopped(handle);
    } else {
      const confirmed = await confirmRemoteEngineOwnerSettled(handle, undefined, ownerCurrent);
      if (!isCurrent() || confirmed === undefined) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
      if (!confirmed) return { settled: false, active: true, owner: true, message: OWNER_MESSAGE };
    }
  }
  return !isCurrent() ? { settled: false, active: false, message: UNAVAILABLE_MESSAGE } : rendererPreparing(threadId) ? { settled: false, active: true, message: ACTIVE_MESSAGE } : { settled: true };
}

async function proveProviderSettled(threadId: string, provider: Provider): Promise<ThreadWorkProof> {
  try {
    if (provider === "claude") {
      return await isClaudeTurnSettled(threadId) ? { settled: true } : { settled: false, active: true, message: ACTIVE_MESSAGE };
    }
    if (provider === "cursor") {
      return await isCursorTurnSettled(threadId) ? { settled: true } : { settled: false, active: true, message: ACTIVE_MESSAGE };
    }
    const runtime = await runtimeThreadState(threadId);
    if (runtime.busy === undefined) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
    if (runtime.busy) return { settled: false, active: true, message: ACTIVE_MESSAGE };
    // No turn can run in a process that has not loaded the thread, even if
    // its saved history ended mid-turn when an earlier process exited.
    if (!runtime.loaded && runtime.busy === false) return { settled: true };
    // A rollout can retain an unfinished historical turn after the old
    // process exited. Read current app-server thread status, which resolves
    // the loaded runtime's agent status independently of that saved history.
    // A real live turn upgrades idle/notLoaded to active in the provider.
    const current = await rpc<{ thread?: { id?: string; status?: { type?: string } } }>("thread/read", { threadId, includeTurns: false });
    const after = await runtimeThreadState(threadId);
    if (after.instance !== runtime.instance || after.busy !== false) {
      return { settled: false, active: true, message: ACTIVE_MESSAGE };
    }
    if (current.thread?.id !== threadId) return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
    const status = current.thread.status?.type;
    if (status === "active") return { settled: false, active: true, message: ACTIVE_MESSAGE };
    if (status === "idle" || status === "notLoaded" || status === "systemError") return { settled: true };
    // Older/unknown provider responses are not proof of an idle runtime.
    return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
  } catch {
    return { settled: false, active: false, message: UNAVAILABLE_MESSAGE };
  }
}

/**
 * A real Stop for work native evidence shows still running when the renderer
 * no longer holds its identity. Scoped to this exact thread's current
 * provider turn; Codex interrupts only its in-progress turn in the observed
 * runtime instance. Closed engine owners use the separate retained-child retry.
 */
async function cutOffUntrackedThreadWork(threadId: string, provider: Provider, isCurrent: () => boolean): Promise<void> {
  const assertCurrent = () => {
    if (!isCurrent() || rendererPreparing(threadId)) throw new Error("This conversation changed while Stop was being confirmed. Retry Stop for its current work.");
  };
  assertCurrent();
  if (provider === "claude" || provider === "cursor") {
    const identity = provider === "claude" ? await claudeTurnState(threadId) : await cursorTurnState(threadId);
    assertCurrent();
    if (!identity || identity.phase === "completed") return;
    // Native expectation checks bind this cutoff to the observed start/turn;
    // a replacement admitted after the read is preserved by the backend.
    const expected = { turnId: identity.turnId, startRequestId: identity.startRequestId };
    if (provider === "claude") await killClaudeTurn(threadId, expected);
    else await killCursorTurn(threadId, expected);
  } else {
    const runtime = await runtimeThreadState(threadId);
    assertCurrent();
    const turn = await latestCodexTurn(threadId);
    assertCurrent();
    const after = await runtimeThreadState(threadId);
    assertCurrent();
    if (after.instance !== runtime.instance) throw new Error(UNAVAILABLE_MESSAGE);
    if (turn?.status === "inProgress" && turn.id) await rpc("turn/interrupt", { threadId, turnId: turn.id, expectedRuntimeInstance: runtime.instance });
  }
}

const SETTLE_RETRY_MS = [200, 500, 1000, 2000];

/**
 * Stop's root cutoff when no live identity survives. Settled work needs no
 * cutoff. Running work is cut off when `cutOff` is allowed, then proven again.
 * Throws with a user-facing reason while work is running or unprovable.
 */
export async function stopByThreadEvidence(threadId: string, provider: Provider | undefined, cutOff: boolean,
  stopStillCurrent: () => boolean = () => true): Promise<void> {
  const sameLifetime = captureRecoveryGuard(threadId);
  // The original cutoff can await before entering this fallback. Preserve its
  // lifetime as well as this probe's snapshot, so a delayed retry cannot adopt
  // and cut off a replacement run that started during that first await.
  const isCurrent = () => stopStillCurrent() && sameLifetime();
  let proof = await proveThreadWorkSettled(threadId, provider, isCurrent);
  if (!proof.settled && proof.owner && cutOff) {
    // A failed native retirement can retain an exact child whose process
    // cutoff is still uncertain even after its renderer identity disappeared.
    // Only explicit host Stop retries those already-closed native owners;
    // remote Stop stays on its stamped cutoff or read-only proof route.
    if (!isCurrent() || rendererPreparing(threadId)
      || !await retryClosedRemoteOwnersForThread(threadId, isCurrent)) throw new Error(UNAVAILABLE_MESSAGE);
    proof = await proveThreadWorkSettled(threadId, provider, isCurrent);
  }
  if (proof.settled) {
    if (!isCurrent() || rendererPreparing(threadId)) throw new Error(UNAVAILABLE_MESSAGE);
    settleProvenRendererTask(threadId);
    return;
  }
  if (!proof.active || proof.owner || !cutOff) throw new Error(proof.message);
  if (!provider || !isCurrent()) throw new Error(UNAVAILABLE_MESSAGE);
  await cutOffUntrackedThreadWork(threadId, provider, isCurrent);
  for (const delay of SETTLE_RETRY_MS) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    proof = await proveThreadWorkSettled(threadId, provider, isCurrent);
    if (proof.settled) {
      if (!isCurrent() || rendererPreparing(threadId)) throw new Error(UNAVAILABLE_MESSAGE);
      settleProvenRendererTask(threadId);
      return;
    }
    if (!proof.active) break;
  }
  if (!proof.settled) throw new Error(proof.message);
}

export type ParentRunRecovery =
  | { outcome: "released" }
  | { outcome: "none" }
  | { outcome: "active" | "unavailable" | "changed"; message: string };

const recoveries = new Map<string, Promise<ParentRunRecovery>>();

/**
 * Release this thread's uncertainty latch once native evidence proves its work
 * ended. Concurrent calls for a thread share one probe.
 */
export function reconcileUncertainParentRun(threadId: string, provider: Provider | undefined): Promise<ParentRunRecovery> {
  const pending = recoveries.get(threadId);
  if (pending) return pending;
  const work = (async (): Promise<ParentRunRecovery> => {
    const before = useTaskStore.getState();
    const run = before.parentRuns[threadId];
    if (!isUncertainParentRun(run)) return { outcome: "none" };
    if (parentStopCutoffActive(threadId)) return { outcome: "changed", message: "Stop is still confirming this cutoff." };
    const epoch = parentRunStopEpoch(threadId);
    const task = before.tasks[threadId];
    const attempt = { agentRunId: task?.agentRunId, runStartedAt: task?.agentRunStartedAt };
    const stillCurrent = captureRecoveryGuard(threadId);
    const isCurrent = () => stillCurrent() && !parentStopCutoffActive(threadId);
    const proof = await proveThreadWorkSettled(threadId, provider, isCurrent);
    if (!proof.settled) return { outcome: proof.active ? "active" : "unavailable", message: proof.message };
    const live = useTaskStore.getState(), current = live.tasks[threadId];
    if (!isCurrent() || live.parentRuns[threadId] !== run || parentRunStopEpoch(threadId) !== epoch || parentStopCutoffActive(threadId)
      || current?.agentRunId !== attempt.agentRunId || current?.agentRunStartedAt !== attempt.runStartedAt || rendererPreparing(threadId)) {
      return { outcome: "changed", message: "This conversation changed while its status was being confirmed. Try again." };
    }
    settleProvenRendererTask(threadId);
    if (run.pause?.stop) live.stopParentRun(threadId, "stop");
    else live.updateParentRun(threadId, (entry) => entry === run ? parentRunAfterSettledProof(entry) : entry);
    return { outcome: "released" };
  })();
  recoveries.set(threadId, work);
  const release = () => { if (recoveries.get(threadId) === work) recoveries.delete(threadId); };
  void work.then(release, release);
  return work;
}

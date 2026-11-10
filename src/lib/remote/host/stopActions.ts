import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { captureRootCutoff, stopWithChildren, waitForRootCutoff } from "../../stopWithChildren";
import { parentRunStopEpoch, useTaskStore } from "../../taskStore";
import { stoppingParentRun } from "../../parentRun";
import { pendingTurnStartRevision } from "../../pendingTurnStarts";
import { beginParentStopCutoff, isUncertainParentRun, parentRecoveryProvider, stopByThreadEvidence } from "../../parentRunRecovery";
import { HostReadError } from "./scope";
import { isLiveRemoteEngineOwner, markRemoteEngineRetiring, remoteEngineStopped } from "./engineOwners";
import { sameStop, sameStopLifetime } from "./targetHandles";
import type { RemoteStopSnapshot, RemoteTurnRunner } from "./workTypes";

/** Closures supplied by App must address the supplied root, never selection. */
export interface StopActionSources {
  bumpRootCutoffIntent(threadId: string): void;
  captureChildStopFrontier(threadId: string): unknown;
  cancelChildAgentsFor(threadId: string, frontier: unknown): Promise<void>;
  /** Retire only this workflow run, and use stopRoot for its provider cutoff. */
  stopWorkflow(workflowId: string, runId: string, stopRoot: () => Promise<void>): Promise<boolean | void>;
}
export async function stopThreadAndChildren(context: TurnRunnerContext, expected: RemoteStopSnapshot,
  runner: RemoteTurnRunner, sources: StopActionSources, assertCurrent: () => void): Promise<void> {
  // Native handle is already claimed; recheck renderer ownership synchronously
  // before ANY parent retirement, workflow cutoff or child-frontier capture.
  assertCurrent();
  if (context.activeThread?.id !== expected.threadId || !(expected.ownerHandle ? sameStopLifetime(expected, runner.getThreadStopTarget(expected.threadId)) : sameStop(expected, runner.getThreadStopTarget(expected.threadId)))) {
    throw new HostReadError("stale_target", "The observed run has changed.");
  }
  const id = expected.threadId;
  const store = useTaskStore.getState();
  const parent = store.parentRuns[id];
  const stoppingParent = parent ? stoppingParentRun(parent, "Stop is waiting for confirmation that all owned work ended.") : undefined;
  // An earlier unconfirmed Stop, a reload or a lost start can leave this run
  // with no live identity (or only a closed native owner). Read that before
  // this Stop marks its own owner retiring.
  const isUncertainParent = isUncertainParentRun(parent) && !expected.workflowRunId;
  const evidenceStop = isUncertainParent && !expected.turnId && !expected.startRequestId
    && !(expected.ownerHandle && isLiveRemoteEngineOwner(expected.ownerHandle));
  const provider = parentRecoveryProvider(context.activeThread ?? undefined, parent);
  if (expected.ownerHandle) markRemoteEngineRetiring(expected.ownerHandle);
  store.stopParentRun(id, "stop", stoppingParent);
  const stopEpoch = parentRunStopEpoch(id);
  const startRevision = pendingTurnStartRevision(id);
  const sameStopAttempt = () => {
    const live = useTaskStore.getState(), task = live.tasks[id];
    return live.parentRuns[id] === stoppingParent && parentRunStopEpoch(id) === stopEpoch
      && pendingTurnStartRevision(id) === startRevision
      && task?.agentRunId === expected.agentRunId && task?.agentRunStartedAt === expected.runStartedAt;
  };
  const releaseCutoff = stoppingParent ? beginParentStopCutoff(id) : undefined;
  try {
    sources.bumpRootCutoffIntent(id);
    const frontier = sources.captureChildStopFrontier(id);
    const cutoff = captureRootCutoff(id);
    const failures = await stopWithChildren(
      async () => {
        if (expected.workflowId && expected.workflowRunId) {
          const stopped = await sources.stopWorkflow(expected.workflowId, expected.workflowRunId, () => runner.stopThreadTurn({ ...context, running: true }, expected));
          if (stopped === false) throw new HostReadError("uncertain", "Mythra Code couldn't confirm this workflow stopped. Check the conversation.");
        } else if (evidenceStop) {
          // Proof only for another device. Work native evidence shows still
          // running with no live identity is cut off by Stop on the host.
          try { await stopByThreadEvidence(id, provider, false, sameStopAttempt); } catch (reason) {
            throw new HostReadError("uncertain", `${reason instanceof Error ? reason.message : String(reason)} If it keeps running, use Stop on the host.`);
          }
        } else if (isUncertainParent) {
          try { await runner.stopThreadTurn({ ...context, running: true }, expected); } catch (reason) {
            // A retained identity can name work that already ended natively.
            // Only fresh native proof of that may stand in for the cutoff.
            await stopByThreadEvidence(id, provider, false, sameStopAttempt).catch(() => { throw reason; });
          }
        } else await runner.stopThreadTurn({ ...context, running: true }, expected);
      },
      () => sources.cancelChildAgentsFor(id, frontier),
      () => waitForRootCutoff(id, undefined, cutoff),
    );
    if (failures.length) {
      const evidence = failures.find((failure) => failure instanceof HostReadError && failure.code === "uncertain");
      throw evidence ?? new HostReadError("uncertain", "Stop was requested, but the other device couldn't confirm everything stopped. Check the conversation.");
    }
    if (expected.ownerHandle) remoteEngineStopped(expected.ownerHandle);
    const live = useTaskStore.getState(), task = live.tasks[id];
    if (stoppingParent && live.parentRuns[id] === stoppingParent && parentRunStopEpoch(id) === stopEpoch
      && task?.agentRunId === expected.agentRunId && task?.agentRunStartedAt === expected.runStartedAt) {
      live.updateParentRun(id, () => null);
    }
  } catch (reason) {
    // Retiring automatic follow-up prevents another dispatch; it does not prove
    // the owned native work stopped. Keep that uncertainty visible and retain
    // the removal guard without reviving automatic continuation or overwriting
    // a newer run (including a second Stop) admitted while cutoff was awaited.
    const live = useTaskStore.getState(), task = live.tasks[id];
    if (stoppingParent && task && live.parentRuns[id] === stoppingParent && parentRunStopEpoch(id) === stopEpoch
      && task.agentRunId === expected.agentRunId && task.agentRunStartedAt === expected.runStartedAt) {
      live.updateParentRun(id, () => stoppingParentRun(stoppingParent,
        "Stop could not confirm that all owned work ended. Retry Stop: Mythra Code asks the provider again, and Stop on the host cuts off anything still running."));
    }
    throw reason;
  } finally {
    releaseCutoff?.();
  }
}

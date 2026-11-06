import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { captureRootCutoff, stopWithChildren, waitForRootCutoff } from "../../stopWithChildren";
import { useTaskStore } from "../../taskStore";
import { HostReadError } from "./scope";
import { sameStop } from "./targetHandles";
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
  if (context.activeThread?.id !== expected.threadId || !sameStop(expected, runner.getThreadStopTarget(expected.threadId))) {
    throw new HostReadError("stale_target", "The observed run has changed.");
  }
  const id = expected.threadId;
  const store = useTaskStore.getState();
  store.stopParentRun(id, "stop");
  sources.bumpRootCutoffIntent(id);
  const frontier = sources.captureChildStopFrontier(id);
  const cutoff = captureRootCutoff(id);
  const failures = await stopWithChildren(
    () => expected.workflowId && expected.workflowRunId
      ? sources.stopWorkflow(expected.workflowId, expected.workflowRunId, () => runner.stopThreadTurn({ ...context, running: true }, expected))
      : runner.stopThreadTurn({ ...context, running: true }, expected),
    () => sources.cancelChildAgentsFor(id, frontier),
    () => waitForRootCutoff(id, undefined, cutoff),
  );
  if (failures.length) throw new HostReadError("uncertain", "Stop was requested, but the host could not confirm every cutoff. Check the conversation.");
}

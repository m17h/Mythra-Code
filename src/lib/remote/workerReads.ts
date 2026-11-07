import type { WireWorker } from "./wire-resources";

export interface WorkerScope { device: string; workspaceId?: string; threadId?: string }
const sameScope = (left: WorkerScope, right: WorkerScope) => left.device === right.device && left.workspaceId === right.workspaceId && left.threadId === right.threadId;

/** A slow answer must never land in whatever is on screen by the time it arrives. */
export function createWorkerReads() {
  let current: WorkerScope | null = null;
  let generation = 0;
  return {
    enter(scope: WorkerScope) { current = scope; generation += 1; },
    leave() { current = null; generation += 1; },
    /** Null when there's nothing to ask about, or this request belongs to an older scope. */
    begin(scope: WorkerScope): number | null {
      if (!current || !sameScope(current, scope) || !scope.workspaceId || !scope.threadId) return null;
      generation += 1;
      return generation;
    },
    accepts(read: number, scope: WorkerScope) { return read === generation && current !== null && sameScope(current, scope); },
  };
}

/** Claude native children share their root's process; Codex ones have their own thread. */
export const workerRuntime = (worker: Pick<WireWorker, "nativeRuntime" | "provider">): "codex" | "claude" => worker.nativeRuntime ?? (worker.provider === "claude" ? "claude" : "codex");

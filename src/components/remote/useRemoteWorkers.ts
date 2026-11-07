import { useCallback, useEffect, useMemo, useState } from "react";
import { hostRead, hostWrite } from "../../lib/remote/remoteActions";
import type { WireResourceResult, WireWorker } from "../../lib/remote/wire-resources";
import { createWorkerReads, workerRuntime } from "../../lib/remote/workerReads";
import type { SubAgentWorker } from "../../lib/subAgentActivity";
import type { Provider } from "../../types";

const RECHECK_MS = 5_000;
const NO_WORKERS: readonly WireWorker[] = [];

/** The shape the real command center shows. The review token stays on the host:
 * this only says a sign-off is possible, and the opaque `target` proves which work. */
const workerView = (worker: WireWorker): SubAgentWorker => ({
  id: worker.id, kind: worker.kind, status: worker.status as SubAgentWorker["status"], title: worker.title, detail: worker.detail, createdAt: worker.createdAt,
  ...(worker.provider ? { provider: worker.provider as Provider } : {}), ...(worker.model ? { model: worker.model } : {}), canOpen: worker.canOpen, canStop: worker.canStop,
  ...(worker.kind === "native" ? { nativeRuntime: workerRuntime(worker) } : {}),
  ...(worker.review ? { review: worker.review } : {}), ...(worker.canAccept ? { reviewToken: "host" } : {}), ...(worker.finishedAt ? { finishedAt: worker.finishedAt } : {}),
});

/** Sub-agents under one conversation. Asks while its parent runs, and once more when it stops. */
export function useRemoteWorkers(device: string, name: string, target: { workspaceId?: string; threadId?: string }, revision: string, running: boolean) {
  const { workspaceId, threadId } = target;
  const [rows, setRows] = useState<readonly WireWorker[]>(NO_WORKERS);
  const [reads] = useState(createWorkerReads);
  const refresh = useCallback(() => {
    const scope = { device, workspaceId, threadId };
    const read = reads.begin(scope);
    if (read === null) return;
    hostRead<WireResourceResult>(device, "agents.read", { workspaceId, threadId }).then((result) => {
      if (reads.accepts(read, scope)) setRows(result.workers ?? NO_WORKERS);
    }, () => undefined);
  }, [device, reads, threadId, workspaceId]);
  useEffect(() => {
    reads.enter({ device, workspaceId, threadId });
    setRows(NO_WORKERS);
    return () => reads.leave();
  }, [device, reads, threadId, workspaceId]);
  useEffect(() => {
    refresh();
    if (!running) return;
    const timer = setInterval(refresh, RECHECK_MS);
    return () => clearInterval(timer);
  }, [refresh, running]);
  const act = useCallback(async (op: "agents.stop" | "agents.accept" | "agents.replace", id: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const worker = rows.find((entry) => entry.id === id);
    if (!worker || !workspaceId || !threadId) return `That sub-agent changed on ${name}. Refresh and try again.`;
    const outcome = await hostWrite(device, name, op, { workspaceId, threadId, revision, agentId: id, target: worker.target, ...extra });
    refresh();
    return outcome.message;
  }, [device, name, refresh, revision, rows, threadId, workspaceId]);
  const workers = useMemo(() => rows.map(workerView), [rows]);
  return { rows, workers, refresh, act };
}

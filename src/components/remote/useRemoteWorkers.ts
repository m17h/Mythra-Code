import { useCallback, useEffect, useMemo, useState } from "react";
import { hostRead, hostWrite } from "../../lib/remote/remoteActions";
import type { WireResourceResult, WireWorker } from "../../lib/remote/wire-resources";
import { createWorkerReads, workerRuntime } from "../../lib/remote/workerReads";
import { useRemoteDevices } from "../../lib/remote/devices";
import type { SubAgentPendingSummary, SubAgentWorker } from "../../lib/subAgentActivity";
import type { Provider } from "../../types";

const RECHECK_MS = 5_000;
const NO_WORKERS: readonly WireWorker[] = [];
const reportedCount = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  ? value : undefined;

/** Totals come only from the host's own count over every worker. A complete
 * empty list is the one case that proves zero without them. */
export function remotePendingSummary(result: Pick<WireResourceResult, "workers" | "truncated" | "pending" | "workerTotal">): SubAgentPendingSummary {
  const rows = Array.isArray(result.workers) ? result.workers : undefined;
  const shown = rows?.length ?? 0;
  const pending = result.pending && typeof result.pending === "object" ? result.pending : undefined;
  const questions = reportedCount(pending?.questions), results = reportedCount(pending?.results);
  const total = reportedCount(result.workerTotal);
  const validRowCounts = rows?.every((worker) => (worker.pendingQuestions === undefined || reportedCount(worker.pendingQuestions) !== undefined)
    && (worker.pendingResult === undefined || worker.pendingResult === true));
  const rowQuestions = rows?.reduce((sum, worker) => sum + (reportedCount(worker.pendingQuestions) ?? 0), 0) ?? 0;
  const rowResults = rows?.filter((worker) => worker.pendingResult === true).length ?? 0;
  if (rows && validRowCounts && questions !== undefined && results !== undefined && total !== undefined
    && Number.isSafeInteger(questions + results) && total >= shown && results <= total
    && (result.truncated === true ? total > shown : result.truncated === false && total === shown)
    && (result.truncated ? questions >= rowQuestions && results >= rowResults : questions === rowQuestions && results === rowResults)) {
    return { kind: "exact", questions, results, shown, total };
  }
  if (rows && !shown && result.truncated === false && result.pending === undefined && result.workerTotal === undefined) {
    return { kind: "exact", questions: 0, results: 0, shown: 0, total: 0 };
  }
  return { kind: "unavailable", shown, truncated: result.truncated === true };
}
const deviceConnected = (device: string) => useRemoteDevices.getState().snapshot?.devices.some((entry) => entry.fingerprint === device && entry.state === "connected" && entry.canView) === true;

/** The shape the real command center shows. The review token stays on the host:
 * this only says a sign-off is possible, and the opaque `target` proves which work. */
const workerView = (worker: WireWorker): SubAgentWorker => ({
  id: worker.id, kind: worker.kind, status: worker.status as SubAgentWorker["status"], title: worker.title, detail: worker.detail, createdAt: worker.createdAt,
  ...(worker.provider ? { provider: worker.provider as Provider } : {}), ...(worker.model ? { model: worker.model } : {}), canOpen: worker.canOpen, canStop: worker.canStop,
  ...(worker.kind === "native" ? { nativeRuntime: workerRuntime(worker) } : {}),
  ...(worker.review ? { review: worker.review } : {}), ...(worker.canAccept ? { reviewToken: "host" } : {}), ...(worker.finishedAt ? { finishedAt: worker.finishedAt } : {}),
  ...(worker.pendingResult === true ? { pendingResult: true as const } : {}),
  ...(typeof worker.pendingQuestions === "number" && Number.isSafeInteger(worker.pendingQuestions) && worker.pendingQuestions > 0
    ? { pendingQuestions: worker.pendingQuestions } : {}),
});

/** Children can ask or finish between parent turns, so keep the visible fleet fresh while connected. */
export function useRemoteWorkers(device: string, name: string, target: { workspaceId?: string; threadId?: string }, revision: string, running: boolean) {
  const { workspaceId, threadId } = target;
  const scopeKey = JSON.stringify([device, workspaceId, threadId]);
  const connected = useRemoteDevices((state) => state.snapshot?.devices.some((entry) => entry.fingerprint === device && entry.state === "connected" && entry.canView) === true);
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; rows: readonly WireWorker[]; pending: SubAgentPendingSummary }>();
  const current = connected && snapshot?.scopeKey === scopeKey ? snapshot : undefined;
  const rows = current?.rows ?? NO_WORKERS;
  /** Undefined until this scope's first reply: no badge rather than a guess. */
  const pending = current?.pending;
  const [reads] = useState(createWorkerReads);
  const refresh = useCallback(() => {
    const scope = { device, workspaceId, threadId };
    if (!deviceConnected(device)) return Promise.resolve();
    const read = reads.begin(scope);
    if (read === null) return Promise.resolve();
    return hostRead<WireResourceResult>(device, "agents.read", { workspaceId, threadId }).then((result) => {
      if (reads.accepts(read, scope) && deviceConnected(device)) setSnapshot({ scopeKey, rows: Array.isArray(result.workers) ? result.workers : NO_WORKERS, pending: remotePendingSummary(result) });
    }, () => { if (reads.accepts(read, scope)) setSnapshot(undefined); });
  }, [device, reads, scopeKey, threadId, workspaceId]);
  useEffect(() => {
    let available: boolean | undefined;
    const update = () => {
      const next = deviceConnected(device);
      if (next === available) return;
      available = next;
      // Invalidate replies synchronously even if reconnect is batched into the
      // same render as disconnect. Old host handles must not survive it.
      reads.leave();
      if (next) reads.enter({ device, workspaceId, threadId });
      setSnapshot(undefined);
    };
    update();
    const unsubscribe = useRemoteDevices.subscribe(update);
    return () => { unsubscribe(); reads.leave(); };
  }, [device, reads, threadId, workspaceId]);
  useEffect(() => {
    if (!connected || !workspaceId || !threadId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      // Wait for the previous read so slow links cannot invalidate every reply
      // with a newer interval request before any snapshot is displayed.
      if (!cancelled) timer = setTimeout(poll, RECHECK_MS);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [connected, refresh, revision, running, threadId, workspaceId]);
  const act = useCallback(async (op: "agents.stop" | "agents.accept" | "agents.replace", id: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const worker = rows.find((entry) => entry.id === id);
    if (!worker || !workspaceId || !threadId) return `That sub-agent changed on ${name}. Refresh and try again.`;
    const outcome = await hostWrite(device, name, op, { workspaceId, threadId, revision, agentId: id, target: worker.target, ...extra });
    refresh();
    return outcome.message;
  }, [device, name, refresh, revision, rows, threadId, workspaceId]);
  const workers = useMemo(() => rows.map(workerView), [rows]);
  return { rows, workers, pending, refresh, act };
}

import { invoke } from "@tauri-apps/api/core";
import type { PendingApproval } from "../../../types";
import { useTaskStore } from "../../taskStore";
export interface PendingRequestIdentity {
  threadId: string; id: string | number; method: string; turnId?: string; itemId?: string;
  /** Native-attested remote execution lifetime, NOT a viewer or timeline field. */
  remoteOwner?: string;
}
export interface PendingRequestInventory {
  complete: boolean;
  requests: Array<PendingApproval & { remoteOwner?: string }>;
  /** Identities whose live payload was individually omitted (size/unsupported).
   * They are PRESENT, not expired; other complete payloads remain recoverable. */
  present?: PendingRequestIdentity[];
  /** Complete, explicit native absence proof for a previously recovered remote owner. */
  expired?: Array<PendingRequestIdentity & { remoteOwner: string }>;
}
// Existing listener-delivered/local approvals have no proven remote provenance.
// Merely finding the same numeric request ID in a remote inventory cannot give
// this recovery routine ownership of a local process's request.
const recoveredOwners = new WeakMap<PendingApproval, string>();
const validId = (value: unknown): value is string | number => typeof value === "string" && value.length > 0 && value.length <= 1024
  || typeof value === "number" && Number.isFinite(value);
const validIdentity = (entry: PendingRequestIdentity): boolean => Boolean(entry && typeof entry.threadId === "string" && entry.threadId
  && typeof entry.method === "string" && entry.method && validId(entry.id));
const matchesLiveIdentity = (approval: PendingApproval, entry: PendingRequestIdentity): boolean => approval.threadId === entry.threadId
  && approval.id === entry.id && approval.method === entry.method
  && (entry.turnId === undefined || approval.params.turnId === entry.turnId) && (entry.itemId === undefined || approval.params.itemId === entry.itemId);
const identity = (entry: PendingRequestIdentity) => JSON.stringify([entry.threadId, typeof entry.id, entry.id, entry.method, entry.turnId ?? null, entry.itemId ?? null]);
const approvalIdentity = (entry: PendingApproval): PendingRequestIdentity => ({ threadId: entry.threadId, id: entry.id, method: entry.method,
  ...(typeof entry.params?.turnId === "string" ? { turnId: entry.params.turnId } : {}), ...(typeof entry.params?.itemId === "string" ? { itemId: entry.params.itemId } : {}) });
/** Remote recovery is NOT the owner of ordinary host approvals. Incomplete,
 * malformed or failed reads leave every local reference/status/unread bit alone.
 * Absence in a list alone is never proof a local provider stopped waiting. */
export async function reconcilePendingRequests(generation: number, isCurrent: () => boolean,
  read = () => invoke<PendingRequestInventory>("remote_work_pending_requests", { generation }),
  recovery?: (ready: boolean, unavailableThreads: ReadonlySet<string>) => void): Promise<boolean> {
  const before = useTaskStore.getState();
  const approvalQueryToken = before.approvalQueryToken;
  const observed = Object.values(before.tasks).flatMap((task) => task.approvals);
  let inventory: PendingRequestInventory;
  try { inventory = await read(); }
  catch { if (isCurrent()) recovery?.(false, new Set()); return false; }
  if (!isCurrent()) return false;
  if (!inventory || inventory.complete !== true || !Array.isArray(inventory.requests) || inventory.requests.length > 1024
    || inventory.present !== undefined && (!Array.isArray(inventory.present) || inventory.present.length > 4096)
    || inventory.expired !== undefined && (!Array.isArray(inventory.expired) || inventory.expired.length > 4096)) {
    recovery?.(false, new Set()); return false;
  }
  // Native may have captured the inventory before a local response/listener
  // completed during this await. Never resurrect that resolved request.
  if (useTaskStore.getState().approvalQueryToken !== approvalQueryToken) {
    recovery?.(false, new Set()); return false;
  }
  const recovered = inventory.requests.filter((entry) => validIdentity(entry) && entry.params && typeof entry.params === "object" && !Array.isArray(entry.params));
  const omitted = [...(inventory.present ?? []), ...inventory.requests.filter((entry) => validIdentity(entry)
    && (!entry.params || typeof entry.params !== "object" || Array.isArray(entry.params))).map(approvalIdentity)];
  const live = [...recovered.map(approvalIdentity), ...omitted.filter(validIdentity)];
  const expired = new Map((inventory.expired ?? []).filter((entry) => validIdentity(entry) && typeof entry.remoteOwner === "string" && entry.remoteOwner.length > 0 && entry.remoteOwner.length <= 512)
    .map((entry) => [identity(entry), entry.remoteOwner]));
  for (const approval of observed) {
    if (!isCurrent()) return false;
    const key = identity(approvalIdentity(approval)), owner = recoveredOwners.get(approval);
    if (!owner || expired.get(key) !== owner || live.some((entry) => matchesLiveIdentity(approval, entry))) continue;
    const store = useTaskStore.getState();
    if (!store.tasks[approval.threadId]?.approvals.includes(approval)) continue; // A newer listener event won the read.
    store.resolveApproval(approval.threadId, approval.id);
    recoveredOwners.delete(approval);
    useTaskStore.setState((state) => {
      const task = state.tasks[approval.threadId];
      if (!task) return state;
      return { tasks: { ...state.tasks, [approval.threadId]: { ...task,
        expiredApprovals: [...(task.expiredApprovals ?? []), { id: `expired-${crypto.randomUUID()}`, summary: "This remote request expired. Continue on the host to recover the task." }].slice(-64) } } };
    });
    const task = useTaskStore.getState().tasks[approval.threadId];
    if (!task?.activeTurnId && (task?.status === "idle" || task?.status === "starting")) useTaskStore.getState().setTaskStatus(approval.threadId, "interrupted");
  }
  for (const entry of recovered) {
    if (!isCurrent()) return false;
    const store = useTaskStore.getState();
    // Never resolve/re-enqueue a live local request just to change receivedAt,
    // object identity or provenance, and never replace a newer listener event.
    if (store.tasks[entry.threadId]?.approvals.some((approval) => approval.id === entry.id)) continue;
    const approval: PendingApproval = { id: entry.id, method: entry.method, params: entry.params, threadId: entry.threadId, receivedAt: Date.now() };
    store.enqueueApproval(approval);
    const installed = useTaskStore.getState().tasks[entry.threadId]?.approvals.find((value) => value === approval);
    if (installed && typeof entry.remoteOwner === "string" && entry.remoteOwner && entry.remoteOwner.length <= 512) recoveredOwners.set(installed, entry.remoteOwner);
    if (useTaskStore.getState().tasks[entry.threadId]?.status === "idle") useTaskStore.getState().setTaskStatus(entry.threadId, "starting");
  }
  const unavailable = new Set<string>();
  for (const entry of omitted) {
    if (!validIdentity(entry)) continue;
    const known = useTaskStore.getState().tasks[entry.threadId]?.approvals.some((approval) => matchesLiveIdentity(approval, entry));
    if (!known) unavailable.add(entry.threadId);
  }
  recovery?.(true, unavailable);
  return true;
}

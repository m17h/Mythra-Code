import { invoke } from "@tauri-apps/api/core";
import type { PendingApproval } from "../../../types";
import { useTaskStore } from "../../taskStore";
export interface PendingRequestInventory { complete: boolean; requests: PendingApproval[] }
/** A native-verified live channel may be recovered; a timeline record may not. */
export async function reconcilePendingRequests(generation: number, isCurrent: () => boolean,
  read = () => invoke<PendingRequestInventory>("remote_work_pending_requests", { generation })): Promise<boolean> {
  const observed = Object.values(useTaskStore.getState().tasks).flatMap((task) => task.approvals);
  let inventory: PendingRequestInventory;
  try { inventory = await read(); }
  catch { inventory = { complete: false, requests: [] }; }
  if (!isCurrent()) return false;
  const recovered = inventory.complete && Array.isArray(inventory.requests) ? inventory.requests.slice(0, 1024) : [];
  const key = (approval: PendingApproval) => JSON.stringify([approval.threadId, typeof approval.id, approval.id, approval.method]);
  const live = new Map(recovered.map((approval) => [key(approval), approval]));
  for (const approval of observed) {
    const store = useTaskStore.getState();
    if (!store.tasks[approval.threadId]?.approvals.includes(approval)) continue; // A new runtime event won the read race.
    store.resolveApproval(approval.threadId, approval.id);
    if (live.has(key(approval))) continue;
    useTaskStore.setState((state) => {
      const task = state.tasks[approval.threadId];
      if (!task) return state;
      const id = `expired-${crypto.randomUUID()}`;
      return { tasks: { ...state.tasks, [approval.threadId]: { ...task,
        expiredApprovals: [...(task.expiredApprovals ?? []), { id, summary: "This request expired when the other device reconnected. Continue on the other device to recover the task." }].slice(-64) } } };
    });
    const task = useTaskStore.getState().tasks[approval.threadId];
    if (!task?.activeTurnId && (task?.status === "idle" || task?.status === "starting")) useTaskStore.getState().setTaskStatus(approval.threadId, "interrupted");
  }
  for (const approval of recovered) {
    if (!isCurrent() || !approval || typeof approval.threadId !== "string" || !approval.threadId
      || typeof approval.method !== "string" || typeof approval.id !== "number" && typeof approval.id !== "string"
      || !approval.params || typeof approval.params !== "object") continue;
    const store = useTaskStore.getState();
    // Never replace a newer listener-delivered request with this older read.
    if (store.tasks[approval.threadId]?.approvals.some((entry) => entry.id === approval.id)) continue;
    store.enqueueApproval({ ...approval, receivedAt: Date.now() });
    if (useTaskStore.getState().tasks[approval.threadId]?.status === "idle") useTaskStore.getState().setTaskStatus(approval.threadId, "starting");
  }
  return inventory.complete === true;
}

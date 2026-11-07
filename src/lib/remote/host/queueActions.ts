import { adoptRemoteQueuedTurns, releaseRemoteQueueAdmission, releaseRemoteQueueEdit, useTaskStore, type QueuedTurn } from "../../taskStore";
import { invoke } from "@tauri-apps/api/core";
import { subscribeRemoteStateAdoption } from "../../storage";
import { HostReadError } from "./scope";
import { commitHostState, operationStamp } from "./stateCommit";
import type { HostParityActions } from "./parityActions";
import { promptInvocationText } from "./promptText";
import { remoteProvenance } from "./provenance";
const KEY = "kiwi.queuedTurns";
export function createHostQueueActions(pump: (threadId: string) => void) {
  let disposed = false;
  const holds = new Map<string, { threadId: string; id: string; timer: ReturnType<typeof setTimeout> }>();
  const unsubscribe = subscribeRemoteStateAdoption(KEY, adoptRemoteQueuedTurns);
  const release = (handle: string) => {
    const hold = holds.get(handle); if (!hold) return;
    try { releaseRemoteQueueEdit(hold.threadId, hold.id, handle); holds.delete(handle); pump(hold.threadId); }
    catch { if (!disposed) hold.timer = setTimeout(() => release(handle), 250); else holds.delete(handle); }
  };
  const execute: HostParityActions["execute"] = async (op, args, operation) => {
    const threadId = operation.context.activeThread?.id;
    if (!threadId) throw new HostReadError("unsupported", "A conversation is required for this queue action.");
    // Queue ownership is resident even when the host has never selected it;
    // actual delivery still performs isolated, preserve-unread hydration.
    useTaskStore.getState().ensureTask(threadId, operation.context.activeWorkspace!.path);
    let editHandle: string | undefined, queuedTurnId: string | undefined;
    const newPrompt = (op === "prompt.schedule" || op === "prompt.scheduleNew") || op === "queue.edit.finish" && !args.cancel || op === "schedules.edit" || op === "queue.retry";
    if (newPrompt) {
      // Native must advertise BOTH atomic queue-identity preservation and this
      // operation's provider-step gate. Never fall back to a local send.
      let ready = false;
      try { ready = (await invoke<{ ready: boolean }>("remote_work_queue_authorize", { stamp: operationStamp(operation), permission: operation.context.effectiveSettings.permission, ownerHandle: operation.delivery.ownerHandle,
        attemptId: operation.delivery.attemptId, messageId: operation.delivery.messageId })).ready === true; } catch { /* Not installed/ready. */ }
      if (!ready) throw "MYTHRA_REMOTE_REJECTED:unsupported";
    }
    const reject: { device: string; opId: string; opSeq: number }[] = [];
    const committed = await commitHostState(operation, [KEY], (rows) => {
      const raw = rows[0].value;
      const all = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, QueuedTurn[]> : {};
      const entries = [...(all[threadId] ?? [])];
      const id = args.queueId ?? args.scheduleId;
      const index = entries.findIndex((row) => row.id === id);
      const entry = entries[index];
      const editable = () => {
        if (!entry || entry.status === "sending" || entry.remoteDelivery && !["queued", "rejected"].includes(entry.remoteDelivery.disposition)) {
          throw new HostReadError("stale_target", "This instruction may already have been delivered; it cannot be retried or edited.");
        }
      };
      if (op !== "prompt.schedule" && op !== "prompt.scheduleNew") editable();
      if (entry?.editing && op !== "queue.edit.finish" && op !== "queue.edit.begin") throw new HostReadError("busy", "This instruction is currently being edited.");
      if (newPrompt) {
        const text = op === "queue.retry" ? entry.text : String(args.text);
        if (!text.trim()) throw new HostReadError("unsupported", "An instruction is required.");
        if (op === "queue.edit.finish" && (!entry.remoteEdit || entry.remoteEdit.handle !== args.editHandle
          || entry.remoteEdit.device !== operation.identity.device || entry.remoteEdit.generation !== operation.generation || entry.remoteEdit.expiresAt < Date.now())) throw new HostReadError("stale_target", "This edit hold expired.");
        if (entry?.attachments?.length && (!entry.remoteDelivery?.attachmentIds?.length || entry.remoteDelivery.device !== operation.identity.device)) throw new HostReadError("unsupported", "Upload these attachments from this device before replacing the instruction.");
        if (entry?.remoteDelivery) reject.push(entry.remoteDelivery);
        const remoteDelivery = { ...operation.identity, workspaceId: operation.context.activeWorkspace!.id,
          attemptId: operation.delivery.attemptId, messageId: operation.delivery.messageId, disposition: "queued" as const,
          ...(entry?.remoteDelivery?.attachmentIds ? { attachmentIds: entry.remoteDelivery.attachmentIds } : {}),
          ...(operation.delivery.ownerHandle ? { ownerHandle: operation.delivery.ownerHandle } : {}),
          provenance: remoteProvenance(operation, (op === "prompt.schedule" || op === "prompt.scheduleNew") ? "schedule" : "queue-edit") };
        const next: QueuedTurn = { ...(entry ?? {}), id: entry?.id ?? crypto.randomUUID(), threadId, text,
          skillInvocationText: op === "queue.retry" && entry.skillInvocationText !== undefined ? entry.skillInvocationText : promptInvocationText(text),
          attachments: entry?.attachments ?? [], status: "queued", createdAt: entry?.createdAt ?? Date.now(), remoteDelivery,
          editing: true, remoteAdmissionPending: true, remoteEdit: undefined, error: undefined,
          ...((op === "prompt.schedule" || op === "prompt.scheduleNew") ? { deliverAt: args.deliverAt as number } : {}) };
        queuedTurnId = next.id;
        if (index < 0) entries.push(next); else entries[index] = next;
      } else if (op === "queue.remove" || op === "schedules.remove") {
        if (entry.remoteDelivery) reject.push(entry.remoteDelivery);
        entries.splice(index, 1);
      } else if (op === "queue.edit.begin") {
        if (entry.editing && (!entry.remoteEdit || entry.remoteEdit.expiresAt > Date.now())) throw new HostReadError("busy", "Another editor is changing this instruction.");
        editHandle = crypto.randomUUID();
        entries[index] = { ...entry, editing: true, remoteEdit: { handle: editHandle, device: operation.identity.device,
          generation: operation.generation, expiresAt: Date.now() + 120_000 } };
      } else if (op === "queue.edit.finish") {
        if (!entry.remoteEdit || entry.remoteEdit.handle !== args.editHandle || entry.remoteEdit.device !== operation.identity.device
          || entry.remoteEdit.generation !== operation.generation) throw new HostReadError("stale_target", "This edit is no longer owned by this device.");
        entries[index] = { ...entry, editing: undefined, remoteEdit: undefined };
      } else if (op === "schedules.reschedule") entries[index] = { ...entry, deliverAt: args.deliverAt as number, releasedAt: undefined, missedAt: undefined };
      else if (op === "schedules.release") entries[index] = { ...entry, releasedAt: Date.now(), missedAt: undefined };
      else throw new HostReadError("unsupported", "Unsupported queue change.");
      return { [KEY]: { ...all, [threadId]: entries } };
    }, { rejectQueued: reject, queued: newPrompt });
    if (queuedTurnId) {
      if (op === "prompt.scheduleNew") {
        const value = committed.rows?.find((row) => row.key === KEY)?.value as Record<string, QueuedTurn[]> | undefined;
        const entry = value?.[threadId]?.find((entry) => entry.id === queuedTurnId);
        // Native queued CAS proves and retires ONLY the empty preparation
        // lifetime in the same transaction. Older runtimes return its handle:
        // refuse rather than claim a schedule can recover after host restart.
        if (!entry || entry.remoteDelivery?.opId !== operation.identity.opId || entry.remoteDelivery.ownerHandle) throw new HostReadError("unsupported", "This device has not installed restart-safe scheduling admission yet.");
        operation.delivery.adoptDetachedOwner?.();
      }
      await operation.delivery.queued(threadId, queuedTurnId);
      releaseRemoteQueueAdmission(threadId, queuedTurnId, operation.delivery.attemptId);
    }
    if (editHandle) {
      holds.set(editHandle, { threadId, id: String(args.queueId), timer: setTimeout(() => release(editHandle!), 120_000) });
      return { state: "accepted", threadId, editHandle };
    }
    if (typeof args.editHandle === "string") { const hold = holds.get(args.editHandle); if (hold) clearTimeout(hold.timer); holds.delete(args.editHandle); }
    // queue receipt is finalized by executeParityMutation before the pump runs.
    setTimeout(() => pump(threadId), 0);
    return queuedTurnId ? { state: "queued", threadId, queuedTurnId } : { state: "accepted", threadId };
  };
  return { execute, dispose() { disposed = true; unsubscribe(); for (const [handle, hold] of [...holds]) { clearTimeout(hold.timer); release(handle); } } };
}

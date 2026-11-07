import { invoke } from "@tauri-apps/api/core";
import { adoptRemoteQueuedTurns, type QueuedTurn } from "../../taskStore";
import { withRemoteStateCommit, recoverRemoteStateRows } from "../../storage";
import { commitHostState, operationStamp, registerRemoteStateRecovery, type StampedRow } from "./stateCommit";
import { nativeRefusal } from "./nativeActions";
import { HostReadError, idArg } from "./scope";
import type { HostMutationContext } from "./workActions";
import type { RemoteTurnDelivery } from "./workTypes";
import type { RemoteWorkResult } from "../wire";
const KEY = "kiwi.queuedTurns";
type Operation = HostMutationContext & { delivery: RemoteTurnDelivery };
function queueRow(rows: readonly StampedRow[], threadId: string, queueId: string): QueuedTurn | undefined {
  if (rows.length !== 1 || rows[0].key !== KEY || !rows[0].value || typeof rows[0].value !== "object" || Array.isArray(rows[0].value)) throw new HostReadError("uncertain", "The queue claim could not be confirmed.");
  return (rows[0].value as Record<string, QueuedTurn[]>)[threadId]?.find((entry) => entry.id === queueId);
}
/** A steer alias alone is insufficient: the source queue row must be held
 * durably before input, otherwise a crash can deliver it again as a new turn.
 * Missing atomic native claim refuses before any provider call. */
export async function executeQueueSteer(args: Readonly<Record<string, unknown>>, operation: Operation,
  steer: (entry: QueuedTurn) => Promise<RemoteWorkResult>): Promise<{ state: "accepted"; threadId: string }> {
  const threadId = operation.context.activeThread!.id, queueId = idArg(args.queueId), targetHandle = idArg(args.target);
  const stamp = operationStamp(operation);
  const claimArgs = { stamp, queueId, targetHandle, permission: operation.context.effectiveSettings.permission,
    attemptId: operation.delivery.attemptId, messageId: operation.delivery.messageId };
  let entry: QueuedTurn | undefined;
  await withRemoteStateCommit([KEY], async (adopt) => {
    operation.assertAllowed();
    const snapshot = await invoke<{ rows: StampedRow[] }>("remote_state_snapshot", { stamp, keys: [KEY] });
    const previous = queueRow(snapshot.rows, threadId, queueId);
    if (!previous || previous.editing || previous.status === "sending" || previous.remoteDelivery && !["queued", "rejected"].includes(previous.remoteDelivery.disposition)
      || previous.deliverAt !== undefined && previous.releasedAt === undefined) throw new HostReadError("stale_target", "This instruction is not available to steer.");
    // Do not reinterpret a host-local attachment as viewer authority.
    if (previous.attachments.length) throw new HostReadError("unsupported", "Send attachment-bearing instructions separately instead of steering this queue entry.");
    operation.assertAllowed();
    const nativeArgs = { ...claimArgs, expectedRevision: snapshot.rows[0].revision };
    const install = (rows: StampedRow[]) => {
      const claimed = queueRow(rows, threadId, queueId);
      if (!claimed || claimed.text !== previous.text || claimed.remoteDelivery?.opId !== stamp.opId
        || claimed.remoteDelivery.device !== stamp.device || claimed.remoteDelivery.disposition !== "dispatched") throw new HostReadError("uncertain", "The exact queued instruction claim was not confirmed.");
      return claimed;
    };
    try {
      const reply = await invoke<{ rows: StampedRow[] }>("remote_work_queue_steer_claim", nativeArgs);
      entry = install(reply.rows); adopt(KEY, reply.rows[0].value); adoptRemoteQueuedTurns(reply.rows[0].value);
    } catch (reason) {
      if (typeof reason === "string" && /not found|unknown command/i.test(reason)) throw new HostReadError("unsupported", "This device has not installed atomic queued steering yet.");
      const error = reason instanceof HostReadError ? reason : nativeRefusal(reason);
      if (error.code !== "uncertain") throw error;
      registerRemoteStateRecovery(`${stamp.device}:${stamp.opId}:queue-steer`, async () => {
        // Reconcile the SAME claim only; never repeat provider input.
        const reply = await invoke<{ rows: StampedRow[] }>("remote_work_queue_steer_claim", nativeArgs);
        install(reply.rows); recoverRemoteStateRows(reply.rows); adoptRemoteQueuedTurns(reply.rows[0].value);
      });
      throw Object.assign(error, { holdRemoteState: true });
    }
  });
  // Our own claim changed the public revision. After it, retain authority and
  // exact turn ownership, not the obsolete pre-claim queue revision.
  operation.delivery.assertAllowed();
  const outcome = await steer(entry!);
  if (outcome.state !== "accepted") throw new HostReadError("uncertain", "Queued steering was not confirmed. Its held instruction will not be sent automatically.");
  await commitHostState({ ...operation, assertAllowed: () => operation.delivery.assertAllowed() }, [KEY], (rows) => {
    const claimed = queueRow(rows, threadId, queueId);
    if (!claimed || claimed.remoteDelivery?.opId !== stamp.opId || claimed.remoteDelivery.device !== stamp.device) throw new HostReadError("uncertain", "The steered queue entry changed before cleanup.");
    const all = rows[0].value as Record<string, QueuedTurn[]>;
    return { [KEY]: { ...all, [threadId]: all[threadId].filter((entry) => entry.id !== queueId) } };
  }, { adopt: (rows) => adoptRemoteQueuedTurns(rows[0].value) });
  return { state: "accepted", threadId };
}

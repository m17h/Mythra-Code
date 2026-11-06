import { invoke } from "@tauri-apps/api/core";
import { recoverRemoteStateRows, withRemoteStateCommit } from "../../storage";
import type { HostMutationContext } from "./workActions";
import { HostReadError } from "./scope";
export interface StampedRow { key: string; value: unknown; revision: number | null }
const recovery = new Map<string, () => Promise<void>>();
export function registerRemoteStateRecovery(key: string, recover: () => Promise<void>): void {
  recovery.set(key, async () => { await recover(); recovery.delete(key); });
}
export async function reconcileRemoteStateCommits(): Promise<void> { for (const resume of [...recovery.values()]) await resume(); }
export function operationStamp(operation: HostMutationContext) {
  const ctx = operation.context;
  return { generation: operation.generation, ...operation.identity,
    grantRevision: operation.grantRevision, workspaceId: ctx.activeWorkspace?.id, threadId: ctx.activeThread?.id };
}
/** Domain adapters transform native snapshots, never render-captured state. */
export function commitHostState(operation: HostMutationContext, keys: readonly string[],
  transform: (rows: readonly StampedRow[]) => Readonly<Record<string, unknown>>,
  options: { rejectQueued?: { device: string; opId: string; opSeq: number }[]; queued?: boolean; adopt?(rows: readonly StampedRow[]): void } = {}) {
  return withRemoteStateCommit(keys, async (adopt) => {
    operation.assertAllowed();
    const stamp = operationStamp(operation);
    const snapshot = await invoke<{ rows: StampedRow[] }>("remote_state_snapshot", { stamp, keys });
    operation.assertAllowed();
    if (snapshot.rows.length !== keys.length || keys.some((key) => !snapshot.rows.some((row) => row.key === key))) throw new HostReadError("uncertain", "The host state snapshot could not be confirmed.");
    const values = transform(snapshot.rows);
    if (Object.keys(values).some((key) => !keys.includes(key))) throw new HostReadError("unsupported", "Unexpected state write.");
    operation.assertAllowed();
    const args = { stamp,
      writes: snapshot.rows.filter((row) => Object.hasOwn(values, row.key)).map((row) => ({ key: row.key, expectedRevision: row.revision, value: values[row.key] })),
      rejectQueued: options.rejectQueued ?? [], queued: options.queued === true };
    type Result = { result: unknown; rows?: StampedRow[]; replayed: boolean };
    const withRows = async (result: Result): Promise<Result> => {
      if (result.rows || !result.replayed) return result;
      // Native replay confirms the prior transaction before these local-only
      // reads; no grant, path or raw state is exposed to the viewer.
      return { ...result, rows: await Promise.all(keys.map(async (key) => ({ key, value: await invoke("state_read", { key }), revision: null }))) };
    };
    let result: Result | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { result = await withRows(await invoke<Result>("remote_state_commit", args)); if (!result.rows) throw new Error("Missing commit rows"); break; }
      catch (reason) {
        const code = typeof reason === "string" ? /^MYTHRA_REMOTE_REJECTED:([a-z_]+)/.exec(reason)?.[1]
          : reason && typeof reason === "object" && "code" in reason ? reason.code : null;
        if (["forbidden", "stale_target", "unsupported", "host_unavailable"].includes(String(code))) throw reason;
        if (attempt < 2) continue; // SAME identity/expected revisions, never a new op.
        const key = `${stamp.device}:${stamp.opId}`;
        recovery.set(key, async () => {
          const replay = await withRows(await invoke<Result>("remote_state_commit", args));
          if (!replay.rows) throw new Error("Remote commit still unconfirmed");
          const rows = await Promise.all(keys.map(async (key) => ({ key, value: await invoke("state_read", { key }), revision: null })));
          recoverRemoteStateRows(rows); options.adopt?.(rows); recovery.delete(key);
        });
        throw Object.assign(new HostReadError("uncertain", "The state commit needs recovery; its old local saves remain fenced."), { holdRemoteState: true });
      }
    }
    if (!result?.rows) throw new HostReadError("uncertain", "The host state commit has no confirmed adoption rows.");
    for (const row of result.rows) adopt(row.key, row.value);
    options.adopt?.(result.rows);
    return result;
  });
}

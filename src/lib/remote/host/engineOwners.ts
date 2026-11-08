import { nativeHostTransport, type HostTransport } from "./bridge";
import { finishRemoteOwnerPreparations, forgetRemoteOwnerPreparations } from "./promptPreparation";
/** Ephemeral native lifetimes. Never restore tokens from disk or a timeline. */
export interface RemoteEngineOwner {
  generation: number; threadId: string; runId: string; kind: "parent" | "workflow" | "start"; ownerHandle: string;
  /** A typed follow-up may keep the logical parent while opening a new native lifetime. */
  parentRunId?: string;
  stopEpoch?: number;
  /** Tracking-only local lifetime; survives remote renderer lease changes. */
  local?: true;
}
interface Lifetime { owner: RemoteEngineOwner; retiring?: boolean; finishing?: Promise<boolean>; timer?: ReturnType<typeof setTimeout>; wake?: () => void }
const owners = new Map<string, Lifetime>();
const threads = new Map<string, string>();
/** Threads another device last gave work to. Outlives the owner on purpose: a child
 * can start after that turn ended or the lease changed, and it's still that device's
 * work. Only a local send clears it. Being wrong here only skips an optional checkpoint. */
const remoteWorkThreads = new Set<string>();
const REMOTE_WORK_LIMIT = 4_096;
export function noteRemoteWork(threadId: string): void {
  remoteWorkThreads.delete(threadId);
  remoteWorkThreads.add(threadId);
  if (remoteWorkThreads.size > REMOTE_WORK_LIMIT) remoteWorkThreads.delete(remoteWorkThreads.values().next().value!);
}
export function noteLocalWork(threadId: string): void { remoteWorkThreads.delete(threadId); }
export function hasRemoteWork(threadId: string): boolean { return remoteWorkThreads.has(threadId); }
export function rememberRemoteEngineOwner(owner: RemoteEngineOwner): void {
  if (!owner.local && !owner.threadId.startsWith("command:") && !owner.threadId.startsWith("preparing:")) noteRemoteWork(owner.threadId);
  const previous = threads.get(owner.threadId);
  if (previous && previous !== owner.ownerHandle) void finishRemoteEngineOwner(previous);
  owners.set(owner.ownerHandle, owners.get(owner.ownerHandle) ?? { owner });
  owners.get(owner.ownerHandle)!.owner = owner;
  threads.set(owner.threadId, owner.ownerHandle);
}
export function remoteEngineOwner(threadId: string, parentRunId?: string, workflowRunId?: string): RemoteEngineOwner | undefined {
  const owner = owners.get(threads.get(threadId) ?? "")?.owner;
  return owner && (owner.kind === "parent" ? (owner.parentRunId ?? owner.runId) === parentRunId
    : owner.kind === "workflow" && owner.runId === workflowRunId) ? owner : undefined;
}
/** Start owners have no parent/workflow ID yet, but are still exact Stop
 * targets during preparation. Never infer one from a restored receipt. */
export function remoteThreadOwner(threadId: string): RemoteEngineOwner | undefined { return owners.get(threads.get(threadId) ?? "")?.owner; }
export function remoteStartOwner(threadId: string): RemoteEngineOwner | undefined {
  const owner = owners.get(threads.get(threadId) ?? "")?.owner;
  return owner?.kind === "start" ? owner : undefined;
}
function forget(handle: string): void {
  forgetRemoteOwnerPreparations(handle);
  const entry = owners.get(handle); if (!entry) return;
  clearTimeout(entry.timer); entry.wake?.(); owners.delete(handle);
  if (threads.get(entry.owner.threadId) === handle) threads.delete(entry.owner.threadId);
}
/** Normal completion never kills a child. A false native confirmation keeps
 * ownership visible and retries only for this bounded finalization lifetime. */
export function finishRemoteEngineOwner(handle: string, transport: HostTransport = nativeHostTransport): Promise<boolean> {
  const entry = owners.get(handle);
  if (!entry) return Promise.resolve(true);
  if (entry.retiring) return Promise.resolve(false);
  if (entry.finishing) return entry.finishing;
  const work = (async () => {
    for (let attempt = 0; attempt < 6 && owners.get(handle) === entry && !entry.retiring; attempt++) {
      try {
        if (!entry.owner.local && !await finishRemoteOwnerPreparations(handle)) return false;
        if (entry.retiring || owners.get(handle) !== entry) return false;
        const result = await transport.invoke<{ confirmed: boolean }>(entry.owner.local ? "remote_local_owner_finish" : "remote_work_owner_finish", { ...(entry.owner.local ? {} : { generation: entry.owner.generation }), ownerHandle: handle });
        if (result?.confirmed === true) { forget(handle); return true; }
      } catch { /* Lease loss/restart is not permission to kill or rerun a child. */ }
      if (attempt < 5 && owners.get(handle) === entry && !entry.retiring) await new Promise<void>((resolve) => { entry.wake = resolve; entry.timer = setTimeout(() => { entry.wake = undefined; resolve(); }, Math.min(1000, 100 * 2 ** attempt)); });
    }
    return false;
  })();
  entry.finishing = work;
  void work.finally(() => { if (owners.get(handle) === entry) entry.finishing = undefined; });
  return work;
}
/** Must precede synchronous renderer run retirement so its normal-finally hook
 * cannot race native owner_retire by closing the token through owner_finish. */
export function markRemoteEngineRetiring(handle: string): void { const entry = owners.get(handle); if (entry) entry.retiring = true; }
export function remoteEngineStopped(handle: string): void { forget(handle); }
export function forgetRemoteEngineOwner(threadId: string): void {
  const handle = threads.get(threadId); threads.delete(threadId);
  if (handle) void finishRemoteEngineOwner(handle);
}
export function finishRemoteThreadOwner(threadId: string, parentPresent: boolean, workflowRunId?: string): Promise<boolean> | undefined {
  const entry = owners.get(threads.get(threadId) ?? "");
  if (entry && !entry.retiring && (entry.owner.kind === "parent" ? !parentPresent : entry.owner.kind === "workflow" ? entry.owner.runId !== workflowRunId : !parentPresent && !workflowRunId)) {
    return finishRemoteEngineOwner(entry.owner.ownerHandle);
  }
}
export function clearRemoteEngineOwners(generation: number): void { for (const [handle, entry] of owners) if (!entry.owner.local && entry.owner.generation === generation) forget(handle); }
export function isLiveRemoteEngineOwner(handle: string): boolean { return owners.has(handle) && !owners.get(handle)?.retiring; }

export function hasRemoteEngineOwners(): boolean { return owners.size > 0; }
export function remoteEngineOwnerThreads(): IterableIterator<string> { return threads.keys(); }

/** Optional local tracking never changes a provider policy or requires a remote
 * grant. The field is stripped natively before provider input. */
export async function openLocalEngineOwner(workspaceId: string, runId: string, kind: "parent" | "workflow" | "start", threadId?: string): Promise<string | undefined> {
  try {
    const result = await nativeHostTransport.invoke<{ ownerHandle: string }>("remote_local_owner_open", { workspaceId, runId, kind, threadId });
    return typeof result?.ownerHandle === "string" && result.ownerHandle ? result.ownerHandle : undefined;
  } catch { return undefined; } // Tracking failure must not prevent ordinary local work.
}

/** Ephemeral native lifetimes. Never restore tokens from disk or a timeline. */
export interface RemoteEngineOwner { generation: number; threadId: string; runId: string; kind: "parent" | "workflow"; ownerHandle: string }
const owners = new Map<string, RemoteEngineOwner>();
export function rememberRemoteEngineOwner(owner: RemoteEngineOwner): void { owners.set(owner.threadId, owner); }
export function remoteEngineOwner(threadId: string, parentRunId?: string, workflowRunId?: string): RemoteEngineOwner | undefined {
  const owner = owners.get(threadId);
  return owner && owner.runId === (owner.kind === "parent" ? parentRunId : workflowRunId) ? owner : undefined;
}
export function forgetRemoteEngineOwner(threadId: string): void { owners.delete(threadId); }
export function clearRemoteEngineOwners(generation: number): void { for (const [id, owner] of owners) if (owner.generation === generation) owners.delete(id); }

export function isLiveRemoteEngineOwner(handle: string): boolean { return [...owners.values()].some((owner) => owner.ownerHandle === handle); }

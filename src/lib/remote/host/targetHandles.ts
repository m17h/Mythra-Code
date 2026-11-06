import { invoke } from "@tauri-apps/api/core";
import type { PendingApproval } from "../../../types";
import { useTaskStore } from "../../taskStore";
import type { RemoteOperationIdentity, WireWorkTarget } from "../wire";
import { HostReadError } from "./scope";
import type { RemoteStopSnapshot } from "./workTypes";

export interface WorkTarget {
  wire: WireWorkTarget; device: string; workspaceId: string; provider: string;
  stop?: RemoteStopSnapshot; approval?: PendingApproval; expires: number;
}
const stale = () => new HostReadError("stale_target", "This request or turn has ended. Refresh the conversation.");
export function sameStop(a: RemoteStopSnapshot, b: RemoteStopSnapshot): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId && a.startRequestId === b.startRequestId
    && a.agentRunId === b.agentRunId && a.runStartedAt === b.runStartedAt && a.parentRunId === b.parentRunId
    && a.workflowId === b.workflowId && a.workflowRunId === b.workflowRunId;
}
/** Renderer identity checks supplement, never replace, native owner fencing. */
export class WorkTargets {
  private entries = new Map<string, WorkTarget>();
  private disposed = false;
  constructor(private readonly generation: number, private readonly isCurrent: () => boolean) {}
  dispose(): void { this.disposed = true; this.entries.clear(); }
  private check(): void { if (this.disposed || !this.isCurrent()) throw stale(); }
  async register(input: Omit<WorkTarget, "wire" | "expires">, kind: WireWorkTarget["kind"]): Promise<WireWorkTarget> {
    this.check();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= Date.now()) { this.entries.delete(key); continue; }
      if (entry.device === input.device && entry.workspaceId === input.workspaceId && entry.provider === input.provider
        && entry.wire.kind === kind && entry.approval === input.approval
        && (!input.stop || entry.stop && sameStop(entry.stop, input.stop))) return { ...entry.wire };
    }
    // Do not evict live ownership handles behind another viewer's buttons.
    if (this.entries.size >= 1024) throw new HostReadError("busy", "Too many outstanding host requests. Try again shortly.");
    const approval = input.approval;
    const params = approval?.params;
    const result = await invoke<{ handle: string }>("remote_work_target_register", {
      generation: this.generation, device: input.device, kind, workspaceId: input.workspaceId, provider: input.provider,
      ...input.stop, threadId: approval?.threadId ?? input.stop?.threadId,
      ...(approval ? { requestId: approval.id, method: approval.method,
        turnId: typeof params?.turnId === "string" ? params.turnId : undefined,
        itemId: typeof params?.itemId === "string" ? params.itemId : undefined } : {}),
    });
    this.check();
    if (!result || typeof result.handle !== "string" || !result.handle || result.handle.length > 256) throw stale();
    const wire = { handle: result.handle, kind };
    this.entries.set(wire.handle, { ...input, wire, expires: Date.now() + 5 * 60_000 });
    return { ...wire };
  }
  resolve(handle: string, device: string, threadId: string): WorkTarget {
    this.check();
    const entry = this.entries.get(handle);
    if (!entry || entry.device !== device || entry.expires <= Date.now()
      || (entry.approval?.threadId ?? entry.stop?.threadId) !== threadId) throw stale();
    if (entry.approval && !useTaskStore.getState().tasks[threadId]?.approvals.includes(entry.approval)) throw stale();
    return entry;
  }
  async claim(entry: WorkTarget, identity: RemoteOperationIdentity): Promise<void> {
    this.check();
    await invoke("remote_work_target_claim", { generation: this.generation, ...identity, handle: entry.wire.handle });
    this.check();
  }
  consume(entry: WorkTarget): void { this.entries.delete(entry.wire.handle); }
}

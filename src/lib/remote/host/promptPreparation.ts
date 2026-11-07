import type { CreatedWorktree } from "../../worktrees";
import type { DeviceGrant } from "../types";
import { recoverRemoteStateRows, withRemoteStateCommit } from "../../storage";
import { useTaskStore } from "../../taskStore";
import { nativeHostTransport, type HostTransport } from "./bridge";
import { nativeRefusal } from "./nativeActions";
import { noteCheckpointSkipped } from "./remoteCheckpoint";
import { HostReadError } from "./scope";
import { registerRemoteStateRecovery, type StampedRow } from "./stateCommit";
import type { RemoteDispatchInfo, RemoteTurnDelivery } from "./workTypes";

const keys = ["kiwi.threadWorktrees", "kiwi.threadProjects", "kiwi.checkpoints", "kiwi.checkpointHeads"] as const;
type Kind = "isolatedCreate" | "gitInit" | "checkpointBefore" | "checkpointAfter";
interface Prepared { preparationId: string; kind: Kind; opId: string; checkpointId?: string | null; worktree?: CreatedWorktree | null; rows: StampedRow[] }
interface Bound { bound: true; rows: StampedRow[] }
const instances = new WeakMap<RemoteTurnDelivery, RemotePromptPreparation>();
const owners = new Map<string, Set<RemotePromptPreparation>>();
const checkpoints = new Map<string, RemotePromptPreparation>();
let executionRoot: ((workspaceId: string, threadId?: string) => string | undefined) | undefined;
export function configureRemotePreparationRoots(resolve: typeof executionRoot): () => void {
  executionRoot = resolve; return () => { if (executionRoot === resolve) executionRoot = undefined; };
}
let settleCheckpoint: ((id: string, error: string) => void) | undefined;
export function configureRemoteCheckpointSettlement(handler: ((id: string, error: string) => void) | undefined): () => void {
  settleCheckpoint = handler;
  return () => { if (settleCheckpoint === handler) settleCheckpoint = undefined; };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const unavailable = () => new HostReadError("uncertain", "Git preparation could not be confirmed. Inspect the project on the host before trying again.");
function rowsOf(reply: unknown): StampedRow[] {
  if (!reply || typeof reply !== "object" || !("rows" in reply) || !Array.isArray(reply.rows)
    || reply.rows.length !== keys.length || keys.some((key) => (reply.rows as StampedRow[]).filter((row) => row?.key === key).length !== 1)
    || reply.rows.some((row: StampedRow) => !row || !keys.includes(row.key as typeof keys[number]) || row.revision !== null && (!Number.isSafeInteger(row.revision) || row.revision! < 0) || !Object.hasOwn(row, "value"))) throw unavailable();
  return reply.rows as StampedRow[];
}
/** Native instruction/kind receipts own effects. This lane only serializes host
 * persistence and adopts authoritative rows; it never pays a second prompt. */
export class RemotePromptPreparation {
  private readonly meta;
  private readonly owner: string;
  private checkpointId?: string;
  private isolated = false;
  private draftCheckpoint = false;
  private preparedRoot?: string;
  private holds = 0;
  private settlementRequested = false;
  private predecessorTurnId?: string;
  private needsBind = false;
  private threadId?: string;
  private delivered = false;
  private turnId?: string;
  private completed = false;
  private uncertainMutation = false;
  private completing?: Promise<boolean>;
  private settled = deferred();
  constructor(private readonly delivery: RemoteTurnDelivery, private readonly workspaceId: string, private readonly originalThreadId?: string,
    private readonly transport: HostTransport = nativeHostTransport) {
    this.meta = delivery.metadata();
    if (!this.meta.ownerHandle) throw new HostReadError("unsupported", "A native instruction owner is required for Git preparation.");
    this.owner = this.meta.ownerHandle; this.threadId = originalThreadId;
    const set = owners.get(this.owner) ?? new Set(); set.add(this); owners.set(this.owner, set);
  }
  private async authority(): Promise<DeviceGrant> {
    this.delivery.assertAllowed();
    const grant = await this.transport.invoke<DeviceGrant | null>("remote_work_grant", { generation: this.meta.generation, device: this.meta.device });
    this.delivery.assertAllowed();
    if (!grant?.view || !grant.work || !grant.capabilities.terminal) throw new HostReadError("forbidden", "This preparation needs Work and Terminal access. Enable them in the host's device settings.");
    return grant;
  }
  private async native<T extends Prepared | Bound>(command: string, extra: Record<string, unknown>, validate: (result: T) => void): Promise<T> {
    return withRemoteStateCommit(keys, async (adopt) => {
      const grant = await this.authority();
      const { generation, device, opId, opSeq } = this.meta;
      const args = { stamp: { generation, device, opId, opSeq, grantRevision: grant.revision, workspaceId: this.workspaceId,
        ...(this.originalThreadId ? { threadId: this.originalThreadId } : {}) }, ownerHandle: this.owner, ...extra };
      const check = (reply: T) => { const rows = rowsOf(reply); validate(reply); return rows; };
      let reply: T;
      try { reply = await this.transport.invoke<T>(command, args); check(reply); }
      catch (reason) {
        const error = reason instanceof HostReadError ? reason : nativeRefusal(reason);
        if (["forbidden", "stale_target", "unsupported", "host_unavailable"].includes(error.code)) throw error;
        // Same native receipt/kind only. A started/uncertain helper never reruns.
        this.uncertainMutation = true;
        registerRemoteStateRecovery(`${device}:${opId}:prepare:${command}:${String(extra.kind ?? "")}`, async () => {
          const recovered = await this.transport.invoke<T>(command, args);
          recoverRemoteStateRows(check(recovered));
          if (command === "remote_prompt_preparation_bind") { this.needsBind = false; this.threadId = String(extra.threadId); }
          if (extra.kind === "isolatedCreate") { const prepared = recovered as Prepared; this.isolated = true; this.needsBind = true; this.preparedRoot = prepared.worktree!.path; }
          if (extra.kind === "checkpointBefore") {
            this.checkpointId = (recovered as Prepared).checkpointId!; this.threadId = typeof extra.threadId === "string" ? extra.threadId : undefined;
            this.needsBind ||= !this.threadId; this.draftCheckpoint ||= !this.threadId; checkpoints.set(this.checkpointId, this);
          }
          if (extra.kind === "checkpointAfter") { this.completed = true; if (this.checkpointId) checkpoints.delete(this.checkpointId); }
          this.uncertainMutation = false;
        });
        throw Object.assign(unavailable(), { holdRemoteState: true });
      }
      // Even a grant change after native success cannot discard committed rows.
      for (const row of check(reply)) adopt(row.key, row.value);
      return reply;
    });
  }
  private prepare(kind: Kind, threadId?: string, label?: string): Promise<Prepared> {
    const safeLabel = label ? [...label.replace(/\0/g, "")].slice(0, 60).join("") : undefined; // <=240 UTF-8 bytes
    return this.native<Prepared>("remote_prompt_prepare", { kind, ...(threadId ? { threadId } : {}), ...(safeLabel ? { label: safeLabel } : {}) }, (reply) => {
      if (reply.kind !== kind || reply.opId !== this.meta.opId || typeof reply.preparationId !== "string" || !reply.preparationId) throw unavailable();
      if (kind.startsWith("checkpoint") && (typeof reply.checkpointId !== "string" || !reply.checkpointId)) throw unavailable();
      if (kind === "isolatedCreate" && (!reply.worktree || ["path", "branch", "baseCommit", "gitDir"].some((key) => typeof reply.worktree?.[key as keyof CreatedWorktree] !== "string" || !reply.worktree[key as keyof CreatedWorktree]))) throw unavailable();
    });
  }
  async isolatedCreate(label?: string): Promise<CreatedWorktree> {
    const reply = await this.prepare("isolatedCreate", undefined, label);
    this.isolated = true; this.needsBind = true; this.preparedRoot = reply.worktree!.path;
    return reply.worktree!;
  }
  async gitInit(): Promise<void> {
    try { await this.prepare("gitInit"); }
    catch (reason) { if (!(reason instanceof HostReadError && ["forbidden", "unsupported"].includes(reason.code))) throw reason; }
  }
  get preparedCheckpointId(): string | undefined { return this.checkpointId; }
  get ownsNativeBinding(): boolean { return this.isolated || this.draftCheckpoint; }
  hold(): void { this.holds++; }
  release(): void { if (this.holds) this.holds--; if (!this.holds && this.settlementRequested) this.settled.resolve(); }
  async checkpointBefore(threadId = this.threadId, label?: string): Promise<string | undefined> {
    try {
      // Optional snapshots do not prevent ordinary Work-only prompt delivery.
      await this.authority();
      const root = this.preparedRoot ?? executionRoot?.(this.workspaceId, threadId);
      if (!root) { if (threadId) noteCheckpointSkipped(threadId); return undefined; }
      // Unsupported/non-root repositories are an optional read failure, not an
      // uncertain Git mutation. Never enter the durable helper latch for them.
      let identity: { isRoot?: boolean };
      try { identity = await this.transport.invoke("remote_studio_git_identity", { root }); }
      catch { if (threadId) noteCheckpointSkipped(threadId); return undefined; }
      if (identity?.isRoot !== true) { if (threadId) noteCheckpointSkipped(threadId); return undefined; }
      this.predecessorTurnId = threadId ? useTaskStore.getState().tasks[threadId]?.lastCompletedTurnId : undefined;
      const reply = await this.prepare("checkpointBefore", threadId, label);
      this.checkpointId = reply.checkpointId!; this.threadId = threadId;
      this.needsBind ||= !threadId; this.draftCheckpoint ||= !threadId;
      checkpoints.set(this.checkpointId, this);
      return this.checkpointId;
    } catch (reason) {
      if (reason instanceof HostReadError && ["forbidden", "unsupported"].includes(reason.code)) {
        if (threadId) noteCheckpointSkipped(threadId); return undefined;
      }
      throw reason;
    }
  }
  async bind(threadId: string): Promise<void> {
    if (this.threadId && this.threadId !== threadId) throw new HostReadError("stale_target", "The prepared instruction belongs to another thread.");
    if (this.needsBind) {
      await this.native<Bound>("remote_prompt_preparation_bind", { threadId }, (reply) => { if (reply.bound !== true) throw unavailable(); });
      this.needsBind = false;
    }
    this.threadId = threadId;
  }
  markDelivered(info: Partial<RemoteDispatchInfo>): void {
    this.delivered = true;
    if (info.threadId) this.threadId = info.threadId;
    if (info.turnId) this.turnId = info.turnId;
    if (!this.checkpointId && this.threadId) noteCheckpointSkipped(this.threadId);
  }
  settle(): void { this.settlementRequested = true; if (!this.holds) this.settled.resolve(); }
  async complete(expectedTurnId?: string): Promise<boolean> {
    if (expectedTurnId && expectedTurnId === this.predecessorTurnId) return true;
    await this.settled.promise;
    if (expectedTurnId && this.turnId && expectedTurnId !== this.turnId) return true;
    if (this.completed || !this.checkpointId) return true;
    if (!this.delivered || !this.threadId || this.needsBind) { if (this.threadId) noteCheckpointSkipped(this.threadId);
      settleCheckpoint?.(this.checkpointId, "This run from another device ended before its result could be saved, so only its starting point was saved."); return false; }
    if (this.completing) return this.completing;
    this.completing = (async () => {
      try {
        const reply = await this.prepare("checkpointAfter", this.threadId);
        if (reply.checkpointId !== this.checkpointId) throw unavailable();
        this.completed = true; checkpoints.delete(this.checkpointId!); return true;
      } catch (reason) {
        if (this.threadId) noteCheckpointSkipped(this.threadId);
        if (reason instanceof HostReadError && ["forbidden", "stale_target", "unsupported", "host_unavailable"].includes(reason.code)) {
          settleCheckpoint?.(this.checkpointId!, "That device lost access before this run finished, so only its starting point was saved.");
          checkpoints.delete(this.checkpointId!); this.completed = true; return false;
        }
        throw reason;
      } finally { this.completing = undefined; }
    })();
    return this.completing;
  }
  async discard(): Promise<void> {
    if (!this.isolated || this.delivered || !this.needsBind) return;
    await this.native<Prepared>("remote_prompt_preparation_discard", {}, (reply) => {
      if (reply.opId !== this.meta.opId) throw unavailable();
    });
    this.isolated = false; this.needsBind = false;
    if (this.checkpointId) checkpoints.delete(this.checkpointId);
  }
  matchesThread(threadId: string): boolean { return this.threadId === threadId; }
  abandon(): void {
    if (this.checkpointId) {
      settleCheckpoint?.(this.checkpointId, "This step from another device stopped before it began, so only its starting point was saved.");
      checkpoints.delete(this.checkpointId);
    }
    this.completed = true;
  }
  sameOwner(handle: string | undefined): boolean { return handle === this.owner; }
  /** A failed anonymous root has no task-driven owner finisher. Release only
   * its own start lifetime; never a shared parent/workflow child receipt. */
  async finishRejectedDraft(): Promise<void> {
    await this.settled.promise;
    if (this.delivered || this.uncertainMutation || this.delivery.ownerRunId !== this.delivery.attemptId) return;
    try {
      const result = await this.transport.invoke<{ confirmed: boolean }>("remote_work_owner_finish", { generation: this.meta.generation, ownerHandle: this.owner });
      if (result?.confirmed) forgetRemoteOwnerPreparations(this.owner);
    } catch { /* A lost lease is not permission to use any local fallback. */ }
  }
  async beforeOwnerFinish(): Promise<boolean> {
    await this.settled.promise;
    if (this.uncertainMutation) return false; // Keep its native owner recoverable.
    if (!this.delivered) return true; // No provider input: not a completed checkpoint.
    try { await this.complete(); return true; } catch { return false; }
  }
  forget(): void { if (this.checkpointId) checkpoints.delete(this.checkpointId); }
}
export function remotePromptPreparation(delivery: RemoteTurnDelivery, workspaceId: string, originalThreadId?: string): RemotePromptPreparation {
  let instance = instances.get(delivery);
  if (!instance || !instance.sameOwner(delivery.ownerHandle)) { instance = new RemotePromptPreparation(delivery, workspaceId, originalThreadId); instances.set(delivery, instance); }
  return instance;
}
export function markRemotePromptDelivered(delivery: RemoteTurnDelivery, info: Partial<RemoteDispatchInfo>): void { instances.get(delivery)?.markDelivered(info); }
export function settleRemotePromptPreparation(delivery: RemoteTurnDelivery): void { instances.get(delivery)?.settle(); }
export function completeRemotePreparedCheckpoint(checkpointId: string, turnId?: string): Promise<boolean> | undefined { return checkpoints.get(checkpointId)?.complete(turnId); }
export async function finishRemoteOwnerPreparations(ownerHandle: string): Promise<boolean> {
  for (const preparation of owners.get(ownerHandle) ?? []) if (!await preparation.beforeOwnerFinish()) return false;
  return true;
}
export function forgetRemoteOwnerPreparations(ownerHandle: string): void {
  for (const preparation of owners.get(ownerHandle) ?? []) { preparation.settle(); preparation.forget(); }
  owners.delete(ownerHandle);
}

export function abandonRemoteCheckpoint(threadId: string): void {
  for (const entry of checkpoints.values()) if (entry.matchesThread(threadId)) entry.abandon();
}

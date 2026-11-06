import { invoke } from "@tauri-apps/api/core";
import { flushPendingStateWrites } from "../../storage";
import { useTaskStore, type RemoteQueuedDelivery } from "../../taskStore";
import type { DeviceGrant } from "../types";
import type { RemoteOperationIdentity, RemoteWorkResult } from "../wire";
import { HostReadError } from "./scope";
import type { RemoteDispatchInfo, RemoteTurnDelivery } from "./workTypes";

export interface DeliveryReceipt extends RemoteOperationIdentity {
  generation: number;
  disposition: "preparing" | RemoteQueuedDelivery["disposition"];
  workspaceId: string; attemptId: string; messageId: string;
  threadId?: string; queuedTurnId?: string; startRequestId?: string; turnId?: string;
  ownerHandle?: string; provider?: string; permission?: string; errorCode?: string; stopHandle?: string;
}
export interface JournalOptions {
  generation: number; identity: RemoteOperationIdentity; workspaceId: string;
  attemptId?: string; messageId?: string; threadId?: string; queuedTurnId?: string;
  targetHandle?: string;
  isCurrent(): boolean;
  assertAllowed(): void;
  validateGrant(grant: DeviceGrant | null): void;
}
/** Rust owns the authoritative journal; the queue mirror is an extra crash latch. */
export class RemoteDeliveryJournal implements RemoteTurnDelivery {
  readonly identity: RemoteOperationIdentity;
  readonly attemptId: string;
  readonly messageId: string;
  private receipt: DeliveryReceipt;
  private outcome: RemoteWorkResult;
  private dispatched = false;
  private owner?: { kind: string; runId: string; handle: string };
  get ownerHandle(): string | undefined { return this.owner?.handle; }
  async openOwner(kind: "parent" | "workflow" | "start", runId: string, threadId?: string): Promise<string> {
    if (this.owner) {
      if (this.owner.kind !== kind || this.owner.runId !== runId) throw new HostReadError("stale_target", "This engine lifetime changed.");
      return this.owner.handle;
    }
    await this.refreshGrant();
    const grant = await invoke<DeviceGrant | null>("remote_work_grant", { generation: this.options.generation, device: this.identity.device });
    this.options.validateGrant(grant); this.assertAllowed();
    if (!grant) throw new HostReadError("forbidden", "Remote work is no longer allowed.");
    const result = await invoke<{ ownerHandle: string }>("remote_work_owner_open", {
      stamp: { generation: this.options.generation, ...this.identity, grantRevision: grant.revision, workspaceId: this.receipt.workspaceId, threadId: threadId ?? this.receipt.threadId }, kind, runId,
    });
    this.assertAllowed();
    if (!result?.ownerHandle || result.ownerHandle.length > 256) throw new HostReadError("uncertain", "The native engine lifetime was not confirmed.");
    this.owner = { kind, runId, handle: result.ownerHandle };
    this.receipt.ownerHandle = result.ownerHandle;
    await this.save(this.receipt.disposition);
    return result.ownerHandle;
  }
  constructor(private readonly options: JournalOptions) {
    this.identity = options.identity;
    this.attemptId = options.attemptId ?? crypto.randomUUID();
    this.messageId = options.messageId ?? `remote-${crypto.randomUUID()}`;
    this.receipt = { ...options.identity, generation: options.generation, workspaceId: options.workspaceId,
      attemptId: this.attemptId, messageId: this.messageId, disposition: "preparing",
      ...(options.threadId ? { threadId: options.threadId } : {}), ...(options.queuedTurnId ? { queuedTurnId: options.queuedTurnId } : {}) };
    this.outcome = { opId: this.identity.opId, state: "rejected", attemptId: this.attemptId, messageId: this.messageId,
      ...(options.threadId ? { threadId: options.threadId } : {}) };
  }
  assertAllowed(): void {
    if (!this.options.isCurrent()) throw new HostReadError("host_unavailable", "The host renderer is recovering.");
    this.options.assertAllowed();
  }
  metadata(): ReturnType<RemoteTurnDelivery["metadata"]> {
    return { ...this.identity, generation: this.options.generation, attemptId: this.attemptId, messageId: this.messageId, ...(this.ownerHandle ? { ownerHandle: this.ownerHandle } : {}) };
  }
  private async refreshGrant(): Promise<void> {
    this.assertAllowed();
    const grant = await invoke<DeviceGrant | null>("remote_work_grant", { generation: this.options.generation, device: this.identity.device });
    this.assertAllowed();
    this.options.validateGrant(grant);
  }
  private async save(disposition: DeliveryReceipt["disposition"], extra: Partial<DeliveryReceipt> = {}): Promise<void> {
    this.receipt = { ...this.receipt, ...extra, disposition };
    await invoke("remote_work_receipt", { ...this.receipt });
  }
  private async mirror(disposition: RemoteQueuedDelivery["disposition"], code?: string): Promise<void> {
    if (!this.receipt.threadId || !this.receipt.queuedTurnId) return;
    useTaskStore.getState().setRemoteQueuedDisposition(this.receipt.threadId, this.receipt.queuedTurnId, disposition, code);
    await flushPendingStateWrites();
  }
  async beforeCreate(): Promise<void> { await this.refreshGrant(); await this.save("preparing"); this.assertAllowed(); }
  async bindThread(threadId: string): Promise<void> {
    this.assertAllowed();
    this.outcome.threadId = threadId;
    await this.save("preparing", { threadId });
    this.assertAllowed();
  }
  async queued(threadId: string, queuedTurnId: string): Promise<void> {
    this.receipt.threadId = threadId; this.receipt.queuedTurnId = queuedTurnId;
    await flushPendingStateWrites();
    await this.refreshGrant();
    await this.save("queued");
    await this.mirror("queued");
    this.outcome = { ...this.outcome, state: "queued", threadId, queuedTurnId };
  }
  async beforeDispatch(info: RemoteDispatchInfo): Promise<void> {
    await this.refreshGrant();
    this.assertAllowed();
    this.receipt = { ...this.receipt, ...info };
    // Durable mirror first. A crash after this point is held, even if the
    // renderer never learns whether Rust dispatched the provider request.
    await this.mirror("dispatched");
    await this.save("dispatched", info);
    this.assertAllowed();
    this.dispatched = true;
  }
  async accepted(info: Partial<RemoteDispatchInfo>): Promise<void> {
    this.outcome = { ...this.outcome, state: "accepted", ...(info.threadId ? { threadId: info.threadId } : {}), ...(info.turnId ? { turnId: info.turnId } : {}) };
    try { await this.save("accepted", info); await this.mirror("accepted"); }
    catch { await this.uncertain(info); }
  }
  async uncertain(info: Partial<RemoteDispatchInfo> = {}): Promise<void> {
    this.outcome = { ...this.outcome, state: "uncertain", ...(info.threadId ? { threadId: info.threadId } : {}), ...(info.turnId ? { turnId: info.turnId } : {}),
      error: { code: "uncertain", message: "Delivery could not be confirmed. Check the conversation before sending again." } };
    try { await this.save("uncertain", info); } catch { /* Rust retains its stronger native receipt. */ }
    try { await this.mirror("uncertain"); } catch { /* The pre-dispatch mirror remains held. */ }
  }
  async rejected(code = "internal"): Promise<void> {
    if (this.outcome.state === "accepted" || this.outcome.state === "uncertain") return;
    this.outcome = { ...this.outcome, state: "rejected", error: { code,
      message: code === "forbidden" ? "Remote access was removed before this instruction could run." : "The host did not deliver this instruction." } };
    try { await this.save("rejected", { errorCode: code }); await this.mirror("rejected", code); }
    catch { await this.uncertain(); }
  }
  async failure(reason: unknown): Promise<void> {
    if (this.outcome.state === "accepted" || this.outcome.state === "uncertain") return;
    const raw = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
    const definitive = /^MYTHRA_REMOTE_REJECTED:([a-z_]+)/.exec(raw)?.[1];
    const code = reason instanceof HostReadError ? reason.code : definitive ?? "internal";
    if (this.dispatched && !definitive) await this.uncertain();
    else await this.rejected(code);
  }
  async invokeSteer<T>(action: string, args: Record<string, unknown>): Promise<T> {
    return invoke<T>("remote_work_dispatch", { ...this.metadata(), action, args, targetHandle: this.options.targetHandle });
  }
  result(): RemoteWorkResult { return { ...this.outcome, ...(this.outcome.error ? { error: { ...this.outcome.error } } : {}) }; }
  queueRecord(): RemoteQueuedDelivery {
    return { ...this.identity, workspaceId: this.options.workspaceId, attemptId: this.attemptId,
      messageId: this.messageId, ...(this.ownerHandle ? { ownerHandle: this.ownerHandle } : {}), disposition: "uncertain", needsRecovery: false };
  }
}

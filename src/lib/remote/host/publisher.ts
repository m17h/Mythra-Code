import { drainTaskDeltas, pinTaskTranscript, useTaskStore } from "../../taskStore";
import type { DeviceGrant } from "../types";
import { REMOTE_GRACE_MS, type HostTimelineSubscribeResult, type ThreadSnapshot } from "../wire";
import { HostBridge } from "./bridge";
import { HostCatalog } from "./catalog";
import { diffProjection } from "./diff";
import { HostHistory } from "./history";
import { HostWindows } from "./window";
import { HostReadError, currentGrant, requireThread, type HostSources } from "./scope";

interface Publisher {
  epoch: string; seq: number; baseline: ThreadSnapshot | null; count: number;
  release: () => void; timer?: ReturnType<typeof setTimeout>;
  viewers: Map<string, DeviceGrant>;
}
const MAX_PUBLISHERS = 64;
const MAX_PINNED_BYTES = 64 * 1024 * 1024;
export class HostPublishers {
  private publishers = new Map<string, Publisher>();
  constructor(private readonly sources: HostSources, private readonly catalog: HostCatalog,
    private readonly history: HostHistory, private readonly windows: HostWindows, private readonly bridge: HostBridge) {}
  dispose(): void {
    for (const publisher of this.publishers.values()) { clearTimeout(publisher.timer); publisher.release(); }
    this.publishers.clear();
  }
  private get(threadId: string): Publisher {
    const existing = this.publishers.get(threadId);
    if (existing) { clearTimeout(existing.timer); existing.timer = undefined; return existing; }
    const tasks = useTaskStore.getState().tasks;
    const bytes = [...this.publishers.keys(), threadId].reduce((total, id) => total + (tasks[id]?.estimatedTranscriptBytes ?? 0), 0);
    if (this.publishers.size >= MAX_PUBLISHERS || bytes > MAX_PINNED_BYTES) throw new HostReadError("busy", "The other device has too much history open. Close another remote conversation first.");
    const publisher: Publisher = { epoch: crypto.randomUUID(), seq: 0, baseline: null, count: 0,
      release: pinTaskTranscript(threadId), viewers: new Map() };
    this.publishers.set(threadId, publisher);
    return publisher;
  }
  private capture(threadId: string, publisher: Publisher): ThreadSnapshot {
    try {
      for (const [device, expected] of publisher.viewers) {
        const grant = currentGrant(this.sources, device, expected);
        const thread = this.catalog.thread(threadId);
        if (!thread || !this.catalog.eligible(thread)) throw new HostReadError("thread_unavailable", "This conversation is no longer shared.");
        requireThread(this.sources, thread, grant, this.catalog.ownership());
      }
    } catch (reason) {
      // Scope changes are not visible to Rust's common per-thread ring. Drop
      // the generation instead of broadcasting to any formerly scoped viewer.
      this.bridge.invalidate();
      throw reason;
    }
    const task = useTaskStore.getState().tasks[threadId];
    if (!task) throw new HostReadError("thread_unavailable", "This conversation is no longer available.");
    const next = this.windows.snapshot(threadId, task, this.history.availability(threadId));
    if (publisher.baseline) {
      const frame = diffProjection(publisher.baseline, next);
      if (frame) {
        publisher.seq += 1;
        this.bridge.publish({ generation: this.bridge.generation, threadId, epoch: publisher.epoch, frames: [{ seq: publisher.seq, frame }] });
      }
    }
    publisher.baseline = next;
    return next;
  }
  /** No awaits: drain -> publish pending diff -> immutable snapshot at seq S. */
  subscribe(threadId: string, device: string, grant: DeviceGrant, request: { epoch?: string; needSnapshot?: boolean }): HostTimelineSubscribeResult {
    const publisher = this.get(threadId);
    publisher.viewers.set(device, grant);
    drainTaskDeltas();
    const snapshot = this.capture(threadId, publisher);
    // Rust has no renderer-issued epoch until the first publication. Establish
    // it even for a quiet thread so replay and snapshots share one boundary.
    if (publisher.seq === 0) {
      publisher.seq = 1;
      this.bridge.publish({ generation: this.bridge.generation, threadId, epoch: publisher.epoch, frames: [{ seq: 1, frame: {
        status: snapshot.status, availability: snapshot.availability, activeTurnId: snapshot.activeTurnId,
        assistantOutputActive: snapshot.assistantOutputActive, workingStartedAt: snapshot.workingStartedAt, error: snapshot.error,
        reset: { messages: snapshot.messages, activities: snapshot.activities }, approvals: snapshot.approvals,
        queuedTurns: snapshot.queuedTurns, history: snapshot.history,
      } }] });
    }
    return { epoch: publisher.epoch, seq: publisher.seq,
      ...(request.needSnapshot !== false || request.epoch !== publisher.epoch ? { snapshot } : {}) };
  }
  /** Called after the subscribe response; handles a requester lost before registration. */
  settle(threadId: string): void {
    const publisher = this.publishers.get(threadId);
    if (publisher && publisher.count === 0) this.subscribers(threadId, 0);
  }
  subscribers(threadId: string, count: number): void {
    const publisher = this.publishers.get(threadId);
    if (!publisher) return;
    publisher.count = Math.max(0, count);
    clearTimeout(publisher.timer);
    publisher.timer = undefined;
    if (publisher.count === 0) {
      // Grace cleanup only: this timer never drains, projects, or publishes.
      // Keep authorization evidence through grace/in-flight registration.
      // Dropping it on a delayed zero-count event could leave a later positive
      // event publishing without a scope check. Retirement clears it instead.
      publisher.timer = setTimeout(() => {
        if (this.publishers.get(threadId) !== publisher || publisher.count !== 0) return;
        this.publishers.delete(threadId);
        publisher.release();
        this.bridge.retired(threadId);
      }, REMOTE_GRACE_MS);
    }
  }
  tick(): void {
    drainTaskDeltas();
    for (const [threadId, publisher] of this.publishers) if (publisher.count > 0) this.capture(threadId, publisher);
  }
}

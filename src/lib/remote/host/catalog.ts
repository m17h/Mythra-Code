import type { Project, Thread } from "../../../types";
import { rpc } from "../../codex";
import { listLocalTranscriptThreads } from "../../localTranscriptPersistence";
import { canOwnNativeThread, nativeAgentLinkFromThread, type OwnershipLinks } from "../../nativeAgentLinks";
import { isLocalSubscriptionThread, providerFromThread } from "../../threadProvider";
import { reconcileWorkspaceThreads, sidebarThread, isSubAgentThread } from "../../threadList";
import { useTaskStore } from "../../taskStore";
import type { WireThread } from "../wire";
import { boundedText } from "./projection";
import { HostReadError, normalizedHostPath, threadEligible, type HostSources } from "./scope";

interface Listing { rows: Thread[]; at: number }
/** Separate request/cache ownership from App's selected sidebar and its counter. */
export class HostCatalog {
  private listings = new Map<string, Listing>();
  private pending = new Map<string, Promise<Thread[]>>();
  private discoveredLinks: OwnershipLinks = {};
  private serial = 0;
  private activeReads = 0;
  constructor(private readonly sources: HostSources) {}
  clear(): void { this.serial += 1; this.listings.clear(); this.pending.clear(); this.discoveredLinks = {}; }
  thread(id: string): Thread | undefined {
    const known = this.sources.getKnownThreads()[id];
    if (known) return known;
    const archived = this.sources.getArchivedThreads?.().find((thread) => thread.id === id);
    if (archived) return archived;
    for (const listing of this.listings.values()) {
      const thread = listing.rows.find((row) => row.id === id);
      if (thread) return thread;
    }
    return undefined;
  }
  eligible(thread: Thread): boolean {
    return threadEligible(this.sources, thread, this.ownership());
  }
  ownership(): OwnershipLinks { return { ...this.discoveredLinks, ...this.sources.getOwnershipLinks() }; }
  async list(workspace: Project): Promise<Thread[]> {
    const cached = this.listings.get(workspace.id);
    if (cached && Date.now() - cached.at < 5000) return cached.rows.filter((thread) => this.eligible(thread));
    const existing = this.pending.get(workspace.id);
    if (existing) return existing;
    if (this.activeReads >= 4) throw new HostReadError("busy", "The other device is reading other workspaces. Try again shortly.");
    this.activeReads += 1;
    const request = this.read(workspace);
    this.pending.set(workspace.id, request);
    try { return await request; }
    finally { this.activeReads -= 1; if (this.pending.get(workspace.id) === request) this.pending.delete(workspace.id); }
  }
  private async read(workspace: Project): Promise<Thread[]> {
    const nameRead = this.sources.watchThreadNames?.();
    try {
    const serial = this.serial;
    const check = () => { if (serial !== this.serial) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly."); };
    const namesAtStart = new Map(Object.values(this.sources.getKnownThreads()).map((thread) => [thread.id, thread.name]));
    const knownLocal = [...Object.values(this.sources.getKnownThreads()).filter(isLocalSubscriptionThread).map((thread) => thread.id), ...this.sources.getArchivedThreadIds()];
    const localPromise = listLocalTranscriptThreads([...new Set(knownLocal)]).catch(() => [] as Thread[]);
    const runtime = this.sources.getRuntime();
    const native: Thread[] = [];
    let complete = false;
    if (runtime.available) {
      try {
        let cursor: string | null = null;
        const seen = new Set<string>();
        for (let page = 0; page < 20; page += 1) {
          const result: { data: Thread[]; nextCursor?: string | null } = await rpc("thread/list", { cwd: workspace.path, limit: 100, cursor });
          check();
          for (const thread of result.data ?? []) if (thread && typeof thread.id === "string" && typeof thread.cwd === "string") native.push(sidebarThread(thread));
          cursor = result.nextCursor ?? null;
          if (!cursor) { complete = true; break; }
          if (seen.has(cursor)) break;
          seen.add(cursor);
        }
      } catch { /* A failed native sweep must not orphan local transcripts. */ }
    }
    const local = await localPromise;
    check();
    const currentWorkspace = this.sources.getWorkspaces().find((entry) => entry.id === workspace.id);
    if (!currentWorkspace || normalizedHostPath(currentWorkspace.path) !== normalizedHostPath(workspace.path)) {
      throw new HostReadError("thread_unavailable", "This workspace changed while it was being read.");
    }
    const graph = { ...this.discoveredLinks, ...this.sources.getOwnershipLinks() };
    for (const thread of native) {
      const link = nativeAgentLinkFromThread(thread);
      if (!link) { delete this.discoveredLinks[thread.id]; continue; }
      const known = this.sources.getKnownThreads()[thread.id];
      if (known && !isSubAgentThread(known, graph)) continue;
      if (!canOwnNativeThread(graph, link.rootThreadId, link.childThreadId)) continue;
      graph[thread.id] = link;
      this.discoveredLinks[thread.id] = link;
    }
    const entries = [...(this.sources.getArchivedThreads?.() ?? []), ...native, ...local].map((thread) => {
      const current = this.sources.getKnownThreads()[thread.id];
      return current && (nameRead?.changedIds.has(thread.id) || current.name !== namesAtStart.get(thread.id)) && (namesAtStart.has(thread.id) || current.name?.trim())
        ? { ...thread, name: current.name } : thread;
    }).filter((thread) => this.eligible(thread));
    const remembered = Object.fromEntries(Object.entries(this.sources.getKnownThreads()).filter(([, thread]) => this.eligible(thread)));
    const rows = reconcileWorkspaceThreads(entries, remembered, workspace.path, { ...this.sources.getBindings() }, {
      // Native's non-archived index cannot prove an archived record absent.
      runtimeHome: runtime.dataHome, runtimeIndexComplete: complete && !this.sources.getArchivedThreadIds().size,
    }).filter((thread) => this.eligible(thread));
    while (this.listings.size >= 16 && !this.listings.has(workspace.id)) this.listings.delete(this.listings.keys().next().value!);
    this.listings.set(workspace.id, { rows, at: Date.now() });
    return rows;
    } finally { nameRead?.finish(); }
  }
  row(thread: Thread, workspaceId: string): WireThread {
    return {
      id: thread.id, workspaceId, provider: providerFromThread(thread,
        this.sources.getWorkspaces().find((workspace) => workspace.id === workspaceId)?.overrides?.defaults?.provider ?? this.sources.getDefaultProvider?.() ?? "openai"),
      title: boundedText(thread.name || "Untitled thread", 256), preview: boundedText(thread.preview, 512),
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0,
      status: useTaskStore.getState().tasks[thread.id]?.status ?? "idle",
      archived: this.sources.getArchivedThreadIds().has(thread.id), child: isSubAgentThread(thread, this.ownership()),
      pinned: this.sources.getPinnedThreadIds?.().has(thread.id) === true,
      unread: useTaskStore.getState().tasks[thread.id]?.unread === true,
      waiting: (useTaskStore.getState().tasks[thread.id]?.approvals.length ?? 0) > 0,
    };
  }
}

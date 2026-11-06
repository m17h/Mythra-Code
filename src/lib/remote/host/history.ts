import type { Activity, ChatMessage, Thread } from "../../../types";
import { rpc } from "../../codex";
import { isClaudeTurnActive, loadClaudeTranscriptPage } from "../../claude";
import { cursorTurnState, loadCursorTranscriptPage } from "../../cursor";
import { restoreCursorTurnOwner } from "../../cursorTurnOwnership";
import { recoverCursorAssistantSegments } from "../../cursorEvents";
import { captureHistoryReadBoundary, drainTaskDeltas, pinTaskTranscript, useTaskStore } from "../../taskStore";
import { INITIAL_THREAD_TURN_LIMIT, OLDER_THREAD_TURN_LIMIT, isPaginatedHistoryUnsupported, normalizeThreadTurnsPage, turnsFromDescendingPage, type ThreadHistoryState } from "../../threadHistory";
import { timelineFromTurns } from "../../threadTimeline";
import { providerFromThread } from "../../threadProvider";
import type { WireAvailability } from "../wire";
import { HostReadError, normalizedHostPath, threadWorkspace, type HostSources } from "./scope";
import { sourceRows } from "./window";

interface HistoryTarget { thread: Thread; workspacePath: string; assertCurrent(): void }
export class HostHistory {
  private pendingRequestsRecovering = false;
  requestRecovery(complete: boolean): void { this.pendingRequestsRecovering = !complete; }
  private pending = new Map<string, Promise<void>>();
  private hydrated = new Map<string, { messages: ChatMessage[]; activities: Activity[] }>();
  private uncertain = new Set<string>();
  private serial = 0;
  private activeReads = 0;
  private pins = new Set<() => void>();
  constructor(private readonly sources: HostSources) {}
  clear(): void {
    this.serial += 1; this.hydrated.clear(); this.uncertain.clear(); this.pending.clear();
    for (const release of this.pins) release();
    this.pins.clear();
  }
  availability(threadId: string): WireAvailability {
    if (this.pendingRequestsRecovering) return "recovering";
    const task = useTaskStore.getState().tasks[threadId];
    if (task?.activeTurnId && (task.status === "running" || task.status === "starting")) return "ready";
    if (this.uncertain.has(threadId)) return "recovering";
    if (task && (task.status === "completed" || task.status === "interrupted" || task.status === "error")) return "ready";
    return this.uncertain.has(threadId) || !this.hydrated.has(threadId) ? "recovering" : "ready";
  }
  async ensure(target: HistoryTarget): Promise<void> {
    target.assertCurrent();
    const id = target.thread.id;
    const task = useTaskStore.getState().tasks[id];
    const loaded = this.hydrated.get(id);
    if (loaded && task && (task.messages.length || task.activities.length
      || loaded.messages === task.messages && loaded.activities === task.activities)) return;
    const pending = this.pending.get(id);
    if (pending) { await pending; target.assertCurrent(); return; }
    await this.run(target, false);
  }
  async earlier(target: HistoryTarget): Promise<void> {
    await this.ensure(target);
    const pending = this.pending.get(target.thread.id);
    if (pending) { await pending; target.assertCurrent(); return; }
    if (useTaskStore.getState().tasks[target.thread.id]?.history.hasMore) await this.run(target, true);
  }
  private async run(target: HistoryTarget, older: boolean): Promise<void> {
    if (this.activeReads >= 4) throw new HostReadError("busy", "The host is reading other conversations. Try again shortly.");
    this.activeReads += 1;
    const id = target.thread.id;
    const release = pinTaskTranscript(id);
    this.pins.add(release);
    const serial = this.serial;
    const check = () => { if (serial !== this.serial) throw new HostReadError("host_unavailable", "The host is recovering."); target.assertCurrent(); };
    const work = this.read(target, older, check);
    this.pending.set(id, work);
    try {
      await work; check();
      const task = useTaskStore.getState().tasks[id];
      if (task) this.hydrated.set(id, { messages: task.messages, activities: task.activities });
    }
    finally { this.activeReads -= 1; release(); this.pins.delete(release); if (this.pending.get(id) === work) this.pending.delete(id); }
  }
  private async read(target: HistoryTarget, older: boolean, check: () => void): Promise<void> {
    const id = target.thread.id;
    const executionPath = this.sources.executionPathFor(id, target.workspacePath);
    const provider = providerFromThread(target.thread,
      threadWorkspace(this.sources, target.thread)?.overrides?.defaults?.provider ?? this.sources.getDefaultProvider?.() ?? "openai");
    const original = useTaskStore.getState().tasks[id];
    // A remote recent-page read must not discard older pages the host user
    // already loaded. Keep all resident rows as anchors, while still allowing
    // authoritative same-ID payloads unless they changed during this read.
    const boundary = { ...captureHistoryReadBoundary(original), preserveAfterOrder: -Infinity,
      messageSnapshots: new Map((original?.messages ?? []).map((row) => [row.id, row])),
      activitySnapshots: new Map((original?.activities ?? []).map((row) => [row.id, row])) };
    const cursor = older ? original?.history.nextCursor ?? undefined : undefined;
    if (older && !cursor) return;
    const install = (messages: ChatMessage[], activities: Activity[], history: ThreadHistoryState, local: boolean) => {
      check();
      if (normalizedHostPath(this.sources.executionPathFor(id, target.workspacePath)) !== normalizedHostPath(executionPath)) throw new HostReadError("stale_target", "This conversation's checkout changed.");
      drainTaskDeltas();
      const store = useTaskStore.getState();
      const current = store.tasks[id];
      if (older) {
        if (current?.history.nextCursor !== cursor) return;
        store.prependHistory(id, messages, activities, history);
      } else {
        store.hydrateTask(id, messages, activities, executionPath, current?.history.paginated ? current.history : history, boundary,
          { ...(local ? { source: "local" as const } : {}), preserveUnread: true });
      }
    };
    if (provider === "claude" || provider === "cursor") {
      const read = (before?: string) => provider === "claude" ? loadClaudeTranscriptPage(id, before) : loadCursorTranscriptPage(id, before);
      let page;
      try { page = await read(cursor); }
      catch (reason) {
        // A save can advance generation while preserving old chunks. Find the
        // first unseen page, never rewind the resident history cursor blindly.
        if (!older || !/local transcript cursor is stale/i.test(String(reason))) throw reason;
        const seen = new Set([...(original?.messages ?? []), ...(original?.activities ?? [])].map((row) => row.id));
        let next: string | undefined;
        for (let index = 0; index < 100; index += 1) {
          check();
          const candidate = await read(next);
          check();
          if (!candidate) break;
          if ([...candidate.messages, ...candidate.activities].some((row) => !seen.has(row.id)) || !candidate.nextCursor) { page = candidate; break; }
          next = candidate.nextCursor;
        }
      }
      check();
      if (!page) {
        if (!original?.messages.length && !original?.activities.length) throw new HostReadError("thread_unavailable", "The saved conversation is not available.");
      } else {
        if (page.thread.id !== id || providerFromThread(page.thread, "openai") !== provider
          || normalizedHostPath(page.thread.cwd) !== normalizedHostPath(target.thread.cwd)) throw new HostReadError("stale_target", "The saved conversation changed.");
        install(page.messages, page.activities, { nextCursor: page.nextCursor, hasMore: Boolean(page.nextCursor), loading: false, paginated: true }, true);
        if (provider === "cursor" && "cursorSessionId" in page && typeof page.cursorSessionId === "string" && page.cursorSessionId) this.sources.onCursorSession(id, page.cursorSessionId);
      }
      if (!older && provider === "cursor") {
        const receipt = await cursorTurnState(id);
        check();
        if (receipt) {
          const owner = restoreCursorTurnOwner(id, receipt.turnId, receipt.startRequestId, receipt.phase);
          if (owner.restored && receipt.cursorSessionId) this.sources.onCursorSession(id, receipt.cursorSessionId);
          if (owner.restored && !owner.settled && !owner.stopped) {
            const store = useTaskStore.getState();
            store.setActiveTurn(id, receipt.turnId);
            store.setTaskStatus(id, receipt.phase === "starting" ? "starting" : "running");
            recoverCursorAssistantSegments(id, receipt.turnId);
          } else if (receipt.phase === "completed" && useTaskStore.getState().tasks[id]?.lastCompletedTurnId !== receipt.turnId) {
            const task = useTaskStore.getState().tasks[id];
            const sealed = [...(task?.messages ?? []), ...(task?.activities ?? [])].some((row) => row.turnId === receipt.turnId
              && !("role" in row && row.role === "user") && ["completed", "interrupted", "failed"].includes(row.turnStatus ?? ""));
            if (!sealed) this.uncertain.add(id);
          }
        }
      } else if (!older && provider === "claude") {
        const active = await isClaudeTurnActive(id);
        check();
        if (active && !useTaskStore.getState().tasks[id]?.activeTurnId) this.uncertain.add(id);
      }
      return;
    }
    if (!this.sources.getRuntime().available) throw new HostReadError("host_unavailable", "The host runtime is unavailable.");
    let history;
    try {
      const result = normalizeThreadTurnsPage(await rpc<unknown>("thread/turns/list", { threadId: id, ...(cursor ? { cursor } : {}), limit: older ? OLDER_THREAD_TURN_LIMIT : INITIAL_THREAD_TURN_LIMIT, sortDirection: "desc", itemsView: "summary" }));
      check();
      if (!result) throw new HostReadError("unsupported", "The host returned an unsupported history page.");
      const turns = turnsFromDescendingPage(result);
      history = timelineFromTurns(turns, { includeContextCompaction: provider === "openai" });
      install(history.messages, history.activities, { nextCursor: result.nextCursor, hasMore: Boolean(result.nextCursor), loading: false, paginated: true }, false);
      if (!older && turns.length && !["completed", "interrupted", "failed"].includes(turns.at(-1)?.status ?? "") && !useTaskStore.getState().tasks[id]?.activeTurnId) this.uncertain.add(id);
    } catch (reason) {
      check();
      if (!(reason instanceof HostReadError && reason.code === "unsupported") && !isPaginatedHistoryUnsupported(reason)) throw reason;
      const result = await rpc<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: true });
      check();
      if (result.thread.id !== id) throw new HostReadError("stale_target", "The conversation changed.");
      history = timelineFromTurns(result.thread.turns, { includeContextCompaction: provider === "openai" });
      // Full compatibility reads use hydration rather than appending an entire duplicate history.
      const store = useTaskStore.getState();
      drainTaskDeltas();
      store.hydrateTask(id, history.messages, history.activities, executionPath,
        { nextCursor: null, hasMore: false, loading: false, paginated: false }, boundary, { preserveUnread: true });
      if (result.thread.turns?.length && !["completed", "interrupted", "failed"].includes(result.thread.turns.at(-1)?.status ?? "") && !useTaskStore.getState().tasks[id]?.activeTurnId) this.uncertain.add(id);
    }
  }
  /** Fetch only enough native pages to serve the requested opaque row anchor. */
  async preparePage(target: HistoryTarget, anchor: { id: string; kind: string } | undefined, limit: number): Promise<void> {
    await this.ensure(target);
    if (!anchor) return;
    for (let page = 0; page < 24; page += 1) {
      target.assertCurrent();
      const task = useTaskStore.getState().tasks[target.thread.id];
      if (!task) throw new HostReadError("thread_unavailable", "This conversation is unavailable.");
      const index = sourceRows(task).findIndex((row) => row.entry.id === anchor.id && row.kind === anchor.kind);
      if (index < 0) throw new HostReadError("stale_target", "History changed. Refresh the conversation.");
      if (index >= limit || !task.history.hasMore) return;
      const cursor = task.history.nextCursor;
      await this.earlier(target);
      if (useTaskStore.getState().tasks[target.thread.id]?.history.nextCursor === cursor) return;
    }
  }
}

import { create } from "zustand";
import { listenViewer, viewerErrorCode, viewerRequest } from "./viewerBridge";
import type {
  ThreadSnapshot, ThreadFrame, TimelineSubscribeResult, ThreadReadResult,
  RemoteViewerFrame, RemoteViewerState, WireMessage, WireActivity, WireHistory,
  WireApproval, WireQueuedTurn, WireWorkspace, WireThread, WireProvider, WireTaskStatus,
} from "./wire";
import { REMOTE_MAX_ROWS, REMOTE_DEFAULT_ROWS } from "./wire";

export type ViewState = "loading" | "live" | "recovering" | "stale" | "removed";
export interface RemoteTimeline extends ThreadSnapshot {
  epoch: string | null; seq: number; baseline: boolean; replayable: boolean;
  state: ViewState; reading: boolean; historyLimited: boolean;
}
export interface RemoteThreadList { threads: WireThread[]; cursor?: string; loading: boolean }
export interface RemoteDeviceView {
  workspaces: WireWorkspace[];
  lists: Map<string, RemoteThreadList>;
  timelines: Map<string, RemoteTimeline>;
  workspaceId: string | null; threadId: string | null;
  state: ViewState; loading: boolean; error: string | null;
}
interface RemoteStore { devices: Record<string, RemoteDeviceView> }
/** No persistence middleware: even baselines and cursors belong only to this renderer lifetime. */
export const useRemoteStore = create<RemoteStore>(() => ({ devices: {} }));
const BACKOFF = [1, 2, 5, 10, 30];
const MAX_CACHED_THREADS = 8;
const MAX_CACHED_WORKSPACES = 16;
const MAX_HISTORY_ROWS = 1000;
const MAX_WINDOW_CHARS = 4 * 1024 * 1024;
const MAX_BUFFERED_FRAMES = 512;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const PROVIDERS = new Set(["openai", "openrouter", "lmstudio", "claude", "cursor"]);
const STATUSES = new Set(["idle", "starting", "running", "completed", "interrupted", "error"]);
const TURNS = new Set(["inProgress", "completed", "interrupted", "failed"]);
const kinds = new Set(["command", "file", "reasoning", "agent", "warning", "compaction"]);
const actions = new Set(["spawn", "sendInput", "resume", "wait", "close", "status"]);
const deviceValid = (id: string) => /^[0-9a-f]{64}$/.test(id);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote object");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 1024 * 1024): string => {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid remote text");
  return value;
};
const id = (value: unknown) => { const result = text(value, 512); if (!result) throw new Error("Missing identity"); return result; };
const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid sequence");
  return value;
};
const order = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("Invalid order");
  return value;
};
const measure = (value: unknown): number => {
  const parsed = order(value);
  if (parsed < 0) throw new Error("Invalid measurement");
  return parsed;
};
const bool = (value: unknown): boolean => { if (typeof value !== "boolean") throw new Error("Invalid flag"); return value; };
function rows<T>(value: unknown, parse: (entry: unknown) => T, max = REMOTE_MAX_ROWS): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid remote rows");
  return value.map(parse);
}
function unique<T extends { id: string }>(entries: T[]): T[] {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate identity");
  return entries;
}
function turn(value: unknown): WireMessage["turnStatus"] {
  if (value === null) return null;
  if (typeof value !== "string" || !TURNS.has(value)) throw new Error("Invalid turn");
  return value as WireMessage["turnStatus"];
}
function history(value: unknown): WireHistory {
  const v = object(value);
  return { hasMore: bool(v.hasMore), ...(v.cursor === undefined ? {} : { cursor: text(v.cursor, 4096) }) };
}
function message(value: unknown): WireMessage {
  const v = object(value);
  if (v.role !== "user" && v.role !== "assistant") throw new Error("Invalid message role");
  const result: WireMessage = {
    id: id(v.id), order: order(v.order), role: v.role, text: text(v.text),
    turnId: v.turnId === null ? null : id(v.turnId), streaming: bool(v.streaming), turnStatus: turn(v.turnStatus),
  };
  if (v.phase === "commentary" || v.phase === "final") result.phase = v.phase;
  if (v.turnDurationMs !== undefined) result.turnDurationMs = measure(v.turnDurationMs);
  if (v.provenance === "mythra-notice") result.provenance = v.provenance;
  if (["sending", "accepted", "queued", "read", "unconfirmed"].includes(String(v.steerStatus))) result.steerStatus = v.steerStatus as WireMessage["steerStatus"];
  if (v.attachmentNames !== undefined) result.attachmentNames = rows(v.attachmentNames, (entry) => text(entry, 512), 100);
  if (v.attachmentImages !== undefined) result.attachmentImages = rows(v.attachmentImages, (entry) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > 7) throw new Error("Invalid image reference");
    return entry;
  }, 8);
  if (v.questions !== undefined) result.questions = rows(v.questions, (entry) => {
    const q = object(entry);
    const secret = bool(q.secret);
    const answers = q.answers === undefined ? undefined : rows(q.answers, (answer) => text(answer, 16000), 100);
    return { id: id(q.id), title: text(q.title, 16000), secret, options: rows(q.options, (option) => text(option, 16000), 100),
      answered: bool(q.answered), ...(answers === undefined ? {} : { answers: secret ? ["Private answer submitted on the other device."] : answers }) };
  }, 100);
  if (v.truncated === true) result.truncated = true;
  return result;
}
function activity(value: unknown): WireActivity {
  const v = object(value);
  if (typeof v.kind !== "string" || !kinds.has(v.kind)) throw new Error("Invalid activity");
  const result: WireActivity = { id: id(v.id), order: order(v.order), kind: v.kind as WireActivity["kind"], title: text(v.title),
    status: v.status === null ? null : text(v.status, 256), turnId: v.turnId === null ? null : id(v.turnId), turnStatus: turn(v.turnStatus) };
  if (v.detail !== undefined) result.detail = text(v.detail);
  if (["research", "files", "commands"].includes(String(v.workType))) result.workType = v.workType as WireActivity["workType"];
  if (v.turnDurationMs !== undefined) result.turnDurationMs = measure(v.turnDurationMs);
  if (v.itemCount !== undefined) result.itemCount = measure(v.itemCount);
  if (v.agent !== undefined) {
    const a = object(v.agent);
    if (typeof a.action !== "string" || !actions.has(a.action)) throw new Error("Invalid agent action");
    result.agent = { action: a.action as NonNullable<WireActivity["agent"]>["action"] };
    if (typeof a.provider === "string" && PROVIDERS.has(a.provider)) result.agent.provider = a.provider as WireProvider;
    if (a.model !== undefined) result.agent.model = text(a.model, 512);
    if (a.count !== undefined) result.agent.count = measure(a.count);
  }
  if (v.truncated === true) result.truncated = true;
  return result;
}
function approval(value: unknown): WireApproval {
  const v = object(value);
  if (!["command", "file", "permissions", "question", "settings", "other"].includes(String(v.kind)) || v.hostOnly !== true) throw new Error("Invalid approval");
  return { id: id(v.id), kind: v.kind as WireApproval["kind"], summary: text(v.summary, 16000), hostOnly: true };
}
function queued(value: unknown): WireQueuedTurn {
  const v = object(value);
  if (!["queued", "sending", "failed"].includes(String(v.status))) throw new Error("Invalid queue");
  return { id: id(v.id), text: text(v.text), status: v.status as WireQueuedTurn["status"], createdAt: measure(v.createdAt),
    attachmentNames: rows(v.attachmentNames, (entry) => text(entry, 512), 100), ...(v.truncated === true ? { truncated: true } : {}) };
}
function stateFields(value: Record<string, unknown>): Pick<ThreadSnapshot, "status" | "availability" | "activeTurnId" | "workingStartedAt" | "error"> {
  if (typeof value.status !== "string" || !STATUSES.has(value.status) || !["ready", "recovering"].includes(String(value.availability))) throw new Error("Invalid thread state");
  return { status: value.status as WireTaskStatus, availability: value.availability as ThreadSnapshot["availability"],
    activeTurnId: value.activeTurnId === null ? null : id(value.activeTurnId),
    workingStartedAt: value.workingStartedAt === null ? null : measure(value.workingStartedAt), error: value.error === null ? null : text(value.error, 16000) };
}
function snapshot(value: unknown): ThreadSnapshot {
  const v = object(value);
  return { ...stateFields(v), messages: unique(rows(v.messages, message)), activities: unique(rows(v.activities, activity)),
    approvals: unique(rows(v.approvals, approval)), queuedTurns: unique(rows(v.queuedTurns, queued)), history: history(v.history) };
}
function frame(value: unknown): ThreadFrame {
  const v = object(value);
  const result: ThreadFrame = stateFields(v);
  if (v.reset !== undefined) { const r = object(v.reset); result.reset = { messages: unique(rows(r.messages, message)), activities: unique(rows(r.activities, activity)) }; }
  if (v.upsertMessages !== undefined) result.upsertMessages = unique(rows(v.upsertMessages, message));
  if (v.upsertActivities !== undefined) result.upsertActivities = unique(rows(v.upsertActivities, activity));
  if (v.removeMessageIds !== undefined) result.removeMessageIds = rows(v.removeMessageIds, id);
  if (v.removeActivityIds !== undefined) result.removeActivityIds = rows(v.removeActivityIds, id);
  if (v.appendMessageText !== undefined) result.appendMessageText = rows(v.appendMessageText, (entry) => { const a = object(entry); return { id: id(a.id), text: text(a.text) }; });
  if (v.approvals !== undefined) result.approvals = unique(rows(v.approvals, approval));
  if (v.queuedTurns !== undefined) result.queuedTurns = unique(rows(v.queuedTurns, queued));
  if (v.history !== undefined) result.history = history(v.history);
  return result;
}
function emptyDevice(): RemoteDeviceView {
  return { workspaces: [], lists: new Map(), timelines: new Map(), workspaceId: null, threadId: null, state: "loading", loading: false, error: null };
}
const emptyTimeline = (): RemoteTimeline => ({
  status: "idle", availability: "recovering", activeTurnId: null, workingStartedAt: null, error: null,
  messages: [], activities: [], approvals: [], queuedTurns: [], history: { hasMore: false },
  epoch: null, seq: 0, baseline: false, replayable: false, state: "loading", reading: false, historyLimited: false,
});
function changeDevice(device: string, change: (current: RemoteDeviceView) => RemoteDeviceView) {
  useRemoteStore.setState((state) => ({ devices: { ...state.devices, [device]: change(state.devices[device] ?? emptyDevice()) } }));
}
function cacheList(lists: Map<string, RemoteThreadList>, workspaceId: string, list: RemoteThreadList): Map<string, RemoteThreadList> {
  const next = new Map(lists);
  next.delete(workspaceId); next.set(workspaceId, list);
  while (next.size > MAX_CACHED_WORKSPACES) next.delete(next.keys().next().value!);
  return next;
}
function changeTimeline(device: string, threadId: string, change: (current: RemoteTimeline) => RemoteTimeline) {
  changeDevice(device, (current) => {
    const timelines = new Map(current.timelines);
    timelines.set(threadId, change(timelines.get(threadId) ?? emptyTimeline()));
    while (timelines.size > MAX_CACHED_THREADS) {
      const victim = [...timelines.keys()].find((key) => key !== current.threadId && key !== threadId);
      if (!victim) break;
      timelines.delete(victim);
    }
    return { ...current, timelines };
  });
}
function mergeRows<T extends { id: string; order: number }>(current: T[], upserts: T[] = [], removals: string[] = []): T[] {
  if (!upserts.length && !removals.length) return current;
  const next = new Map(current.map((entry) => [entry.id, entry]));
  for (const key of removals) next.delete(key);
  for (const entry of upserts) next.set(entry.id, entry);
  return [...next.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
function bounded(window: Pick<ThreadSnapshot, "messages" | "activities">) {
  if (window.messages.length + window.activities.length > MAX_HISTORY_ROWS
    || window.messages.reduce((sum, row) => sum + row.text.length, 0) + window.activities.reduce((sum, row) => sum + row.title.length + (row.detail?.length ?? 0), 0) > MAX_WINDOW_CHARS) throw new Error("Window limit");
}
function applyFrame(current: RemoteTimeline, patch: ThreadFrame, seq: number): RemoteTimeline {
  let messages = patch.reset ? patch.reset.messages : current.messages;
  let activities = patch.reset ? patch.reset.activities : current.activities;
  messages = mergeRows(messages, patch.upsertMessages, patch.removeMessageIds);
  activities = mergeRows(activities, patch.upsertActivities, patch.removeActivityIds);
  if (patch.appendMessageText?.length) {
    const additions = new Map<string, string>();
    for (const append of patch.appendMessageText) additions.set(append.id, (additions.get(append.id) ?? "") + append.text);
    messages = messages.map((row) => { const addition = additions.get(row.id); if (addition === undefined) return row; additions.delete(row.id); return { ...row, text: row.text + addition }; });
    if (additions.size) throw new Error("Append without baseline");
  }
  const next: RemoteTimeline = {
    ...current, ...stateFields(patch as unknown as Record<string, unknown>), messages, activities, seq,
    approvals: patch.approvals ?? current.approvals, queuedTurns: patch.queuedTurns ?? current.queuedTurns,
    history: patch.history ?? current.history, historyLimited: patch.reset ? false : current.historyLimited,
    state: patch.availability === "recovering" ? "recovering" : "live",
  };
  bounded(next);
  return next;
}

// Serialize subscription mutations per device. A late unsubscribe from a closed
// shell must complete before its replacement can establish a new subscription.
const commandTails = new Map<string, Promise<unknown>>();
/** One subscribe or unsubscribe at a time per thread. Leaving one thread never holds up the next. */
function serial<T>(thread: string, work: () => Promise<T>): Promise<T> {
  const previous = commandTails.get(thread) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  commandTails.set(thread, result);
  const clean = () => { if (commandTails.get(thread) === result) commandTails.delete(thread); };
  void result.then(clean, clean);
  return result;
}
let bridge: Promise<() => void> | null = null;
let bridgeGeneration = 0;
function ensureBridge() {
  if (!bridge) {
    const generation = ++bridgeGeneration;
    bridge = listenViewer(
      (event) => { if (generation === bridgeGeneration && event && typeof event.device === "string") controllers.get(event.device)?.onFrame(event); },
      (event) => { if (generation === bridgeGeneration && event && typeof event.device === "string") controllers.get(event.device)?.onState(event); },
    ).catch((error) => { if (generation === bridgeGeneration) bridge = null; throw error; });
  }
  return bridge;
}
function releaseBridge() {
  if (controllers.size) return;
  const installed = bridge;
  bridge = null; bridgeGeneration++;
  void installed?.then((stop) => stop(), () => {});
}
const controllers = new Map<string, ViewerSession>();
class ViewerSession {
  refs = 0;
  alive = true;
  token = 0;
  catalogToken = 0;
  listToken = 0;
  retry = 0;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending = false;
  subscribed = false;
  replayTarget: { token: number; epoch: string; seq: number } | null = null;
  replayTimer: ReturnType<typeof setTimeout> | undefined;
  buffered: RemoteViewerFrame[] = [];
  bufferedBytes = 0;
  desiredThread: string | null = null;
  constructor(readonly device: string) {}
  get view() { return useRemoteStore.getState().devices[this.device]; }
  active(token: number) { return this.alive && this.token === token; }
  clearReplay() {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = undefined; this.replayTarget = null;
  }
  finishReplay() {
    const target = this.replayTarget;
    if (!target || !this.active(target.token) || !this.desiredThread) return;
    const current = this.view?.timelines.get(this.desiredThread);
    if (!current?.baseline || !current.replayable || current.epoch !== target.epoch || current.seq < target.seq) return;
    this.clearReplay(); this.retry = 0;
    changeTimeline(this.device, this.desiredThread, (window) => ({ ...window, state: window.availability === "recovering" ? "recovering" : "live" }));
    changeDevice(this.device, (view) => ({ ...view, state: "live", error: null }));
  }
  fail(reason: unknown) {
    const removed = ["not_paired", "forbidden", "thread_unavailable"].includes(viewerErrorCode(reason));
    this.token++; this.subscribed = false; this.pending = false; this.clearReplay();
    this.buffered = []; this.bufferedBytes = 0;
    if (removed) {
      this.catalogToken++; this.listToken++;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
    changeDevice(this.device, (current) => ({ ...current, state: removed ? "removed" : "stale", loading: false,
      error: removed ? "Your access changed. On the other device, open Settings → Connections → Devices and check this device's access." : "The other device couldn't be reached. Work already started there may still be running." }));
    if (this.desiredThread) changeTimeline(this.device, this.desiredThread, (current) => removed
      ? { ...emptyTimeline(), state: "removed" } : { ...current, state: "stale", reading: false });
    if (!removed) this.schedule();
  }
  schedule() {
    if (!this.alive || this.timer) return;
    const delay = BACKOFF[Math.min(this.retry++, BACKOFF.length - 1)] * 1000;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.alive) void this.refresh(); }, delay);
  }
  async refresh() {
    if (!this.alive) return;
    const generation = ++this.catalogToken;
    changeDevice(this.device, (current) => ({ ...current, loading: true }));
    try {
      await ensureBridge();
      const raw = object(await viewerRequest<unknown>(this.device, "workspaces.list"));
      const workspaces = unique(rows(raw.workspaces, (entry): WireWorkspace => {
        const v = object(entry); return { id: id(v.id), name: text(v.name, 512), isChat: bool(v.isChat), ...(v.pinned === true ? { pinned: true } : {}) };
      }, 1000));
      if (!this.alive || generation !== this.catalogToken) return;
      const oldWorkspace = this.view?.workspaceId;
      const workspaceId = workspaces.some((workspace) => workspace.id === oldWorkspace) ? oldWorkspace! : workspaces[0]?.id ?? null;
      changeDevice(this.device, (current) => ({ ...current, workspaces, workspaceId, loading: false, state: "live", error: null }));
      if (workspaceId) await this.loadThreads(workspaceId, false);
      else this.selectThread(null);
    } catch (error) { if (this.alive && generation === this.catalogToken) this.fail(error); }
  }
  async loadThreads(workspaceId: string, more: boolean) {
    if (!this.alive || this.view?.workspaceId !== workspaceId) return;
    const generation = ++this.listToken;
    const existing = this.view?.lists.get(workspaceId);
    if (more && (!existing?.cursor || existing.loading)) return;
    const cursor = more ? existing?.cursor : undefined;
    changeDevice(this.device, (current) => ({ ...current, lists: cacheList(current.lists, workspaceId, { threads: existing?.threads ?? [], cursor: existing?.cursor, loading: true }) }));
    try {
      const raw = object(await viewerRequest<unknown>(this.device, "threads.list", { workspaceId, ...(cursor ? { cursor } : {}), limit: REMOTE_DEFAULT_ROWS }));
      const threads = unique(rows(raw.threads, (entry): WireThread => {
        const v = object(entry);
        if (v.workspaceId !== workspaceId || typeof v.provider !== "string" || !PROVIDERS.has(v.provider) || typeof v.status !== "string" || !STATUSES.has(v.status)) throw new Error("Invalid thread");
        return { id: id(v.id), workspaceId, provider: v.provider as WireProvider, title: text(v.title, 512), preview: text(v.preview, 16000), updatedAt: measure(v.updatedAt), status: v.status as WireTaskStatus,
          ...(v.archived === true ? { archived: true } : {}), ...(v.child === true ? { child: true } : {}), ...(v.pinned === true ? { pinned: true } : {}),
          ...(v.unread === true ? { unread: true } : {}), ...(v.parentThreadId === undefined ? {} : { parentThreadId: id(v.parentThreadId) }) };
      }));
      if (!this.alive || generation !== this.listToken || this.view?.workspaceId !== workspaceId) return;
      const next = more ? [...new Map([...(existing?.threads ?? []), ...threads].map((thread) => [thread.id, thread])).values()] : threads;
      const nextCursor = raw.cursor === undefined || raw.cursor === null ? undefined : text(raw.cursor, 4096);
      const selected = this.view?.threadId;
      // A selected item may sit on a later page. Preserve its known identity on refresh.
      const selectedThread = existing?.threads.find((thread) => thread.id === selected);
      if (!more && selectedThread && !next.some((thread) => thread.id === selected)) next.push(selectedThread);
      changeDevice(this.device, (current) => ({ ...current, lists: cacheList(current.lists, workspaceId, { threads: next.slice(0, 1000), cursor: next.length >= 1000 ? undefined : nextCursor, loading: false }) }));
      const threadId = next.some((thread) => thread.id === selected) ? selected! : next[0]?.id ?? null;
      if (threadId !== this.desiredThread || !more) this.selectThread(threadId);
    } catch (error) { if (this.alive && generation === this.listToken) {
      changeDevice(this.device, (current) => ({ ...current, lists: cacheList(current.lists, workspaceId, { threads: existing?.threads ?? [], cursor: existing?.cursor, loading: false }) }));
      this.fail(error);
    } }
  }
  selectWorkspace(workspaceId: string) {
    if (!this.view?.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    this.listToken++;
    this.selectThread(null);
    changeDevice(this.device, (current) => ({ ...current, workspaceId, threadId: null }));
    void this.loadThreads(workspaceId, false);
  }
  selectThread(threadId: string | null) {
    const previous = this.desiredThread;
    const token = ++this.token;
    this.clearReplay();
    this.pending = false; this.subscribed = false; this.buffered = []; this.bufferedBytes = 0;
    this.desiredThread = threadId;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (previous && previous !== threadId) void serial(`${this.device}/${previous}`, () => viewerRequest(this.device, "timeline.unsubscribe", { threadId: previous })).catch(() => {});
    changeDevice(this.device, (current) => ({ ...current, threadId }));
    if (threadId) void this.subscribe(threadId, token);
  }
  async subscribe(threadId: string, token: number) {
    this.pending = true;
    changeTimeline(this.device, threadId, (current) => ({ ...current, state: current.baseline ? "stale" : "loading" }));
    try {
      await ensureBridge();
      await serial(`${this.device}/${threadId}`, async () => {
        if (!this.active(token)) return;
        const baseline = this.view?.timelines.get(threadId);
        const args = { threadId, ...(baseline?.baseline && baseline.replayable && baseline.epoch ? { epoch: baseline.epoch, afterSeq: baseline.seq } : {}) };
        const raw = object(await viewerRequest<TimelineSubscribeResult>(this.device, "timeline.subscribe", args));
        if (!this.active(token)) return;
        const epoch = id(raw.epoch); const targetSeq = number(raw.seq);
        // Epoch UUIDs have no ordering. Do not guess that a mismatching event
        // is older than this reply; the host may have restarted during subscribe.
        if (this.buffered.some((event) => event.epoch !== epoch)) throw new Error("Epoch changed during subscribe");
        if (raw.snapshot !== undefined) {
          const data = snapshot(raw.snapshot); bounded(data);
          changeTimeline(this.device, threadId, () => ({ ...data, epoch, seq: targetSeq, baseline: true, replayable: true, reading: false, historyLimited: false,
            state: data.availability === "recovering" ? "recovering" : "live" }));
        } else if (!baseline?.baseline || !baseline.replayable || baseline.epoch !== epoch || baseline.seq > targetSeq) throw new Error("Replay has no baseline");
        // Rust may include replay frames in the reply; live events can also beat
        // the invoke response. Both enter the same deduplicating sequence path.
        if (raw.frames !== undefined) {
          const replay = rows(raw.frames, (entry) => {
            const v = object(entry);
            return { device: this.device, threadId, epoch, seq: number(v.seq), frame: frame(v.frame) };
          }, MAX_BUFFERED_FRAMES);
          if (this.buffered.length + replay.length > MAX_BUFFERED_FRAMES) throw new Error("Replay buffer full");
          const bytes = new TextEncoder().encode(JSON.stringify(replay)).byteLength;
          if (this.bufferedBytes + bytes > MAX_BUFFERED_BYTES) throw new Error("Replay buffer full");
          this.buffered.push(...replay);
        }
        const buffered = this.buffered.sort((a, b) => a.seq - b.seq);
        this.buffered = []; this.bufferedBytes = 0; this.pending = false; this.subscribed = true;
        this.replayTarget = { token, epoch, seq: targetSeq };
        for (const event of buffered) this.consume(event);
        this.finishReplay();
        if (this.replayTarget) {
          // Replay can arrive as events after the invoke result. Keep stale
          // text visible until the promised boundary is reached, never skip
          // directly from the old seq to the response's seq.
          const waiting = this.replayTarget;
          this.replayTimer = setTimeout(() => {
            if (!this.active(token) || this.replayTarget !== waiting) return;
            changeTimeline(this.device, threadId, (current) => ({ ...current, replayable: false }));
            this.fail(new Error("Replay did not reach its boundary"));
          }, 10_000);
        }
      });
    } catch (error) {
      if (!this.active(token)) return;
      this.pending = false; this.subscribed = false; this.buffered = []; this.bufferedBytes = 0;
      // Transport refusals leave the old cursor usable. A malformed reply or
      // discontinuity needs a fresh snapshot, but stale text stays visible.
      if (error instanceof Error && !("code" in error)) {
        changeTimeline(this.device, threadId, (current) => ({ ...current, replayable: false }));
      }
      this.fail(error);
    }
  }
  consume(event: RemoteViewerFrame) {
    const current = this.view?.timelines.get(event.threadId);
    if (!current?.baseline || !current.replayable || current.epoch !== event.epoch) throw new Error("Epoch changed");
    if (event.seq <= current.seq) return;
    if (event.seq !== current.seq + 1) throw new Error("Sequence gap");
    const patch = frame(event.frame);
    changeTimeline(this.device, event.threadId, (window) => {
      const next = applyFrame(window, patch, event.seq);
      return this.replayTarget ? { ...next, state: next.availability === "recovering" ? "recovering" : "stale" } : next;
    });
    this.finishReplay();
  }
  onFrame(event: RemoteViewerFrame) {
    if (!this.alive || event.threadId !== this.desiredThread || !this.pending && !this.subscribed) return;
    try {
      id(event.epoch); number(event.seq);
      if (this.pending) {
        const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (this.buffered.length >= MAX_BUFFERED_FRAMES || this.bufferedBytes + size > MAX_BUFFERED_BYTES) throw new Error("Replay buffer full");
        this.buffered.push(event); this.bufferedBytes += size;
      } else this.consume(event);
    } catch (error) {
      this.token++; this.pending = false; this.subscribed = false; this.buffered = []; this.bufferedBytes = 0;
      if (this.desiredThread) changeTimeline(this.device, this.desiredThread, (current) => ({ ...current, replayable: false, state: "stale" }));
      this.fail(error);
    }
  }
  onState(event: RemoteViewerState) {
    if (!this.alive || event.threadId !== this.desiredThread || !["live", "recovering", "stale", "removed"].includes(event.state)) return;
    if (event.state === "live") {
      // A transport state notification is not a transcript baseline. In
      // particular, it cannot release a stale/recovering view before replay.
      if (!this.pending && !this.subscribed) this.schedule();
      return;
    }
    this.token++; this.pending = false; this.subscribed = false; this.clearReplay();
    this.buffered = []; this.bufferedBytes = 0;
    changeTimeline(this.device, event.threadId, (current) => event.state === "removed"
      ? { ...emptyTimeline(), state: "removed" } : { ...current, state: event.state, reading: false });
    changeDevice(this.device, (current) => ({ ...current, state: event.state }));
    if (event.state === "removed") {
      this.catalogToken++; this.listToken++;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    } else this.schedule();
  }
  async loadEarlier() {
    const threadId = this.desiredThread;
    const current = threadId ? this.view?.timelines.get(threadId) : undefined;
    if (!threadId || !current?.baseline || current.state !== "live" || current.reading || !current.history.hasMore || current.historyLimited) return;
    const token = this.token; const epoch = current.epoch; const before = current.history.cursor;
    if (!before) return;
    const remaining = MAX_HISTORY_ROWS - current.messages.length - current.activities.length;
    if (remaining < 1) { changeTimeline(this.device, threadId, (window) => ({ ...window, historyLimited: true })); return; }
    changeTimeline(this.device, threadId, (window) => ({ ...window, reading: true }));
    try {
      const raw = object(await viewerRequest<ThreadReadResult>(this.device, "timeline.read", { threadId, before, limit: Math.min(REMOTE_DEFAULT_ROWS, remaining) }));
      const page = { messages: unique(rows(raw.messages, message)), activities: unique(rows(raw.activities, activity)), history: history(raw.history) };
      if (!this.active(token)) return;
      changeTimeline(this.device, threadId, (window) => {
        if (window.epoch !== epoch || window.history.cursor !== before) return { ...window, reading: false };
        // Live rows win if a page overlaps the current window.
        const next = { ...window, messages: mergeRows(page.messages, window.messages), activities: mergeRows(page.activities, window.activities), history: page.history, reading: false };
        bounded(next); return next;
      });
    } catch (error) { if (this.active(token)) { changeTimeline(this.device, threadId, (window) => ({ ...window, reading: false, historyLimited: true }));
      changeDevice(this.device, (view) => ({ ...view, error: "Earlier history could not be loaded. Refresh this view to try again." })); } }
  }
  close() {
    this.alive = false; this.token++; this.catalogToken++; this.listToken++; this.clearReplay();
    this.pending = false; this.subscribed = false; this.buffered = []; this.bufferedBytes = 0;
    if (this.timer) clearTimeout(this.timer);
    const threadId = this.desiredThread;
    if (threadId) {
      changeTimeline(this.device, threadId, (current) => ({ ...current, state: "stale", reading: false }));
      void serial(`${this.device}/${threadId}`, () => viewerRequest(this.device, "timeline.unsubscribe", { threadId })).catch(() => {});
    }
  }
}

/** Ref-counted for StrictMode and any shell/header consumers sharing a device. */
export function mountRemoteDevice(device: string): () => void {
  if (!deviceValid(device)) return () => {};
  let controller = controllers.get(device);
  if (!controller) { controller = new ViewerSession(device); controllers.set(device, controller); void controller.refresh(); }
  controller.refs++;
  const mounted = controller;
  return () => { if (--mounted.refs === 0 && controllers.get(device) === mounted) { mounted.close(); controllers.delete(device); releaseBridge(); } };
}
/** Paired online devices stay ready in memory, so switching shows them at once.
 * A copy lasts until the app exits or the device stops being available. */
const keptDevices = new Map<string, () => void>();
export function keepRemoteSessions(paired: readonly string[], online: readonly string[]): void {
  for (const [device, release] of keptDevices) if (!online.includes(device)) { release(); keptDevices.delete(device); }
  for (const device of online) if (!keptDevices.has(device)) keptDevices.set(device, mountRemoteDevice(device));
  const removed = Object.keys(useRemoteStore.getState().devices).filter((device) => !paired.includes(device) && !controllers.has(device));
  if (removed.length) useRemoteStore.setState((state) => {
    const devices = { ...state.devices };
    for (const device of removed) delete devices[device];
    return { devices };
  });
}
export const selectRemoteWorkspace = (device: string, workspaceId: string) => controllers.get(device)?.selectWorkspace(workspaceId);
export function selectRemoteThread(device: string, threadId: string) {
  const controller = controllers.get(device);
  if (controller?.view?.lists.get(controller.view.workspaceId ?? "")?.threads.some((thread) => thread.id === threadId)) controller.selectThread(threadId);
}
/** Opens a thread the host has only just created, which no list shows yet. */
/** `wanted` is asked again after the list loads, because people move on in the meantime. */
export async function openRemoteThread(device: string, workspaceId: string, threadId: string, wanted: () => boolean = () => true): Promise<void> {
  const controller = controllers.get(device);
  if (!controller) return;
  if (controller.view?.workspaceId === workspaceId) await controller.loadThreads(workspaceId, false);
  if (wanted() && controller.view?.lists.get(workspaceId)?.threads.some((thread) => thread.id === threadId)) controller.selectThread(threadId);
}
export const loadRemoteThreads = (device: string) => { const controller = controllers.get(device); if (controller?.view?.workspaceId) void controller.loadThreads(controller.view.workspaceId, true); };
export const loadRemoteEarlier = (device: string) => { void controllers.get(device)?.loadEarlier(); };
export const refreshRemoteDevice = (device: string) => { const controller = controllers.get(device); if (controller) { controller.retry = 0; void controller.refresh(); } };

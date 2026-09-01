import { invoke } from "@tauri-apps/api/core";
import type { Activity, ChatMessage, Thread } from "../types";
import { estimateTranscriptBytes } from "./taskStore";
import { beginPersistencePerformanceWrite, type PersistenceWriteKind } from "./runtimePerformanceBridge";

export type LocalTranscriptProvider = "claude" | "cursor";

export interface LocalTranscriptValue {
  thread: Thread;
  cursorSessionId?: string;
  messages: ChatMessage[];
  activities: Activity[];
}

interface LocalTranscriptWriteState {
  generation: number;
  headSeq: number;
  tailSeq: number;
}

interface LocalTranscriptSnapshotWrite extends LocalTranscriptWriteState {
  rewrittenChunks: number;
  totalChunks: number;
  compatibilitySnapshotCreated: boolean;
}

interface PersistenceState extends LocalTranscriptWriteState {
  partial: boolean;
  mutableTurnId: string | null;
  /** A generation conflict makes incremental replacement ambiguous for the
   * rest of this turn. Full snapshots remain safe only when the complete
   * transcript is resident and are still uncommon. */
  snapshotOnlyTurnId: string | null;
}

interface TailSelection {
  value: LocalTranscriptValue;
  turnId: string;
  seal: boolean;
}

export interface LocalTranscriptPage extends LocalTranscriptValue {
  nextCursor: string | null;
  headSeq: number;
  tailSeq: number;
  generation: number;
  byteLen: number;
}

/** Discover durable local-provider conversations without reading messages. */
export async function listLocalTranscriptThreads(knownThreadIds: string[] = []): Promise<Thread[]> {
  const value = await invoke<unknown>("local_transcript_list", { knownThreadIds });
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is Thread => {
    if (!candidate || typeof candidate !== "object") return false;
    const thread = candidate as Partial<Thread>;
    return typeof thread.id === "string"
      && Boolean(thread.id.trim())
      && typeof thread.cwd === "string"
      && typeof thread.updatedAt === "number"
      && (thread.modelProvider === "claude" || thread.modelProvider === "cursor");
  });
}

const LOCAL_TRANSCRIPT_INITIAL_BYTES = 40 * 1024;

const persistenceStates = new Map<string, PersistenceState>();
const saveQueues = new Map<string, Promise<void>>();
const deletingTranscripts = new Set<string>();
const MAX_PERSISTENCE_STATES = 128;

function persistenceKey(provider: LocalTranscriptProvider, threadId: string): string {
  return `${provider}\0${threadId}`;
}

function terminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function rememberPersistenceState(key: string, state: PersistenceState): void {
  persistenceStates.delete(key);
  persistenceStates.set(key, state);
  if (persistenceStates.size <= MAX_PERSISTENCE_STATES) return;
  for (const candidate of persistenceStates.keys()) {
    if (candidate === key || saveQueues.has(candidate) || deletingTranscripts.has(candidate)) continue;
    // Losing this marker could turn the next save of a bounded renderer
    // window into a destructive first-save snapshot. Partial records are only
    // a few numbers and must live until deletion or a proven full hydration.
    if (persistenceStates.get(candidate)?.partial) continue;
    persistenceStates.delete(candidate);
    break;
  }
}

function trailingEntries<T extends ChatMessage | Activity>(entries: T[], turnId: string | null): T[] {
  let start = entries.length;
  while (start > 0) {
    const candidateTurnId = entries[start - 1].turnId?.trim() || null;
    if (candidateTurnId !== turnId) break;
    start -= 1;
  }
  return entries.slice(start);
}

function selectMutableTail(transcript: LocalTranscriptValue): TailSelection | null {
  const latestMessage = transcript.messages.at(-1);
  const latestActivity = transcript.activities.at(-1);
  const messageOrder = latestMessage?.timelineOrder ?? Number.MAX_SAFE_INTEGER;
  const activityOrder = latestActivity?.timelineOrder ?? Number.MAX_SAFE_INTEGER;
  const latest = latestActivity && (!latestMessage || activityOrder >= messageOrder)
    ? latestActivity
    : latestMessage;
  if (!latest) return null;

  const latestTurnId = latest.turnId?.trim() || null;
  const messages = trailingEntries(transcript.messages, latestTurnId);
  const activities = trailingEntries(transcript.activities, latestTurnId);
  const selected = [...messages, ...activities];
  if (!selected.length) return null;
  const seal = Boolean(latestTurnId) && selected.every((entry) => terminalTurnStatus(entry.turnStatus));
  return {
    value: {
      thread: transcript.thread,
      ...(transcript.cursorSessionId !== undefined ? { cursorSessionId: transcript.cursorSessionId } : {}),
      messages,
      activities,
    },
    turnId: latestTurnId ?? "__pending__",
    seal,
  };
}

function storedMutableTurnId(
  transcript: LocalTranscriptValue,
  state: LocalTranscriptWriteState,
): string | null {
  if (state.tailSeq > state.headSeq) return null;
  return selectMutableTail(transcript)?.turnId ?? "__pending__";
}

async function readWriteState(
  provider: LocalTranscriptProvider,
  threadId: string,
): Promise<LocalTranscriptWriteState | null> {
  return invoke<LocalTranscriptWriteState | null>("local_transcript_write_state_read", {
    provider,
    threadId,
  });
}

async function saveSnapshot(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
): Promise<PersistenceState> {
  return measuredPersistenceWrite(provider, transcript, "snapshot", transcript, selectMutableTail(transcript)?.turnId, async () => {
    // The native snapshot response already contains the committed generation.
    // Reusing it avoids a second bridge hop and database read.
    const { generation, headSeq, tailSeq } = await invoke<LocalTranscriptSnapshotWrite>("local_transcript_snapshot_write", { provider, value: transcript });
    return { generation, headSeq, tailSeq, partial: false, mutableTurnId: null, snapshotOnlyTurnId: null };
  });
}

async function saveMetadata(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
  state: PersistenceState,
): Promise<PersistenceState> {
  return measuredPersistenceWrite(provider, transcript, "metadata", null, undefined, async () => {
    const next = await invoke<LocalTranscriptWriteState>("local_transcript_metadata_write", {
      provider,
      threadId: transcript.thread.id,
      thread: transcript.thread,
      cursorSessionId: transcript.cursorSessionId ?? null,
      expectedGeneration: state.generation,
    });
    return { ...state, ...next };
  });
}

async function measuredPersistenceWrite<T>(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
  kind: PersistenceWriteKind,
  payload: LocalTranscriptValue | null,
  performanceTurnId: string | undefined,
  write: () => Promise<T>,
): Promise<T> {
  // This uses the store's constant-time string-length estimator rather than
  // serializing a second copy of the payload on the renderer hot path.
  const estimatedBytes = payload ? estimateTranscriptBytes(payload.messages, payload.activities) : 0;
  const finish = beginPersistencePerformanceWrite(transcript.thread.id, provider, kind, estimatedBytes, performance.now(), performanceTurnId);
  try {
    const result = await write();
    finish(true);
    return result;
  } catch (error) {
    finish(false);
    throw error;
  }
}

async function saveTail(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
  state: PersistenceState,
  tail: TailSelection,
): Promise<PersistenceState> {
  return measuredPersistenceWrite(provider, transcript, "tail", tail.value, tail.turnId, async () => {
    const next = await invoke<LocalTranscriptWriteState>("local_transcript_tail_write", {
      provider,
      value: tail.value,
      expectedGeneration: state.generation,
      seal: tail.seal,
    });
    return {
      ...next,
      partial: state.partial,
      mutableTurnId: tail.seal ? null : tail.turnId,
      snapshotOnlyTurnId: null,
    };
  });
}

async function persistTranscript(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
): Promise<void> {
  const key = persistenceKey(provider, transcript.thread.id);
  let state = persistenceStates.get(key);
  if (!state) {
    state = await saveSnapshot(provider, transcript);
    const initialTail = selectMutableTail(transcript);
    if (initialTail && !initialTail.seal) state.snapshotOnlyTurnId = initialTail.turnId;
    rememberPersistenceState(key, state);
    return;
  }
  const tail = selectMutableTail(transcript);
  if (!tail) {
    if (state.partial) {
      state = await saveMetadata(provider, transcript, state);
      rememberPersistenceState(key, state);
      return;
    }
    state = await saveSnapshot(provider, transcript);
    rememberPersistenceState(key, state);
    return;
  }

  if (state.snapshotOnlyTurnId === tail.turnId) {
    if (state.partial) throw new Error("Paged local transcript requires a full reload before snapshot recovery");
    state = await saveSnapshot(provider, transcript);
    if (!tail.seal) state.snapshotOnlyTurnId = tail.turnId;
    rememberPersistenceState(key, state);
    return;
  }
  if (state.mutableTurnId === null && tail.seal) {
    if (state.partial) {
      state = await saveMetadata(provider, transcript, state);
      rememberPersistenceState(key, state);
      return;
    }
    state = await saveSnapshot(provider, transcript);
    rememberPersistenceState(key, state);
    return;
  }
  const compatibleMutableTurn = state.mutableTurnId === null
    || state.mutableTurnId === tail.turnId
    || state.mutableTurnId === "__pending__";
  if (!compatibleMutableTurn) {
    if (state.partial) throw new Error("Paged local transcript tail changed before its prior turn was sealed");
    state = await saveSnapshot(provider, transcript);
    if (!tail.seal) state.snapshotOnlyTurnId = tail.turnId;
    rememberPersistenceState(key, state);
    return;
  }

  try {
    const next = await saveTail(provider, transcript, state, tail);
    rememberPersistenceState(key, next);
  } catch (reason) {
    if (!/generation is stale/i.test(String(reason))) throw reason;
    if (state.partial) throw new Error("Paged local transcript changed outside this window; reload it before saving");
    const recovered = await saveSnapshot(provider, transcript);
    if (!tail.seal) recovered.snapshotOnlyTurnId = tail.turnId;
    rememberPersistenceState(key, recovered);
  }
}

export async function loadLocalTranscript<T extends LocalTranscriptValue>(
  provider: LocalTranscriptProvider,
  threadId: string,
): Promise<T | null> {
  const transcript = await invoke<T | null>("local_transcript_full_read", { provider, threadId });
  const key = persistenceKey(provider, threadId);
  if (!transcript) {
    persistenceStates.delete(key);
    return null;
  }
  const existing = persistenceStates.get(key);
  try {
    const state = await readWriteState(provider, threadId);
    if (existing?.partial) return transcript;
    if (state) rememberPersistenceState(key, {
      ...state,
      partial: false,
      mutableTurnId: storedMutableTurnId(transcript, state),
      snapshotOnlyTurnId: null,
    });
    else persistenceStates.delete(key);
  } catch {
    // The transcript is already readable. A transient token failure should
    // only disable incremental writes for a complete in-memory transcript.
    // Never discard a partial marker: doing so could let a later save replace
    // unseen history with the bounded renderer window.
    if (!existing?.partial) persistenceStates.delete(key);
  }
  return transcript;
}

export async function loadLocalTranscriptPage<T extends LocalTranscriptPage>(
  provider: LocalTranscriptProvider,
  threadId: string,
  cursor?: string,
): Promise<T | null> {
  const key = persistenceKey(provider, threadId);
  if (cursor) {
    return invoke<T | null>("local_transcript_page_read", {
      provider,
      threadId,
      cursor,
      byteBudget: LOCAL_TRANSCRIPT_INITIAL_BYTES,
    });
  }
  let page = await invoke<T | null>("local_transcript_page_read", {
    provider,
    threadId,
    cursor: null,
    byteBudget: LOCAL_TRANSCRIPT_INITIAL_BYTES,
  });
  if (!page) {
    persistenceStates.delete(key);
    return null;
  }
  // An interrupted process can leave its newest durable turn mutable. A
  // bounded renderer window cannot safely snapshot around unseen history when
  // the next turn begins, so recover the complete transcript once on this
  // exceptional restart path. Ordinary sealed transcripts stay paged.
  if (page.tailSeq <= page.headSeq && page.nextCursor) {
    const transcript = await invoke<LocalTranscriptValue | null>("local_transcript_full_read", { provider, threadId });
    if (!transcript) {
      persistenceStates.delete(key);
      return null;
    }
    page = {
      ...page,
      ...transcript,
      nextCursor: null,
      byteLen: estimateTranscriptBytes(transcript.messages, transcript.activities),
    } as T;
  }
  // The backend returns the page and mutable-tail boundary under one database
  // lock, avoiding both a second native round trip and a page/token race.
  rememberPersistenceState(key, {
    generation: page.generation,
    headSeq: page.headSeq,
    tailSeq: page.tailSeq,
    partial: Boolean(page.nextCursor),
    mutableTurnId: storedMutableTurnId(page, page),
    snapshotOnlyTurnId: null,
  });
  return page;
}

export function saveLocalTranscript(
  provider: LocalTranscriptProvider,
  transcript: LocalTranscriptValue,
): Promise<void> {
  const key = persistenceKey(provider, transcript.thread.id);
  if (deletingTranscripts.has(key)) {
    return Promise.reject(new Error("Local transcript is being deleted"));
  }
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(() => persistTranscript(provider, transcript));
  saveQueues.set(key, queued);
  void queued.finally(() => {
    if (saveQueues.get(key) === queued) saveQueues.delete(key);
  }).catch(() => undefined);
  return queued;
}

export async function forgetLocalTranscriptPersistence(
  provider: LocalTranscriptProvider,
  threadId: string,
  deleteStored: () => Promise<void>,
): Promise<void> {
  const key = persistenceKey(provider, threadId);
  deletingTranscripts.add(key);
  try {
    let pending = saveQueues.get(key);
    while (pending) {
      await pending.catch(() => undefined);
      const next = saveQueues.get(key);
      if (!next || next === pending) break;
      pending = next;
    }
    await deleteStored();
    persistenceStates.delete(key);
    saveQueues.delete(key);
  } finally {
    deletingTranscripts.delete(key);
  }
}

export function resetLocalTranscriptPersistenceForTests(): void {
  persistenceStates.clear();
  saveQueues.clear();
  deletingTranscripts.clear();
}

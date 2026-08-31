import { invoke } from "@tauri-apps/api/core";
import type { Activity, ChatMessage, Thread } from "../types";

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

interface PersistenceState extends LocalTranscriptWriteState {
  mutableTurnId: string | null;
  /** A generation conflict makes incremental replacement ambiguous for the
   * rest of this turn. Full snapshots remain safe and are still uncommon. */
  snapshotOnlyTurnId: string | null;
}

interface TailSelection {
  value: LocalTranscriptValue;
  turnId: string;
  seal: boolean;
}

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
  await invoke("local_transcript_snapshot_write", { provider, value: transcript });
  const state = await readWriteState(provider, transcript.thread.id);
  if (!state) throw new Error("Local transcript snapshot was saved without write state");
  return { ...state, mutableTurnId: null, snapshotOnlyTurnId: null };
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
    state = await saveSnapshot(provider, transcript);
    rememberPersistenceState(key, state);
    return;
  }

  if (state.snapshotOnlyTurnId === tail.turnId) {
    state = await saveSnapshot(provider, transcript);
    if (!tail.seal) state.snapshotOnlyTurnId = tail.turnId;
    rememberPersistenceState(key, state);
    return;
  }
  if (state.mutableTurnId === null && tail.seal) {
    state = await saveSnapshot(provider, transcript);
    rememberPersistenceState(key, state);
    return;
  }
  const compatibleMutableTurn = state.mutableTurnId === null
    || state.mutableTurnId === tail.turnId
    || state.mutableTurnId === "__pending__";
  if (!compatibleMutableTurn) {
    state = await saveSnapshot(provider, transcript);
    if (!tail.seal) state.snapshotOnlyTurnId = tail.turnId;
    rememberPersistenceState(key, state);
    return;
  }

  try {
    const next = await invoke<LocalTranscriptWriteState>("local_transcript_tail_write", {
      provider,
      value: tail.value,
      expectedGeneration: state.generation,
      seal: tail.seal,
    });
    rememberPersistenceState(key, {
      ...next,
      mutableTurnId: tail.seal ? null : tail.turnId,
      snapshotOnlyTurnId: null,
    });
  } catch (reason) {
    if (!/generation is stale/i.test(String(reason))) throw reason;
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
  try {
    const state = await readWriteState(provider, threadId);
    if (state) rememberPersistenceState(key, { ...state, mutableTurnId: null, snapshotOnlyTurnId: null });
    else persistenceStates.delete(key);
  } catch {
    // The transcript is already readable. A transient token failure should
    // only disable incremental writes; the next save safely snapshots it.
    persistenceStates.delete(key);
  }
  return transcript;
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

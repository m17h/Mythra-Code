import { create } from "zustand";
import { flushPendingStateWrites, loadStored, storeValue } from "../storage";

/**
 * Prompts on their way to another device. With the composer's drafts, these are
 * the only remote contents kept across launches. The composer clears its draft
 * before sending and this holds the text, so a lost acknowledgement can never
 * leave it sitting in the composer ready to be sent a second time.
 */
const STORAGE_KEY = "kiwi.remote.outbox";
const MAX_ENTRIES = 64;
export const MAX_PROMPT_CHARS = 256 * 1024;

export type OutboxOperation = "prompt.send" | "prompt.queue" | "prompt.steer";
/**
 * `sending`: handed to the link.
 * `awaiting`: the acknowledgement was lost, and only the host can say what happened.
 * `retry`: the host proved it never admitted this, so the same `opId` is safe.
 * `uncertain`: nobody can say. The user has to look at the conversation.
 * `rejected`: refused after the composer had moved on, so the text stays here.
 */
export type OutboxState = "sending" | "awaiting" | "retry" | "uncertain" | "rejected";
export interface OutboxEntry {
  opId: string;
  opSeq: number;
  device: string;
  op: OutboxOperation;
  threadId?: string;
  workspaceId?: string;
  handle?: string;
  draftKey: string;
  text: string;
  state: OutboxState;
  createdAt: number;
  error?: string;
}
export interface NewThreadTarget { workspaceId: string; draftId: string }
interface Persisted {
  entries: OutboxEntry[];
  /** Highest `opSeq` used per device, so a restart never reuses one. */
  sequences: Record<string, number>;
}
interface OutboxStore extends Persisted {
  /** The new thread being written on each device. Not persisted. */
  compose: Record<string, NewThreadTarget | undefined>;
}

const ENTRY_STATES = new Set<OutboxState>(["sending", "awaiting", "retry", "uncertain", "rejected"]);
const OPERATIONS = new Set<OutboxOperation>(["prompt.send", "prompt.queue", "prompt.steer"]);
function restoredEntry(value: unknown): OutboxEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<OutboxEntry>;
  if (typeof entry.opId !== "string" || typeof entry.opSeq !== "number" || typeof entry.device !== "string"
    || typeof entry.draftKey !== "string" || typeof entry.text !== "string" || typeof entry.createdAt !== "number"
    || !entry.op || !OPERATIONS.has(entry.op) || !entry.state || !ENTRY_STATES.has(entry.state)) return null;
  // A send interrupted by quitting may have reached the host. Ask, never resend.
  return { ...entry, state: entry.state === "sending" ? "awaiting" : entry.state } as OutboxEntry;
}
function restored(): Persisted {
  const stored = loadStored<Partial<Persisted>>(STORAGE_KEY, {});
  return {
    entries: Array.isArray(stored.entries) ? stored.entries.map(restoredEntry).filter((entry): entry is OutboxEntry => Boolean(entry)).slice(-MAX_ENTRIES) : [],
    sequences: stored.sequences && typeof stored.sequences === "object" ? stored.sequences : {},
  };
}

export const useRemoteOutbox = create<OutboxStore>(() => ({ ...restored(), compose: {} }));

export const threadDraftKey = (device: string, threadId: string) => `${device}/${threadId}`;
export const newThreadDraftKey = (device: string, target: NewThreadTarget) => `${device}/${target.workspaceId}/${target.draftId}`;

function persist(): void {
  const { entries, sequences } = useRemoteOutbox.getState();
  storeValue<Persisted>(STORAGE_KEY, { entries, sequences });
}

export function nextOperationSequence(device: string, atLeast = 0): number {
  const current = Math.max(useRemoteOutbox.getState().sequences[device] ?? 0, atLeast);
  const next = current + 1;
  useRemoteOutbox.setState((state) => ({ sequences: { ...state.sequences, [device]: next } }));
  persist();
  return next;
}

export function outboxIsFull(): boolean {
  return useRemoteOutbox.getState().entries.length >= MAX_ENTRIES;
}

/** Waits until the prompt is durable. Nothing reaches the network before this returns. */
export async function admitToOutbox(entry: OutboxEntry): Promise<void> {
  useRemoteOutbox.setState((state) => ({ entries: [...state.entries, entry] }));
  persist();
  await flushPendingStateWrites();
}

export function updateOutboxEntry(opId: string, change: Partial<OutboxEntry>): void {
  useRemoteOutbox.setState((state) => ({
    entries: state.entries.map((entry) => entry.opId === opId ? { ...entry, ...change } : entry),
  }));
  persist();
}

export function removeOutboxEntry(opId: string): void {
  useRemoteOutbox.setState((state) => ({ entries: state.entries.filter((entry) => entry.opId !== opId) }));
  persist();
}

/** The host refused it after the composer moved on. It was never delivered, so
 * the text stays beside the conversation to copy instead of overwriting newer typing. */
export function markPromptRejected(opId: string, error: string): void {
  updateOutboxEntry(opId, { state: "rejected", error });
}

export function setNewThreadTarget(device: string, target: NewThreadTarget | undefined): void {
  useRemoteOutbox.setState((state) => ({ compose: { ...state.compose, [device]: target } }));
}

/** One saved new-thread draft per workspace, the same as on this machine. */
export const newThreadTargetFor = (workspaceId: string): NewThreadTarget => ({ workspaceId, draftId: "draft" });

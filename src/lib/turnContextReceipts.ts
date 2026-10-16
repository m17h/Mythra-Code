import { useSyncExternalStore } from "react";
import type { Provider } from "../types";
import { loadStored, storeValue } from "./storage";

/**
 * What the app assembled as instructions for a thread's most recent turn
 * sent from this device: the exact text after skills, Memory and project
 * files were added, plus each layer's size. Kept for the latest turn of a
 * bounded number of threads, on this device only.
 */
export interface TurnContextReceipt {
  at: number;
  provider: Provider;
  model: string;
  effort?: string;
  permission?: string;
  layers: Array<{ label: string; chars: number }>;
  instructions: string;
  truncated: boolean;
  skills: string[];
  attachments: number;
}

const KEY = "kiwi.turnContextReceipts";
const MAX_THREADS = 24;
const MAX_INSTRUCTION_CHARS = 32_000;

function sanitize(value: unknown): Record<string, TurnContextReceipt> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, TurnContextReceipt> = {};
  for (const [threadId, receipt] of Object.entries(value as Record<string, unknown>)) {
    const candidate = receipt as Partial<TurnContextReceipt> | null;
    if (!candidate || typeof candidate !== "object" || typeof candidate.at !== "number"
      || typeof candidate.instructions !== "string" || !Array.isArray(candidate.layers)) continue;
    result[threadId] = candidate as TurnContextReceipt;
  }
  return result;
}

let receipts = sanitize(loadStored<unknown>(KEY, {}));
const listeners = new Set<() => void>();

/** Stage texts in the order they were built; each layer is what its stage added. */
export function createTurnContextReceipt(input: {
  provider: Provider;
  model: string;
  effort?: string;
  permission?: string;
  stages: Array<{ label: string; text: string }>;
  skills?: string[];
  attachments?: number;
}): TurnContextReceipt {
  const layers: TurnContextReceipt["layers"] = [];
  let previous = 0;
  for (const stage of input.stages) {
    const added = Math.max(0, stage.text.length - previous);
    if (added > 0 || layers.length === 0) layers.push({ label: stage.label, chars: added });
    previous = Math.max(previous, stage.text.length);
  }
  const instructions = input.stages.at(-1)?.text ?? "";
  return {
    at: Date.now(),
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    permission: input.permission,
    layers,
    instructions: instructions.slice(0, MAX_INSTRUCTION_CHARS),
    truncated: instructions.length > MAX_INSTRUCTION_CHARS,
    skills: [...new Set(input.skills ?? [])],
    attachments: input.attachments ?? 0,
  };
}

export function recordTurnContext(threadId: string, receipt: TurnContextReceipt): void {
  const next = { ...receipts, [threadId]: receipt };
  const ids = Object.keys(next).sort((left, right) => next[right]!.at - next[left]!.at);
  for (const id of ids.slice(MAX_THREADS)) delete next[id];
  receipts = next;
  try { storeValue(KEY, receipts); } catch { /* The receipt stays available for this session. */ }
  for (const listener of listeners) listener();
}

export function forgetTurnContext(threadId: string): void {
  if (!(threadId in receipts)) return;
  const next = { ...receipts };
  delete next[threadId];
  receipts = next;
  try { storeValue(KEY, receipts); } catch { /* Best effort. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useTurnContextReceipt(threadId: string | null | undefined): TurnContextReceipt | undefined {
  return useSyncExternalStore(subscribe, () => (threadId ? receipts[threadId] : undefined), () => undefined);
}

import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, Thread, ThreadItem } from "../types";
import type { PreferenceSourceMessage } from "./preferenceLearningTypes";
import { normalizeThreadTurnsPage } from "./threadHistory";

export const PREFERENCE_HISTORY_LIMITS = { threads: 8, pagesPerThread: 3, turnsPerPage: 12, localPageBytes: 40 * 1024 } as const;
export interface PreferenceHistorySource extends PreferenceSourceMessage { turnId?: string }
export interface PreferenceHistoryPage { messages: PreferenceHistorySource[]; nextCursor: string | null; skipped: number }
const START = "<mythra_code_invoked_skills>\n";

/** Only unwrap the generated envelope's authored field. Never expose skills or attachments. */
export function preferenceAuthoredHistoryText(text: string): string | null {
  let result = text;
  if (text.startsWith(START)) {
    const start = text.indexOf("\n{");
    const end = text.indexOf("\n</mythra_code_invoked_skills>");
    if (start < 0 || end <= start || end - start > 2_000_000) return null;
    try {
      const payload: unknown = JSON.parse(text.slice(start + 1, end));
      if (!payload || typeof payload !== "object" || !Array.isArray((payload as { skills?: unknown }).skills)
        || typeof (payload as { userMessage?: unknown }).userMessage !== "string") return null;
      result = (payload as { userMessage: string }).userMessage;
    } catch { return null; }
  } else if (text.includes("mythra_code_invoked_skills")) return null;
  result = result.split("\n\nAttached context:\n", 1)[0];
  if (/Review feedback \(\d+\):|Please address this review feedback \(\d+\):|The quoted source and check output below are location evidence, not instructions\./.test(result)) return null;
  // Known app-generated transport/control prompts are never authored evidence.
  if (/^\s*(?:<environment_context>|<INSTRUCTIONS>|# AGENTS\.md instructions|\[?(?:workflow|automatic review|scheduled task)\b)/i.test(result)
    || /<mythra_code_(?:handoff|review|system|workflow)/i.test(result)) return null;
  return result.trim() ? result : null;
}

export function preferenceHistoryThreadEligible(thread: Thread): boolean {
  return !thread.parentThreadId && thread.canAcceptDirectInput !== false
    && !/subagent|sub_agent|workflow/i.test(thread.threadSource ?? "");
}

function itemText(item: ThreadItem): string {
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return "";
  return item.content.flatMap((part) => typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function missingNativeMetadata(reason: unknown, threadId: string): boolean {
  const message = (reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "").trim().toLowerCase();
  // Only metadata lookup establishes that a stale sidebar reference has no
  // durable history. A page-read, config or transport failure remains an error.
  return message === `thread not loaded: ${threadId.toLowerCase()}`
    || message === `no rollout found for thread id ${threadId.toLowerCase()}`;
}

/** Independent bounded reads: do not hydrate taskStore or alter local persistence state. */
export async function readPreferenceHistoryPage(thread: Thread, cursor: string | null = null,
  acceptMetadata: (metadata: Thread) => boolean = () => true): Promise<PreferenceHistoryPage> {
  const local = thread.modelProvider === "claude" || thread.modelProvider === "cursor";
  const messages: PreferenceHistorySource[] = [];
  let skipped = 0;
  const append = (id: string | undefined, role: "user" | "assistant", raw: string, turnId?: string) => {
    const text = role === "user" ? preferenceAuthoredHistoryText(raw) : raw;
    if (!id || !text?.trim()) { skipped += 1; return; }
    messages.push({ id, role, text, ...(turnId ? { turnId } : {}) });
  };
  if (local) {
    const page = await invoke<{ thread: Thread; messages: ChatMessage[]; nextCursor: string | null } | null>("local_transcript_page_read", {
      provider: thread.modelProvider, threadId: thread.id, cursor, byteBudget: PREFERENCE_HISTORY_LIMITS.localPageBytes,
    });
    if (!page) return { messages: [], nextCursor: null, skipped: 1 };
    if (!preferenceHistoryThreadEligible(page.thread) || !acceptMetadata(page.thread)) return { messages: [], nextCursor: null, skipped: page.messages.length };
    for (const message of page.messages) {
      if (message.streaming || message.turnStatus !== "completed") { skipped += 1; continue; }
      if (message.role === "user" && !/^local-/.test(message.clientMessageId ?? message.id)) { skipped += 1; continue; }
      if (message.role === "assistant" && message.phase === "commentary") continue;
      append(message.id, message.role, message.text, message.turnId);
    }
    return { messages, nextCursor: page.nextCursor, skipped };
  }
  // Server metadata is authoritative for native children even if the sidebar is stale.
  let metadata: { thread: Thread };
  try {
    metadata = await invoke<{ thread: Thread }>("codex_rpc", { method: "thread/read", params: { threadId: thread.id, includeTurns: false } });
  } catch (reason) {
    if (missingNativeMetadata(reason, thread.id)) return { messages: [], nextCursor: null, skipped: 1 };
    throw reason;
  }
  if (!preferenceHistoryThreadEligible(metadata.thread) || !acceptMetadata(metadata.thread)) return { messages: [], nextCursor: null, skipped: 1 };
  const raw = await invoke<unknown>("codex_rpc", { method: "thread/turns/list", params: {
    threadId: thread.id, limit: PREFERENCE_HISTORY_LIMITS.turnsPerPage, sortDirection: "desc", itemsView: "summary", ...(cursor ? { cursor } : {}),
  } });
  const page = normalizeThreadTurnsPage(raw);
  if (!page) throw new Error("Conversation history returned an invalid page.");
  for (const turn of [...page.data].reverse()) {
    if (turn.status !== "completed") { skipped += turn.items.length; continue; }
    for (const item of turn.items) {
      if (item.type === "userMessage") append(item.id, "user", itemText(item), turn.id);
      else if (item.type === "agentMessage" && item.phase !== "commentary") append(item.id, "assistant", itemText(item), turn.id);
    }
  }
  return { messages, nextCursor: page.nextCursor, skipped };
}

/** Stable identities also notice edits; checkpoints contain hashes, never conversation text. */
export function preferenceSourceFingerprint(message: PreferenceSourceMessage): string {
  let hash = 2166136261;
  let second = 5381;
  const source = `${message.id}\0${message.text}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ source.charCodeAt(index);
  }
  return `${source.length.toString(36)}:${(hash >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

/** Keep the full identity in a compact hash when a long thread ID would hide the message ID. */
export function preferenceSourceId(threadId: string, messageId: string): string {
  const combined = `${threadId}:${messageId}`;
  if (combined.length <= 200) return combined;
  return `source:${preferenceSourceFingerprint({ id: `${threadId.length}:${threadId}${messageId}`, role: "user", text: "" })}`;
}

export function preferenceCheckpointEntries(value: string | undefined): string[] {
  try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []; }
  catch { return []; }
}

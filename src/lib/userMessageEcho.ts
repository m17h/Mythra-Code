import type { ChatMessage } from "../types";

const ATTACHED_CONTEXT_MARKER = "\n\nAttached context:\n";

/** Remove file-reference lines appended by buildTurnInput without eating an
 * unrecognized transport suffix that may contain user-authored text. */
function withoutGeneratedAttachedContext(suffix: string): string {
  if (!suffix.startsWith(ATTACHED_CONTEXT_MARKER)) return suffix;
  const lines = suffix.slice(ATTACHED_CONTEXT_MARKER.length).split("\n");
  let generatedLines = 0;
  while (generatedLines < lines.length && lines[generatedLines].startsWith("@") && lines[generatedLines].length > 1) {
    generatedLines += 1;
  }
  if (generatedLines === 0) return suffix;
  const remainder = lines.slice(generatedLines).join("\n");
  return remainder ? `\n${remainder}` : "";
}

/** Undo Mythra's generated skill envelope and file context when displaying provider history. */
export function displayedUserPrompt(text: string): string {
  if (!text.startsWith("<mythra_code_invoked_skills>\n")) return text;
  const start = text.indexOf("\n{");
  const end = text.indexOf("\n</mythra_code_invoked_skills>");
  if (start < 0 || end < start) return text;
  try {
    const payload = JSON.parse(text.slice(start + 1, end));
    if (Array.isArray(payload.skills) && typeof payload.userMessage === "string") {
      const suffix = text.slice(end + "\n</mythra_code_invoked_skills>".length);
      return payload.userMessage + withoutGeneratedAttachedContext(suffix);
    }
  } catch { /* Unrecognized text is ordinary user input. */ }
  return text;
}

export function userEchoIndex(messages: ChatMessage[], incoming: ChatMessage): number {
  if (incoming.role !== "user" || !incoming.turnId) return -1;
  const text = displayedUserPrompt(incoming.text);
  return messages.findIndex((entry) => entry.role === "user"
    && (entry.clientMessageId ? entry.id === entry.clientMessageId : /^(local-|scheduled-|workflow-)/.test(entry.id))
    && entry.turnId === incoming.turnId
    && (text === entry.text || text.startsWith(`${entry.text}\n\nAttached context:\n`))
    && JSON.stringify((entry.attachments ?? []).map((item) => item.path))
      === JSON.stringify((incoming.attachments ?? []).map((item) => item.path)));
}

/** One-to-one reconciliation: two intentional identical sends remain two rows. */
export function reconcileUserMessages(incoming: ChatMessage[], live: ChatMessage[]): { messages: ChatMessage[]; matchedIds: Set<string> } {
  const matchedIds = new Set<string>();
  const byId = new Map(live.map((message) => [message.id, message]));
  const byTurn = new Map<string, ChatMessage[]>();
  for (const message of live) {
    if (!message.turnId || message.role !== "user") continue;
    const entries = byTurn.get(message.turnId) ?? [];
    entries.push(message);
    byTurn.set(message.turnId, entries);
  }
  const messages = incoming.map((message) => {
    if (message.role !== "user") return message;
    const candidates = byId.has(message.id) ? [] : (byTurn.get(message.turnId ?? "") ?? []).filter((entry) => !matchedIds.has(entry.id));
    const existing = byId.get(message.id) ?? candidates[userEchoIndex(candidates, message)];
    if (!existing) return message;
    matchedIds.add(existing.id);
    return { ...message, ...(existing.id === message.id ? existing : {}), text: existing.text, attachments: existing.attachments ?? message.attachments,
      clientMessageId: existing.clientMessageId ?? (existing.id !== message.id ? existing.id : undefined), steerStatus: existing.steerStatus };
  });
  return { messages, matchedIds };
}

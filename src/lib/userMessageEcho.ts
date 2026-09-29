import type { ChatMessage } from "../types";
import { skillMentionRanges } from "./skillMentions";
import { isSkillDependencyPath, sanitizeMessageSkillDependencies, validSkillDependencyReport } from "./skillDependencies";

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
export function displayedUserMessage(text: string): Pick<ChatMessage, "text" | "skillReferences" | "skillsFolder" | "skillDependencies"> {
  if (!text.startsWith("<mythra_code_invoked_skills>\n")) return { text };
  const start = text.indexOf("\n{");
  const end = text.indexOf("\n</mythra_code_invoked_skills>");
  if (start < 0 || end < start || end - start > 2_000_000) return { text };
  try {
    const payload = JSON.parse(text.slice(start + 1, end));
    if (payload && typeof payload === "object" && Array.isArray(payload.skills) && typeof payload.userMessage === "string") {
      const suffix = text.slice(end + "\n</mythra_code_invoked_skills>".length);
      const display = payload.userMessage + withoutGeneratedAttachedContext(suffix);
      const skillDependencies = validSkillDependencyReport(payload.dependencyReport ?? payload.skillDependencies);
      const hasDependencyMetadata = Object.hasOwn(payload, "dependencyReport") || Object.hasOwn(payload, "skillDependencies");
      const userRootPaths = skillDependencies ? new Set(skillDependencies.roots.filter((root) => root.channel === "user")
        .map((root) => skillDependencies.nodes.find((node) => node.id === root.nodeId)?.path)) : undefined;
      const hasExplicitReferences = Object.hasOwn(payload, "skillReferences");
      const candidates: unknown[] = hasExplicitReferences ? (Array.isArray(payload.skillReferences) ? payload.skillReferences : [])
        : hasDependencyMetadata && !skillDependencies ? [] : payload.skills;
      const sources: Array<{ name: string; sourcePath: string }> = candidates.slice(0, 64)
        .filter((entry: unknown): entry is { name: string; sourcePath: string } => Boolean(entry && typeof entry === "object"
          && (!("kind" in entry) || entry.kind === "skill")
          && "name" in entry && typeof entry.name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(entry.name)
          && "sourcePath" in entry && isSkillDependencyPath(entry.sourcePath)
          && (hasExplicitReferences || !userRootPaths || userRootPaths.has(entry.sourcePath))));
      const skillReferences = skillMentionRanges(display, sources).map(({ start, end, skill }) => ({ start, end, name: skill.name, path: skill.sourcePath }));
      return { text: display, skillReferences,
        ...(isSkillDependencyPath(payload.skillsFolder) ? { skillsFolder: payload.skillsFolder } : {}),
        ...(skillDependencies ? { skillDependencies } : {}) };
    }
  } catch { /* Unrecognized text is ordinary user input. */ }
  return { text };
}

export function displayedUserPrompt(text: string): string {
  return displayedUserMessage(text).text;
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

/** A prior writer could persist one local prompt before and after its turn ID
 * arrived. Keep its first timeline position and freshest identified contents.
 * Distinct IDs remain distinct even when the user sent identical text. */
function collapseRepeatedUserIds(messages: ChatMessage[]): ChatMessage[] {
  const canonical = new Map<string, ChatMessage>();
  let duplicated = false;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const previous = canonical.get(message.id);
    if (!previous) canonical.set(message.id, message);
    else {
      duplicated = true;
      if (message.turnId || !previous.turnId) canonical.set(message.id, {
        ...previous,
        ...message,
        timelineOrder: previous.timelineOrder ?? message.timelineOrder,
        attachments: message.attachments ?? previous.attachments,
        skillReferences: message.skillReferences ?? previous.skillReferences,
        skillsFolder: message.skillsFolder ?? previous.skillsFolder,
        skillDependencies: message.skillDependencies ?? previous.skillDependencies,
      });
    }
  }
  if (!duplicated) return messages;
  const emitted = new Set<string>();
  return messages.flatMap((message) => {
    if (message.role !== "user") return [message];
    if (emitted.has(message.id)) return [];
    emitted.add(message.id);
    return [canonical.get(message.id) ?? message];
  });
}

/** One-to-one reconciliation: two intentional identical sends remain two rows. */
export function reconcileUserMessages(incoming: ChatMessage[], live: ChatMessage[]): { messages: ChatMessage[]; matchedIds: Set<string> } {
  const matchedIds = new Set<string>();
  const sanitizedLive = live.map(sanitizeMessageSkillDependencies);
  const byId = new Map(sanitizedLive.map((message) => [message.id, message]));
  const byTurn = new Map<string, ChatMessage[]>();
  for (const message of sanitizedLive) {
    if (!message.turnId || message.role !== "user") continue;
    const entries = byTurn.get(message.turnId) ?? [];
    entries.push(message);
    byTurn.set(message.turnId, entries);
  }
  const messages = collapseRepeatedUserIds(incoming.map(sanitizeMessageSkillDependencies)).map((message) => {
    if (message.role !== "user") return message;
    const candidates = byId.has(message.id) ? [] : (byTurn.get(message.turnId ?? "") ?? []).filter((entry) => !matchedIds.has(entry.id));
    const existing = byId.get(message.id) ?? candidates[userEchoIndex(candidates, message)];
    if (!existing) return message;
    matchedIds.add(existing.id);
    return { ...message, ...(existing.id === message.id ? existing : {}), timelineOrder: message.timelineOrder ?? existing.timelineOrder, text: existing.text, attachments: existing.attachments ?? message.attachments,
      clientMessageId: existing.clientMessageId ?? (existing.id !== message.id ? existing.id : undefined), steerStatus: existing.steerStatus,
      skillReferences: existing.skillReferences ?? message.skillReferences, skillsFolder: existing.skillsFolder ?? message.skillsFolder,
      skillDependencies: existing.skillDependencies ?? message.skillDependencies };
  });
  return { messages, matchedIds };
}

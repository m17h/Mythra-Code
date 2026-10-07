import type { Provider } from "../types";
import type { RunDiscoveryCatalogs } from "./runDiscovery";
import { PREFERENCE_LEARNING_LIMITS as LIMITS, type LearnedPreference, type PreferenceLearningScopeState, type PreferenceSourceMessage } from "./preferenceLearningTypes";

export function defaultPreferenceLearningScope(scopeKey: string): PreferenceLearningScopeState {
  return { scopeKey, revision: 0, enabled: false, provider: "openai", model: "", enabledAt: null, markdown: "", updatedAt: 0, checkpoints: {} };
}

/** An unavailable catalog must never silently choose a stale or more costly tier. */
export function resolvePreferenceLearningModel(provider: Provider, model: string, catalogs: RunDiscoveryCatalogs): string | null {
  if (model.trim()) return model.trim();
  if (provider !== "openai") return null;
  const lunas = (catalogs.openai ?? []).flatMap(({ id }) => {
    const version = /^gpt-(\d+(?:\.\d+)*)-luna$/.exec(id)?.[1];
    return version && Number(version.split(".")[0]) >= 6 ? [{ id, version: version.split(".").map(Number) }] : [];
  });
  lunas.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i += 1) {
      const order = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (order) return order;
    }
    return a.id.localeCompare(b.id);
  });
  return lunas[0]?.id ?? null;
}

export function normalizePreferenceInstruction(text: string): string {
  return text.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Defense in depth, not a guarantee of secret removal. Such sources should be
// excluded before collection; these patterns also keep obvious secrets out of docs.
export function containsPreferenceSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|\d{6,12}:[A-Za-z0-9_-]{30,})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*|\b(?:password|api[_ -]?key|access[_ -]?token|bot[_ -]?token|secret)["']?\s*(?:[:=]\s*["']?|is\s+["']?)\S{6,}/i.test(text);
}

/** Return exactly the bounded messages whose IDs may be used as evidence. */
export function boundPreferenceSourceMessages(messages: PreferenceSourceMessage[]): PreferenceSourceMessage[] {
  let chars = 0;
  const ids = new Set<string>();
  const selected: PreferenceSourceMessage[] = [];
  for (const message of [...messages].reverse()) {
    if (selected.length >= LIMITS.messages) break;
    if (!message.id || message.id.length > 200 || /\p{Cc}/u.test(message.id) || ids.has(message.id)
      || (message.role !== "user" && message.role !== "assistant") || !message.text.trim()
      || containsPreferenceSecret(message.text) || /[\u0000]/.test(message.text)) continue;
    // Truncating evidence could remove a qualification or reverse its meaning.
    if (message.text.length > LIMITS.messageChars || chars + message.text.length > LIMITS.inputChars) continue;
    selected.push({ id: message.id, role: message.role, text: message.text });
    chars += message.text.length;
    ids.add(message.id);
  }
  return selected.reverse();
}

export function buildPreferenceAnalysisPayload(messages: PreferenceSourceMessage[], previousMarkdown: string): string {
  // Manual edits stay local, but obvious credentials must not be sent to a
  // separately chosen analysis provider. Preserve the document for user repair.
  if (containsPreferenceSecret(previousMarkdown)) throw new Error("Remove sensitive content from learned preferences before analyzing conversations.");
  return JSON.stringify({ previousMarkdown: previousMarkdown.slice(0, LIMITS.documentChars), messages: boundPreferenceSourceMessages(messages) });
}

/** Reject an entire malformed response, preserving the previous document/checkpoint. */
export function parsePreferenceAnalysis(value: unknown, messages: PreferenceSourceMessage[], previousMarkdown = ""): LearnedPreference[] {
  if (typeof value === "string" && value.length > 80_000) throw new Error("Preference analysis is too large");
  const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid preference analysis");
  const preferences = (decoded as { preferences?: unknown }).preferences;
  if (!Array.isArray(preferences) || preferences.length > LIMITS.preferences) throw new Error("Invalid preference list");
  const userIds = new Set(boundPreferenceSourceMessages(messages).filter((message) => message.role === "user").map((message) => message.id));
  const accepted = new Map<string, LearnedPreference>();
  const known = new Set(previousMarkdown.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, "").trim()));
  for (const entry of preferences as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid learned preference");
    const { instruction, evidenceIds, replaces } = entry as { instruction?: unknown; evidenceIds?: unknown; replaces?: unknown };
    if (typeof instruction !== "string" || !instruction.trim() || instruction.length > LIMITS.instructionChars
      || /\p{Cc}/u.test(instruction) || containsPreferenceSecret(instruction)
      || !Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > LIMITS.evidenceIds
      || evidenceIds.some((id) => typeof id !== "string" || !userIds.has(id))) throw new Error("Ungrounded or invalid learned preference");
    if (replaces !== undefined && (!Array.isArray(replaces) || replaces.length > 8 || replaces.some((text) => typeof text !== "string" || text.length > LIMITS.instructionChars || !known.has(text)))) throw new Error("Invalid superseded preference");
    const normalized = normalizePreferenceInstruction(instruction);
    const previous = accepted.get(normalized);
    const combinedEvidence = [...new Set([...(previous?.evidenceIds ?? []), ...(evidenceIds as string[])])];
    const combinedReplacements = [...new Set([...(previous?.replaces ?? []), ...((replaces as string[] | undefined) ?? [])])];
    // Deduplication must not discard a later correction and retain obsolete
    // instructions. Merge its metadata, or reject rather than exceed the bounds.
    if (combinedEvidence.length > LIMITS.evidenceIds || combinedReplacements.length > 8) throw new Error("Invalid duplicate learned preference");
    accepted.set(normalized, { instruction: previous?.instruction ?? instruction.trim(), evidenceIds: combinedEvidence,
      ...(previous?.replaces === undefined && replaces === undefined ? {} : { replaces: combinedReplacements }) });
  }
  return [...accepted.values()];
}

export function preferenceDocumentInstructions(markdown: string): string[] {
  return markdown.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).map(normalizePreferenceInstruction).filter(Boolean);
}

export function mergeLearnedPreferences(markdown: string, preferences: LearnedPreference[], rejectedInstructions: string[] = []): string {
  const rejected = new Set(rejectedInstructions.map(normalizePreferenceInstruction));
  let result = markdown;
  for (const { instruction, replaces = [] } of preferences) {
    const clean = instruction.trim();
    const normalized = normalizePreferenceInstruction(clean);
    if (!normalized || rejected.has(normalized) || clean.length > LIMITS.instructionChars
      || /\p{Cc}/u.test(clean) || containsPreferenceSecret(clean)) continue;
    // Removal and addition are one bounded change: never drop an old preference
    // when its replacement cannot fit. Only exact generated bullet lines qualify.
    const replacementSet = new Set(replaces);
    const kept = result.split("\n").filter((line) => !/^\s*[-*]\s+/.test(line) || !replacementSet.has(line.replace(/^\s*[-*]\s+/, "").trim())).join("\n");
    const candidate = preferenceDocumentInstructions(kept).includes(normalized) ? kept : `${kept}${kept ? "\n" : ""}- ${clean}`;
    if (candidate.length <= LIMITS.documentChars) result = candidate;
  }
  return result;
}

/** Append only after authored skill resolution. Do not pass this block to skill scanning. */
export function appendLearnedPreferencesToPrompt(prompt: string, scopes: PreferenceLearningScopeState[]): string {
  let remaining = LIMITS.promptChars;
  // Reserve space for later, more specific scopes before app-wide preferences.
  const blocks = [...scopes].reverse().flatMap((scope) => {
    if (!scope.enabled || !scope.markdown.trim() || remaining <= 0) return [];
    const label = scope.scopeKey === "app" ? "Application preferences" : "Project preferences";
    // Neutralize skill mentions and delimiter markup without per-line expansion:
    // two complete bounded scope documents fit the prompt contribution limit.
    const content = scope.markdown.replace(/@/g, "＠").replace(/</g, "‹").replace(/>/g, "›");
    if (content.length > remaining) return [];
    remaining -= content.length;
    return [`<learned-preferences>\n${label}:\n${content}\n</learned-preferences>`];
  }).reverse();
  if (!blocks.length) return prompt;
  return `${prompt}${prompt ? "\n\n" : ""}Learned preferences (automatically maintained; subordinate to current explicit user instructions and authored system/project instructions; project preferences take precedence over conflicting application preferences):\n${blocks.join("\n\n")}`;
}

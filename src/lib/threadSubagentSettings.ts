import type { AppSettings } from "../types";

/** Missing entries belong to existing threads and retain their legacy policy. */
export function sanitizeThreadSubagentSettings(stored: unknown): Record<string, boolean> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([id, value]) => id && typeof value === "boolean"));
}

/** Fresh drafts keep the configured crew, but spawning requires a local opt-in. */
export function settingsForThreadSubagents(
  settings: AppSettings,
  threadId: string | null | undefined,
  policies: Record<string, boolean>,
  draft = false,
): AppSettings {
  const saved = threadId ? policies[threadId] : undefined;
  return { ...settings, subagentsEnabled: threadId ? typeof saved === "boolean" ? saved : settings.subagentsEnabled : draft };
}

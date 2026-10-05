/** Records read before React mounts or rewritten by startup migrations. */
export const STARTUP_DATA_KEYS = new Set([
  "kiwi.schemaVersion", "kiwi.projects", "kiwi.knownThreads", "kiwi.settings",
  "kiwi.promptProfiles", "kiwi.usageLedger",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check unsafe startup shapes without normalizing or exposing saved contents.
 * Missing records and optional legacy fields retain their existing defaults. */
export function validateStartupData(readRaw: (key: string) => string | null): void {
  const invalid = (key: string): never => {
    throw new Error(`Saved startup data is invalid (${key}).`);
  };
  const read = (key: string): unknown => {
    const raw = readRaw(key);
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch { return invalid(key); }
  };
  const version = read("kiwi.schemaVersion") ?? 0;
  if (typeof version !== "number" || !Number.isFinite(version) || version < 0) return invalid("kiwi.schemaVersion");
  const projects = read("kiwi.projects");
  if (projects !== undefined && (!Array.isArray(projects) || projects.some((project) => (
    !isRecord(project) || (project.overrides && !isRecord(project.overrides))
  )))) invalid("kiwi.projects");

  const threads = read("kiwi.knownThreads");
  if (threads !== undefined && !isRecord(threads)) invalid("kiwi.knownThreads");

  const settings = read("kiwi.settings");
  if (settings !== undefined) {
    if (!isRecord(settings)) return invalid("kiwi.settings");
    for (const field of ["model", "lmStudioBaseUrl"]) {
      if (settings[field] != null && typeof settings[field] !== "string") invalid("kiwi.settings");
    }
  }

  const profiles = read("kiwi.promptProfiles");
  const ledger = read("kiwi.usageLedger");
  // These migrations dereference rows; later readers already sanitize them.
  if (version < 14) {
    if (profiles !== undefined && (!Array.isArray(profiles) || profiles.some((profile) => !isRecord(profile)))) {
      invalid("kiwi.promptProfiles");
    }
  }
  if (version < 16) {
    if (Array.isArray(ledger) && ledger.some((record) => record === null)) invalid("kiwi.usageLedger");
  }
}

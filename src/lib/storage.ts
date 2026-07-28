import { invoke } from "@tauri-apps/api/core";

export const DURABLE_STORAGE_KEYS = [
  "kiwi.schemaVersion",
  "kiwi.projects",
  "kiwi.workspaceMode",
  "kiwi.settings",
  "kiwi.threadProjects",
  "kiwi.knownThreads",
  "kiwi.threadModels",
  "kiwi.turnDurations",
  "kiwi.checkpoints",
  "kiwi.promptProfiles",
  "kiwi.customAgents",
  "kiwi.projectActions",
  "kiwi.scheduledTasks",
  "kiwi.pinnedThreads",
  "kiwi.archivedThreads",
  "kiwi.skillsFolder",
  "kiwi.skillAliases",
  "kiwi.disabledSkills",
  "kiwi.drafts",
  "kiwi.scheduleRuns",
  "kiwi.workflows",
  "kiwi.workflowRuns",
  "kiwi.costLedger",
  "kiwi.paneSizes",
  "kiwi.onboardingVersion",
] as const;

/**
 * Bump when any kiwi.* value changes shape, and add a corresponding step in
 * migrateStorage. Old installs then upgrade their data instead of loading
 * garbage into the new code.
 */
export const STORAGE_SCHEMA_VERSION = 4;

export function migrateStorage(): void {
  const stored = loadStored<number>("kiwi.schemaVersion", 0);
  if (stored >= STORAGE_SCHEMA_VERSION) return;
  // Version 2 adds the optional project systemPromptMode field. Version 3 adds
  // provider metadata to newly archived threads. Version 4 adds a separate
  // per-turn duration store. All additions are optional and require no eager
  // rewrite of existing records.
  storeValue("kiwi.schemaVersion", STORAGE_SCHEMA_VERSION);
}

export function loadStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storeValue<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy-mode failures must not abort the calling flow;
    // the SQLite mirror below still persists the value on desktop builds.
  }
  void Promise.resolve(invoke("state_write", { key, value })).catch(() => {
    // Browser previews and tests do not have a Tauri host. localStorage remains
    // the safe fallback while desktop builds persist the same value in SQLite.
  });
}

export async function hydrateNativeStorage(
  keys: readonly string[] = DURABLE_STORAGE_KEYS,
): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        const nativeValue = await invoke<unknown | null>("state_read", { key });
        if (nativeValue !== null) {
          localStorage.setItem(key, JSON.stringify(nativeValue));
          return;
        }
        const legacy = localStorage.getItem(key);
        if (legacy !== null) {
          await invoke("state_write", { key, value: JSON.parse(legacy) });
        }
      } catch {
        // Web-only development keeps using localStorage.
      }
    }),
  );
  migrateStorage();
}

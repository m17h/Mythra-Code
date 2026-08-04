import { invoke } from "@tauri-apps/api/core";

export const DURABLE_STORAGE_KEYS = [
  "kiwi.schemaVersion",
  "kiwi.projects",
  "kiwi.workspaceMode",
  "kiwi.settings",
  "kiwi.threadProjects",
  "kiwi.threadWorktrees",
  "kiwi.knownThreads",
  "kiwi.threadModels",
  "kiwi.turnDurations",
  "kiwi.checkpoints",
  "kiwi.checkpointHeads",
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
  "kiwi.usageLedger",
  "kiwi.paneSizes",
  "kiwi.sidebarSplitRatio",
  "kiwi.onboardingVersion",
] as const;

/**
 * Bump when any kiwi.* value changes shape, and add a corresponding step in
 * migrateStorage. Old installs then upgrade their data instead of loading
 * garbage into the new code.
 */
export const STORAGE_SCHEMA_VERSION = 9;
const nativeWriteQueues = new Map<string, Promise<void>>();

function queueNativeStateOperation(key: string, operation: () => Promise<unknown>): void {
  const previous = nativeWriteQueues.get(key);
  const write = () => {
    try {
      return Promise.resolve(operation()).then(() => undefined);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const next = previous
    ? previous.catch(() => undefined).then(write)
    : write();
  nativeWriteQueues.set(key, next);
  void next.finally(() => {
    if (nativeWriteQueues.get(key) === next) nativeWriteQueues.delete(key);
  }).catch(() => {
    // localStorage remains the immediate fallback if the native mirror fails.
  });
}

export async function flushPendingStateWrites(): Promise<void> {
  await Promise.allSettled([...nativeWriteQueues.values()]);
}

if (typeof window !== "undefined") {
  // Best-effort quit-time flush: without it, native-mirror writes queued just
  // before the window closes can be lost, and the next launch hydrates stale
  // data over the newer localStorage copy.
  window.addEventListener("pagehide", () => {
    void flushPendingStateWrites();
  });
}

export function migrateStorage(): void {
  const stored = loadStored<number>("kiwi.schemaVersion", 0);
  if (stored >= STORAGE_SCHEMA_VERSION) return;
  // Version 2 adds the optional project systemPromptMode field. Version 3 adds
  // provider metadata to newly archived threads. Version 4 adds a separate
  // per-turn duration store. Version 5 adds the current filesystem checkpoint
  // head for each project. Version 6 adds per-thread isolated worktree records.
  // Version 7 adds the persisted Projects/Threads sidebar split ratio.
  // Version 8 adds the durable per-thread and all-time token usage ledger.
  // Version 9 adds cumulative usage baselines, cache-write accounting, and
  // checkpoint metadata that can restore an applied worktree baseline.
  // All additions are optional and require no eager rewrite of existing records.
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
  // Writes for the same key are serialized so an older async SQLite write can
  // never finish after and overwrite a newer value.
  queueNativeStateOperation(key, () => invoke("state_write", { key, value }));
}

export function removeStoredValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // The native mirror can still remove the durable value.
  }
  queueNativeStateOperation(key, () => invoke("state_delete", { key }));
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

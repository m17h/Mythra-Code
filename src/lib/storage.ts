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
  "kiwi.queuedTurns",
  "kiwi.threadHandoffs",
  "kiwi.pendingHandoff",
  "kiwi.childAgentPolicies",
  "kiwi.childAgentLinks",
  "kiwi.onboardingVersion",
] as const;

/**
 * Bump when any kiwi.* value changes shape, and add a corresponding step in
 * migrateStorage. Old installs then upgrade their data instead of loading
 * garbage into the new code.
 */
export const STORAGE_SCHEMA_VERSION = 11;
const nativeWriteQueues = new Map<string, Promise<void>>();
const NATIVE_PENDING_PREFIX = "kiwi.nativePending.";
let nativeOperationSequence = 0;

function pendingMarkerKey(key: string): string {
  return `${NATIVE_PENDING_PREFIX}${key}`;
}

function markNativeOperationPending(key: string): string {
  const token = `${Date.now()}-${nativeOperationSequence += 1}`;
  try {
    localStorage.setItem(pendingMarkerKey(key), token);
  } catch {
    // SQLite can still persist the value when localStorage is unavailable.
  }
  return token;
}

function clearNativeOperationPending(key: string, token: string): void {
  try {
    const marker = pendingMarkerKey(key);
    // A newer queued write owns a different token and must keep its marker.
    if (localStorage.getItem(marker) === token) localStorage.removeItem(marker);
  } catch {
    // The marker is only a recovery aid for the localStorage cache.
  }
}

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
  // Version 10 adds durable queued follow-up turns, provider-handoff
  // provenance, and an in-progress handoff draft. These stores are empty by
  // default, so no eager rewrite is required.
  // Version 11 adds frozen cross-provider delegation policies and parent/child
  // ownership records. They are optional and likewise need no eager rewrite.
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
  // never finish after and overwrite a newer value. The marker survives a
  // renderer/app crash and tells the next launch that localStorage is newer
  // than SQLite and must be replayed rather than overwritten.
  const token = markNativeOperationPending(key);
  queueNativeStateOperation(key, async () => {
    await invoke("state_write", { key, value });
    clearNativeOperationPending(key, token);
  });
}

export function removeStoredValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // The native mirror can still remove the durable value.
  }
  const token = markNativeOperationPending(key);
  queueNativeStateOperation(key, async () => {
    await invoke("state_delete", { key });
    clearNativeOperationPending(key, token);
  });
}

export async function hydrateNativeStorage(
  keys: readonly string[] = DURABLE_STORAGE_KEYS,
): Promise<void> {
  await Promise.all(
    keys.map(async (key) => {
      try {
        const marker = pendingMarkerKey(key);
        const pendingToken = localStorage.getItem(marker);
        if (pendingToken !== null) {
          const cached = localStorage.getItem(key);
          if (cached === null) {
            await invoke("state_delete", { key });
            clearNativeOperationPending(key, pendingToken);
            return;
          }
          try {
            await invoke("state_write", { key, value: JSON.parse(cached) });
            clearNativeOperationPending(key, pendingToken);
            return;
          } catch (error) {
            // Keep a valid pending marker for the next launch if the replay
            // failed. Invalid JSON cannot be replayed, so fall through to the
            // durable value instead of leaving hydration permanently wedged.
            try {
              JSON.parse(cached);
              throw error;
            } catch (parseError) {
              if (parseError === error) throw error;
              localStorage.removeItem(marker);
            }
          }
        }
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

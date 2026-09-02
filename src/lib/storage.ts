import { invoke } from "@tauri-apps/api/core";
import { boundThreadPreview } from "./threadPreview";

export const DURABLE_STORAGE_KEYS = [
  "kiwi.schemaVersion",
  "kiwi.projects",
  "kiwi.workspaceMode",
  "kiwi.settings",
  "kiwi.headerUsageWindows",
  "kiwi.threadProjects",
  "kiwi.threadWorktrees",
  "kiwi.knownThreads",
  "kiwi.threadModels",
  "kiwi.threadReasoning",
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
  "kiwi.removedSkills",
  "kiwi.drafts",
  "kiwi.scheduleRuns",
  "kiwi.workflows",
  "kiwi.workflowRuns",
  "kiwi.costLedger",
  "kiwi.usageLedger",
  "kiwi.modelPricingCatalog",
  "kiwi.paneSizes",
  "kiwi.sidebarSplitRatio",
  "kiwi.queuedTurns",
  "kiwi.threadHandoffs",
  "kiwi.pendingHandoff",
  "kiwi.childAgentPolicies",
  "kiwi.childAgentLinks",
  "kiwi.nativeAgentLinks",
  "kiwi.threadSubagentCapabilities",
  "kiwi.onboardingVersion",
  "kiwi.modelFavorites",
] as const;

/**
 * Bump when any kiwi.* value changes shape, and add a corresponding step in
 * migrateStorage. Old installs then upgrade their data instead of loading
 * garbage into the new code.
 */
export const STORAGE_SCHEMA_VERSION = 20;
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
  // Version 12 records the sub-agent capability config last applied to each
  // runtime thread, and the app-server instance it was applied to, so a
  // renderer reload can still tell a real on/off change from a restarted
  // runtime that is holding nothing at all.
  // Version 13 adds the last validated model-pricing catalog snapshot so the
  // app has current forward-looking estimates even when a later launch is offline.
  // Version 14 adds per-thread reasoning and removes the three legacy bundled
  // prompt profiles. User-created profiles and the currently selected prompt
  // text are preserved.
  if (stored < 14) {
    const legacyProfileIds = new Set(["empty", "concise", "reviewer"]);
    const profiles = loadStored<Array<{ id?: string; builtIn?: boolean }>>("kiwi.promptProfiles", []);
    const userProfiles = profiles.filter((profile) => !profile.builtIn && !legacyProfileIds.has(profile.id ?? ""));
    if (userProfiles.length !== profiles.length) storeValue("kiwi.promptProfiles", userProfiles);
    const settings = loadStored<Record<string, unknown>>("kiwi.settings", {});
    if (legacyProfileIds.has(String(settings.promptProfileId ?? ""))) {
      storeValue("kiwi.settings", { ...settings, promptProfileId: "" });
    }
  }
  // Version 15 persists provider-native sub-agent ownership so their durable
  // Codex threads remain browsable and depth-limited after a renderer reload.
  // Version 16 stops treating cumulative provider usage as current context.
  // The old field cannot be distinguished from a real latest-request value,
  // so clear only that derived value and preserve the full token/cost ledger.
  if (stored < 16) {
    const records = loadStored<Array<Record<string, unknown>>>("kiwi.usageLedger", []);
    if (Array.isArray(records) && records.length) {
      const withoutLegacyContext = (value: unknown): unknown => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const next = { ...(value as Record<string, unknown>) };
        delete next.contextTokens;
        return next;
      };
      storeValue("kiwi.usageLedger", records.map((record) => ({
        ...record,
        usage: withoutLegacyContext(record.usage),
        ...(record.cumulativeSnapshot === undefined
          ? {}
          : { cumulativeSnapshot: withoutLegacyContext(record.cumulativeSnapshot) }),
      })));
    }
  }
  // Version 17 adds app-only skill removals. It starts empty and needs no
  // eager migration, but is mirrored natively with the other durable state.
  // Version 18 adds LM Studio as a persisted provider value. Existing
  // settings already merge with the current defaults, so no eager rewrite is
  // required.
  // Version 19 adds per-provider starred models. The store starts empty and
  // is sanitized on read, so no eager migration is required.
  // Version 20 removes accidentally retained turns from sidebar metadata and
  // bounds legacy previews. Canonical transcript messages live in provider
  // history and are not changed.
  if (stored < 20) {
    const index = loadStored<Record<string, unknown>>("kiwi.knownThreads", {});
    let changed = false;
    const compacted = Object.fromEntries(Object.entries(index).map(([threadId, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [threadId, value];
      const next = { ...(value as Record<string, unknown>) };
      if ("turns" in next) {
        delete next.turns;
        changed = true;
      }
      if (typeof next.preview === "string") {
        const preview = boundThreadPreview(next.preview);
        if (preview !== next.preview) {
          next.preview = preview;
          changed = true;
        }
      }
      return [threadId, next];
    }));
    if (changed) storeValue("kiwi.knownThreads", compacted);
  }
  // All other additions are optional and require no eager rewrite of existing records.
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

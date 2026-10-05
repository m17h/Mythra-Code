import { invoke, isTauri } from "@tauri-apps/api/core";
import { boundThreadPreview } from "./threadPreview";
import { STARTUP_DATA_KEYS, validateStartupData } from "./startupData";

export const DURABLE_STORAGE_KEYS = [
  "kiwi.schemaVersion",
  "kiwi.projects",
  "kiwi.workspaceMode",
  "kiwi.pinnedWorkspacesCollapsed",
  "kiwi.settings",
  "kiwi.runDiscovery",
  "kiwi.headerUsageWindows",
  "kiwi.threadProjects",
  "kiwi.threadWorktrees",
  "kiwi.threadPullRequests",
  "kiwi.gitAutoPublish",
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
  "kiwi.reviewFeedback",
  "kiwi.agentQuestions",
  "kiwi.scheduleRuns",
  "kiwi.workflows",
  "kiwi.workflowRuns",
  "kiwi.costLedger",
  "kiwi.usageLedger",
  "kiwi.usageHistory",
  "kiwi.modelPricingCatalog",
  "kiwi.officialModelPricing",
  "kiwi.paneSizes",
  "kiwi.sidebarSplitRatio",
  "kiwi.queuedTurns",
  "kiwi.newThreadTimedPrompts",
  "kiwi.threadHandoffs",
  "kiwi.pendingHandoff",
  "kiwi.childAgentPolicies",
  "kiwi.threadSubagentSettings",
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
export const STORAGE_SCHEMA_VERSION = 28;
const nativeWriteQueues = new Map<string, Promise<void>>();
const NATIVE_PENDING_PREFIX = "kiwi.nativePending.";
let nativeOperationSequence = 0;
// Keep a readable copy when the webview cache is full or unavailable. The
// observed cache value lets explicit external cache changes supersede it.
const uncachedValues = new Map<string, { cached: string | null; value: string | null }>();
// Native-only fallback must preserve physically unreadable pending records for
// the rest of this document, including migration writes and explicit updates.
const unreadableCacheKeys = new Set<string>();

function readCache(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function readCacheChecked(key: string): { ok: true; value: string | null } | { ok: false } {
  try { return { ok: true, value: localStorage.getItem(key) }; } catch { return { ok: false }; }
}

function cacheValue(key: string, value: string | null): boolean {
  if (unreadableCacheKeys.has(key)) {
    uncachedValues.set(key, { cached: null, value });
    return false;
  }
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    uncachedValues.delete(key);
    return true;
  } catch {
    uncachedValues.set(key, { cached: readCache(key), value });
    return false;
  }
}

export function resetStorageMemoryForTests(): void { uncachedValues.clear(); unreadableCacheKeys.clear(); }

function invalidatePendingMarker(key: string): void {
  if (unreadableCacheKeys.has(key)) return;
  try { localStorage.removeItem(pendingMarkerKey(key)); } catch { /* Cache unavailable. */ }
}

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

export function migrateStorage(readRaw: (key: string) => string | null = readStoredRaw): void {
  validateStartupData(readRaw);
  const loadMigrationStored = <T,>(key: string, fallback: T): T => {
    const raw = readRaw(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  };
  const stored = loadMigrationStored<number>("kiwi.schemaVersion", 0);
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
    const profiles = loadMigrationStored<Array<{ id?: string; builtIn?: boolean }>>("kiwi.promptProfiles", []);
    const userProfiles = profiles.filter((profile) => !profile.builtIn && !legacyProfileIds.has(profile.id ?? ""));
    if (userProfiles.length !== profiles.length) storeValue("kiwi.promptProfiles", userProfiles);
    const settings = loadMigrationStored<Record<string, unknown>>("kiwi.settings", {});
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
    const records = loadMigrationStored<Array<Record<string, unknown>>>("kiwi.usageLedger", []);
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
  // Version 21 adds optional provider usage subtotals and cost-only OpenRouter
  // receipts. Legacy usage remains authoritative and is interpreted on read;
  // no eager rewrite or guessed attribution is needed.
  // Version 22 sorts pinned projects ahead of unpinned ones in the stored
  // project order and adds the collapsed state of that pinned group. The order
  // is normalized on read and the new flag defaults to expanded, so no eager
  // rewrite is required.
  // Version 20 removes accidentally retained turns from sidebar metadata and
  // bounds legacy previews. Canonical transcript messages live in provider
  // history and are not changed.
  if (stored < 20) {
    const index = loadMigrationStored<Record<string, unknown>>("kiwi.knownThreads", {});
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
  // Version 23 adds optional per-thread GitHub PR links, independent of provider transcripts.
  // Version 25 adds an optional queued-turn editing hold. Missing means false;
  // sanitizeStoredQueuedTurns preserves true so reopening cannot send an unfinished edit.
  // Version 26 adds optional project setup/check commands and scoped feedback
  // drafts. Existing projects keep their single launch command unchanged.
  // kiwi.usageHistory (dated per-model usage detail) starts empty and is never
  // backfilled: earlier usage stays in the ledger as unallocated all-time usage.
  // kiwi.officialModelPricing (rates read from the providers' pricing pages)
  // likewise starts empty; the catalog and bundled rates apply until a check.
  // Version 27 adds the optional last successful model count to each official
  // pricing source. Older snapshots infer it until their next successful read.
  // Version 28 adds optional thread-local spawning switches. Missing entries
  // retain existing threads' legacy opt-ins; fresh threads explicitly store off.
  storeValue("kiwi.schemaVersion", STORAGE_SCHEMA_VERSION);
}

/** The current serialized value, including a write that could not fit in the
 * webview cache. Callers that cache parsed values must key on this value too. */
export function readStoredRaw(key: string): string | null {
  if (unreadableCacheKeys.has(key)) return uncachedValues.get(key)?.value ?? null;
  const cached = readCache(key);
  const uncached = uncachedValues.get(key);
  if (uncached && uncached.cached !== cached) uncachedValues.delete(key);
  return uncached && uncached.cached === cached ? uncached.value : cached;
}

export function loadStored<T>(key: string, fallback: T): T {
  try {
    const value = readStoredRaw(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function storeValue<T>(key: string, value: T): void {
  // Capture the exact revision now: callers such as drafts mutate their maps
  // while earlier writes are still queued.
  const serialized = JSON.stringify(value);
  const cached = cacheValue(key, serialized);
  const token = cached ? markNativeOperationPending(key) : null;
  if (!cached) invalidatePendingMarker(key);
  queueNativeStateOperation(key, async () => {
    await invoke("state_write", { key, value: JSON.parse(serialized) });
    if (token) clearNativeOperationPending(key, token);
  });
}

export function removeStoredValue(key: string): void {
  const cached = cacheValue(key, null);
  const token = cached ? markNativeOperationPending(key) : null;
  if (!cached) invalidatePendingMarker(key);
  queueNativeStateOperation(key, async () => {
    await invoke("state_delete", { key });
    if (token) clearNativeOperationPending(key, token);
  });
}

export async function hydrateNativeStorage(
  keys: readonly string[] = DURABLE_STORAGE_KEYS,
): Promise<void> {
  const hydrationWrites: Array<() => Promise<unknown>> = [];
  const startupSnapshot = new Map<string, string | null>();
  const nativeStartup = isTauri();
  let startupReadFailure: string | null = null;
  await Promise.all(
    keys.map(async (key) => {
      try {
        const marker = pendingMarkerKey(key);
        const markerRead = readCacheChecked(marker);
        const cachedRead = readCacheChecked(key);
        // Unknown pending ownership must not replace a readable cache record.
        // When the entire cache is inaccessible, native data can still be
        // used in memory without touching those unreadable recovery records.
        if (!markerRead.ok && (cachedRead.ok || !nativeStartup)) {
          startupReadFailure ??= key;
          return;
        }
        const cacheUnavailable = !markerRead.ok && !cachedRead.ok;
        if (cacheUnavailable) unreadableCacheKeys.add(key);
        const pendingToken = markerRead.ok ? markerRead.value : null;
        if (STARTUP_DATA_KEYS.has(key) && cachedRead.ok) startupSnapshot.set(key, cachedRead.value);
        const acceptNative = (raw: string) => {
          if (STARTUP_DATA_KEYS.has(key)) startupSnapshot.set(key, raw);
          if (cacheUnavailable) uncachedValues.set(key, { cached: null, value: raw });
          else cacheValue(key, raw);
        };
        if (pendingToken !== null) {
          // A pending deletion requires proven absence, not a read failure.
          if (!cachedRead.ok) {
            startupReadFailure ??= key;
            return;
          }
          const cached = cachedRead.value;
          if (cached === null) {
            hydrationWrites.push(async () => {
              await invoke("state_delete", { key });
              clearNativeOperationPending(key, pendingToken);
            });
            return;
          }
          try {
            const value: unknown = JSON.parse(cached);
            hydrationWrites.push(async () => {
              await invoke("state_write", { key, value });
              clearNativeOperationPending(key, pendingToken);
            });
            return;
          } catch {
            // Preserve invalid startup input for diagnosis; validation below
            // stops mounting without replaying or replacing the pending value.
            if (STARTUP_DATA_KEYS.has(key)) return;
            // Other stores retain their existing durable fallback behavior.
            localStorage.removeItem(marker);
          }
        }
        if (nativeStartup && STARTUP_DATA_KEYS.has(key)) {
          try {
            // Raw reads distinguish a saved JSON null from a missing row and
            // let validation reject malformed JSON without losing its bytes.
            const raw = await invoke<string | null>("state_read_raw", { key });
            if (raw !== null) {
              acceptNative(raw);
              return;
            }
          } catch {
            startupReadFailure ??= key;
            return;
          }
        } else {
          const nativeValue = await invoke<unknown | null>("state_read", { key });
          if (nativeValue !== null) {
            acceptNative(JSON.stringify(nativeValue));
            return;
          }
        }
        if (!cachedRead.ok && !cacheUnavailable && STARTUP_DATA_KEYS.has(key)) {
          startupReadFailure ??= key;
          return;
        }
        const legacy = cachedRead.ok ? cachedRead.value : null;
        if (STARTUP_DATA_KEYS.has(key)) startupSnapshot.set(key, legacy);
        if (legacy !== null) {
          const value: unknown = JSON.parse(legacy);
          hydrationWrites.push(() => invoke("state_write", { key, value }));
        }
      } catch {
        // Web-only development keeps using localStorage.
      }
    }),
  );
  // Custom key lists still validate all startup records. Production's durable
  // list already captured them above, including raw native values and pending
  // replay inputs; never reread those values during validation or migration.
  for (const key of STARTUP_DATA_KEYS) {
    if (startupSnapshot.has(key)) continue;
    const cached = readCacheChecked(key);
    if (!cached.ok) startupReadFailure ??= key;
    else startupSnapshot.set(key, cached.value);
  }
  if (startupReadFailure !== null) throw new Error(`Saved startup data could not be read (${startupReadFailure}).`);
  // Never replay, mirror, migrate, or mount malformed startup data. In
  // particular, defaults must not overwrite the original saved records.
  const readStartupSnapshot = (key: string): string | null => startupSnapshot.get(key) ?? null;
  validateStartupData(readStartupSnapshot);
  await Promise.all(hydrationWrites.map(async (write) => {
    try { await write(); } catch { /* Web-only development keeps using the cache. */ }
  }));
  migrateStorage(readStartupSnapshot);
}

import { useCallback, useSyncExternalStore } from "react";
import { cancelRunDiscovery, discoverRunCommand, type RunDiscoveryPreferences, type RunDiscoveryPurpose, type RunDiscoverySuggestion } from "../lib/runDiscovery";

interface DiscoveryEntry {
  /** Request identity of the in-flight worker, if any. */
  i: string | null;
  /** Request the user asked to stop; its late result must never save. */
  x: boolean;
  /** Request whose stop call is still awaiting confirmation. */
  y: boolean;
  s: RunDiscoverySuggestion | null;
  e: string;
}

const EMPTY: DiscoveryEntry = { i: null, x: false, y: false, s: null, e: "" };

/**
 * Workers live outside React, keyed by project folder. A discovery outlives
 * the popover and the project control itself, so switching projects, opening
 * Chats or collapsing the top bar no longer stops it. The result still saves
 * to the project that started it: the save callback is captured at start.
 */
const entries = new Map<string, DiscoveryEntry>();
const listeners = new Set<() => void>();
const scopeKey = (cwd: string | undefined, purpose: RunDiscoveryPurpose) => cwd ? JSON.stringify([purpose, cwd]) : undefined;
const read = (key?: string): DiscoveryEntry => (key && entries.get(key)) || EMPTY;
function update(key: string, patch: Partial<DiscoveryEntry>) {
  entries.set(key, { ...read(key), ...patch });
  listeners.forEach((listener) => listener());
}
const updateCurrent = (key: string, id: string, patch: Partial<DiscoveryEntry>) => {
  if (read(key).i === id) update(key, patch);
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook: forget every worker between cases. Live requests are not cancelled. */
export function resetRunCommandDiscoveries() {
  entries.clear();
  listeners.forEach((listener) => listener());
}

export function useRunCommandDiscovery(cwd?: string, lmStudioBaseUrl?: string, purpose: RunDiscoveryPurpose = "run") {
  const key = scopeKey(cwd, purpose);
  const entry = useSyncExternalStore(subscribe, () => read(key));
  const cancel = useCallback(async () => {
    if (!key) return;
    const entry = read(key);
    const id = entry.i;
    if (!id || entry.y) return;
    update(key, { y: true, x: true });
    try {
      await cancelRunDiscovery(id);
      updateCurrent(key, id, { i: null, e: "" });
    } catch (reason) { updateCurrent(key, id, { e: `Could not confirm discovery cleanup: ${reason}` }); }
    finally { if (read(key).y) update(key, { y: false }); }
  }, [key]);
  const discover = useCallback(async (preferences: RunDiscoveryPreferences, onFound?: (result: RunDiscoverySuggestion) => void) => {
    if (!cwd || !key || read(key).i) return;
    const id = crypto.randomUUID();
    update(key, { i: id, x: false, e: "", s: null });
    try {
      const result = await discoverRunCommand(id, cwd, preferences, lmStudioBaseUrl, purpose);
      const current = read(key);
      if (current.i === id && !current.x) {
        if (result.command.trim()) onFound?.(result);
        update(key, { s: result });
      }
    } catch (reason) {
      const current = read(key);
      if (current.i === id && !current.x) update(key, { e: `${reason}` });
    } finally {
      updateCurrent(key, id, { i: null });
    }

  }, [cwd, key, lmStudioBaseUrl, purpose]);
  const clearSuggestion = () => { if (key) update(key, { s: null }); };
  return { pending: Boolean(entry.i), suggestion: entry.s, unavailable: entry.s && !entry.s.command.trim() ? entry.s.explanation : "", error: entry.e, discover, cancel, clearSuggestion };
}

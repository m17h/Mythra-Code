import { useCallback, useSyncExternalStore } from "react";
import { cancelRunDiscovery, discoverRunCommand, type RunDiscoveryPreferences, type RunDiscoverySuggestion } from "../lib/runDiscovery";

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
const read = (cwd?: string): DiscoveryEntry => (cwd && entries.get(cwd)) || EMPTY;
function update(cwd: string, patch: Partial<DiscoveryEntry>) {
  entries.set(cwd, { ...read(cwd), ...patch });
  listeners.forEach((listener) => listener());
}
const updateCurrent = (cwd: string, id: string, patch: Partial<DiscoveryEntry>) => {
  if (read(cwd).i === id) update(cwd, patch);
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

export function useRunCommandDiscovery(cwd?: string, lmStudioBaseUrl?: string) {
  const entry = useSyncExternalStore(subscribe, () => read(cwd));
  const cancel = useCallback(async () => {
    if (!cwd) return;
    const entry = read(cwd);
    const id = entry.i;
    if (!id || entry.y) return;
    update(cwd, { y: true, x: true });
    try {
      await cancelRunDiscovery(id);
      updateCurrent(cwd, id, { i: null, e: "" });
    } catch (reason) { updateCurrent(cwd, id, { e: `Could not confirm discovery cleanup: ${reason}` }); }
    finally { if (read(cwd).y) update(cwd, { y: false }); }
  }, [cwd]);
  const discover = useCallback(async (preferences: RunDiscoveryPreferences, onFound?: (result: RunDiscoverySuggestion) => void) => {
    if (!cwd || read(cwd).i) return;
    const id = crypto.randomUUID();
    update(cwd, { i: id, x: false, e: "", s: null });
    try {
      const result = await discoverRunCommand(id, cwd, preferences, lmStudioBaseUrl);
      const current = read(cwd);
      if (current.i === id && !current.x) {
        onFound && onFound(result);
        update(cwd, { s: result });
      }
    } catch (reason) {
      const current = read(cwd);
      if (current.i === id && !current.x) update(cwd, { e: `${reason}` });
    } finally {
      updateCurrent(cwd, id, { i: null });
    }

  }, [cwd, lmStudioBaseUrl]);
  const clearSuggestion = () => { if (cwd) update(cwd, { s: null }); };
  return { pending: Boolean(entry.i), suggestion: entry.s, error: entry.e, discover, cancel, clearSuggestion };
}

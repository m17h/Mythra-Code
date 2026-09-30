import { useSyncExternalStore } from "react";

/**
 * Small per-checkout state that outlives a mounted panel.
 *
 * Dock tabs unmount their contents, and a read or mutation that finishes after
 * navigation must land in the checkout it was started for — never in whatever
 * checkout happens to be on screen. Entries are bounded; the least recently
 * written scope is dropped first.
 */
export interface ScopedStore<T> {
  get: (scope: string) => T;
  update: (scope: string, patch: Partial<T> | ((current: T) => Partial<T>)) => void;
  subscribe: (listener: () => void) => () => void;
  clear: () => void;
}

export function createScopedStore<T extends object>(initial: T, limit = 16): ScopedStore<T> {
  const entries = new Map<string, T>();
  const listeners = new Set<() => void>();
  const empty = Object.freeze({ ...initial }) as T;
  return {
    get: (scope) => entries.get(scope) ?? empty,
    update: (scope, patch) => {
      const current = entries.get(scope) ?? empty;
      const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      entries.delete(scope);
      entries.set(scope, next);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear: () => {
      entries.clear();
      listeners.forEach((listener) => listener());
    },
  };
}

export function useScopedStore<T extends object>(store: ScopedStore<T>, scope: string): T {
  return useSyncExternalStore(store.subscribe, () => store.get(scope), () => store.get(scope));
}

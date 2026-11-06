import { useCallback, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { deferUntilRemoteStateAdopted, loadStored, storeValue, subscribeRemoteStateAdoption } from "../lib/storage";

export type PersistedUpdate<T> = T | ((current: T) => T);
export type SetPersisted<T> = (update: PersistedUpdate<T>) => void;
/** Rebase a direct local edit captured during a remote commit over its adoption. */
export function rebasePersistedIntent(base: unknown, next: unknown, adopted: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(next)) return adopted;
  if (Array.isArray(base) && Array.isArray(next) && Array.isArray(adopted)
    && [...base, ...next, ...adopted].every((row) => row && typeof row === "object" && typeof row.id === "string")) {
    const before = new Map(base.map((row) => [row.id, row]));
    const after = new Map(next.map((row) => [row.id, row]));
    const latest = new Map(adopted.map((row) => [row.id, row]));
    for (const key of before.keys()) if (!after.has(key)) latest.delete(key);
    for (const [key, value] of after) latest.set(key, before.has(key) ? rebasePersistedIntent(before.get(key), value, latest.get(key)) : value);
    const order = next.map((row) => row.id);
    return [...order.map((id) => latest.get(id)), ...[...latest].filter(([id]) => !order.includes(id)).map(([, row]) => row)].filter(Boolean);
  }
  if (base && next && adopted && !Array.isArray(base) && !Array.isArray(next) && !Array.isArray(adopted)
    && typeof base === "object" && typeof next === "object" && typeof adopted === "object") {
    const a = base as Record<string, unknown>, b = next as Record<string, unknown>, result = { ...adopted } as Record<string, unknown>;
    for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) delete result[key];
    for (const key of Object.keys(b)) result[key] = rebasePersistedIntent(a[key], b[key], result[key]);
    return result;
  }
  return next;
}

export interface PersistedStateOptions<T> {
  /**
   * Maps the stored value (or default) exactly once on mount. `load()` reads
   * storage lazily so callers can normalize legacy data — or ignore it and
   * return a value computed elsewhere (e.g. module-level app settings).
   */
  init?: (load: () => T) => T;
  /**
   * Shapes what is written to storage; React state keeps the full value.
   * Used by callers that persist a compacted form of their records.
   */
  serialize?: (value: T) => unknown;
}

/**
 * `useState` + `storeValue` in one place: every write through the returned
 * setter also persists under `key`. Functional updates read the latest
 * committed value (via an internal ref), so persisted state can be updated
 * from stale closures without losing writes. Identity-equal updates are
 * dropped entirely — no re-render and no redundant storage write.
 *
 * Storage is only read lazily inside the state initializer, never at module
 * scope, so importing a caller stays safe before hydrateNativeStorage runs.
 */
export function usePersistedStateRef<T>(
  key: string,
  defaultValue: T,
  options?: PersistedStateOptions<T>,
): [T, SetPersisted<T>, MutableRefObject<T>] {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [value, setValue] = useState<T>(() => {
    const load = () => loadStored(key, defaultValue);
    return options?.init ? options.init(load) : load();
  });
  const ref = useRef(value);
  useLayoutEffect(() => subscribeRemoteStateAdoption(key, (adopted) => {
    ref.current = adopted as T;
    setValue(adopted as T);
  }), [key]);
  const setPersisted = useCallback<SetPersisted<T>>(
    (update) => {
      const base = ref.current;
      if (deferUntilRemoteStateAdopted(key, () => setPersisted(typeof update === "function" ? update
        : rebasePersistedIntent(base, update, ref.current) as T))) return;
      const next = typeof update === "function"
        ? (update as (current: T) => T)(ref.current)
        : update;
      if (Object.is(next, ref.current)) return;
      ref.current = next;
      setValue(next);
      const serialize = optionsRef.current?.serialize;
      storeValue(key, serialize ? serialize(next) : next);
    },
    [key],
  );
  return [value, setPersisted, ref];
}

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  options?: PersistedStateOptions<T>,
): [T, SetPersisted<T>] {
  const [value, setPersisted] = usePersistedStateRef(key, defaultValue, options);
  return [value, setPersisted];
}

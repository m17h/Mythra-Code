import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { loadStored, storeValue } from "../lib/storage";

export type PersistedUpdate<T> = T | ((current: T) => T);
export type SetPersisted<T> = (update: PersistedUpdate<T>) => void;

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
  const setPersisted = useCallback<SetPersisted<T>>(
    (update) => {
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

export interface ModelRefreshState<T> {
  pending?: { key: string; kind: "routine" | "manual"; promise: Promise<T[]> };
  lastSuccess?: { key: string; at: number };
  error?: string;
}

/** A manual Codex read must run its guarded installed-runtime check even if a
 * routine non-restarting catalog read is already in flight. Other callers share
 * the same read. Clearing pending on identity change also cancels queued work. */
export function shareModelRefresh<T>(state: ModelRefreshState<T>, key: string, read: () => Promise<T[]>, kind: "routine" | "manual" = "routine"): Promise<T[]> {
  const previous = state.pending;
  if (previous?.key === key && (kind === "routine" || previous.kind === "manual")) return previous.promise;
  const start: Promise<T[]> = previous?.key === key
    ? previous.promise.then(() => state.pending?.promise === promise ? read() : [])
    : read();
  const promise: Promise<T[]> = start.then((models) => {
    if (state.pending?.promise === promise && models.length) state.lastSuccess = { key, at: Date.now() };
    return models;
  }).finally(() => { if (state.pending?.promise === promise) state.pending = undefined; });
  state.pending = { key, kind, promise };
  return promise;
}

export function modelCatalogRecentlyRefreshed(state: ModelRefreshState<unknown>, key: string, now = Date.now()): boolean {
  if (state.lastSuccess?.key !== key) return false;
  const age = now - state.lastSuccess.at;
  return age >= 0 && age < 30_000;
}

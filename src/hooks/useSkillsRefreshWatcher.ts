import { useCallback, useEffect, useRef } from "react";

interface Options {
  folder: string;
  /** The shortest cadence requested by the visible skill surfaces, or none. */
  pollMs: number | null;
  refresh: (silent: boolean) => Promise<unknown> | void;
  /** Explicit edits and initial warmup may already be scanning this library. */
  busy?: () => boolean;
}

/** App-owned watcher: surface changes adjust one timer, without competing scans. */
export function useSkillsRefreshWatcher(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef(new Set<string>());
  const lastStarted = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const request = useCallback((silent: boolean) => {
    const current = latest.current;
    if (!current.folder || document.hidden || pending.current.has(current.folder) || current.busy?.()) return;
    // A focus/visibility pair or a surface change immediately after a read
    // describes the same freshness request. Explicit library actions stay direct.
    if (Date.now() - (lastStarted.current.get(current.folder) ?? -Infinity) < 250) return;
    const folder = current.folder;
    const active = pending.current;
    active.add(folder);
    lastStarted.current.set(folder, Date.now());
    void Promise.resolve().then(() => {
      // A folder switch before the microtask must not invoke an old callback.
      if (mounted.current && !document.hidden && latest.current.folder === folder && !latest.current.busy?.()) return latest.current.refresh(silent);
    }).catch(() => {}).finally(() => active.delete(folder));
  }, []);

  useEffect(() => {
    if (!options.folder) return;
    // Focus refreshes retain invocation/library freshness even when no skill
    // surface is open; only periodic work depends on the visible surface.
    const focus = () => request(true);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [options.folder, request]);

  useEffect(() => {
    if (!options.folder || options.pollMs === null) return;
    request(false);
    const timer = window.setInterval(() => request(true), options.pollMs);
    return () => window.clearInterval(timer);
  }, [options.folder, options.pollMs, request]);
}

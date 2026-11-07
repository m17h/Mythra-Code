import { useCallback, useEffect, useRef, useState } from "react";
import { hostRead, hostRows } from "../../lib/remote/remoteActions";
import type { WireParityReadResult, WireParityRow } from "../../lib/remote/wire";

const RECHECK_MS = 5_000;
const LIVE = new Set(["starting", "running"]);

/** A Run or Checks process belongs to one target, and the host knows best whether it
 * is still going. It may have been started before this view existed, or finished
 * without anyone here watching. Asks only while something is thought to be running. */
export function useRemoteCommand(device: string, op: "run.status" | "checks.status", target: { workspaceId?: string; threadId?: string }, connected: boolean) {
  const key = JSON.stringify(target);
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [latest, setLatest] = useState<Record<string, WireParityRow | undefined>>({});
  const handle = handles[key] ?? null;
  const reading = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const store = useCallback((forKey: string, next: string | null) => {
    setHandles(({ [forKey]: _previous, ...rest }) => next ? { ...rest, [forKey]: next } : rest);
  }, []);
  const refresh = useCallback(() => {
    if (!targetRef.current.workspaceId) return;
    const read = ++reading.current;
    hostRead<WireParityReadResult>(device, op, { ...targetRef.current }).then((result) => {
      if (read !== reading.current) return;
      const rows = hostRows(result);
      store(key, rows.find((row) => LIVE.has(row.status ?? ""))?.id ?? null);
      setLatest((current) => ({ ...current, [key]: rows[0] }));
    }, () => undefined);
  }, [device, key, op, store]);
  useEffect(() => { if (connected) refresh(); }, [connected, refresh]);
  useEffect(() => {
    if (!handle || !connected) return;
    const timer = setInterval(refresh, RECHECK_MS);
    return () => clearInterval(timer);
  }, [connected, handle, refresh]);
  return { handle, latest: latest[key], set: useCallback((next: string | null) => { reading.current += 1; store(key, next); }, [key, store]) };
}

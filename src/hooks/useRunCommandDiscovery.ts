import { useEffect, useRef, useState } from "react";
import { cancelRunDiscovery, discoverRunCommand, type RunDiscoveryPreferences, type RunDiscoverySuggestion } from "../lib/runDiscovery";

/** The worker outlives the popover, but never the selected project control. */
export function useRunCommandDiscovery(cwd?: string, lmStudioBaseUrl?: string) {
  const active = useRef<string | null>(null);
  const stopped = useRef<string | null>(null);
  const stopping = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [suggestion, setSuggestion] = useState<RunDiscoverySuggestion | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setPending(false); setSuggestion(null); setError("");
    return () => {
      const id = active.current;
      active.current = null;
      if (id) void cancelRunDiscovery(id).catch(() => {});
    };
  }, [cwd]);
  const cancel = async () => {
    const id = active.current;
    if (!id || stopping.current === id) return;
    stopping.current = id;
    stopped.current = id;
    try {
      await cancelRunDiscovery(id);
      if (stopped.current === id && (!active.current || active.current === id)) setError("");
      if (active.current === id) { active.current = null; setPending(false); }
    } catch (reason) { if (active.current === id) setError(`Could not confirm discovery cleanup: ${String(reason)}`); }
    finally { if (stopping.current === id) stopping.current = null; }
  };
  const discover = async (preferences: RunDiscoveryPreferences, onFound?: (result: RunDiscoverySuggestion) => void) => {
    if (!cwd || active.current) return;
    const id = crypto.randomUUID();
    active.current = id;
    stopped.current = null;
    setPending(true); setError(""); setSuggestion(null);
    try {
      const result = await discoverRunCommand(id, cwd, preferences, lmStudioBaseUrl);
      if (active.current === id && stopped.current !== id) {
        onFound?.(result);
        setSuggestion(result);
      }
    } catch (reason) {
      if (active.current === id && stopped.current !== id) setError(String(reason));
    } finally {
      if (active.current === id) { active.current = null; setPending(false); }
    }
  };
  return { pending, suggestion, error, discover, cancel, clearSuggestion: () => setSuggestion(null) };
}

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { hostRead, hostWrite } from "../../lib/remote/remoteActions";
import type { WireDiscoveryStatus } from "../../lib/remote/host/discoveryActions";
import type { CommandDiscoveryState, DiscoveredCommandSuggestion } from "../RunCommandDiscovery";

const RECHECK_MS = 2_000;
/** The host ends a search itself. These only stop this device asking forever. */
const LONGEST_MS = 20 * 60_000;
const MISSED_ANSWERS = 15;
type Purpose = "run" | "check";
interface Search { handle: string | null; stopped: boolean; suggestion: DiscoveredCommandSuggestion | null; error: string }
const IDLE: Search = { handle: null, stopped: false, suggestion: null, error: "" };

/** A search outlives the popover and the tab that started it, as it does locally. */
const searches = new Map<string, Search>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = (key: string) => searches.get(key) ?? IDLE;
const update = (key: string, patch: Partial<Search>) => { searches.set(key, { ...read(key), ...patch }); listeners.forEach((listener) => listener()); };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function follow(key: string, device: string, name: string, purpose: Purpose, target: { workspaceId: string; threadId?: string }, handle: string, onFound?: (result: DiscoveredCommandSuggestion) => void) {
  const current = () => read(key).handle === handle;
  const deadline = Date.now() + LONGEST_MS;
  let missed = 0;
  while (current()) {
    await wait(RECHECK_MS);
    if (!current()) return;
    let status: WireDiscoveryStatus;
    try {
      status = await hostRead<WireDiscoveryStatus>(device, `discovery.${purpose}.status`, { ...target, processHandle: handle });
      missed = 0;
    } catch {
      missed += 1;
      if (missed >= MISSED_ANSWERS) { if (current()) update(key, { handle: null, error: `Mythra Code lost track of this search on ${name}. Try again.` }); return; }
      continue;
    }
    if (!current()) return;
    if (status.state === "completed") {
      const stopped = read(key).stopped;
      update(key, { handle: null, suggestion: stopped ? null : status.discovery ?? { command: "", explanation: "" } });
      if (!stopped && status.discovery?.command.trim()) onFound?.(status.discovery);
      return;
    }
    if (status.state === "stopped") { update(key, { handle: null }); return; }
    if (status.state === "failed" || status.state === "uncertain") { update(key, { handle: null, error: status.message || `This search on ${name} didn't finish. Try again.` }); return; }
    if (Date.now() > deadline) { update(key, { handle: null, error: `This search on ${name} is taking too long. Try again.` }); return; }
  }
}

/** Find run command and Find checks, on the other machine with its own saved model. */
export function useRemoteDiscovery(device: string, name: string, purpose: Purpose, target: { workspaceId?: string; threadId?: string }, revision: string): CommandDiscoveryState {
  const { workspaceId, threadId } = target;
  const key = JSON.stringify([device, purpose, workspaceId ?? ""]);
  const search = useSyncExternalStore(subscribe, () => read(key));
  const discover = useCallback<CommandDiscoveryState["discover"]>(async (_preferences, onFound) => {
    if (!workspaceId || read(key).handle) return;
    const scope = { workspaceId, ...(threadId ? { threadId } : {}) };
    update(key, { handle: "starting", stopped: false, suggestion: null, error: "" });
    const outcome = await hostWrite<{ processHandle?: string }>(device, name, `discovery.${purpose}.start`, { ...scope, revision });
    const handle = outcome.ok ? outcome.result?.processHandle : undefined;
    if (!handle) { update(key, { handle: null, error: outcome.ok ? `This search on ${name} couldn't be confirmed. Try again.` : outcome.message }); return; }
    update(key, { handle });
    void follow(key, device, name, purpose, scope, handle, onFound);
  }, [device, key, name, purpose, revision, threadId, workspaceId]);
  const cancel = useCallback(async () => {
    const { handle } = read(key);
    if (!handle || handle === "starting" || !workspaceId) return;
    update(key, { stopped: true });
    const outcome = await hostWrite(device, name, `discovery.${purpose}.stop`, { workspaceId, ...(threadId ? { threadId } : {}), revision, runId: handle });
    if (read(key).handle !== handle) return;
    update(key, outcome.ok ? { handle: null, error: "" } : { error: outcome.message });
  }, [device, key, name, purpose, revision, threadId, workspaceId]);
  const clearSuggestion = useCallback(() => { update(key, { suggestion: null, error: "" }); }, [key]);
  return useMemo(() => ({ pending: Boolean(search.handle), suggestion: search.suggestion, error: search.error, discover, cancel, clearSuggestion }), [cancel, clearSuggestion, discover, search]);
}

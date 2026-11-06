import type { HostAttachResult, HostLeaseCheck, HostRequest, HostSubscribers, HostTick } from "../wire";
import { HostBridge, nativeHostTransport, type HostTransport } from "./bridge";
import { HostCatalog } from "./catalog";
import { HostDispatcher } from "./dispatcher";
import { HostHistory } from "./history";
import { HostPublishers } from "./publisher";
import { HostWindows } from "./window";
import type { HostSources } from "./scope";
import { HostReadError } from "./scope";
import type { RemoteWorkAdapter } from "./workTypes";
import type { QueuedTurn } from "../../taskStore";
import { reconcilePendingRequests } from "./pendingRequests";
import { reconcileRemoteStateCommits } from "./stateCommit";

export type { HostSources } from "./scope";
export { createRemoteWork } from "./workActions";
export type { RemoteWorkOptions, RemoteWorkLease, HostRowActions, HostSettingsActions } from "./workActions";
export type { HostContextSources } from "./hostContext";
export type { StopActionSources } from "./stopActions";
export type { HostParityActions } from "./parityActions";
export { createHostSettingsActions } from "./settingsActions";
export { applyHostExecutionPreferences, getHostThreadPreferences } from "./executionPreferences";
export { commitHostState, operationStamp } from "./stateCommit";
interface Session { generation: number; ready: boolean; bridge: HostBridge; publisher: HostPublishers; dispatcher: HostDispatcher; work?: RemoteWorkAdapter }

/** App mounts one controller after its own indexes/provider listeners are ready. */
export function createRemoteHost(sources: HostSources, transport: HostTransport = nativeHostTransport) {
  let disposed = false;
  let started = false;
  let session: Session | null = null;
  let attempt = 0;
  let attaching: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unlisten: Array<() => void> = [];
  const catalog = new HostCatalog(sources);
  const history = new HostHistory(sources);
  const windows = new HostWindows();
  const reset = () => {
    session?.work?.dispose();
    session?.dispatcher.dispose();
    session?.publisher.dispose();
    session = null;
    catalog.clear(); history.clear(); windows.clear();
  };
  const scheduleAttach = () => {
    if (disposed || retry) return;
    const delays = [1000, 2000, 5000, 10_000, 30_000];
    retry = setTimeout(() => { retry = undefined; void attach(); }, delays[Math.min(attempt++, delays.length - 1)]);
  };
  const lost = () => { if (disposed) return; reset(); scheduleAttach(); };
  const attach = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (attaching) return attaching;
    const work = (async () => {
      try {
        reset();
        const result = await transport.invoke<HostAttachResult>("remote_host_attach");
        if (disposed) return;
        const generation = result.generation;
        const isCurrent = () => !disposed && session?.generation === generation;
        const bridge = new HostBridge(generation, transport, isCurrent, () => { if (isCurrent()) lost(); });
        const publisher = new HostPublishers(sources, catalog, history, windows, bridge);
        const remoteWork = sources.createWork?.({ generation, isCurrent, findThread: (id) => catalog.thread(id),
          ensureHydrated: async (id, assertCurrent) => {
            assertCurrent();
            const thread = catalog.thread(id);
            if (!thread) throw new HostReadError("thread_unavailable", "This conversation is unavailable.");
            sources.rememberThread?.(thread);
            const binding = sources.getBindings()[id] || thread.cwd;
            await history.ensure({ thread, workspacePath: binding, assertCurrent });
            assertCurrent();
            if (history.availability(id) !== "ready") throw new HostReadError("host_unavailable", "This conversation's runtime ownership is recovering.");
          },
        });
        const dispatcher = new HostDispatcher(sources, catalog, history, windows, publisher, bridge, isCurrent, remoteWork, transport);
        session = { generation, ready: false, bridge, publisher, dispatcher, work: remoteWork };
        let reconciliationTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => { await reconcileRemoteStateCommits(); await sources.reconcile(isCurrent); history.requestRecovery(await reconcilePendingRequests(generation, isCurrent));
              if (isCurrent()) await remoteWork?.reconcileQueues(false); })(),
            new Promise<never>((_, reject) => { reconciliationTimer = setTimeout(() => reject(new Error("Host reconciliation timed out")), 15_000); }),
          ]);
        } finally { clearTimeout(reconciliationTimer); }
        if (disposed || session?.generation !== generation) return;
        await bridge.command("remote_host_ready");
        if (isCurrent()) session!.ready = true;
        if (isCurrent()) void remoteWork?.reconcileQueues().catch(() => undefined);
        attempt = 0;
      } catch { lost(); }
    })();
    attaching = work;
    void work.finally(() => {
      if (attaching === work) attaching = undefined;
      if (!disposed && !session) scheduleAttach();
    });
    return work;
  };
  async function start(): Promise<void> {
    if (started || disposed) return;
    started = true;
    try {
      const register = async <T>(name: string, callback: (payload: T) => void) => {
        const stop = await transport.listen<T>(name, callback);
        if (disposed) stop(); else unlisten.push(stop);
      };
      await register<HostRequest>("remote-host-request", (request) => {
        const current = session;
        // An expired individual request is not a lost renderer lease. The
        // bridge itself handles stale_generation without retiring a winner
        // because an older viewer request merely stopped waiting.
        if (current?.generation === request.generation) void current.dispatcher.dispatch(request).catch(() => undefined);
      });
      await register<HostLeaseCheck>("remote-host-lease-check", (check) => {
        const current = session;
        if (current?.generation === check.generation) void current.bridge.command("remote_host_renew", {}, true).catch(() => undefined);
      });
      await register<HostSubscribers>("remote-host-subscribers", (update) => {
        const current = session;
        if (current?.generation === update.generation) current.publisher.subscribers(update.threadId, update.count);
      });
      await register<HostTick>("remote-host-tick", (tick) => {
        const current = session;
        if (current?.generation !== tick.generation) return;
        try { current.publisher.tick(); }
        // Scope/removal changed. Reattach drops subscriptions before any more
        // output; viewers must prove access again rather than share a stale ring.
        catch { lost(); return; }
        void current.bridge.command("remote_host_tick_ack", { tickId: tick.tickId }, true).catch(() => undefined);
      });
      if (!disposed) await attach();
    } catch {
      for (const stop of unlisten.splice(0)) stop();
      started = false;
      if (!disposed) retry = setTimeout(() => { retry = undefined; void start(); }, 1000);
    }
  }
  return {
    start,
    isReady(): boolean { return session?.ready === true; },
    resolveQueued(entry: QueuedTurn) {
      if (!session?.work) return Promise.reject(new HostReadError("host_unavailable", "Remote queue delivery is not ready."));
      return session.work.resolveQueued(entry);
    },
    reconcileWorkQueues(): Promise<void> { return session?.work?.reconcileQueues() ?? Promise.resolve(); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(retry);
      for (const stop of unlisten.splice(0)) stop();
      reset();
    },
  };
}

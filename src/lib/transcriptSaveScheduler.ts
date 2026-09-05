interface PendingSave {
  revision: number;
  firstChangedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

/** Coalesce bursts while still persisting continuous output at least every
 * five seconds. Only the revision actually saved may release dirty history. */
export function createTranscriptSaveScheduler(options: {
  save: (threadId: string) => Promise<boolean>;
  dirty: (threadId: string, dirty: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Map<string, PendingSave>();
  const arm = (id: string, entry: PendingSave) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void drain(id).catch(options.onError);
    }, Math.max(0, Math.min(900, entry.firstChangedAt + 5_000 - Date.now())));
  };
  const drain = async (id: string): Promise<void> => {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.running) {
      await entry.running;
      return drain(id);
    }
    const revision = entry.revision;
    entry.firstChangedAt = Date.now();
    const running = Promise.resolve().then(async () => {
      if (!await options.save(id)) throw new Error(`Transcript ${id} is not available to save`);
      if (pending.get(id) === entry && entry.revision === revision) {
        pending.delete(id);
        options.dirty(id, false);
      }
    });
    entry.running = running;
    try { await running; }
    finally {
      entry.running = undefined;
      if (pending.get(id) === entry) {
        // Retry failed writes, and retain a newer revision which arrived while
        // this write was in flight. Avoid a tight loop after a slow failure.
        entry.firstChangedAt = Date.now();
        arm(id, entry);
      }
    }
  };
  const schedule = (id: string) => {
    const entry = pending.get(id) ?? { revision: 0, firstChangedAt: Date.now() };
    entry.revision += 1;
    pending.set(id, entry);
    options.dirty(id, true);
    if (!entry.running) arm(id, entry);
  };
  return {
    schedule,
    flush: async (id: string) => { schedule(id); await drain(id); },
    // Snapshot the pending work at close time. A still-running provider may
    // keep producing output; waiting for complete silence could block Quit.
    flushAll: async () => { await Promise.all([...pending.keys()].map(drain)); },
    dispose: () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
    cancel: (id: string) => {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
    },
  };
}

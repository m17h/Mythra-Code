interface RunningSave {
  revision: number;
  promise: Promise<void>;
}

interface PendingSave {
  revision: number;
  firstChangedAt: number;
  automaticFailures: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: RunningSave;
}

const COALESCE_DELAY_MS = 900;
const CONTINUOUS_SAVE_LIMIT_MS = 5_000;
const MAX_AUTOMATIC_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;

/** Coalesce bursts while still persisting continuous output at least every
 * five seconds. Automatic disk failures use a bounded retry budget; the dirty
 * entry remains available for an explicit flush after that budget is spent. */
export function createTranscriptSaveScheduler(options: {
  save: (threadId: string) => Promise<boolean>;
  dirty: (threadId: string, dirty: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Map<string, PendingSave>();

  const automaticRetryDelay = (failures: number) => Math.min(
    MAX_RETRY_DELAY_MS,
    COALESCE_DELAY_MS * (2 ** failures),
  );

  const arm = (id: string, entry: PendingSave, delay?: number) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void attempt(id, true).catch(options.onError);
    }, delay ?? Math.max(0, Math.min(
      COALESCE_DELAY_MS,
      entry.firstChangedAt + CONTINUOUS_SAVE_LIMIT_MS - Date.now(),
    )));
  };

  const attempt = (id: string, automatic: boolean): Promise<void> => {
    const entry = pending.get(id);
    if (!entry) return Promise.resolve();
    if (entry.running) return entry.running.promise;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const revision = entry.revision;
    const promise = Promise.resolve().then(async () => {
      let succeeded = false;
      try {
        if (!await options.save(id)) throw new Error(`Transcript ${id} is not available to save`);
        succeeded = true;
        entry.automaticFailures = 0;
        if (pending.get(id) === entry && entry.revision === revision) {
          pending.delete(id);
          options.dirty(id, false);
        }
      } catch (error) {
        if (automatic) entry.automaticFailures += 1;
        throw error;
      } finally {
        if (entry.running?.promise === promise) entry.running = undefined;
        if (pending.get(id) === entry && succeeded) {
          // A later revision stays dirty and receives its own coalesced save.
          entry.firstChangedAt = Date.now();
          arm(id, entry);
        } else if (pending.get(id) === entry && automatic && entry.automaticFailures < MAX_AUTOMATIC_ATTEMPTS) {
          arm(id, entry, automaticRetryDelay(entry.automaticFailures));
        }
      }
    });
    entry.running = { revision, promise };
    return promise;
  };

  /** Save only through the revision captured by the caller. Revisions arriving
   * later stay pending, so a live provider cannot make shutdown wait forever. */
  const flushThrough = async (id: string, targetRevision: number): Promise<void> => {
    let entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const running = entry.running;
    if (running) {
      await running.promise;
      if (running.revision >= targetRevision) return;
      entry = pending.get(id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    await attempt(id, false);
  };

  const schedule = (id: string) => {
    const entry = pending.get(id) ?? { revision: 0, firstChangedAt: Date.now(), automaticFailures: 0 };
    entry.revision += 1;
    pending.set(id, entry);
    options.dirty(id, true);
    if (entry.running || entry.automaticFailures >= MAX_AUTOMATIC_ATTEMPTS) return;
    // New output still coalesces normally, but it cannot shorten a failure
    // backoff that is already armed.
    if (entry.automaticFailures > 0 && entry.timer) return;
    arm(id, entry);
  };

  return {
    schedule,
    flush: async (id: string) => {
      schedule(id);
      const revision = pending.get(id)?.revision;
      if (revision !== undefined) await flushThrough(id, revision);
    },
    flushAll: async () => {
      const failed = new Map<string, unknown>();
      for (let pass = 0; pass < 3 && pending.size; pass++) {
        const snapshot = [...pending.entries()].filter(([id]) => !failed.has(id)).map(([id, entry]) => [id, entry.revision] as const);
        if (!snapshot.length) break;
        const results = await Promise.allSettled(snapshot.map(([id, revision]) => flushThrough(id, revision)));
        results.forEach((result, index) => { if (result.status === "rejected") failed.set(snapshot[index][0], result.reason); });
      }
      if (failed.size) throw new Error([...failed.values()].map(String).join("; "));
      // Never report a successful close flush while a final delta is unsaved.
      // Continuous output stays dirty and reaches the explicit discard choice.
      if (pending.size) throw new Error("Messages are still arriving. Stop active runs and retry closing to save them all.");
    },
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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Provider, Thread } from "../types";
import type { RunDiscoveryCatalogs } from "../lib/runDiscovery";
import { cleanThreadTitle, resolveThreadTitleModel } from "../lib/threadTitles";

interface Options {
  enabled: boolean;
  provider: Provider;
  model: string;
  catalogs: RunDiscoveryCatalogs;
  lmStudioBaseUrl: string;
  getThread: (id: string) => Thread | undefined;
  applyTitle: (id: string, title: string) => Promise<void>;
}
interface PreparedTitle { id: string; prompt: string; provider: Provider; model: string; lmStudioBaseUrl: string }
interface Job extends PreparedTitle { requestId: string; cancelled: boolean; applying?: Promise<void> }
const MAX_WAITING_TITLES = 16;
const MAX_SEEN_TITLES = 256;

function boundedPrompt(prompt: string): string {
  let result = "";
  let length = 0;
  for (const character of prompt) {
    if (length++ === 2000) break;
    result += character;
  }
  return result;
}

/** One short job at a time, only for explicitly submitted new conversations.
 * No mount scan, backfill, retry loop, transcript reads, or background polling. */
export function useAutomaticThreadTitles(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useRef<Job[]>([]);
  const prepared = useRef(new Map<string, PreparedTitle>());
  const active = useRef<Job | null>(null);
  const seen = useRef(new Set<string>());
  const alive = useRef(true);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const remember = useCallback((id: string) => {
    seen.current.add(id);
    if (seen.current.size <= MAX_SEEN_TITLES) return;
    const owned = new Set(queue.current.map((job) => job.id));
    if (active.current) owned.add(active.current.id);
    for (const candidate of seen.current) {
      if (seen.current.size <= MAX_SEEN_TITLES) break;
      if (!owned.has(candidate)) seen.current.delete(candidate);
    }
  }, []);
  const clearPending = useCallback((id: string) => {
    if (!alive.current) return;
    setPendingIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current); next.delete(id); return next;
    });
  }, []);
  // Reserve before the thread is exposed, but spend nothing until its first
  // message is accepted. This also covers slow checkpoints/provider startup.
  const prepareTitle = useCallback((id: string, prompt: string) => {
    const current = optionsRef.current;
    const thread = current.getThread(id);
    if (!alive.current || !current.enabled || !prompt.trim() || thread?.name?.trim() || seen.current.has(id)
      || prepared.current.has(id) || prepared.current.size + queue.current.length >= MAX_WAITING_TITLES) return;
    const model = resolveThreadTitleModel(current.provider, current.model, current.catalogs);
    if (!model) return;
    // Keep the provider selected when this first prompt was submitted. A later
    // settings change must not send an already reserved prompt elsewhere.
    prepared.current.set(id, { id, prompt: boundedPrompt(prompt), provider: current.provider, model, lmStudioBaseUrl: current.lmStudioBaseUrl });
    setPendingIds((pending) => pending.has(id) ? pending : new Set(pending).add(id));
  }, []);

  const cancel = useCallback(async (id: string) => {
    // Cancellation also owns reservations whose first turn is still starting.
    // Its late acceptance must not revive a title after a rename or opt-out.
    remember(id);
    prepared.current.delete(id);
    clearPending(id);
    queue.current = queue.current.filter((job) => job.id !== id);
    const job = active.current;
    if (job?.id !== id) return;
    job.cancelled = true;
    if (!job.applying) void invoke("run_discovery_cancel", { requestId: job.requestId }).catch(() => undefined);
    // A manual rename must be ordered after an already submitted name write.
    await job.applying?.catch(() => undefined);
  }, [clearPending, remember]);

  const pump = useCallback(async () => {
    if (active.current) return;
    while (alive.current && queue.current.length) {
      const job = queue.current.shift()!;
      const current = optionsRef.current;
      if (!current.enabled) { clearPending(job.id); continue; }
      const thread = current.getThread(job.id);
      if (!thread || thread.name?.trim()) { clearPending(job.id); continue; }
      active.current = job;
      try {
        const value = await invoke<unknown>("generate_thread_title", {
          options: { requestId: job.requestId, cwd: "", provider: job.provider, model: job.model,
            effort: job.provider === "openai" || job.provider === "claude" ? "low" : "default", fast: false,
            ...(job.provider === "lmstudio" ? { lmStudioBaseUrl: job.lmStudioBaseUrl } : {}) },
          prompt: job.prompt,
        });
        const latest = optionsRef.current;
        const title = cleanThreadTitle(value);
        const present = latest.getThread(job.id);
        if (alive.current && !job.cancelled && latest.enabled && title && present && !present.name?.trim()) {
          job.applying = latest.applyTitle(job.id, title);
          await job.applying;
        }
      } catch {
        // A convenience feature cannot block the user's turn or replace its error.
      } finally { clearPending(job.id); if (active.current === job) active.current = null; }
    }
  }, [clearPending]);

  const requestTitle = useCallback((id: string, prompt: string) => {
    if (!alive.current || seen.current.has(id)) return;
    if (!optionsRef.current.enabled || !prompt.trim()) {
      void cancel(id);
      return;
    }
    const reservation = prepared.current.get(id);
    prepared.current.delete(id);
    // Acceptance may arrive long after cancellation or an opt-out. Consume
    // only the original reservation: bounded deduplication can forget an old
    // ID, but must never recreate permission to send its prompt to a provider.
    // An accepted first prompt gets at most one attempt, even when the queue
    // or model configuration made this attempt ineligible.
    remember(id);
    const thread = optionsRef.current.getThread(id);
    if (!reservation || !thread || thread.name?.trim() || queue.current.length >= MAX_WAITING_TITLES) { clearPending(id); return; }
    queue.current.push({ ...reservation, requestId: crypto.randomUUID(), cancelled: false });
    void pump();
  }, [pump, clearPending, cancel, remember]);

  useEffect(() => {
    if (options.enabled) return;
    for (const id of prepared.current.keys()) remember(id);
    prepared.current.clear();
    queue.current = [];
    setPendingIds(new Set());
    if (active.current) void cancel(active.current.id);
  }, [options.enabled, cancel, remember]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      prepared.current.clear();
      queue.current = [];
      if (active.current) void cancel(active.current.id);
    };
  }, [cancel]);
  return { requestTitle, prepareTitle, cancel, pendingIds };
}

import { useCallback, useEffect, useRef } from "react";
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
interface Job { id: string; requestId: string; prompt: string; cancelled: boolean; applying?: Promise<void> }

/** One short job at a time, only for explicitly submitted new conversations.
 * No mount scan, backfill, retry loop, transcript reads, or background polling. */
export function useAutomaticThreadTitles(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queue = useRef<Job[]>([]);
  const active = useRef<Job | null>(null);
  const seen = useRef(new Set<string>());
  const alive = useRef(true);

  const cancel = useCallback(async (id: string) => {
    queue.current = queue.current.filter((job) => job.id !== id);
    const job = active.current;
    if (job?.id !== id) return;
    job.cancelled = true;
    if (!job.applying) void invoke("run_discovery_cancel", { requestId: job.requestId }).catch(() => undefined);
    // A manual rename must be ordered after an already submitted name write.
    await job.applying?.catch(() => undefined);
  }, []);

  const pump = useCallback(async () => {
    if (active.current) return;
    while (alive.current && queue.current.length) {
      const job = queue.current.shift()!;
      const current = optionsRef.current;
      if (!current.enabled) { queue.current = []; return; }
      const thread = current.getThread(job.id);
      const model = resolveThreadTitleModel(current.provider, current.model, current.catalogs);
      if (!thread || thread.name?.trim() || !model) continue;
      active.current = job;
      try {
        const value = await invoke<unknown>("generate_thread_title", {
          options: { requestId: job.requestId, cwd: "", provider: current.provider, model,
            effort: current.provider === "openai" || current.provider === "claude" ? "low" : "default", fast: false,
            ...(current.provider === "lmstudio" ? { lmStudioBaseUrl: current.lmStudioBaseUrl } : {}) },
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
      } finally { if (active.current === job) active.current = null; }
    }
  }, []);

  const requestTitle = useCallback((id: string, prompt: string) => {
    if (!optionsRef.current.enabled || !prompt.trim() || seen.current.has(id) || queue.current.length >= 16) return;
    seen.current.add(id);
    while (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!);
    queue.current.push({ id, requestId: crypto.randomUUID(), prompt: [...prompt].slice(0, 2000).join(""), cancelled: false });
    void pump();
  }, [pump]);

  useEffect(() => {
    if (options.enabled) return;
    queue.current = [];
    if (active.current) void cancel(active.current.id);
  }, [options.enabled, cancel]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
      if (active.current) void cancel(active.current.id);
    };
  }, [cancel]);
  return { requestTitle, cancel };
}

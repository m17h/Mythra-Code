import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Provider, Thread } from "../types";
import type { RunDiscoveryCatalogs } from "../lib/runDiscovery";
import type { PreferenceLearningScopeState, PreferenceSourceMessage } from "../lib/preferenceLearningTypes";
import { boundPreferenceSourceMessages, buildPreferenceAnalysisPayload, parsePreferenceAnalysis, resolvePreferenceLearningModel } from "../lib/preferenceLearning";
import { commitPreferenceAnalysis, getPreferenceLearningHydrated, getPreferenceLearningJob, getPreferenceLearningScope, loadPreferenceLearning, reservePreferenceLearningAnalysis, setPreferenceLearningJob, subscribePreferenceLearning } from "../lib/preferenceLearningStore";
import { PREFERENCE_HISTORY_LIMITS, preferenceCheckpointEntries, preferenceHistoryThreadEligible, preferenceSourceFingerprint, preferenceSourceId, readPreferenceHistoryPage } from "../lib/preferenceLearningHistory";
import { useTaskStore as taskStore } from "../lib/taskStore";

export interface PreferenceHistoryProgress {
  scopeKey: string; runId: string; status: "idle" | "reading" | "queued" | "analyzing" | "saving" | "complete" | "partial" | "cancelled" | "error";
  threads: number; pages: number; messages: number; skipped: number; limited: boolean; message?: string;
  changed?: boolean; superseded?: boolean; provider?: Provider; model?: string;
}
export interface PreferenceLearningOptions {
  catalogs: RunDiscoveryCatalogs; lmStudioBaseUrl: string;
  getThread: (id: string) => Thread | undefined;
  getProjectId: (thread: Thread) => string | null | undefined;
  isEligibleThread: (thread: Thread) => boolean;
  isScopeValid?: (scopeKey: string) => boolean;
  getHistoryThreads?: (scopeKey: string) => Thread[] | Promise<Thread[]>;
  onUpdated: (scopeKey: string) => void;
  /** Test seam; production waits for the conversation to settle for one minute. */
  debounceMs?: number;
}
interface Source extends PreferenceSourceMessage { threadId: string; messageId?: string; transcriptFingerprint?: string }
interface Receipt { id: string; text: string; capturedAt: number; transcriptFingerprint: string; scopeKeys: string[] }
interface Job { scopeKey: string; requestId: string; sources: Source[]; history: boolean; historyRunId?: string; cancelled: boolean; revision?: number; readyAt: number }
interface HistoryRun { scopeKey: string; id: string; cancelled: boolean; settingsInvalidated?: boolean; progress: PreferenceHistoryProgress }

/** Future authored submissions only; mounted/hydrated task histories are never scanned. */
export function usePreferenceLearning(options: PreferenceLearningOptions) {
  const opts = useRef(options); opts.current = options;
  const alive = useRef(true);
  const receipts = useRef(new Map<string, Receipt[]>());
  const queue = useRef<Job[]>([]);
  const active = useRef<Job | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scopes = useRef(new Map<string, PreferenceLearningScopeState>());
  const ownWrites = useRef(new Set<string>());
  const historyRun = useRef<HistoryRun | null>(null);
  const discoveredThreads = useRef(new Map<string, Thread>());
  const collectCompleted = useRef<((threadId: string) => void) | null>(null);
  const [historyProgress, setHistoryProgress] = useState<PreferenceHistoryProgress | null>(null);
  const updateHistory = useCallback((runId: string | undefined, patch: Partial<PreferenceHistoryProgress>) => {
    const run = historyRun.current;
    if (!alive.current || !runId || run?.id !== runId) return;
    run.progress = { ...run.progress, ...patch };
    setHistoryProgress(run.progress);
    if (["complete", "partial", "error", "cancelled"].includes(run.progress.status)) {
      run.cancelled = run.progress.status === "cancelled";
      historyRun.current = null;
    }
  }, []);
  const finishHistory = useCallback((job: Job, outcome: "saved" | "empty" | "error" | "cancelled", message?: string, changed = false) => {
    const run = historyRun.current;
    if (!job.historyRunId || run?.id !== job.historyRunId) return;
    const status = outcome === "saved" || outcome === "empty" ? run.progress.limited || run.progress.skipped ? "partial" : "complete" : outcome;
    updateHistory(job.historyRunId, { status, ...(outcome === "empty" ? { messages: 0 } : {}), changed: outcome === "saved" || outcome === "empty" ? changed : undefined,
      message: message ?? (outcome === "empty" ? "No new eligible authored messages were found in this bounded history pass."
        : changed ? "History analysis complete. Learned preferences were updated." : "History analysis complete. No changes were needed.") });
  }, [updateHistory]);
  const validScope = useCallback((scopeKey: string) => getPreferenceLearningHydrated() && (opts.current.isScopeValid?.(scopeKey) ?? true), []);
  const belongs = useCallback((scopeKey: string, threadId: string) => {
    const thread = opts.current.getThread(threadId) ?? discoveredThreads.current.get(threadId);
    return Boolean(thread && preferenceHistoryThreadEligible(thread) && opts.current.isEligibleThread(thread)
      && (scopeKey === "app" || scopeKey === `project:${opts.current.getProjectId(thread) ?? ""}`));
  }, []);
  const cancelScope = useCallback((scopeKey: string, settingsInvalidated = false) => {
    // Once dispatched, the native CAS is atomic and cannot be unsent. Keep its
    // truthful saving/result state; settings mutations still invalidate it.
    const finishingSave = historyRun.current?.scopeKey === scopeKey && historyRun.current.progress.status === "saving";
    if (!settingsInvalidated && finishingSave) return;
    if (finishingSave && historyRun.current) historyRun.current.settingsInvalidated = true;
    const historyRunId = historyRun.current?.scopeKey === scopeKey ? historyRun.current.id
      : active.current?.scopeKey === scopeKey ? active.current.historyRunId : undefined;
    // A cancelled/cleared consent window cannot revive an earlier submission,
    // including enable/clear transitions within the same millisecond.
    for (const entries of receipts.current.values()) {
      for (const receipt of entries) receipt.scopeKeys = receipt.scopeKeys.filter((key) => key !== scopeKey);
    }
    const timer = timers.current.get(scopeKey); if (timer) clearTimeout(timer);
    timers.current.delete(scopeKey);
    queue.current = queue.current.filter((job) => job.scopeKey !== scopeKey);
    if (historyRun.current?.scopeKey === scopeKey && !finishingSave) {
      historyRun.current.cancelled = true;
      updateHistory(historyRun.current.id, { status: "cancelled", message: "History analysis cancelled." });
    }
    const job = active.current;
    if (job?.scopeKey === scopeKey && !job.cancelled && !finishingSave) {
      job.cancelled = true;
      void invoke("run_discovery_cancel", { requestId: job.requestId }).catch(() => undefined);
    }
    if (!finishingSave && getPreferenceLearningJob(scopeKey).status !== "idle") setPreferenceLearningJob(scopeKey, { status: "idle", historyRunId });
  }, [updateHistory]);
  const currentJob = useCallback((job: Job, revision?: number) => alive.current && !job.cancelled && validScope(job.scopeKey)
    && getPreferenceLearningScope(job.scopeKey).enabled
    && (revision === undefined || getPreferenceLearningScope(job.scopeKey).revision === revision)
    && job.sources.every((source) => belongs(job.scopeKey, source.threadId)
      && (job.history || source.role !== "user" || taskStore.getState().tasks[source.threadId]?.messages.some((message) =>
        message.role === "user" && (message.id === source.messageId || message.clientMessageId === source.messageId)
        && message.turnStatus === "completed"
        && preferenceSourceFingerprint({ id: "", role: "user", text: message.text }) === source.transcriptFingerprint))), [validScope, belongs]);

  const pump = useCallback(async () => {
    if (active.current) return;
    while (alive.current && queue.current.length) {
      const nextIndex = queue.current.findIndex((job) => job.readyAt <= Date.now());
      if (nextIndex < 0) return;
      const job = queue.current.splice(nextIndex, 1)[0];
      active.current = job;
      try {
        if (!currentJob(job)) { finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed."); continue; }
        let state = getPreferenceLearningScope(job.scopeKey);
        const sourceById = new Map(job.sources.map((source) => [source.id, source]));
        const candidates = job.sources.filter((source) => source.role === "assistant"
          || !preferenceCheckpointEntries(state.checkpoints[source.threadId]).includes(preferenceSourceFingerprint(source)));
        const payload = buildPreferenceAnalysisPayload(boundPreferenceSourceMessages(candidates), state.markdown);
        const bounded = (JSON.parse(payload) as { messages: PreferenceSourceMessage[] }).messages;
        const userSources = bounded.filter((source) => source.role === "user");
        if (!userSources.length) { finishHistory(job, "empty"); continue; }
        const model = resolvePreferenceLearningModel(state.provider, state.model, opts.current.catalogs);
        if (!model) {
          setPreferenceLearningJob(job.scopeKey, { status: "error", historyRunId: job.historyRunId, message: "Select an available learning model." });
          finishHistory(job, "error", "Select an available learning model before analyzing history."); continue;
        }
        updateHistory(job.historyRunId, { provider: state.provider, model });
        ownWrites.current.add(job.scopeKey);
        const reserved = await reservePreferenceLearningAnalysis(job.scopeKey, state.revision);
        ownWrites.current.delete(job.scopeKey);
        if (!reserved) {
          if (currentJob(job)) {
            setPreferenceLearningJob(job.scopeKey, { status: "error", historyRunId: job.historyRunId, message: "Learning paused: daily request limit reached or settings changed." });
            finishHistory(job, "error", "History analysis paused: daily request limit reached or settings changed.");
          } else finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed.");
          continue;
        }
        state = reserved; job.revision = state.revision; scopes.current.set(job.scopeKey, state);
        if (!currentJob(job, state.revision)) { finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed."); continue; }
        updateHistory(job.historyRunId, { status: "analyzing", message: "Analyzing recent conversations…" });
        setPreferenceLearningJob(job.scopeKey, { status: "running", historyRunId: job.historyRunId, startedAt: Date.now(), message: job.history ? "Analyzing recent past conversations…" : "Learning from your completed conversation…" });
        const response = await invoke<unknown>("analyze_user_preferences", { options: {
          requestId: job.requestId, cwd: "", provider: state.provider, model, effort: state.provider === "openai" || state.provider === "claude" ? "low" : "default", fast: false,
          ...(state.provider === "lmstudio" ? { lmStudioBaseUrl: opts.current.lmStudioBaseUrl } : {}),
        }, payload });
        if (!currentJob(job, state.revision)) { finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed."); continue; }
        const preferences = parsePreferenceAnalysis(response, bounded, state.markdown);
        const checkpoints: Record<string, string> = {};
        for (const message of userSources) {
          const threadId = sourceById.get(message.id)!.threadId;
          const tokens = [...preferenceCheckpointEntries(checkpoints[threadId] ?? state.checkpoints[threadId]), preferenceSourceFingerprint(message)];
          // Native values are bounded at 2,000 characters. Retain newest IDs.
          while (tokens.length > 64 || JSON.stringify(tokens).length > 2000) tokens.shift();
          checkpoints[threadId] = JSON.stringify([...new Set(tokens)]);
        }
        if (!currentJob(job, state.revision)) { finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed."); continue; }
        updateHistory(job.historyRunId, { status: "saving", message: "Saving learned preferences…" });
        ownWrites.current.add(job.scopeKey);
        const committed = await commitPreferenceAnalysis(job.scopeKey, state.revision, preferences, checkpoints);
        ownWrites.current.delete(job.scopeKey);
        scopes.current.set(job.scopeKey, committed.state);
        if (committed.saved && job.historyRunId) {
          const superseded = Boolean(historyRun.current?.settingsInvalidated || !committed.committed || !currentJob(job, committed.state.revision));
          updateHistory(job.historyRunId, { superseded });
          finishHistory(job, "saved", superseded ? "History analysis was saved. Review the latest settings and preferences before continuing." : undefined, committed.changed);
          if (!superseded && committed.changed) opts.current.onUpdated(job.scopeKey);
        } else if (committed.committed && currentJob(job, committed.state.revision)) {
          if (committed.changed) opts.current.onUpdated(job.scopeKey);
        } else if (!committed.committed && currentJob(job)) {
          setPreferenceLearningJob(job.scopeKey, { status: "error", historyRunId: job.historyRunId, message: "Preferences changed before analysis could be saved." });
          finishHistory(job, "error", "History analysis could not be saved. Your saved preferences were kept.");
        } else finishHistory(job, "cancelled", "History analysis cancelled because its sources or settings changed.");
      } catch {
        if (alive.current && !job.cancelled) {
          setPreferenceLearningJob(job.scopeKey, { status: "error", historyRunId: job.historyRunId, message: "Preference analysis failed. Your saved preferences were kept." });
          finishHistory(job, "error", "History analysis failed. Your saved preferences were kept.");
        }
      } finally {
        ownWrites.current.delete(job.scopeKey);
        if (alive.current && !job.cancelled && getPreferenceLearningJob(job.scopeKey).status !== "error") {
          const pending = queue.current.find((queued) => queued.scopeKey === job.scopeKey);
          setPreferenceLearningJob(job.scopeKey, { status: pending ? "queued" : "idle", historyRunId: pending ? pending.historyRunId : job.historyRunId });
        }
        if (active.current === job) active.current = null;
      }
    }
  }, [currentJob, finishHistory, updateHistory]);

  const enqueue = useCallback((scopeKey: string, sources: Source[], historyRunId?: string) => {
    const history = Boolean(historyRunId);
    if (!validScope(scopeKey) || !getPreferenceLearningScope(scopeKey).enabled || !sources.some((source) => source.role === "user")) return false;
    const existing = queue.current.find((job) => job.scopeKey === scopeKey && !job.history && !history);
    if (existing) { existing.sources = [...new Map([...existing.sources, ...sources].map((source) => [source.id, source])).values()].slice(-80); existing.readyAt = Date.now() + (opts.current.debounceMs ?? 60_000); }
    else {
      if (queue.current.length + Number(Boolean(active.current)) >= 8) {
        setPreferenceLearningJob(scopeKey, { status: "error", historyRunId, message: "Learning queue is full; this conversation was skipped." });
        updateHistory(historyRunId, { status: "error", message: "Learning queue is full. History analysis was not submitted; try again after pending learning finishes." });
        return false;
      }
      queue.current.push({ scopeKey, requestId: crypto.randomUUID(), sources, history, historyRunId, cancelled: false, readyAt: history ? Date.now() : Date.now() + (opts.current.debounceMs ?? 60_000) });
    }
    scopes.current.set(scopeKey, getPreferenceLearningScope(scopeKey));
    if (!active.current || active.current.scopeKey !== scopeKey) setPreferenceLearningJob(scopeKey, { status: "queued", historyRunId });
    if (history) { updateHistory(historyRunId, { status: "queued", message: "Waiting to analyze recent conversations…" }); void pump(); return true; }
    const previous = timers.current.get(scopeKey); if (previous) clearTimeout(previous);
    timers.current.set(scopeKey, setTimeout(() => { timers.current.delete(scopeKey); void pump(); }, opts.current.debounceMs ?? 60_000));
    return true;
  }, [validScope, pump, updateHistory]);

  const captureUserPrompt = useCallback((threadId: string, messageId: string, text: string, capturedAt = Date.now()) => {
    const thread = opts.current.getThread(threadId);
    if (!thread || !messageId || !text.trim() || !preferenceHistoryThreadEligible(thread) || !opts.current.isEligibleThread(thread)) return;
    if (!boundPreferenceSourceMessages([{ id: messageId, role: "user", text }]).length) return;
    const keys = ["app", ...(opts.current.getProjectId(thread) ? [`project:${opts.current.getProjectId(thread)}`] : [])];
    const scopeKeys = keys.filter((key) => validScope(key) && getPreferenceLearningScope(key).enabled);
    if (!scopeKeys.length) return;
    const entries = receipts.current.get(threadId) ?? [];
    const transcriptText = taskStore.getState().tasks[threadId]?.messages.find((message) => message.id === messageId || message.clientMessageId === messageId)?.text ?? text;
    const transcriptFingerprint = preferenceSourceFingerprint({ id: "", role: "user", text: transcriptText });
    receipts.current.set(threadId, [...entries.filter((entry) => entry.id !== messageId), { id: messageId, text, capturedAt, transcriptFingerprint, scopeKeys }].slice(-32));
    while (receipts.current.size > 128) receipts.current.delete(receipts.current.keys().next().value!);
    for (const key of keys) if (validScope(key)) scopes.current.set(key, getPreferenceLearningScope(key));
    // Some providers finish a short response before their send RPC resolves.
    collectCompleted.current?.(threadId);
  }, [validScope]);

  const requestHistory = useCallback(async (scopeKey: string) => {
    if (!validScope(scopeKey) || !getPreferenceLearningScope(scopeKey).enabled || !opts.current.getHistoryThreads || historyRun.current) return;
    const runId = crypto.randomUUID();
    const progress: PreferenceHistoryProgress = { scopeKey, runId, status: "reading", threads: 0, pages: 0, messages: 0, skipped: 0, limited: false };
    const run: HistoryRun = { scopeKey, id: runId, cancelled: false, progress }; historyRun.current = run;
    let handedOff = false;
    const start = getPreferenceLearningScope(scopeKey);
    scopes.current.set(scopeKey, start);
    setHistoryProgress(progress);
    setPreferenceLearningJob(scopeKey, { status: "running", historyRunId: runId, message: "Reading recent past conversations…" });
    const check = () => alive.current && historyRun.current === run && !run.cancelled && validScope(scopeKey) && getPreferenceLearningScope(scopeKey).enabled && getPreferenceLearningScope(scopeKey).revision === start.revision;
    try {
      const discovered = await opts.current.getHistoryThreads(scopeKey);
      if (!check()) return;
      const threads = discovered.filter((thread) => preferenceHistoryThreadEligible(thread) && opts.current.isEligibleThread(thread)
        && (scopeKey === "app" || scopeKey === `project:${opts.current.getProjectId(thread) ?? ""}`));
      for (const thread of threads.slice(0, PREFERENCE_HISTORY_LIMITS.threads)) discoveredThreads.current.set(thread.id, thread);
      // Keep metadata referenced by another active/queued history job.
      const retainedIds = new Set([...threads.slice(0, PREFERENCE_HISTORY_LIMITS.threads).map((thread) => thread.id), ...[...(active.current?.sources ?? []), ...queue.current.flatMap((job) => job.sources)].map((source) => source.threadId)]);
      while (discoveredThreads.current.size > 128) {
        const candidate = [...discoveredThreads.current.keys()].find((id) => !retainedIds.has(id));
        if (!candidate) break;
        discoveredThreads.current.delete(candidate);
      }
      progress.limited = threads.length > PREFERENCE_HISTORY_LIMITS.threads;
      const sources: Source[] = [];
      for (const thread of threads.slice(0, PREFERENCE_HISTORY_LIMITS.threads).reverse()) {
        let cursor: string | null = null;
        const threadSources: Source[] = [];
        for (let pageIndex = 0; pageIndex < PREFERENCE_HISTORY_LIMITS.pagesPerThread; pageIndex += 1) {
          if (!check() || !belongs(scopeKey, thread.id)) return;
          const page = await readPreferenceHistoryPage(thread, cursor, (metadata) => opts.current.isEligibleThread(metadata)
            && (scopeKey === "app" || scopeKey === `project:${opts.current.getProjectId(metadata) ?? ""}`));
          if (!check() || !belongs(scopeKey, thread.id)) return;
          progress.pages += 1; progress.skipped += page.skipped;
          threadSources.unshift(...page.messages.map((message) => ({ ...message, threadId: thread.id, id: preferenceSourceId(thread.id, message.id) })));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        progress.threads += 1; progress.limited ||= Boolean(cursor);
        sources.push(...threadSources);
        updateHistory(runId, { ...progress });
      }
      if (!check()) return;
      const unprocessed = sources.filter((source) => source.role === "assistant" || !preferenceCheckpointEntries(start.checkpoints[source.threadId]).includes(preferenceSourceFingerprint(source)));
      const selected = boundPreferenceSourceMessages(unprocessed);
      progress.messages = selected.filter((source) => source.role === "user").length;
      progress.limited ||= selected.length < unprocessed.length;
      updateHistory(runId, progress);
      if (progress.messages) handedOff = enqueue(scopeKey, sources.filter((source) => selected.some((message) => message.id === source.id)), runId);
      else {
        setPreferenceLearningJob(scopeKey, { status: "idle", historyRunId: runId, message: "No new eligible authored messages found." });
        updateHistory(runId, { status: progress.limited || progress.skipped ? "partial" : "complete", changed: false,
          message: "No new eligible authored messages were found in this bounded history pass." });
      }
    } catch {
      if (check()) { updateHistory(runId, { status: "error", message: "History could not be read. No partial analysis was submitted." }); setPreferenceLearningJob(scopeKey, { status: "error", historyRunId: runId, message: "History could not be read." }); }
    } finally {
      if (!handedOff && historyRun.current === run) {
        updateHistory(runId, { status: "cancelled", message: "History analysis cancelled because its sources or settings changed." });
        if (alive.current) setPreferenceLearningJob(scopeKey, { status: "idle", historyRunId: runId });
      }
    }
  }, [validScope, belongs, enqueue, updateHistory]);

  useEffect(() => {
    alive.current = true;
    const timerMap = timers.current;
    const receiptMap = receipts.current;
    if (!getPreferenceLearningHydrated()) void loadPreferenceLearning().catch(() => undefined);
    collectCompleted.current = (threadId) => {
        const task = taskStore.getState().tasks[threadId];
        if (!task?.lastCompletedTurnId || task.lastCompletedTurnStatus !== "completed") return;
        const thread = opts.current.getThread(threadId); if (!thread) return;
        const captured = receipts.current.get(threadId) ?? [];
        const keys = ["app", ...(opts.current.getProjectId(thread) ? [`project:${opts.current.getProjectId(thread)}`] : [])];
        for (const scopeKey of keys) {
          if (!validScope(scopeKey) || !belongs(scopeKey, threadId)) continue;
          const scope = getPreferenceLearningScope(scopeKey); if (!scope.enabled) continue;
          const eligibleReceipts = new Map(captured.filter((receipt) => receipt.scopeKeys.includes(scopeKey) && receipt.capturedAt >= (scope.enabledAt ?? Infinity))
            .map((receipt) => [receipt.id, receipt]));
          const capturedTurnIds = new Set(task.messages.flatMap((message) => {
            if (message.role !== "user" || message.turnStatus !== "completed" || !message.turnId) return [];
            const receipt = eligibleReceipts.get(message.clientMessageId ?? message.id) ?? eligibleReceipts.get(message.id);
            return receipt && preferenceSourceFingerprint({ id: "", role: "user", text: message.text }) === receipt.transcriptFingerprint ? [message.turnId] : [];
          }));
          const accepted = captured.filter((receipt) => eligibleReceipts.has(receipt.id)
            && task.messages.some((message) => message.role === "user" && (message.id === receipt.id || message.clientMessageId === receipt.id)
              && message.turnId === task.lastCompletedTurnId && preferenceSourceFingerprint({ id: "", role: "user", text: message.text }) === receipt.transcriptFingerprint));
          if (!accepted.length) continue;
          const sources: Source[] = accepted.map((receipt) => {
            const message = task.messages.find((entry) => entry.role === "user" && (entry.id === receipt.id || entry.clientMessageId === receipt.id))!;
            return { id: preferenceSourceId(threadId, message.id), messageId: message.id, role: "user", text: receipt.text, transcriptFingerprint: receipt.transcriptFingerprint, threadId };
          });
          // Assistant output is bounded context, never evidence. Preserve nearby final responses only.
          const firstUser = task.messages.findIndex((message) => message.id === sources[0].messageId);
          const preceding = task.messages.slice(0, firstUser).filter((message) => message.role === "assistant" && !message.streaming
            && message.phase !== "commentary" && message.turnStatus === "completed" && message.turnId
            && capturedTurnIds.has(message.turnId)).slice(-1);
          const response = task.messages.filter((message) => message.role === "assistant" && !message.streaming && message.phase !== "commentary" && message.turnId === task.lastCompletedTurnId).slice(-1);
          sources.unshift(...preceding.map((message) => ({ id: preferenceSourceId(threadId, message.id), role: "assistant" as const, text: message.text, threadId })));
          sources.push(...response.map((message) => ({ id: preferenceSourceId(threadId, message.id), role: "assistant" as const, text: message.text, threadId })));
          enqueue(scopeKey, sources);
        }
    };
    const unsubscribeTasks = taskStore.subscribe((state, previous) => {
      if (!receipts.current.size || state.statuses === previous.statuses) return;
      for (const threadId of receipts.current.keys()) {
        const task = state.tasks[threadId]; if (!task) continue;
        if (task.lastCompletedTurnId && task.lastCompletedTurnStatus === "completed"
          && (previous.tasks[threadId]?.lastCompletedTurnId !== task.lastCompletedTurnId
            || previous.tasks[threadId]?.lastCompletedTurnStatus !== "completed")) collectCompleted.current?.(threadId);
      }
    });
    const unsubscribeLearning = subscribePreferenceLearning(() => {
      for (const [key, previous] of scopes.current) {
        const current = getPreferenceLearningScope(key);
        if (!current.enabled || !validScope(key)) {
          scopes.current.set(key, current);
          cancelScope(key, true);
          continue;
        }
        if (!ownWrites.current.has(key) && (current !== previous || !validScope(key)
          || active.current?.scopeKey === key && getPreferenceLearningJob(key).status === "idle")) {
          scopes.current.set(key, current);
          if (current.revision !== previous.revision || !current.enabled || !validScope(key)) cancelScope(key, true);
        }
      }
    });
    return () => {
      alive.current = false; unsubscribeTasks(); unsubscribeLearning();
      collectCompleted.current = null;
      const pendingScopes = new Set([...queue.current.map((job) => job.scopeKey),
        ...(active.current ? [active.current.scopeKey] : []), ...(historyRun.current ? [historyRun.current.scopeKey] : [])]);
      for (const timer of timerMap.values()) clearTimeout(timer);
      timerMap.clear(); queue.current = []; receiptMap.clear();
      if (historyRun.current) historyRun.current.cancelled = true;
      historyRun.current = null;
      if (active.current) { active.current.cancelled = true; void invoke("run_discovery_cancel", { requestId: active.current.requestId }).catch(() => undefined); }
      for (const key of pendingScopes) setPreferenceLearningJob(key, { status: "idle", historyRunId: getPreferenceLearningJob(key).historyRunId });
    };
  }, [belongs, cancelScope, enqueue, validScope]);
  useEffect(() => {
    for (const key of scopes.current.keys()) if (!validScope(key)) cancelScope(key, true);
  });
  return { captureUserPrompt, cancelScope, requestHistory, historyProgress };
}

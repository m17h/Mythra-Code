import { invoke } from "@tauri-apps/api/core";
import { auditEvent } from "./codex";
import type { Provider } from "../types";

const THREAD_OPEN_AUDIT_KIND = "performance.threadOpen";
const MAX_LONG_TASKS = 200;
const MAX_SAMPLE_AGE_MS = 60_000;
const THREAD_OPEN_TIMEOUT_MS = 30_000;

interface LongTaskSample {
  startTime: number;
  duration: number;
}

export interface ProcessMemorySnapshot {
  hostResidentBytes: number | null;
  managedProcessTreeResidentBytes: number | null;
  managedProcessCount: number;
  appServerResidentBytes: number | null;
  sampledAgeMs: number;
  cached: boolean;
}

interface ActiveThreadOpen {
  threadId: string;
  provider: Provider;
  warm: boolean;
  startedAt: number;
  shellCommittedAt?: number;
  historyHydratedAt?: number;
  timelineCommittedAt?: number;
  runtimeReadyAt?: number;
  projectedHistoryBytes?: number;
  messageCount?: number;
  activityCount?: number;
  renderedRowCount?: number;
  timelineDomNodeCount?: number;
  totalDomNodeCount?: number;
  renderMetricsCaptured: boolean;
  paginated?: boolean;
  hasMore?: boolean;
  measureProjectedHistoryBytes?: () => number | null;
  timeout?: ReturnType<typeof setTimeout>;
  finished: boolean;
}

interface ChromiumPerformanceMemory {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

let active: ActiveThreadOpen | null = null;
let longTaskObserver: PerformanceObserver | null = null;
const longTasks: LongTaskSample[] = [];

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function durationFrom(sample: ActiveThreadOpen, at?: number): number | null {
  return at === undefined ? null : rounded(at - sample.startedAt);
}

function startLongTaskObserver(): void {
  if (longTaskObserver || typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
  if (!supported) return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
      if (longTasks.length > MAX_LONG_TASKS) longTasks.splice(0, longTasks.length - MAX_LONG_TASKS);
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
}

function javascriptHeapSnapshot(): Record<string, number | null> {
  const memory = (performance as Performance & { memory?: ChromiumPerformanceMemory }).memory;
  return {
    usedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
    totalBytes: typeof memory?.totalJSHeapSize === "number" ? memory.totalJSHeapSize : null,
    limitBytes: typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null,
  };
}

function longTaskSummary(startedAt: number, endedAt: number): Record<string, number | boolean> {
  if (longTaskObserver) {
    for (const entry of longTaskObserver.takeRecords()) {
      longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    }
    if (longTasks.length > MAX_LONG_TASKS) longTasks.splice(0, longTasks.length - MAX_LONG_TASKS);
  }
  const matching = longTasks.filter((entry) => entry.startTime <= endedAt && entry.startTime + entry.duration >= startedAt);
  return {
    supported: Boolean(longTaskObserver),
    count: matching.length,
    totalDurationMs: rounded(matching.reduce((total, entry) => total + entry.duration, 0)),
    maximumDurationMs: rounded(matching.reduce((maximum, entry) => Math.max(maximum, entry.duration), 0)),
  };
}

export function projectedJsonBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : new TextEncoder().encode(json).byteLength;
  } catch {
    return null;
  }
}

/**
 * Starts one privacy-safe navigation sample. Thread ids are used only to
 * reject stale commits in renderer memory and are never written to the audit
 * event. A newer selection closes the old sample as superseded so slow or
 * incomplete opens do not disappear from the dataset.
 */
export function beginThreadOpen(threadId: string, provider: Provider, warm: boolean): void {
  startLongTaskObserver();
  if (active && !active.finished) void finishThreadOpen(active, "superseded", "newSelection", false);
  const sample: ActiveThreadOpen = {
    threadId,
    provider,
    warm,
    startedAt: performance.now(),
    renderMetricsCaptured: false,
    finished: false,
  };
  sample.timeout = setTimeout(() => {
    if (active !== sample || sample.finished) return;
    const phase = sample.timelineCommittedAt === undefined
      ? "timelineCommitTimeout"
      : sample.renderMetricsCaptured
        ? "runtimeReadyTimeout"
        : "renderMetricsTimeout";
    void finishThreadOpen(sample, "abandoned", phase);
  }, THREAD_OPEN_TIMEOUT_MS);
  active = sample;
}

/** Called from a layout effect after the selected thread shell commits. */
export function markThreadShellCommitted(threadId: string): void {
  if (!active || active.finished || active.threadId !== threadId || active.shellCommittedAt !== undefined) return;
  active.shellCommittedAt = performance.now();
}

/** Records the bounded history data handed to the task store. */
export function markThreadHistoryHydrated(threadId: string, input: {
  projectedBytes: number | null;
  messageCount: number;
  activityCount: number;
  paginated: boolean;
  hasMore: boolean;
  measureProjectedBytes?: () => number | null;
}): void {
  if (!active || active.finished || active.threadId !== threadId) return;
  active.historyHydratedAt = performance.now();
  if (input.projectedBytes !== null) active.projectedHistoryBytes = Math.max(0, Math.round(input.projectedBytes));
  active.messageCount = Math.max(0, Math.round(input.messageCount));
  active.activityCount = Math.max(0, Math.round(input.activityCount));
  active.paginated = input.paginated;
  active.hasMore = input.hasMore;
  active.measureProjectedHistoryBytes = input.measureProjectedBytes;
}

/** Lets the React boundary avoid DOM queries after the one useful commit. */
export function threadOpenAwaitingTimeline(threadId: string): boolean {
  return Boolean(
    active
    && !active.finished
    && active.threadId === threadId
    && active.historyHydratedAt !== undefined
    && active.timelineCommittedAt === undefined,
  );
}

/** Stamps the hydrated commit before any diagnostic DOM traversal occurs. */
export function markThreadTimelineCommitted(threadId: string): void {
  if (!active || active.finished || active.threadId !== threadId || active.historyHydratedAt === undefined || active.timelineCommittedAt !== undefined) return;
  active.timelineCommittedAt = performance.now();
}

/** Lets the React boundary collect render metrics after the measured commit. */
export function threadOpenAwaitingRenderMetrics(threadId: string): boolean {
  return Boolean(
    active
    && !active.finished
    && active.threadId === threadId
    && active.timelineCommittedAt !== undefined
    && !active.renderMetricsCaptured,
  );
}

/** Records DOM metrics in a later frame so counting cannot inflate commit time. */
export function markThreadRenderMetrics(threadId: string, input: {
  renderedRowCount: number;
  timelineDomNodeCount: number;
  totalDomNodeCount: number;
}): void {
  if (!active || active.finished || active.threadId !== threadId || active.timelineCommittedAt === undefined || active.renderMetricsCaptured) return;
  active.renderMetricsCaptured = true;
  active.renderedRowCount = Math.max(0, Math.round(input.renderedRowCount));
  active.timelineDomNodeCount = Math.max(0, Math.round(input.timelineDomNodeCount));
  active.totalDomNodeCount = Math.max(0, Math.round(input.totalDomNodeCount));
  void finishIfComplete();
}

/** Marks provider/runtime preparation complete without waiting on diagnostics IO. */
export function markThreadRuntimeReady(threadId: string): void {
  if (!active || active.finished || active.threadId !== threadId) return;
  active.runtimeReadyAt = performance.now();
  void finishIfComplete();
}

/** Records a failed navigation if it is still the current sample. */
export function failThreadOpen(threadId: string, phase: string): void {
  if (!active || active.finished || active.threadId !== threadId) return;
  void finishThreadOpen(active, "error", phase);
}

async function finishIfComplete(): Promise<void> {
  const sample = active;
  if (!sample || sample.finished || sample.timelineCommittedAt === undefined || !sample.renderMetricsCaptured || sample.runtimeReadyAt === undefined) return;
  await finishThreadOpen(sample, "completed");
}

async function processMemorySnapshot(): Promise<ProcessMemorySnapshot | null> {
  try {
    return await invoke<ProcessMemorySnapshot>("performance_snapshot");
  } catch {
    return null;
  }
}

async function finishThreadOpen(
  sample: ActiveThreadOpen,
  outcome: "completed" | "error" | "abandoned" | "superseded",
  phase?: string,
  includeProcessMemory = true,
): Promise<void> {
  if (sample.finished) return;
  sample.finished = true;
  if (sample.timeout) clearTimeout(sample.timeout);
  const finishedAt = performance.now();
  const endedAt = outcome === "completed" && sample.timelineCommittedAt !== undefined && sample.runtimeReadyAt !== undefined
    ? Math.max(sample.timelineCommittedAt, sample.runtimeReadyAt)
    : finishedAt;
  if (active === sample) active = null;
  // Yield until the measured browser task has ended. This lets long-task
  // entries become observable and keeps all remaining diagnostics work out of
  // the navigation task whose duration was just captured.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const processMemory = includeProcessMemory ? await processMemorySnapshot() : null;
  if (outcome !== "superseded" && sample.projectedHistoryBytes === undefined && sample.measureProjectedHistoryBytes) {
    const measured = sample.measureProjectedHistoryBytes();
    if (measured !== null) sample.projectedHistoryBytes = Math.max(0, Math.round(measured));
  }
  sample.measureProjectedHistoryBytes = undefined;
  const payload = {
    schemaVersion: 1,
    provider: sample.provider,
    warm: sample.warm,
    outcome,
    ...(phase ? { phase: phase.slice(0, 80) } : {}),
    durationMs: {
      shellCommit: durationFrom(sample, sample.shellCommittedAt),
      historyHydrated: durationFrom(sample, sample.historyHydratedAt),
      timelineCommit: durationFrom(sample, sample.timelineCommittedAt),
      runtimeReady: durationFrom(sample, sample.runtimeReadyAt),
      total: rounded(endedAt - sample.startedAt),
    },
    history: {
      projectedBytes: sample.projectedHistoryBytes ?? null,
      messages: sample.messageCount ?? null,
      activities: sample.activityCount ?? null,
      paginated: sample.paginated ?? null,
      hasMore: sample.hasMore ?? null,
    },
    render: {
      rows: sample.renderedRowCount ?? null,
      timelineDomNodes: sample.timelineDomNodeCount ?? null,
      totalDomNodes: sample.totalDomNodeCount ?? null,
    },
    longTasks: longTaskSummary(sample.startedAt, endedAt),
    javascriptHeap: javascriptHeapSnapshot(),
    processMemory,
  };
  await auditEvent(THREAD_OPEN_AUDIT_KIND, payload).catch(() => undefined);
  const cutoff = endedAt - MAX_SAMPLE_AGE_MS;
  while (longTasks[0] && longTasks[0].startTime < cutoff) longTasks.shift();
}

/** Test-only reset; exported to keep observer/sample state deterministic. */
export function resetPerformanceDiagnostics(): void {
  if (active?.timeout) clearTimeout(active.timeout);
  active = null;
  longTasks.length = 0;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}

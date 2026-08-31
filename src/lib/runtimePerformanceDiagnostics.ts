import { auditEvent } from "./codex";
import type { Provider } from "../types";

const TURN_AUDIT_KIND = "performance.runtimeTurn";
const COMPOSER_AUDIT_KIND = "performance.composer";
const MAX_ACTIVE_TURNS = 32;
const MAX_PROVIDER_BINDINGS = 256;
const TURN_FINALIZE_GRACE_MS = 2_000;
const COMPOSER_BATCH_SIZE = 32;

type RuntimeOutcome = "completed" | "interrupted" | "error" | "abandoned";
export type PersistenceWriteKind = "snapshot" | "tail" | "metadata";

interface RuntimeTurnSample {
  key: string;
  threadId: string;
  turnId?: string;
  provider: Provider | "unknown";
  startedAt: number;
  lastObservedAt: number;
  pendingFrameSince?: number;
  deltaCalls: number;
  deltaCharacters: number;
  flushes: number;
  queueToFrameTotalMs: number;
  queueToFrameMaximumMs: number;
  queueToFrameOverBudget: number;
  flushWorkTotalMs: number;
  flushWorkMaximumMs: number;
  flushWorkOverBudget: number;
  persistenceWrites: number;
  persistenceFailures: number;
  persistenceEstimatedBytes: number;
  persistenceDurationTotalMs: number;
  persistenceDurationMaximumMs: number;
  persistenceKinds: Record<PersistenceWriteKind, number>;
  pendingPersistenceWrites: number;
  outcome?: RuntimeOutcome;
  finalizeTimer?: ReturnType<typeof setTimeout>;
}

interface ComposerBatch {
  values: number[];
  frames: Set<number>;
}

const providers = new Map<string, Provider>();
const activeTurns = new Map<string, RuntimeTurnSample>();
const currentTurns = new Map<string, string>();
const composerBatches = new Map<Provider, ComposerBatch>();
let turnSequence = 0;

function rounded(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function rememberProvider(threadId: string, provider: Provider): void {
  providers.delete(threadId);
  providers.set(threadId, provider);
  while (providers.size > MAX_PROVIDER_BINDINGS) providers.delete(providers.keys().next().value as string);
}

export function registerRuntimePerformanceProvider(threadId: string, provider: Provider): void {
  if (!threadId) return;
  rememberProvider(threadId, provider);
  for (const sample of activeTurns.values()) if (sample.threadId === threadId) sample.provider = provider;
}

export function forgetRuntimePerformanceProvider(threadId: string): void {
  providers.delete(threadId);
}

function createTurnSample(threadId: string, at: number, provider?: Provider): RuntimeTurnSample {
  const key = `${threadId}\0${++turnSequence}`;
  const sample: RuntimeTurnSample = {
    key,
    threadId,
    provider: provider ?? providers.get(threadId) ?? "unknown",
    startedAt: at,
    lastObservedAt: at,
    deltaCalls: 0,
    deltaCharacters: 0,
    flushes: 0,
    queueToFrameTotalMs: 0,
    queueToFrameMaximumMs: 0,
    queueToFrameOverBudget: 0,
    flushWorkTotalMs: 0,
    flushWorkMaximumMs: 0,
    flushWorkOverBudget: 0,
    persistenceWrites: 0,
    persistenceFailures: 0,
    persistenceEstimatedBytes: 0,
    persistenceDurationTotalMs: 0,
    persistenceDurationMaximumMs: 0,
    persistenceKinds: { snapshot: 0, tail: 0, metadata: 0 },
    pendingPersistenceWrites: 0,
  };
  activeTurns.set(key, sample);
  currentTurns.set(threadId, key);
  while (activeTurns.size > MAX_ACTIVE_TURNS) {
    const oldest = activeTurns.values().next().value as RuntimeTurnSample | undefined;
    if (!oldest) break;
    void finishRuntimeTurn(oldest, oldest.outcome ?? "abandoned");
  }
  return sample;
}

function currentTurnSample(threadId: string): RuntimeTurnSample | undefined {
  const key = currentTurns.get(threadId);
  return key ? activeTurns.get(key) : undefined;
}

function turnSample(threadId: string, at: number, provider?: Provider): RuntimeTurnSample {
  return currentTurnSample(threadId) ?? createTurnSample(threadId, at, provider);
}

function matchingTurnSample(threadId: string, turnId?: string): RuntimeTurnSample | undefined {
  const current = currentTurnSample(threadId);
  if (!turnId || turnId === "__pending__") return current;
  if (current?.turnId === turnId) return current;
  if (current && !current.turnId) {
    current.turnId = turnId;
    return current;
  }
  return [...activeTurns.values()].find((sample) => sample.threadId === threadId && sample.turnId === turnId);
}

export function beginRuntimePerformanceTurn(threadId: string, provider?: Provider, at = performance.now()): void {
  if (!threadId) return;
  if (provider) registerRuntimePerformanceProvider(threadId, provider);
  const existing = currentTurnSample(threadId);
  if (existing && !existing.outcome) return;
  createTurnSample(threadId, at, provider);
}

export function bindRuntimePerformanceTurn(threadId: string, turnId: string | undefined): void {
  if (!turnId) return;
  const sample = currentTurnSample(threadId);
  if (sample && !sample.turnId) sample.turnId = turnId;
}

export function recordStreamingDelta(threadId: string, characters: number, at = performance.now(), turnId?: string): void {
  if (!threadId || characters <= 0) return;
  const sample = matchingTurnSample(threadId, turnId) ?? turnSample(threadId, at);
  sample.lastObservedAt = at;
  sample.deltaCalls += 1;
  sample.deltaCharacters += Math.max(0, Math.round(characters));
  sample.pendingFrameSince ??= at;
}

export function recordStreamingFlush(threadIds: Iterable<string>, startedAt: number, endedAt: number): void {
  const workMs = rounded(endedAt - startedAt);
  for (const threadId of threadIds) {
    const sample = currentTurnSample(threadId);
    if (!sample) continue;
    sample.lastObservedAt = endedAt;
    sample.flushes += 1;
    sample.flushWorkTotalMs += workMs;
    sample.flushWorkMaximumMs = Math.max(sample.flushWorkMaximumMs, workMs);
    if (workMs > 16.7) sample.flushWorkOverBudget += 1;
    if (sample.pendingFrameSince !== undefined) {
      const delayMs = rounded(startedAt - sample.pendingFrameSince);
      sample.queueToFrameTotalMs += delayMs;
      sample.queueToFrameMaximumMs = Math.max(sample.queueToFrameMaximumMs, delayMs);
      if (delayMs > 33.4) sample.queueToFrameOverBudget += 1;
      sample.pendingFrameSince = undefined;
    }
  }
}

function scheduleFinalization(sample: RuntimeTurnSample): void {
  if (!sample.outcome || sample.pendingPersistenceWrites > 0) return;
  if (sample.finalizeTimer) clearTimeout(sample.finalizeTimer);
  sample.finalizeTimer = setTimeout(() => {
    sample.finalizeTimer = undefined;
    if (sample.pendingPersistenceWrites === 0 && sample.outcome) void finishRuntimeTurn(sample, sample.outcome);
  }, TURN_FINALIZE_GRACE_MS);
}

export function completeRuntimePerformanceTurn(threadId: string, outcome: RuntimeOutcome, turnId?: string): void {
  // Steering can replace the runtime turn id without taking the task through
  // another idle → starting transition. taskStore suppresses completion while
  // a newer turn is active, so the current sample is the safe terminal fallback.
  const sample = matchingTurnSample(threadId, turnId) ?? currentTurnSample(threadId);
  if (!sample) return;
  sample.outcome = outcome;
  sample.lastObservedAt = performance.now();
  scheduleFinalization(sample);
}

export function beginPersistencePerformanceWrite(
  threadId: string,
  provider: Provider,
  kind: PersistenceWriteKind,
  estimatedBytes: number,
  startedAt = performance.now(),
  turnId?: string,
): (succeeded?: boolean, endedAt?: number) => void {
  registerRuntimePerformanceProvider(threadId, provider);
  const sample = matchingTurnSample(threadId, turnId);
  if (!sample) return () => undefined;
  if (sample.finalizeTimer) {
    clearTimeout(sample.finalizeTimer);
    sample.finalizeTimer = undefined;
  }
  sample.pendingPersistenceWrites += 1;
  sample.persistenceWrites += 1;
  sample.persistenceKinds[kind] += 1;
  sample.persistenceEstimatedBytes += Math.max(0, Math.round(estimatedBytes));
  let finished = false;
  return (succeeded = true, endedAt = performance.now()) => {
    if (finished) return;
    finished = true;
    const durationMs = rounded(endedAt - startedAt);
    sample.lastObservedAt = endedAt;
    sample.pendingPersistenceWrites = Math.max(0, sample.pendingPersistenceWrites - 1);
    if (!succeeded) sample.persistenceFailures += 1;
    sample.persistenceDurationTotalMs += durationMs;
    sample.persistenceDurationMaximumMs = Math.max(sample.persistenceDurationMaximumMs, durationMs);
    scheduleFinalization(sample);
  };
}

async function finishRuntimeTurn(sample: RuntimeTurnSample, outcome: RuntimeOutcome): Promise<void> {
  if (activeTurns.get(sample.key) !== sample) return;
  activeTurns.delete(sample.key);
  if (currentTurns.get(sample.threadId) === sample.key) currentTurns.delete(sample.threadId);
  if (sample.finalizeTimer) clearTimeout(sample.finalizeTimer);
  const average = (total: number, count: number) => count ? rounded(total / count) : null;
  await auditEvent(TURN_AUDIT_KIND, {
    schemaVersion: 1,
    provider: sample.provider,
    outcome,
    observedDurationMs: rounded(sample.lastObservedAt - sample.startedAt),
    streaming: {
      deltaCalls: sample.deltaCalls,
      deltaCharacters: sample.deltaCharacters,
      flushes: sample.flushes,
      queueToFrameAverageMs: average(sample.queueToFrameTotalMs, sample.flushes),
      queueToFrameMaximumMs: rounded(sample.queueToFrameMaximumMs),
      queueToFrameOverBudget: sample.queueToFrameOverBudget,
      flushWorkAverageMs: average(sample.flushWorkTotalMs, sample.flushes),
      flushWorkMaximumMs: rounded(sample.flushWorkMaximumMs),
      flushWorkOverBudget: sample.flushWorkOverBudget,
    },
    persistence: {
      writes: sample.persistenceWrites,
      failures: sample.persistenceFailures,
      estimatedBytes: sample.persistenceEstimatedBytes,
      durationTotalMs: rounded(sample.persistenceDurationTotalMs),
      durationMaximumMs: rounded(sample.persistenceDurationMaximumMs),
      kinds: sample.persistenceKinds,
    },
  }).catch(() => undefined);
}

export function recordComposerInputToFrame(provider: Provider, startedAt = performance.now()): void {
  const batch = composerBatches.get(provider) ?? { values: [], frames: new Set<number>() };
  composerBatches.set(provider, batch);
  if (typeof requestAnimationFrame !== "function") return;
  const frame = requestAnimationFrame((frameAt) => {
    batch.frames.delete(frame);
    batch.values.push(rounded(frameAt - startedAt));
    if (batch.values.length < COMPOSER_BATCH_SIZE) return;
    const values = batch.values.splice(0, COMPOSER_BATCH_SIZE);
    void auditEvent(COMPOSER_AUDIT_KIND, {
      schemaVersion: 1,
      provider,
      samples: values.length,
      inputToFrameMs: values,
    }).catch(() => undefined);
  });
  batch.frames.add(frame);
}

/** Test-only reset for deterministic clocks, timers, and animation frames. */
export function resetRuntimePerformanceDiagnostics(): void {
  for (const sample of activeTurns.values()) if (sample.finalizeTimer) clearTimeout(sample.finalizeTimer);
  for (const batch of composerBatches.values()) for (const frame of batch.frames) cancelAnimationFrame(frame);
  providers.clear();
  activeTurns.clear();
  currentTurns.clear();
  composerBatches.clear();
  turnSequence = 0;
}

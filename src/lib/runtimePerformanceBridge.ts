import type { Provider } from "../types";
export type { PersistenceWriteKind } from "./runtimePerformanceDiagnostics";
import type { PersistenceWriteKind } from "./runtimePerformanceDiagnostics";

type Diagnostics = typeof import("./runtimePerformanceDiagnostics");

const MAX_PROVIDER_BINDINGS = 256;
const COMPOSER_SAMPLE_EVERY = 16;
const providers = new Map<string, Provider>();
const composerSeen = new Map<Provider, number>();
let loaded: Diagnostics | null = null;
let loading: Promise<Diagnostics> | null = null;

function loadDiagnostics(): Promise<Diagnostics> {
  loading ??= import("./runtimePerformanceDiagnostics").then((module) => {
    loaded = module;
    for (const [threadId, provider] of providers) module.registerRuntimePerformanceProvider(threadId, provider);
    return module;
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

function withDiagnostics(action: (module: Diagnostics) => void): void {
  if (loaded) action(loaded);
  else void loadDiagnostics().then(action).catch(() => undefined);
}

export function registerRuntimePerformanceProvider(threadId: string, provider: Provider): void {
  if (!threadId) return;
  providers.delete(threadId);
  providers.set(threadId, provider);
  while (providers.size > MAX_PROVIDER_BINDINGS) {
    const oldest = providers.keys().next().value as string | undefined;
    if (!oldest) break;
    providers.delete(oldest);
  }
  if (loaded) loaded.registerRuntimePerformanceProvider(threadId, provider);
}

export function forgetRuntimePerformanceProvider(threadId: string): void {
  providers.delete(threadId);
  if (loaded) loaded.forgetRuntimePerformanceProvider(threadId);
}

export function beginRuntimePerformanceTurn(threadId: string, at = performance.now()): void {
  withDiagnostics((module) => module.beginRuntimePerformanceTurn(threadId, providers.get(threadId), at));
}

export function bindRuntimePerformanceTurn(threadId: string, turnId: string | undefined): void {
  withDiagnostics((module) => module.bindRuntimePerformanceTurn(threadId, turnId));
}

export function completeRuntimePerformanceTurn(
  threadId: string,
  outcome: "completed" | "interrupted" | "error" | "abandoned",
  turnId?: string,
): void {
  withDiagnostics((module) => module.completeRuntimePerformanceTurn(threadId, outcome, turnId));
}

export function recordStreamingDelta(threadId: string, characters: number, at: number, turnId?: string): void {
  if (loaded) {
    loaded.recordStreamingDelta(threadId, characters, at, turnId);
    return;
  }
  void loadDiagnostics().then((module) => module.recordStreamingDelta(threadId, characters, at, turnId)).catch(() => undefined);
}

export function recordStreamingFlush(threadIds: Iterable<string>, startedAt: number, endedAt: number): void {
  if (loaded) {
    loaded.recordStreamingFlush(threadIds, startedAt, endedAt);
    return;
  }
  const capturedThreadIds = [...threadIds];
  void loadDiagnostics().then((module) => module.recordStreamingFlush(capturedThreadIds, startedAt, endedAt)).catch(() => undefined);
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
  if (loaded) return loaded.beginPersistencePerformanceWrite(threadId, provider, kind, estimatedBytes, startedAt, turnId);
  const pending = loadDiagnostics().then((module) => module.beginPersistencePerformanceWrite(
    threadId,
    provider,
    kind,
    estimatedBytes,
    startedAt,
    turnId,
  ));
  let completion: { succeeded: boolean; endedAt: number } | null = null;
  let resolvedFinish: ((succeeded?: boolean, endedAt?: number) => void) | null = null;
  void pending.then((finish) => {
    resolvedFinish = finish;
    if (completion) finish(completion.succeeded, completion.endedAt);
  }).catch(() => undefined);
  return (succeeded = true, endedAt = performance.now()) => {
    completion = { succeeded, endedAt };
    resolvedFinish?.(succeeded, endedAt);
  };
}

export function recordComposerInputToFrame(provider: Provider, startedAt = performance.now()): void {
  const seen = (composerSeen.get(provider) ?? 0) + 1;
  composerSeen.set(provider, seen);
  if (seen % COMPOSER_SAMPLE_EVERY !== 0) return;
  if (!loaded) {
    // Warm the lazy collector without counting chunk-load time as input
    // latency. The next sampled change uses the already-loaded module.
    void loadDiagnostics().catch(() => undefined);
    return;
  }
  loaded.recordComposerInputToFrame(provider, startedAt);
}

/** Test-only reset. The lazy module is retained like a production import. */
export function resetRuntimePerformanceDiagnostics(): void {
  providers.clear();
  composerSeen.clear();
  loaded?.resetRuntimePerformanceDiagnostics();
}

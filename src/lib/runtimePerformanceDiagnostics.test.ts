import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auditEvent } = vi.hoisted(() => ({
  auditEvent: vi.fn(async (_kind: string, _payload: unknown) => undefined),
}));

vi.mock("./codex", () => ({ auditEvent }));

import {
  beginPersistencePerformanceWrite,
  beginRuntimePerformanceTurn,
  bindRuntimePerformanceTurn,
  completeRuntimePerformanceTurn,
  recordComposerInputToFrame,
  recordStreamingDelta,
  recordStreamingFlush,
  registerRuntimePerformanceProvider,
  resetRuntimePerformanceDiagnostics,
} from "./runtimePerformanceDiagnostics";

describe("runtime performance diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    auditEvent.mockClear();
    resetRuntimePerformanceDiagnostics();
  });

  afterEach(() => {
    resetRuntimePerformanceDiagnostics();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits one aggregate privacy-safe turn record after persistence settles", async () => {
    vi.spyOn(performance, "now").mockReturnValue(40);
    registerRuntimePerformanceProvider("secret-thread", "claude");
    recordStreamingDelta("secret-thread", 12, 0);
    recordStreamingDelta("secret-thread", 8, 2);
    recordStreamingFlush(["secret-thread"], 10, 13);
    const finishWrite = beginPersistencePerformanceWrite("secret-thread", "claude", "tail", 4_096, 20);
    finishWrite(true, 30);
    completeRuntimePerformanceTurn("secret-thread", "completed");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(auditEvent).toHaveBeenCalledOnce();
    expect(auditEvent).toHaveBeenCalledWith("performance.runtimeTurn", {
      schemaVersion: 1,
      provider: "claude",
      outcome: "completed",
      observedDurationMs: 40,
      streaming: {
        deltaCalls: 2,
        deltaCharacters: 20,
        flushes: 1,
        queueToFrameAverageMs: 10,
        queueToFrameMaximumMs: 10,
        queueToFrameOverBudget: 0,
        flushWorkAverageMs: 3,
        flushWorkMaximumMs: 3,
        flushWorkOverBudget: 0,
      },
      persistence: {
        writes: 1,
        failures: 0,
        estimatedBytes: 4_096,
        durationTotalMs: 10,
        durationMaximumMs: 10,
        kinds: { snapshot: 0, tail: 1, metadata: 0 },
      },
    });
    expect(JSON.stringify(auditEvent.mock.calls[0])).not.toContain("secret-thread");
  });

  it("waits for a post-turn persistence write instead of emitting an incomplete sample", async () => {
    vi.spyOn(performance, "now").mockReturnValue(5);
    recordStreamingDelta("thread", 1, 0);
    completeRuntimePerformanceTurn("thread", "completed");
    await vi.advanceTimersByTimeAsync(900);

    const finishWrite = beginPersistencePerformanceWrite("thread", "cursor", "snapshot", 1_000, 900);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(auditEvent).not.toHaveBeenCalled();

    finishWrite(false, 2_100);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(auditEvent).toHaveBeenCalledWith("performance.runtimeTurn", expect.objectContaining({
      provider: "cursor",
      persistence: expect.objectContaining({ writes: 1, failures: 1, estimatedBytes: 1_000 }),
    }));
  });

  it("keeps a previous turn's delayed persistence separate from the next turn", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    beginRuntimePerformanceTurn("thread", "claude", 0);
    bindRuntimePerformanceTurn("thread", "turn-one");
    recordStreamingDelta("thread", 2, 1, "turn-one");
    completeRuntimePerformanceTurn("thread", "completed", "turn-one");

    beginRuntimePerformanceTurn("thread", "claude", 10);
    bindRuntimePerformanceTurn("thread", "turn-two");
    recordStreamingDelta("thread", 3, 11, "turn-two");
    const finishOldWrite = beginPersistencePerformanceWrite("thread", "claude", "tail", 700, 12, "turn-one");
    finishOldWrite(true, 15);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(auditEvent).toHaveBeenCalledOnce();
    expect(auditEvent).toHaveBeenCalledWith("performance.runtimeTurn", expect.objectContaining({
      streaming: expect.objectContaining({ deltaCharacters: 2 }),
      persistence: expect.objectContaining({ writes: 1, estimatedBytes: 700 }),
    }));

    completeRuntimePerformanceTurn("thread", "completed", "turn-two");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(auditEvent).toHaveBeenCalledTimes(2);
    expect(auditEvent.mock.calls[1][1]).toMatchObject({
      streaming: { deltaCharacters: 3 },
      persistence: { writes: 0 },
    });
  });

  it("finishes the current sample when steering replaces its bound turn id", async () => {
    vi.spyOn(performance, "now").mockReturnValue(20);
    beginRuntimePerformanceTurn("thread", "openai", 0);
    bindRuntimePerformanceTurn("thread", "turn-one");
    recordStreamingDelta("thread", 5, 5, "turn-one");

    // A steered turn starts while the task remains running, so there is no
    // second idle → starting transition to create or rebind a sample.
    beginRuntimePerformanceTurn("thread", "openai", 10);
    bindRuntimePerformanceTurn("thread", "turn-two");
    completeRuntimePerformanceTurn("thread", "completed", "turn-two");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(auditEvent).toHaveBeenCalledOnce();
    expect(auditEvent).toHaveBeenCalledWith("performance.runtimeTurn", expect.objectContaining({
      outcome: "completed",
      streaming: expect.objectContaining({ deltaCharacters: 5 }),
    }));
  });

  it("samples composer input sparsely and exports only aggregate frame latency", async () => {
    let nextFrame = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => callbacks.delete(id)));

    for (let sample = 0; sample < 32; sample += 1) {
      recordComposerInputToFrame("openai", sample * 20);
      const [id, callback] = callbacks.entries().next().value as [number, FrameRequestCallback];
      callbacks.delete(id);
      callback(sample * 20 + 8);
    }
    await Promise.resolve();

    expect(requestAnimationFrame).toHaveBeenCalledTimes(32);
    expect(auditEvent).toHaveBeenCalledWith("performance.composer", {
      schemaVersion: 1,
      provider: "openai",
      samples: 32,
      inputToFrameMs: Array.from({ length: 32 }, () => 8),
    });
  });
});

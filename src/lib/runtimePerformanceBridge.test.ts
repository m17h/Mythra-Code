import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({
  registerRuntimePerformanceProvider: vi.fn(),
  forgetRuntimePerformanceProvider: vi.fn(),
  beginRuntimePerformanceTurn: vi.fn(),
  bindRuntimePerformanceTurn: vi.fn(),
  completeRuntimePerformanceTurn: vi.fn(),
  recordStreamingDelta: vi.fn(),
  recordStreamingFlush: vi.fn(),
  beginPersistencePerformanceWrite: vi.fn(() => vi.fn()),
  recordComposerInputToFrame: vi.fn(),
  resetRuntimePerformanceDiagnostics: vi.fn(),
}));

vi.mock("./runtimePerformanceDiagnostics", () => diagnostics);

describe("runtime performance bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const value of Object.values(diagnostics)) value.mockClear();
  });

  it("retains provider metadata without loading diagnostics until real work begins", async () => {
    const {
      beginRuntimePerformanceTurn,
      recordStreamingDelta,
      registerRuntimePerformanceProvider,
    } = await import("./runtimePerformanceBridge");
    registerRuntimePerformanceProvider("thread", "openrouter");
    expect(diagnostics.registerRuntimePerformanceProvider).not.toHaveBeenCalled();

    beginRuntimePerformanceTurn("thread", 10);
    await vi.waitFor(() => expect(diagnostics.beginRuntimePerformanceTurn).toHaveBeenCalledWith("thread", "openrouter", 10));
    expect(diagnostics.registerRuntimePerformanceProvider).toHaveBeenCalledWith("thread", "openrouter");

    recordStreamingDelta("thread", 4, 12, "turn");
    expect(diagnostics.recordStreamingDelta).toHaveBeenCalledWith("thread", 4, 12, "turn");
  });

  it("warms on the first sampled composer change and measures only after loading", async () => {
    const { recordComposerInputToFrame, registerRuntimePerformanceProvider } = await import("./runtimePerformanceBridge");
    registerRuntimePerformanceProvider("thread", "claude");
    for (let input = 0; input < 15; input += 1) recordComposerInputToFrame("claude", input);
    expect(diagnostics.recordComposerInputToFrame).not.toHaveBeenCalled();

    recordComposerInputToFrame("claude", 15);
    await vi.waitFor(() => expect(diagnostics.registerRuntimePerformanceProvider).toHaveBeenCalledWith("thread", "claude"));
    expect(diagnostics.recordComposerInputToFrame).not.toHaveBeenCalled();

    for (let input = 16; input < 32; input += 1) recordComposerInputToFrame("claude", input);
    expect(diagnostics.recordComposerInputToFrame).toHaveBeenCalledWith("claude", 31);
  });
});

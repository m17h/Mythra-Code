import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForSignIn } from "./signInPolling";

describe("waitForSignIn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps probing until the provider reports signed in", async () => {
    const check = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const watch = waitForSignIn(check, { intervalMs: 1_000, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(watch).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("treats a failing probe as not signed in yet", async () => {
    const check = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("claude exited"))
      .mockResolvedValueOnce(true);
    const watch = waitForSignIn(check, { intervalMs: 1_000, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(watch).resolves.toBe(true);
  });

  it("gives up at the deadline without a further probe", async () => {
    const check = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const watch = waitForSignIn(check, { intervalMs: 1_000, timeoutMs: 2_500 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(watch).resolves.toBe(false);
    // t=0, 1s, 2s, then the 0.5s remainder elapses and the deadline is hit.
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("stops immediately when aborted and ignores a late signed-in result", async () => {
    const controller = new AbortController();
    let resolveProbe: ((value: boolean) => void) | undefined;
    const check = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveProbe = resolve; }));
    const watch = waitForSignIn(check, { intervalMs: 1_000, timeoutMs: 60_000, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
    controller.abort();
    resolveProbe?.(true);
    await expect(watch).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextUsageReset, USAGE_MIN_GAP_MS, USAGE_POLL_MS, useUsageRefresh } from "./useUsageRefresh";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("useUsageRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

  it("leaves the launch reading alone, then polls a visible window", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh }));
    await flush();
    // Connecting the account is what read it; a second read on launch would
    // only duplicate that one.
    expect(refresh).not.toHaveBeenCalled();
    for (let tick = 1; tick <= 3; tick += 1) {
      await act(async () => { vi.advanceTimersByTime(USAGE_POLL_MS); await Promise.resolve(); });
      expect(refresh).toHaveBeenCalledTimes(tick);
    }
  });

  it("does not read while the provider is not connected", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const { rerender } = renderHook((props: { enabled: boolean }) => useUsageRefresh({ key: "claude:me", enabled: props.enabled, refresh }), {
      initialProps: { enabled: false },
    });
    await act(async () => { vi.advanceTimersByTime(USAGE_POLL_MS * 5); await Promise.resolve(); });
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(refresh).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => { vi.advanceTimersByTime(USAGE_POLL_MS); await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("skips polls while the window is hidden and catches up on focus", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh }));
    setVisibility("hidden");
    await act(async () => { vi.advanceTimersByTime(USAGE_POLL_MS * 3); await Promise.resolve(); });
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of requests into one read", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh }));
    act(() => { result.current(); result.current(); result.current(); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(USAGE_MIN_GAP_MS + 1); await Promise.resolve(); });
    act(() => { result.current(); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("honours a forced request inside the burst window but never overlaps reads", async () => {
    let release = () => {};
    const refresh = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockImplementationOnce(() => new Promise<null>((resolve) => { release = () => resolve(null); }));
    const { result } = renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh }));
    act(() => { result.current(); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => { result.current({ force: true }); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);

    act(() => { result.current({ force: true }); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);

    await act(async () => { release(); await Promise.resolve(); });
  });

  it("re-reads immediately when the watched account changes", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const { rerender } = renderHook((props: { key: string }) => useUsageRefresh({ key: props.key, enabled: true, refresh }), {
      initialProps: { key: "claude:one" },
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    rerender({ key: "openai:two" });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reads again once a window rolls over", async () => {
    const refresh = vi.fn().mockResolvedValue(null);
    const resetsAt = Math.floor((Date.now() + 120_000) / 1000);
    renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh, resetsAt, pollMs: 10 * 60_000 }));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(130_000); await Promise.resolve(); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("survives a failing read and tries again on the next poll", async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(null);
    const { result } = renderHook(() => useUsageRefresh({ key: "claude:me", enabled: true, refresh }));
    act(() => { result.current(); });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(USAGE_POLL_MS); await Promise.resolve(); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("nextUsageReset", () => {
  const now = 1_700_000_000_000;

  it("returns the soonest future rollover", () => {
    expect(nextUsageReset([
      { resetsAt: now / 1000 + 3600 },
      { resetsAt: now / 1000 + 60 },
      { resetsAt: now / 1000 + 600 },
    ], now)).toBe(now / 1000 + 60);
  });

  it("ignores windows that have no reset time or already passed", () => {
    expect(nextUsageReset([{ resetsAt: null }, { resetsAt: now / 1000 - 10 }, {}], now)).toBeNull();
    expect(nextUsageReset([], now)).toBeNull();
  });
});

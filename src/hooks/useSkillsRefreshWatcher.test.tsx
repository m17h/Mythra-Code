import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillsRefreshWatcher } from "./useSkillsRefreshWatcher";

const visibility = (hidden: boolean) => Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("single Skills watcher", () => {
  beforeEach(() => { vi.useFakeTimers(); visibility(false); });
  afterEach(() => { vi.useRealTimers(); visibility(false); });

  it("does not supersede an explicit scan that starts before the watcher microtask", async () => {
    const refresh = vi.fn();
    let busy = false;
    renderHook(() => useSkillsRefreshWatcher({ folder: "/skills", pollMs: null, refresh, busy: () => busy }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      busy = true;
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    busy = false;
    await act(async () => { vi.advanceTimersByTime(500); window.dispatchEvent(new Event("focus")); });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("skips a focus refresh if the window hides before the watcher microtask", async () => {
    const refresh = vi.fn();
    renderHook(() => useSkillsRefreshWatcher({ folder: "/skills", pollMs: null, refresh }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      visibility(true);
    });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses one selected cadence, pauses unrelated/hidden surfaces, and preserves focus freshness", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = renderHook(({ pollMs }) => useSkillsRefreshWatcher({ folder: "/skills", pollMs, refresh }), { initialProps: { pollMs: 2_000 as number | null } });
    await flush();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(refresh).toHaveBeenCalledTimes(2);
    // Requests while the prior microtask is pending collapse into one read.
    view.rerender({ pollMs: 5_000 });
    await flush();
    refresh.mockClear();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
    view.rerender({ pollMs: null });
    refresh.mockClear();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(refresh).not.toHaveBeenCalled();
    visibility(true);
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    visibility(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("coalesces slow scans and explicit warmup, catches failures, and starts the new folder independently", async () => {
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockRejectedValue(new Error("scan unavailable"));
    let busy = true;
    const view = renderHook(({ folder }) => useSkillsRefreshWatcher({ folder, pollMs: 2_000, refresh, busy: () => busy }), { initialProps: { folder: "/old" } });
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    busy = false;
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(8_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender({ folder: "/new" });
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(refresh).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(10_000); window.dispatchEvent(new Event("focus")); });
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

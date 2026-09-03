import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleSettingsPreload } from "./settingsPreload";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(idleAvailable = true) {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  let callback: (() => void) | undefined;
  const request = vi.fn((fn: () => void) => { callback = fn; return 7; });
  const cancelIdle = vi.fn();
  vi.stubGlobal("requestIdleCallback", idleAvailable ? request : undefined);
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  const preload = vi.fn();
  const cancel = scheduleSettingsPreload(preload);
  return { preload, cancel, request, cancelIdle, idle: () => callback?.(), hide: (value: boolean) => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); } };
}

describe("Settings module prewarm", () => {
  it("waits until after launch and idle, runs once without a forced busy timeout", () => {
    const h = setup();
    vi.advanceTimersByTime(1999);
    expect(h.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.request).toHaveBeenCalledWith(expect.any(Function));
    expect(h.preload).not.toHaveBeenCalled();
    h.idle(); h.idle(); h.hide(true); h.hide(false);
    expect(h.preload).toHaveBeenCalledOnce();
    h.cancel();
  });
  it.each([false, true])("cancels before loading (idle queued: %s)", queued => {
    const h = setup();
    if (queued) vi.advanceTimersByTime(2000);
    h.cancel();
    vi.runAllTimers(); h.idle();
    expect(h.preload).not.toHaveBeenCalled();
    if (queued) expect(h.cancelIdle).toHaveBeenCalledWith(7);
  });
  it("rechecks visibility at execution and waits for a fresh idle callback", () => {
    const h = setup();
    vi.advanceTimersByTime(2000);
    h.hide(true); h.idle();
    expect(h.preload).not.toHaveBeenCalled();
    h.hide(false);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.preload).not.toHaveBeenCalled();
    h.idle();
    expect(h.preload).toHaveBeenCalledOnce();
    h.cancel();
  });
  it("does not queue work while hidden and removes its visibility listener on cancel", () => {
    const h = setup();
    h.hide(true); vi.advanceTimersByTime(2000);
    expect(h.request).not.toHaveBeenCalled();
    h.cancel(); h.hide(false);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("supports WebKit without idle callbacks and cancels the deferred fallback", () => {
    const h = setup(false);
    vi.advanceTimersByTime(2299);
    expect(h.preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.preload).toHaveBeenCalledOnce();
    h.cancel();
    const cancelled = setup(false);
    vi.advanceTimersByTime(2000); cancelled.cancel(); vi.runAllTimers();
    expect(cancelled.preload).not.toHaveBeenCalled();
  });
});

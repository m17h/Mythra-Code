import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  destroy: vi.fn(), invoke: vi.fn(), listen: vi.fn(), onCloseRequested: vi.fn(),
  cancel: undefined as undefined | ((event: { payload: { requestId: number } }) => void),
  close: undefined as undefined | (() => Promise<void>),
  pending: undefined as undefined | { requestId: number; phase: "saving" | "prompt" | "closing" },
  completed: [] as number[], prevented: [] as boolean[], registration: [] as string[],
  stopCancel: vi.fn(), stopClose: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { flushBeforeClose, useFlushOnClose } from "./useFlushOnClose";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const ready = () => act(async () => {});
async function close(requestId: number) {
  native.pending ??= { requestId, phase: "saving" };
  await act(async () => { await native.close?.(); });
}
function keepOpen(requestId: number) {
  native.pending = undefined;
  act(() => { native.cancel?.({ payload: { requestId } }); });
}
const finishCalls = () => native.invoke.mock.calls.filter(([command]) => command === "close_guard_finish");

beforeEach(() => {
  native.pending = undefined; native.cancel = undefined; native.close = undefined;
  native.completed = []; native.prevented = []; native.registration = [];
  native.destroy.mockReset().mockResolvedValue(undefined);
  native.stopCancel.mockReset(); native.stopClose.mockReset();
  native.listen.mockReset().mockImplementation(async (name: string, handler: typeof native.cancel) => {
    native.registration.push(name); native.cancel = handler;
    return native.stopCancel;
  });
  native.onCloseRequested.mockReset().mockImplementation(async (handler: (event: { preventDefault: () => void }) => unknown) => {
    native.registration.push("close");
    // The real Tauri API awaits the handler then destroys unless prevented.
    native.close = async () => {
      let prevented = false;
      const result = handler({ preventDefault: () => { prevented = true; } });
      native.prevented.push(prevented); // Check prevention before any await.
      await result;
      if (!prevented) await native.destroy();
    };
    return native.stopClose;
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args?: { requestId: number; result: string }) => {
    if (command === "close_guard_claim") {
      native.registration.push("claim");
      return native.pending?.phase === "saving" ? { requestId: native.pending.requestId } : null;
    }
    if (command === "close_guard_finish") {
      if (!args || native.pending?.requestId !== args.requestId || native.pending.phase !== "saving") return false;
      if (args.result === "saved") {
        native.pending.phase = "closing"; native.completed.push(args.requestId);
      } else if (args.result === "failed") native.pending.phase = "prompt";
      else if (args.result === "cancel") native.pending = undefined;
      return true;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => vi.useRealTimers());

it("registers cancellation before close and recovers a pending native request", async () => {
  native.pending = { requestId: 1, phase: "saving" };
  const flush = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await ready();
  expect(native.registration).toEqual(["mythra://close-cancelled", "close", "claim"]);
  expect(flush).toHaveBeenCalledOnce();
  expect(native.completed).toEqual([1]);
  expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
  expect(native.stopClose).toHaveBeenCalledOnce(); expect(native.stopCancel).toHaveBeenCalledOnce();
});

it("flushes the latest callback once and synchronously prevents every duplicate close", async () => {
  const save = deferred<void>();
  const oldFlush = vi.fn(); const flush = vi.fn(() => save.promise);
  const view = renderHook(({ callback }) => useFlushOnClose(callback, vi.fn()), { initialProps: { callback: oldFlush } });
  await ready(); view.rerender({ callback: flush });
  await close(2); await close(2);
  expect(native.prevented).toEqual([true, true]);
  expect(oldFlush).not.toHaveBeenCalled(); expect(flush).toHaveBeenCalledOnce();
  expect(finishCalls()).toEqual([]);
  await act(async () => { save.resolve(); });
  expect(finishCalls()).toEqual([["close_guard_finish", { requestId: 2, result: "saved" }]]);
  expect(native.completed).toEqual([2]); expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("hands a failed save to native consent and allows retry after Keep open", async () => {
  const flush = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  const onError = vi.fn(); const view = renderHook(() => useFlushOnClose(flush, onError));
  await ready(); await close(3);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  expect(finishCalls()).toEqual([["close_guard_finish", { requestId: 3, result: "failed", error: "Error: disk full" }]]);
  expect(native.pending?.phase).toBe("prompt");
  await close(3); expect(flush).toHaveBeenCalledOnce();
  keepOpen(3); await close(4);
  expect(native.completed).toEqual([4]); expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("still sends failed completion when the error-reporting callback throws", async () => {
  const view = renderHook(() => useFlushOnClose(
    vi.fn().mockRejectedValue(new Error("disk full")), () => { throw new Error("report unavailable"); },
  ));
  await ready(); await close(5);
  expect(finishCalls()).toEqual([["close_guard_finish", { requestId: 5, result: "failed", error: "Error: disk full" }]]);
  expect(native.pending?.phase).toBe("prompt"); expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("has no JS deadline and ignores a timed-out save after native Keep open", async () => {
  vi.useFakeTimers();
  const oldSave = deferred<void>(); const newSave = deferred<void>();
  const flush = vi.fn().mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await ready(); await close(6);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(finishCalls()).toEqual([]);
  native.pending!.phase = "prompt"; // The native watchdog owns this transition.
  keepOpen(6); await close(7);
  await act(async () => { oldSave.resolve(); }); expect(finishCalls()).toEqual([]);
  await act(async () => { newSave.resolve(); });
  expect(native.completed).toEqual([7]); expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("leaves native timeout consent in charge when a late save gets a false finish", async () => {
  const save = deferred<void>();
  const view = renderHook(() => useFlushOnClose(() => save.promise, vi.fn()));
  await ready(); await close(8); native.pending!.phase = "prompt";
  await act(async () => { save.resolve(); });
  expect(finishCalls()).toHaveLength(1); expect(native.completed).toEqual([]);
  expect(native.destroy).not.toHaveBeenCalled(); view.unmount();
});

it("coalesces claims and remembers Keep open while a claim response is delayed", async () => {
  const claim = deferred<{ requestId: number }>(); const flush = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await ready(); native.invoke.mockImplementationOnce(() => claim.promise);
  await close(9); await close(9);
  expect(native.invoke.mock.calls.filter(([command]) => command === "close_guard_claim")).toHaveLength(2); // Setup + one claim.
  keepOpen(9); await close(10);
  await act(async () => { claim.resolve({ requestId: 9 }); });
  expect(flush).toHaveBeenCalledOnce(); expect(native.completed).toEqual([10]);
  expect(finishCalls()).toEqual([["close_guard_finish", { requestId: 10, result: "saved" }]]);
  expect(native.prevented).toEqual([true, true, true]); view.unmount();
});

it("does not flush a cancelled claim when there is no second close", async () => {
  const claim = deferred<{ requestId: number }>(); const flush = vi.fn();
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await ready(); native.invoke.mockImplementationOnce(() => claim.promise);
  await close(11); keepOpen(11);
  await act(async () => { claim.resolve({ requestId: 11 }); });
  expect(flush).not.toHaveBeenCalled(); expect(finishCalls()).toEqual([]); view.unmount();
});

it("reclaims the same native request on remount without finishing from the old hook", async () => {
  const oldSave = deferred<void>(); const newSave = deferred<void>();
  const first = renderHook(() => useFlushOnClose(() => oldSave.promise, vi.fn()));
  await ready(); await close(12); first.unmount();
  const second = renderHook(() => useFlushOnClose(() => newSave.promise, vi.fn())); await ready();
  await act(async () => { oldSave.resolve(); }); expect(finishCalls()).toEqual([]);
  await act(async () => { newSave.resolve(); });
  expect(finishCalls()).toEqual([["close_guard_finish", { requestId: 12, result: "saved" }]]);
  expect(native.invoke.mock.calls.some(([, args]) => args?.result === "cancel")).toBe(false); second.unmount();
});

it("recovers pending work across StrictMode effect replacement", async () => {
  native.pending = { requestId: 13, phase: "saving" }; const flush = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()), { reactStrictMode: true });
  await ready(); expect(flush).toHaveBeenCalledOnce(); expect(native.completed).toEqual([13]);
  expect(native.stopCancel).toHaveBeenCalledOnce(); view.unmount();
});

it("cleans a cancellation listener whose registration resolves after unmount", async () => {
  const registration = deferred<() => void>(); const stop = vi.fn();
  native.listen.mockReturnValueOnce(registration.promise);
  const view = renderHook(() => useFlushOnClose(vi.fn(), vi.fn())); view.unmount();
  await act(async () => { registration.resolve(stop); });
  expect(stop).toHaveBeenCalledOnce(); expect(native.onCloseRequested).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
});

it("cleans a close listener whose registration resolves after unmount", async () => {
  const registration = deferred<() => void>(); const stop = vi.fn();
  native.onCloseRequested.mockReturnValueOnce(registration.promise);
  const view = renderHook(() => useFlushOnClose(vi.fn(), vi.fn())); await ready(); view.unmount();
  await act(async () => { registration.resolve(stop); });
  expect(stop).toHaveBeenCalledOnce(); expect(native.stopCancel).toHaveBeenCalledOnce();
  expect(native.invoke).not.toHaveBeenCalled();
});

it("reports registration failure and cleans the listener already registered", async () => {
  native.onCloseRequested.mockRejectedValueOnce(new Error("listener IPC unavailable"));
  const onError = vi.fn(); const view = renderHook(() => useFlushOnClose(vi.fn(), onError)); await ready();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("listener IPC unavailable"));
  expect(native.stopCancel).toHaveBeenCalledOnce(); expect(native.invoke).not.toHaveBeenCalled();
  view.unmount(); expect(native.stopCancel).toHaveBeenCalledOnce();
});

it("reports cancellation listener failure before installing close handling", async () => {
  native.listen.mockRejectedValueOnce(new Error("event IPC unavailable"));
  const onError = vi.fn(); const view = renderHook(() => useFlushOnClose(vi.fn(), onError)); await ready();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("event IPC unavailable"));
  expect(native.onCloseRequested).not.toHaveBeenCalled(); view.unmount();
});

it("prevents close and reports a rejected claim while the native watchdog stays armed", async () => {
  const onError = vi.fn(); const flush = vi.fn(); const view = renderHook(() => useFlushOnClose(flush, onError));
  await ready(); native.invoke.mockRejectedValueOnce(new Error("claim IPC unavailable")); await close(14);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("claim IPC unavailable"));
  expect(native.pending).toEqual({ requestId: 14, phase: "saving" }); expect(flush).not.toHaveBeenCalled();
  expect(native.prevented).toEqual([true]); expect(native.destroy).not.toHaveBeenCalled(); view.unmount();
});

it("reports a rejected finish without destroying or cancelling the native request", async () => {
  const onError = vi.fn(); const view = renderHook(() => useFlushOnClose(vi.fn().mockResolvedValue(undefined), onError));
  await ready(); const implementation = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation((command: string, args: unknown) => command === "close_guard_finish"
    ? Promise.reject(new Error("finish IPC unavailable")) : implementation(command, args));
  await close(15);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("finish IPC unavailable"));
  expect(native.pending?.phase).toBe("saving"); expect(native.destroy).not.toHaveBeenCalled(); view.unmount();
});

it("retains best-effort pagehide flushing with the latest callback and cleanup", async () => {
  const flush = vi.fn().mockRejectedValue(new Error("unavailable")); const newer = vi.fn().mockResolvedValue(undefined);
  const view = renderHook(({ callback }) => useFlushOnClose(callback, vi.fn()), { initialProps: { callback: flush } }); await ready();
  await act(async () => { window.dispatchEvent(new Event("pagehide")); }); view.rerender({ callback: newer });
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  expect(flush).toHaveBeenCalledOnce(); expect(newer).toHaveBeenCalledOnce(); view.unmount();
  await act(async () => { window.dispatchEvent(new Event("pagehide")); }); expect(newer).toHaveBeenCalledOnce();
});

it("flushes every independent store even when another rejects or throws synchronously", async () => {
  const metadata = vi.fn(async () => {});
  await expect(flushBeforeClose([
    () => { throw new Error("transcript unavailable"); },
    async () => { throw new Error("settings unavailable"); }, metadata,
  ])).rejects.toThrow("transcript unavailable; Error: settings unavailable");
  expect(metadata).toHaveBeenCalledOnce();
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  destroy: vi.fn(),
  onCloseRequested: vi.fn(),
  listen: vi.fn(),
  close: undefined as undefined | (() => Promise<void>),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  pending: 0,
  completed: [] as number[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

import { useFlushOnClose } from "./useFlushOnClose";

beforeEach(() => {
  native.close = undefined;
  native.pending = 0;
  native.completed = [];
  native.listeners.clear();
  native.destroy.mockReset().mockResolvedValue(undefined);
  native.listen.mockReset().mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, callback);
    if (name === "tauri://close-requested") native.close = async () => { callback({ payload: null }); };
    return () => { native.listeners.delete(name); };
  });
  // This mirrors @tauri-apps/api/window's real wrapper: it destroys the
  // window after the callback unless that callback prevents its default.
  native.onCloseRequested.mockReset().mockImplementation(async (callback: (event: { preventDefault: () => void }) => unknown) => {
    native.close = async () => {
      let prevented = false;
      await callback({ preventDefault: () => { prevented = true; } });
      if (!prevented) await native.destroy();
    };
    return vi.fn();
  });
  native.invoke.mockReset().mockImplementation(async (command: string, args?: { requestId: number; result: string }) => {
    if (command === "close_guard_claim") return native.pending ? { requestId: native.pending } : null;
    if (command === "close_guard_finish") {
      if (!args || args.requestId !== native.pending) return false;
      if (args.result === "saved") {
        native.completed.push(args.requestId);
        native.pending = 0;
      } else if (args.result === "cancel") native.pending = 0;
      return true;
    }
    return undefined;
  });
});

async function close(requestId: number): Promise<void> {
  native.pending = requestId;
  await act(async () => { await native.close?.(); });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

it("lets native completion own a saved close without the Tauri JS helper destroying", async () => {
  const view = renderHook(() => useFlushOnClose(vi.fn().mockResolvedValue(undefined), vi.fn()));
  await act(async () => {});
  await close(11);
  expect(native.completed).toEqual([11]);
  expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("keeps failed saves under native consent even after the JS close callback returns", async () => {
  const view = renderHook(() => useFlushOnClose(vi.fn().mockRejectedValue(new Error("disk full")), vi.fn()));
  await act(async () => {});
  await close(21);
  expect(native.invoke).toHaveBeenCalledWith("close_guard_finish", expect.objectContaining({ requestId: 21, result: "failed" }));
  expect(native.completed).toEqual([]);
  expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("cannot complete a retry with the stale save from a native Keep open decision", async () => {
  const first = deferred();
  const second = deferred();
  const flush = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await act(async () => {});
  await close(31);
  native.pending = 0;
  act(() => { native.listeners.get("mythra://close-cancelled")?.({ payload: { requestId: 31 } }); });
  await close(32);
  await act(async () => { first.resolve(); });
  expect(native.completed).toEqual([]);
  expect(native.destroy).not.toHaveBeenCalled();
  await act(async () => { second.resolve(); });
  expect(native.completed).toEqual([32]);
  expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

it("reclaims a new close that arrives before the previous Keep open notification", async () => {
  const first = deferred();
  const second = deferred();
  const flush = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  await act(async () => {});
  await close(41);
  // The native dialog callback has cancelled 41; its JS notification is
  // queued, while another user close has already created native request 42.
  await close(42);
  await act(async () => { native.listeners.get("mythra://close-cancelled")?.({ payload: { requestId: 41 } }); });
  expect(flush).toHaveBeenCalledTimes(2);
  await act(async () => { first.resolve(); });
  expect(native.completed).toEqual([]);
  await act(async () => { second.resolve(); });
  expect(native.completed).toEqual([42]);
  expect(native.destroy).not.toHaveBeenCalled();
  view.unmount();
});

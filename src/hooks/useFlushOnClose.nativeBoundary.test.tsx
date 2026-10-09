import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

import { useFlushOnClose } from "./useFlushOnClose";
import { flushPendingStateWrites, loadStored, resetStorageMemoryForTests, storeValue } from "../lib/storage";

beforeEach(() => {
  resetStorageMemoryForTests();
  localStorage.clear();
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

afterEach(async () => {
  native.invoke.mockResolvedValue(undefined);
  await flushPendingStateWrites();
  resetStorageMemoryForTests();
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

it("retries the actual failed state revision after native Keep open and completes only the saved close", async () => {
  const protocol = native.invoke.getMockImplementation()!;
  let stateUnavailable = true;
  native.invoke.mockImplementation(async (command: string, args) => {
    if (command === "state_write") {
      if (stateUnavailable) throw new Error("private database path and sensitive diagnostic");
      return undefined;
    }
    return protocol(command, args);
  });
  const reportError = vi.fn();
  const view = renderHook(() => useFlushOnClose(flushPendingStateWrites, reportError));
  await act(async () => {});
  storeValue("kiwi.settings", { model: "latest saved revision", systemPrompt: "private saved content" });
  await close(51);
  expect(native.invoke).toHaveBeenCalledWith("close_guard_finish", expect.objectContaining({ requestId: 51, result: "failed" }));
  expect(native.completed).toEqual([]);
  expect(reportError).toHaveBeenCalledWith(expect.stringContaining("kiwi.settings"));
  expect(String(reportError.mock.calls)).not.toContain("private database path");
  expect(String(reportError.mock.calls)).not.toContain("private saved content");

  native.pending = 0;
  act(() => native.listeners.get("mythra://close-cancelled")?.({ payload: { requestId: 51 } }));
  expect(loadStored("kiwi.settings", {})).toEqual({ model: "latest saved revision", systemPrompt: "private saved content" });
  const writesBeforeRetry = native.invoke.mock.calls.filter(([command]) => command === "state_write").length;
  stateUnavailable = false;
  await close(52);
  expect(native.invoke.mock.calls.filter(([command]) => command === "state_write")).toHaveLength(writesBeforeRetry + 1);
  expect(native.invoke).toHaveBeenCalledWith("state_write", { key: "kiwi.settings", value: { model: "latest saved revision", systemPrompt: "private saved content" } });
  expect(localStorage.getItem("kiwi.nativePending.kiwi.settings")).toBeNull();
  expect(native.completed).toEqual([52]);
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

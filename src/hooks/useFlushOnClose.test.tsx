import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  destroy: vi.fn(),
  onCloseRequested: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
import { useFlushOnClose } from "./useFlushOnClose";
beforeEach(() => {
  native.destroy.mockReset().mockResolvedValue(undefined);
  native.onCloseRequested.mockReset().mockResolvedValue(vi.fn());
});
it("prevents closing until the latest writes finish and ignores duplicate close clicks", async () => {
  let release!: () => void;
  const flush = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const view = renderHook(() => useFlushOnClose(flush, vi.fn()));
  const event = { preventDefault: vi.fn() };
  const closeRequested = native.onCloseRequested.mock.calls[0][0];
  act(() => { closeRequested(event); closeRequested(event); });
  expect(flush).toHaveBeenCalledTimes(1);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(native.destroy).not.toHaveBeenCalled();
  await act(async () => { release(); });
  expect(native.destroy).toHaveBeenCalledTimes(1);
  view.unmount();
});
it("keeps the window open after a failed save and allows retry", async () => {
  const flush = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  const onError = vi.fn();
  const view = renderHook(() => useFlushOnClose(flush, onError));
  const closeRequested = native.onCloseRequested.mock.calls[0][0];
  await act(async () => closeRequested({ preventDefault: vi.fn() }));
  expect(native.destroy).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  await act(async () => closeRequested({ preventDefault: vi.fn() }));
  expect(native.destroy).toHaveBeenCalledTimes(1);
  view.unmount();
});

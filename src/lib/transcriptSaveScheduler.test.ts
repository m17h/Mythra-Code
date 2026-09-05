import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTranscriptSaveScheduler } from "./transcriptSaveScheduler";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup(save = vi.fn(async () => true)) {
  const dirty = vi.fn();
  const onError = vi.fn();
  return { save, dirty, onError, scheduler: createTranscriptSaveScheduler({ save, dirty, onError }) };
}
it("saves continuous output within five seconds instead of waiting for silence", async () => {
  const { scheduler, save } = setup();
  for (let index = 0; index < 50; index++) {
    scheduler.schedule("thread");
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(save).toHaveBeenCalledTimes(1);
  scheduler.dispose();
});
it("does not clear dirty state for changes arriving during an older write", async () => {
  let release!: (saved: boolean) => void;
  const save = vi.fn(async () => true).mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  const { scheduler, dirty } = setup(save);
  scheduler.schedule("thread");
  await vi.advanceTimersByTimeAsync(900);
  scheduler.schedule("thread");
  release(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(dirty).not.toHaveBeenCalledWith("thread", false);
  await scheduler.flushAll();
  expect(save).toHaveBeenCalledTimes(2);
  expect(dirty).toHaveBeenLastCalledWith("thread", false);
  scheduler.dispose();
});
it("flushes pending work immediately and keeps failed saves dirty for retry", async () => {
  const save = vi.fn(async () => true).mockRejectedValueOnce(new Error("disk unavailable"));
  const { scheduler, dirty } = setup(save);
  scheduler.schedule("thread");
  await expect(scheduler.flushAll()).rejects.toThrow("disk unavailable");
  expect(dirty).not.toHaveBeenCalledWith("thread", false);
  await scheduler.flushAll();
  expect(dirty).toHaveBeenLastCalledWith("thread", false);
  scheduler.dispose();
});
it("cancels a deleted thread without resurrecting its write", async () => {
  const { scheduler, save } = setup();
  scheduler.schedule("thread");
  scheduler.cancel("thread");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(save).not.toHaveBeenCalled();
});

it("allows shutdown to finish while a provider keeps producing newer output", async () => {
  let release!: (saved: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
  const { scheduler, dirty } = setup(save);
  scheduler.schedule("thread");
  const closing = scheduler.flushAll();
  await vi.advanceTimersByTimeAsync(0);
  scheduler.schedule("thread");
  release(true);
  await closing;
  expect(save).toHaveBeenCalledTimes(1);
  expect(dirty).not.toHaveBeenCalledWith("thread", false);
  scheduler.dispose();
});

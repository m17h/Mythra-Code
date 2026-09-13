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
it("stops automatic retry after bounded backoff and permits an explicit retry", async () => {
  let available = false;
  const save = vi.fn(async () => {
    if (!available) throw new Error("disk unavailable");
    return true;
  });
  const { scheduler, dirty, onError } = setup(save);
  scheduler.schedule("thread");

  await vi.advanceTimersByTimeAsync(900);
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_799);
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3_600);
  expect(save).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(save).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledTimes(3);
  expect(dirty).not.toHaveBeenCalledWith("thread", false);

  available = true;
  await scheduler.flushAll();
  expect(save).toHaveBeenCalledTimes(4);
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

it("saves final updates and newly dirty threads that arrive during close", async () => {
  let release!: (saved: boolean) => void;
  const save = vi.fn(async () => true).mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
  const { scheduler, dirty } = setup(save);
  scheduler.schedule("thread");
  const closing = scheduler.flushAll();
  await vi.advanceTimersByTimeAsync(0);
  scheduler.schedule("thread");
  scheduler.schedule("other-thread");
  release(true);
  await closing;
  expect(save).toHaveBeenCalledTimes(3);
  expect(dirty).toHaveBeenCalledWith("thread", false);
  expect(dirty).toHaveBeenCalledWith("other-thread", false);
  scheduler.dispose();
});
it("requires an explicit discard choice if output never settles within bounded close passes", async () => {
  const save = vi.fn(async () => { scheduler.schedule("thread"); return true; });
  const { scheduler, dirty } = setup(save);
  scheduler.schedule("thread");
  await expect(scheduler.flushAll()).rejects.toThrow("Messages are still arriving");
  expect(save).toHaveBeenCalledTimes(3);
  expect(dirty).not.toHaveBeenCalledWith("thread", false);
  scheduler.dispose();
});
it("does not swallow a failed in-flight save after its entry is cancelled", async () => {
  let reject!: (reason: Error) => void;
  const save = vi.fn(() => new Promise<boolean>((_, fail) => { reject = fail; }));
  const { scheduler } = setup(save);
  scheduler.schedule("thread");
  const closing = scheduler.flushAll();
  const rejected = expect(closing).rejects.toThrow("disk failed");
  await vi.advanceTimersByTimeAsync(0);
  scheduler.cancel("thread");
  reject(new Error("disk failed"));
  await rejected;
  scheduler.dispose();
});
it("drains final updates on healthy threads even when another transcript fails", async () => {
  let scheduler!: ReturnType<typeof createTranscriptSaveScheduler>;
  let healthySaves = 0;
  const save = vi.fn(async (id: string) => {
    if (id === "failed") throw new Error("locked transcript");
    if (++healthySaves === 1) scheduler.schedule("healthy");
    return true;
  });
  const dirty = vi.fn();
  scheduler = createTranscriptSaveScheduler({ save, dirty, onError: vi.fn() });
  scheduler.schedule("failed"); scheduler.schedule("healthy");
  await expect(scheduler.flushAll()).rejects.toThrow("locked transcript");
  expect(healthySaves).toBe(2);
  expect(dirty).toHaveBeenCalledWith("healthy", false);
  expect(dirty).not.toHaveBeenCalledWith("failed", false);
  scheduler.dispose();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { stopWithChildren, waitForRootCutoff } from "./stopWithChildren";

beforeEach(() => resetTaskStore());
afterEach(() => vi.useRealTimers());

describe("root and descendant cutoff", () => {
  it("sends initial cutoffs in parallel and sweeps children born before root cutoff returns", async () => {
    let finishRoot!: () => void;
    let lateChild = false;
    const stopRoot = vi.fn(() => new Promise<void>((resolve) => { finishRoot = () => { lateChild = true; resolve(); }; }));
    const cancelChildren = vi.fn(async () => { lateChild = false; });
    const confirm = vi.fn(async () => {});
    const stopping = stopWithChildren(stopRoot, cancelChildren, confirm);
    expect(stopRoot).toHaveBeenCalledTimes(1);
    expect(cancelChildren).toHaveBeenCalledTimes(1);
    finishRoot();
    expect(await stopping).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cancelChildren).toHaveBeenCalledTimes(2);
    expect(lateChild).toBe(false);
  });

  it("preserves initial and final cleanup failures", async () => {
    const initialError = new Error("first child cutoff failed");
    const finalError = new Error("late child cutoff failed");
    const cancel = vi.fn().mockRejectedValueOnce(initialError).mockRejectedValueOnce(finalError);
    expect(await stopWithChildren(async () => {}, cancel, async () => {})).toEqual([initialError, finalError]);
  });

  it("never claims a final sweep after a failed or unconfirmed root cutoff", async () => {
    const cancel = vi.fn(async () => {});
    const confirm = vi.fn(async () => {});
    const error = new Error("root cutoff failed");
    expect(await stopWithChildren(async () => { throw error; }, cancel, confirm)).toEqual([error]);
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await stopWithChildren(async () => false, cancel, confirm)).toEqual([expect.objectContaining({ message: "The parent turn's stop was not confirmed." })]);
  });

  it("waits for a cancelled in-flight root start to settle before final cleanup", async () => {
    const store = useTaskStore.getState();
    store.ensureTask("root", "/tmp/project");
    store.setTaskStatus("root", "starting");
    let confirmed = false;
    const waiting = waitForRootCutoff("root").then(() => { confirmed = true; });
    await Promise.resolve();
    expect(confirmed).toBe(false);
    store.setTaskStatus("root", "interrupted");
    await waiting;
    expect(confirmed).toBe(true);
  });

  it("reports an unconfirmed pending cutoff within the bounded wait", async () => {
    vi.useFakeTimers();
    useTaskStore.getState().ensureTask("root", "/tmp/project");
    useTaskStore.getState().setTaskStatus("root", "starting");
    const waiting = expect(waitForRootCutoff("root", 10)).rejects.toThrow("still stopping");
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
  });
});

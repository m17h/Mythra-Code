import { describe, expect, it, vi } from "vitest";
import { modelCatalogRecentlyRefreshed, shareModelRefresh, type ModelRefreshState } from "./modelCatalogRefresh";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("model catalog refresh coordination", () => {
  it("coalesces routine reads and queues exactly one manual guarded read after routine discovery", async () => {
    const state: ModelRefreshState<string> = {};
    const routine = deferred<string[]>();
    const readRoutine = vi.fn(() => routine.promise);
    const guarded = vi.fn(async () => ["new-runtime-model"]);
    const first = shareModelRefresh(state, "account", readRoutine);
    expect(shareModelRefresh(state, "account", readRoutine)).toBe(first);
    const manual = shareModelRefresh(state, "account", guarded, "manual");
    expect(shareModelRefresh(state, "account", guarded, "manual")).toBe(manual);
    expect(guarded).not.toHaveBeenCalled();
    routine.resolve(["old-runtime-model"]);
    expect(await manual).toEqual(["new-runtime-model"]);
    expect(readRoutine).toHaveBeenCalledTimes(1);
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(state.pending).toBeUndefined();
    expect(state.lastSuccess?.key).toBe("account");
  });

  it("does not run an obsolete queued manual refresh or publish old freshness after account invalidation", async () => {
    const state: ModelRefreshState<string> = {};
    const routine = deferred<string[]>();
    const guarded = vi.fn(async () => ["old-account"]);
    void shareModelRefresh(state, "old", () => routine.promise);
    const manual = shareModelRefresh(state, "old", guarded, "manual");
    state.pending = undefined;
    await shareModelRefresh(state, "new", async () => ["new-account"]);
    routine.resolve(["old-account"]);
    expect(await manual).toEqual([]);
    expect(guarded).not.toHaveBeenCalled();
    expect(state.lastSuccess?.key).toBe("new");
  });

  it("never reuses future-clock or different-account success, and bounds launch reuse to 30 seconds", () => {
    const state: ModelRefreshState<string> = { lastSuccess: { key: "account", at: 100_000 } };
    expect(modelCatalogRecentlyRefreshed(state, "account", 99_999)).toBe(false);
    expect(modelCatalogRecentlyRefreshed(state, "other", 100_001)).toBe(false);
    expect(modelCatalogRecentlyRefreshed(state, "account", 100_000)).toBe(true);
    expect(modelCatalogRecentlyRefreshed(state, "account", 129_999)).toBe(true);
    expect(modelCatalogRecentlyRefreshed(state, "account", 130_000)).toBe(false);
  });
});

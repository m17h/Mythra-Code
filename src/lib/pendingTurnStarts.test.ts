import { describe, expect, it } from "vitest";
import { PendingTurnStarts } from "./pendingTurnStarts";

describe("PendingTurnStarts", () => {
  it("cancels the exact in-flight start it was asked to stop", () => {
    const starts = new PendingTurnStarts();
    const pending = starts.begin("thread-a");
    expect(starts.requestCancel("thread-a")).toBe(true);
    expect(starts.finish("thread-a", pending)).toBe(true);
  });

  it("records nothing when stopping a thread with no start in flight", () => {
    // Regression: thread A is starting, the user navigates to thread B and
    // presses Stop. The old Set-based intent bricked B's next send; now the
    // stop must be a no-op because B has no pending start.
    const starts = new PendingTurnStarts();
    const pendingA = starts.begin("thread-a");
    expect(starts.requestCancel("thread-b")).toBe(false);

    // Thread A keeps running (its stop was never requested)...
    expect(starts.finish("thread-a", pendingA)).toBe(false);

    // ...and a later send in thread B is not silently cancelled.
    const pendingB = starts.begin("thread-b");
    expect(starts.finish("thread-b", pendingB)).toBe(false);
  });

  it("does not leak an intent across sequential starts of the same thread", () => {
    const starts = new PendingTurnStarts();
    const first = starts.begin("thread-a");
    starts.requestCancel("thread-a");
    expect(starts.finish("thread-a", first)).toBe(true);

    const second = starts.begin("thread-a");
    expect(starts.finish("thread-a", second)).toBe(false);
  });

  it("keeps a newer overlapping start when an older one settles late", () => {
    const starts = new PendingTurnStarts();
    const stale = starts.begin("thread-a");
    const fresh = starts.begin("thread-a");
    expect(starts.finish("thread-a", stale)).toBe(false);
    // The fresh start is still cancellable after the stale one settled.
    expect(starts.requestCancel("thread-a")).toBe(true);
    expect(starts.finish("thread-a", fresh)).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { parseClaudeContinuation, useClaudeContinuationStore } from "./claudeContinuation";

const event = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info });

describe("Claude subscription wrap-up telemetry", () => {
  beforeEach(() => useClaudeContinuationStore.setState({ byThread: {} }));

  it("recognizes only the explicit active allowance, without needing utilization", () => {
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: true, resetsAt: 2000 }), 1000))
      .toEqual({ kind: "grace", expiresAt: 2_000_000 });
    expect(parseClaudeContinuation(event({ status: "allowed_warning", utilization: 1.1, rateLimitType: "five_hour" }))).toBeNull();
  });

  it("does not mistake offered paid credits for credits being consumed", () => {
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: true, overageStatus: "allowed" })))
      .toEqual({ kind: "grace" });
    expect(parseClaudeContinuation(event({ status: "allowed", overageStatus: "allowed", canUserPurchaseCredits: true }))).toBeNull();
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: true, overageInUse: true })))
      .toEqual({ kind: "paid" });
  });

  it("distinguishes included model-specific usage from paid extra usage", () => {
    expect(parseClaudeContinuation(event({ status: "allowed", isUsingOverage: true, rateLimitType: "seven_day_overage_included" }))).toBeNull();
    expect(parseClaudeContinuation(event({ status: "allowed", isUsingOverage: true, rateLimitType: "overage" }))).toEqual({ kind: "paid" });
  });

  it("clears rejected and expired signals even when the CLI retains the flag", () => {
    expect(parseClaudeContinuation(event({ status: "rejected", rateLimitGraceActive: true, overageInUse: true }))).toBeNull();
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: true, resetsAt: 1 }), 1000)).toBeNull();
  });

  it("ignores malformed and unknown events rather than inventing permission", () => {
    for (const value of [null, [], {}, event({}), event({ status: "future", rateLimitGraceActive: true })]) {
      expect(parseClaudeContinuation(value)).toBeUndefined();
    }
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: "true" }))).toBeNull();
    expect(parseClaudeContinuation(event({ status: "allowed", rateLimitGraceActive: true, resetsAt: "2000" })))
      .toEqual({ kind: "grace" });
  });

  it("isolates concurrent threads and ignores late cleanup for a retired turn", () => {
    const store = useClaudeContinuationStore.getState();
    store.update("a", "new", { kind: "grace" });
    store.update("b", "other", { kind: "paid" });
    store.clear("a", "old");
    store.update("a", "old", null);
    expect(useClaudeContinuationStore.getState().byThread.a).toEqual({ kind: "grace", turnId: "new" });
    store.clear("a", "new");
    expect(useClaudeContinuationStore.getState().byThread.a).toBeUndefined();
    expect(useClaudeContinuationStore.getState().byThread.b.kind).toBe("paid");
  });
});

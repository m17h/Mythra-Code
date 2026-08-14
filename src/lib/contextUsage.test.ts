import { describe, expect, it } from "vitest";
import { contextUsagePercent } from "./contextUsage";

describe("contextUsagePercent", () => {
  it("uses current context occupancy instead of cumulative thread tokens", () => {
    expect(contextUsagePercent({ contextTokens: 20_000, contextWindow: 200_000 })).toBe(10);
  });

  it("does not invent pressure from a provider's cumulative usage", () => {
    expect(contextUsagePercent({ contextWindow: 200_000 })).toBeNull();
  });

  it("caps provider values at a full window", () => {
    expect(contextUsagePercent({ contextTokens: 250_000, contextWindow: 200_000 })).toBe(100);
  });
});

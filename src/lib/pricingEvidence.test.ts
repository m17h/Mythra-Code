import { describe, expect, it } from "vitest";
import { parseRateEpochs } from "./pricingEvidence";

describe("historical pricing evidence retention", () => {
  it("keeps evidence across more than four successive price periods", () => {
    const start = Date.parse("2026-01-01T00:00:00Z");
    const epochs = Array.from({ length: 5 }, (_, index) => {
      const at = start + index * 86_400_000;
      return [at, at + 3_600_000, index + 1, 10, null, null, null, 0];
    });
    const parsed = parseRateEpochs({ "openai:gpt-6-sol": epochs });
    expect(parsed["openai:gpt-6-sol"]).toHaveLength(5);
    expect(parsed["openai:gpt-6-sol"][0][2]).toBe(1);
  });
});

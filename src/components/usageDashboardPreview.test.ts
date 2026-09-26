import { describe, expect, it } from "vitest";
import { previewUsageSource } from "./usageDashboardPreview";

describe("usage dashboard preview", () => {
  it("keeps earlier totals under the original provider without anonymous duplicates", () => {
    const detail = previewUsageSource().detail(null);
    expect(detail.providers.map((provider) => provider.provider)).toEqual([
      "claude", "openai", "cursor", "openrouter", "unknown",
    ]);
    expect(detail.providers.find((provider) => provider.provider === "openai")?.earlier?.totalTokens).toBe(3_250_000);
    expect(detail.providers.find((provider) => provider.provider === "claude")?.earlier?.totalTokens).toBe(1_930_000);
  });
});

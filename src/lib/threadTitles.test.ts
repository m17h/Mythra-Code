import { describe, expect, it } from "vitest";
import { cleanThreadTitle, resolveThreadTitleModel } from "./threadTitles";
const catalog = (...ids: string[]) => ({ openai: ids.map((id) => ({ id, label: id })) });
describe("thread title model choice", () => {
  it("defaults to known Luna and follows a newer Luna only when actually advertised", () => {
    expect(resolveThreadTitleModel("openai", "", {})).toBe("gpt-5.6-luna");
    expect(resolveThreadTitleModel("openai", "", catalog("gpt-5.6-luna", "gpt-6-astra"))).toBe("gpt-5.6-luna");
    expect(resolveThreadTitleModel("openai", "", catalog("gpt-5.6-luna", "gpt-6-luna"))).toBe("gpt-6-luna");
    expect(resolveThreadTitleModel("openai", "", catalog("gpt-6-astra"))).toBeNull();
    expect(resolveThreadTitleModel("openai", "", catalog("gpt-5.9-luna", "gpt-5.10-luna"))).toBe("gpt-5.10-luna");
  });
  it("honors a specific model without upgrading it or silently switching providers", () => {
    expect(resolveThreadTitleModel("openai", "gpt-5.6-luna", catalog("gpt-5.6-luna", "gpt-6-luna"))).toBe("gpt-5.6-luna");
    expect(resolveThreadTitleModel("claude", "claude-sonnet-5", {})).toBe("claude-sonnet-5");
    expect(resolveThreadTitleModel("lmstudio", "", {})).toBeNull();
    expect(resolveThreadTitleModel("cursor", "custom-id", { cursor: [{ id: "auto", label: "Auto" }] })).toBe("custom-id");
  });
  it("rejects oversized, empty and non-string model output", () => {
    expect(cleanThreadTitle("  Fix\n sidebar scrolling ")).toBe("Fix sidebar scrolling");
    expect(cleanThreadTitle("x".repeat(81))).toBeNull();
    expect(cleanThreadTitle({ title: "no" })).toBeNull();
    expect(cleanThreadTitle("")).toBeNull();
  });
});

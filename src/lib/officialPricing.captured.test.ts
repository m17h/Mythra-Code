import { describe, expect, it } from "vitest";
import { parseAnthropicPricing, parseCursorPricing, parseOpenAIPricing } from "./officialPricing";
import { pricingForModel, pricingModelKeys, resetUsageLedgerCache } from "./usageLedger";

/**
 * Parses real pricing pages captured by the native live check
 * (`npm run test:rust -- capture_pricing_pages -- --ignored`, which writes them
 * to node_modules/.cache/pricing). Skipped when no capture exists, so CI never
 * depends on the network.
 */
const captured = import.meta.glob<string>("../../node_modules/.cache/pricing/*.md", { query: "?raw", import: "default", eager: true });
const page = (name: string) => Object.entries(captured).find(([path]) => path.endsWith(`/${name}.md`))?.[1];

describe.skipIf(!page("openai") || !page("anthropic") || !page("cursor"))("captured official pricing pages", () => {
  it("reads OpenAI's standard short-context rates", () => {
    const result = parseOpenAIPricing(page("openai")!, "2026-09-25");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    console.info("openai", Object.keys(result.models).length, "models,", result.skipped, "skipped");
    expect(result.models["gpt-6-sol"]).toMatchObject({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 });
  });

  it("reads Claude's base rates with the 5-minute cache write", () => {
    const result = parseAnthropicPricing(page("anthropic")!, "2026-09-25");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    console.info("anthropic", Object.keys(result.models), result.skipped, "skipped");
    expect(result.models["claude-opus-5-5"]).toMatchObject({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 });
  });

  it("reads Cursor's per-model rates", () => {
    const result = parseCursorPricing(page("cursor")!, "2026-09-25");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    console.info("cursor", Object.keys(result.models).length, "models,", result.skipped, "skipped");
    expect(result.models).not.toHaveProperty("auto");
    expect(result.models["grok 4.5"]).toMatchObject({ input: 2, cacheRead: 0.5, output: 6 });
    expect(result.models["grok 4.5"].cacheWrite).toBeUndefined();
  });

  it("agrees with every bundled rate the pages still list", () => {
    resetUsageLedgerCache();
    localStorage.clear();
    const openai = parseOpenAIPricing(page("openai")!, "2026-09-25");
    const anthropic = parseAnthropicPricing(page("anthropic")!, "2026-09-25");
    if (!openai.ok || !anthropic.ok) throw new Error("capture did not parse");
    const differences: string[] = [];
    for (const key of pricingModelKeys()) {
      const [provider, model] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      const live = (provider === "openai" ? openai : anthropic).models[model];
      const bundled = pricingForModel(provider as "openai" | "claude", model);
      if (!live || !bundled) continue;
      const same = live.input === bundled.inputPerMillion && live.output === bundled.outputPerMillion
        && live.cacheRead === bundled.cachedInputPerMillion && live.cacheWrite === bundled.cacheWriteInputPerMillion;
      if (!same) differences.push(`${key}: page ${JSON.stringify(live)} vs bundled ${JSON.stringify(bundled)}`);
    }
    expect(differences).toEqual([]);
  });
});

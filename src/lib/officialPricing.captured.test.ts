import { describe, expect, it } from "vitest";
import { parseAnthropicPricing, parseCursorPricing, parseOpenAIPricing, recordOfficialPricingResult, refreshOfficialPricing } from "./officialPricing";
import { OFFICIAL_PRICING_KEY, pricingForModel, pricingModelKeys, resetUsageLedgerCache } from "./usageLedger";
import { frontierPricingSnapshot } from "./frontierPricing";
import { resetStorageMemoryForTests } from "./storage";

/**
 * Parses real pricing pages captured by the native live check
 * (`npm run test:rust -- capture_pricing_pages -- --ignored`, which writes them
 * to node_modules/.cache/pricing). Skipped when no capture exists, so CI never
 * depends on the network.
 */
const captured = import.meta.glob<string>("../../node_modules/.cache/pricing/*.md", { query: "?raw", import: "default", eager: true });
const page = (name: string) => Object.entries(captured).find(([path]) => path.endsWith(`/${name}.md`))?.[1];

describe.skipIf(!page("openai") || !page("anthropic"))("captured frontier pricing catalog", () => {
  it("reads every published flagship Standard row with exact short and long prices", () => {
    const result = parseOpenAIPricing(page("openai")!, "2026-10-09", { includeLongContext: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // Independently compare the actual numeric table cells to the parsed rows.
    const section = page("openai")!.split("### Standard pricing data\n")[1].split("### Batch pricing data")[0];
    const rows = section.split("\n").filter((line) => /^\| (?:gpt|o\d|davinci|babbage)[a-z0-9.-]*[ |]/.test(line));
    expect(rows.length).toBeGreaterThan(30);
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
      const id = cells[0].replace(/\s*\(<\d+K context length\)$/, "");
      const amount = (cell: string) => cell === "-" ? undefined : Number(cell.replace("$", ""));
      const parsed = result.models[id];
      expect(parsed, id).toBeDefined();
      expect([parsed.input, parsed.cacheRead, parsed.cacheWrite, parsed.output], id).toEqual(cells.slice(1, 5).map(amount));
      if (cells[5] !== "-") {
        expect(parsed.longContext, id).toBeDefined();
        expect([parsed.longContext!.input, parsed.longContext!.cacheRead, parsed.longContext!.cacheWrite, parsed.longContext!.output], id)
          .toEqual(cells.slice(5, 9).map(amount));
      } else expect(parsed.longContext, id).toBeUndefined();
    }
    expect(result.models["gpt-6.1-sol"]).toMatchObject({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });
  });

  it("includes the current Claude flagship models and both Haiku 5.5 price bands", () => {
    localStorage.clear();
    resetStorageMemoryForTests();
    resetUsageLedgerCache();
    const result = parseAnthropicPricing(page("anthropic")!, "2026-10-09");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.models["claude-sonnet-5-5"]).toMatchObject({ input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 });
    expect(result.models["claude-haiku-5-5"]).toMatchObject({
      input: 0.1, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5,
      longContext: { input: 0.5, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    });
    recordOfficialPricingResult("anthropic", result, Date.parse("2026-10-09T12:00:00Z"));
    expect(frontierPricingSnapshot().entries.find((entry) => entry.id === "claude-haiku-5-5")).toMatchObject({
      inputPerMillion: 0.1, outputPerMillion: 0.5,
      longContext: { inputPerMillion: 0.5, outputPerMillion: 2.5, cachedInputPerMillion: 0.05, cacheWrite1hInputPerMillion: 1 },
    });
  });

  it("matches every current Claude model table row to the actual published prices", () => {
    const result = parseAnthropicPricing(page("anthropic")!, "2026-10-09", { includeCatalogDetails: true });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const rows = page("anthropic")!.split("The following table shows pricing for all Claude models:")[1]
      .split("\n\n").find((block) => block.trim().startsWith("| Model"))!.split("\n").filter((line) => /^\| Claude /.test(line));
    let compared = 0;
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
      const match = /^Claude ([A-Za-z]+) ([3-9]\d*)(?:\.(\d+))?/.exec(cells[0]);
      expect(match, cells[0]).not.toBeNull();
      if (!match) continue;
      const id = Number(match[2]) === 3 ? `claude-3-${match[3] ? `${match[3]}-` : ""}${match[1].toLowerCase()}`
        : `claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ""}`;
      const rate = cells[0].includes("for prompts over") ? result.models[id]?.longContext : result.models[id];
      expect(rate, cells[0]).toBeDefined();
      const amounts = cells.slice(1).map((cell) => Number(/^\$(\d+(?:\.\d+)?)/.exec(cell)![1]));
      expect([rate!.input, rate!.cacheWrite, rate!.cacheWrite1h, rate!.cacheRead, rate!.output], cells[0]).toEqual(amounts);
      compared += 1;
    }
    expect(compared).toBe(rows.length);
  });

  it("includes published OpenAI specialist prices while retaining the existing ledger model scope", async () => {
    localStorage.clear();
    resetStorageMemoryForTests();
    resetUsageLedgerCache();
    const outcome = await refreshOfficialPricing({ force: true, fetchDocument: async (source) => page(source)!, now: () => Date.parse("2026-10-09T12:00:00Z") });
    expect(outcome.failed).toEqual([]);
    const entries = frontierPricingSnapshot().entries;
    for (const [id, input, cached, write, output] of [
      ["gpt-5.6-cyber", 12.5, 1.25, 15.625, 75],
      ["gpt-5.5-cyber", 12.5, 1.25, undefined, 75],
      ["gpt-rosalind-research", 5, 0.5, undefined, 25],
      ["gpt-rosalind-discovery", 5, 0.5, undefined, 25],
      ["chat-latest", 5, 0.5, undefined, 30],
      ["gpt-5.3-codex", 1.75, 0.175, undefined, 14],
      ["gpt-5-search-api", 1.25, 0.125, undefined, 10],
    ] as const) {
      expect(entries.find((entry) => entry.id === id), id).toMatchObject({
        inputPerMillion: input, cachedInputPerMillion: cached, outputPerMillion: output,
      });
      expect(entries.find((entry) => entry.id === id)?.cacheWriteInputPerMillion, id).toBe(write);
    }
    const stored = JSON.parse(localStorage.getItem(OFFICIAL_PRICING_KEY)!);
    expect(stored.models).not.toHaveProperty("openai:gpt-rosalind-discovery");
    expect(stored.models).not.toHaveProperty("openai:gpt-5.6-cyber");
    expect(stored.models).not.toHaveProperty("claude:claude-haiku-5-5");
    expect(stored.models).not.toHaveProperty("claude:claude-3-5-haiku");
    expect(entries.find((entry) => entry.id === "claude-3-5-haiku")).toMatchObject({
      name: "Claude Haiku 3.5", status: "retired", inputPerMillion: 0.8, outputPerMillion: 4,
      cachedInputPerMillion: 0.08, cacheWriteInputPerMillion: 1, cacheWrite1hInputPerMillion: 1.6,
    });
    expect(entries.find((entry) => entry.id === "gpt-6.1-sol")?.longContextThresholdTokens).toBe(272_000);
    expect(entries.find((entry) => entry.id === "claude-haiku-5-5")?.longContextThresholdTokens).toBe(100_000);
  });
});

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

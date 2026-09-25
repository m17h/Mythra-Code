import type { TokenUsageView } from "./StudioDock";
import { pricingForModel, type UsageAmounts, type UsageProvider } from "../lib/usageLedger";
import { addUsageToAmounts, emptyComponentAmounts, localDayKey, shiftDayKey, type UsageBucket, type UsageComponentAmounts } from "../lib/usageHistory";
import { combineUsageDetail, componentCost, summarizeUsageBuckets, type UsageDetail, type UsageRange } from "../lib/usageSummary";

/** What the dashboard reads. The live source is the device ledger. */
export interface UsageDashboardSource {
  detail: (range: UsageRange | null) => UsageDetail;
  reported: () => { cost: number; requests: number };
  /** Set only on synthetic data, so the page can say so. */
  preview?: boolean;
}

type Row = [daysAgo: number, provider: UsageProvider, model: string, input: number, cacheRead: number, cacheWrite: number, output: number, turns: number];
const ROWS: Row[] = [
  [3, "cursor", "auto", 900_000, 0, 0, 60_000, 6],
  [2, "claude", "claude-sonnet-5", 1_600_000, 1_200_000, 90_000, 70_000, 9],
  [16, "openrouter", "vendor/preview-model", 400_000, 0, 0, 40_000, 5],
];
// Five weeks of the two models people compare most, with a weekly rhythm,
// so the trend, week grouping and Compare view have something to show.
for (let daysAgo = 0; daysAgo < 35; daysAgo += 1) {
  const weekday = (35 - daysAgo) % 7;
  if (weekday === 5) continue;
  const load = 0.6 + ((daysAgo * 37) % 11) / 10;
  const scale = (value: number) => Math.round(value * load);
  if (daysAgo % 3 !== 1) ROWS.push([daysAgo, "claude", "claude-opus-5-5", scale(2_600_000), scale(2_100_000), scale(180_000), scale(120_000), Math.max(1, Math.round(9 * load))]);
  if (daysAgo % 4 !== 2) ROWS.push([daysAgo, "openai", "gpt-5.6-sol", scale(2_000_000), scale(1_400_000), scale(100_000), scale(150_000), Math.max(1, Math.round(11 * load))]);
}

/** Usage recorded before dated tracking began, known only as all-time
 * provider totals; "unknown" is usage that never had a provider label. */
const LEGACY: Array<[provider: UsageProvider, input: number, cacheRead: number, output: number, cost: number | null]> = [
  ["openai", 3_000_000, 2_200_000, 250_000, 9.4],
  ["claude", 1_800_000, 1_400_000, 130_000, 4.8],
  ["unknown", 200_000, 0, 20_000, null],
];

function ledgerAmounts(amounts: UsageComponentAmounts): UsageAmounts {
  return {
    inputTokens: amounts.uncachedInputTokens + amounts.cacheReadTokens + amounts.cacheWriteTokens,
    cachedInputTokens: amounts.cacheReadTokens, cacheWriteInputTokens: amounts.cacheWriteTokens,
    outputTokens: amounts.outputTokens, reasoningOutputTokens: amounts.reasoningOutputTokens, totalTokens: amounts.totalTokens,
    estimatedCost: componentCost(amounts), pricedTokens: amounts.pricedTokens, unpricedTokens: amounts.unpricedTokens,
  };
}

function addAmounts(target: UsageAmounts, source: UsageAmounts): UsageAmounts {
  // A caller can carry a provider label alongside these amounts. Iterating
  // its runtime keys would concatenate `undefined` onto that label and make
  // the preview show a second, unnamed provider row.
  for (const key of [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens",
    "totalTokens", "estimatedCost", "pricedTokens", "unpricedTokens",
  ] as const) target[key] += source[key];
  return target;
}

/**
 * Synthetic, in-memory usage for demonstrating the dashboard in a development
 * build. Nothing here reads or writes the usage ledger or history; costs use
 * the same rate lookup and component split as real recording.
 */
export function previewUsageSource(now = Date.now()): UsageDashboardSource {
  const today = localDayKey(now);
  const buckets: UsageBucket[] = ROWS.map(([daysAgo, provider, model, input, cacheRead, cacheWrite, output, turns]) => {
    const usage: TokenUsageView = {
      inputTokens: input, cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite, outputTokens: output,
      reasoningOutputTokens: Math.round(output * 0.3), totalTokens: input + output, contextWindow: null,
    };
    const pricing = provider === "cursor" || provider === "unknown" ? undefined : pricingForModel(provider, model);
    const bucket = { day: shiftDayKey(today, -daysAgo), provider, model, ...emptyComponentAmounts() };
    addUsageToAmounts(bucket, usage, pricing);
    bucket.turns = turns;
    bucket.modelTurns = turns;
    return bucket;
  });
  const startedDay = shiftDayKey(today, -35);
  return {
    preview: true,
    reported: () => ({ cost: 0.42, requests: 5 }),
    detail: (range) => {
      const summary = summarizeUsageBuckets(buckets, range, startedDay);
      if (range) return combineUsageDetail(summary, null);
      const providers = summary.providers.map((provider) => ({ provider: provider.provider, ...ledgerAmounts(provider) }));
      for (const [provider, input, cacheRead, output, cost] of LEGACY) {
        const legacy: UsageAmounts = {
          inputTokens: input, cachedInputTokens: cacheRead, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0,
          totalTokens: input + output, estimatedCost: cost ?? 0, pricedTokens: cost === null ? 0 : input + output, unpricedTokens: cost === null ? input + output : 0,
        };
        const existing = providers.find((item) => item.provider === provider);
        if (existing) addAmounts(existing, legacy);
        else providers.push({ provider, ...legacy });
      }
      const totals = providers.reduce((sum, item) => addAmounts(sum, item), ledgerAmounts(emptyComponentAmounts()));
      return combineUsageDetail(summary, { totals: { ...totals, threads: 0 }, providers });
    },
  };
}

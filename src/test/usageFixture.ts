import {
  annotateThreadUsage, recordOpenRouterCharge, recordUsageDelta, resetUsageLedgerCache, flushUsageLedger, USAGE_LEDGER_KEY,
} from "../lib/usageLedger";
// Attach dated detail synchronously; the app loads it on first usage instead.
import "../lib/usageHistory";

const DAY_MS = 86_400_000;
const legacyUsage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
  inputTokens, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens, contextWindow: null,
});

/**
 * All-time ledger records written before dated detail existed: two known
 * providers, and one record that never had a provider label.
 */
export function legacyLedgerRecords(now = Date.now()) {
  return [
    { threadId: "fixture-legacy", provider: "openai", model: "gpt-5.6-sol", usage: legacyUsage(1_000_000, 500_000, 200_000),
      estimatedCost: 8.5, pricedTokens: 1_200_000, unpricedTokens: 0, updatedAt: now - 40 * DAY_MS },
    { threadId: "fixture-legacy-claude", provider: "claude", model: "claude-opus-5", usage: legacyUsage(600_000, 200_000, 100_000),
      estimatedCost: 2.25, pricedTokens: 700_000, unpricedTokens: 0, updatedAt: now - 50 * DAY_MS },
    { threadId: "fixture-legacy-unlabeled", usage: legacyUsage(50_000, 0, 10_000), updatedAt: now - 60 * DAY_MS },
  ];
}

/** Records through the real ledger path as if it were `at`. */
function at<T>(time: number, run: () => T): T {
  const realNow = Date.now;
  Date.now = () => time;
  try { return run(); } finally { Date.now = realNow; }
}

/**
 * Synthetic local records only; never loads real account or conversation data.
 * Seeds pre-tracking all-time records (no dated detail) plus dated usage
 * across several days, providers and models, recorded turn by turn.
 */
export function seedUsageDashboard(now = Date.now()): void {
  resetUsageLedgerCache();
  localStorage.clear();
  localStorage.setItem(USAGE_LEDGER_KEY, JSON.stringify(legacyLedgerRecords(now)));
  resetUsageLedgerCache();
  // Oldest first: dated tracking "begins" on the first recorded day.
  const rows: Array<[daysAgo: number, thread: string, provider: "openai" | "claude" | "cursor" | "openrouter", model: string, input: number, output: number, turns: number]> = [
    // Per-turn splits (and their 1/4 cache-read, 1/8 cache-write shares) are
    // whole numbers so the ledger's token rounding never shifts a total.
    [12, "fixture-sonnet", "claude", "claude-sonnet-5", 640_000, 100_000, 2],
    [3, "fixture-sol", "openai", "gpt-5.6-sol", 1_800_000, 400_000, 4],
    [2, "fixture-router", "openrouter", "vendor/unknown", 160_000, 40_000, 1],
    [1, "fixture-cursor", "cursor", "auto", 320_000, 50_000, 1],
    [0, "fixture-astra", "openai", "gpt-6-astra", 1_200_000, 210_000, 3],
    [0, "fixture-opus", "claude", "claude-opus-5-5", 800_000, 100_000, 2],
  ];
  for (const [daysAgo, thread, provider, model, input, output, turns] of rows) {
    at(now - daysAgo * DAY_MS, () => {
      annotateThreadUsage(thread, { provider, model });
      for (let turn = 0; turn < turns; turn += 1) {
        const inputTokens = input / turns;
        const outputTokens = output / turns;
        recordUsageDelta(thread, {
          inputTokens, outputTokens, cachedInputTokens: inputTokens / 4, cacheWriteInputTokens: inputTokens / 8,
          totalTokens: inputTokens + outputTokens, reasoningOutputTokens: outputTokens / 5, contextWindow: null,
        }, `${thread}-event-${turn}`, `${thread}-turn-${turn}`);
      }
    });
  }
  recordOpenRouterCharge("fixture-paid", 0.42);
  recordOpenRouterCharge("fixture-free", 0);
  flushUsageLedger();
}

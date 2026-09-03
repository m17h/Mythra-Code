import { annotateThreadUsage, recordOpenRouterCharge, recordUsageDelta, resetUsageLedgerCache, flushUsageLedger } from "../lib/usageLedger";

/** Synthetic local records only; never loads real account or conversation data. */
export function seedUsageDashboard(): void {
  resetUsageLedgerCache();
  localStorage.clear();
  for (const [thread, provider, model, inputTokens, outputTokens] of [
    ["fixture-openai", "openai", "gpt-5.6-luna", 1_800_000, 400_000],
    ["fixture-claude", "claude", "claude-haiku-4-5", 800_000, 200_000],
    ["fixture-router", "openrouter", "vendor/unknown", 160_000, 40_000],
  ] as const) {
    annotateThreadUsage(thread, { provider, model });
    recordUsageDelta(thread, { inputTokens, outputTokens, cachedInputTokens: inputTokens / 4,
      cacheWriteInputTokens: inputTokens / 8, totalTokens: inputTokens + outputTokens,
      reasoningOutputTokens: outputTokens / 5, contextWindow: null });
  }
  recordOpenRouterCharge("fixture-paid", 0.42);
  recordOpenRouterCharge("fixture-free", 0);
  flushUsageLedger();
}

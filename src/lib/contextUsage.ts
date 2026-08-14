export interface ContextUsageSnapshot {
  contextTokens?: number;
  contextWindow?: number | null;
}

/**
 * Context pressure is only meaningful when the provider reports both the
 * current prompt occupancy and its window. Cumulative billed tokens are not a
 * fallback: repeated agent/tool round trips count the same history again.
 */
export function contextUsagePercent(usage: ContextUsageSnapshot | null | undefined): number | null {
  const tokens = usage?.contextTokens;
  const window = usage?.contextWindow;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return null;
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return null;
  return Math.min(100, (tokens / window) * 100);
}

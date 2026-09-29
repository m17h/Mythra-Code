import type { UsageEvidence } from "../types";

export function normalizedServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.trim().toLowerCase())) return undefined;
  const tier = value.trim().toLowerCase();
  return tier === "default" ? "standard" : tier === "priority" ? "fast" : tier;
}

export function cacheUnknownTokens(usage: UsageEvidence & { inputTokens: number }, kind: "Read" | "Write"): number {
  const unknown = usage[`cache${kind}UnknownTokens`];
  if (typeof unknown === "number" && Number.isFinite(unknown) && (unknown > 0 || usage[`cache${kind}Reported`] !== false)) return Math.min(usage.inputTokens, Math.max(0, unknown));
  return usage[`cache${kind}Reported`] === false ? usage.inputTokens : 0;
}

/** Empty accumulators do not turn a reported zero into unknown. */
export function mergedUsageEvidence(left: UsageEvidence & { inputTokens: number; outputTokens?: number }, right: UsageEvidence & { inputTokens: number; outputTokens?: number }): UsageEvidence {
  const cacheReadUnknownTokens = cacheUnknownTokens(left, "Read") + cacheUnknownTokens(right, "Read");
  const cacheWriteUnknownTokens = cacheUnknownTokens(left, "Write") + cacheUnknownTokens(right, "Write");
  const leftUsed = left.inputTokens + (left.outputTokens ?? 0) > 0;
  const rightUsed = right.inputTokens + (right.outputTokens ?? 0) > 0;
  const tier = leftUsed ? left.serviceTier : right.serviceTier;
  const sameTier = !leftUsed || !rightUsed || left.serviceTier === right.serviceTier;
  return {
    tokenAvailability: !rightUsed ? left.tokenAvailability : !leftUsed ? right.tokenAvailability : left.tokenAvailability === "unavailable" || right.tokenAvailability === "unavailable" ? "unavailable" : left.tokenAvailability === "partial" || right.tokenAvailability === "partial" ? "partial" : right.tokenAvailability ?? left.tokenAvailability,
    cacheReadUnknownTokens, cacheWriteUnknownTokens,
    cacheReadReported: !cacheReadUnknownTokens && (left.cacheReadReported !== false || !left.inputTokens) && (right.cacheReadReported !== false || !right.inputTokens),
    cacheWriteReported: !cacheWriteUnknownTokens && (left.cacheWriteReported !== false || !left.inputTokens) && (right.cacheWriteReported !== false || !right.inputTokens),
    serviceTier: sameTier ? tier : "mixed",
    serviceTierSource: !rightUsed ? left.serviceTierSource : sameTier && (!leftUsed || left.serviceTierSource === right.serviceTierSource) ? right.serviceTierSource : "unknown",
    requestedServiceTier: !rightUsed ? left.requestedServiceTier : !leftUsed || left.requestedServiceTier === right.requestedServiceTier ? right.requestedServiceTier : "mixed",
  };
}

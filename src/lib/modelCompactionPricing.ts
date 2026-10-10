import type { Provider } from "../types";
import type { FrontierPricingEntry } from "./frontierPricing";

/** Manual context-management choices, not provider pricing boundaries. */
const MANUAL_WINDOWS = [200_000, 500_000, 1_000_000];

export function compactionPricingEntry(provider: Provider | undefined, model: string | undefined, entries: readonly FrontierPricingEntry[], resolvedModel?: string): FrontierPricingEntry | undefined {
  const source = provider === "claude" ? "anthropic" : provider === "openai" ? "openai" : null;
  const selected = (resolvedModel?.trim() || model?.trim())?.toLowerCase();
  if (!source || !selected) return undefined;
  const exact = entries.find((entry) => entry.provider === source && entry.id === selected);
  if (exact) return exact;
  // Floating Claude aliases need the actual runtime-resolved identity above.
  // Never assume "haiku" means 5.5 on an older CLI. Match dated snapshots,
  // never similar names or another provider's billing through a proxy.
  const canonical = provider === "claude"
    ? selected.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "")
    : selected.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const id = provider === "openai" && canonical === "gpt-5.6" ? "gpt-5.6-sol" : canonical;
  return entries.find((entry) => entry.provider === source && entry.id === id);
}

/** A published input-price band, not a context capacity or a billing cap. */
export function compactionPriceBoundary(entry: FrontierPricingEntry | undefined): number | undefined {
  const value = entry?.longContextThresholdTokens;
  return entry?.longContext && value !== undefined && Number.isInteger(value)
    && value >= 100_000 && value <= 1_000_000 ? value : undefined;
}

export function modelCompactionWindows(entry: FrontierPricingEntry | undefined): number[] {
  const boundary = compactionPriceBoundary(entry);
  return [...new Set([...MANUAL_WINDOWS, ...(boundary !== undefined ? [boundary] : [])])].sort((a, b) => a - b);
}

export function describeCompactionPriceBoundary(entry: FrontierPricingEntry | undefined): string {
  const boundary = compactionPriceBoundary(entry);
  if (boundary !== undefined) {
    const amount = boundary % 1_000 === 0 ? `${boundary / 1_000}K` : boundary.toLocaleString("en-US");
    return `${entry!.name}: published API pricing changes above ${amount} input tokens, including cached input. Subscription allowances are separate.`;
  }
  if (entry?.longContext) return `${entry.name}: long-context API prices are listed, but their input-token boundary is unavailable. Manual windows are not pricing limits.`;
  return entry
    ? `${entry.name}: the published API table does not list a long-context price increase. Model context limits still apply.`
    : "No published API price boundary is available for this model. Manual windows are not pricing limits.";
}

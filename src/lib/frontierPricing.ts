import {
  isAnthropicPricingModelId, officialPricingSnapshot, officialPricingStatus, refreshOfficialPricing,
  type OfficialPricingRefresh, type OfficialRate,
} from "./officialPricing";

export type FrontierPricingSource = "openai" | "anthropic";

/** USD per one million tokens, standard API processing. These rates do not
 * describe Claude Code or Codex subscription allowances. Undefined means the
 * official table does not publish a separate rate, never a zero-dollar fee. */
export interface FrontierTokenRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWriteInputPerMillion?: number;
  cacheWrite1hInputPerMillion?: number;
}

export interface FrontierPricingEntry extends FrontierTokenRates {
  id: string;
  provider: FrontierPricingSource;
  name: string;
  asOf: string;
  status?: "retired" | "limited";
  /** Explicit long-context standard rates from the provider's table. */
  longContext?: FrontierTokenRates;
  longContextThresholdTokens?: number;
}

export interface FrontierPricingProvider {
  provider: FrontierPricingSource;
  sourceUrl: string;
  checkedAt?: number;
  verifiedAt?: number;
  verificationTimeUncertain?: boolean;
  checkedTimeUncertain?: boolean;
  error?: string;
  checking: boolean;
  models: number;
}

export interface FrontierPricingSnapshot {
  entries: FrontierPricingEntry[];
  providers: FrontierPricingProvider[];
  checking: boolean;
}

const SOURCES: readonly FrontierPricingSource[] = ["anthropic", "openai"];
export const FRONTIER_PRICING_URLS: Record<FrontierPricingSource, string> = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
};

function tokenRates(rate: OfficialRate): FrontierTokenRates {
  return {
    inputPerMillion: rate.input, outputPerMillion: rate.output,
    ...(rate.cacheRead !== undefined ? { cachedInputPerMillion: rate.cacheRead } : {}),
    ...(rate.cacheWrite !== undefined ? { cacheWriteInputPerMillion: rate.cacheWrite } : {}),
    ...(rate.cacheWrite1h !== undefined ? { cacheWrite1hInputPerMillion: rate.cacheWrite1h } : {}),
  };
}

function displayName(id: string, rate: OfficialRate): string {
  if (rate.name) return rate.name;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  return claude ? `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}` : id;
}

/** Read the same validated cache used by usage pricing. A failed refresh
 * retains its dated successful listing and separate attempt/error metadata. */
export function frontierPricingSnapshot(): FrontierPricingSnapshot {
  const statuses = officialPricingStatus();
  const entries = SOURCES.flatMap((provider) => Object.entries(officialPricingSnapshot(provider))
    // Batch, Flex and Fast prices must never appear as ordinary API prices.
    .filter(([id, rate]) => (provider === "openai" ? /^[a-z0-9][a-z0-9.-]{0,79}$/.test(id)
      : isAnthropicPricingModelId(id)) && (!rate.serviceTier || rate.serviceTier === "standard"))
    .map(([id, rate]): FrontierPricingEntry => ({
      id, provider, name: displayName(id, rate), asOf: rate.asOf, ...tokenRates(rate),
      ...(rate.status ? { status: rate.status } : {}),
      ...(rate.longContext ? { longContext: tokenRates(rate.longContext) } : {}),
      ...(rate.longContextThresholdTokens ? { longContextThresholdTokens: rate.longContextThresholdTokens } : {}),
    })));
  const providers = SOURCES.map((provider): FrontierPricingProvider => {
    const state = statuses.find((status) => status.source === provider)!;
    return {
      provider, sourceUrl: FRONTIER_PRICING_URLS[provider],
      checkedAt: state.checkedAt, verifiedAt: state.verifiedAt, error: state.error,
      verificationTimeUncertain: state.verificationTimeUncertain, checkedTimeUncertain: state.checkedTimeUncertain,
      checking: state.checking, models: entries.filter((entry) => entry.provider === provider).length,
    };
  });
  return { entries, providers, checking: providers.some((provider) => provider.checking) };
}

/** Shares the existing bounded, deduplicated official fetch and storage path. */
export function refreshFrontierPricing(): Promise<OfficialPricingRefresh> {
  return refreshOfficialPricing({ force: true });
}

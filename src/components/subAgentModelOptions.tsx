import { ProviderLogo } from "./BrandLogos";
import type { AppSelectOption } from "./AppSelectMenu";
import type { Provider } from "../types";
import { CHILD_AGENT_REASONING_EFFORTS } from "../lib/childAgents";
import { isClaudeDefaultModel } from "../lib/claude";

export interface ChildAgentModelOption {
  id: string;
  label: string;
  detail?: string;
  keywords?: string;
  /** Concrete identity reported by the runtime, especially for floating aliases. */
  resolvedModel?: string;
}
export type ChildAgentModelCatalogs = Partial<Record<Provider, ChildAgentModelOption[]>> & {
  /** Raw CLI aliases omitted from provider arrays, retained to recognize saved defaults. */
  hiddenClaudeModelIds?: string[];
  /** Live catalogs cannot supply a new default while loading or after a failed refresh. */
  unavailableProviders?: Partial<Record<Provider, string>>;
};

const BUILTIN_MODEL_CATALOGS: Record<Provider, ChildAgentModelOption[]> = {
  openai: [
    { id: "gpt-6-astra", label: "Astra", detail: "gpt-6-astra · frontier intelligence" },
    // Same offline Sol as DEFAULT_OPENAI_MODEL/OPENAI_MODELS; the live catalog
    // supplies anything newer the account can actually run.
    { id: "gpt-5.6-sol", label: "Sol", detail: "gpt-5.6-sol · detail & polish" },
    { id: "gpt-5.6-terra", label: "Terra", detail: "gpt-5.6-terra · everyday power" },
    { id: "gpt-5.6-luna", label: "Luna", detail: "gpt-5.6-luna · fast & focused" },
  ],
  claude: [
    { id: "claude-fable-5", label: "Fable 5", detail: "Frontier coding" },
    { id: "claude-opus-5", label: "Opus 5", detail: "Deepest reasoning" },
    { id: "claude-sonnet-5", label: "Sonnet 5", detail: "Balanced power" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", detail: "Fast and efficient" },
  ],
  cursor: [{ id: "auto", label: "Auto", detail: "Cursor recommended" }],
  openrouter: [],
  lmstudio: [],
};

const REASONING_LABELS: Record<(typeof CHILD_AGENT_REASONING_EFFORTS)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

function catalogFor(provider: Provider, catalogs: ChildAgentModelCatalogs | undefined): ChildAgentModelOption[] {
  const supplied = catalogs?.[provider];
  return catalogs?.unavailableProviders?.[provider]
    ? [] : supplied?.length ? supplied : BUILTIN_MODEL_CATALOGS[provider];
}

function visibleModel(provider: Provider, entry: ChildAgentModelOption, catalogs: ChildAgentModelCatalogs | undefined): boolean {
  return provider !== "claude" || !isClaudeDefaultModel(entry.id, entry.label)
    && !catalogs?.hiddenClaudeModelIds?.includes(entry.id);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

interface PreferredModelIdentity {
  version: number[];
  snapshot: number;
  standardContext: boolean;
}

/** Dates are snapshots of one version, not additional version components. */
function preferredIdentity(provider: Provider, model: string): PreferredModelIdentity | null {
  const snapshot = /-(\d{8})(?=\[|$)/.exec(model);
  const identity = model.replace(/-\d{8}(?=\[|$)/, "");
  const match = provider === "openai"
    ? /^gpt-(\d+(?:\.\d+)*)-sol(?:\[[^\]]+\])?$/i.exec(identity)
    : /^(?:claude-)?opus-(\d+(?:[.-]\d+)*)(?:\[[^\]]+\])?$/i.exec(identity)
      ?? /^claude-(\d+(?:[.-]\d+)*)-opus(?:\[[^\]]+\])?$/i.exec(identity);
  return match ? {
    version: match[1].split(/[.-]/).map(Number),
    snapshot: snapshot ? Number(snapshot[1]) : 0,
    standardContext: !model.includes("["),
  } : null;
}

function isClaudeFamilyAlias(model: string): boolean {
  return /^(?:(?:claude-)?(?:opus|sonnet|haiku|fable)|opusplan)(?:\[[^\]]+\])?$/i.test(model);
}

/** Choose once when adding a destination or changing its provider. Existing
 * saved choices never move when a catalog refresh introduces a newer model. */
export function defaultChildAgentModel(provider: Provider, catalogs: ChildAgentModelCatalogs | undefined): string | undefined {
  if (provider !== "openai" && provider !== "claude") return provider === "cursor" ? "auto" : "";
  // Offline picker suggestions are not evidence that this account can run a
  // model. Wait for a live catalog rather than persisting an outdated fallback.
  if (catalogs?.unavailableProviders?.[provider]) return undefined;
  const catalog = (catalogs?.[provider] ?? []).filter((entry) => visibleModel(provider, entry, catalogs));
  let newest: { id: string; identity: PreferredModelIdentity; direct: boolean } | undefined;
  let fallback: string | undefined;
  let preferredAlias: string | undefined;
  let fallbackAlias: string | undefined;
  for (const entry of catalog) {
    // Save the CLI-reported concrete identity, even when only a floating alias
    // is listed. Do not invent context suffixes the resolver did not report.
    // Prefer pinned identities, while keeping an alias-only account usable.
    const id = entry.resolvedModel?.trim() || entry.id.trim();
    if (!id || id.startsWith("-") || (provider === "openai" && id.includes("/"))) continue;
    if (provider === "claude" && isClaudeDefaultModel(id)) continue;
    if (provider === "claude" && isClaudeFamilyAlias(id)) {
      fallbackAlias ??= id;
      if (/^(?:claude-)?opus(?:\[[^\]]+\])?$/i.test(id)
        && (!preferredAlias || preferredAlias.includes("[") && !id.includes("["))) preferredAlias = id;
      continue;
    }
    // Keep other advertised model identities usable when the preferred family
    // is absent. Do not impose vendor naming rules on unknown catalog rows.
    fallback ??= id;
    const identity = preferredIdentity(provider, id);
    if (!identity) continue;
    const direct = id === entry.id.trim();
    // Equal versions prefer standard context, then the newest dated snapshot.
    // Final ties are deterministic rather than depending on catalog order.
    const order = newest ? compareVersions(identity.version, newest.identity.version)
      || Number(identity.standardContext) - Number(newest.identity.standardContext)
      || identity.snapshot - newest.identity.snapshot
      || Number(direct) - Number(newest.direct)
      || id.localeCompare(newest.id) : 1;
    if (!newest || order > 0) newest = { id, identity, direct };
  }
  return newest?.id ?? preferredAlias ?? fallback ?? fallbackAlias;
}

/** An offered alternative is usable, but choosing another family must be clear. */
export function defaultChildAgentModelNotice(provider: Provider, catalogs: ChildAgentModelCatalogs | undefined): string | undefined {
  if (provider !== "openai" && provider !== "claude") return undefined;
  const model = defaultChildAgentModel(provider, catalogs);
  if (model === undefined || preferredIdentity(provider, model)) return undefined;
  if (provider === "claude" && isClaudeFamilyAlias(model)) {
    return `Claude reports ${model} without an exact version. This sub-agent will follow that provider alias; you can choose another model.`;
  }
  const family = provider === "openai" ? "Sol" : "Opus";
  return `The ${family} default could not be selected. This sub-agent will use ${model}; you can choose another model.`;
}

export function defaultChildAgentModelIssue(provider: Provider, catalogs: ChildAgentModelCatalogs | undefined): string | undefined {
  if (provider !== "openai" && provider !== "claude") return undefined;
  const unavailable = catalogs?.unavailableProviders?.[provider];
  if (unavailable) return unavailable;
  if (defaultChildAgentModel(provider, catalogs) !== undefined) return undefined;
  const family = provider === "openai" ? "Sol" : "Opus";
  return catalogs?.[provider] === undefined
    ? `Load the ${family} model catalog before adding a sub-agent.`
    : "An available model could not be selected. Refresh models in Settings.";
}

export const REASONING_OPTIONS: AppSelectOption[] = CHILD_AGENT_REASONING_EFFORTS.map((effort) => ({
  value: effort,
  label: REASONING_LABELS[effort],
}));

export function modelOptionsFor(
  provider: Provider,
  catalogs: ChildAgentModelCatalogs | undefined,
  selectedModel?: string,
): AppSelectOption[] {
  const catalog = catalogFor(provider, catalogs);
  const options: AppSelectOption[] = catalog
    .filter((entry) => visibleModel(provider, entry, catalogs))
    .map((entry) => ({
      value: entry.id,
      label: entry.label,
      detail: entry.detail ?? entry.id,
      keywords: entry.keywords,
      icon: <ProviderLogo provider={provider} size={11} />,
    }));
  const hiddenDefault = provider === "claude" && selectedModel !== undefined
    && (catalogs?.hiddenClaudeModelIds?.includes(selectedModel)
      || isClaudeDefaultModel(selectedModel, catalog.find((entry) => entry.id === selectedModel)?.label));
  if (selectedModel && !hiddenDefault && !options.some((option) => option.value === selectedModel)) {
    const resolvedEntry = catalog.find((entry) => visibleModel(provider, entry, catalogs)
      && entry.resolvedModel?.trim() === selectedModel);
    options.unshift({
      value: selectedModel,
      label: resolvedEntry?.label ?? selectedModel,
      detail: resolvedEntry ? selectedModel : "Previously configured model",
      keywords: resolvedEntry?.keywords,
      icon: <ProviderLogo provider={provider} size={11} />,
    });
  }
  return options;
}

import { useId, useMemo, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnthropicLogo, OpenAILogo } from "./BrandLogos";
import { useFrontierPricing } from "../hooks/useFrontierPricing";
import type { FrontierPricingEntry, FrontierPricingProvider, FrontierPricingSource, FrontierTokenRates } from "../lib/frontierPricing";
import "./FrontierPricingSettings.css";

const PROVIDERS: ReadonlyArray<{ id: FrontierPricingSource; label: string; page: string }> = [
  { id: "openai", label: "OpenAI", page: "OpenAI pricing page" },
  { id: "anthropic", label: "Anthropic", page: "Anthropic pricing page" },
];
const PROVIDER_LABEL: Record<FrontierPricingSource, string> = { openai: "OpenAI", anthropic: "Anthropic" };

type Filter = "all" | FrontierPricingSource;
const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [{ id: "all", label: "All" }, ...PROVIDERS];

/** Company marks, drawn in the surrounding text colour so they sit quietly in
 * every theme instead of carrying a brand tile into a reference table. */
function CompanyMark({ provider, size = 14 }: { provider: FrontierPricingSource; size?: number }) {
  return provider === "openai"
    ? <OpenAILogo size={size} className="frontier-pricing-mark" />
    : <AnthropicLogo size={size} className="frontier-pricing-mark" />;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** The adapter only carries positive published rates; undefined means the
 * table lists none. Anything else is shown as unpublished, never as $0. */
export function formatRate(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? USD.format(value) : null;
}

function Rate({ value }: { value: number | undefined }) {
  const text = formatRate(value);
  return text ? <span className="frontier-pricing-rate">{text}</span> : <span className="frontier-pricing-missing">Not published</span>;
}

function when(at: number): string {
  const date = new Date(at);
  const day = date.toDateString() === new Date().toDateString()
    ? "today"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return `${day} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function listedDay(asOf: string): string {
  const date = new Date(`${asOf}T12:00:00`);
  return Number.isNaN(date.getTime()) ? asOf : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Never claims freshness it doesn't have: a failed check always says so, and
 * names how old the rates still on screen are. */
export function providerStatusText(status: FrontierPricingProvider | undefined, checking: boolean): { tone: "ok" | "warn" | "idle"; text: string } {
  if (checking || status?.checking) return { tone: "idle", text: "Checking the official pricing page…" };
  if (!status) return { tone: "idle", text: "Not checked yet" };
  if (status.verificationTimeUncertain || status.checkedTimeUncertain) {
    const saved = status.models > 0;
    const prefix = status.error
      ? `Couldn’t verify · ${saved ? "showing saved rates" : "no verified rates saved"};`
      : `${saved ? "Saved rates" : "No verified rates saved"} ·`;
    return { tone: "warn", text: `${prefix} verification time is uncertain. Refresh to check the official page.` };
  }
  if (status.error) {
    const attempted = status.checkedAt ? ` ${when(status.checkedAt)}` : "";
    return { tone: "warn", text: `Couldn’t verify${attempted} · ${status.verifiedAt ? `showing rates verified ${when(status.verifiedAt)}` : "no verified rates saved yet"}` };
  }
  if (status.verifiedAt) return { tone: "ok", text: `${status.models} ${status.models === 1 ? "model" : "models"} verified ${when(status.verifiedAt)}` };
  return { tone: "idle", text: "Not checked yet" };
}

function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}

/** The published boundary above which the long-context rates apply. Unknown
 * when the source table gave none; it is never inferred from the model. */
export function longContextCondition(entry: FrontierPricingEntry): string | undefined {
  const tokens = entry.longContextThresholdTokens;
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? `Prompts over ${tokenCount(tokens)} tokens` : undefined;
}

function matches(entry: FrontierPricingEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${entry.name} ${entry.id} ${PROVIDER_LABEL[entry.provider]} ${entry.provider === "anthropic" ? "claude" : "gpt chatgpt"}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

function safeSourceUrl(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).protocol === "https:" ? url : null; } catch { return null; }
}

function CacheWrite({ provider, rates }: { provider: FrontierPricingSource; rates: FrontierTokenRates }) {
  // Anthropic prices cache writes by how long the entry lives; both durations
  // are shown together so neither reads as the only rate.
  if (provider === "anthropic" && (formatRate(rates.cacheWriteInputPerMillion) || formatRate(rates.cacheWrite1hInputPerMillion))) {
    return <span className="frontier-pricing-cache-write">
      <span><small>5m</small> <Rate value={rates.cacheWriteInputPerMillion} /></span>
      <span><small>1h</small> <Rate value={rates.cacheWrite1hInputPerMillion} /></span>
    </span>;
  }
  return <Rate value={rates.cacheWriteInputPerMillion} />;
}

function RateCells({ provider, rates }: { provider: FrontierPricingSource; rates: FrontierTokenRates }) {
  return <>
    <td data-label="Input"><Rate value={rates.inputPerMillion} /></td>
    <td data-label="Cache read"><Rate value={rates.cachedInputPerMillion} /></td>
    <td data-label="Cache write"><CacheWrite provider={provider} rates={rates} /></td>
    <td data-label="Output"><Rate value={rates.outputPerMillion} /></td>
  </>;
}

/** The standard rate leads; a long-context tier follows as a secondary row so
 * it never stands in for the model's usual rate, or vice versa. */
function ModelRows({ entry, verifiedDay }: { entry: FrontierPricingEntry; verifiedDay?: string }) {
  const stale = Boolean(verifiedDay && entry.asOf && entry.asOf < verifiedDay);
  const condition = longContextCondition(entry);
  return <tbody className="frontier-pricing-model">
    <tr>
      <th scope="row" data-label="Model">
        <span className="frontier-pricing-name">{entry.name}</span>
        <span className="frontier-pricing-meta">
          {entry.name !== entry.id && <code>{entry.id}</code>}
          {entry.status === "retired" && <span className="frontier-pricing-badge">Retired</span>}
          {entry.status === "limited" && <span className="frontier-pricing-badge">Limited availability</span>}
          {stale && <span className="frontier-pricing-badge">Last listed {listedDay(entry.asOf)}</span>}
        </span>
        {entry.longContext && <span className="frontier-pricing-tier">Standard context</span>}
      </th>
      <RateCells provider={entry.provider} rates={entry} />
    </tr>
    {entry.longContext && <tr className="frontier-pricing-long">
      <th scope="row" data-label="Tier">
        <span className="frontier-pricing-tier">Long context<span className="sr-only"> for {entry.name}</span></span>
        <span className="frontier-pricing-condition">{condition ?? "Applies above the threshold on the pricing page"}</span>
      </th>
      <RateCells provider={entry.provider} rates={entry.longContext} />
    </tr>}
  </tbody>;
}

function ProviderSection({ provider, label, page, status, models, checking, query }: {
  provider: FrontierPricingSource; label: string; page: string; status?: FrontierPricingProvider;
  models: FrontierPricingEntry[]; checking: boolean; query: string;
}) {
  const headingId = useId();
  const state = providerStatusText(status, checking);
  const source = safeSourceUrl(status?.sourceUrl);
  const verifiedDay = status?.verifiedAt && !status.verificationTimeUncertain && !status.checkedTimeUncertain
    ? new Date(status.verifiedAt).toISOString().slice(0, 10) : undefined;
  return <section className="frontier-pricing-provider" aria-labelledby={headingId}>
    <header className="frontier-pricing-provider-head">
      <h4 id={headingId}><CompanyMark provider={provider} /><span>{label}</span></h4>
      <p className={`frontier-pricing-status ${state.tone}`}>
        <span className="frontier-pricing-dot" aria-hidden="true" />
        <span>{state.text}</span>
      </p>
      {source && <button type="button" className="frontier-pricing-source" onClick={() => void openUrl(source)}>
        <ExternalLink size={12} aria-hidden="true" />{page}
      </button>}
    </header>
    {status?.error && <p className="frontier-pricing-error">{status.error}</p>}
    {models.length
      ? <div className="frontier-pricing-table-wrap">
        <table className="frontier-pricing-table" aria-labelledby={headingId}>
          <thead>
            <tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cache read</th><th scope="col">Cache write</th><th scope="col">Output</th></tr>
          </thead>
          {models.map((entry) => <ModelRows key={entry.id} entry={entry} verifiedDay={verifiedDay} />)}
        </table>
      </div>
      : <p className="frontier-pricing-empty">{query
        ? `No ${label} models match “${query}”.`
        : checking || status?.checking ? `Reading ${label}’s pricing page…` : `No verified ${label} rates saved yet. Refresh to read the official pricing page.`}</p>}
  </section>;
}

export interface FrontierPricingViewProps {
  entries: readonly FrontierPricingEntry[];
  providers: readonly FrontierPricingProvider[];
  checking: boolean;
  onRefresh: () => Promise<unknown> | void;
}

/** Published API list prices, as a read-only reference. */
export function FrontierPricingView({ entries, providers, checking, onRefresh }: FrontierPricingViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const busy = checking || refreshing;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => entries.filter((entry) => matches(entry, needle)), [entries, needle]);

  const refresh = async () => {
    if (busy) return;
    setRefreshing(true);
    setRefreshFailed(false);
    try { await onRefresh(); } catch { setRefreshFailed(true); } finally { setRefreshing(false); }
  };

  return <div className="frontier-pricing">
    <p className="frontier-pricing-intro">
      Pay-as-you-go API list prices in US dollars per 1M tokens, read from each company’s official pricing page.
      These are not Claude or ChatGPT subscription allowances, and nothing here changes your selected model or how you’re billed.
    </p>
    <div className="frontier-pricing-toolbar">
      <div className="frontier-pricing-filter" role="radiogroup" aria-label="Company">
        {FILTERS.map(({ id, label }, index) => (
          <button key={id} type="button" role="radio" aria-checked={filter === id} tabIndex={filter === id ? 0 : -1} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? FILTERS.length - 1
                : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % FILTERS.length
                  : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + FILTERS.length - 1) % FILTERS.length : null;
              if (next === null) return;
              event.preventDefault();
              setFilter(FILTERS[next].id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}>
            {id !== "all" && <CompanyMark provider={id} size={12} />}{label}
          </button>
        ))}
      </div>
      <label className="frontier-pricing-search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          aria-label="Search models"
          placeholder="Search models"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }}
        />
        {query && <button type="button" aria-label="Clear model search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={12} /></button>}
      </label>
      <button type="button" className="secondary-button frontier-pricing-refresh" disabled={busy} aria-busy={busy} onClick={() => void refresh()}>
        {busy ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
        {busy ? "Checking…" : "Refresh prices"}
      </button>
    </div>
    {refreshFailed && <p className="frontier-pricing-error" role="alert">Couldn’t refresh pricing. Previously verified rates are still shown.</p>}
    {PROVIDERS.filter(({ id }) => filter === "all" || filter === id).map(({ id, label, page }) => (
      <ProviderSection
        key={id}
        provider={id}
        label={label}
        page={page}
        status={providers.find((status) => status.provider === id)}
        models={visible.filter((entry) => entry.provider === id)}
        checking={checking}
        query={query.trim()}
      />
    ))}
    <p className="frontier-pricing-footnote">
      Cache read is the discounted rate for cached input. Anthropic lists separate 5-minute and 1-hour cache-write rates.
      Long-context rows apply only when a request exceeds the stated threshold; batch, priority, regional, and data-residency pricing are not shown.
    </p>
  </div>;
}

export function FrontierPricingSettings({ onRefreshAvailableModels }: { onRefreshAvailableModels?: () => Promise<void> } = {}) {
  const { entries, providers, checking, refresh } = useFrontierPricing();
  const [modelRefreshError, setModelRefreshError] = useState("");
  const refreshAll = async () => {
    setModelRefreshError("");
    const [prices, models] = await Promise.allSettled([refresh(), onRefreshAvailableModels?.()]);
    if (models.status === "rejected") setModelRefreshError(`Available models could not be refreshed. ${models.reason instanceof Error ? models.reason.message : "The previous model lists are retained."}`);
    if (prices.status === "rejected") throw prices.reason;
  };
  return <>
    <FrontierPricingView entries={entries} providers={providers} checking={checking} onRefresh={refreshAll} />
    {modelRefreshError && <p className="frontier-pricing-error" role="alert">{modelRefreshError}</p>}
  </>;
}

import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  formatEstimatedCost, getUsageRevision, modelPricingCatalogRevision, openRouterReportedCost,
  pricingForModel, pricingRefreshStatus, subscribeUsage, type ModelPricing, type UsageProvider,
} from "../lib/usageLedger";
import { officialPricingStatus, type OfficialPricingSource, type OfficialPricingStatus } from "../lib/officialPricing";
import {
  emptyComponentAmounts, isDayKey, localDayKey, repricingSummary, shiftDayKey, usageCostParts, USAGE_HISTORY_RETENTION_DAYS,
  type RepricingSummary, type UsageBucket, type UsageComponentAmounts,
} from "../lib/usageHistory";
import {
  componentBreakdown, componentCost, knownPricedModels, promptAverages, usageDetail, usagePeriods, USAGE_COMPONENTS,
  type ModelUsageSummary, type PromptAverages, type ProviderUsageSummary, type UsageComponentId, type UsageDetail, type UsageGrain, type UsagePeriod, type UsageRange,
} from "../lib/usageSummary";
import { AppSelectMenu } from "./AppSelectMenu";
import { UsageColumnChart } from "./UsageColumnChart";
import { previewUsageSource, type UsageDashboardSource } from "./usageDashboardPreview";
import "./UsageDashboard.css";

const LABELS: Record<UsageProvider, string> = {
  openai: "OpenAI / Codex", claude: "Claude Code", openrouter: "OpenRouter",
  cursor: "Cursor", lmstudio: "LM Studio", unknown: "Unattributed",
};
const number = (value: number) => Math.round(value).toLocaleString();
const COMPACT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
/** Headline figures abbreviate large counts; tables keep exact values. */
const compact = (value: number) => (Math.abs(value) < 10_000 ? number(value) : COMPACT.format(Math.round(value)));
const estimate = (value: number) => `≈ ${formatEstimatedCost(value)}`;
const adjustment = (value: number) => `≈ ${value < 0 ? "−" : "+"}${formatEstimatedCost(Math.abs(value))}`;
const percent = (part: number, whole: number) => {
  const share = whole > 0 ? part / whole * 100 : 0;
  // A real but tiny share is never shown as none.
  return share > 0 && share < 0.5 ? "<1%" : `${Math.round(share)}%`;
};
/** "/prompt" to the eye, "per prompt" to a screen reader. */
const PerPrompt = () => <><span aria-hidden="true">/prompt</span><span className="sr-only"> per prompt</span></>;
const plural = (count: number, word: string) => `${number(count)} ${word}${Math.round(count) === 1 ? "" : "s"}`;
const inputTokens = (amounts: UsageComponentAmounts) => amounts.uncachedInputTokens + amounts.cacheReadTokens + amounts.cacheWriteTokens;

type Preset = "today" | "7d" | "30d" | "all" | "custom";
const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
];
type View = "overview" | "models" | "compare";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "compare", label: "Compare" },
];
const GRAINS: Array<{ id: UsageGrain; label: string }> = [{ id: "day", label: "Day" }, { id: "week", label: "Week" }];
type Measure = "cost" | "tokens";
const MEASURES: Array<{ id: Measure; label: string }> = [{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }];
type Part = UsageComponentId | "total";
const PARTS: Array<{ value: Part; label: string }> = [
  { value: "total", label: "All token types" },
  ...USAGE_COMPONENTS.map((component) => ({ value: component.id as Part, label: component.label })),
];

const LIVE_SOURCE: UsageDashboardSource = { detail: usageDetail, reported: openRouterReportedCost };

/**
 * Development builds only: `VITE_PREVIEW_USAGE_DASHBOARD=1 npm run desktop`
 * (or `window.__mythraPreviewUsageDashboard(true)`) swaps in synthetic,
 * in-memory usage so the page can be reviewed without real history. It never
 * writes the ledger. In production the condition is the constant `false`.
 */
const useUsageDashboardPreview: () => UsageDashboardSource | null = import.meta.env.DEV
  ? function useDevelopmentUsagePreview() {
    const [enabled, setEnabled] = useState(() => Boolean(import.meta.env.VITE_PREVIEW_USAGE_DASHBOARD?.trim()));
    useEffect(() => {
      window.__mythraPreviewUsageDashboard = setEnabled;
      return () => { delete window.__mythraPreviewUsageDashboard; };
    }, []);
    const [source] = useState(() => previewUsageSource());
    return enabled ? source : null;
  }
  : () => null;

declare global {
  interface Window { __mythraPreviewUsageDashboard?: (enabled: boolean) => void }
}

export function modelLabel(model: string): string {
  if (!model) return "Model not reported";
  if (model === "unattributed") return "Model not attributable";
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z]+))?$/.exec(model);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : ""}`;
  if (model === "auto") return "Auto";
  return model;
}

function rangeFor(preset: Preset, today: string, custom: { from: string; to: string }): UsageRange | null {
  if (preset === "all") return null;
  if (preset === "today") return { from: today, to: today };
  if (preset === "7d") return { from: shiftDayKey(today, -6), to: today };
  if (preset === "30d") return { from: shiftDayKey(today, -29), to: today };
  const from = isDayKey(custom.from) ? custom.from : today;
  const to = isDayKey(custom.to) ? custom.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

function dateOf(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12);
}
function formatDay(day: string): string {
  return dateOf(day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function shortDay(day: string): string {
  return dateOf(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function periodLabel(period: UsagePeriod, grain: UsageGrain): string {
  return grain === "day" || period.from === period.to ? shortDay(period.from) : `${shortDay(period.from)} – ${shortDay(period.to)}`;
}

/** Cursor's usage never reports cache writes, so its zero is "unknown", not "none". */
const writesReported = (provider: UsageProvider) => provider !== "cursor";

function modelKey(provider: UsageProvider, model: string): string { return `${provider}:${model}`; }
/** One model's dated buckets, so its averages are taken model-day by model-day. */
function bucketsOf(buckets: UsageBucket[], provider: UsageProvider, model: string): UsageBucket[] {
  return buckets.filter((bucket) => bucket.provider === provider && bucket.model === model);
}
function splitKey(key: string): { provider: UsageProvider; model: string } {
  const separator = key.indexOf(":");
  return { provider: key.slice(0, separator) as UsageProvider, model: key.slice(separator + 1) };
}
function ratesFor(provider: UsageProvider, model: string): ModelPricing | undefined {
  return provider === "unknown" || !model ? undefined : pricingForModel(provider, model);
}
function rate(value: number | undefined): string {
  if (value === undefined) return "—";
  // Published per-million rates include values such as $0.125. Keep their
  // significant decimal places instead of rounding a hypothetical estimate.
  const cents = value * 100;
  const decimals = Math.abs(cents - Math.round(cents)) < 1e-9 ? 2 : value < 0.001 ? 4 : 3;
  return `$${value.toFixed(decimals)}`;
}
/** A cache component with no published rate of its own bills as input; say so
 * rather than print a rate the provider never listed. */
const RATE_OF: Record<UsageComponentId, (pricing: ModelPricing) => string> = {
  input: (pricing) => rate(pricing.inputPerMillion),
  cacheRead: (pricing) => pricing.cachedInputPerMillion === undefined ? "Same as input" : rate(pricing.cachedInputPerMillion),
  cacheWrite: (pricing) => pricing.cacheWriteInputPerMillion === undefined ? "Same as input"
    : pricing.cacheWrite1hInputPerMillion === undefined ? rate(pricing.cacheWriteInputPerMillion)
      : `${rate(pricing.cacheWriteInputPerMillion)} · 1h ${rate(pricing.cacheWrite1hInputPerMillion)}`,
  output: (pricing) => rate(pricing.outputPerMillion),
};
const ORIGIN_LABEL: Record<NonNullable<ModelPricing["origin"]>, string> = { official: "pricing page", catalog: "Mythra catalog", bundled: "bundled rate" };
function rateSource(pricing: ModelPricing): string {
  return `${pricing.origin === "official" ? `${pricing.source} ${ORIGIN_LABEL.official}` : pricing.origin ? ORIGIN_LABEL[pricing.origin] : pricing.source}, verified ${pricing.asOf}`;
}
function rateLine(model: ModelUsageSummary): string {
  const rates = ratesFor(model.provider, model.model);
  if (!rates) {
    if (model.provider !== "cursor") return "No published rate, so this model isn’t priced.";
    return model.model === "auto" ? "Auto doesn’t report which model served each request, so it isn’t priced." : "No rate on Cursor’s pricing page matches this model’s name, so it isn’t priced.";
  }
  const write = rates.cacheWriteInputPerMillion === undefined ? "cache writes at the input rate"
    : rates.cacheWrite1hInputPerMillion === undefined ? `${rate(rates.cacheWriteInputPerMillion)} cache write`
      : `${rate(rates.cacheWriteInputPerMillion)} cache write (${rate(rates.cacheWrite1hInputPerMillion)} for 1-hour)`;
  const read = rates.cachedInputPerMillion === undefined ? "cache reads at the input rate" : `${rate(rates.cachedInputPerMillion)} cache read`;
  return `Current rate per 1M: ${rate(rates.inputPerMillion)} input, ${read}, ${write}, ${rate(rates.outputPerMillion)} output (${rateSource(rates)}).`;
}

function partValue(amounts: UsageComponentAmounts, part: Part, measure: Measure): number {
  if (part === "total") return measure === "cost" ? componentCost(amounts) : amounts.totalTokens;
  const component = USAGE_COMPONENTS.find((item) => item.id === part)!;
  return amounts[measure === "cost" ? component.cost : component.tokens];
}
/** A cost is unknown, not zero, when a period's usage has no rate at all. */
function measured(amounts: UsageComponentAmounts, part: Part, measure: Measure): number | null {
  if (measure === "cost" && amounts.totalTokens > 0 && !amounts.pricedTokens) return null;
  return partValue(amounts, part, measure);
}
const formatMeasure = (measure: Measure) => (value: number) => (measure === "cost" ? formatEstimatedCost(value) : compact(value));

/** A keyboard-operable single-choice segmented control (radio group). */
function Segmented<T extends string>({ label, options, value, onChange, className = "" }: {
  label: string; options: Array<{ id: T; label: string }>; value: T; onChange: (value: T) => void; className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = options.findIndex((item) => item.id === value);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % options.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + options.length) % options.length
        : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next].id);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return <div ref={group} className={`usage-segmented ${className}`} role="radiogroup" aria-label={label}>
    {options.map((item) => <button key={item.id} type="button" role="radio" aria-checked={value === item.id}
      tabIndex={value === item.id ? 0 : -1} className={value === item.id ? "selected" : ""}
      onClick={() => onChange(item.id)} onKeyDown={keyDown}>{item.label}</button>)}
  </div>;
}

function RangePicker({ preset, onPreset, custom, onCustom, today }: {
  preset: Preset; onPreset: (preset: Preset) => void;
  custom: { from: string; to: string }; onCustom: (value: { from: string; to: string }) => void; today: string;
}) {
  const earliest = shiftDayKey(today, -USAGE_HISTORY_RETENTION_DAYS);
  return <div className="usage-range">
    <Segmented label="Date range" options={PRESETS} value={preset} onChange={onPreset} />
    {preset === "custom" && <div className="usage-range-custom">
      <label>From<input type="date" value={custom.from} min={earliest} max={today} onChange={(event) => onCustom({ ...custom, from: event.target.value })} /></label>
      <label>To<input type="date" value={custom.to} min={earliest} max={today} onChange={(event) => onCustom({ ...custom, to: event.target.value })} /></label>
    </div>}
  </div>;
}

/** What evidence-backed repricing changed, or null when nothing was. */
function repricingNote(summary: RepricingSummary): string | null {
  const parts = [
    summary.pricedTokens > 0 && `${compact(summary.pricedTokens)} previously unpriced tokens`,
    summary.correctedTokens > 0 && `${compact(summary.correctedTokens)} tokens recorded at a different rate`,
  ].filter(Boolean);
  if (!parts.length) return null;
  const change = summary.costChange;
  const amount = Math.abs(change) < 0.005 ? "no change in cost" : `${change > 0 ? "+" : "−"}${formatEstimatedCost(Math.abs(change))}`;
  return `Repriced ${parts.join(" and ")} using historical rate evidence (${amount}).`;
}

/** A headline figure with its context line. */
function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

/** "N prompts" plus how many of them the cost average covers. */
function promptNote(prompts: number, pricedPrompts: number, ambiguousCost = false): string {
  if (!prompts) return "No prompts with dated detail";
  if (ambiguousCost) return `${plural(prompts, "prompt")} · cost average unavailable across switched and unpriced models`;
  return pricedPrompts === prompts ? plural(prompts, "prompt") : `${plural(prompts, "prompt")} · cost from the ${number(pricedPrompts)} fully priced`;
}

/**
 * Tokens and estimated cost by billable part, each with its per-prompt
 * average and how much of the part its cost covers. Earlier (undated) usage
 * adds its known token split and a cost total that can't be split by part.
 */
function ComponentTable({ buckets, earlier, per, caption, writesUnreported = false }: {
  buckets: UsageComponentAmounts[]; earlier?: UsageDetail["unallocated"]; per: "turns" | "modelTurns"; caption: string; writesUnreported?: boolean;
}) {
  const breakdown = componentBreakdown(buckets, earlier);
  const averages = promptAverages(buckets, per);
  const anyCost = breakdown.rows.some((row) => row.costedTokens + row.partlyCostedTokens > 0);
  const coverage = (costed: number, partly: number, tokens: number) => {
    if (!tokens) return "—";
    const share = percent(costed, tokens);
    // Which tokens of a partly priced model-day have a rate is unknown, so
    // only a lower bound can be stated.
    if (partly > 0) return costed > 0 ? `≥ ${share}` : "Partly";
    return share;
  };
  return <table className="usage-component-table">
    <caption className="sr-only">{caption}</caption>
    <thead><tr><th scope="col">Token type</th><th scope="col">Tokens</th><th scope="col">Est. cost</th><th scope="col">Priced</th></tr></thead>
    <tbody>{breakdown.rows.map((row) => {
      const unreported = writesUnreported && row.id === "cacheWrite";
      const perTokens = averages.tokens?.[row.id];
      const perCost = averages.cost?.[row.id];
      if (unreported) return <tr key={row.id}><th scope="row">{row.label}</th><td className="usage-none">Not reported</td><td className="usage-none">Not reported</td><td className="usage-none">—</td></tr>;
      return <tr key={row.id}>
        <th scope="row">{row.label}</th>
        <td><strong>{number(row.tokens)}</strong>{perTokens !== undefined && <small>{number(perTokens)}<PerPrompt /></small>}</td>
        <td>{anyCost ? <><strong>{estimate(row.cost)}</strong>{perCost !== undefined && <small>{estimate(perCost)}<PerPrompt /></small>}</> : <span className="usage-none">Unpriced</span>}</td>
        <td>{coverage(row.costedTokens, row.partlyCostedTokens, row.tokens)}</td>
      </tr>;
    })}</tbody>
    <tfoot>
      {breakdown.earlier && <tr className="usage-earlier-row">
        <th scope="row">{breakdown.earlier.tokens ? "Earlier usage" : "Pricing adjustment"}<small>Cost not split by type</small></th>
        <td><strong>{number(breakdown.earlier.tokens)}</strong><small>{breakdown.earlier.tokens ? "included above" : "tokens unchanged"}</small></td>
        <td>{breakdown.earlier.priced ? <strong>{breakdown.earlier.tokens && breakdown.earlier.cost >= 0 ? estimate(breakdown.earlier.cost) : adjustment(breakdown.earlier.cost)}</strong> : <span className="usage-none">Unpriced</span>}</td>
        <td>—</td>
      </tr>}
      <tr>
        <th scope="row">Total</th>
        <td><strong>{number(breakdown.total.tokens)}</strong>{averages.tokens && <small>{number(averages.tokens.total)}<PerPrompt /></small>}</td>
        <td>{anyCost || breakdown.earlier?.priced ? <><strong>{estimate(breakdown.total.cost)}</strong>{averages.cost && <small>{estimate(averages.cost.total)}<PerPrompt /></small>}</> : <span className="usage-none">Unpriced</span>}</td>
        <td />
      </tr>
    </tfoot>
  </table>;
}

function averagesNote(buckets: UsageComponentAmounts[], per: "turns" | "modelTurns"): string {
  const averages = promptAverages(buckets, per);
  const notes = [
    averages.prompts ? `Per-prompt figures cover ${plural(averages.prompts, "prompt")}` : "No prompts to average",
    averages.ambiguousCost ? "cost average unavailable because switched-model prompts include unpriced usage"
      : averages.pricedPrompts < averages.prompts && `costs only the ${number(averages.pricedPrompts)} whose usage was all priced`,
    averages.excludedTokens > 0 && `${number(averages.excludedTokens)} tokens from model-days with usage lacking a prompt id aren’t averaged`,
  ].filter(Boolean);
  return `${notes.join("; ")}. “Priced” is the share of each type’s tokens its cost covers.`;
}

function autoGrain(range: UsageRange): UsageGrain {
  return shiftDayKey(range.from, 45) < range.to ? "week" : "day";
}

/** Cost or tokens per day or week for the selected range, with its table. */
function TrendCard({ buckets, range, grain, onGrain }: {
  buckets: UsageBucket[]; range: UsageRange; grain: UsageGrain; onGrain: (grain: UsageGrain) => void;
}) {
  const [measure, setMeasure] = useState<Measure>("cost");
  const periods = usagePeriods(buckets, range, grain);
  const values = periods.map((period) => measured(period.amounts, "total", measure));
  const labels = periods.map((period) => periodLabel(period, grain));
  const unpricedPeriods = values.filter((value) => value === null).length;
  const describe = (index: number) => {
    const { amounts } = periods[index];
    const cost = amounts.pricedTokens ? estimate(componentCost(amounts)) : amounts.totalTokens ? "unpriced" : "—";
    return `${labels[index]} · ${cost} · ${compact(amounts.totalTokens)} tokens · ${plural(amounts.turns, "prompt")}`;
  };
  const title = `${grain === "day" ? "Daily" : "Weekly"} ${measure === "cost" ? "estimated cost" : "tokens"}`;
  return <section className="usage-dashboard-card usage-trend" aria-labelledby="usage-trend-heading">
    <div className="usage-card-head">
      <h5 id="usage-trend-heading">{title}</h5>
      <div className="usage-card-controls">
        <Segmented label="Trend measure" options={MEASURES} value={measure} onChange={setMeasure} />
        <Segmented label="Group by" options={GRAINS} value={grain} onChange={onGrain} />
      </div>
    </div>
    <UsageColumnChart periods={labels} series={[{ label: title, values }]} format={formatMeasure(measure)} describe={describe} />
    {measure === "cost" && unpricedPeriods > 0 && <p className="usage-card-note">Striped marks: usage with no rate, so no cost to show.</p>}
    <details className="usage-table-toggle">
      <summary><ChevronRight size={13} aria-hidden="true" className="usage-disclosure" />Show as table</summary>
      <div className="usage-table-scroll">
        <table>
          <caption className="sr-only">{title} · {formatDay(range.from)} – {formatDay(range.to)}</caption>
          <thead><tr><th scope="col">{grain === "day" ? "Day" : "Week"}</th><th scope="col">Est. cost</th><th scope="col">Tokens</th><th scope="col">Prompts</th></tr></thead>
          <tbody>{periods.slice().reverse().map((period) => <tr key={period.from}>
            <th scope="row">{periodLabel(period, grain)}{!period.complete && <small>partial week</small>}</th>
            <td>{period.amounts.pricedTokens ? estimate(componentCost(period.amounts)) : period.amounts.totalTokens ? "Unpriced" : "—"}</td>
            <td>{number(period.amounts.totalTokens)}</td>
            <td>{number(period.amounts.turns)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </section>;
}

function providerTotals(provider: ProviderUsageSummary) {
  const earlier = provider.earlier;
  return {
    tokens: provider.totalTokens + (earlier?.totalTokens ?? 0),
    cost: componentCost(provider) + (earlier?.estimatedCost ?? 0),
    priced: provider.pricedTokens + (earlier?.pricedTokens ?? 0) > 0,
    unpriced: provider.unpricedTokens + (earlier?.unpricedTokens ?? 0),
  };
}

/** Each provider's share of the range's estimated cost, aligned for comparison. */
function ProvidersCard({ providers, allTime }: { providers: ProviderUsageSummary[]; allTime: boolean }) {
  const rows = providers.map((provider) => ({ provider, ...providerTotals(provider) }));
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  return <section className="usage-dashboard-card usage-providers" aria-labelledby="usage-providers-heading">
    <div className="usage-card-head"><h5 id="usage-providers-heading">By provider</h5></div>
    <table className="usage-share-table">
      <caption className="sr-only">Estimated cost and tokens by provider</caption>
      <thead><tr><th scope="col">Provider</th><th scope="col">Est. cost</th><th scope="col">Tokens</th></tr></thead>
      <tbody>{rows.map(({ provider, tokens, cost, priced, unpriced }) => {
        const notes = [
          provider.provider === "unknown" && "No saved provider label",
          allTime && provider.earlier && (provider.earlier.totalTokens > 0
            ? (provider.models.length ? "Includes earlier usage" : "Earlier usage only")
            : "Includes pricing adjustment"),
          priced && unpriced > 0 && `${compact(unpriced)} tokens unpriced`,
        ].filter(Boolean);
        return <tr key={provider.provider}>
          <th scope="row">{LABELS[provider.provider]}{notes.length > 0 && <small>{notes.join(" · ")}</small>}
            <span className="usage-share" aria-hidden="true"><span style={{ width: `${totalCost > 0 ? cost / totalCost * 100 : 0}%` }} /></span>
          </th>
          <td>{priced ? <><strong>{estimate(cost)}</strong><small>{percent(cost, totalCost)} of cost</small></> : <span className="usage-none">Unpriced</span>}</td>
          <td><strong>{compact(tokens)}</strong><small>{percent(tokens, totalTokens)} of tokens</small></td>
        </tr>;
      })}</tbody>
    </table>
  </section>;
}

function Overview({ detail, range, periodRange, grain, onGrain }: {
  detail: UsageDetail; range: UsageRange | null; periodRange: UsageRange | null; grain: UsageGrain; onGrain: (grain: UsageGrain) => void;
}) {
  const { totals, unallocated } = detail;
  const averages = promptAverages(detail.buckets, "turns");
  const billed = totals.pricedTokens + totals.unpricedTokens;
  const input = inputTokens(totals);
  const showTrend = periodRange !== null && periodRange.from < periodRange.to && detail.buckets.length > 0;
  const repriced = repricingNote(repricingSummary(detail.buckets));
  return <>
    <div className="usage-dashboard-stats" role="group" aria-label={`Summary · ${range ? `${formatDay(range.from)} – ${formatDay(range.to)}` : "All time"}`}>
      <Stat label="Estimated API cost" value={totals.pricedTokens ? estimate(totals.estimatedCost) : "—"}
        detail={billed ? `${percent(totals.pricedTokens, billed)} of tokens priced` : "No usage in this range"} />
      <Stat label="Tokens" value={compact(totals.totalTokens)} detail={`${compact(input)} input · ${compact(totals.outputTokens)} output`} />
      <Stat label="Per prompt" value={averages.cost ? estimate(averages.cost.total) : averages.tokens ? `${compact(averages.tokens.total)} tok` : "—"}
        detail={`${averages.cost && averages.tokens ? `${compact(averages.tokens.total)} tokens · ` : ""}${promptNote(averages.prompts, averages.pricedPrompts, averages.ambiguousCost)}`} />
      <Stat label="Cache reads" value={input ? `${percent(totals.cacheReadTokens, input)} of input` : "—"}
        detail={`${compact(totals.cacheReadTokens)} tokens${detail.detailTotals.cacheReadCost > 0 ? ` · ${estimate(detail.detailTotals.cacheReadCost)}` : ""}`} />
    </div>
    {!range && unallocated && <p className="usage-dashboard-caption">Per-prompt figures and the trend use dated detail only.</p>}
    {repriced && <p className="usage-dashboard-caption">{repriced}</p>}
    {totals.unpricedTokens > 0 && <p className="usage-dashboard-caption">
      {`${compact(totals.unpricedTokens)} tokens are unpriced. Dated usage can be corrected when a historical rate is supported; earlier undated usage cannot.`}
    </p>}
    {(showTrend || detail.providers.length > 0) && <div className="usage-overview-grid">
      {showTrend && <TrendCard buckets={detail.buckets} range={periodRange} grain={grain} onGrain={onGrain} />}
      {detail.providers.length > 0 && <ProvidersCard providers={detail.providers} allTime={!range} />}
    </div>}
  </>;
}

/** One model's usage by billable part, rate context and dated breakdown. */
function ModelDetail({ model, buckets, periodRange, grain, onGrain }: {
  model: ModelUsageSummary; buckets: UsageBucket[]; periodRange: UsageRange | null; grain: UsageGrain; onGrain: (grain: UsageGrain) => void;
}) {
  const label = modelLabel(model.model);
  const own = bucketsOf(buckets, model.provider, model.model);
  const repriced = repricingNote(repricingSummary(own));
  const periods = periodRange ? usagePeriods(own, periodRange, grain).filter((period) => period.amounts.totalTokens > 0).reverse() : [];
  const hidden = !writesReported(model.provider);
  const parts = hidden ? USAGE_COMPONENTS.filter((component) => component.id !== "cacheWrite") : USAGE_COMPONENTS;
  return <div className="usage-model-detail">
    <div className="usage-table-scroll"><ComponentTable buckets={own} per="modelTurns" caption={`${label} tokens and estimated cost by type`} writesUnreported={hidden} /></div>
    <p>
      {model.model && <><code>{model.model}</code> · </>}{model.provider === "claude" && model.model === "unattributed"
        ? "Claude reported tokens without a reliably matching model breakdown. They remain unpriced rather than being charged to a guessed model."
        : rateLine(model)}
      {hidden && ratesFor(model.provider, model.model) ? " Cursor doesn’t report cache writes, so this estimate may be low." : ""}
      {model.cacheWrite1hTokens > 0 ? ` ${number(model.cacheWrite1hTokens)} cache-write tokens used the 1-hour cache.` : ""}
      {repriced ? ` ${repriced}` : ""}
    </p>
    {periods.length > 0 && <>
      <div className="usage-card-head">
        <h6>{label} by {grain}</h6>
        <Segmented label={`${label} group by`} options={GRAINS} value={grain} onChange={onGrain} />
      </div>
      <div className="usage-table-scroll">
        <table className="usage-period-table">
          <caption className="sr-only">{`${label} tokens and estimated cost by ${grain}`}</caption>
          <thead><tr><th scope="col">{grain === "day" ? "Day" : "Week"}</th>{parts.map((component) => <th key={component.id} scope="col">{component.label}</th>)}<th scope="col">Total</th></tr></thead>
          <tbody>{periods.map((period) => {
            const priced = period.amounts.pricedTokens > 0;
            return <tr key={period.from}>
              <th scope="row">{periodLabel(period, grain)}<small>{plural(period.amounts.modelTurns, "prompt")}</small></th>
              {parts.map((component) => <td key={component.id}><strong>{number(period.amounts[component.tokens])}</strong>{priced && <small>{estimate(period.amounts[component.cost])}</small>}</td>)}
              <td><strong>{number(period.amounts.totalTokens)}</strong><small>{priced ? estimate(componentCost(period.amounts)) : "Unpriced"}</small></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </>}
  </div>;
}

/** Every model in range, most expensive first, each expanding to its detail. */
function ModelsView({ detail, range, periodRange, grain, onGrain, expanded, onExpand }: {
  detail: UsageDetail; range: UsageRange | null; periodRange: UsageRange | null; grain: UsageGrain; onGrain: (grain: UsageGrain) => void;
  expanded: string | null; onExpand: (key: string | null) => void;
}) {
  const baseId = useId();
  const models = detail.providers.flatMap((provider) => provider.models)
    .sort((left, right) => componentCost(right) - componentCost(left) || right.totalTokens - left.totalTokens);
  const earlier = !range ? detail.unallocated : null;
  const cursor = models.some((model) => !writesReported(model.provider));
  if (!detail.buckets.length && !earlier) return <div className="usage-dashboard-empty"><strong>No model detail in this range</strong><p>Try a wider range.</p></div>;
  return <>
    <section className="usage-dashboard-card" aria-labelledby={`${baseId}-types`}>
      <div className="usage-card-head"><h5 id={`${baseId}-types`}>By token type · all models</h5></div>
      <ComponentTable buckets={detail.buckets} earlier={earlier} per="turns" caption="Tokens and estimated cost by type, all models" />
      <p className="usage-card-note">{averagesNote(detail.buckets, "turns")}{cursor ? " Cursor doesn’t report cache writes, so its estimates may be low." : ""}</p>
    </section>
    {models.length > 0 && <section className="usage-dashboard-card" aria-labelledby={`${baseId}-models`}>
      <div className="usage-card-head"><h5 id={`${baseId}-models`}>Models</h5></div>
      <table className="usage-models-table">
        <caption className="sr-only">Estimated cost, tokens and prompts by model</caption>
        <thead><tr><th scope="col">Model</th><th scope="col">Est. cost</th><th scope="col">Tokens</th><th scope="col" className="usage-optional">Per prompt</th></tr></thead>
        <tbody>{models.map((model) => {
          const key = modelKey(model.provider, model.model);
          const open = expanded === key;
          const average = promptAverages(bucketsOf(detail.buckets, model.provider, model.model), "modelTurns");
          const panelId = `${baseId}-${key.replace(/[^a-z0-9]/gi, "-")}`;
          return <Fragment key={key}>
            <tr className={open ? "open" : undefined}>
              <th scope="row">
                <button type="button" className="usage-model-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => onExpand(open ? null : key)}>
                  <ChevronRight size={13} aria-hidden="true" className="usage-disclosure" />
                  <span>{modelLabel(model.model)}<small>{LABELS[model.provider]} · {model.modelTurns ? plural(model.modelTurns, "prompt") : "no prompt ids"}</small></span>
                </button>
              </th>
              <td>{model.pricedTokens ? <><strong>{estimate(componentCost(model))}</strong>{model.unpricedTokens > 0 && <small>partly priced</small>}</> : <span className="usage-none">Unpriced</span>}</td>
              <td><strong>{compact(model.totalTokens)}</strong><small>{percent(model.cacheReadTokens, inputTokens(model))} cache reads</small></td>
              <td className="usage-optional">{average.cost ? <strong>{estimate(average.cost.total)}</strong> : <span className="usage-none">—</span>}{average.tokens && <small>{compact(average.tokens.total)} tokens</small>}</td>
            </tr>
            {open && <tr className="usage-model-panel"><td colSpan={4} id={panelId}>
              <ModelDetail model={model} buckets={detail.buckets} periodRange={periodRange} grain={grain} onGrain={onGrain} />
            </td></tr>}
          </Fragment>;
        })}</tbody>
      </table>
    </section>}
  </>;
}

interface CompareSelection { left: string; right: string; part: Part; measure: Measure }

interface ComparedModel {
  key: string; provider: UsageProvider; model: string; label: string;
  amounts: ModelUsageSummary; average: PromptAverages; pricing?: ModelPricing;
  used: boolean; priced: boolean;
}

/**
 * Two models side by side for the selected range: over time for one billable
 * part, and in total for every part. Selections persist across range changes;
 * a model with nothing in range says so. Re-pricing at current rates is kept
 * separate and labelled hypothetical.
 */
function CompareView({ detail, allTimeModels, rangeLabel, periodRange, grain, onGrain, selection, onSelection }: {
  detail: UsageDetail; allTimeModels: ModelUsageSummary[]; rangeLabel: string; periodRange: UsageRange | null;
  grain: UsageGrain; onGrain: (grain: UsageGrain) => void;
  selection: CompareSelection; onSelection: (value: CompareSelection) => void;
}) {
  const models = detail.providers.flatMap((provider) => provider.models);
  const inRange = new Set(models.map((model) => modelKey(model.provider, model.model)));
  const seen = new Set<string>();
  const options = [...models, ...allTimeModels, ...knownPricedModels()].flatMap((model) => {
    const key = modelKey(model.provider, model.model);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ value: key, label: modelLabel(model.model), detail: `${LABELS[model.provider]} · ${inRange.has(key) ? "used in range" : "no usage in range"}` }];
  });
  if (options.length < 2) return <div className="usage-dashboard-empty"><strong>Nothing to compare yet</strong><p>Comparisons appear once two models have usage or a published rate.</p></div>;
  const leftKey = options.some((option) => option.value === selection.left) ? selection.left : options[0].value;
  const rightKey = options.some((option) => option.value === selection.right) ? selection.right : options.find((option) => option.value !== leftKey)!.value;
  const side = (key: string): ComparedModel => {
    const { provider, model } = splitKey(key);
    const amounts = models.find((item) => item.provider === provider && item.model === model) ?? { provider, model, ...emptyComponentAmounts() };
    return {
      key, provider, model, label: modelLabel(model), amounts, average: promptAverages(bucketsOf(detail.buckets, provider, model), "modelTurns"),
      pricing: ratesFor(provider, model), used: amounts.totalTokens > 0, priced: amounts.pricedTokens > 0,
    };
  };
  const columns = [side(leftKey), side(rightKey)];
  const [a, b] = columns;
  const { part, measure } = selection;
  const partLabel = PARTS.find((item) => item.value === part)!.label;
  const periods = periodRange ? columns.map((item) => usagePeriods(detail.buckets, periodRange, grain, (bucket) => bucket.provider === item.provider && bucket.model === item.model)) : [];
  const labels = periods[0]?.map((period) => periodLabel(period, grain)) ?? [];
  const series = columns.map((item, index) => ({ label: item.label, values: periods[index]?.map((period) => measured(period.amounts, part, measure)) ?? [] }));
  const format = formatMeasure(measure);
  const cell = (value: number | null) => (value === null ? "Unpriced" : format(value));
  const chartTitle = `${partLabel === "All token types" ? (measure === "cost" ? "Estimated cost" : "Tokens") : `${partLabel} ${measure === "cost" ? "cost" : "tokens"}`} by ${grain}`;
  const showChart = labels.length > 1 && columns.some((item) => item.used);
  const set = (patch: Partial<CompareSelection>) => onSelection({ ...selection, left: leftKey, right: rightKey, ...patch });

  const whatIf = (from: ComparedModel, to: ComparedModel) => {
    if (!from.used || !to.pricing || from.key === to.key) return null;
    const { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens, outputTokens } = from.amounts;
    const input = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
    const { costs } = usageCostParts({
      inputTokens: input, cachedInputTokens: cacheReadTokens, cacheWriteInputTokens: cacheWriteTokens, cacheWrite1hInputTokens: cacheWrite1hTokens,
      outputTokens, reasoningOutputTokens: 0, totalTokens: input + outputTokens, contextWindow: null,
    }, to.pricing);
    return costs && { total: costs.uncachedInput + costs.cacheRead + costs.cacheWrite + costs.output, cacheRead: costs.cacheRead };
  };
  const repriced = [[a, b, whatIf(a, b)], [b, a, whatIf(b, a)]] as const;
  const totalCell = (item: ComparedModel, index: number) => {
    if (!item.used) return <td key={index} className="usage-none"><strong>No usage</strong><small>in this range</small></td>;
    return <td key={index}>
      <strong>{item.priced ? estimate(componentCost(item.amounts)) : "Unpriced"}</strong>
      <small>{plural(item.amounts.totalTokens, "token")}{item.priced && item.amounts.unpricedTokens > 0 ? ` · ${number(item.amounts.unpricedTokens)} unpriced` : ""}</small>
    </td>;
  };

  return <section className="usage-dashboard-card usage-compare" aria-labelledby="usage-compare-heading">
    <h5 id="usage-compare-heading">Compare models</h5>
    <div className="usage-compare-pickers">
      <span className="usage-swatch series-1" aria-hidden="true" />
      <AppSelectMenu value={leftKey} options={options} ariaLabel="First model" searchable={options.length > 8} portal onChange={(left) => set({ left })} />
      <span className="usage-compare-vs" aria-hidden="true">vs</span>
      <span className="usage-swatch series-2" aria-hidden="true" />
      <AppSelectMenu value={rightKey} options={options} ariaLabel="Second model" searchable={options.length > 8} portal onChange={(right) => set({ right })} />
    </div>
    <div className="usage-card-controls usage-compare-controls">
      <AppSelectMenu value={part} options={PARTS} ariaLabel="Token type" portal onChange={(value) => set({ part: value as Part })} />
      <Segmented label="Compare measure" options={MEASURES} value={measure} onChange={(value) => set({ measure: value })} />
      <Segmented label="Compare group by" options={GRAINS} value={grain} onChange={onGrain} />
    </div>
    {showChart && <>
      <h6>{chartTitle} · {rangeLabel}</h6>
      <ul className="usage-legend" aria-hidden="true">{columns.map((item, index) => <li key={index}><span className={`usage-swatch series-${index + 1}`} />{item.label}</li>)}</ul>
      <UsageColumnChart periods={labels} series={series} format={format}
        describe={(index) => `${labels[index]} · ${columns.map((item, column) => `${item.label} ${cell(series[column].values[index])}`).join(" · ")}`} />
      <details className="usage-table-toggle">
        <summary><ChevronRight size={13} aria-hidden="true" className="usage-disclosure" />Show as table</summary>
        <div className="usage-table-scroll">
          <table className="usage-compare-periods">
            <caption className="sr-only">{`${chartTitle} · ${a.label} compared with ${b.label} · ${rangeLabel}`}</caption>
            <thead><tr><th scope="col">{grain === "day" ? "Day" : "Week"}</th><th scope="col">{a.label}</th><th scope="col">{b.label}</th></tr></thead>
            <tbody>{labels.map((label, index) => ({ label, index })).reverse().map(({ label, index }) => <tr key={index}>
              <th scope="row">{label}</th>
              {series.map((item, column) => <td key={column}>{cell(item.values[index] ?? null)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </>}

    <table className="usage-compare-table">
      <caption className="sr-only">{`Observed usage and estimated cost · ${a.label} compared with ${b.label} · ${rangeLabel}`}</caption>
      <colgroup><col className="usage-compare-label" /><col /><col /></colgroup>
      <thead><tr><td /><th scope="col">{a.label}</th><th scope="col">{b.label}</th></tr></thead>
      <tbody>{USAGE_COMPONENTS.map((component) => <tr key={component.id}>
        <th scope="row">{component.label}</th>
        {columns.map((item, index) => {
          if (!item.used) return <td key={index} className="usage-none">—</td>;
          if (component.id === "cacheWrite" && !writesReported(item.provider)) return <td key={index} className="usage-none">Not reported</td>;
          const { average } = item;
          return <td key={index}>
            <strong>{item.priced ? estimate(item.amounts[component.cost]) : "Unpriced"}</strong>
            <small>{plural(item.amounts[component.tokens], "token")}{average.tokens ? ` · ${compact(average.tokens[component.id])} per prompt` : ""}</small>
          </td>;
        })}
      </tr>)}</tbody>
      <tbody className="usage-compare-summary">
        <tr><th scope="row">Total</th>{columns.map(totalCell)}</tr>
        <tr><th scope="row">Avg per prompt</th>{columns.map((item, index) => {
          const { average } = item;
          if (!item.used || !average.tokens) return <td key={index} className="usage-none">—</td>;
          return <td key={index}><strong>{average.cost ? estimate(average.cost.total) : "Unpriced"}</strong><small>{plural(average.tokens.total, "token")}</small></td>;
        })}</tr>
        <tr><th scope="row">Prompts using model</th>{columns.map((item, index) => <td key={index} className={item.amounts.modelTurns ? undefined : "usage-none"}>{item.amounts.modelTurns ? number(item.amounts.modelTurns) : "—"}</td>)}</tr>
        <tr><th scope="row">Cache read share of input</th>{columns.map((item, index) => <td key={index} className={inputTokens(item.amounts) ? undefined : "usage-none"}>{inputTokens(item.amounts) ? percent(item.amounts.cacheReadTokens, inputTokens(item.amounts)) : "—"}</td>)}</tr>
      </tbody>
    </table>
    <p className="usage-card-note">
      Costs are estimates frozen at the rate each token was recorded under. A prompt that switched models counts toward each model it used.
      {columns.filter((item) => !item.used).map((item) => ` ${item.label} has no recorded usage in this range.`).join("")}
    </p>

    <details className="usage-compare-hypothetical">
      <summary><ChevronRight size={13} aria-hidden="true" className="usage-disclosure" />Hypothetical: re-price at current standard rates</summary>
      <p>Not what was recorded. Today’s published rates, and each model’s usage above re-priced at the other’s.</p>
      <table className="usage-compare-table usage-compare-rates">
        <caption className="sr-only">{`Current standard rates per million tokens · ${a.label} and ${b.label}`}</caption>
        <colgroup><col className="usage-compare-label" /><col /><col /></colgroup>
        <thead><tr><td>Per 1M tokens</td><th scope="col">{a.label}</th><th scope="col">{b.label}</th></tr></thead>
        <tbody>{USAGE_COMPONENTS.map((component) => <tr key={component.id}>
          <th scope="row">{component.label}</th>
          {columns.map((item, index) => <td key={index} className={item.pricing ? undefined : "usage-none"}>{item.pricing ? RATE_OF[component.id](item.pricing) : "No rate"}</td>)}
        </tr>)}</tbody>
      </table>
      {repriced.some(([, , result]) => result) && <ul className="usage-compare-whatif">
        {repriced.map(([from, to, result]) => result && <li key={from.key}>
          {from.label}’s usage at {to.label} rates: <strong>{estimate(result.total)}</strong>
          {from.amounts.cacheReadTokens > 0 && <> · cache reads <strong>{estimate(result.cacheRead)}</strong></>}
        </li>)}
      </ul>}
      <p>Re-pricing keeps the same token counts, but model families tokenize text differently, so a cross-provider comparison is approximate.</p>
    </details>
  </section>;
}

const OFFICIAL_LABELS: Record<OfficialPricingSource, string> = { openai: "OpenAI pricing page", anthropic: "Claude pricing page", cursor: "Cursor pricing page" };
const OFFICIAL_LINKS: Record<OfficialPricingSource, string> = { openai: "OpenAI pricing", anthropic: "Claude pricing", cursor: "Cursor pricing" };
const OFFICIAL_URLS: Record<OfficialPricingSource, string> = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  cursor: "https://cursor.com/docs/models-and-pricing",
};

function when(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return localDayKey(date) === localDayKey() ? `today ${time}` : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

type SourceState = { tone: "ok" | "warn" | "idle"; text: string; detail?: string };

/** Never reports success for a page that failed: a failure always shows, with
 * how old the rates still in use are. */
function officialSourceState(status: OfficialPricingStatus): SourceState {
  if (status.checking && !status.checkedAt) return { tone: "idle", text: "Checking…" };
  if (status.error) {
    return {
      tone: "warn",
      text: `Couldn’t verify ${status.checkedAt ? when(status.checkedAt) : ""} · ${status.verifiedAt ? `using rates verified ${when(status.verifiedAt)}` : "using catalog and bundled rates"}`,
      detail: status.error,
    };
  }
  if (status.verifiedAt) return { tone: "ok", text: `${plural(status.models, "model")} verified ${when(status.verifiedAt)}` };
  return { tone: "idle", text: "Not checked yet · using catalog and bundled rates" };
}

function catalogSourceState(status: ReturnType<typeof pricingRefreshStatus>, revision: string): SourceState {
  const published = revision === "bundled" ? null : new Date(revision).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  if (status.error) return { tone: "warn", text: `Couldn’t refresh · ${published ? `copy published ${published} in use` : "bundled rates in use"}` };
  return published ? { tone: "ok", text: `Fallback · published ${published}` } : { tone: "idle", text: "Fallback · not downloaded yet" };
}

function SourceRow({ label, tone, text, detail }: SourceState & { label: string }) {
  return <li className={`usage-pricing-source ${tone}`}>
    <span className="usage-pricing-dot" aria-hidden="true" />
    <span>{label}</span>
    <small>{text}{detail && <span className="usage-pricing-detail">{detail}</span>}</small>
  </li>;
}

/** Rate freshness at a glance, with every source and caveat on demand. */
function PricingStatus({ onRefreshPricing, openRouterPricingError }: { onRefreshPricing?: () => Promise<void>; openRouterPricingError?: string }) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const pricing = pricingRefreshStatus();
  const official = officialPricingStatus();
  const checking = refreshing || pricing.checking || official.some((status) => status.checking);
  const states = official.map((status) => ({ status, state: officialSourceState(status) }));
  const catalog = catalogSourceState(pricing, modelPricingCatalogRevision());
  const warn = refreshError || catalog.tone === "warn" || Boolean(openRouterPricingError) || states.some(({ state }) => state.tone === "warn");
  const verified = Math.max(0, ...official.map((status) => status.verifiedAt ?? 0));
  const headline = checking ? "Checking pricing pages…" : warn ? "Some rates couldn’t be verified" : verified ? `Rates verified ${when(verified)}` : "Using bundled rates";
  const refresh = async () => {
    if (!onRefreshPricing || checking) return;
    setRefreshing(true);
    setRefreshError(false);
    try { await onRefreshPricing(); } catch { setRefreshError(true); }
    finally { setRefreshing(false); }
  };
  return <div className="usage-pricing">
    <details className="usage-pricing-details">
      <summary className={warn ? "warn" : verified ? "ok" : "idle"}>
        <span className="usage-pricing-dot" aria-hidden="true" /><span>{headline}</span><ChevronRight size={13} aria-hidden="true" className="usage-disclosure" />
        <span className="sr-only"> · rate sources and what estimates include</span>
      </summary>
      <div className="usage-pricing-panel">
        <p>Rates are read from each provider’s pricing page at most once a day, and whenever you refresh. New usage takes each model’s most recently verified rate. Earlier estimates keep the rate they were recorded at unless historical evidence supports a correction for dated, model-specific usage. Then that usage is repriced automatically.</p>
        <ul className="usage-pricing-sources" aria-label="Rate sources">
          {states.map(({ status, state }) => <SourceRow key={status.source} label={OFFICIAL_LABELS[status.source]} {...state} />)}
          <SourceRow label="Mythra catalog" {...catalog} />
          {openRouterPricingError !== undefined && <SourceRow label="OpenRouter" tone={openRouterPricingError ? "warn" : "ok"} text={openRouterPricingError ? "Couldn’t refresh · saved rates in use" : "Live model rates"} />}
        </ul>
        <h6>What estimates include</h6>
        <ul className="usage-pricing-notes">
          <li>Standard, short-context API rates. Batch, Flex, Fast or priority, long-context, and data-residency pricing aren’t visible in reported usage and aren’t applied.</li>
          <li>Where a provider lists no separate cache rate, those tokens are priced as input. Claude’s 1-hour cache writes use the 1-hour rate; usage recorded before this app read that split used the 5-minute rate.</li>
          <li>Cursor models are priced at Cursor’s listed rate only when the model name matches exactly. Auto isn’t priced because Cursor doesn’t report where it routed. Cursor doesn’t report cache writes, and the Teams and Enterprise token rate isn’t added, so Cursor estimates may be low.</li>
          <li>A past rate is supported only if the pricing page showed it both before and after that time, with no more than two days between checks, or if the Mythra catalog gives the date and time it took effect. Two matching reads cannot rule out a change and reversal between them. A rate first seen after the usage is never applied to it. Usage without a known model and time can’t be repriced. That includes usage from before dated tracking, and days before this app recorded rates that mix priced and unpriced usage.</li>
          <li>OpenRouter charges come from cost receipts captured by this app. Earlier requests, interrupted responses without a receipt, and activity in other apps are not included. This is not an invoice.</li>
        </ul>
        <div className="usage-dashboard-sources">
          {(Object.keys(OFFICIAL_URLS) as OfficialPricingSource[]).map((source) => <button key={source} type="button" className="secondary-button" onClick={() => void openUrl(OFFICIAL_URLS[source])}><ExternalLink size={12} />{OFFICIAL_LINKS[source]}</button>)}
          <button type="button" className="secondary-button" onClick={() => void openUrl("https://openrouter.ai/activity")}><ExternalLink size={12} />OpenRouter activity</button>
        </div>
      </div>
    </details>
    {onRefreshPricing && <button type="button" className="secondary-button usage-refresh" disabled={checking} onClick={() => void refresh()}><RefreshCw size={13} aria-hidden="true" />{checking ? "Checking…" : "Refresh pricing"}</button>}
    {(pricing.error || refreshError) && <p className="usage-pricing-error" role="status">Some pricing sources couldn’t be checked. Last known rates remain in use.</p>}
  </div>;
}

export function UsageDashboard({ onRefreshPricing, openRouterPricingError }: {
  onRefreshPricing?: () => Promise<void>;
  openRouterPricingError?: string;
}) {
  // Subscribe here, not in App: background usage updates this page without
  // rerendering the chat shell or parsing any transcript history.
  useSyncExternalStore(subscribeUsage, getUsageRevision, getUsageRevision);
  const preview = useUsageDashboardPreview();
  const source = preview ?? LIVE_SOURCE;
  const baseId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  // Open on the last 30 days; before any dated detail exists, all time is the
  // only range with anything to show.
  const [preset, setPreset] = useState<Preset>(() => (source.detail(null).startedDay ? "30d" : "all"));
  const [view, setView] = useState<View>("overview");
  const [chosenGrain, setGrain] = useState<UsageGrain | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const today = localDayKey();
  const [custom, setCustom] = useState(() => ({ from: shiftDayKey(today, -6), to: today }));
  const range = rangeFor(preset, today, custom);
  const detail = source.detail(range);
  const allTime = range ? source.detail(null) : detail;
  const allTimeModels = allTime.providers.flatMap((provider) => provider.models);
  const [selection, setSelection] = useState<CompareSelection>(() => {
    const ranked = [...detail.providers.flatMap((provider) => provider.models), ...allTimeModels]
      .map((model) => modelKey(model.provider, model.model));
    const unique = [...new Set(ranked)];
    return { left: unique[0] ?? "", right: unique[1] ?? "", part: "total", measure: "cost" };
  });
  const { totals, unallocated } = detail;
  const reported = source.reported();
  const trackedFrom = detail.retainedFrom ?? detail.startedDay;
  // Periods span the chosen range; all time spans the retained dated detail.
  const periodRange = range ?? (trackedFrom ? { from: trackedFrom, to: today } : null);
  const grain = chosenGrain ?? (periodRange ? autoGrain(periodRange) : "day");
  const rangeLabel = range ? (range.from === range.to ? formatDay(range.from) : `${formatDay(range.from)} – ${formatDay(range.to)}`) : "All time";

  const coverageNote = !detail.startedDay
    ? (unallocated ? "Dated, per-model detail starts with your next message. Usage recorded earlier stays in the all-time and provider totals." : null)
    : detail.detailAhead
      ? "Some dated detail was saved without its all-time total (the app likely closed mid-save). All-time totals use the saved ledger; dated detail is hidden until the records agree."
    : range && trackedFrom && range.from < trackedFrom
      ? `Dated detail begins ${formatDay(trackedFrom)}. Earlier usage is only in All time and can’t be split by date or model.`
      : !range && unallocated && trackedFrom
          ? unallocated.totalTokens === 0 && unallocated.estimatedCost !== 0
            ? "A pricing adjustment is included in all-time and provider cost but has not reached dated detail. Cost by model and date may differ until those records agree."
            : `Dated detail began ${formatDay(trackedFrom)}. ${number(unallocated.totalTokens)} earlier tokens are counted in totals and under their provider where it’s known, but can’t be split by date, model, or prompt.`
          : null;

  const tabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = VIEWS.findIndex((item) => item.id === view);
    const next = event.key === "ArrowRight" ? (index + 1) % VIEWS.length : event.key === "ArrowLeft" ? (index - 1 + VIEWS.length) % VIEWS.length
      : event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setView(VIEWS[next].id);
    tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const empty = !totals.totalTokens && !unallocated;

  return <section className="set-group usage-dashboard" aria-label="Local usage">
    <header className="usage-dashboard-head">
      <div>
        <h4 className="usage-dashboard-heading">Local usage</h4>
        <p>What Mythra Code recorded on this device, priced at API-equivalent rates. Not your whole provider account, and not a subscription bill.</p>
      </div>
      <PricingStatus onRefreshPricing={onRefreshPricing} openRouterPricingError={openRouterPricingError} />
    </header>
    {preview?.preview && <p className="usage-preview-banner" role="note">Development preview — synthetic usage, not your data.</p>}
    <div className="usage-toolbar">
      <RangePicker preset={preset} onPreset={setPreset} custom={custom} onCustom={setCustom} today={today} />
      <div ref={tabs} className="usage-tabs" role="tablist" aria-label="Usage views">
        {VIEWS.map((item) => <button key={item.id} type="button" role="tab" id={`${baseId}-tab-${item.id}`} aria-selected={view === item.id}
          aria-controls={`${baseId}-panel`} tabIndex={view === item.id ? 0 : -1} className={view === item.id ? "selected" : ""}
          onClick={() => setView(item.id)} onKeyDown={tabKeyDown}>{item.label}</button>)}
      </div>
    </div>
    {coverageNote && <p className="usage-coverage" role="note">{coverageNote}</p>}

    <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${view}`} className="usage-panel">
      {empty
        ? <div className="usage-dashboard-empty"><strong>{range ? "No usage in this range" : "Your usage story starts here"}</strong><p>{range ? "Try a wider range, or All time." : "Send a message to begin tracking. Only usage the provider reports to this app can appear here."}</p></div>
        : view === "overview" ? <Overview detail={detail} range={range} periodRange={periodRange} grain={grain} onGrain={setGrain} />
          : view === "models" ? <ModelsView detail={detail} range={range} periodRange={periodRange} grain={grain} onGrain={setGrain} expanded={expanded} onExpand={setExpanded} />
            : <CompareView detail={detail} allTimeModels={allTimeModels} rangeLabel={rangeLabel} periodRange={periodRange} grain={grain} onGrain={setGrain} selection={selection} onSelection={setSelection} />}
    </div>

    <p className="usage-receipts" aria-label="OpenRouter reported charges" role="group">
      <span>OpenRouter reported charges<small>{reported.requests ? `${plural(reported.requests, "captured request")} · all time · not added to estimates` : "No cost receipts captured yet"}</small></span>
      <strong>{reported.requests ? formatEstimatedCost(reported.cost) : "—"}</strong>
    </p>
  </section>;
}

import { useState, useSyncExternalStore } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  formatEstimatedCost, getUsageRevision, modelPricingCatalogRevision, openRouterReportedCost,
  pricingRefreshStatus, providerUsageTotals, subscribeUsage, usageTotals, type UsageProvider,
} from "../lib/usageLedger";
import "./UsageDashboard.css";

const LABELS: Record<UsageProvider, string> = {
  openai: "OpenAI / Codex", claude: "Claude Code", openrouter: "OpenRouter",
  cursor: "Cursor", lmstudio: "LM Studio", unknown: "Earlier / unattributed",
};
const number = (value: number) => value.toLocaleString();

export function UsageDashboard({ onRefreshPricing, openRouterPricingError }: {
  onRefreshPricing?: () => Promise<void>;
  openRouterPricingError?: string;
}) {
  // Subscribe here, not in App: background usage updates this page without
  // rerendering the chat shell or parsing any transcript history.
  useSyncExternalStore(subscribeUsage, getUsageRevision, getUsageRevision);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const totals = usageTotals();
  const providers = providerUsageTotals();
  const reported = openRouterReportedCost();
  const pricing = pricingRefreshStatus();
  const revision = modelPricingCatalogRevision();
  const billedTokens = totals.pricedTokens + totals.unpricedTokens;
  const coverage = billedTokens ? Math.round(totals.pricedTokens / billedTokens * 100) : null;
  const composition = [
    { label: "Input · uncached", value: Math.max(0, totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteInputTokens), className: "input" },
    { label: "Cache read", value: totals.cachedInputTokens, className: "cached" },
    { label: "Cache write", value: totals.cacheWriteInputTokens, className: "written" },
    { label: "Output", value: totals.outputTokens, className: "output" },
    { label: "Other reported tokens", value: Math.max(0, totals.totalTokens - totals.inputTokens - totals.outputTokens), className: "other" },
  ].filter((part) => part.value > 0);
  const refresh = async () => {
    if (!onRefreshPricing || refreshing || pricing.checking) return;
    setRefreshing(true);
    setRefreshError(false);
    try { await onRefreshPricing(); } catch { setRefreshError(true); }
    finally { setRefreshing(false); }
  };

  return <section className="settings-section usage-dashboard" aria-label="All-time local usage">
    <div className="settings-section-heading usage-dashboard-heading">
      <div><h3>All-time local usage</h3><p>Usage recorded by Mythra Code on this device, across your threads. Not your entire provider account history.</p></div>
    </div>
    <div className="usage-dashboard-stats">
      <div><span>Total tokens</span><strong>{number(totals.totalTokens)}</strong><small>{number(totals.threads)} tracked thread{totals.threads === 1 ? "" : "s"}</small></div>
      <div><span>Estimated API-equivalent value</span><strong>{totals.pricedTokens ? `≈ ${formatEstimatedCost(totals.estimatedCost)}` : "—"}</strong><small>{coverage === null ? "No usage recorded yet" : `${coverage}% of input/output tokens priced`}</small></div>
      <div><span>OpenRouter reported charges</span><strong>{reported.requests ? formatEstimatedCost(reported.cost) : "—"}</strong><small>{reported.requests ? `${number(reported.requests)} captured request${reported.requests === 1 ? "" : "s"}` : "No cost receipts captured yet"}</small></div>
    </div>
    <p className="usage-dashboard-caption">Estimates are in USD, not subscription bills. Reported OpenRouter charges are shown separately and are not added to the estimate.</p>

    {!totals.totalTokens && <div className="usage-dashboard-empty"><strong>Your usage story starts here</strong><p>Send a message to begin tracking. Only usage the provider reports to this app can appear here.</p></div>}
    {totals.totalTokens > 0 && <div className="usage-dashboard-charts">
      <section className="usage-dashboard-card" aria-label="Tokens by provider">
        <h4>Tokens by provider</h4><p>Share of all recorded tokens</p>
        <div className="usage-provider-bars">
          {providers.map((provider) => <div key={provider.provider}>
            <div><span>{LABELS[provider.provider]}</span><strong>{number(provider.totalTokens)} <small>· {(provider.totalTokens / totals.totalTokens * 100).toFixed(1)}%</small></strong></div>
            <div className="usage-chart-track" aria-hidden="true"><span style={{ width: `${Math.min(100, provider.totalTokens / totals.totalTokens * 100)}%` }} /></div>
          </div>)}
        </div>
      </section>
      <section className="usage-dashboard-card" aria-label="Token composition">
        <h4>Where tokens go</h4><p>Caching is part of input, not extra tokens</p>
        <div className="usage-composition-bar" aria-hidden="true">{composition.map((part) => <span key={part.label} className={part.className} style={{ flexGrow: part.value }} />)}</div>
        <dl className="usage-composition-legend">{composition.map((part) => <div key={part.label}><dt><i className={part.className} />{part.label}</dt><dd>{number(part.value)}</dd></div>)}</dl>
        {totals.reasoningOutputTokens > 0 && <p>{number(totals.reasoningOutputTokens)} reasoning tokens included in output.</p>}
      </section>
    </div>}

    {providers.length > 0 && <section className="usage-dashboard-card usage-provider-detail">
      <h4>Provider breakdown</h4>
      <div className="usage-dashboard-table-scroll" tabIndex={0} role="region" aria-label="Provider usage details">
        <table><thead><tr><th scope="col">Provider / tokens</th><th scope="col">API estimate</th><th scope="col">Reported charges</th></tr></thead>
          <tbody>{providers.map((provider) => <tr key={provider.provider}>
            <th scope="row">{LABELS[provider.provider]}<small>{number(provider.inputTokens)} input · {number(provider.outputTokens)} output</small></th>
            <td>{provider.pricedTokens ? `≈ ${formatEstimatedCost(provider.estimatedCost)}` : "Unavailable"}{provider.unpricedTokens > 0 && <small>{number(provider.unpricedTokens)} tokens unpriced</small>}</td>
            <td>{provider.provider === "openrouter" ? reported.requests ? formatEstimatedCost(reported.cost) : "Not captured" : "Not tracked"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {providers.some((provider) => provider.provider === "unknown") && <p>Earlier / unattributed usage has no saved provider label. It is retained in your totals, never assigned to a guessed provider.</p>}
    </section>}

    <section className="usage-dashboard-card usage-pricing-status" aria-label="Pricing and coverage">
      <div className="usage-pricing-heading"><h4>Pricing &amp; coverage</h4>{onRefreshPricing && <button className="secondary-button" disabled={refreshing || pricing.checking} onClick={() => void refresh()}><RefreshCw size={13} />{refreshing || pricing.checking ? "Checking…" : "Refresh pricing"}</button>}</div>
      <p>{revision === "bundled" ? "Using bundled model rates." : `Mythra pricing catalog published ${new Date(revision).toLocaleDateString()}.`}{pricing.checkedAt ? ` Last checked ${new Date(pricing.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : " Pricing is checked when the app opens."}</p>
      {(pricing.error || refreshError) && <p role="status">{pricing.error ?? "Could not refresh all pricing sources. Last known rates remain in use."}</p>}
      {openRouterPricingError && <p role="status">OpenRouter pricing could not refresh. Available saved rates are used.</p>}
      <ul>
        <li>Mythra’s validated catalog and OpenRouter’s model rates refresh at launch. New rates apply to future usage; saved estimates are not rewritten.</li>
        <li>{number(totals.unpricedTokens)} input/output tokens have no saved rate and are excluded from estimates. Missing prices are not treated as free.</li>
        <li>Estimates include reported cache usage, but exclude subscription fees and regional, long-context, priority, tool and other special charges.</li>
        <li>OpenRouter charges come from cost receipts captured by this app. Earlier requests, interrupted responses without a receipt, and activity in other apps are not included. This is not an invoice.</li>
      </ul>
      <div className="usage-dashboard-sources">
        <button className="secondary-button" onClick={() => void openUrl("https://developers.openai.com/api/docs/models/compare")}><ExternalLink size={12} />OpenAI pricing</button>
        <button className="secondary-button" onClick={() => void openUrl("https://www.anthropic.com/pricing")}><ExternalLink size={12} />Anthropic pricing</button>
        <button className="secondary-button" onClick={() => void openUrl("https://openrouter.ai/activity")}><ExternalLink size={12} />OpenRouter activity</button>
      </div>
    </section>
  </section>;
}

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Bot, ChevronRight, Files, Info, Layers3, RefreshCw, Shrink } from "lucide-react";
import type { TokenUsageView } from "./StudioDock";
import type { Provider } from "../types";
import { threadUsageSummary, type ThreadUsageAmounts, type ThreadUsageSummary } from "../lib/threadUsage";
import type { NativeAgentLink, OwnershipLinks } from "../lib/nativeAgentLinks";
import { readClaudeThreadContext, type ClaudeThreadContextResult } from "../lib/threadContext";
import { contextUsagePercent } from "../lib/contextUsage";
import { formatEstimatedCost, getUsageRevision, subscribeUsage } from "../lib/usageLedger";
import "./ThreadUsagePanel.css";

export interface ThreadUsagePanelProps {
  activeThread: boolean;
  threadId?: string;
  turnId?: string;
  provider?: Provider;
  threadTitle?: string;
  nativeLinks: Record<string, NativeAgentLink>;
  managedLinks: OwnershipLinks;
  /** Latest selected-thread reading; never an aggregate of child contexts. */
  context: TokenUsageView | null;
  visibleAttachments?: { images: number; documents: number; files: number };
  onCompact: () => void;
  onRefresh?: () => void;
  /** The Tools dock shows the title, Refresh and Compact in its own header. */
  hideToolbar?: boolean;
  /** Usage recorded on another machine, in place of this one's ledger. */
  hostSummary?: ThreadUsageSummary | null;
}

function available(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function tokens(value: number | null | undefined): string {
  return available(value) ? value.toLocaleString() : "Unavailable";
}

function cost(amounts: ThreadUsageAmounts | undefined): string {
  const value = amounts?.estimatedCost;
  return available(value) ? `≈ ${formatEstimatedCost(value)}` : "Unavailable";
}

function readableUsage(amounts: ThreadUsageAmounts | undefined): TokenUsageView | null {
  return amounts?.usage && amounts.usage.tokenAvailability !== "unavailable" ? amounts.usage : null;
}

function cacheReading(value: number | undefined, reported: boolean | undefined, unknown: number | undefined): string {
  if (reported === true && !unknown) return tokens(value);
  return available(value) && value > 0 ? `${tokens(value)} reported · partial` : "Unavailable";
}

function outputReading(value: number | undefined, reported: boolean | undefined): string {
  if (reported !== false) return tokens(value);
  return available(value) && value > 0 ? `${tokens(value)} reported · partial` : "Unavailable";
}

function AmountRow({ label, amounts }: { label: string; amounts: ThreadUsageAmounts }) {
  const usage = readableUsage(amounts);
  return <div className="thread-usage-amount-row">
    <span>{label}</span>
    <div><strong>{cost(amounts)}</strong><small>{usage ? `${tokens(usage.totalTokens)} tokens` : "Tokens unavailable"}</small></div>
  </div>;
}

function sampledAge(sampledAt: number | null): string {
  if (!available(sampledAt)) return "Sample time unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - sampledAt) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(sampledAt).toLocaleDateString();
}

const subscribeNoUsage = () => () => {};

/** Whether Mythra Code can compact this provider's context (others manage their own). */
export function threadUsageCanCompact(provider: Provider | undefined): boolean {
  return provider === "openai" || provider === "openrouter" || provider === "lmstudio";
}

export function ThreadUsagePanel({ activeThread, threadId, turnId, provider, threadTitle, nativeLinks, managedLinks, context, visibleAttachments, onCompact, onRefresh, hostSummary, hideToolbar }: ThreadUsagePanelProps) {
  // Keep global ledger notifications inside this mounted panel instead of
  // rerendering the app shell and rescanning its loaded messages on each write.
  const usageRevision = useSyncExternalStore(activeThread && threadId ? subscribeUsage : subscribeNoUsage, getUsageRevision);
  const remote = hostSummary !== undefined;
  const summary = useMemo(() => remote ? hostSummary : activeThread && threadId
    ? threadUsageSummary({ threadId, nativeLinks, managedLinks })
    : null, [activeThread, hostSummary, remote, threadId, nativeLinks, managedLinks, usageRevision]);
  // Missing live fields own availability: do not revive stale ledger fields.
  const current = context ? {
    totalTokens: context.contextTokens,
    inputTokens: context.contextInputTokens,
    outputTokens: context.contextOutputTokens,
    cachedInputTokens: context.contextCachedInputTokens,
    reasoningOutputTokens: context.contextReasoningOutputTokens,
    contextWindow: context.contextWindow,
  } : summary?.context;
  const canReadContext = !remote && activeThread && provider === "claude" && Boolean(threadId && turnId);
  const requestKey = JSON.stringify([canReadContext, threadId, turnId, current?.totalTokens, current?.inputTokens, current?.outputTokens, current?.cachedInputTokens, current?.reasoningOutputTokens, current?.contextWindow]);
  const [contextRead, setContextRead] = useState<{ key: string; result: ClaudeThreadContextResult } | null>(null);
  useEffect(() => {
    if (!canReadContext || !threadId || !turnId) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void readClaudeThreadContext(threadId, turnId).then((result) => {
        if (!disposed && result.threadId === threadId && result.turnId === turnId) setContextRead({ key: requestKey, result });
      });
    }, 250);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [canReadContext, threadId, turnId, requestKey]);
  // Retain only this exact turn's previous sample while token changes trigger
  // a fresh read. Another selection's report can never appear in this panel.
  const nativeContext = canReadContext && contextRead && contextRead.result.threadId === threadId && contextRead.result.turnId === turnId ? contextRead.result : null;
  const previousSample = Boolean(nativeContext?.report && contextRead?.key !== requestKey);
  const report = nativeContext?.report;

  if (!activeThread) return <div className="thread-usage thread-usage-empty">
    <Layers3 size={22} aria-hidden="true" />
    <strong>No usage yet</strong>
    <p>Context and cost appear here after the first message.</p>
  </div>;

  const usage = readableUsage(summary?.total);
  const childCount = summary?.descendants.length ?? 0;
  const missingChildren = summary?.missingThreadIds.filter((id) => id !== summary.threadId).length ?? 0;
  const ownMissing = summary ? summary.missingThreadIds.includes(summary.threadId) : true;
  const unpriced = summary?.total.unpricedTokens ?? 0;
  const partialHistoryCount = summary?.historyPartialThreadIds.length ?? 0;
  const outputPartial = usage?.outputTokensReported === false;
  const partial = Boolean(ownMissing || missingChildren || unpriced || partialHistoryCount || outputPartial || usage?.tokenAvailability === "partial");
  const hasEstimate = available(summary?.total.estimatedCost);
  const contextTotal = report ? report.totalTokens : current?.totalTokens;
  const contextWindow = report ? report.maxTokens : current?.contextWindow;
  const contextPercent = report && available(report.percentage)
    ? Math.min(100, report.percentage)
    : contextUsagePercent({ contextTokens: contextTotal, contextWindow });
  const contextHigh = contextPercent !== null && contextPercent >= 85;
  const canCompact = threadUsageCanCompact(provider);
  // Only readings that exist. Image and document splits are never reported
  // by these runtimes, so they are not listed as "Unavailable" rows.
  const lastRequest = [
    available(current?.inputTokens) ? `${tokens(current?.inputTokens)} in` : null,
    available(current?.outputTokens) ? `${tokens(current?.outputTokens)} out` : null,
  ].filter(Boolean).join(" · ");
  const breakdown = report?.messageBreakdown;
  const messageRows: Array<{ label: string; value: number | null }> = breakdown ? [
    { label: "User messages", value: breakdown.userMessageTokens },
    { label: "Assistant messages", value: breakdown.assistantMessageTokens },
    { label: "Tool calls", value: breakdown.toolCallTokens },
    { label: "Tool results", value: breakdown.toolResultTokens },
    { label: "Attachments", value: breakdown.attachmentTokens },
    { label: "Redirected context", value: breakdown.redirectedContextTokens },
    { label: "Unattributed", value: breakdown.unattributedTokens },
  ].filter((row) => available(row.value)) : [];
  const attachmentsShown = visibleAttachments && (visibleAttachments.images + visibleAttachments.documents + visibleAttachments.files) > 0;
  const totalRows: Array<{ label: string; hint?: string; value: string }> = usage ? [
    { label: "Input", value: tokens(usage.inputTokens) },
    { label: "Output", value: outputReading(usage.outputTokens, usage.outputTokensReported) },
    ...(usage.cacheReadReported !== undefined || (available(usage.cachedInputTokens) && usage.cachedInputTokens > 0) ? [{ label: "Cache read", hint: "within input", value: cacheReading(usage.cachedInputTokens, usage.cacheReadReported, usage.cacheReadUnknownTokens) }] : []),
    ...(usage.cacheWriteReported !== undefined || (available(usage.cacheWriteInputTokens) && usage.cacheWriteInputTokens > 0) ? [{ label: "Cache write", hint: "within input", value: cacheReading(usage.cacheWriteInputTokens, usage.cacheWriteReported, usage.cacheWriteUnknownTokens) }] : []),
    ...(available(usage.reasoningOutputTokens) && usage.reasoningOutputTokens > 0 ? [{ label: "Reasoning", hint: "within output", value: outputReading(usage.reasoningOutputTokens, usage.outputTokensReported) }] : []),
  ] : [];

  return <div className="thread-usage">
    {!hideToolbar && <div className="thread-usage-toolbar">
      <span className="thread-usage-scope" title={threadTitle || "Current conversation"}><span className="thread-usage-scope-dot" aria-hidden="true" /><span className="thread-usage-scope-title">{threadTitle || "Current conversation"}</span></span>
      <div className="thread-usage-actions">
        {onRefresh && <button type="button" onClick={onRefresh} aria-label="Refresh prices" title="Refresh prices"><RefreshCw size={13} aria-hidden="true" /></button>}
        <button type="button" onClick={onCompact} disabled={!canCompact} title={canCompact ? "Summarize older turns to free context" : "This provider manages its own context compaction"}><Shrink size={13} aria-hidden="true" />Compact context</button>
      </div>
    </div>}

    <section className={`thread-usage-card thread-usage-context${contextHigh ? " high" : ""}`} aria-label="Current context">
      <div className="thread-usage-section-head">
        <h3>Context</h3>
        <span className="thread-usage-eyebrow" title={report ? "Claude's own summary of this turn's context. Sub-agents have separate windows." : "The latest reading from the provider. It can shrink after compaction; sub-agents have their own windows."}>{report ? "Approximate" : "Latest reading"}</span>
      </div>
      <div className="thread-usage-context-reading">
        <div><strong className={!available(contextTotal) ? "unavailable" : undefined}>{available(contextTotal) ? `${report ? "≈ " : ""}${tokens(contextTotal)}` : "Not reported yet"}</strong>{available(contextWindow) && contextWindow > 0 && <span>of {tokens(contextWindow)} tokens</span>}</div>
        {contextPercent !== null && <b>{Math.round(contextPercent)}<small>%</small></b>}
      </div>
      {contextPercent !== null && <div className="thread-usage-context-track" role="progressbar" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(contextPercent)} aria-valuetext={`${Math.round(contextPercent)}% used`}><span style={{ width: `${contextPercent}%` }} /></div>}
      {!report && lastRequest && <p className="thread-usage-meta" title="Tokens sent and received by the most recent request. Not a full breakdown of the context.">Last request · {lastRequest}</p>}
      {report && nativeContext && <>
        <div className="thread-usage-context-freshness"><span className={`thread-usage-badge${previousSample || nativeContext.status === "cached" ? " partial" : ""}`}>{previousSample ? "Previous sample" : nativeContext.status === "cached" ? "Cached" : "Snapshot"}</span><span title={nativeContext.sampledAt ? new Date(nativeContext.sampledAt).toLocaleString() : undefined}>{sampledAge(nativeContext.sampledAt)}</span></div>
        {nativeContext.status === "cached" && nativeContext.reason && <p className="thread-usage-note">{nativeContext.reason}</p>}
        <details className="thread-usage-details">
          <summary><ChevronRight size={13} aria-hidden="true" />Breakdown</summary>
          <dl className="thread-usage-provider-categories">{report.categories.map((category, index) => <div key={`${category.id ?? category.name}-${index}`}><dt>{category.name}{category.kind && category.kind !== "used" && <small>{category.kind === "free" ? "free capacity" : category.kind === "buffer" ? "reserved buffer" : "deferred"}</small>}</dt><dd className={!available(category.tokens) ? "unavailable" : undefined}>{available(category.tokens) ? `≈ ${tokens(category.tokens)}` : "Unavailable"}</dd></div>)}</dl>
          {report.messageBreakdown?.attachmentsByType && report.messageBreakdown.attachmentsByType.length > 0 && <div className="thread-usage-native-attachments"><h4>Attachment tokens by type</h4><dl>{report.messageBreakdown.attachmentsByType.map((attachment, index) => <div key={`${attachment.name}-${index}`}><dt>{attachment.name}</dt><dd>{available(attachment.tokens) ? `≈ ${tokens(attachment.tokens)}` : "Unavailable"}</dd></div>)}</dl></div>}
          {messageRows.length > 0 && <><h4 className="thread-usage-subhead">Messages &amp; tools</h4><dl>{messageRows.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>≈ {tokens(value)}</dd></div>)}</dl></>}
          <p className="thread-usage-note">These groups can overlap, so they don&rsquo;t add up to the total.</p>
        </details>
      </>}
      {!report && nativeContext?.reason && <p className="thread-usage-note">{nativeContext.reason}</p>}
      {contextHigh && <p className="thread-usage-context-warning">Context is nearly full. {canCompact ? "Compact older turns to make room." : "This provider compacts its own context."}</p>}
    </section>

    <section className="thread-usage-card thread-usage-cost" aria-label="API-equivalent cost">
      <div className="thread-usage-section-head">
        <h3>Cost</h3>
        <span className={`thread-usage-badge${partial && hasEstimate ? " partial" : ""}`} title={`What this conversation${childCount ? ` and its ${childCount} sub-agent thread${childCount === 1 ? "" : "s"}` : ""} would cost at API rates. Subscription payments are separate.`}>{hasEstimate ? partial ? "Partial estimate" : "API-equivalent" : "Not priced"}</span>
      </div>
      <strong className={`thread-usage-cost-value${!hasEstimate ? " unavailable" : ""}`}>{hasEstimate ? cost(summary?.total) : "—"}</strong>
      {summary && (childCount > 0 || summary.claudeNativeIncluded) && <div className="thread-usage-cost-scope">
        <AmountRow label="This thread" amounts={summary.own} />
        {childCount > 0 && <AmountRow label="Sub-agents" amounts={summary.subagents} />}
      </div>}
      {(unpriced > 0 || ownMissing || missingChildren > 0 || partialHistoryCount > 0 || outputPartial || summary?.claudeNativeIncluded) && <div className="thread-usage-coverage">
        <Info size={13} aria-hidden="true" />
        <div>
          {unpriced > 0 && <p>{tokens(unpriced)} tokens have no price and aren&rsquo;t in the estimate.</p>}
          {ownMissing && <p>No usage has been recorded for this thread yet.</p>}
          {missingChildren > 0 && <p>{missingChildren} sub-agent thread{missingChildren === 1 ? " has" : "s have"} no usage recorded.</p>}
          {partialHistoryCount > 0 && <p>Older usage was archived for {partialHistoryCount === 1 ? "one conversation" : `${partialHistoryCount} conversations`}; amounts cover what&rsquo;s kept.</p>}
          {outputPartial && <p>Some output wasn&rsquo;t reported. Totals cover known tokens.</p>}
          {summary?.claudeNativeIncluded && <p>Includes recorded Claude sub-agent requests; older or unreported work may be missing.</p>}
        </div>
      </div>}
    </section>

    <details className="thread-usage-details thread-usage-totals">
      <summary><ChevronRight size={13} aria-hidden="true" />Token totals<span className="thread-usage-summary-value">{usage ? tokens(usage.totalTokens) : "None yet"}</span></summary>
      <p className="thread-usage-note">Every recorded request{childCount ? ", including sub-agents" : ""}. History sent again counts again, so this is not the context size.</p>
      {totalRows.length > 0 && <dl>{totalRows.map((row) => <div key={row.label}><dt>{row.label}{row.hint && <small>{row.hint}</small>}</dt><dd>{row.value}</dd></div>)}</dl>}
      {usage?.tokenAvailability === "partial" && <p className="thread-usage-note">Token reporting is partial; totals cover what was reported.</p>}
    </details>

    {attachmentsShown && visibleAttachments && <p className="thread-usage-meta thread-usage-attachments-line" title="Attachments in the loaded conversation. Older ones may have left the context after compaction.">
      <Files size={12} aria-hidden="true" />
      {[visibleAttachments.images && `${visibleAttachments.images} image${visibleAttachments.images === 1 ? "" : "s"}`, visibleAttachments.documents && `${visibleAttachments.documents} document${visibleAttachments.documents === 1 ? "" : "s"}`, visibleAttachments.files && `${visibleAttachments.files} other file${visibleAttachments.files === 1 ? "" : "s"}`].filter(Boolean).join(" · ")} attached
    </p>}

    {childCount > 0 && <p className="thread-usage-meta"><Bot size={12} aria-hidden="true" />Sub-agent usage is counted once per linked conversation.</p>}
  </div>;
}

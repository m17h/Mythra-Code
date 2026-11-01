import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Bot, ChevronRight, FileText, Files, Image, Info, Layers3, RefreshCw, Shrink } from "lucide-react";
import type { TokenUsageView } from "./StudioDock";
import type { Provider } from "../types";
import { threadUsageSummary, type ThreadUsageAmounts } from "../lib/threadUsage";
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

export function ThreadUsagePanel({ activeThread, threadId, turnId, provider, threadTitle, nativeLinks, managedLinks, context, visibleAttachments, onCompact, onRefresh }: ThreadUsagePanelProps) {
  // Keep global ledger notifications inside this mounted panel instead of
  // rerendering the app shell and rescanning its loaded messages on each write.
  const usageRevision = useSyncExternalStore(activeThread && threadId ? subscribeUsage : subscribeNoUsage, getUsageRevision);
  const summary = useMemo(() => activeThread && threadId
    ? threadUsageSummary({ threadId, nativeLinks, managedLinks })
    : null, [activeThread, threadId, nativeLinks, managedLinks, usageRevision]);
  // Missing live fields own availability: do not revive stale ledger fields.
  const current = context ? {
    totalTokens: context.contextTokens,
    inputTokens: context.contextInputTokens,
    outputTokens: context.contextOutputTokens,
    cachedInputTokens: context.contextCachedInputTokens,
    reasoningOutputTokens: context.contextReasoningOutputTokens,
    contextWindow: context.contextWindow,
  } : summary?.context;
  const canReadContext = activeThread && provider === "claude" && Boolean(threadId && turnId);
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
    <strong>Choose a conversation</strong>
    <p>Its API-equivalent cost and current context will appear here.</p>
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
  const canCompact = provider === "openai" || provider === "openrouter" || provider === "lmstudio";
  const contextRows = [
    { label: "Latest input", value: current?.inputTokens, icon: ArrowDownToLine },
    { label: "Latest output", value: current?.outputTokens, icon: ArrowUpFromLine },
    { label: "Image tokens", value: undefined, icon: Image },
    { label: "Document tokens", value: undefined, icon: FileText },
  ];
  const breakdown = report?.messageBreakdown;
  const messageRows: Array<{ label: string; value: number | null }> = breakdown ? [
    { label: "User messages", value: breakdown.userMessageTokens },
    { label: "Assistant messages", value: breakdown.assistantMessageTokens },
    { label: "Tool calls", value: breakdown.toolCallTokens },
    { label: "Tool results", value: breakdown.toolResultTokens },
    { label: "Attachments", value: breakdown.attachmentTokens },
    { label: "Redirected context", value: breakdown.redirectedContextTokens },
    { label: "Unattributed", value: breakdown.unattributedTokens },
  ] : [];

  return <div className="thread-usage">
    <div className="thread-usage-toolbar">
      <span className="thread-usage-scope" title={threadTitle || "Current conversation"}><span className="thread-usage-scope-dot" aria-hidden="true" /><span className="thread-usage-scope-title">{threadTitle || "Current conversation"}</span></span>
      <div className="thread-usage-actions">
        {onRefresh && <button type="button" onClick={onRefresh} aria-label="Refresh prices" title="Refresh prices"><RefreshCw size={13} aria-hidden="true" /></button>}
        <button type="button" onClick={onCompact} disabled={!canCompact} title={canCompact ? "Summarize older turns to free context" : "This provider manages its own context compaction"}><Shrink size={13} aria-hidden="true" />Compact</button>
      </div>
    </div>

    <section className="thread-usage-card thread-usage-cost" aria-label="API-equivalent cost">
      <div className="thread-usage-section-head">
        <h3>API-equivalent cost</h3>
        <span className={`thread-usage-badge${partial && hasEstimate ? " partial" : ""}`}>{hasEstimate ? partial ? "Partial estimate" : "Estimate" : "Unavailable"}</span>
      </div>
      <strong className={`thread-usage-cost-value${!hasEstimate ? " unavailable" : ""}`}>{cost(summary?.total)}</strong>
      <p className="thread-usage-note">Comparison at API rates for this conversation{childCount ? ` and ${childCount} child thread${childCount === 1 ? "" : "s"}` : ""}. Subscription payments are separate.</p>
      {summary && (childCount > 0 || summary.claudeNativeIncluded) && <div className="thread-usage-cost-scope">
        <AmountRow label="This thread" amounts={summary.own} />
        {childCount > 0 && <AmountRow label="Sub-agents" amounts={summary.subagents} />}
      </div>}
      {(unpriced > 0 || ownMissing || missingChildren > 0 || partialHistoryCount > 0 || outputPartial || summary?.claudeNativeIncluded) && <div className="thread-usage-coverage">
        <Info size={13} aria-hidden="true" />
        <div>
          {unpriced > 0 && <p>{tokens(unpriced)} recorded tokens have no price and are excluded from the estimate.</p>}
          {ownMissing && <p>This thread has no retained usage reading yet.</p>}
          {missingChildren > 0 && <p>{missingChildren} child thread{missingChildren === 1 ? " has" : "s have"} no retained usage reading. Their usage is unavailable.</p>}
          {partialHistoryCount > 0 && <p>Earlier usage was archived for {partialHistoryCount === 1 ? "one conversation" : `${partialHistoryCount} conversations`}. Amounts here cover retained requests only.</p>}
          {outputPartial && <p>Some output usage was not reported. Totals and the estimate cover known tokens.</p>}
          {summary?.claudeNativeIncluded && <p>Includes recorded native Claude worker requests; older or unreported work may be missing.</p>}
        </div>
      </div>}
    </section>

    <section className="thread-usage-card" aria-label="Cumulative thread tokens">
      <div className="thread-usage-section-head"><h3>Cumulative tokens</h3><span className="thread-usage-eyebrow">Recorded requests</span></div>
      <div className="thread-usage-token-total"><strong className={!usage ? "unavailable" : undefined}>{tokens(usage?.totalTokens)}</strong><span>{childCount ? "thread + children" : "this conversation"}</span></div>
      <div className="thread-usage-token-grid">
        <div><span><ArrowDownToLine size={12} aria-hidden="true" />Input</span><strong>{tokens(usage?.inputTokens)}</strong></div>
        <div><span><ArrowUpFromLine size={12} aria-hidden="true" />Output</span><strong>{outputReading(usage?.outputTokens, usage?.outputTokensReported)}</strong></div>
      </div>
      <p className="thread-usage-note">Across recorded requests. History sent again counts again; these totals do not measure current context.</p>
      {usage?.tokenAvailability === "partial" && <p className="thread-usage-note">Token reporting is partial; shown totals cover reported usage.</p>}
      <details className="thread-usage-details">
        <summary><ChevronRight size={13} aria-hidden="true" />Cache & reasoning detail</summary>
        <dl>
          <div><dt>Cache read <small>within input</small></dt><dd>{cacheReading(usage?.cachedInputTokens, usage?.cacheReadReported, usage?.cacheReadUnknownTokens)}</dd></div>
          <div><dt>Cache write <small>within input</small></dt><dd>{cacheReading(usage?.cacheWriteInputTokens, usage?.cacheWriteReported, usage?.cacheWriteUnknownTokens)}</dd></div>
          <div><dt>Reasoning <small>within output</small></dt><dd>{available(usage?.reasoningOutputTokens) && usage.reasoningOutputTokens > 0 ? outputReading(usage.reasoningOutputTokens, usage.outputTokensReported) : "Unavailable"}</dd></div>
        </dl>
      </details>
    </section>

    <section className={`thread-usage-card thread-usage-context${contextHigh ? " high" : ""}`} aria-label="Current thread context">
      <div className="thread-usage-section-head"><h3><Layers3 size={14} aria-hidden="true" />Current context</h3><span className="thread-usage-eyebrow">This thread only</span></div>
      <div className="thread-usage-context-reading">
        <div><strong className={!available(contextTotal) ? "unavailable" : undefined}>{report ? "≈ " : ""}{tokens(contextTotal)}</strong><span>{available(contextWindow) && contextWindow > 0 ? `of ${tokens(contextWindow)} tokens` : "Context window unavailable"}</span></div>
        {contextPercent !== null && <b>{Math.round(contextPercent)}<small>%</small></b>}
      </div>
      {contextPercent !== null ? <div className="thread-usage-context-track" role="progressbar" aria-label="Current context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(contextPercent)} aria-valuetext={`${Math.round(contextPercent)}% used`}><span style={{ width: `${contextPercent}%` }} /></div> : <div className="thread-usage-context-track unavailable" aria-hidden="true" />}
      {report && nativeContext ? <>
        <div className="thread-usage-context-freshness"><span className={`thread-usage-badge${previousSample || nativeContext.status === "cached" ? " partial" : ""}`}>{previousSample ? "Previous sample" : nativeContext.status === "cached" ? "Cached" : "Snapshot"} · approximate</span><span title={nativeContext.sampledAt ? new Date(nativeContext.sampledAt).toLocaleString() : undefined}>{sampledAge(nativeContext.sampledAt)}</span></div>
        {previousSample && <p className="thread-usage-note">Refreshing this turn’s context snapshot.</p>}
        {nativeContext.status === "cached" && nativeContext.reason && <p className="thread-usage-note">{nativeContext.reason}</p>}
        <p className="thread-usage-note">Claude’s context summary for this turn. Child agents have separate windows.</p>
        <dl className="thread-usage-provider-categories">{report.categories.map((category, index) => <div key={`${category.id ?? category.name}-${index}`}><dt>{category.name}{category.kind && category.kind !== "used" && <small>{category.kind === "free" ? "free capacity" : category.kind === "buffer" ? "reserved buffer" : "deferred"}</small>}</dt><dd className={!available(category.tokens) ? "unavailable" : undefined}>{available(category.tokens) ? `≈ ${tokens(category.tokens)}` : "Unavailable"}</dd></div>)}</dl>
        {report.messageBreakdown && <>
          {report.messageBreakdown.attachmentsByType && report.messageBreakdown.attachmentsByType.length > 0 && <div className="thread-usage-native-attachments"><h4>Attachment tokens by type</h4><dl>{report.messageBreakdown.attachmentsByType.map((attachment, index) => <div key={`${attachment.name}-${index}`}><dt>{attachment.name}</dt><dd>{available(attachment.tokens) ? `≈ ${tokens(attachment.tokens)}` : "Unavailable"}</dd></div>)}</dl></div>}
          <details className="thread-usage-details"><summary><ChevronRight size={13} aria-hidden="true" />Messages & tools</summary><dl>{messageRows.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{available(value) ? `≈ ${tokens(value)}` : "Unavailable"}</dd></div>)}</dl></details>
        </>}
        <p className="thread-usage-note thread-usage-breakdown-note">Categories, message details and attachment types can overlap. These rows are not additive.</p>
      </> : <>
      <p className="thread-usage-note">Latest runtime reading. Context can shrink after compaction; child threads have their own windows.</p>
      {nativeContext?.reason && <p className="thread-usage-note thread-usage-breakdown-note">{nativeContext.reason}</p>}
      <dl className="thread-usage-context-grid">{contextRows.map(({ label, value, icon: Icon }) => <div key={label}><dt><Icon size={13} aria-hidden="true" />{label}</dt><dd className={!available(value) ? "unavailable" : undefined}>{tokens(value)}</dd></div>)}</dl>
      <p className="thread-usage-note">Latest input and output are request counts, not a complete context breakdown. Image and document token splits are not reported.</p>
      {(available(current?.cachedInputTokens) || available(current?.reasoningOutputTokens)) && <details className="thread-usage-details">
        <summary><ChevronRight size={13} aria-hidden="true" />Latest request detail</summary>
        <dl>
          <div><dt>Cache read <small>within input</small></dt><dd>{tokens(current?.cachedInputTokens)}</dd></div>
          <div><dt>Reasoning <small>within output</small></dt><dd>{tokens(current?.reasoningOutputTokens)}</dd></div>
        </dl>
      </details>}
      </>}
      {contextHigh && <p className="thread-usage-context-warning">This context reading is nearly full. {canCompact ? "Compact older turns to make room." : "This provider manages its own context compaction."}</p>}
    </section>

    {visibleAttachments && <section className="thread-usage-attachments" aria-label="Attachments in loaded conversation">
      <h3>Loaded conversation attachments</h3>
      <div><span><Image size={13} aria-hidden="true" /><strong>{tokens(visibleAttachments.images)}</strong> images</span><span><FileText size={13} aria-hidden="true" /><strong>{tokens(visibleAttachments.documents)}</strong> documents</span><span><Files size={13} aria-hidden="true" /><strong>{tokens(visibleAttachments.files)}</strong> other files</span></div>
      <p className="thread-usage-note">Attachment counts, not tokens. Older attachments may have left active context after compaction.</p>
    </section>}

    {childCount > 0 && <div className="thread-usage-footnote"><Bot size={13} aria-hidden="true" /><span>Child usage is counted once per linked conversation. Unreported usage remains unavailable.</span></div>}
  </div>;
}

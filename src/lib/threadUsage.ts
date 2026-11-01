import type { TokenUsageView } from "../components/StudioDock";
import type { NativeAgentLink, OwnershipLinks } from "./nativeAgentLinks";
import { mergedUsageEvidence } from "./usageEvidence";
import { usageAmountsForThread, usageForThreads, type ThreadUsageRecord } from "./usageLedger";

/** Tracked billing usage. These values are lifetime counters for the selected
 * conversations, never the composition of their current context. */
export interface ThreadUsageAmounts {
  usage: TokenUsageView | null;
  estimatedCost: number | null;
  pricedTokens: number;
  unpricedTokens: number;
}

export interface ThreadContextUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  contextWindow?: number | null;
}

export interface ThreadUsageDescendant {
  threadId: string;
  amounts: ThreadUsageAmounts;
}

export interface ThreadUsageSummary {
  threadId: string;
  own: ThreadUsageAmounts;
  subagents: ThreadUsageAmounts;
  total: ThreadUsageAmounts;
  /** Only the selected thread's latest request. Context windows across agents
   * cannot be added into a single context occupancy. */
  context: ThreadContextUsage;
  descendants: ThreadUsageDescendant[];
  /** Missing can mean unreported or no longer retained; zero is not implied. */
  missingThreadIds: string[];
  /** These conversations resumed after their older amounts were folded into
   * the global archive. Retained requests are only a suffix of their lifetime
   * usage, even when every retained token has a known price. */
  historyPartialThreadIds: string[];
  /** Native Claude workers exist in this scope. Their explicit child assistant
   * reports are included; absent reports remain partial, never inferred from
   * session-wide modelUsage or total_cost_usd. */
  claudeNativeIncluded: boolean;
}

function emptyAmounts(): ThreadUsageAmounts {
  return { usage: null, estimatedCost: null, pricedTokens: 0, unpricedTokens: 0 };
}

function billingUsage(usage: TokenUsageView): TokenUsageView {
  // Explicitly discard context fields: summing them across independent models
  // or conversations would imply one context that never existed.
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    outputTokensReported: usage.outputTokensReported,
    ...mergedUsageEvidence({ inputTokens: 0 }, usage),
  };
}

function recordAmounts(record: ThreadUsageRecord | null): ThreadUsageAmounts {
  if (!record || record.kind) return emptyAmounts();
  // Thread metadata is annotated before any provider request completes. That
  // creates a ledger row, but does not establish a provider-reported zero.
  // An archived cumulative baseline prevents replaying old tokens; it is not
  // a retained usage reading or evidence that this conversation cost zero.
  if (!record.usage.totalTokens && !record.eventIds?.length
    && (!record.cumulativeSnapshot || record.countedInArchive)) return emptyAmounts();
  const amounts = usageAmountsForThread(record);
  const reportedZero = amounts.totalTokens === 0
    && record.usage.tokenAvailability !== "partial" && record.usage.tokenAvailability !== "unavailable";
  return {
    usage: billingUsage(record.usage),
    // Ledger zero can mean no priced requests, rather than a free request.
    estimatedCost: amounts.pricedTokens > 0 || reportedZero ? amounts.estimatedCost : null,
    pricedTokens: amounts.pricedTokens,
    unpricedTokens: amounts.unpricedTokens,
  };
}

function combineAmounts(rows: ThreadUsageAmounts[]): ThreadUsageAmounts {
  const result = emptyAmounts();
  for (const row of rows) {
    if (row.estimatedCost !== null) result.estimatedCost = (result.estimatedCost ?? 0) + row.estimatedCost;
    result.pricedTokens += row.pricedTokens;
    result.unpricedTokens += row.unpricedTokens;
    const usage = row.usage;
    if (!usage) continue;
    const previous = result.usage;
    result.usage = previous ? {
      totalTokens: previous.totalTokens + usage.totalTokens,
      inputTokens: previous.inputTokens + usage.inputTokens,
      cachedInputTokens: previous.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteInputTokens: (previous.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
      cacheWrite1hInputTokens: (previous.cacheWrite1hInputTokens ?? 0) + (usage.cacheWrite1hInputTokens ?? 0),
      outputTokens: previous.outputTokens + usage.outputTokens,
      reasoningOutputTokens: previous.reasoningOutputTokens + usage.reasoningOutputTokens,
      outputTokensReported: previous.outputTokensReported === false || usage.outputTokensReported === false
        ? false : usage.outputTokensReported ?? previous.outputTokensReported,
      ...mergedUsageEvidence(previous, usage),
    } : billingUsage(usage);
  }
  // Metadata-only empty records must not convert an entirely unpriced sum
  // into a displayed $0 estimate.
  if (result.usage?.totalTokens && result.pricedTokens === 0) result.estimatedCost = null;
  return result;
}

function descendantIds(graph: OwnershipLinks, threadId: string): string[] {
  const children = new Map<string, string[]>();
  for (const [id, link] of Object.entries(graph)) {
    const siblings = children.get(link.rootThreadId) ?? [];
    siblings.push(id);
    children.set(link.rootThreadId, siblings);
  }
  const queue = [threadId];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    for (const id of children.get(queue[index]) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(id);
    }
  }
  return queue.slice(1);
}

/** Read-side scope over accepted ownership only. Global usage, helper receipts
 * and unattributed OpenRouter charge receipts cannot identify this thread. */
export function threadUsageSummary(input: {
  threadId: string;
  nativeLinks: Record<string, NativeAgentLink>;
  managedLinks?: OwnershipLinks;
}): ThreadUsageSummary {
  const { threadId, nativeLinks } = input;
  const graph: OwnershipLinks = { ...nativeLinks, ...input.managedLinks };
  const allDescendants = descendantIds(graph, threadId);
  const records = new Map(usageForThreads([threadId, ...allDescendants], true).map((record) => [record.threadId, record]));
  // Parent metadata retains scope when an early provisional Claude worker is
  // later reidentified or no longer has a visible activity row.
  const billableIds = [...new Set([...allDescendants, ...[...records.values()]
    .filter((record) => record.nativeParentThreadId && record.threadId !== threadId)
    .map((record) => record.threadId)])];
  const ownRecord = records.get(threadId) ?? null;
  const own = recordAmounts(ownRecord);
  const descendants = billableIds.map((id) => ({ threadId: id, amounts: recordAmounts(records.get(id) ?? null) }));
  const subagents = combineAmounts(descendants.map((entry) => entry.amounts));
  const ownUsage = ownRecord?.usage;
  return {
    threadId,
    own,
    subagents,
    total: combineAmounts([own, subagents]),
    context: {
      totalTokens: ownUsage?.contextTokens,
      inputTokens: ownUsage?.contextInputTokens,
      outputTokens: ownUsage?.contextOutputTokens,
      cachedInputTokens: ownUsage?.contextCachedInputTokens,
      reasoningOutputTokens: ownUsage?.contextReasoningOutputTokens,
      contextWindow: ownUsage?.contextWindow,
    },
    descendants,
    missingThreadIds: [
      ...(!own.usage ? [threadId] : []),
      ...descendants.filter((entry) => !entry.amounts.usage).map((entry) => entry.threadId),
    ],
    historyPartialThreadIds: [...records.values()]
      .filter((record) => record.countedInArchive)
      .map((record) => record.threadId),
    claudeNativeIncluded: allDescendants.some((id) => nativeLinks[id]?.runtime === "claude")
      || [...records.values()].some((record) => Boolean(record.nativeParentThreadId)),
  };
}

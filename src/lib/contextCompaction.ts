import type { Activity } from "../types";

/**
 * Provider-native context compaction. Codex and Claude Code each summarise
 * their own conversation history when it outgrows the model window; Mythra
 * Code neither drives nor undoes that, it only shows where it happened.
 *
 * The marker is an ordinary Activity so it inherits timeline ordering, local
 * transcript persistence, and Codex history rebuilds unchanged. The visible
 * transcript is never edited — the seam is additive.
 */
export type CompactionProvider = "openai" | "claude";
export type CompactionTrigger = "auto" | "manual";
/** Lifecycle as the provider reports it, before it is mapped to a state. */
export type CompactionStatus = "inProgress" | "completed" | "failed";
/** What the timeline actually renders. */
export type CompactionState = "active" | "complete" | "incomplete";

const PROVIDER_LABEL: Record<CompactionProvider, string> = {
  openai: "Codex",
  claude: "Claude Code",
};

/**
 * A turn that ends without its compaction ever completing is settled by the
 * task store to the turn's terminal status, so "interrupted" and "error" are
 * both reachable here and must not read as a finished compaction.
 */
export function compactionState(status: string | undefined): CompactionState {
  if (status === "inProgress" || status === "started") return "active";
  if (status === "failed" || status === "error" || status === "interrupted" || status === "cancelled") return "incomplete";
  return "complete";
}

export function compactionTitle(status: string | undefined): string {
  const state = compactionState(status);
  if (state === "active") return "Compacting context";
  return state === "incomplete" ? "Context compaction did not finish" : "Context compacted";
}

function tokensLabel(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  const rounded = tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : tokens >= 10_000
      ? `${Math.round(tokens / 1_000)}K`
      : tokens >= 1_000
        ? `${(tokens / 1_000).toFixed(1)}K`
        : `${Math.round(tokens)}`;
  return `${rounded} tokens before`;
}

export interface CompactionActivityInput {
  id: string;
  provider: CompactionProvider;
  status: CompactionStatus;
  trigger?: CompactionTrigger;
  /** Context size the provider reported immediately before compacting. */
  tokensBefore?: number;
}

/**
 * The rendered subtitle is stored on the activity so a transcript reloaded
 * from disk (or rebuilt from Codex turns) shows the same marker without
 * re-deriving anything from provider payloads that are long gone. The heading
 * is recomputed from `status` at render time instead, because a turn that
 * crashes mid-compaction has its status settled after this is written.
 */
export function compactionActivity({ id, provider, status, trigger, tokensBefore }: CompactionActivityInput): Activity {
  const detail = [
    PROVIDER_LABEL[provider],
    trigger === "manual" ? "Manual" : trigger === "auto" ? "Automatic" : "",
    compactionState(status) === "complete" ? tokensLabel(tokensBefore) : "",
  ].filter(Boolean).join(" · ");
  return { id, kind: "compaction", title: compactionTitle(status), detail, status };
}

/**
 * Codex reports the item twice — `item/started` then `item/completed`. Trust
 * the envelope over the item body so a completion whose payload still carries
 * a stale `inProgress` cannot leave the indicator animating forever.
 */
export function codexCompactionStatus(
  itemStatus: string | undefined,
  lifecycle: "started" | "completed",
): CompactionStatus {
  if (itemStatus === "failed" || itemStatus === "error") return "failed";
  if (lifecycle === "completed" || itemStatus === "completed") return "completed";
  return "inProgress";
}

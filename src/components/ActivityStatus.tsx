import { memo, useEffect, useState } from "react";
import { Check, ChevronRight, CircleDashed, CircleStop, FilePenLine, FoldVertical, ListChecks, Pencil, Search, ShieldAlert, Sparkles, TerminalSquare, TriangleAlert, UsersRound, type LucideIcon } from "lucide-react";
import { latestCompactActivity, type CompactWorkEntry, type CompactWorkState } from "../lib/compactActivity";
import "./ActivityStatus.css";

export type ActivityStatusCategory =
  | "research" | "files" | "commands" | "thinking" | "writing" | "agents" | "compaction" | "approval" | "working";

export interface LiveActivityDescriptor {
  category: ActivityStatusCategory;
  label: string;
  /** Only generic waiting may borrow an occasional light-hearted phrase. */
  playful: boolean;
}

/**
 * The single live line for an active run. Concrete operations always win;
 * a trusted final channel reads as "Writing response" without exposing its
 * text in chat. Nothing here guesses from arbitrary titles or prose.
 */
export function describeLiveActivity(
  entries: readonly CompactWorkEntry[],
  options: { awaiting?: "approval" | "input" | null; activeTurnId?: string } = {},
): LiveActivityDescriptor {
  // Blocked runs never borrow progress language or playful phrases.
  if (options.awaiting === "approval") return { category: "approval", label: "Waiting for approval", playful: false };
  if (options.awaiting === "input") return { category: "approval", label: "Waiting for your answer", playful: false };
  const latest = latestCompactActivity(entries, { activeTurnId: options.activeTurnId });
  const activity = latest.activity;
  if (activity) {
    if (activity.kind === "compaction") return { category: "compaction", label: "Compacting context", playful: false };
    if (activity.kind === "agent" && !activity.workType) return { category: "agents", label: "Coordinating agents", playful: false };
    if (activity.kind === "reasoning") return { category: "thinking", label: "Thinking", playful: true };
    return { category: latest.category, label: latest.label, playful: false };
  }
  const last = entries.at(-1);
  if (last?.kind === "message" && last.value.role === "assistant" && last.value.streaming) {
    return last.value.phase === "final"
      ? { category: "writing", label: "Writing response", playful: false }
      : { category: "working", label: "Working", playful: false };
  }
  const started = entries.some((entry) => entry.kind !== "message" || entry.value.role === "assistant");
  return started
    ? { category: "working", label: "Working", playful: true }
    : { category: "thinking", label: "Thinking", playful: true };
}

/** Gentle thinking phrases, never shown instead of a concrete operation. */
export const ACTIVITY_STATUS_PHRASES = [
  "Greasing the gears",
  "Connecting the dots",
  "Untangling the threads",
  "Sharpening the pencils",
  "Mulling it over",
  "Polishing the plan",
] as const;

/** Generic waiting must last this long before a phrase may appear. */
export const ACTIVITY_PHRASE_DELAY_MS = 3_000;
export const ACTIVITY_PHRASE_INTERVAL_MS = 5_000;

function phraseIndex(seed: string, turn: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  return (Math.abs(hash) + turn) % ACTIVITY_STATUS_PHRASES.length;
}

/**
 * One timer for the one live status line. It restarts whenever the real
 * label changes. Show the normal status for three seconds, then rotate
 * directly between phrases every five seconds until real activity changes.
 */
function usePlayfulLabel(label: string, enabled: boolean, seed: string): string {
  const [phrase, setPhrase] = useState<string | null>(null);
  useEffect(() => {
    setPhrase(null);
    if (!enabled) return;
    let turn = 0;
    let timer = 0;
    const show = () => {
      setPhrase(ACTIVITY_STATUS_PHRASES[phraseIndex(seed, turn)]);
      turn += 1;
      timer = window.setTimeout(show, ACTIVITY_PHRASE_INTERVAL_MS);
    };
    timer = window.setTimeout(show, ACTIVITY_PHRASE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [label, enabled, seed]);
  return enabled && phrase ? phrase : label;
}

const CATEGORY_ICONS: Record<ActivityStatusCategory, LucideIcon> = {
  research: Search,
  files: FilePenLine,
  commands: TerminalSquare,
  thinking: Sparkles,
  writing: Pencil,
  agents: UsersRound,
  compaction: FoldVertical,
  approval: ShieldAlert,
  working: Sparkles,
};

const SETTLED_ICONS: Record<Exclude<CompactWorkState, "running">, LucideIcon> = {
  completed: Check,
  failed: TriangleAlert,
  interrupted: CircleStop,
  unknown: ListChecks,
};

export const SETTLED_ACTIVITY_LABELS: Record<Exclude<CompactWorkState, "running">, string> = {
  completed: "Work completed",
  failed: "Run failed",
  interrupted: "Run stopped",
  unknown: "Activity",
};

/**
 * The provider went idle without confirming the turn ended. Truthful either
 * way: no running animation, and no claim that the work completed.
 */
export const UNCONFIRMED_ACTIVITY_LABEL = "Completion unconfirmed";

export interface ActivityStatusProps {
  state: CompactWorkState;
  /** Live: the semantic operation. Settled: optional override of the outcome label. */
  label?: string;
  category?: ActivityStatusCategory;
  /** Quiet trailing context: step count while live, the work summary once settled. */
  summary?: string;
  playful?: boolean;
  /** Settled `unknown` run whose current turn has no terminal event yet. */
  unconfirmed?: boolean;
  /** Stable per run so the occasional phrase never jumps between rows. */
  seed?: string;
  searchMatches?: number;
  /** Identifies the logical run so focus can return after a row remounts. */
  runKey?: string;
  open?: boolean;
  onOpen: (opener: HTMLButtonElement) => void;
}

/**
 * A single, small, deliberately quiet line. Live runs get one animated mark;
 * settled rows are static so long histories never animate or tick.
 */
export const ActivityStatus = memo(function ActivityStatus({
  state, label, category = "working", summary, playful = false, unconfirmed = false, seed = "", searchMatches = 0, runKey, open = false, onOpen,
}: ActivityStatusProps) {
  const live = state === "running";
  const waiting = live && category === "approval";
  const pending = !live && unconfirmed;
  const semanticLabel = live ? label || "Working" : label || (pending ? UNCONFIRMED_ACTIVITY_LABEL : SETTLED_ACTIVITY_LABELS[state]);
  const shownLabel = usePlayfulLabel(semanticLabel, live && playful && !waiting, seed);
  const Icon = live ? CATEGORY_ICONS[category] : pending ? CircleDashed : SETTLED_ICONS[state];
  const matchText = searchMatches > 0 ? `${searchMatches} match${searchMatches === 1 ? "" : "es"}` : "";
  const accessibleSummary = [summary, matchText].filter(Boolean).join(", ");
  return (
    <div
      className={`activity-status state-${state}${live ? " live" : " settled"}${waiting ? " waiting" : ""}${pending ? " unconfirmed" : ""}${searchMatches ? " search-hit" : ""}`}
      data-category={live ? category : undefined}
    >
      {/* Announce real operations only; decorative phrases stay visual. */}
      {live && <span className="sr-only" role="status">{semanticLabel}</span>}
      <button
        type="button"
        className="activity-status-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${semanticLabel}. View activity${accessibleSummary ? `: ${accessibleSummary}` : ""}`}
        data-activity-run={runKey}
        onClick={(event) => {
          // WebKit does not focus buttons on pointer activation; the dialog
          // needs a consistent return target for pointer and keyboard users.
          event.currentTarget.focus({ preventScroll: true });
          onOpen(event.currentTarget);
        }}
      >
        <span className="activity-status-mark" aria-hidden="true">
          <Icon size={11} strokeWidth={2.2} />
          {live && !waiting && <i className="activity-status-orbit" />}
        </span>
        <span className="activity-status-text" aria-hidden="true">
          <span className={`activity-status-label${shownLabel !== semanticLabel ? " playful" : ""}`} key={shownLabel}>{shownLabel}</span>
          {live && !waiting && <span className="activity-status-ellipsis">…</span>}
        </span>
        {(summary || matchText) && (
          <span className="activity-status-meta" aria-hidden="true">
            {summary}
            {matchText && <b>{matchText}</b>}
          </span>
        )}
        <ChevronRight className="activity-status-chevron" size={12} aria-hidden="true" />
      </button>
    </div>
  );
});

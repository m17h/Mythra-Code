import { createContext } from "react";
import { CirclePause, LoaderCircle } from "lucide-react";
import type { ParentRunView } from "../lib/parentRun";
import type { CompactWorkState } from "../lib/compactActivity";
import "./ParentRunLine.css";

/** Lives here, not in the lazily loaded timeline, so the shell can provide it. */
export const ParentRunTurnLabel = createContext<{ turnId: string; label: string; state: CompactWorkState } | null>(null);

const USAGE_NOTE = "Normal model usage applies.";

/**
 * One quiet line above the composer while a parent run depends on its
 * sub-agents. The composer's Stop button still ends everything; this line only
 * decides whether the parent continues by itself, so while it can, the line
 * says so. A paused run has stopped doing that and makes no such promise.
 */
export function ParentRunLine({ view, continueLabel, onContinue, onDismiss }: {
  view: ParentRunView;
  continueLabel: string;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const paused = view.kind === "paused";
  return (
    <div className={`parent-run-line ${view.kind}`}>
      {paused || view.attention ? <CirclePause size={12} aria-hidden="true" /> : <LoaderCircle className="spin" size={12} aria-hidden="true" />}
      <div className="parent-run-line-copy" role="status" title={[view.title, view.detail, !paused && USAGE_NOTE].filter(Boolean).join(" ")}>
        <span>{view.title}</span>
        {view.detail && <small>{view.detail}{!paused && <span className="parent-run-line-usage"> {USAGE_NOTE}</span>}</small>}
      </div>
      <div className="parent-run-line-actions">
        {paused && <button type="button" className="primary" disabled={view.continueBlocked} onClick={onContinue}
          title={view.continueBlocked ? "Wait for the unconfirmed start to settle before continuing" : `${continueLabel} using the current account`}>{continueLabel}</button>}
        {/* An unacknowledged start may still run; keep its ownership visible. */}
        {!view.continueBlocked && <button
          type="button"
          onClick={onDismiss}
          title={paused ? "The parent won't continue automatically. Sub-agents keep running and stay in the crew panel."
            : "Sub-agents keep running and stay in the crew panel. The parent won't continue by itself. Stop ends their work."}
        >
          {paused ? "Dismiss" : "Don't auto-continue"}
        </button>}
      </div>
    </div>
  );
}

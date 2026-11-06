import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { Activity } from "../types";
import { providerDisplayName } from "../lib/childAgents";
import { TimelineSubAgentControls, useTimelineEnvironment } from "./TimelineEnvironment";
import { coordinationView, type CoordinationRecord, type CoordinationView } from "../lib/managedAgentActivity";

import "./CoordinationRoute.css";

/** Live view of one coordination row: the crew's identity for its child and
 * that child's mailbox, so delivery and read states follow the real message. */
function useCoordinationView(activity: Activity, record: CoordinationRecord): CoordinationView {
  const controls = useContext(TimelineSubAgentControls);
  const source = useTimelineEnvironment().mailbox;
  const workers = controls?.historyWorkers ?? controls?.workers;
  const worker = record.childId ? workers?.find((entry) => entry.id === record.childId) : undefined;
  // Raw bridge receipts cannot prove a mailbox message's identity. A row
  // with no proven app message needs no subscription at all.
  const childId = record.source === "app" && record.messageId ? record.childId : undefined;
  const subscribe = useCallback((listener: () => void) => childId && source
    ? source.subscribe(childId, listener) : () => {}, [childId, source]);
  const snapshot = useCallback(() => childId ? source?.get(childId) : undefined, [childId, source]);
  const mailbox = useSyncExternalStore(subscribe, snapshot);
  const title = worker?.title;
  const detail = worker?.identityRecorded ? worker.detail : worker?.provider
    ? `${providerDisplayName(worker.provider)} · model unknown` : worker ? "Provider/model unknown" : undefined;
  return useMemo(() => coordinationView(activity, record, title !== undefined && detail !== undefined ? { title, detail } : undefined, mailbox),
    [activity, detail, mailbox, record, title]);
}

const CoordinationContext = createContext<CoordinationView | undefined>(undefined);

/** Share one live identity/mailbox read between the route and the state chip. */
export function CoordinationPresentation({ activity, record, children }: {
  activity: Activity;
  record: CoordinationRecord;
  children: ReactNode;
}) {
  const view = useCoordinationView(activity, record);
  return <CoordinationContext.Provider value={view}>{children}</CoordinationContext.Provider>;
}

/** Status word for a coordination row; `fallback` when nothing more specific is known. */
export function CoordinationState({ fallback, render }: {
  fallback: ReactNode;
  render: (state: NonNullable<CoordinationView["state"]>) => ReactNode;
}) {
  const view = useContext(CoordinationContext);
  return <>{view?.state ? render(view.state) : fallback}</>;
}

/** Who is talking to whom, e.g. `Parent → Claude · claude-fable-5`. */
export function CoordinationRoute() {
  const view = useContext(CoordinationContext);
  if (!view || (!view.from && !view.note)) return null;
  return (
    <div className={`coordination-route direction-${view.direction}`}>
      {view.from && <span className="coordination-party" title={view.from}>{view.from}</span>}
      {view.from && view.to && <>
        <ArrowRight className="coordination-arrow" size={11} aria-hidden="true" />
        <span className="sr-only">{" to "}</span>
        <span className="coordination-party" title={view.to}>{view.to}</span>
      </>}
      {view.note && <span className="coordination-note">{view.note}</span>}
    </div>
  );
}

/** Preserve the full bridge answer without turning message text into JSON. */
export function CoordinationReceipt({ detail, reveal = false, subject }: { detail: string; reveal?: boolean; subject?: string }) {
  const [expanded, setExpanded] = useState(reveal);
  useEffect(() => { if (reveal) setExpanded(true); }, [reveal]);
  return <div className="coordination-receipt">
    <button type="button" className="coordination-receipt-toggle" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>
      <ChevronRight size={12} aria-hidden="true" />
      {expanded ? "Hide" : "Show"} result details{subject ? `: ${subject}` : ""}
    </button>
    {expanded && <pre className="coordination-receipt-output" tabIndex={0} aria-label={subject ? `Result details: ${subject}` : "Result details"}>{detail}</pre>}
  </div>;
}

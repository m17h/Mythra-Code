import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CalendarClock, ChevronDown, Clock, ListPlus, LoaderCircle, MessageSquarePlus, Pencil, RotateCw, Send, Trash2 } from "lucide-react";
import type { QueuedTurn } from "../lib/taskStore";
import { formatDeliveryTime, formatDeliveryTimeLong, nextTimedStateChangeDelay, timedPromptState } from "../lib/timedPrompts";
import { TimedPromptPicker } from "./TimedPromptPicker";
import "./TimedPrompts.css";

export interface TimedPromptActions {
  onBeginEdit?: (id: string) => boolean;
  onFinishEdit?: (id: string, text?: string) => boolean;
  onReschedule: (id: string, deliverAt: number) => boolean;
  /** Missed or failed entries only: the user's explicit go-ahead. */
  onRelease: (id: string) => boolean;
  onRemove: (id: string) => void;
}

export type ScheduledPromptScope = "thread" | "new-thread";

const SCOPE_COPY: Record<ScheduledPromptScope, { heading: string; list: string; item: string; release: string }> = {
  thread: { heading: "Scheduled · this thread", list: "Scheduled for this thread", item: "scheduled prompt", release: "Queue now" },
  "new-thread": { heading: "Scheduled · new conversations", list: "Scheduled new conversations", item: "new conversation", release: "Start now" },
};

function attachmentNote(entry: QueuedTurn): string {
  return entry.attachments.length ? ` · ${entry.attachments.length} attachment${entry.attachments.length === 1 ? "" : "s"}` : "";
}

/**
 * Timed prompts that have not joined a queue yet, soonest first. They are
 * deliberately separate from "Next turns": nothing here runs after the
 * current task, and nothing here holds back the prompts listed there.
 *
 * Two scopes can appear together. Prompts for this thread join its queue when
 * due; scheduled new conversations each start their own thread, and stay
 * reachable from every conversation in their workspace so a normal first send
 * never hides them.
 */
export function ScheduledPrompts({
  entries,
  scope,
  actions,
  renderEditor,
  entryDetail,
}: {
  entries: QueuedTurn[];
  scope: ScheduledPromptScope;
  actions: TimedPromptActions;
  renderEditor?: (entry: QueuedTurn, index: number, onFinish: (id: string, text?: string) => boolean, label: string) => ReactNode;
  /** Extra identity for a row, such as the provider a new conversation will use. */
  entryDetail?: (entry: QueuedTurn) => string | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const [expandedChoice, setExpandedChoice] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const copy = SCOPE_COPY[scope];

  // Repaint rows and the folded summary when a prompt reaches delivery time.
  useEffect(() => {
    const delay = nextTimedStateChangeDelay(entries, now);
    if (delay === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [entries, now]);

  useEffect(() => {
    if (rescheduling && !entries.some((entry) => entry.id === rescheduling)) setRescheduling(null);
  }, [entries, rescheduling]);

  if (!entries.length) return null;
  // Keep active edits and their reschedule anchors in view. Decision rows can
  // fold, but their status remains visible before the user opens the list.
  const editing = entries.some((entry) => entry.editing);
  const busy = editing || rescheduling !== null;
  const expanded = busy || expandedChoice;
  const missed = entries.filter((entry) => entry.status === "queued" && entry.missedAt !== undefined).length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const starting = entries.filter((entry) => entry.status === "sending").length;
  const due = entries.filter((entry) => entry.status === "queued" && timedPromptState(entry, now) === "due").length;
  const summary = [
    `${entries.length} prompt${entries.length === 1 ? "" : "s"}`,
    missed ? `${missed} missed` : "",
    failed ? `${failed} failed` : "",
    starting ? `${starting} starting` : "",
    due ? `${due} due` : "",
  ].filter(Boolean).join(" · ");
  const headingContent = (
    <>
      <span>{scope === "new-thread" ? <MessageSquarePlus size={12} aria-hidden="true" /> : <CalendarClock size={12} aria-hidden="true" />} {copy.heading}</span>
      <small className={missed || failed ? "scheduled-prompts-attention" : undefined} aria-live="polite">{summary}</small>
    </>
  );
  return (
    <div className="queued-turns scheduled-prompts" data-scope={scope} data-collapsed={!expanded || undefined}>
      <button
        type="button"
        className="queued-turns-heading scheduled-prompts-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        disabled={busy}
        title={editing ? "Finish editing before collapsing" : rescheduling ? "Close the delivery picker before collapsing" : scope === "new-thread" ? "Each starts its own thread. Times are local; Mythra Code must be open." : "Times are local; Mythra Code must be open."}
        onClick={() => setExpandedChoice(!expanded)}
      >
        {headingContent}
        <ChevronDown size={12} aria-hidden="true" className="scheduled-prompts-chevron" />
      </button>
      <div className="queued-turns-list" id={listId} role="list" aria-label={copy.list} hidden={!expanded}>
          {entries.map((entry, index) => {
            const label = `${copy.item} ${index + 1}`;
            if (entry.editing && actions.onFinishEdit && renderEditor) return (
              <div className="queued-turn scheduled-prompt editing" key={entry.id} role="listitem">
                <span className="scheduled-prompt-badge" aria-hidden="true"><Clock size={11} /></span>
                {renderEditor(entry, index, actions.onFinishEdit, copy.item)}
              </div>
            );
            const state = entry.status === "failed" ? "failed" : timedPromptState(entry, now);
            const when = formatDeliveryTime(entry.deliverAt!, now);
            const identity = entryDetail?.(entry);
            const detail = entry.status === "sending"
              ? "Starting now…"
              : state === "failed"
                ? entry.error || "Could not start"
                : state === "missed"
                  ? `Missed ${when} — not sent automatically. ${copy.release}, reschedule, or remove it.`
                  : state === "due"
                    ? `Due ${when} — checking`
                    : `${when}${attachmentNote(entry)}${identity ? ` · ${identity}` : ""}`;
            return (
              <div className={`queued-turn scheduled-prompt ${entry.status} is-${state}`} key={entry.id} role="listitem">
                <span className="scheduled-prompt-badge" aria-hidden="true"><Clock size={11} /></span>
                <span className="queued-turn-copy" title={`${entry.text}\n\n${formatDeliveryTimeLong(entry.deliverAt!)}`}>
                  <strong>{entry.text}</strong>
                  <small>{detail}</small>
                </span>
                {entry.status === "sending" ? (
                  <LoaderCircle className="spin" size={13} aria-label={`Starting ${label}`} />
                ) : (
                  <span className="queued-turn-actions">
                    {actions.onBeginEdit && actions.onFinishEdit && (
                      <button type="button" onClick={() => actions.onBeginEdit?.(entry.id)} title={`Edit ${copy.item}`} aria-label={`Edit ${label}`}><Pencil size={12} /></button>
                    )}
                    <button
                      type="button"
                      onClick={(event) => {
                        anchorRef.current = event.currentTarget;
                        setRescheduling((current) => current === entry.id ? null : entry.id);
                      }}
                      aria-expanded={rescheduling === entry.id}
                      aria-haspopup="dialog"
                      title="Change delivery time"
                      aria-label={`Reschedule ${label}`}
                    ><CalendarClock size={12} /></button>
                    {(state === "missed" || state === "failed") && (
                      <button type="button" className="release-scheduled" onClick={() => actions.onRelease(entry.id)} title={scope === "new-thread" ? "Start this new conversation now" : "Add to this thread's queue now"} aria-label={`${copy.release} ${label}`}>
                        {state === "failed" ? <RotateCw size={12} /> : scope === "new-thread" ? <Send size={12} /> : <ListPlus size={12} />}
                      </button>
                    )}
                    <button type="button" className="remove-queued" onClick={() => actions.onRemove(entry.id)} title={`Remove ${copy.item}`} aria-label={`Remove ${label}`}><Trash2 size={12} /></button>
                  </span>
                )}
                {rescheduling === entry.id && (
                  <TimedPromptPicker
                    anchorRef={anchorRef}
                    title={scope === "new-thread" ? "Reschedule new conversation" : "Reschedule prompt"}
                    submitLabel="Reschedule"
                    initialDeliverAt={entry.deliverAt}
                    contextLabel={scope === "new-thread" ? "Starts its own new conversation when due, with the settings it was scheduled with." : undefined}
                    onSubmit={(deliverAt) => actions.onReschedule(entry.id, deliverAt)}
                    onClose={() => setRescheduling(null)}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

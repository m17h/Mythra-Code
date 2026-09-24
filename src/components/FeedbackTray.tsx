import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import type { FeedbackNote } from "../lib/reviewFeedback";
import {
  FeedbackAnchorIcon,
  FeedbackFloat,
  FeedbackNoteCard,
  feedbackAnchorSummary,
  toFeedbackRect,
  useFloatDismiss,
  type FeedbackRect,
} from "./FeedbackNoteCard";

/** Matches the chip exit transition in Feedback.css. */
const CHIP_EXIT_MS = 220;

interface Leaving { note: FeedbackNote; index: number }

/**
 * Staged review notes, shown in the composer above attachments. They go out
 * with the next ordinary send — alone or with a typed prompt — so there is no
 * separate send control here. Render it unconditionally: the tray opens and
 * closes itself, and removed chips animate out before they unmount.
 */
export function FeedbackTray({ notes, staleIds, disabled = false, onUpdate, onRemove }: {
  notes: readonly FeedbackNote[];
  /** Notes whose source changed since they were written. Advisory only. */
  staleIds?: readonly string[];
  /** While a send is in flight, chips stay visible but cannot be edited. */
  disabled?: boolean;
  onUpdate: (id: string, comment: string) => void;
  onRemove: (id: string) => void;
}) {
  const open = notes.length > 0;
  // The last non-empty list stays rendered while the tray itself closes.
  const [retained, setRetained] = useState<readonly FeedbackNote[]>(notes);
  if (open && retained !== notes) setRetained(notes);

  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const previousRef = useRef(notes);
  const timersRef = useRef(new Set<number>());
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = notes;
    if (!notes.length) return;
    const ids = new Set(notes.map((note) => note.id));
    const removed = previous.flatMap((note, index) => (ids.has(note.id) ? [] : [{ note, index }]));
    if (!removed.length) return;
    setLeaving((current) => [...current.filter((entry) => !ids.has(entry.note.id)), ...removed]);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setLeaving((current) => current.filter((entry) => !removed.some((gone) => gone.note.id === entry.note.id)));
    }, CHIP_EXIT_MS);
    timersRef.current.add(timer);
  }, [notes]);
  useEffect(() => () => { timersRef.current.forEach((timer) => window.clearTimeout(timer)); }, []);

  const shown: Array<{ note: FeedbackNote; leaving: boolean }> = (open ? notes : retained).map((note) => ({ note, leaving: false }));
  if (open) {
    for (const entry of [...leaving].sort((left, right) => left.index - right.index)) {
      if (shown.some((item) => item.note.id === entry.note.id)) continue;
      shown.splice(Math.min(entry.index, shown.length), 0, { note: entry.note, leaving: true });
    }
  }

  const stale = new Set(staleIds ?? []);
  const [editing, setEditing] = useState<{ note: FeedbackNote; rect: FeedbackRect; key: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [comment, setComment] = useState("");
  const layerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const liveNote = editing ? notes.find((note) => note.id === editing.note.id) ?? null : null;
  // The snapshot keeps the card intact while it fades out after a removal.
  const editingNote = liveNote ?? editing?.note ?? null;

  // A note removed elsewhere, or a send starting, closes its editor.
  useEffect(() => {
    if (editOpen && (!liveNote || disabled)) setEditOpen(false);
  }, [disabled, editOpen, liveNote]);

  const closeEditor = () => {
    setEditOpen(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  };
  useFloatDismiss(editOpen, layerRef, (reason) => {
    if (reason === "scroll") return;
    if (reason === "escape" || comment.trim() === editingNote?.comment) closeEditor();
  });

  const count = notes.length || retained.length;
  return (
    <div className="feedback-tray" data-open={open || undefined} aria-hidden={!open || undefined} inert={!open || undefined}>
      <div className="feedback-tray-clip">
        <div className="feedback-tray-inner" ref={layerRef}>
          <div className="feedback-tray-heading">
            <span><MessageSquarePlus size={12} aria-hidden="true" /> Feedback <em>{count}</em></span>
            <small>Send alone or with a message</small>
          </div>
          <div className="feedback-tray-list" role="list" aria-label="Staged feedback notes">
            {shown.map(({ note, leaving: isLeaving }, index) => {
              const summary = feedbackAnchorSummary(note.anchor);
              const isStale = stale.has(note.id);
              return (
                <div
                  key={note.id}
                  role="listitem"
                  className={`feedback-chip ${isStale ? "stale" : ""} ${isLeaving ? "leaving" : ""} ${editOpen && editing?.note.id === note.id ? "editing" : ""}`}
                  aria-hidden={isLeaving || undefined}
                  inert={isLeaving || undefined}
                >
                  <button
                    type="button"
                    className="feedback-chip-main"
                    disabled={disabled}
                    title={`${summary.title}${isStale ? " · changed since you noted this" : ""}\n${note.comment}`}
                    aria-label={`Edit feedback ${index + 1}: ${summary.place}${isStale ? ", changed since noted" : ""}`}
                    onClick={(event) => {
                      returnFocusRef.current = event.currentTarget;
                      const rect = toFeedbackRect((event.currentTarget.parentElement ?? event.currentTarget).getBoundingClientRect());
                      setEditing((current) => ({ note, rect, key: (current?.key ?? 0) + 1 }));
                      setComment(note.comment);
                      setEditOpen(true);
                    }}
                  >
                    {isStale ? <span className="feedback-chip-stale" aria-hidden="true" /> : <FeedbackAnchorIcon anchor={note.anchor} size={11} />}
                    <strong>{summary.place}</strong>
                    <span>{note.comment}</span>
                  </button>
                  {!disabled && (
                    <button type="button" className="feedback-chip-remove" onClick={() => onRemove(note.id)} aria-label={`Remove feedback ${index + 1}`}>
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <FeedbackFloat open={editOpen && Boolean(liveNote)} rect={editing?.rect} placement="above" align="start" className="feedback-editor-float" role="dialog" label="Edit feedback">
            {editingNote && editing && (
              <FeedbackNoteCard
                key={editing.key}
                anchor={editingNote.anchor}
                comment={comment}
                submitLabel="Save"
                stale={stale.has(editingNote.id)}
                onComment={setComment}
                onSubmit={() => { onUpdate(editingNote.id, comment.trim()); closeEditor(); }}
                onCancel={closeEditor}
                onRemove={() => { setEditOpen(false); returnFocusRef.current = null; onRemove(editingNote.id); }}
              />
            )}
          </FeedbackFloat>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useMemo } from "react";
import {
  feedbackScopeKey,
  sanitizeFeedbackNotes,
  type FeedbackAnchor,
  type FeedbackNote,
} from "../lib/reviewFeedback";
import { usePersistedStateRef } from "./usePersistedState";

export const REVIEW_FEEDBACK_STORAGE_KEY = "kiwi.reviewFeedback";
const MAX_FEEDBACK_SCOPES = 100;
type FeedbackDrafts = Record<string, FeedbackNote[]>;

function sanitizeFeedbackDrafts(raw: unknown): FeedbackDrafts {
  const result: FeedbackDrafts = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [scope, value] of Object.entries(raw).slice(-MAX_FEEDBACK_SCOPES)) {
    const notes = sanitizeFeedbackNotes(value);
    if (notes.length) result[scope] = notes;
  }
  return result;
}

function withScope(drafts: FeedbackDrafts, scope: string, notes: FeedbackNote[]): FeedbackDrafts {
  const next = { ...drafts };
  delete next[scope];
  if (notes.length) next[scope] = notes;
  const keys = Object.keys(next);
  for (let index = 0; keys.length - index > MAX_FEEDBACK_SCOPES; index += 1) delete next[keys[index]];
  return next;
}

/**
 * Feedback has its own per-thread/workspace draft. Adding or editing a note
 * never touches the ordinary composer text. Accepted sends should pass the
 * exact sent snapshot to removeNotes; an edit made during the send survives.
 */
export function useReviewFeedback(threadKey: string, cwd: string) {
  const scope = feedbackScopeKey(threadKey, cwd);
  const [drafts, setDrafts] = usePersistedStateRef<FeedbackDrafts>(REVIEW_FEEDBACK_STORAGE_KEY, {}, {
    init: (load) => sanitizeFeedbackDrafts(load()),
  });
  const notes = useMemo(() => drafts[scope] ?? [], [drafts, scope]);

  const addNote = useCallback((anchor: FeedbackAnchor, comment: string): FeedbackNote | null => {
    const created: FeedbackNote = {
      id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      anchor,
      comment,
      createdAt: Date.now(),
    };
    let added: FeedbackNote | null = null;
    setDrafts((current) => {
      const before = current[scope] ?? [];
      const after = sanitizeFeedbackNotes([...before, created]);
      if (after.length !== before.length + 1) return current;
      added = after[after.length - 1];
      return withScope(current, scope, after);
    });
    return added;
  }, [scope, setDrafts]);

  const updateNote = useCallback((id: string, comment: string): boolean => {
    let updated = false;
    setDrafts((current) => {
      const before = current[scope] ?? [];
      if (!before.some((note) => note.id === id)) return current;
      const after = sanitizeFeedbackNotes(before.map((note) => note.id === id ? { ...note, comment } : note));
      if (after.length !== before.length) return current;
      updated = true;
      return withScope(current, scope, after);
    });
    return updated;
  }, [scope, setDrafts]);

  const removeNote = useCallback((id: string) => {
    setDrafts((current) => {
      const before = current[scope] ?? [];
      const after = before.filter((note) => note.id !== id);
      return after.length === before.length ? current : withScope(current, scope, after);
    });
  }, [scope, setDrafts]);

  const clearNotes = useCallback(() => {
    setDrafts((current) => current[scope] ? withScope(current, scope, []) : current);
  }, [scope, setDrafts]);

  const removeNotes = useCallback((sent: readonly FeedbackNote[]) => {
    const captured = new Map(sent.map((note) => [note.id, JSON.stringify(note)]));
    setDrafts((current) => {
      const before = current[scope] ?? [];
      const after = before.filter((note) => captured.get(note.id) !== JSON.stringify(note));
      return after.length === before.length ? current : withScope(current, scope, after);
    });
  }, [scope, setDrafts]);

  return { notes, addNote, updateNote, removeNote, removeNotes, clearNotes };
}

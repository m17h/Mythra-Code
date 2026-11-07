import { create } from "zustand";
import { loadStored, storeValue } from "../storage";
import { sanitizeFeedbackNotes, type FeedbackAnchor, type FeedbackNote } from "../reviewFeedback";

/** Notes are written and kept on this device. They reach the other machine only
 * as ordinary text in the next message, so no host file or handle is involved. */
const STORAGE_KEY = "kiwi.remoteReviewFeedback";
const MAX_SCOPES = 100;
type Drafts = Readonly<Record<string, readonly FeedbackNote[]>>;

function loadDrafts(): Drafts {
  const raw = loadStored<unknown>(STORAGE_KEY, {});
  const drafts: Record<string, FeedbackNote[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return drafts;
  for (const [scope, value] of Object.entries(raw).slice(-MAX_SCOPES)) {
    const notes = sanitizeFeedbackNotes(value);
    if (notes.length) drafts[scope] = notes;
  }
  return drafts;
}

export const useRemoteFeedback = create<{ scope: string | null; drafts: Drafts }>(() => ({ scope: null, drafts: {} }));
// Saved values arrive after this module loads, so they're read on first use.
let loaded = false;

function commit(scope: string, notes: FeedbackNote[]) {
  const next: Record<string, readonly FeedbackNote[]> = { ...useRemoteFeedback.getState().drafts };
  delete next[scope];
  if (notes.length) next[scope] = notes;
  const keys = Object.keys(next);
  for (let index = 0; keys.length - index > MAX_SCOPES; index += 1) delete next[keys[index]];
  useRemoteFeedback.setState({ drafts: next });
  storeValue(STORAGE_KEY, next);
}
const notesIn = (scope: string) => [...(useRemoteFeedback.getState().drafts[scope] ?? [])];

/** Which conversation on the other machine a new note belongs to. */
export function setRemoteFeedbackScope(scope: string | null) {
  if (!loaded && scope) { loaded = true; useRemoteFeedback.setState({ drafts: { ...loadDrafts(), ...useRemoteFeedback.getState().drafts } }); }
  useRemoteFeedback.setState({ scope });
}

export function addRemoteFeedback(anchor: FeedbackAnchor, comment: string): boolean {
  const scope = useRemoteFeedback.getState().scope;
  if (!scope) return false;
  const before = notesIn(scope);
  const after = sanitizeFeedbackNotes([...before, { id: crypto.randomUUID(), anchor, comment, createdAt: Date.now() }]);
  if (after.length !== before.length + 1) return false;
  commit(scope, after);
  return true;
}

export function updateRemoteFeedback(scope: string, id: string, comment: string): void {
  const before = notesIn(scope);
  const after = sanitizeFeedbackNotes(before.map((note) => note.id === id ? { ...note, comment } : note));
  if (after.length === before.length) commit(scope, after);
}

export const removeRemoteFeedback = (scope: string, id: string) => commit(scope, notesIn(scope).filter((note) => note.id !== id));

/** Only what went out. A note edited while the message was on its way stays. */
export function removeSentRemoteFeedback(scope: string, sent: readonly FeedbackNote[]) {
  const gone = new Map(sent.map((note) => [note.id, JSON.stringify(note)]));
  commit(scope, notesIn(scope).filter((note) => gone.get(note.id) !== JSON.stringify(note)));
}

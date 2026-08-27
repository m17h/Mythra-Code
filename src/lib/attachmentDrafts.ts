import type { AttachmentRecord } from "../components/StudioDock";

/**
 * Attachments belong to a draft, exactly like the composer's text. Both are
 * keyed the same way — a started thread by its id, an unsent thread by
 * `new:<workspace path>` — so switching conversations can never carry a file
 * from one thread into another's next turn, and coming back to a draft finds
 * the files that were chosen for it.
 */
export type AttachmentDrafts = Record<string, AttachmentRecord[]>;

/** Matches the composer's draft cap so both stores forget in step. */
export const MAX_ATTACHMENT_DRAFTS = 100;

const EMPTY: AttachmentRecord[] = [];

export function attachmentsFor(drafts: AttachmentDrafts, key: string): AttachmentRecord[] {
  return drafts[key] ?? EMPTY;
}

/**
 * Replaces one draft's attachments. An emptied draft is deleted rather than
 * stored as `[]`, which keeps the oldest-first cap meaningful.
 */
export function withAttachmentDraft(
  drafts: AttachmentDrafts,
  key: string,
  next: AttachmentRecord[],
): AttachmentDrafts {
  if (attachmentsFor(drafts, key) === next) return drafts;
  const updated: AttachmentDrafts = { ...drafts };
  // Reinsert a non-empty draft so property order remains least-recently-used.
  // Otherwise editing the oldest draft would leave it first in the object and
  // the very next new conversation could evict the draft just edited.
  delete updated[key];
  if (next.length) updated[key] = next;
  let excess = Object.keys(updated).length - MAX_ATTACHMENT_DRAFTS;
  if (excess > 0) {
    for (const candidate of Object.keys(updated)) {
      delete updated[candidate];
      excess -= 1;
      if (excess === 0) break;
    }
  }
  return updated;
}

/** Forgets a draft outright — used when its thread is deleted or archived. */
export function forgetAttachmentDraft(drafts: AttachmentDrafts, key: string): AttachmentDrafts {
  if (!(key in drafts)) return drafts;
  const updated = { ...drafts };
  delete updated[key];
  return updated;
}

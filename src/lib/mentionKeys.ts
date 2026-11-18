/**
 * Keys inside the composer's @ suggestion list (skills and files).
 *
 * The list is an inline listbox the textarea drives, so the textarea's own
 * keydown decides what each key does while it is open:
 *   - ↑ / ↓ move the highlight
 *   - Return (Enter) or Tab inserts the highlighted suggestion (the documented
 *     autocomplete behaviour; the hint row under the list says so)
 *   - Escape closes the list and leaves the draft as typed
 *   - Shift+Tab never edits the draft: it closes the list and lets the
 *     browser move focus backward as usual
 * Tab with ⌘ or Ctrl held belongs to the app/window, not the list.
 * Anything else falls through to the normal composer handling.
 */
export type MentionKeyAction = "next" | "previous" | "accept" | "close" | "close-and-pass" | null;

export type MentionKeyInput = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
};

export function mentionKeyAction(event: MentionKeyInput, open: boolean, resultCount: number): MentionKeyAction {
  if (!open || resultCount <= 0) return null;
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Enter":
      return "accept";
    case "Tab":
      if (event.metaKey || event.ctrlKey) return null;
      // Reverse Tab is navigation, never acceptance.
      return event.shiftKey ? "close-and-pass" : "accept";
    case "Escape":
      return "close";
    default:
      return null;
  }
}

/** The highlight after ↑/↓, wrapping at both ends. */
export function nextMentionIndex(index: number, count: number, direction: "next" | "previous"): number {
  if (count <= 0) return 0;
  const current = Number.isFinite(index) && index >= 0 && index < count ? index : direction === "next" ? -1 : 0;
  return direction === "next" ? (current + 1) % count : (current + count - 1) % count;
}

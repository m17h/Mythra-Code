/**
 * Which elements a keyboard user can actually reach. Pure (duck-typed) so it
 * can be unit-tested without a DOM; `useModalFocus` and the sidebar peek use it.
 */
export const FOCUSABLE_SELECTOR =
  "button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), a[href], summary, [contenteditable='true'], [tabindex]:not([tabindex='-1'])";

/** Ancestors that make every descendant unreachable. */
const UNREACHABLE_ANCESTOR = "[inert], [hidden], [aria-hidden='true'], fieldset[disabled]";

type FocusCandidate = {
  tabIndex: number;
  tagName?: string;
  parentElement?: FocusCandidate | null;
  closest: (selector: string) => unknown;
  getClientRects?: () => { length: number };
  hasAttribute?: (name: string) => boolean;
};

/**
 * True when `element` is inside a closed <details> and is not that details'
 * own summary (the summary stays reachable so it can open the details).
 */
export function insideCollapsedDetails(element: FocusCandidate, root?: FocusCandidate | null): boolean {
  let node: FocusCandidate | null | undefined = element;
  let child: FocusCandidate | null | undefined = null;
  while (node && node !== root) {
    if ((node.tagName ?? "").toUpperCase() === "DETAILS" && !node.hasAttribute?.("open")) {
      // `child` is the direct child of this details on the path to element.
      const isOwnSummary = child && (child.tagName ?? "").toUpperCase() === "SUMMARY";
      if (!isOwnSummary) return true;
    }
    child = node;
    node = node.parentElement;
  }
  return false;
}

export function isReachableFocusable(
  element: FocusCandidate,
  root?: FocusCandidate | null,
  computedVisibility?: (element: FocusCandidate) => string,
): boolean {
  if (element.tabIndex < 0) return false;
  if (element.closest(UNREACHABLE_ANCESTOR)) return false;
  if (element.hasAttribute?.("disabled")) return false;
  if (insideCollapsedDetails(element, root)) return false;
  if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
  const visibility =
    computedVisibility?.(element) ??
    (typeof getComputedStyle === "function" ? getComputedStyle(element as unknown as Element).visibility : "visible");
  return visibility !== "hidden" && visibility !== "collapse";
}

/**
 * Where Tab (or Shift+Tab) should land inside a modal surface, given its
 * reachable tab stops in document order. Returns the index to focus, or null
 * to let the browser move focus normally (it stays inside: there is a stop on
 * that side of the active element).
 *
 * - `activeIndex`: the focused element's index among the stops, or -1 when it
 *   is not a stop (a heading or the dialog itself focused programmatically).
 * - `before`: how many stops precede the focused element in document order;
 *   only read when `activeIndex` is -1.
 * - `inside`: false when focus is outside the surface (or on the page body).
 *
 * The case this exists for: a dialog that opens by focusing its static title
 * (tabindex -1). The browser's own Shift+Tab from there walks backwards out of
 * the dialog, into an inert page, and lands on <body>.
 */
export function containedTabTarget({ count, activeIndex, before, inside, shift }: {
  count: number;
  activeIndex: number;
  before: number;
  inside: boolean;
  shift: boolean;
}): number | null {
  if (count <= 0) return null;
  if (!inside) return shift ? count - 1 : 0;
  if (activeIndex >= 0) {
    if (shift && activeIndex === 0) return count - 1;
    if (!shift && activeIndex === count - 1) return 0;
    return null;
  }
  const preceding = Math.max(0, Math.min(before, count));
  if (shift) return preceding > 0 ? preceding - 1 : count - 1;
  return preceding < count ? preceding : 0;
}

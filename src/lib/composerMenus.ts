/** Root class of the provider picker every composer model control embeds. */
export const PROVIDER_CONTROL_SELECTOR = ".thread-provider-control";

/**
 * Whether a dismissal event should close an open model menu.
 *
 * The composer renders the provider picker *inside* each model control's root,
 * so plain `root.contains(target)` containment is asymmetric: clicking the
 * model trigger is outside the provider control and closes its menu, but
 * clicking the provider trigger counts as inside the model control and left
 * both popovers open. Treating the nested provider control as outside makes
 * the two mutually exclusive in either opening order, without either component
 * having to know about the other's state.
 */
export function closesModelMenu(event: Event, root: HTMLElement | null): boolean {
  if (!root) return true;
  // The propagation path is fixed when dispatch starts. Unlike
  // `root.contains(event.target)`, it still records that a click began inside
  // the menu when React synchronously replaces the clicked control before the
  // event reaches this document listener.
  const path = event.composedPath();
  // Activating the nested provider pill always dismisses the model menu, for
  // pointer presses and for the Enter/Space activation that emits no pointer
  // event at all.
  if (path.some((entry) => entry instanceof Element && entry.matches(PROVIDER_CONTROL_SELECTOR))) return true;
  return !path.includes(root);
}

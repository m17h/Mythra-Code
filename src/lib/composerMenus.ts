/** Root class of the provider picker every composer model control embeds. */
export const PROVIDER_CONTROL_SELECTOR = ".thread-provider-control";

/**
 * Whether a pointer event should close an open model menu.
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
  const target = event.target;
  if (!root || !(target instanceof Node)) return true;
  if (!root.contains(target)) return true;
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest(PROVIDER_CONTROL_SELECTOR));
}

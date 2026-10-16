import { useSyncExternalStore } from "react";
import { loadStored, storeValue } from "./storage";

/**
 * Opt-in performance overlay. A per-device display preference that applies
 * immediately (it is not part of Settings Save/Cancel), plus a counter of
 * provider events the overlay turns into a rate. Counting is one integer
 * increment per delivered batch item, so it costs nothing when the overlay
 * is off.
 */
const KEY = "kiwi.performanceOverlay";
let enabled = loadStored<boolean>(KEY, false) === true;
const listeners = new Set<() => void>();

export function performanceOverlayEnabled(): boolean {
  return enabled;
}

export function setPerformanceOverlayEnabled(value: boolean): void {
  if (value === enabled) return;
  enabled = value;
  storeValue(KEY, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePerformanceOverlayEnabled(): boolean {
  return useSyncExternalStore(subscribe, performanceOverlayEnabled, performanceOverlayEnabled);
}

let providerEvents = 0;

/** Called by provider event listeners with the number of events delivered. */
export function countProviderEvents(count = 1): void {
  providerEvents += count;
}

export function providerEventTotal(): number {
  return providerEvents;
}

const requestedStops = new Set<string>();

function key(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}

/** Record stop intent before an asynchronous provider kill can emit exit. */
export function markProviderStopIntent(threadId: string, turnId: string): void {
  requestedStops.add(key(threadId, turnId));
}

export function clearProviderStopIntent(threadId: string, turnId: string): void {
  requestedStops.delete(key(threadId, turnId));
}

/** Consume the intent once a terminal provider event classifies the turn. */
export function consumeProviderStopIntent(threadId: string, turnId: string): boolean {
  const stopKey = key(threadId, turnId);
  const requested = requestedStops.has(stopKey);
  requestedStops.delete(stopKey);
  return requested;
}

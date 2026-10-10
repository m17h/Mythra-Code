// Native turn IDs are learned from start acknowledgments or early events.
// The local start token distinguishes a pending replacement from an old
// process's tail even after Stop cleared activeTurnId in the task store.
interface Owner {
  token: object;
  startRequestId?: string;
  turnId?: string;
  closed?: boolean;
  stopped?: boolean;
  settled?: boolean;
  previous?: Owner;
}

interface KnownTurn {
  token: object;
  closed: boolean;
  stopped?: boolean;
}

export interface CursorStartAttempt {
  owner: Owner;
}

const owners = new Map<string, Owner>();
const knownTurns = new Map<string, KnownTurn>();
const latestUsageSnapshotTurns = new Map<string, string>();
const MAX_KNOWN_TURNS = 200;
const key = (threadId: string, turnId: string) => `${threadId}\0${turnId}`;

function remember(threadId: string, turnId: string, token: object, closed = false, stopped = false): void {
  const id = key(threadId, turnId);
  const previous = knownTurns.get(id);
  knownTurns.delete(id);
  knownTurns.set(id, { token, closed, stopped: stopped || (previous?.token === token && previous.stopped) });
  if (knownTurns.size > MAX_KNOWN_TURNS) {
    const oldest = knownTurns.keys().next().value;
    if (oldest !== undefined) knownTurns.delete(oldest);
  }
}

export function cursorTurnOwner(threadId: string, activeTurnId?: string): Owner | undefined {
  let owner = owners.get(threadId);
  // Renderer restoration can supply an accepted identity before its first
  // event. Keep that evidence when dispatching a new start or Stop.
  if (!owner && activeTurnId) {
    owner = { token: {}, turnId: activeTurnId };
    owners.set(threadId, owner);
    remember(threadId, activeTurnId, owner.token);
  }
  return owner;
}

export function beginCursorTurnStart(threadId: string, activeTurnId?: string): CursorStartAttempt {
  const previous = cursorTurnOwner(threadId, activeTurnId);
  const owner = { token: {}, startRequestId: crypto.randomUUID(), previous };
  owners.set(threadId, owner);
  return { owner };
}

export function isCurrentCursorTurnStart(threadId: string, attempt: CursorStartAttempt): boolean {
  return owners.get(threadId) === attempt.owner;
}

export function cursorTurnStartAttempt(threadId: string, startRequestId: string): CursorStartAttempt | undefined {
  let owner = owners.get(threadId);
  while (owner && owner.startRequestId !== startRequestId) owner = owner.previous;
  return owner ? { owner } : undefined;
}

export function cursorTurnCanSettle(threadId: string, turnId: string, startRequestId?: string): boolean {
  const owner = owners.get(threadId);
  return owner?.turnId === turnId && (!startRequestId || owner.startRequestId === startRequestId);
}

export function cursorTurnWasSettled(threadId: string, turnId: string, startRequestId?: string): boolean {
  let owner = owners.get(threadId);
  while (owner && owner.turnId !== turnId) owner = owner.previous;
  return Boolean(owner?.settled && (!startRequestId || owner.startRequestId === startRequestId));
}

export function acceptCursorTurnStart(threadId: string, attempt: CursorStartAttempt, turnId: string): boolean {
  // A very short turn may have completed, or a successor may have begun,
  // before this acknowledgment arrives. Neither may be resurrected here.
  attempt.owner.turnId = turnId;
  remember(threadId, turnId, attempt.owner.token, Boolean(attempt.owner.closed));
  // A successful native start no longer needs rollback ancestry. A stale
  // acknowledgment still teaches us its identity, but never replaces owner.
  attempt.owner.previous = undefined;
  return owners.get(threadId) === attempt.owner && !attempt.owner.stopped;
}

export function rejectCursorTurnStart(threadId: string, attempt: CursorStartAttempt): void {
  attempt.owner.closed = true;
  if (attempt.owner.turnId) remember(threadId, attempt.owner.turnId, attempt.owner.token, true);
  if (owners.get(threadId) !== attempt.owner) return;
  let previous = attempt.owner.previous;
  while (previous && (previous.closed || (previous.turnId && knownTurns.get(key(threadId, previous.turnId))?.closed))) {
    previous = previous.previous;
  }
  if (previous) {
    owners.set(threadId, previous);
  } else {
    owners.delete(threadId);
  }
}

export function observeCursorTurnOwner(threadId: string, turnId: string, startRequestId?: string): { mayActivate: boolean; newerOwner: boolean; stopped?: boolean } {
  let owner = owners.get(threadId);
  // Pending/current identities cannot fall out of protection just because
  // unrelated settled turns exhausted the bounded historical-ID cache.
  let matchingOwner = owner;
  while (matchingOwner && matchingOwner.turnId !== turnId) matchingOwner = matchingOwner.previous;
  const known = matchingOwner
    ? { token: matchingOwner.token, closed: Boolean(matchingOwner.closed), stopped: matchingOwner.stopped }
    : knownTurns.get(key(threadId, turnId));
  if (startRequestId && owner?.startRequestId !== startRequestId) {
    return { mayActivate: false, newerOwner: Boolean(owner), stopped: known?.stopped };
  }
  // Untagged legacy output may enrich history but cannot claim a tagged
  // pending start; its exact native identity must first be acknowledged.
  if (!startRequestId && owner?.startRequestId && !owner.turnId) {
    return { mayActivate: false, newerOwner: true, stopped: known?.stopped };
  }
  if (known && (known.closed || known.token !== owner?.token)) {
    return { mayActivate: false, newerOwner: Boolean(owner && owner.token !== known.token), ...(known.stopped ? { stopped: true } : {}) };
  }
  if (owner?.turnId && owner.turnId !== turnId) return { mayActivate: false, newerOwner: true };
  if (!owner) {
    owner = { token: {}, turnId };
    owners.set(threadId, owner);
  } else {
    owner.turnId = turnId;
  }
  if (!known) remember(threadId, turnId, owner.token);
  return { mayActivate: true, newerOwner: false };
}

export function retireCursorTurnOwner(threadId: string, owner: Owner | undefined): void {
  if (!owner) return;
  owner.closed = true;
  owner.stopped = true;
  if (owner.turnId) remember(threadId, owner.turnId, owner.token, true, true);
  // Retain the latest settled token for late start acknowledgments. A new
  // start replaces it; rollback skips it because it is closed.
}

export function finishCursorTurnOwner(threadId: string, turnId: string): void {
  const owner = owners.get(threadId);
  const known = knownTurns.get(key(threadId, turnId));
  if (known) remember(threadId, turnId, known.token, true);
  let matchingOwner = owner;
  while (matchingOwner && matchingOwner.turnId !== turnId) matchingOwner = matchingOwner.previous;
  if (matchingOwner) {
    matchingOwner.closed = true;
    matchingOwner.settled = true;
  }
}

export function latestCursorUsageSnapshotTurn(threadId: string): string | undefined {
  return latestUsageSnapshotTurns.get(threadId);
}

export function markCursorUsageSnapshotTurn(threadId: string, turnId: string): void {
  latestUsageSnapshotTurns.set(threadId, turnId);
}

export function resetCursorTurnOwnershipForTests(): void {
  owners.clear();
  knownTurns.clear();
  latestUsageSnapshotTurns.clear();
}

export function forgetCursorTurnOwnership(threadId: string): void {
  owners.delete(threadId);
  latestUsageSnapshotTurns.delete(threadId);
  for (const id of knownTurns.keys()) if (id.startsWith(`${threadId}\0`)) knownTurns.delete(id);
}

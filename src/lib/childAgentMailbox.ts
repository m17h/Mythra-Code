import { useSyncExternalStore } from "react";
import { loadStored, storeValue } from "./storage";

/**
 * Durable parent ↔ child mailbox for Mythra Code-managed sub-agents.
 *
 * A child can ask its parent a question or report progress while it works,
 * and a parent can send guidance or more work back on the child's own
 * conversation. Nothing here talks to a provider: this module only records
 * what was said and its real delivery state, so the bridge handlers, the
 * follow-up pump and the UI all read one truthful source.
 *
 * The store is synchronous and module-level on purpose. Tool calls can arrive
 * between React renders (a child can ask before its ownership link renders),
 * and every transition must be atomic with respect to the next request.
 *
 * New messages respect per-mailbox and aggregate storage bounds. Previously
 * stored pending work is preserved even when it already exceeds a bound.
 * Pending entries (unanswered questions, unread updates, queued guidance) are never evicted;
 * settled ones are dropped oldest-first and counted in `dropped`, so a reader
 * can say honestly that earlier history was trimmed.
 */

export const MAX_MAILBOX_TEXT = 4_000;
export const MAX_MAILBOX_MESSAGES = 50;
export const MAX_UNREAD_FOR_PARENT = 20;
export const MAX_QUEUED_FOR_CHILD = 8;
/** Two million serialized characters; leaves a practical bound on every write. */
const MAX_STORE_CHARACTERS = 2 * 1024 * 1024;
/** Leave room for answers even when incoming questions use their admission budget. */
const MAX_NEW_WORK_CHARACTERS = MAX_STORE_CHARACTERS / 2;
const MAX_REASON = 300;
/** Guidance queued behind an unconfirmed delivery is never sent automatically. */
const HELD_REASON = "Not sent automatically because earlier guidance may not have been delivered. Check the child's state and resend this if it is still needed.";
const STORAGE_KEY = "kiwi.childAgentMailbox";
const MAX_SEQUENCE = 9_999_999_999;
const MESSAGE_ID = /^m\d{1,10}(?![\s\S])/;
// Require the actual end of the string: JavaScript's `$` also accepts a final newline.
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,80}(?![\s\S])/;

/** Child → parent entries are unread until a parent tool returns them. */
export type ParentBoundState = "unread" | "read";
/**
 * Parent → child delivery. `delivering` is in-flight provider work; a reload
 * during it cannot prove either outcome and is recorded as failed/uncertain.
 */
export type ChildBoundState = "queued" | "delivering" | "delivered" | "failed" | "cancelled";

export interface ChildMailMessage {
  /** App-generated label, unique within one child's mailbox (`m1`, `m2`…). */
  id: string;
  /** Optional caller retry identity, honored only while this message is retained. */
  clientRequestId?: string;
  direction: "toParent" | "toChild";
  kind: "question" | "update" | "guidance";
  text: string;
  createdAt: number;
  state: ParentBoundState | ChildBoundState;
  /** How guidance reached the child: live steer, follow-up turn, or pulled by the child. */
  via?: "steer" | "turn" | "read";
  settledAt?: number;
  /** A question is answered only after its linked parent reply reaches the child. */
  answeredAt?: number;
  /** Explicit parent sign-off can close a question without pretending it was answered. */
  closedAt?: number;
  /** Sanitization shortened older externally supplied text. */
  textTruncated?: boolean;
  /** Parent guidance answering a child message. */
  replyTo?: string;
  /** Short reason for failed or cancelled guidance. */
  reason?: string;
  /**
   * A failed delivery whose outcome is unknown: the provider may have
   * received it (interrupted by reload, lost after dispatch). Never described
   * as "not delivered".
   */
  uncertain?: boolean;
  /** Child-chosen key of the read that consumed this guidance, for replay. */
  readKey?: string;
}

export interface ChildMailbox {
  rootThreadId: string;
  nextSeq: number;
  /** Settled entries evicted by the bound. */
  dropped: number;
  /** Bounded retry receipts for pulls that returned no guidance. */
  emptyReadKeys?: string[];
  /**
   * Highest guidance sequence that settled failed or cancelled. Durable even
   * when that entry is later trimmed, so a review token can bind to every
   * undelivered correction a parent could have seen.
   */
  undeliveredSeq?: number;
  /**
   * Undelivered outcomes at or below this sequence were resolved by an
   * explicit acceptance. Later unrelated delivery never resolves them.
   */
  resolvedThroughSeq?: number;
  messages: ChildMailMessage[];
}

type MailboxState = Record<string, ChildMailbox>;

let state: MailboxState | null = null;
const listeners = new Set<() => void>();
const serializedMailboxSizes = new WeakMap<ChildMailbox, number>();

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function finiteCount(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function finiteTimestamp(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 8_640_000_000_000_000 ? number : 0;
}

function sanitizeMessage(candidate: unknown): ChildMailMessage | null {
  if (!candidate || typeof candidate !== "object") return null;
  const entry = candidate as Record<string, unknown>;
  const id = typeof entry.id === "string" && MESSAGE_ID.test(entry.id) && Number(entry.id.slice(1)) > 0 ? entry.id : "";
  const direction = entry.direction === "toParent" || entry.direction === "toChild" ? entry.direction : null;
  const text = boundedText(entry.text, MAX_MAILBOX_TEXT);
  if (!id || !direction || !text.trim()) return null;
  const kind = direction === "toChild" ? "guidance" : entry.kind === "question" ? "question" : "update";
  let messageState: ChildMailMessage["state"];
  let reason = boundedText(entry.reason, MAX_REASON) || undefined;
  if (direction === "toParent") {
    messageState = entry.state === "read" ? "read" : "unread";
  } else if (entry.state === "delivering") {
    // The renderer was reloaded while a provider call was in flight. Its
    // outcome is unknown; never retry it silently and never claim delivery.
    messageState = "failed";
    reason = "Delivery was interrupted by an app reload; it may or may not have reached the sub-agent. Resend it if it is still needed.";
  } else if (entry.state === "queued" || entry.state === "delivered" || entry.state === "failed" || entry.state === "cancelled") {
    messageState = entry.state;
  } else return null;
  if (direction !== "toChild" || (messageState !== "failed" && messageState !== "cancelled")) reason = undefined;
  const via = direction === "toChild" && messageState === "delivered"
    && (entry.via === "steer" || entry.via === "turn" || entry.via === "read") ? entry.via : undefined;
  const replyTo = direction === "toChild" && typeof entry.replyTo === "string" && MESSAGE_ID.test(entry.replyTo) ? entry.replyTo : undefined;
  const createdAt = finiteTimestamp(entry.createdAt);
  const settledAt = direction === "toChild" && (messageState === "queued" || entry.state === "delivering")
    ? undefined : finiteTimestamp(entry.settledAt) || undefined;
  const answeredAt = kind === "question" ? finiteTimestamp(entry.answeredAt) || undefined : undefined;
  const closedAt = kind === "question" ? finiteTimestamp(entry.closedAt) || undefined : undefined;
  const clientRequestId = typeof entry.clientRequestId === "string" && CLIENT_REQUEST_ID.test(entry.clientRequestId) ? entry.clientRequestId : undefined;
  const uncertain = direction === "toChild" && messageState === "failed" && (entry.state === "delivering" || entry.uncertain === true);
  const readKey = direction === "toChild" && messageState === "delivered" && via === "read"
    && typeof entry.readKey === "string" && CLIENT_REQUEST_ID.test(entry.readKey) ? entry.readKey : undefined;
  return {
    id, direction, kind, text, createdAt, state: messageState,
    ...(clientRequestId ? { clientRequestId } : {}),
    ...(via ? { via } : {}),
    ...(settledAt ? { settledAt } : {}),
    ...(answeredAt ? { answeredAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    ...(entry.textTruncated === true || (typeof entry.text === "string" && entry.text.length > MAX_MAILBOX_TEXT) ? { textTruncated: true } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(reason ? { reason } : {}),
    ...(uncertain ? { uncertain: true } : {}),
    ...(readKey ? { readKey } : {}),
  };
}

export function sanitizeChildAgentMailboxes(stored: unknown): MailboxState {
  if (!stored || typeof stored !== "object") return {};
  const result: MailboxState = {};
  for (const [childThreadId, candidate] of Object.entries(stored as Record<string, unknown>)) {
    if (!childThreadId.trim() || childThreadId.length > 200 || !candidate || typeof candidate !== "object") continue;
    if (childThreadId === "__proto__" || childThreadId === "constructor" || childThreadId === "prototype") continue;
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.rootThreadId !== "string" || !entry.rootThreadId.trim() || entry.rootThreadId.length > 200) continue;
    const messages: ChildMailMessage[] = [];
    const ids = new Set<string>();
    let dropped = finiteCount(entry.dropped);
    let highest = 0;
    // Guidance interrupted mid-delivery by a reload is uncertain; anything
    // queued after it must not be sent automatically across that gap.
    let reloadUncertainSeq = Infinity;
    for (const candidateMessage of Array.isArray(entry.messages) ? entry.messages : []) {
      // A damaged message body still spent its ID. Preserve the high-water
      // mark before rejecting it, so recovery cannot reuse that identity.
      if (candidateMessage && typeof candidateMessage === "object") {
        const candidateId = (candidateMessage as Record<string, unknown>).id;
        if (typeof candidateId === "string" && MESSAGE_ID.test(candidateId)) {
          highest = Math.max(highest, Number(candidateId.slice(1)));
          if ((candidateMessage as Record<string, unknown>).state === "delivering") {
            reloadUncertainSeq = Math.min(reloadUncertainSeq, Number(candidateId.slice(1)));
          }
        }
      }
      const message = sanitizeMessage(candidateMessage);
      if (!message || ids.has(message.id)) { dropped += 1; continue; }
      ids.add(message.id);
      messages.push(message);
    }
    // Older records did not persist a question's resolution independently of
    // the reply. Infer it before trimming replies, then retain it durably.
    const answers = new Map(messages.filter((message) => message.direction === "toChild" && message.state === "delivered" && message.replyTo)
      .map((message) => [message.replyTo!, message.settledAt || message.createdAt || 1]));
    const held = messages.map((message) => message.direction === "toChild" && message.state === "queued"
      && Number(message.id.slice(1)) > reloadUncertainSeq
      ? { ...message, state: "failed" as const, reason: HELD_REASON, settledAt: Date.now() } : message);
    const undeliveredSeq = Math.max(finiteCount(entry.undeliveredSeq), ...held
      .filter((message) => message.direction === "toChild" && (message.state === "failed" || message.state === "cancelled"))
      .map((message) => Number(message.id.slice(1))));
    const resolvedThroughSeq = finiteCount(entry.resolvedThroughSeq);
    const emptyReadKeys = Array.isArray(entry.emptyReadKeys)
      ? [...new Set(entry.emptyReadKeys.filter((key): key is string => typeof key === "string" && CLIENT_REQUEST_ID.test(key)))].slice(-MAX_MAILBOX_MESSAGES)
      : [];
    const mailbox: ChildMailbox = {
      rootThreadId: entry.rootThreadId,
      nextSeq: Math.max(highest + 1, Math.min(MAX_SEQUENCE + 1, finiteCount(entry.nextSeq, 1))),
      dropped,
      ...(emptyReadKeys.length ? { emptyReadKeys } : {}),
      ...(undeliveredSeq ? { undeliveredSeq } : {}),
      ...(resolvedThroughSeq ? { resolvedThroughSeq } : {}),
      messages: held.map((message) => message.kind === "question" && !message.answeredAt && answers.has(message.id)
        ? { ...message, answeredAt: answers.get(message.id) } : message),
    };
    result[childThreadId] = trimMailbox(mailbox);
  }
  return trimStoreHistory(result);
}

function current(): MailboxState {
  if (!state) state = sanitizeChildAgentMailboxes(loadStored<unknown>(STORAGE_KEY, {}));
  return state;
}

function isPending(message: ChildMailMessage): boolean {
  return message.state === "unread" || message.state === "queued" || message.state === "delivering"
    || (message.direction === "toParent" && message.kind === "question" && !message.answeredAt && !message.closedAt);
}

const sequence = (message: ChildMailMessage) => Number(message.id.slice(1));

/**
 * Failed/cancelled guidance still awaiting the parent's attention. Only an
 * explicit acceptance, or a later delivered resend of the same text and
 * reply target, resolves it; unrelated later delivery does not.
 */
function unresolvedOutcomeList(mailbox: ChildMailbox | undefined): ChildMailMessage[] {
  if (!mailbox?.undeliveredSeq || mailbox.undeliveredSeq <= (mailbox.resolvedThroughSeq ?? 0)) return [];
  const delivered = mailbox.messages.filter((message) => message.direction === "toChild" && message.state === "delivered");
  return mailbox.messages.filter((message) => message.direction === "toChild"
    && (message.state === "failed" || message.state === "cancelled")
    && sequence(message) > (mailbox.resolvedThroughSeq ?? 0)
    && !delivered.some((resend) => sequence(resend) > sequence(message) && resend.text === message.text && resend.replyTo === message.replyTo));
}

/** Unresolved outcomes are actionable truth and are never trimmed. */
function protectedIds(mailbox: ChildMailbox): Set<string> {
  return new Set(unresolvedOutcomeList(mailbox).map((message) => message.id));
}

function trimMailbox(mailbox: ChildMailbox): ChildMailbox {
  let remove = Math.max(0, mailbox.messages.length - MAX_MAILBOX_MESSAGES);
  if (!remove) return mailbox;
  const kept = protectedIds(mailbox);
  const messages = mailbox.messages.filter((message) => {
    if (remove && !isPending(message) && !kept.has(message.id)) { remove -= 1; return false; }
    return true;
  });
  return { ...mailbox, messages, dropped: mailbox.dropped + mailbox.messages.length - messages.length };
}

function storeCharacters(all: MailboxState): number {
  return 2 + Object.entries(all).reduce((count, [id, mailbox]) => {
    let size = serializedMailboxSizes.get(mailbox);
    if (size === undefined) {
      size = JSON.stringify(mailbox).length;
      serializedMailboxSizes.set(mailbox, size);
    }
    return count + JSON.stringify(id).length + size + 2;
  }, 0);
}

/** Trim settled history, retaining each mailbox and its honest dropped count. */
function trimStoreHistory(all: MailboxState, limit = MAX_STORE_CHARACTERS): MailboxState {
  let characters = storeCharacters(all);
  if (characters <= limit) return all;
  const removable = Object.entries(all).flatMap(([childId, mailbox]) => {
    const kept = protectedIds(mailbox);
    return mailbox.messages.filter((message) => !isPending(message) && !kept.has(message.id)).map((message) => ({ childId, message }));
  })
    .sort((a, b) => a.message.createdAt - b.message.createdAt);
  const removed = new Map<string, Set<string>>();
  for (const { childId, message } of removable) {
    if (characters <= limit) break;
    const ids = removed.get(childId) ?? new Set<string>();
    const mailbox = all[childId];
    const previousDropped = mailbox.dropped + ids.size;
    // Removing the last array entry removes no comma, and growing the
    // disclosed dropped count also costs characters. Account for both rather
    // than assuming a fixed reserve covers any number of historical children.
    characters -= JSON.stringify(message).length + (mailbox.messages.length - ids.size > 1 ? 1 : 0);
    characters += String(previousDropped + 1).length - String(previousDropped).length;
    ids.add(message.id);
    removed.set(childId, ids);
  }
  const next = { ...all };
  for (const [childId, ids] of removed) {
    const mailbox = all[childId];
    next[childId] = { ...mailbox, messages: mailbox.messages.filter((message) => !ids.has(message.id)), dropped: mailbox.dropped + ids.size };
  }
  return next;
}

function commit(next: MailboxState): void {
  // Capture storage successfully before publishing an in-memory revision.
  // Native acknowledgement remains owned by storage.ts's write/close guards.
  storeValue(STORAGE_KEY, next);
  state = next;
  for (const listener of [...listeners]) listener();
}

function updateMailbox(childThreadId: string, rootThreadId: string, update: (mailbox: ChildMailbox) => ChildMailbox, admission: false | "work" | "answer" | "read" = false): ChildMailbox {
  const all = current();
  // Aggregate serialized capacity already bounds mailbox records. Preserve
  // their sequence/dropped counters instead of imposing a lifetime child cap
  // or evicting old mailboxes to make room for a new conversation.
  const existing = all[childThreadId] ?? { rootThreadId, nextSeq: 1, dropped: 0, messages: [] };
  if (admission && admission !== "read" && existing.nextSeq > MAX_SEQUENCE) throw new Error("This conversation has exhausted its message IDs; this message was not saved.");
  const next = update(existing);
  if (next === existing) return existing;
  const bounded = trimMailbox(next);
  const limit = admission === "answer" ? MAX_STORE_CHARACTERS : MAX_NEW_WORK_CHARACTERS;
  const boundedStore = trimStoreHistory({ ...all, [childThreadId]: bounded }, admission ? limit : MAX_STORE_CHARACTERS);
  if (admission && (bounded.messages.length > MAX_MAILBOX_MESSAGES || storeCharacters(boundedStore) > limit)) {
    if (admission === "read") throw new Error("The mailbox is full, so this empty pull's replay receipt could not be saved. No guidance was consumed; use a fresh replayKey for a new pull.");
    throw new Error("The conversation mailbox is full. Read updates, answer open questions, explicitly accept finished work, or delete old conversations before sending more; this message was not saved.");
  }
  commit(boundedStore);
  return boundedStore[childThreadId];
}

export function getChildMailbox(childThreadId: string): ChildMailbox | undefined {
  return current()[childThreadId];
}

export function getChildMailboxes(): Readonly<MailboxState> {
  return current();
}

export function subscribeChildMailboxes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A single conversation does not need to rerender for another child's mail. */
export function subscribeChildMailbox(childThreadId: string, listener: () => void): () => void {
  let snapshot = getChildMailbox(childThreadId);
  return subscribeChildMailboxes(() => {
    const next = getChildMailbox(childThreadId);
    if (snapshot === next) return;
    snapshot = next;
    listener();
  });
}

/** Whole-store snapshot for UI that summarizes many children. */
export function useChildMailboxes(): Readonly<MailboxState> {
  return useSyncExternalStore(subscribeChildMailboxes, getChildMailboxes);
}

export function useChildMailbox(childThreadId: string): ChildMailbox | undefined {
  return useSyncExternalStore(
    (listener) => subscribeChildMailbox(childThreadId, listener),
    () => getChildMailbox(childThreadId),
  );
}

function latestMatching(mailbox: ChildMailbox | undefined, matches: (message: ChildMailMessage) => boolean): ChildMailMessage | undefined {
  const messages = mailbox?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (matches(messages[index])) return messages[index];
  }
  return undefined;
}

function requestRetry(
  mailbox: ChildMailbox | undefined,
  clientRequestId: string | undefined,
  direction: ChildMailMessage["direction"],
  kind: ChildMailMessage["kind"],
  text: string,
  replyTo?: string,
): ChildMailMessage | undefined {
  if (clientRequestId === undefined) return undefined;
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(clientRequestId)) {
    throw new Error("clientRequestId must contain 1–80 ASCII letters, digits, underscores, dots, colons, or hyphens.");
  }
  const existing = latestMatching(mailbox, (message) => message.direction === direction && message.clientRequestId === clientRequestId);
  if (existing && (existing.kind !== kind || existing.text !== text || existing.replyTo !== replyTo)) {
    throw new Error("This clientRequestId already identifies a different message. Use a new key for new work; this message was not saved.");
  }
  return existing;
}

function trimmedMessageText(text: string): string {
  const value = text.trim();
  if (!value) throw new Error("The message cannot be empty.");
  if (value.length > MAX_MAILBOX_TEXT) {
    throw new Error(`The message is too long (${value.length} characters); the limit is ${MAX_MAILBOX_TEXT}. Summarize, or point at files in the workspace.`);
  }
  return value;
}

/**
 * Record a child's question or update. A caller key deduplicates retained
 * history; without a key, only identical still-pending content is reused.
 */
export function postMessageToParent(
  childThreadId: string,
  rootThreadId: string,
  kind: "question" | "update",
  text: string,
  clientRequestId?: string,
): { message: ChildMailMessage; duplicate: boolean } {
  const value = trimmedMessageText(text);
  const mailbox = getChildMailbox(childThreadId);
  const retry = requestRetry(mailbox, clientRequestId, "toParent", kind, value);
  if (retry) return { message: retry, duplicate: true };
  const recent = clientRequestId === undefined ? latestMatching(mailbox, (message) => message.direction === "toParent" && message.text === value && message.kind === kind
    && (kind === "question" ? !message.answeredAt && !message.closedAt : message.state === "unread")) : undefined;
  if (recent) {
    return { message: recent, duplicate: true };
  }
  const unread = mailbox?.messages.filter((message) => message.direction === "toParent" && message.state === "unread").length ?? 0;
  if (unread >= MAX_UNREAD_FOR_PARENT) {
    throw new Error(`Your parent has ${unread} unread messages from you. Wait for it to read them, or finish your turn with a summary.`);
  }
  const pending = mailbox?.messages.filter((message) => message.direction === "toParent" && isPending(message)).length ?? 0;
  if (pending >= MAX_UNREAD_FOR_PARENT) {
    throw new Error(`Your parent has ${pending} unread updates or unanswered questions from you. Wait for answers before sending more; this message was not saved.`);
  }
  let created: ChildMailMessage | undefined;
  updateMailbox(childThreadId, rootThreadId, (box) => {
    created = {
      id: `m${box.nextSeq}`, direction: "toParent", kind, text: value, createdAt: Date.now(), state: "unread",
      ...(clientRequestId ? { clientRequestId } : {}),
    };
    return { ...box, rootThreadId, nextSeq: box.nextSeq + 1, messages: [...box.messages, created] };
  }, "work");
  return { message: created!, duplicate: false };
}

export function unreadForParent(childThreadId: string): ChildMailMessage[] {
  return getChildMailbox(childThreadId)?.messages.filter((message) => message.direction === "toParent" && message.state === "unread") ?? [];
}

/** Return unread child messages oldest-first and mark exactly those read. */
export function takeUnreadForParent(childThreadId: string, limit = 8): { messages: ChildMailMessage[]; remaining: number } {
  return takeUnreadForParentMany([{ childThreadId, limit }])[childThreadId] ?? { messages: [], remaining: 0 };
}

/**
 * Several children's unread messages in one atomic store commit, so a
 * status read serializes and notifies once rather than once per child.
 */
export function takeUnreadForParentMany(
  requests: ReadonlyArray<{ childThreadId: string; limit: number }>,
): Record<string, { messages: ChildMailMessage[]; remaining: number }> {
  const all = current();
  const result: Record<string, { messages: ChildMailMessage[]; remaining: number }> = {};
  const now = Date.now();
  let next: MailboxState | undefined;
  for (const { childThreadId, limit } of requests) {
    const mailbox = all[childThreadId];
    const unread = mailbox?.messages.filter((message) => message.direction === "toParent" && message.state === "unread") ?? [];
    const taken = unread.slice(0, Math.max(0, Math.min(MAX_UNREAD_FOR_PARENT, finiteCount(limit, 8))));
    result[childThreadId] = { messages: taken, remaining: unread.length - taken.length };
    if (!mailbox || !taken.length) continue;
    const ids = new Set(taken.map((message) => message.id));
    next ??= { ...all };
    next[childThreadId] = {
      ...mailbox,
      messages: mailbox.messages.map((message) => message.direction === "toParent" && ids.has(message.id)
        ? { ...message, state: "read" as const, ...(message.kind === "update" ? { settledAt: now } : {}) } : message),
    };
  }
  // Read metadata (settledAt) can grow serialized size slightly; trim
  // settled history once (never pending truth, never refusing the read).
  if (next) commit(trimStoreHistory(next));
  return result;
}

/** Queue guidance; keyed retries reuse retained history, unkeyed content only pending delivery. */
export function queueMessageToChild(
  childThreadId: string,
  rootThreadId: string,
  text: string,
  replyTo?: string,
  clientRequestId?: string,
): { message: ChildMailMessage; duplicate: boolean } {
  const value = trimmedMessageText(text);
  const mailbox = getChildMailbox(childThreadId);
  if (replyTo !== undefined && (typeof replyTo !== "string" || !MESSAGE_ID.test(replyTo))) {
    throw new Error(`\`${replyTo}\` is not a message this sub-agent sent you.`);
  }
  const retry = requestRetry(mailbox, clientRequestId, "toChild", "guidance", value, replyTo);
  // A retained keyed reply remains retryable even if its old answered question
  // has since been trimmed. Its payload and reference must still match exactly.
  if (retry) return { message: retry, duplicate: true };
  if (replyTo !== undefined && !mailbox?.messages.some((message) => message.id === replyTo && message.direction === "toParent")) {
    throw new Error(`\`${replyTo}\` is not a message this sub-agent sent you.`);
  }
  const recent = clientRequestId === undefined ? latestMatching(mailbox, (message) => message.direction === "toChild" && message.text === value && message.replyTo === replyTo
    && (message.state === "queued" || message.state === "delivering")) : undefined;
  if (recent) {
    return { message: recent, duplicate: true };
  }
  const queued = mailbox?.messages.filter((message) => message.direction === "toChild" && (message.state === "queued" || message.state === "delivering")).length ?? 0;
  if (queued >= MAX_QUEUED_FOR_CHILD) {
    throw new Error(`This sub-agent already has ${queued} undelivered messages. Wait for them to be delivered before sending more.`);
  }
  let created: ChildMailMessage | undefined;
  updateMailbox(childThreadId, rootThreadId, (box) => {
    created = {
      id: `m${box.nextSeq}`, direction: "toChild", kind: "guidance", text: value, createdAt: Date.now(), state: "queued",
      ...(replyTo ? { replyTo } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
    };
    return { ...box, rootThreadId, nextSeq: box.nextSeq + 1, messages: [...box.messages, created] };
  }, replyTo ? "answer" : "work");
  return { message: created!, duplicate: false };
}

export function queuedForChild(childThreadId: string): ChildMailMessage[] {
  return getChildMailbox(childThreadId)?.messages.filter((message) => message.direction === "toChild" && message.state === "queued") ?? [];
}

/**
 * The retained guidance a keyed parent retry identifies, if any. Lets a retry
 * report its real state even when the child can no longer accept new work.
 */
export function retainedMessageToChild(childThreadId: string, text: string, replyTo?: string, clientRequestId?: string): ChildMailMessage | undefined {
  if (clientRequestId === undefined) return undefined;
  return requestRetry(getChildMailbox(childThreadId), clientRequestId, "toChild", "guidance", trimmedMessageText(text), replyTo);
}

/** A child can recover its uncertain send even when new messages are refused. */
export function retainedMessageToParent(childThreadId: string, kind: "question" | "update", text: string, clientRequestId?: string): ChildMailMessage | undefined {
  if (clientRequestId === undefined) return undefined;
  return requestRetry(getChildMailbox(childThreadId), clientRequestId, "toParent", kind, trimmedMessageText(text));
}

/**
 * Compare-and-set one guidance entry. Returns false when another path already
 * moved it (for example the child pulled it while a follow-up was preparing).
 */
export function transitionChildMessage(
  childThreadId: string,
  ids: readonly string[],
  from: readonly ChildBoundState[],
  to: ChildBoundState,
  detail: { via?: ChildMailMessage["via"]; reason?: string; uncertain?: boolean; readKey?: string } = {},
): boolean {
  const mailbox = getChildMailbox(childThreadId);
  if (!mailbox || !ids.length) return false;
  const wanted = new Set(ids);
  const matching = mailbox.messages.filter((message) => message.direction === "toChild" && wanted.has(message.id));
  if (matching.length !== wanted.size || matching.some((message) => !from.includes(message.state as ChildBoundState))) return false;
  const now = Date.now();
  const settled = to !== "queued" && to !== "delivering";
  const answered = new Set(to === "delivered" ? matching.flatMap((message) => message.replyTo ? [message.replyTo] : []) : []);
  const undelivered = to === "failed" || to === "cancelled" ? Math.max(...ids.map((id) => Number(id.slice(1)))) : 0;
  // Successors already queued behind an unconfirmed delivery are not sent
  // automatically across it: they fail visibly for the parent to resolve.
  const heldAfter = to === "failed" && detail.uncertain ? Math.min(...ids.map((id) => Number(id.slice(1)))) : Infinity;
  const held = new Set(mailbox.messages.filter((message) => message.direction === "toChild" && message.state === "queued"
    && !wanted.has(message.id) && sequence(message) > heldAfter).map((message) => message.id));
  const undeliveredSeq = Math.max(undelivered, ...[...held].map((id) => Number(id.slice(1))));
  updateMailbox(childThreadId, mailbox.rootThreadId, (box) => ({
    ...box,
    ...(undeliveredSeq > (box.undeliveredSeq ?? 0) ? { undeliveredSeq } : {}),
    messages: box.messages.map((message) => message.direction === "toParent" && message.kind === "question" && answered.has(message.id)
      ? { ...message, answeredAt: now, settledAt: now }
      : held.has(message.id) && message.state === "queued" ? { ...message, state: "failed" as const, reason: HELD_REASON, settledAt: now }
      : message.direction === "toChild" && wanted.has(message.id) ? {
      ...message,
      state: to,
      // Metadata describes this state, not an earlier attempt. In particular,
      // late provider acknowledgement must clear a previous cancellation.
      via: to === "delivered" ? detail.via : undefined,
      settledAt: settled ? now : undefined,
      reason: to === "failed" || to === "cancelled" ? detail.reason?.slice(0, MAX_REASON) : undefined,
      uncertain: to === "failed" && detail.uncertain ? true : undefined,
      readKey: to === "delivered" && detail.via === "read" ? detail.readKey : undefined,
    } : message),
  }));
  return true;
}

/** Durable revision of undelivered guidance; review tokens include it. */
export function guidanceRevision(childThreadId: string): number {
  return getChildMailbox(childThreadId)?.undeliveredSeq ?? 0;
}

/**
 * Unresolved failed/cancelled guidance, oldest first. Pure: every
 * status/collect repeats it until explicit acceptance or a delivered resend
 * of the same text, so a lost response cannot hide it. `ids` lists every
 * unresolved outcome so none is undiscoverable behind the shown limit.
 * `trimmed` warns when the durable counter exceeds every retained outcome
 * (history from before outcomes were protected from trimming).
 */
export function unresolvedGuidanceOutcomes(childThreadId: string, limit = 4, offset = 0): { messages: ChildMailMessage[]; remaining: number; ids: string[]; trimmed: boolean; total: number; nextOffset?: number } {
  const mailbox = getChildMailbox(childThreadId);
  const outcomes = unresolvedOutcomeList(mailbox);
  const retainedMax = Math.max(0, ...outcomes.map(sequence));
  const trimmed = Boolean(mailbox?.undeliveredSeq && mailbox.undeliveredSeq > (mailbox.resolvedThroughSeq ?? 0)
    && mailbox.undeliveredSeq > retainedMax
    && !mailbox.messages.some((message) => sequence(message) === mailbox.undeliveredSeq));
  const start = Math.max(0, Math.floor(offset));
  const shown = outcomes.slice(start, start + Math.max(0, limit));
  const remaining = Math.max(0, outcomes.length - start - shown.length);
  return { messages: shown, remaining, ids: shown.map((message) => message.id), trimmed, total: outcomes.length,
    ...(remaining ? { nextOffset: start + shown.length } : {}) };
}

/** Explicit acceptance resolves every undelivered outcome recorded so far. */
export function resolveGuidanceOutcomes(childThreadId: string): void {
  const mailbox = getChildMailbox(childThreadId);
  if (!mailbox?.undeliveredSeq || mailbox.undeliveredSeq <= (mailbox.resolvedThroughSeq ?? 0)) return;
  updateMailbox(childThreadId, mailbox.rootThreadId, (box) => ({ ...box, resolvedThroughSeq: box.undeliveredSeq }));
}

/**
 * The single ordered deliverable prefix used by steering, pulls, follow-ups
 * and the pump: queued guidance in order, stopping at guidance still being
 * delivered (`blockedBy`). Pipe/stream writes are not model processing; this
 * only guarantees the app never submits a later message ahead of an earlier
 * one still in flight.
 */
export function deliverableGuidance(childThreadId: string): { messages: ChildMailMessage[]; blockedBy?: string } {
  const messages: ChildMailMessage[] = [];
  for (const message of getChildMailbox(childThreadId)?.messages ?? []) {
    if (message.direction !== "toChild") continue;
    if (message.state === "delivering") return { messages, blockedBy: message.id };
    if (message.state === "queued") messages.push(message);
  }
  return { messages };
}

/** Model-facing outcome of guidance that did not (or may not have) reached the child. */
export function guidanceOutcomeForModel(message: ChildMailMessage): Record<string, unknown> {
  return {
    messageId: message.id,
    state: message.state,
    delivery: message.uncertain ? "uncertain" : "not_delivered",
    ...(message.reason ? { reason: message.reason } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    excerpt: message.text.length > 200 ? `${message.text.slice(0, 200)}…` : message.text,
  };
}

/**
 * The child pulls its deliverable guidance prefix; exactly those entries
 * become delivered. A `readKey` labels the batch so a retry with the same key
 * can replay it (see {@link replayReadForChild}) after a lost response.
 */
export function takeQueuedForChild(childThreadId: string, readKey?: string, rootThreadId?: string): ChildMailMessage[] {
  if (readKey !== undefined && !CLIENT_REQUEST_ID.test(readKey)) throw new Error("replayKey must contain 1–80 ASCII letters, digits, underscores, dots, colons, or hyphens.");
  if (readKey !== undefined && hasChildReadReplay(childThreadId, readKey)) return replayReadForChild(childThreadId, readKey);
  const queued = deliverableGuidance(childThreadId).messages;
  if (!queued.length) {
    const root = getChildMailbox(childThreadId)?.rootThreadId ?? rootThreadId;
    if (readKey !== undefined && root) {
      // An empty response is still this pull's outcome. Without its receipt,
      // a lost-response retry could silently consume guidance arriving later.
      updateMailbox(childThreadId, root, (box) => ({
        ...box, emptyReadKeys: [...(box.emptyReadKeys ?? []), readKey].slice(-MAX_MAILBOX_MESSAGES),
      }), "read");
    }
    return [];
  }
  return transitionChildMessage(childThreadId, queued.map((message) => message.id), ["queued"], "delivered", { via: "read", readKey }) ? queued : [];
}

/** Distinguishes a retained empty response from a key never used here. */
export function hasChildReadReplay(childThreadId: string, readKey: string): boolean {
  return Boolean(getChildMailbox(childThreadId)?.emptyReadKeys?.includes(readKey)
    || replayReadForChild(childThreadId, readKey).length);
}

/**
 * Guidance an earlier read with this key consumed, while still retained.
 * Replays the response only; it never re-delivers or resends anything.
 */
export function replayReadForChild(childThreadId: string, readKey: string): ChildMailMessage[] {
  if (!CLIENT_REQUEST_ID.test(readKey)) return [];
  return getChildMailbox(childThreadId)?.messages.filter((message) => message.direction === "toChild"
    && message.state === "delivered" && message.via === "read" && message.readKey === readKey) ?? [];
}

/** Cancel undelivered guidance (Stop, acceptance, deletion, revoked delegation). */
export function cancelQueuedForChild(childThreadId: string, reason: string): number {
  const queued = queuedForChild(childThreadId);
  if (!queued.length) return 0;
  transitionChildMessage(childThreadId, queued.map((message) => message.id), ["queued"], "cancelled", { reason });
  return queued.length;
}

export function cancelQueuedForRoot(rootThreadId: string, reason: string): void {
  for (const [childThreadId, mailbox] of Object.entries(current())) {
    if (mailbox.rootThreadId === rootThreadId) cancelQueuedForChild(childThreadId, reason);
  }
}

/** Use only after explicit parent/user acceptance, not a child turn boundary. */
export function closeChildMailboxQuestions(childThreadId: string): void {
  const mailbox = getChildMailbox(childThreadId);
  if (!mailbox || !mailbox.messages.some((message) => message.kind === "question" && !message.answeredAt && !message.closedAt)) return;
  const now = Date.now();
  updateMailbox(childThreadId, mailbox.rootThreadId, (box) => ({
    ...box,
    messages: box.messages.map((message) => message.direction === "toParent" && message.kind === "question" && !message.answeredAt && !message.closedAt
      ? { ...message, state: "read", closedAt: now, settledAt: now } : message),
  }));
}

/** Drop a deleted conversation's mailbox. */
export function forgetChildMailbox(childThreadId: string): void {
  const all = current();
  if (!all[childThreadId]) return;
  const next = { ...all };
  delete next[childThreadId];
  commit(next);
}

/**
 * Resolve when `ready` holds or the wait elapses. Event-driven: listens to
 * store commits rather than polling.
 */
export function waitForMailbox(ready: () => boolean, timeoutMs: number, abort?: AbortSignal): Promise<boolean> {
  if (ready()) return Promise.resolve(true);
  if (timeoutMs <= 0 || abort?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      abort?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(ready()), timeoutMs);
    const unsubscribe = subscribeChildMailboxes(() => { if (ready()) finish(true); });
    abort?.addEventListener("abort", onAbort);
  });
}

/** Live counters a status row needs. */
export interface ChildMailboxSummary {
  unreadQuestions: number;
  /** Includes already-read questions until an answer is delivered or explicitly closed. */
  unansweredQuestions: number;
  unreadUpdates: number;
  queuedForChild: number;
  latestQuestion?: ChildMailMessage;
}

export function summarizeChildMailbox(mailbox: ChildMailbox | undefined): ChildMailboxSummary {
  const summary: ChildMailboxSummary = { unreadQuestions: 0, unansweredQuestions: 0, unreadUpdates: 0, queuedForChild: 0 };
  for (const message of mailbox?.messages ?? []) {
    if (message.direction === "toParent" && message.kind === "question" && !message.answeredAt && !message.closedAt) {
      summary.unansweredQuestions += 1;
      summary.latestQuestion = message;
    }
    if (message.direction === "toParent" && message.state === "unread") {
      if (message.kind === "question") {
        summary.unreadQuestions += 1;
      } else summary.unreadUpdates += 1;
    } else if (message.direction === "toChild" && (message.state === "queued" || message.state === "delivering")) {
      summary.queuedForChild += 1;
    }
  }
  return summary;
}

/** Model-facing view: no internal fields beyond what the reader can act on. */
export function mailMessageForModel(message: ChildMailMessage): Record<string, unknown> {
  return {
    id: message.id,
    kind: message.kind,
    text: message.text,
    sentAt: new Date(finiteTimestamp(message.createdAt)).toISOString(),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.textTruncated ? { textTruncated: true } : {}),
  };
}

/** Test seam. */
export function resetChildAgentMailboxes(next: MailboxState = {}): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

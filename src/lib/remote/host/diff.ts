import type { ThreadFrame, ThreadSnapshot, WireMessage } from "../wire";
import { REMOTE_RESULT_BYTES } from "../wire";
import { jsonBytes } from "./window";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function diffProjection(previous: ThreadSnapshot, next: ThreadSnapshot): ThreadFrame | null {
  if (same(previous, next)) return null;
  const frame: ThreadFrame = { status: next.status, availability: next.availability,
    activeTurnId: next.activeTurnId, assistantOutputActive: next.assistantOutputActive,
    workingStartedAt: next.workingStartedAt, error: next.error };
  const oldMessages = new Map(previous.messages.map((message) => [message.id, message]));
  const oldActivities = new Map(previous.activities.map((activity) => [activity.id, activity]));
  const reset = previous.messages.some((message) => !next.messages.some((row) => row.id === message.id))
    || previous.activities.some((activity) => !next.activities.some((row) => row.id === activity.id))
    || next.messages.some((message) => {
      const old = oldMessages.get(message.id);
      return old ? old.order !== message.order || !message.text.startsWith(old.text) : message.order < Math.max(-Infinity, ...previous.messages.map((row) => row.order), ...previous.activities.map((row) => row.order));
    })
    || next.activities.some((activity) => {
      const old = oldActivities.get(activity.id);
      return old ? old.order !== activity.order || old.detail !== activity.detail : activity.order < Math.max(-Infinity, ...previous.messages.map((row) => row.order), ...previous.activities.map((row) => row.order));
    });
  if (reset) frame.reset = { messages: next.messages, activities: next.activities };
  else {
    const upserts: WireMessage[] = [];
    const appends: { id: string; text: string }[] = [];
    for (const message of next.messages) {
      const old = oldMessages.get(message.id);
      if (old && same(old, message)) continue;
      if (old && message.text !== old.text && same({ ...old, text: message.text }, message)) appends.push({ id: message.id, text: message.text.slice(old.text.length) });
      else upserts.push(message);
    }
    if (upserts.length) frame.upsertMessages = upserts;
    if (appends.length) frame.appendMessageText = appends;
    const activities = next.activities.filter((activity) => !same(oldActivities.get(activity.id), activity));
    if (activities.length) frame.upsertActivities = activities;
  }
  if (!same(previous.approvals, next.approvals)) frame.approvals = next.approvals;
  if (!same(previous.queuedTurns, next.queuedTurns)) frame.queuedTurns = next.queuedTurns;
  if (!same(previous.history, next.history)) frame.history = next.history;
  // A reset is never larger than a bounded snapshot plus the small envelope.
  if (jsonBytes(frame) > REMOTE_RESULT_BYTES) throw new Error("Remote projection exceeded its byte budget");
  return frame;
}

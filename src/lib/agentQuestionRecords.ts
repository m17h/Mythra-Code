import type { Activity, ChatMessage } from "../types";
import { loadStored, storeValue } from "./storage";

type Answers = Record<string, string[]>;
interface QuestionRecord { threadId: string; message?: ChatMessage; answers?: Answers }
const STORAGE_KEY = "kiwi.agentQuestions";
const recordKey = (threadId: string, messageId: string) => JSON.stringify([threadId, messageId]);
const records = () => loadStored<Record<string, QuestionRecord>>(STORAGE_KEY, {});

// RPC questions are not part of the runtime's saved transcript. Keep their
// presentation and answer acknowledgements in one hydrated, removable store.
export function saveQuestionRequest(threadId: string, message: ChatMessage): void {
  const current = records();
  const key = recordKey(threadId, message.id);
  storeValue(STORAGE_KEY, { ...current, [key]: { ...current[key], threadId, message } });
}

export function savedQuestionAnswers(threadId: string, messageId: string): Answers | null {
  return records()[recordKey(threadId, messageId)]?.answers ?? null;
}

export function saveQuestionAnswers(threadId: string, messageId: string, answers: Answers): void {
  const current = records();
  const key = recordKey(threadId, messageId);
  storeValue(STORAGE_KEY, { ...current, [key]: { ...current[key], threadId, answers } });
}

export function forgetQuestionRecords(threadId: string): void {
  const current = records();
  const retained = Object.fromEntries(Object.entries(current).filter(([, record]) => record.threadId !== threadId));
  if (Object.keys(retained).length !== Object.keys(current).length) storeValue(STORAGE_KEY, retained);
}

export function restoreQuestionRequests(threadId: string, messages: ChatMessage[], activities: Activity[], completeHistory = false): ChatMessage[] {
  const ids = new Set(messages.map((message) => message.id));
  const turnEnds = new Map<string, number>();
  let end = 0;
  for (const entry of [...messages, ...activities]) {
    end = Math.max(end, entry.timelineOrder ?? 0);
    if (entry.turnId) turnEnds.set(entry.turnId, Math.max(turnEnds.get(entry.turnId) ?? 0, entry.timelineOrder ?? 0));
  }
  const missing = Object.values(records()).flatMap((record) => record.threadId === threadId && record.message
    && !ids.has(record.message.id) && (completeHistory || (record.message.turnId && turnEnds.has(record.message.turnId))) ? [record.message] : []);
  if (!missing.length) return messages;
  return [...messages, ...missing.map((message, index) => ({ ...message,
    // Place recovered RPC forms after their own turn, before the next turn.
    timelineOrder: (turnEnds.get(message.turnId ?? "") ?? end) + (index + 1) / (missing.length + 1),
  }))].sort((left, right) => (left.timelineOrder ?? 0) - (right.timelineOrder ?? 0));
}

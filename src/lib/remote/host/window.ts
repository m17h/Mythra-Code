import type { Activity, ChatMessage } from "../../../types";
import type { ThreadTaskState } from "../../taskStore";
import { REMOTE_DEFAULT_ROWS, REMOTE_MAX_ROWS, REMOTE_WINDOW_BYTES, type ThreadReadResult, type ThreadSnapshot, type WireAvailability } from "../wire";
import { projectActivity, projectApprovals, projectMessage, projectQueue, projectState } from "./projection";
import { HostReadError } from "./scope";

const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }
export function rowLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.max(1, Math.min(REMOTE_MAX_ROWS, value)) : REMOTE_DEFAULT_ROWS;
}
export interface SourceRow { kind: "message" | "activity"; entry: ChatMessage | Activity; order: number }
export function sourceRows(task: ThreadTaskState): SourceRow[] {
  return [
    ...task.messages.map((entry, index): SourceRow => ({ kind: "message", entry, order: entry.timelineOrder ?? index * 2 })),
    ...task.activities.map((entry, index): SourceRow => ({ kind: "activity", entry, order: entry.timelineOrder ?? index * 2 + 1 })),
  ].sort((left, right) => left.order - right.order || left.entry.id.localeCompare(right.entry.id));
}
interface Anchor { threadId: string; id: string; kind: SourceRow["kind"]; touched: number }
/** Opaque cursors contain no native pagination token or filesystem identity. */
export class HostWindows {
  private anchors = new Map<string, Anchor>();
  clear(): void { this.anchors.clear(); }
  anchor(threadId: string, cursor?: string): Anchor | undefined {
    if (!cursor) return undefined;
    const anchor = this.anchors.get(cursor);
    if (!anchor || anchor.threadId !== threadId || Date.now() - anchor.touched > 15 * 60_000) {
      throw new HostReadError("stale_target", "This history page has expired. Refresh the conversation.");
    }
    anchor.touched = Date.now();
    return anchor;
  }
  private cursor(threadId: string, row: SourceRow): string {
    for (const [key, anchor] of this.anchors) {
      if (anchor.threadId === threadId && anchor.id === row.entry.id && anchor.kind === row.kind) { anchor.touched = Date.now(); return key; }
    }
    while (this.anchors.size >= 1024) this.anchors.delete(this.anchors.keys().next().value!);
    const key = crypto.randomUUID();
    this.anchors.set(key, { threadId, id: row.entry.id, kind: row.kind, touched: Date.now() });
    return key;
  }
  snapshot(threadId: string, task: ThreadTaskState, availability: WireAvailability, limit = REMOTE_DEFAULT_ROWS): ThreadSnapshot {
    const state: ThreadSnapshot = { ...projectState(task, availability), messages: [], activities: [],
      approvals: projectApprovals(task), queuedTurns: projectQueue(task), history: { hasMore: false } };
    const rows = this.page(threadId, task, undefined, limit, jsonBytes(state));
    return { ...state, ...rows };
  }
  page(threadId: string, task: ThreadTaskState, before?: string, limit = REMOTE_DEFAULT_ROWS, overhead = 0): ThreadReadResult {
    const anchor = this.anchor(threadId, before);
    const all = sourceRows(task);
    const end = anchor ? all.findIndex((row) => row.entry.id === anchor.id && row.kind === anchor.kind) : all.length;
    if (end < 0) throw new HostReadError("stale_target", "History changed. Refresh the conversation.");
    const selected: Array<{ row: SourceRow; value: ReturnType<typeof projectMessage> | ReturnType<typeof projectActivity> }> = [];
    let bytes = overhead + 2048;
    for (let index = end - 1; index >= 0 && selected.length < rowLimit(limit); index -= 1) {
      const row = all[index];
      const value = row.kind === "message" ? projectMessage(threadId, row.entry as ChatMessage, row.order) : projectActivity(row.entry as Activity, row.order);
      const size = jsonBytes(value) + 2;
      if (bytes + size > REMOTE_WINDOW_BYTES) break;
      bytes += size;
      selected.unshift({ row, value });
    }
    const first = selected[0]?.row;
    const hasMore = end > selected.length || task.history.hasMore;
    return {
      messages: selected.flatMap(({ row, value }) => row.kind === "message" ? [value as ReturnType<typeof projectMessage>] : []),
      activities: selected.flatMap(({ row, value }) => row.kind === "activity" ? [value as ReturnType<typeof projectActivity>] : []),
      history: { hasMore, ...(hasMore && first ? { cursor: this.cursor(threadId, first) } : {}) },
    };
  }
}

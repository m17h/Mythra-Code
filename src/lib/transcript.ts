import type { Activity, ChatMessage } from "../types";

function mergeById<T extends { id: string; timelineOrder?: number }>(
  durable: T[],
  live: T[],
): T[] {
  const merged = new Map(durable.map((entry) => [entry.id, entry]));
  for (const entry of live) merged.set(entry.id, entry);
  return [...merged.values()].sort(
    (left, right) => (left.timelineOrder ?? Number.MAX_SAFE_INTEGER) - (right.timelineOrder ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Combine complete durable history with fresher in-memory streaming state. */
export function mergeTranscriptHistory(
  durableMessages: ChatMessage[],
  durableActivities: Activity[],
  liveMessages: ChatMessage[],
  liveActivities: Activity[],
): { messages: ChatMessage[]; activities: Activity[] } {
  return {
    messages: mergeById(durableMessages, liveMessages),
    activities: mergeById(durableActivities, liveActivities),
  };
}

/**
 * Renders a thread as portable Markdown for export. Ordering matches the
 * timeline (ascending timelineOrder, messages before activities on ties).
 */
export function buildTranscriptMarkdown(label: string, messages: ChatMessage[], activities: Activity[]): string {
  const entries = [
    ...messages.map((value) => ({ kind: "message" as const, order: value.timelineOrder ?? Number.MAX_SAFE_INTEGER, value })),
    ...activities.map((value) => ({ kind: "activity" as const, order: value.timelineOrder ?? Number.MAX_SAFE_INTEGER, value })),
  ].sort((left, right) => left.order - right.order || (left.kind === "message" ? 0 : 1) - (right.kind === "message" ? 0 : 1));

  const lines: string[] = [`# ${label}`, "", `_Exported from Mythra Code on ${new Date().toLocaleString()}_`, ""];
  for (const entry of entries) {
    if (entry.kind === "message") {
      const message = entry.value as ChatMessage;
      lines.push(`## ${message.role === "user" ? "You" : "Assistant"}`, "", message.text.trim(), "");
      continue;
    }
    const activity = entry.value as Activity;
    if (activity.kind === "reasoning") {
      lines.push("<details><summary>Model thinking</summary>", "", activity.detail?.trim() ?? "", "", "</details>", "");
      continue;
    }
    lines.push(`> **${activity.kind}** — ${activity.title}${activity.status ? ` _(${activity.status})_` : ""}`);
    if (activity.detail) {
      lines.push(">", "> ```", ...activity.detail.trim().split("\n").map((line) => `> ${line}`), "> ```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

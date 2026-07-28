import type { Activity, ChatMessage, ThreadItem, Turn } from "../types";

export interface ThreadTimelineSnapshot {
  messages: ChatMessage[];
  activities: Activity[];
}

function userText(item: ThreadItem): string {
  return (item.content ?? [])
    .filter((content): content is { type: string; text?: string } => typeof content !== "string" && content.type === "text")
    .map((content) => content.text ?? "")
    .join("\n");
}

function activityFromItem(item: ThreadItem, id: string, timelineOrder: number, turnId: string, turnStatus: Turn["status"]): Activity | null {
  if (item.type === "commandExecution") {
    return { id, kind: "command", title: item.command ?? "Run command", detail: item.aggregatedOutput ?? item.cwd, status: item.status, timelineOrder, turnId, turnStatus };
  }
  if (item.type === "fileChange") {
    return { id, kind: "file", title: `${item.changes?.length ?? 0} file change${item.changes?.length === 1 ? "" : "s"}`, itemCount: item.changes?.length, status: item.status, timelineOrder, turnId, turnStatus };
  }
  if (item.type === "reasoning") {
    const content = (item.content ?? []).filter((entry): entry is string => typeof entry === "string").join("\n\n").trim();
    const summary = (item.summary ?? []).join("\n\n").trim();
    const detail = content || summary;
    if (detail) return { id, kind: "reasoning", title: "Model thinking", detail, status: "completed", timelineOrder, turnId, turnStatus };
  }
  if (item.type === "collabAgentToolCall") {
    const titles: Record<string, string> = {
      spawnAgent: `Spawn sub-agent${item.receiverThreadIds?.length === 1 ? "" : "s"}`,
      sendInput: "Send input to sub-agent",
      resumeAgent: "Resume sub-agent",
      wait: "Wait for sub-agents",
      closeAgent: "Close sub-agent",
    };
    return { id, kind: "agent", title: titles[item.tool ?? ""] ?? "Sub-agent activity", detail: item.prompt ?? undefined, status: item.status, timelineOrder, turnId, turnStatus };
  }
  if (item.type === "subAgentActivity") {
    const action = item.kind === "started" ? "started" : item.kind === "interrupted" ? "interrupted" : "working";
    return { id, kind: "agent", title: `Sub-agent ${action}`, detail: item.agentPath || item.agentThreadId, status: item.kind, timelineOrder, turnId, turnStatus };
  }
  return null;
}

export function timelineFromTurns(turns: Turn[] = []): ThreadTimelineSnapshot {
  const messages: ChatMessage[] = [];
  const activities: Activity[] = [];
  let timelineOrder = 0;

  for (const turn of turns) {
    const turnStatus = turn.status ?? "completed";
    turn.items.forEach((item, itemIndex) => {
      const order = ++timelineOrder;
      const id = item.id ?? `${turn.id}-${itemIndex}`;
      if (item.type === "userMessage") {
        messages.push({ id, role: "user", text: userText(item), timelineOrder: order, turnId: turn.id, turnStatus });
        return;
      }
      if (item.type === "agentMessage" || item.type === "plan") {
        messages.push({ id, role: "assistant", text: item.text ?? "", timelineOrder: order, turnId: turn.id, turnStatus });
        return;
      }
      const activity = activityFromItem(item, id, order, turn.id, turnStatus);
      if (activity) activities.push(activity);
    });
  }

  return { messages, activities };
}

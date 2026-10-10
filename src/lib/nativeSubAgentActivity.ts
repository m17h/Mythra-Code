import type { Activity, ThreadItem } from "../types";

type NativeSubAgentPresentation = Pick<Activity, "kind" | "title" | "detail" | "status" | "agent">;

/**
 * Give every concrete Codex child lifecycle item the same structured metadata
 * used by Mythra Code-owned and Claude-native spawns. Codex can report a native
 * child as `subAgentActivity` without also emitting a `spawnAgent` tool call,
 * so treating these as generic status rows makes the Relay UI provider-
 * dependent and causes restored transcripts to disagree with live ones.
 */
export function nativeSubAgentPresentation(item: ThreadItem): NativeSubAgentPresentation {
  const titles: Record<string, string> = { started: "started", interrupted: "interrupted", completed: "completed", failed: "failed", errored: "failed" };
  const action = titles[item.kind ?? ""] ?? "working";
  const identity = item.agentPath?.trim() || item.agentThreadId?.trim() || "Delegated task";

  return {
    kind: "agent",
    title: `Sub-agent ${action}`,
    detail: identity,
    status: item.kind,
    agent: {
      action: "spawn",
      provider: "openai",
      ...(item.agentModel ? { model: item.agentModel } : {}),
      count: 1,
      ...(item.agentThreadId ? { threadIds: [item.agentThreadId] } : {}),
    },
  };
}

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChildAgentPolicy } from "./childAgents";
import { childAgentSessionOptions } from "./childAgents";

/**
 * Front-end half of the cross-provider sub-agent bridge. The backend owns the
 * loopback endpoint and its tokens; nothing secret crosses this boundary — a
 * launch descriptor is only an executable path plus a session-file path.
 */

export type ChildAgentTool = "spawn_mythra_agent" | "agent_status" | "collect_agent" | "cancel_agent" | "propose_agent_settings";

/** How a provider runtime should register the bridge as an MCP server. */
export interface ChildAgentBridgeLaunch {
  name: string;
  command: string;
  args: string[];
  /** Ready-made `{"mcpServers":{…}}` file for CLIs that take a config path. */
  configPath: string;
  toolNames: string[];
}

export interface ChildAgentRequest {
  requestId: string;
  sessionId: string;
  tool: ChildAgentTool;
  arguments: Record<string, unknown>;
}

export async function startChildAgentSession(
  policy: ChildAgentPolicy,
  knownChildren: string[] = [],
): Promise<ChildAgentBridgeLaunch> {
  return invoke<ChildAgentBridgeLaunch>("child_agent_session_start", {
    options: childAgentSessionOptions(policy, knownChildren),
  });
}

export async function endChildAgentSession(sessionId: string): Promise<void> {
  await invoke("child_agent_session_end", { sessionId });
}

export async function respondToChildAgentRequest(
  requestId: string,
  result: Record<string, unknown> | null,
  error?: string,
): Promise<void> {
  await invoke("child_agent_respond", { requestId, result, error: error ?? null });
}

/** Release a child's concurrency slot once its turn reaches a terminal state. */
export async function reportChildAgentFinished(sessionId: string, childThreadId: string): Promise<void> {
  await invoke("child_agent_finished", { sessionId, childThreadId });
}

export function onChildAgentRequest(handler: (request: ChildAgentRequest) => void): Promise<UnlistenFn> {
  return listen<ChildAgentRequest>("child-agent-request", ({ payload }) => handler(payload));
}

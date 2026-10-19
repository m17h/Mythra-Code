import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChildAgentPolicy } from "./childAgents";
import { childAgentSessionOptions } from "./childAgents";
import type { PermissionMode, Provider, SubagentModelGuidance } from "../types";

/**
 * Front-end half of the cross-provider sub-agent bridge. The backend owns the
 * loopback endpoint and its tokens; nothing secret crosses this boundary — a
 * launch descriptor is only an executable path plus a session-file path.
 */

export type ChildAgentTool = "spawn_mythra_agent" | "agent_status" | "collect_agent" | "cancel_agent" | "send_agent_message" | "accept_agent" | "message_parent" | "read_parent_messages" | "propose_agent_settings" | "set_project_run_command" | "set_project_check_command" | "read_project_terminal" | "language_tools_status" | "install_language_tool" | "language_tool_query";

export interface ProjectBridgeContext {
  projectPath?: string;
  permission: PermissionMode;
  provider?: Provider;
  childThread?: boolean;
  /** V2 owned child: grants only its parent mailbox tools, captured at spawn. */
  parentMessaging?: boolean;
  /** Native delegation retains project tools, never Mythra spawning/crew proposals. */
  nativeDelegation?: boolean;
}

/** How a provider runtime should register the bridge as an MCP server. */
export interface ChildAgentBridgeLaunch {
  /** Opaque registration generation; safe to share, unlike the private token. */
  registrationId: string;
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
  /** Backend registration that admitted this request. Rotation revokes it. */
  registrationId: string;
  tool: ChildAgentTool;
  arguments: Record<string, unknown>;
  /** Backend-owned execution folder; a model cannot supply or override it. */
  terminalScope?: string;
}

export async function startChildAgentSession(
  policy: ChildAgentPolicy,
  knownChildren: string[] = [],
  finishedChildren: string[] = [],
  projectContext?: ProjectBridgeContext,
  /** Notes already narrowed to this crew; only a managed root carries them. */
  modelGuidance: SubagentModelGuidance[] = [],
): Promise<ChildAgentBridgeLaunch> {
  const guidance = projectContext?.childThread || projectContext?.nativeDelegation ? [] : modelGuidance;
  return invoke<ChildAgentBridgeLaunch>("child_agent_session_start", {
    options: {
      ...childAgentSessionOptions(policy, knownChildren),
      ...(guidance.length ? { modelGuidance: guidance.map(({ provider, model, note }) => ({ provider, model, note })) } : {}),
      finishedChildren,
      permission: policy.permission,
      ...projectContext,
      // Root conversations and child mailbox authority are separate scopes.
      collaborationV2: policy.collaborationV2 === true
        && !projectContext?.childThread && !projectContext?.nativeDelegation,
    },
  });
}

export async function endChildAgentSession(sessionId: string): Promise<void> {
  await invoke("child_agent_session_end", { sessionId });
}

/** Revoke only a V2 root's tool registration, retaining its child slot lifetime. */
export function revokeChildAgentRootRegistration(sessionId: string, registrationId?: string): Promise<boolean> {
  return invoke<boolean>("child_agent_revoke_root_registration", { sessionId, registrationId: registrationId ?? null });
}

/**
 * A queued renderer request cannot retain authority after bridge rotation.
 * The exact relay id lets the backend also refuse an expired/answered relay.
 */
export function isChildAgentRequestActive(request: ChildAgentRequest): Promise<boolean> {
  return invoke<boolean>("child_agent_request_active", {
    sessionId: request.sessionId,
    registrationId: request.registrationId,
    requestId: request.requestId,
  });
}

/** Adopt one exact initial-spawn reservation before requesting provider work. */
export function claimChildAgentSpawn(request: ChildAgentRequest, childThreadId: string): Promise<void> {
  return invoke<void>("child_agent_claim_spawn", {
    sessionId: request.sessionId,
    registrationId: request.registrationId,
    requestId: request.requestId,
    childThreadId,
  });
}

/** A durable provisional child the renderer can associate with its initial relay. */
export interface UnclaimedSpawnCandidate {
  requestId: string;
  sessionId: string;
  registrationId?: string;
  childThreadId: string;
}

export interface RetiredSpawnReceipt {
  requestId: string;
  sessionId: string;
  registrationId?: string;
  childThreadId?: string;
  /** A bounded backend receipt replayed for an earlier retirement. */
  replayed?: boolean;
}

export interface PreservedSpawn {
  requestId: string;
  sessionId: string;
  childThreadId: string;
  /** `not_pending` is unknown, never proof of either outcome. */
  reason: "claimed" | "not_pending" | "identity_mismatch";
}

function text(value: unknown, limit = 200): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= limit ? value : undefined;
}

/**
 * Renderer replacement retires only requests that never claimed a child, and
 * reports exact receipts so a matching never-started provisional child can
 * settle instead of staying unknown.
 */
export async function retireUnclaimedChildAgentSpawns(candidates: UnclaimedSpawnCandidate[] = []): Promise<{ retired: RetiredSpawnReceipt[]; preserved: PreservedSpawn[] }> {
  const result = await invoke<unknown>("child_agent_retire_unclaimed_spawns", { candidates });
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const retired = (Array.isArray(record.retired) ? record.retired : []).flatMap((entry): RetiredSpawnReceipt[] => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const requestId = text(item.requestId);
    const sessionId = text(item.sessionId);
    if (!requestId || !sessionId) return [];
    return [{ requestId, sessionId, ...(text(item.registrationId) ? { registrationId: text(item.registrationId) } : {}),
      ...(text(item.childThreadId) ? { childThreadId: text(item.childThreadId) } : {}), ...(item.replayed === true ? { replayed: true } : {}) }];
  });
  const preserved = (Array.isArray(record.preserved) ? record.preserved : []).flatMap((entry): PreservedSpawn[] => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const requestId = text(item.requestId);
    const sessionId = text(item.sessionId);
    const childThreadId = text(item.childThreadId);
    const reason = item.reason === "claimed" || item.reason === "not_pending" || item.reason === "identity_mismatch" ? item.reason : undefined;
    return requestId && sessionId && childThreadId && reason ? [{ requestId, sessionId, childThreadId, reason }] : [];
  });
  return { retired, preserved };
}

export async function respondToChildAgentRequest(
  requestId: string,
  result: Record<string, unknown> | null,
  error?: string,
): Promise<void> {
  await invoke("child_agent_respond", { requestId, result, error: error ?? null });
}

/**
 * Release a child's concurrency slot once its turn reaches a terminal state.
 * A follow-up turn carries the activation token its reservation returned; a
 * missing or older token can never release a newer follow-up's slot.
 */
export async function reportChildAgentFinished(sessionId: string, childThreadId: string, activationId?: string): Promise<void> {
  await invoke("child_agent_finished", { sessionId, childThreadId, activationId: activationId ?? null });
}

/**
 * Take a live concurrency slot for an idle owned child's follow-up turn. The
 * backend refuses when the parent's budget is full, its session is gone, or
 * the child still holds a slot. Resolves with the activation token that
 * alone can release this reservation.
 */
export async function reactivateChildAgent(sessionId: string, childThreadId: string): Promise<string> {
  const result = await invoke<{ activationId?: unknown }>("child_agent_reactivate", { sessionId, childThreadId });
  if (typeof result?.activationId !== "string" || !result.activationId) {
    throw new Error("Mythra Code did not return a sub-agent activation token.");
  }
  return result.activationId;
}

export function onChildAgentRequest(handler: (request: ChildAgentRequest) => void): Promise<UnlistenFn> {
  return listen<ChildAgentRequest>("child-agent-request", ({ payload }) => handler(payload));
}

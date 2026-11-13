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

export type ChildAgentTool = "spawn_mythra_agent" | "agent_status" | "collect_agent" | "cancel_agent" | "send_agent_message" | "accept_agent" | "message_parent" | "read_parent_messages" | "propose_agent_settings" | "set_project_run_command" | "set_project_check_command" | "read_project_terminal" | "get_commit_message_context" | "set_commit_message" | "language_tools_status" | "install_language_tool" | "language_tool_query";

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

/** Durable child ownership used only when rebuilding a lost native session. */
export interface RecoveredChildAgent {
  childId: string;
  targetId?: string;
  provider?: Provider;
  model?: string;
  activationId?: string;
  retiringActivationIds?: string[];
  uncertainActivationIds?: string[];
  active: boolean;
}

export async function startChildAgentSession(
  policy: ChildAgentPolicy,
  knownChildren: string[] = [],
  finishedChildren: string[] = [],
  projectContext?: ProjectBridgeContext,
  /** Notes already narrowed to this crew; only a managed root carries them. */
  modelGuidance: SubagentModelGuidance[] = [],
  recoveredChildren: RecoveredChildAgent[] = [],
): Promise<ChildAgentBridgeLaunch> {
  const guidance = projectContext?.childThread || projectContext?.nativeDelegation ? [] : modelGuidance;
  return invoke<ChildAgentBridgeLaunch>("child_agent_session_start", {
    options: {
      ...childAgentSessionOptions(policy, knownChildren),
      ...(guidance.length ? { modelGuidance: guidance.map(({ provider, model, note }) => ({ provider, model, note })) } : {}),
      finishedChildren,
      recoveredChildren,
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
 * A follow-up turn carries its activation token; a missing or older token can
 * never release a newer follow-up's slot. With a token, success also means the
 * backend retired that exact attempt: it holds no slot, and a late admission
 * of it is refused, whether or not it had been admitted.
 */
export async function reportChildAgentFinished(sessionId: string, childThreadId: string, activationId?: string): Promise<boolean> {
  const result = await waitForReservationReply(
    invoke<{ released?: unknown } | null>("child_agent_finished", { sessionId, childThreadId, activationId: activationId ?? null }),
  );
  if (typeof result?.released !== "boolean") {
    throw new Error("Mythra Code did not confirm this exact sub-agent reservation was released.");
  }
  // Whether a slot was freed by this call; false is still a settled release.
  return result.released;
}

/** The caller must retain guidance and retire its token before another admission. */
export class ChildAgentAdmissionUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildAgentAdmissionUnconfirmedError";
  }
}

/**
 * Bound only bridge accounting IPC, never a provider request. Giving up this
 * wait cannot cancel native admission; the caller retains the exact token
 * until retirement is acknowledged. A late reply has no continuation that
 * could dispatch a prompt or reopen the retired attempt.
 */
function waitForReservationReply<T>(request: Promise<T>, signal?: AbortSignal, timeoutReason?: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { reason: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if ("reason" in result) reject(result.reason);
      else resolve(result.value);
    };
    const abort = () => finish({ reason: new Error("The sub-agent reservation wait was cancelled before provider dispatch.") });
    const timer = setTimeout(() => finish({ reason: timeoutReason?.()
      ?? new Error("The sub-agent reservation confirmation timed out; its exact token remains owned until release is confirmed.") }), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    // Attach both handlers even after cancellation: a late native failure
    // must be observed, but its result must never resume the caller.
    request.then((value) => finish({ value }), (reason: unknown) => finish({ reason }));
    if (signal?.aborted) abort();
  });
}

/**
 * Take a live concurrency slot for an idle owned child's follow-up turn. The
 * backend refuses when the parent's budget is full, its session is gone, the
 * child still holds a slot, or the child's own worker slot is busy, removed,
 * or now runs a different provider/model. `slot` is the child's durable,
 * spawn-time destination identity; a slot the backend recorded wins.
 *
 * `activationId` is chosen and durably persisted by the caller before this
 * call, so a lost or malformed reply never strands an admission: releasing
 * that same token always settles it. Never retry this call blindly; any
 * failure is settled by releasing the token instead.
 */
export async function reactivateChildAgent(
  sessionId: string,
  childThreadId: string,
  slot: { targetId: string; provider: Provider; model: string },
  activationId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("The sub-agent reservation wait was cancelled before provider dispatch.");
  const result = await waitForReservationReply(invoke<{ activationId?: unknown }>("child_agent_reactivate", {
    sessionId, childThreadId, targetId: slot.targetId, provider: slot.provider, model: slot.model, activationId,
  }), signal, () => new ChildAgentAdmissionUnconfirmedError("The sub-agent activation acknowledgement timed out. No instruction was sent; its exact reservation must be released first."));
  if (result?.activationId !== activationId) {
    throw new ChildAgentAdmissionUnconfirmedError("Mythra Code did not confirm this sub-agent activation. No instruction was sent; its exact reservation must be released first.");
  }
}

export function onChildAgentRequest(handler: (request: ChildAgentRequest) => void): Promise<UnlistenFn> {
  return listen<ChildAgentRequest>("child-agent-request", ({ payload }) => handler(payload));
}

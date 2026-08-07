import {
  endChildAgentSession,
  startChildAgentSession,
  type ChildAgentBridgeLaunch,
} from "./agentBridge";
import {
  childAgentPolicyFor,
  childAgentPolicyForThread,
  type ChildAgentLink,
  type ChildAgentPolicy,
  type ChildAgentReadiness,
} from "./childAgents";
import type { AppSettings, PermissionMode } from "../types";

/**
 * Owns the lifetime of a root thread's delegation bridge.
 *
 * A thread's approved destinations are decided exactly once — when its first
 * turn starts — and reused verbatim for every later turn, so a settings change
 * mid-conversation can never silently re-point the children a running plan
 * depends on. Providers that spawn a fresh process per turn (Claude, Cursor)
 * therefore get the same launch descriptor every time.
 */

/** Launch descriptors for sessions registered during this app session. */
const launches = new Map<string, ChildAgentBridgeLaunch>();
/** Immediate policy view for bridge requests that race React persistence. */
const activePolicies = new Map<string, ChildAgentPolicy>();

/** Test seam and reload guard: drop every cached descriptor. */
export function resetChildAgentLaunches(): void {
  launches.clear();
  activePolicies.clear();
}

export function cacheChildAgentPolicy(policy: ChildAgentPolicy): void {
  activePolicies.set(policy.sessionId, policy);
}

export function childAgentPolicyForSession(
  policies: Record<string, ChildAgentPolicy>,
  sessionId: string,
): ChildAgentPolicy | undefined {
  return activePolicies.get(sessionId) ?? policies[sessionId];
}

export interface ChildAgentBridgeInput {
  /** The thread this turn belongs to; absent for a brand-new conversation. */
  threadId?: string;
  policies: Record<string, ChildAgentPolicy>;
  links: Record<string, ChildAgentLink>;
  settings: Pick<AppSettings, "childAgents" | "subagentsEnabled" | "subagentMax">;
  permission: PermissionMode;
  systemPrompt: string;
  projectInstructionsEnabled: boolean;
  reasoningEffort: ChildAgentPolicy["reasoningEffort"];
  serviceTier: string | null;
  readiness: ChildAgentReadiness;
  newSessionId?: () => string;
}

export interface ChildAgentBridgeResult {
  policy: ChildAgentPolicy;
  launch: ChildAgentBridgeLaunch;
  /** True when this call captured the policy, so the caller must persist it. */
  captured: boolean;
}

/**
 * Resolve the bridge a turn should start with, or null when this thread must
 * not be able to delegate across providers. Returns null — never throws — for
 * a thread that is itself a child, which is what keeps depth at one.
 */
export async function ensureChildAgentBridge(
  input: ChildAgentBridgeInput,
): Promise<ChildAgentBridgeResult | null> {
  if (input.threadId && input.links[input.threadId]) return null;

  const existing = childAgentPolicyForThread(input.policies, input.threadId);
  // Delegation capabilities are immutable once a conversation exists. This
  // also keeps pre-feature threads honest: they never started with the MCP
  // bridge, so they cannot acquire it silently on a later turn.
  if (input.threadId && !existing) return null;
  const policy = existing ?? childAgentPolicyFor({
    sessionId: (input.newSessionId ?? (() => crypto.randomUUID()))(),
    rootThreadId: input.threadId,
    childAgents: input.settings.childAgents,
    subagentsEnabled: input.settings.subagentsEnabled,
    subagentMax: input.settings.subagentMax,
    permission: input.permission,
    systemPrompt: input.systemPrompt,
    projectInstructionsEnabled: input.projectInstructionsEnabled,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    readiness: input.readiness,
  });
  if (!policy) return null;
  cacheChildAgentPolicy(policy);

  const cached = launches.get(policy.sessionId);
  if (cached) return { policy, launch: cached, captured: false };

  // Re-seed the children this thread already owns so a session rebuilt after a
  // restart still recognises them for collect/cancel.
  const knownChildren = Object.values(input.links)
    .filter((link) => policy.rootThreadId && link.rootThreadId === policy.rootThreadId)
    .map((link) => link.childThreadId);
  const launch = await startChildAgentSession(policy, knownChildren);
  launches.set(policy.sessionId, launch);
  return { policy, launch, captured: !existing };
}

/** Tear down every bridge session belonging to a thread. */
export async function releaseChildAgentSessions(
  policies: Record<string, ChildAgentPolicy>,
  threadId: string,
): Promise<string[]> {
  const released: string[] = [];
  for (const policy of Object.values(policies)) {
    if (policy.rootThreadId !== threadId) continue;
    released.push(policy.sessionId);
    await releaseChildAgentSession(policy.sessionId);
  }
  return released;
}

/** Drop one provisional or attached bridge session. */
export async function releaseChildAgentSession(sessionId: string): Promise<void> {
  launches.delete(sessionId);
  activePolicies.delete(sessionId);
  await endChildAgentSession(sessionId).catch(() => undefined);
}

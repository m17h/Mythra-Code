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
 * Two rules, and they pull in different directions on purpose:
 *
 * - *Destinations are frozen.* The approved set is decided once — on the first
 *   turn where cross-provider sub-agents are available — and reused verbatim
 *   afterwards, so a settings change mid-conversation can never re-point the
 *   children a running plan depends on. Providers that spawn a fresh process
 *   per turn (Claude, Cursor) therefore get the same launch descriptor every
 *   time.
 * - *The switch is live.* Whether that frozen roster is reachable at all
 *   follows the current sub-agent settings on every turn. A user who enables
 *   sub-agents several messages into a conversation gets them on the very next
 *   run, and a user who switches them off loses them just as promptly — the
 *   backend session is torn down rather than merely left unmentioned, because
 *   a provider whose runtime thread outlives a turn still has the bridge
 *   registered as an MCP server.
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
  // Depth one, decided before anything the settings could say: a thread that
  // is itself a child never receives a bridge.
  if (input.threadId && input.links[input.threadId]) return null;

  const existing = childAgentPolicyForThread(input.policies, input.threadId);
  // The switch is read fresh every turn, in both directions. Switching
  // sub-agents (or cross-provider delegation) off has to remove the powers a
  // thread already holds, not just decline to hand out new ones.
  //
  // Ending the backend session is the authoritative revocation: it invalidates
  // the session token, so a bridge process a provider runtime is still holding
  // open can no longer reach the app even if that runtime never drops its MCP
  // server registration. The policy record itself is kept, so switching
  // delegation back on restores the very same frozen destinations. Asking the
  // backend unconditionally also closes a reload-shaped gap: the renderer can
  // reload without the Tauri process being replaced, which empties the maps
  // above while leaving a registered bridge alive in Rust.
  if (!input.settings.subagentsEnabled || !input.settings.childAgents.enabled) {
    if (existing) await releaseChildAgentSession(existing.sessionId);
    return null;
  }

  // An existing thread with no policy has never run with a cross-provider
  // roster available — either it predates the feature or the user had that
  // feature switched off. It may capture one now: the composer shows the
  // roster it would capture, so nothing is acquired silently.
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

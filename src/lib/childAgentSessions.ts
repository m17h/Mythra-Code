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
 * - *Destinations are turn-boundary atomic.* The approved set is reused while
 *   work is active. A direct user edit is staged while idle and promoted only
 *   when the next prompt starts, so no running plan can be re-pointed midway.
 *   Providers that spawn a fresh process per turn (Claude, Cursor) therefore
 *   receive one internally consistent launch descriptor for each turn.
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

/** Queue a fresh launch for the next root turn without revoking the bridge
 * that the currently-running parent still needs to collect its children. */
export function invalidateChildAgentLaunch(sessionId: string): void {
  launches.delete(sessionId);
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
  /** Includes provider-native ownership, which is stored separately from bridge links. */
  isChildThread?: boolean;
  settings: Pick<AppSettings, "childAgents" | "subagentsEnabled" | "subagentMax">;
  permission: PermissionMode;
  systemPrompt: string;
  providerSystemPrompts?: Partial<Record<"openai" | "claude", string>>;
  projectInstructionsEnabled: boolean;
  reasoningEffort: ChildAgentPolicy["reasoningEffort"];
  serviceTier: string | null;
  readiness: ChildAgentReadiness;
  /** Saved projects keep a proposal-only bridge even while delegation is off. */
  settingsProposalsEnabled?: boolean;
  /** Only an actual prompt may consume a thread-local staged crew edit. */
  promoteStagedEdits?: boolean;
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
  if (input.isChildThread || (input.threadId && input.links[input.threadId])) return null;

  const persistedStored = childAgentPolicyForThread(input.policies, input.threadId);
  // A composer edit can be followed by Send before React persistence renders.
  // Prefer an immediately staged record once storage identifies the session.
  // Other cached policies (notably the temporary proposal-only bridge used
  // while delegation is switched off) must not overwrite the durable roster.
  const immediateStored = persistedStored
    ? childAgentPolicyForSession(input.policies, persistedStored.sessionId)
    : undefined;
  const stored = immediateStored?.pendingRecapture ? immediateStored : persistedStored;
  // A roster the user explicitly approved replaces the frozen one — but only
  // when it still has somewhere to send work. An empty approved roster would
  // otherwise be promoted into a policy the backend rejects, turning the next
  // prompt into a failed turn instead of a thread without delegation.
  const recapture = input.promoteStagedEdits && stored?.pendingRecapture?.targets.length
    ? stored.pendingRecapture
    : undefined;
  const existing = recapture ? {
    ...stored!,
    // The staged budget was clamped against every *enabled* destination, but
    // only the ready subset is promoted; re-clamp so the limit can never
    // exceed the roster it actually governs.
    maxConcurrent: Math.max(1, Math.min(recapture.maxConcurrent, recapture.targets.length)),
    targets: recapture.targets,
    capturedAt: recapture.approvedAt,
    pendingRecapture: undefined,
  } : stored;
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
  const delegationEnabled = input.settings.subagentsEnabled && input.settings.childAgents.enabled;
  if (!delegationEnabled) {
    if (!input.settingsProposalsEnabled) {
      if (existing) await releaseChildAgentSession(existing.sessionId);
      return null;
    }
    const policy: ChildAgentPolicy = {
      ...(existing ?? {
        sessionId: (input.newSessionId ?? (() => crypto.randomUUID()))(),
        rootThreadId: input.threadId ?? "",
        maxConcurrent: Math.max(1, input.settings.subagentMax),
        permission: input.permission,
        systemPrompt: input.systemPrompt,
        ...(input.providerSystemPrompts ? { providerSystemPrompts: { ...input.providerSystemPrompts } } : {}),
        projectInstructionsEnabled: input.projectInstructionsEnabled,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        capturedAt: Date.now(),
      }),
      targets: [],
    };
    cacheChildAgentPolicy(policy);
    const cached = launches.get(policy.sessionId);
    if (cached?.toolNames.length === 1 && cached.toolNames[0] === "propose_agent_settings") {
      return { policy, launch: cached, captured: !stored };
    }
    if (cached || existing) await releaseChildAgentSession(policy.sessionId);
    cacheChildAgentPolicy(policy);
    const launch = await startChildAgentSession(policy, []);
    launches.set(policy.sessionId, launch);
    // The emptied roster serves only this session's bridge. Persisting it over
    // a stored policy would erase the frozen destinations (and any approved
    // recapture) that switching delegation back on is documented to restore,
    // so the policy is captured only when the thread never had one.
    return { policy, launch, captured: !stored };
  }

  // An existing thread with no policy has never run with a cross-provider
  // roster available — either it predates the feature or the user had that
  // feature switched off. It may capture one now: the composer shows the
  // roster it would capture, so nothing is acquired silently.
  const livePolicy = childAgentPolicyFor({
    sessionId: (input.newSessionId ?? (() => crypto.randomUUID()))(),
    rootThreadId: input.threadId,
    childAgents: input.settings.childAgents,
    subagentsEnabled: input.settings.subagentsEnabled,
    subagentMax: input.settings.subagentMax,
    permission: input.permission,
    systemPrompt: input.systemPrompt,
    providerSystemPrompts: input.providerSystemPrompts,
    projectInstructionsEnabled: input.projectInstructionsEnabled,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    readiness: input.readiness,
  });
  // A proposal-only policy captured no delegation authority. Once the user
  // enables a real crew, capture the live approved roster into that session.
  const policy = existing?.targets.length ? existing : livePolicy && existing
    ? { ...livePolicy, sessionId: existing.sessionId, rootThreadId: existing.rootThreadId }
    : livePolicy;
  if (!policy) return null;
  cacheChildAgentPolicy(policy);

  // A promoted policy must never reuse a bridge registered with the old
  // roster. Keep this invariant here rather than relying on every writer to
  // remember to invalidate the launch cache.
  if (recapture) launches.delete(policy.sessionId);

  const cached = launches.get(policy.sessionId);
  if (cached?.toolNames.includes("spawn_agent")) return { policy, launch: cached, captured: false };
  // A launch cached while delegation was off carries only the settings
  // proposal tool. Reusing it would run this turn with a roster visible in the
  // UI but no way to spawn into it, so — mirroring the check the proposal-only
  // branch makes in the other direction — it is ended and replaced with a
  // spawn-capable bridge.
  if (cached) {
    await releaseChildAgentSession(policy.sessionId);
    cacheChildAgentPolicy(policy);
  }

  // Re-seed the children this thread already owns so a session rebuilt after a
  // restart still recognises them for collect/cancel.
  const knownChildren = Object.values(input.links)
    .filter((link) => policy.rootThreadId && link.rootThreadId === policy.rootThreadId)
    .map((link) => link.childThreadId);
  const launch = await startChildAgentSession(policy, knownChildren);
  launches.set(policy.sessionId, launch);
  return { policy, launch, captured: !stored || Boolean(recapture) };
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

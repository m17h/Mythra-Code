import {
  endChildAgentSession,
  startChildAgentSession,
  type ChildAgentBridgeLaunch,
  type ProjectBridgeContext,
} from "./agentBridge";
import {
  childAgentPolicyFor,
  readyChildAgentTargets,
  childAgentPolicyForThread,
  type ChildAgentLink,
  type ChildAgentPolicy,
  type ChildAgentReadiness,
} from "./childAgents";
import type { AppSettings, PermissionMode, Provider } from "../types";

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
/** Security context belongs to the launch, not the frozen delegation roster. */
const launchContexts = new Map<string, string>();
/** Children receive language tools without persisting a delegation policy. */
const childProjectSessions = new Map<string, string>();

/** Bind the first-turn language bridge once app-server returns its child ID. */
export function registerChildProjectLaunch(threadId: string, sessionId: string, launch: ChildAgentBridgeLaunch, context: ProjectBridgeContext): void {
  childProjectSessions.set(threadId, sessionId);
  launches.set(sessionId, launch);
  launchContexts.set(sessionId, JSON.stringify(context));
}

async function childProjectSessionId(threadId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadId));
  // Stable across renderer reloads so re-registration rotates a child's old
  // token instead of leaving a previous permission policy reachable.
  return `language-child-${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Test seam and reload guard: drop every cached descriptor. */
export function resetChildAgentLaunches(): void {
  launches.clear();
  activePolicies.clear();
  launchContexts.clear();
  childProjectSessions.clear();
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
  /** Current provider guides tool routing without changing authority. */
  provider?: Provider;
  systemPrompt: string;
  providerSystemPrompts?: Partial<Record<Provider, string>>;
  projectInstructionsEnabled: boolean;
  reasoningEffort: ChildAgentPolicy["reasoningEffort"];
  serviceTier: string | null;
  readiness: ChildAgentReadiness;
  /** Saved projects keep project controls even while delegation is off. */
  settingsProposalsEnabled?: boolean;
  /** Only an actual prompt may consume a thread-local staged crew edit. */
  promoteStagedEdits?: boolean;
  newSessionId?: () => string;
  /** Trusted execution folder selected by the app, never by a model tool. */
  projectPath?: string;
}

export interface ChildAgentBridgeResult {
  policy: ChildAgentPolicy;
  launch: ChildAgentBridgeLaunch;
  /** True when this call captured the policy, so the caller must persist it. */
  captured: boolean;
  /** The roster stayed frozen, but a live execution setting changed. */
  policyUpdated?: boolean;
}

/**
 * Resolve the bridge a turn should start with, or null when this thread must
 * not be able to delegate across providers. Child projects may receive a
 * language-only bridge; their session can never expose delegation tools.
 */
export async function ensureChildAgentBridge(
  input: ChildAgentBridgeInput,
): Promise<ChildAgentBridgeResult | null> {
  const childThread = Boolean(input.isChildThread || (input.threadId && input.links[input.threadId]));
  const projectContext: ProjectBridgeContext = {
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    permission: input.permission,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(childThread ? { childThread: true } : {}),
  };
  const contextIdentity = JSON.stringify(projectContext);
  const cachedLaunch = async (sessionId: string) => {
    if (launches.has(sessionId) && launchContexts.get(sessionId) !== contextIdentity) {
      // session_start rotates the old token while retaining live child
      // accounting. Ending it here would drop reserved/concurrent children.
      launches.delete(sessionId);
      launchContexts.delete(sessionId);
    }
    return launches.get(sessionId);
  };
  const startSession = async (policy: ChildAgentPolicy, known: string[], finished: string[] = []) => {
    // Keep the existing call shape for non-project sessions.
    const launch = input.projectPath
      ? await startChildAgentSession(policy, known, finished, projectContext)
      : await startChildAgentSession(policy, known, ...(finished.length ? [finished] : []));
    launches.set(policy.sessionId, launch);
    launchContexts.set(policy.sessionId, contextIdentity);
    return launch;
  };
  if (childThread) {
    if (!input.projectPath || !input.threadId) return null;
    const sessionId = childProjectSessions.get(input.threadId)
      ?? input.links[input.threadId]?.languageSessionId
      ?? (input.newSessionId ? input.newSessionId() : await childProjectSessionId(input.threadId));
    const policy: ChildAgentPolicy = {
      sessionId,
      rootThreadId: input.threadId,
      targets: [],
      maxConcurrent: 1,
      permission: input.permission,
      systemPrompt: input.systemPrompt,
      projectInstructionsEnabled: input.projectInstructionsEnabled,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
      capturedAt: Date.now(),
    };
    const cached = await cachedLaunch(sessionId);
    childProjectSessions.set(input.threadId, sessionId);
    return { policy, launch: cached ?? await startSession(policy, []), captured: false };
  }

  const persistedStored = childAgentPolicyForThread(input.policies, input.threadId);
  // A composer edit can be followed by Send before React persistence renders.
  // Prefer an immediately staged record once storage identifies the session.
  // Other cached policies (notably the temporary proposal-only bridge used
  // while delegation is switched off) must not overwrite the durable roster.
  const immediateStored = persistedStored
    ? childAgentPolicyForSession(input.policies, persistedStored.sessionId)
    : undefined;
  const stored = immediateStored?.pendingRecapture ? immediateStored : persistedStored;
  // An explicit empty draft is a durable thread-local revocation. Keep it
  // until the user supplies another roster: dropping it would let the old
  // frozen crew or global defaults silently repopulate the cleared thread.
  const pending = input.promoteStagedEdits ? stored?.pendingRecapture : undefined;
  const readyTargets = pending ? readyChildAgentTargets({ enabled: true, targets: pending.targets }, input.readiness) : [];
  const clearedRoster = Boolean(pending && !readyTargets.length);
  const recapture = pending && readyTargets.length ? { ...pending, targets: readyTargets } : undefined;
  const frozenExisting = recapture ? {
    ...stored!,
    // The staged budget was clamped against every *enabled* destination, but
    // only the ready subset is promoted; re-clamp so the limit can never
    // exceed the roster it actually governs.
    maxConcurrent: Math.max(1, Math.min(recapture.maxConcurrent, recapture.targets.length)),
    targets: recapture.targets,
    capturedAt: recapture.approvedAt,
    pendingRecapture: undefined,
  } : stored;
  // The destination roster is frozen, not the execution boundary. Permission
  // mode is a live composer control and every child promises to inherit the
  // parent turn's current mode. Refresh it in both directions so an old Ask
  // policy cannot prompt under Full access—and an old Full policy cannot stay
  // over-privileged after the user tightens it.
  const existing = frozenExisting && input.promoteStagedEdits ? {
    ...frozenExisting,
    permission: input.permission,
    reasoningEffort: input.reasoningEffort,
    systemPrompt: input.systemPrompt,
    providerSystemPrompts: input.providerSystemPrompts,
    projectInstructionsEnabled: input.projectInstructionsEnabled,
    serviceTier: input.serviceTier,
  } : frozenExisting ? { ...frozenExisting, permission: input.permission } : undefined;
  const policyUpdated = Boolean(stored && existing && JSON.stringify(stored) !== JSON.stringify(existing));
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
  const delegationEnabled = !clearedRoster && input.settings.subagentsEnabled && input.settings.childAgents.enabled
    && Boolean(existing?.targets.length || readyChildAgentTargets(input.settings.childAgents, input.readiness).length);
  if (!delegationEnabled) {
    if (!input.settingsProposalsEnabled && !input.projectPath) {
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
    const cached = await cachedLaunch(policy.sessionId);
    cacheChildAgentPolicy(policy);
    if (cached?.toolNames.includes("propose_agent_settings") && !cached.toolNames.includes("spawn_mythra_agent")) {
      return { policy, launch: cached, captured: !stored };
    }
    if (cached || existing) await releaseChildAgentSession(policy.sessionId);
    cacheChildAgentPolicy(policy);
    const launch = await startSession(policy, []);
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

  const cached = await cachedLaunch(policy.sessionId);
  cacheChildAgentPolicy(policy);
  if (cached?.toolNames.includes("spawn_mythra_agent")) {
    return { policy, launch: cached, captured: false, ...(policyUpdated ? { policyUpdated: true } : {}) };
  }
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
  const finishedChildren = Object.values(input.links).filter((link) => link.rootThreadId === policy.rootThreadId && link.terminalStatus).map((link) => link.childThreadId);
  const launch = await startSession(policy, knownChildren, finishedChildren);
  return {
    policy,
    launch,
    captured: !stored || Boolean(recapture),
    ...(policyUpdated ? { policyUpdated: true } : {}),
  };
}

/** Tear down every bridge session belonging to a thread. */
export async function releaseChildAgentSessions(
  policies: Record<string, ChildAgentPolicy>,
  threadId: string,
  links: Record<string, ChildAgentLink> = {},
  isChildThread = false,
): Promise<string[]> {
  const released: string[] = [];
  const childSession = childProjectSessions.get(threadId) ?? links[threadId]?.languageSessionId
    ?? (links[threadId] || isChildThread ? await childProjectSessionId(threadId) : undefined);
  if (childSession) {
    released.push(childSession);
    await releaseChildAgentSession(childSession);
  }
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
  launchContexts.delete(sessionId);
  for (const [threadId, childSession] of childProjectSessions) {
    if (childSession === sessionId) childProjectSessions.delete(threadId);
  }
  await endChildAgentSession(sessionId).catch(() => undefined);
}

/** An approval must not silently replace a direct edit or a live child's policy. */
export function assertChildAgentProposalAvailable(policies: Record<string, ChildAgentPolicy>, links: Record<string, ChildAgentLink>, rootThreadId: string): void {
  const stored = childAgentPolicyForThread(policies, rootThreadId);
  const policy = stored && childAgentPolicyForSession(policies, stored.sessionId);
  if (policy?.pendingRecapture) throw new Error("This task has unsent sub-agent changes. Apply or clear them before accepting a proposal.");
  if (Object.values(links).some((link) => link.rootThreadId === rootThreadId && !link.terminalStatus)) {
    throw new Error("Wait for this task's sub-agents to finish before applying a proposal.");
  }
}

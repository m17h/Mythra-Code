import {
  endChildAgentSession,
  revokeChildAgentRootRegistration,
  startChildAgentSession,
  type ChildAgentBridgeLaunch,
  type ProjectBridgeContext,
} from "./agentBridge";
import {
  childAgentPolicyFor,
  childAgentSessionOptions,
  readyChildAgentTargets,
  childAgentPolicyForThread,
  modelGuidanceForTargets,
  sanitizeSubagentModelGuidance,
  subagentModelGuidanceKey,
  type ChildAgentLink,
  type ChildAgentPolicy,
  type ChildAgentReadiness,
} from "./childAgents";
import type { AppSettings, PermissionMode, Provider, SubagentModelGuidance } from "../types";

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
/** Registered read authority outlives a descriptor invalidated for the next turn. */
const terminalScopes = new Map<string, string>();
/** Children receive language tools without persisting a delegation policy. */
const childProjectSessions = new Map<string, string>();
/** Start/end must reach Rust in order: stale cleanup cannot revoke a newer token. */
const sessionOperations = new Map<string, Promise<void>>();
const sessionRegistrations = new Map<string, object>();
const sessionLifetimes = new Map<string, object>();
/** Only pending child ensures are retained; ownership starts before async hashing. */
const pendingChildRegistrations = new Map<string, object>();
const pendingThreadReleases = new Map<string, Promise<void>>();
/**
 * Saved reusable model notes. Read from here rather than a turn's settings so
 * queued and background prompts see the current saved notes, not a draft or
 * the settings their context happened to capture.
 */
let savedModelGuidance: SubagentModelGuidance[] = [];
let savedModelGuidanceSource: unknown;

/**
 * Who a root registration belongs to. A real prompt owns the policy its turn
 * captured; an attach (thread selection) only ever borrows a registration.
 */
interface RegistrationOwner {
  policy: ChildAgentPolicy;
  prompt: boolean;
}
/**
 * A root registration still waiting on its native start. Equivalent starts
 * share it, and an attach adopts a real prompt's start instead of replacing
 * it; only another prompt, Stop, or revocation may supersede a prompt.
 */
interface PendingRegistration {
  registration: object;
  /** Everything the native start receives, for exact-match sharing. */
  request: string;
  /** Execution context plus spawn capability; an attach adopts only a match. */
  authority: string;
  /** A prompt joining an identical start becomes its owner. */
  owner: RegistrationOwner;
  launch: Promise<ChildAgentBridgeLaunch>;
}
const pendingRegistrations = new Map<string, PendingRegistration>();
/**
 * What the latest successful root registration committed, together with its
 * launch: the notes it carries and the policy of the real prompt behind it.
 * Durable storage only catches up after that prompt's turn starts, so an
 * attach builds on `promptPolicy` instead of republishing a replaced roster.
 */
interface CommittedRegistration {
  guidance: { crew: string; guidance: SubagentModelGuidance[] } | null;
  promptPolicy?: ChildAgentPolicy;
}
const committedRegistrations = new Map<string, CommittedRegistration>();
/** Admitted root Stops still queued; later ensures wait instead of racing them. */
const stopBarriers = new Map<string, Promise<void>>();

/**
 * An attach whose current authority differs from a prompt's in-flight start
 * waits for that start to settle, then is evaluated again from scratch, so
 * the normal switch, context and revocation rules apply to the result.
 */
class AttachDeferred extends Error {}
const MAX_ATTACH_ATTEMPTS = 3;
const deferAttach = (): never => {
  throw new AttachDeferred("This project bridge registration was cancelled.");
};

/**
 * Resolve a registration an attach adopted. If a real prompt with an allowed
 * authority supersedes it, follow that prompt's start rather than failing.
 */
function adoptRegistration(sessionId: string, pending: PendingRegistration, allowed: string[]): Promise<{ launch: ChildAgentBridgeLaunch; owner: RegistrationOwner }> {
  return pending.launch.then((launch) => ({ launch, owner: pending.owner }), (reason: unknown) => {
    const successor = pendingRegistrations.get(sessionId);
    if (!successor || successor === pending || !successor.owner.prompt
      || sessionRegistrations.get(sessionId) !== successor.registration) throw reason;
    if (allowed.includes(successor.authority)) return adoptRegistration(sessionId, successor, allowed);
    return successor.launch.then(deferAttach, deferAttach);
  });
}

/** A real prompt's start still in flight for this thread, if any. */
function promptRegistrationForThread(threadId: string, sessionId: string | undefined): [string, PendingRegistration] | undefined {
  return [...pendingRegistrations.entries()].find(([id, pending]) => pending.owner.prompt
    && (id === sessionId || pending.owner.policy.rootThreadId === threadId)
    && sessionRegistrations.get(id) === pending.registration);
}

/**
 * The base an attach must start from. The committed prompt policy wins over a
 * durable record that has not caught up yet; a staged edit approved after
 * that prompt captured its roster is newer and stays staged.
 */
function attachBasePolicy(stored: ChildAgentPolicy | undefined, threadId: string | undefined): ChildAgentPolicy | undefined {
  const committed = stored
    ? committedRegistrations.get(stored.sessionId)?.promptPolicy
    : threadId ? [...committedRegistrations.values()].find((entry) => entry.promptPolicy?.rootThreadId === threadId)?.promptPolicy : undefined;
  if (!committed) return stored;
  const staged = stored?.pendingRecapture && stored.pendingRecapture.approvedAt > committed.capturedAt
    ? stored.pendingRecapture
    : undefined;
  return { ...committed, rootThreadId: stored?.rootThreadId || committed.rootThreadId, pendingRecapture: staged };
}

/** Publish the saved notes; the next real parent turn picks them up. */
export function setSavedSubagentModelGuidance(entries: unknown): void {
  // Called on every app render; saved settings keep a stable array identity.
  if (entries === savedModelGuidanceSource) return;
  savedModelGuidanceSource = entries;
  savedModelGuidance = sanitizeSubagentModelGuidance(entries);
}

function queueSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionOperations.get(sessionId);
  const result = previous ? previous.then(operation, operation) : operation();
  const settled = result.then(() => undefined, () => undefined);
  sessionOperations.set(sessionId, settled);
  void settled.then(() => {
    if (sessionOperations.get(sessionId) === settled) sessionOperations.delete(sessionId);
  });
  return result;
}

/** Bind the first-turn language bridge once app-server returns its child ID. */
export function registerChildProjectLaunch(threadId: string, sessionId: string, launch: ChildAgentBridgeLaunch, context: ProjectBridgeContext): void {
  childProjectSessions.set(threadId, sessionId);
  launches.set(sessionId, launch);
  launchContexts.set(sessionId, JSON.stringify({ ...context, collaborationV2: false }));
  terminalScopes.delete(sessionId);
}

async function childProjectSessionId(threadId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadId));
  // Stable across renderer reloads so re-registration rotates a child's old
  // token instead of leaving a previous permission policy reachable.
  return `language-child-${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The child conversation a child bridge session belongs to. Session ids are
 * authenticated by the backend token, so this maps a request to exactly one
 * registered child; links persisted before a reload supply the fallback.
 */
export function childThreadForBridgeSession(sessionId: string, links: Record<string, ChildAgentLink>): string | undefined {
  for (const [threadId, childSession] of childProjectSessions) {
    if (childSession === sessionId) return threadId;
  }
  return Object.values(links).find((link) => link.languageSessionId === sessionId)?.childThreadId;
}

/** Test seam and reload guard: drop every cached descriptor. */
export function resetChildAgentLaunches(): void {
  launches.clear();
  activePolicies.clear();
  launchContexts.clear();
  terminalScopes.clear();
  childProjectSessions.clear();
  sessionRegistrations.clear();
  sessionLifetimes.clear();
  pendingChildRegistrations.clear();
  pendingRegistrations.clear();
  committedRegistrations.clear();
  stopBarriers.clear();
}

/** Queue a fresh launch for the next root turn without revoking the bridge
 * that the currently-running parent still needs to collect its children. */
export function invalidateChildAgentLaunch(sessionId: string): void {
  launches.delete(sessionId);
}

/** Capture Stop's registration when this renderer has its launch descriptor. */
export function childAgentRegistrationForSession(sessionId: string): string | undefined {
  return launches.get(sessionId)?.registrationId;
}

/**
 * Serialize Stop with native starts/ends. Invalidate immediately and again
 * after an older pending start settles, so no revoked descriptor is cached.
 * Reject a Stop that was already stale at entry. Once admitted, its native
 * revocation must run: a newer run can fail before registering a replacement.
 * Later starts queue behind it; a captured registration protects replacements
 * that were already registered before this Stop reached the queue.
 */
export function revokeRootChildAgentRegistration(sessionId: string, registrationId: string | undefined, stillCurrent: () => boolean): Promise<boolean> {
  const invalidateCaptured = () => {
    const cached = launches.get(sessionId);
    if (registrationId === undefined || cached?.registrationId === registrationId) {
      launches.delete(sessionId);
      terminalScopes.delete(sessionId);
      // The stopped turn's roster is no longer a live prompt registration, so
      // attaches fall back to durable storage, keeping unsent staged edits.
      const committed = committedRegistrations.get(sessionId);
      if (committed?.promptPolicy) committedRegistrations.set(sessionId, { guidance: committed.guidance });
    }
  };
  if (!stillCurrent()) return Promise.resolve(false);
  invalidateCaptured();
  // Without a descriptor this Stop targets the start still in flight: it
  // completes in queue order and is then revoked, so nothing may adopt it.
  if (registrationId === undefined) pendingRegistrations.delete(sessionId);
  const revoked = queueSessionOperation(sessionId, async () => {
    invalidateCaptured();
    return revokeChildAgentRootRegistration(sessionId, registrationId);
  });
  const barrier = revoked.then(() => undefined, () => undefined);
  stopBarriers.set(sessionId, barrier);
  void barrier.then(() => {
    if (stopBarriers.get(sessionId) === barrier) stopBarriers.delete(sessionId);
  });
  return revoked;
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

/** Only a currently registered root bridge may inspect its captured terminal. */
export function projectTerminalScopeForSession(sessionId: string): string | undefined {
  return terminalScopes.get(sessionId);
}

export interface ChildAgentBridgeInput {
  /** The thread this turn belongs to; absent for a brand-new conversation. */
  threadId?: string;
  policies: Record<string, ChildAgentPolicy>;
  links: Record<string, ChildAgentLink>;
  /** Includes provider-native ownership, which is stored separately from bridge links. */
  isChildThread?: boolean;
  settings: Pick<AppSettings, "childAgents" | "subagentsEnabled" | "subagentMax" | "subagentEngine" | "managedSubagentV2">;
  permission: PermissionMode;
  /** Current provider guides tool routing without changing authority. */
  provider?: Provider;
  systemPrompt: string;
  providerSystemPrompts?: Partial<Record<Provider, string>>;
  projectInstructionsEnabled: boolean;
  projectClaudeInstructionsEnabled?: boolean;
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
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ensureChildAgentBridgeOnce(input);
    } catch (reason) {
      if (!(reason instanceof AttachDeferred)) throw reason;
      // Only attaches defer, and only after a prompt's start settled. Bound
      // the loop in case prompts keep arriving with a different authority.
      if (attempt >= MAX_ATTACH_ATTEMPTS) throw new Error("This project bridge registration was cancelled.");
    }
  }
}

async function ensureChildAgentBridgeOnce(
  input: ChildAgentBridgeInput,
): Promise<ChildAgentBridgeResult | null> {
  const childThread = Boolean(input.isChildThread || (input.threadId && input.links[input.threadId]));
  // Only a Mythra Code-owned child has a parent mailbox. Provider-native
  // children keep their language-only bridge exactly as before.
  const managedChild = Boolean(input.threadId && input.links[input.threadId]);
  const childConversations = Boolean(input.threadId && input.links[input.threadId]?.signoff === "required");
  const projectContext: ProjectBridgeContext = {
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    permission: input.permission,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(childThread ? { childThread: true } : {}),
    ...(managedChild ? { parentMessaging: childConversations } : {}),
    // Opening a managed child can inherit the project's native engine setting,
    // but its ownership still grants only its own parent mailbox. Native
    // children remain language-only and never acquire this managed authority.
    ...(!managedChild && input.settings.subagentEngine === "native" ? { nativeDelegation: true } : {}),
  };
  // Only a real prompt re-reads the saved notes. The roster stays frozen;
  // just the advice shown for it follows the user's current preferences.
  // Resolved once per call, so lookup and registration agree on the notes.
  const resolvedGuidance = new Map<string, { crew: string; guidance: SubagentModelGuidance[] }>();
  const guidanceFor = (policy: ChildAgentPolicy): { crew: string; guidance: SubagentModelGuidance[] } | null => {
    if (childThread || input.settings.subagentEngine === "native") return null;
    const targets = policy.targets.filter((target) => target.enabled);
    if (!targets.length) return null;
    const crew = JSON.stringify(targets.map(subagentModelGuidanceKey));
    const memo = `${policy.sessionId}\u0000${crew}`;
    const resolved = resolvedGuidance.get(memo);
    if (resolved) return resolved;
    // Attaches keep the notes their bridge is registered with, so navigation
    // never rotates a bridge; an unregistered crew starts from saved notes.
    const registered = committedRegistrations.get(policy.sessionId)?.guidance;
    const next = !input.promoteStagedEdits && registered?.crew === crew
      ? registered
      : { crew, guidance: modelGuidanceForTargets(savedModelGuidance, targets) };
    resolvedGuidance.set(memo, next);
    return next;
  };
  // Notes are part of the registered tool description, so changed notes need
  // a new registration exactly like a changed execution context.
  const contextIdentityFor = (policy: ChildAgentPolicy, guidance = guidanceFor(policy)?.guidance ?? []) => JSON.stringify({
    ...projectContext,
    collaborationV2: policy.collaborationV2 === true,
    ...(guidance.length ? { modelGuidance: guidance } : {}),
  });
  // Authority of a start: execution context (permission, provider, project,
  // native engine) plus spawn capability.
  const authorityOf = (delegation: boolean) => JSON.stringify({ ...projectContext, delegation });
  // The one rule for an attach borrowing a prompt's start: the exact same
  // context, and never more spawn capability than the attach itself asks for.
  // A start without delegation (for example a prompt that consumed an empty
  // staged roster) is a safe borrow for an attach that would delegate.
  const allowedAuthorities = (delegation: boolean) => delegation ? [authorityOf(false), authorityOf(true)] : [authorityOf(false)];
  // Wait out an incompatible prompt start, then retry the whole ensure. Undo
  // only this attach's own immediate cache write, as a borrowed result would.
  const deferToPrompt = async (pending: PendingRegistration, own?: ChildAgentPolicy): Promise<never> => {
    await pending.launch.catch(() => undefined);
    if (own && activePolicies.get(own.sessionId) === own) cacheChildAgentPolicy(pending.owner.policy);
    return deferAttach();
  };
  let invocationCurrent = () => true;
  let lifetime: object | undefined;
  // Synchronous on purpose: a root caller must decide on the descriptor in the
  // same run that read it, before a concurrent prompt can invalidate it.
  const cachedLaunch = (policy: ChildAgentPolicy): ChildAgentBridgeLaunch | undefined => {
    const sessionId = policy.sessionId;
    const contextIdentity = contextIdentityFor(policy);
    lifetime = sessionLifetimes.get(sessionId) ?? {};
    sessionLifetimes.set(sessionId, lifetime);
    if (launchContexts.has(sessionId) && launchContexts.get(sessionId) !== contextIdentity) {
      // session_start rotates the old token while retaining live child
      // accounting. Ending it here would drop reserved/concurrent children.
      launches.delete(sessionId);
      launchContexts.delete(sessionId);
      terminalScopes.delete(sessionId);
    }
    return launches.get(sessionId);
  };
  const assertLifetime = (sessionId: string) => {
    if (!lifetime || sessionLifetimes.get(sessionId) !== lifetime) {
      throw new Error("This project bridge registration was cancelled.");
    }
  };
  const startSession = async (policy: ChildAgentPolicy, known: string[], finished: string[] = []): Promise<{ launch: ChildAgentBridgeLaunch; owner: RegistrationOwner }> => {
    assertLifetime(policy.sessionId);
    const sessionId = policy.sessionId;
    const resolved = guidanceFor(policy);
    const guidance = resolved?.guidance ?? [];
    const promoting = input.promoteStagedEdits === true;
    const authority = authorityOf(policy.targets.length > 0);
    const allowed = allowedAuthorities(policy.targets.length > 0);
    // Everything the native start receives. Child sessions keep their own
    // per-invocation cancellation and are never shared.
    const request = childThread ? undefined : JSON.stringify({
      context: contextIdentityFor(policy, guidance),
      options: childAgentSessionOptions(policy, known),
      finished,
      permission: policy.permission,
    });
    const inFlight = request ? pendingRegistrations.get(sessionId) : undefined;
    if (inFlight && sessionRegistrations.get(sessionId) === inFlight.registration) {
      if (inFlight.request === request || (inFlight.owner.prompt && !promoting && allowed.includes(inFlight.authority))) {
        // An attach borrows a compatible start. A prompt joining an identical
        // start owns it, so its policy is the one committed and handed out.
        if (!promoting) return adoptRegistration(sessionId, inFlight, allowed);
        const owner = { policy, prompt: true };
        inFlight.owner = owner;
        return { launch: await inFlight.launch, owner };
      }
      // An attach never cancels a prompt's start, even when it disagrees.
      if (inFlight.owner.prompt && !promoting) return deferToPrompt(inFlight, policy);
    }
    const registration = {};
    sessionRegistrations.set(sessionId, registration);
    let entry: PendingRegistration | undefined;
    const started = queueSessionOperation(sessionId, async () => {
      const current = () => invocationCurrent() && sessionRegistrations.get(sessionId) === registration;
      if (!current()) throw new Error("This project bridge registration was cancelled.");
      // Keep the existing call shape for projectless roots. A projectless
      // managed child still needs its child scope and parent mailbox flags.
      const launch = input.projectPath || projectContext.childThread
        ? await startChildAgentSession(policy, known, finished, projectContext, ...(guidance.length ? [guidance] : []))
        : guidance.length
          ? await startChildAgentSession(policy, known, finished, undefined, guidance)
          : await startChildAgentSession(policy, known, ...(finished.length ? [finished] : []));
      if (!current()) {
        // This operation still owns the native session until the next queued
        // start/end. Retire it here, before a newer registration can reach Rust.
        await endChildAgentSession(sessionId).catch(() => undefined);
        throw new Error("This project bridge registration was cancelled.");
      }
      launches.set(sessionId, launch);
      launchContexts.set(sessionId, contextIdentityFor(policy, guidance));
      // Commit notes and owning prompt policy atomically with the launch. A
      // proposal-only or attach start keeps the last prompt's roster.
      const owner = entry?.owner ?? { policy, prompt: promoting };
      const promptPolicy = owner.prompt && owner.policy.targets.length
        ? owner.policy
        : committedRegistrations.get(sessionId)?.promptPolicy;
      committedRegistrations.set(sessionId, { guidance: resolved, ...(promptPolicy ? { promptPolicy } : {}) });
      if (!projectContext.childThread && projectContext.projectPath?.trim()
        && launch.toolNames.includes("read_project_terminal")) {
        terminalScopes.set(sessionId, projectContext.projectPath);
      } else terminalScopes.delete(sessionId);
      return launch;
    });
    if (!request) return { launch: await started, owner: { policy, prompt: promoting } };
    const pending: PendingRegistration = { registration, request, authority, owner: { policy, prompt: promoting }, launch: started };
    entry = pending;
    pendingRegistrations.set(sessionId, pending);
    const settle = () => {
      if (pendingRegistrations.get(sessionId) === pending) pendingRegistrations.delete(sessionId);
    };
    void started.then(settle, settle);
    if (!promoting) return adoptRegistration(sessionId, pending, allowed);
    return { launch: await started, owner: pending.owner };
  };
  // An attach whose start a real prompt owns returns that prompt's policy and
  // never claims capture or an update, so App can neither persist its stale
  // view over the prompt nor release the prompt's session on abandonment. It
  // undoes only its own immediate cache write.
  const promptOwnedResult = (own: ChildAgentPolicy, started: { launch: ChildAgentBridgeLaunch; owner: RegistrationOwner }): ChildAgentBridgeResult | undefined => {
    if (input.promoteStagedEdits || !started.owner.prompt) return undefined;
    if (activePolicies.get(own.sessionId) === own) cacheChildAgentPolicy(started.owner.policy);
    return { policy: started.owner.policy, launch: started.launch, captured: false };
  };
  if (childThread) {
    if (!input.threadId || (!input.projectPath && !managedChild)) return null;
    const threadId = input.threadId;
    const invocation = {};
    pendingChildRegistrations.set(threadId, invocation);
    invocationCurrent = () => pendingChildRegistrations.get(threadId) === invocation;
    try {
      // A release can itself await the stable child identity. A newer ensure
      // must not register a session that this older release will then end.
      const pendingRelease = pendingThreadReleases.get(threadId);
      if (pendingRelease) await pendingRelease;
      if (!invocationCurrent()) throw new Error("This project bridge registration was cancelled.");
      const sessionId = childProjectSessions.get(threadId)
        ?? input.links[threadId]?.languageSessionId
        ?? (input.newSessionId ? input.newSessionId() : await childProjectSessionId(threadId));
      if (!invocationCurrent()) throw new Error("This project bridge registration was cancelled.");
      const policy: ChildAgentPolicy = {
        sessionId,
        rootThreadId: threadId,
        targets: [],
        maxConcurrent: 1,
        permission: input.permission,
        systemPrompt: input.systemPrompt,
        projectInstructionsEnabled: input.projectInstructionsEnabled === true,
        projectClaudeInstructionsEnabled: input.projectClaudeInstructionsEnabled === true,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        // Child authority comes from its durable signoff marker, never from
        // root conversation tools or the current global preview setting.
        collaborationV2: false,
        capturedAt: Date.now(),
      };
      // Publish provisional ownership before yielding, including random IDs
      // used by delegated first turns. Release must retire this exact session.
      childProjectSessions.set(threadId, sessionId);
      const cached = await cachedLaunch(policy);
      if (!invocationCurrent()) throw new Error("This project bridge registration was cancelled.");
      assertLifetime(sessionId);
      return { policy, launch: cached ?? (await startSession(policy, [])).launch, captured: false };
    } finally {
      if (invocationCurrent()) pendingChildRegistrations.delete(threadId);
    }
  }

  const persistedStored = childAgentPolicyForThread(input.policies, input.threadId);
  // A Stop still queued for this session finishes first, so neither a prompt
  // nor an attach can share or supersede the start it is about to revoke.
  const stopBarrier = persistedStored ? stopBarriers.get(persistedStored.sessionId) : undefined;
  if (stopBarrier) await stopBarrier;
  // A composer edit can be followed by Send before React persistence renders.
  // Prefer an immediately staged record once storage identifies the session.
  // Other cached policies (notably the temporary proposal-only bridge used
  // while delegation is switched off) must not overwrite the durable roster.
  const immediateStored = persistedStored
    ? childAgentPolicyForSession(input.policies, persistedStored.sessionId)
    : undefined;
  const latestStored = immediateStored?.pendingRecapture ? immediateStored : persistedStored;
  // Only a real prompt reads the durable record as authoritative; an attach
  // builds on the roster the latest successful prompt actually registered.
  const stored = input.promoteStagedEdits ? latestStored : attachBasePolicy(latestStored, input.threadId);
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
  // A preview switch must not strand an assignment already awaiting its
  // parent's review. Keep that crew's conversations until explicit acceptance;
  // the next real prompt can then adopt the user's current default either way.
  const unsettledV2Crew = Boolean(input.threadId && Object.values(input.links).some((link) =>
    link.rootThreadId === input.threadId && link.signoff === "required" && !link.acceptedAt));
  const collaborationV2 = input.settings.subagentEngine !== "native" && (unsettledV2Crew
    || (input.promoteStagedEdits || !stored
      ? input.settings.managedSubagentV2 === true
      : stored.collaborationV2 === true));
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
    projectInstructionsEnabled: input.projectInstructionsEnabled === true,
    projectClaudeInstructionsEnabled: input.projectClaudeInstructionsEnabled === true,
    serviceTier: input.serviceTier,
    collaborationV2,
  } : frozenExisting ? { ...frozenExisting, permission: input.permission, collaborationV2 } : undefined;
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
  const delegationEnabled = input.settings.subagentEngine !== "native" && !clearedRoster && input.settings.subagentsEnabled && input.settings.childAgents.enabled
    && Boolean(existing?.targets.length || readyChildAgentTargets(input.settings.childAgents, input.readiness).length);
  // A thread opened while its real prompt is still registering adopts that
  // registration before caching anything of its own, but only when it asks
  // for an allowed authority. Otherwise it waits for the prompt's start and
  // is re-evaluated, so a switch turned off since still revokes it below.
  const promptInFlight = !input.promoteStagedEdits && input.threadId
    ? promptRegistrationForThread(input.threadId, persistedStored?.sessionId)
    : undefined;
  if (promptInFlight) {
    const allowed = allowedAuthorities(delegationEnabled);
    if (!allowed.includes(promptInFlight[1].authority)) return deferToPrompt(promptInFlight[1]);
    const adopted = await adoptRegistration(promptInFlight[0], promptInFlight[1], allowed);
    return { policy: adopted.owner.policy, launch: adopted.launch, captured: false };
  }
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
        projectInstructionsEnabled: input.projectInstructionsEnabled === true,
        projectClaudeInstructionsEnabled: input.projectClaudeInstructionsEnabled === true,
        reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier,
        collaborationV2,
        capturedAt: Date.now(),
      }),
      targets: [],
    };
    cacheChildAgentPolicy(policy);
    const cached = cachedLaunch(policy);
    cacheChildAgentPolicy(policy);
    if (cached && !cached.toolNames.includes("spawn_mythra_agent")
      && (input.settings.subagentEngine === "native" || cached.toolNames.includes("propose_agent_settings"))) {
      return { policy, launch: cached, captured: !stored };
    }
    if (cached || existing) await revokeChildAgentSession(policy.sessionId, lifetime);
    assertLifetime(policy.sessionId);
    cacheChildAgentPolicy(policy);
    const started = await startSession(policy, []);
    const borrowed = promptOwnedResult(policy, started);
    if (borrowed) return borrowed;
    // The emptied roster serves only this session's bridge. Persisting it over
    // a stored policy would erase the frozen destinations (and any approved
    // recapture) that switching delegation back on is documented to restore,
    // so the policy is captured only when the thread never had one.
    return { policy, launch: started.launch, captured: !stored };
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
    collaborationV2,
    permission: input.permission,
    systemPrompt: input.systemPrompt,
    providerSystemPrompts: input.providerSystemPrompts,
    projectInstructionsEnabled: input.projectInstructionsEnabled === true,
    projectClaudeInstructionsEnabled: input.projectClaudeInstructionsEnabled === true,
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

  const cached = cachedLaunch(policy);
  cacheChildAgentPolicy(policy);
  if (cached?.toolNames.includes("spawn_mythra_agent")) {
    // Reusing the launch is this prompt's successful registration for the turn.
    if (input.promoteStagedEdits) {
      committedRegistrations.set(policy.sessionId, { guidance: committedRegistrations.get(policy.sessionId)?.guidance ?? null, promptPolicy: policy });
    }
    return { policy, launch: cached, captured: false, ...(policyUpdated ? { policyUpdated: true } : {}) };
  }
  // A launch cached while delegation was off carries only the settings
  // proposal tool. Reusing it would run this turn with a roster visible in the
  // UI but no way to spawn into it, so — mirroring the check the proposal-only
  // branch makes in the other direction — it is ended and replaced with a
  // spawn-capable bridge.
  if (cached) {
    await revokeChildAgentSession(policy.sessionId, lifetime);
    assertLifetime(policy.sessionId);
    cacheChildAgentPolicy(policy);
  }

  // Re-seed the children this thread already owns so a session rebuilt after a
  // restart still recognises them for collect/cancel.
  const knownChildren = Object.values(input.links)
    .filter((link) => policy.rootThreadId && link.rootThreadId === policy.rootThreadId)
    .map((link) => link.childThreadId);
  const finishedChildren = Object.values(input.links).filter((link) => link.rootThreadId === policy.rootThreadId && link.terminalStatus).map((link) => link.childThreadId);
  const started = await startSession(policy, knownChildren, finishedChildren);
  const borrowed = promptOwnedResult(policy, started);
  if (borrowed) return borrowed;
  return {
    policy,
    launch: started.launch,
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
  // Revocation cannot wait for the same hash computation it must cancel.
  pendingChildRegistrations.delete(threadId);
  const previous = pendingThreadReleases.get(threadId);
  const operation = () => releaseChildAgentSessionsInner(policies, threadId, links, isChildThread);
  const result = previous ? previous.then(operation, operation) : operation();
  const settled = result.then(() => undefined, () => undefined);
  pendingThreadReleases.set(threadId, settled);
  void settled.then(() => {
    if (pendingThreadReleases.get(threadId) === settled) pendingThreadReleases.delete(threadId);
  });
  return result;
}

async function releaseChildAgentSessionsInner(
  policies: Record<string, ChildAgentPolicy>,
  threadId: string,
  links: Record<string, ChildAgentLink>,
  isChildThread: boolean,
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
  return revokeChildAgentSession(sessionId);
}

async function revokeChildAgentSession(sessionId: string, preservedLifetime?: object): Promise<void> {
  if (preservedLifetime && sessionLifetimes.get(sessionId) !== preservedLifetime) {
    throw new Error("This project bridge registration was cancelled.");
  }
  // Revoke renderer authority before waiting for an in-flight native start.
  if (!preservedLifetime) sessionLifetimes.delete(sessionId);
  sessionRegistrations.delete(sessionId);
  launches.delete(sessionId);
  activePolicies.delete(sessionId);
  launchContexts.delete(sessionId);
  terminalScopes.delete(sessionId);
  pendingRegistrations.delete(sessionId);
  committedRegistrations.delete(sessionId);
  for (const [threadId, childSession] of childProjectSessions) {
    if (childSession === sessionId) childProjectSessions.delete(threadId);
  }
  await queueSessionOperation(sessionId, () => endChildAgentSession(sessionId).catch(() => undefined));
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

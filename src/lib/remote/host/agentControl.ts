import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { useTaskStore, pinTaskTranscript, type TaskStatus } from "../../taskStore";
import { sealStoppedTurn } from "../../stopTurnHistory";
import { markProviderStopIntent, clearProviderStopIntent } from "../../providerStopIntent";
import { childAgentModel, providerDisplayName } from "../../childAgents";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostContextSources } from "./hostContext";
import { resolveThreadExecutionContext } from "./executionContext";
import type { HostParityActions } from "./parityActions";
import type { HostResources } from "./resources";
import { operationStamp } from "./stateCommit";
import { nativeRefusal } from "./nativeActions";
import { HostReadError, idArg } from "./scope";
import { sameStop, type WorkTargets } from "./targetHandles";
import type { RemoteStopSnapshot, RemoteTurnRunner, RemoteTurnDelivery } from "./workTypes";
type Operation = Parameters<HostParityActions["execute"]>[2];
interface AgentControlServices {
  sources: HostContextSources; resources: HostResources; runner: RemoteTurnRunner; targets: WorkTargets;
  ensureHydrated(threadId: string, assertCurrent: () => void): Promise<void>;
  transport?: HostTransport;
}
const stale = () => new HostReadError("stale_target", "This sub-agent assignment or parent turn changed. Refresh before trying again.");
function terminal(status: TaskStatus | undefined): TaskStatus | undefined {
  return status === "completed" || status === "interrupted" || status === "error" ? status : undefined;
}
/** Physical cutoff is native-owned. Shared hook owns follow-up generations,
 * preparation reservations, slot release, parent activity and metadata refs. */
export async function executeHostAgentControl(op: "agents.stop" | "agents.replace", args: Readonly<Record<string, unknown>>, operation: Operation,
  services: AgentControlServices): ReturnType<HostParityActions["execute"]> {
  const { sources, resources, runner, targets } = services, transport = services.transport ?? nativeHostTransport;
  const root = operation.context.activeThread!.id, device = operation.identity.device, handle = idArg(args.target);
  const worker = resources.resolveWorker(handle, device, root);
  if (worker.id !== args.agentId || !worker.canStop) throw stale();
  if (worker.nativeRuntime === "claude" || worker.id.startsWith("claude-native:")) throw new HostReadError("unsupported", "Claude native sub-agents share their root process. Stop the root conversation to stop them.");
  const lifecycle = sources.getAgentLifecycle?.();
  const stopWorker = lifecycle?.stopWorker?.bind(lifecycle);
  if (!stopWorker) throw new HostReadError("unsupported", "The host's shared sub-agent Stop lifecycle is not attached.");
  const parent = runner.getThreadStopTarget(root), task = useTaskStore.getState().tasks[root];
  const replacement = op === "agents.replace" ? sources.getThreadCrew?.(root)?.targets.find((entry) => entry.id === args.targetId && entry.enabled !== false) : undefined;
  if (op === "agents.replace" && !replacement) throw new HostReadError("stale_target", "That destination was not approved when this parent started.");
  if (op === "agents.replace" && (task?.status === "starting" || task?.status === "running" && !parent.turnId
    || useTaskStore.getState().workflowOwners[root] || task?.queuedTurns.some((entry) => entry.status === "queued" && !entry.editing))) {
    throw new HostReadError("busy", "Wait for the parent's current preparation or queued instruction before replacing this sub-agent.");
  }
  const initialCheck = () => {
    // The generic dispatcher already checked the resource revision. Streaming
    // parent rows are not ownership of this child; keep exact handles/turns and
    // live authority, not an obsolete messages.length-based public revision.
    operation.delivery.assertAllowed();
    if (resources.resolveWorker(handle, device, root).id !== worker.id) throw stale();
    if (op === "agents.replace" && !sameStop(parent, runner.getThreadStopTarget(root))) throw stale();
  };
  const release = pinTaskTranscript(worker.id), releaseRoot = pinTaskTranscript(root);
  let confirmed = false, cutoffInvoked = false, nativeTarget: string | undefined, child: RemoteTurnDelivery | undefined;
  let ownerHandle: string | undefined, hydrated = false;
  try {
    initialCheck();
    try { await services.ensureHydrated(worker.id, initialCheck); hydrated = true; }
    catch (reason) {
      // Like local child Stop, a failed history read does not make an exact
      // native cutoff unsafe. Never serialize that incomplete history afterward.
      if (!(reason instanceof HostReadError) || !["host_unavailable", "internal", "uncertain"].includes(reason.code)) throw reason;
    }
    initialCheck();
    const context = resolveThreadExecutionContext(sources, { threadId: worker.id }, device);
    if (context.activeWorkspace?.id !== operation.context.activeWorkspace?.id) throw stale();
    const input = resources.input(root), link = input.links[worker.id];
    const observed = runner.getThreadStopTarget(worker.id);
    const expected: RemoteStopSnapshot = { ...observed,
      turnId: observed.turnId ?? link?.activationTurnId,
      startRequestId: observed.startRequestId ?? link?.activationStartRequestId };
    if (!expected.turnId && !expected.startRequestId && !expected.ownerHandle) throw new HostReadError("stale_target", "This child has no confirmed native turn or startup owner.");
    const target = await targets.register({ device, workspaceId: context.activeWorkspace!.id, provider: context.effectiveSettings.provider, stop: expected }, expected.ownerHandle ? "parent" : expected.turnId ? "turn" : "start");
    initialCheck(); nativeTarget = target.handle;
    let parentHandle: string | undefined;
    if (op === "agents.replace" && parent.turnId) {
      parentHandle = (await targets.register({ device, workspaceId: operation.context.activeWorkspace!.id,
        provider: operation.context.effectiveSettings.provider, stop: parent }, "turn")).handle;
      initialCheck();
    }
    const initialTask = useTaskStore.getState().tasks[worker.id];
    const assertBeforeCutoff = () => { initialCheck(); if (!sameStop(observed, runner.getThreadStopTarget(worker.id))) throw stale(); };
    await stopWorker(root, worker, async () => {
      if (cutoffInvoked) throw new HostReadError("uncertain", "This cutoff callback has already run; it cannot be repeated.");
      assertBeforeCutoff(); cutoffInvoked = true;
      // A root latch records that the independently journaled child cutoff may
      // have run even if the native helper loses its acknowledgement afterward.
      await operation.delivery.beforeDispatch({ threadId: root, messageId: operation.delivery.messageId, provider: operation.context.effectiveSettings.provider });
      assertBeforeCutoff();
      if (expected.turnId) markProviderStopIntent(worker.id, expected.turnId);
      try {
        let result: { confirmed: boolean };
        try { result = await transport.invoke("remote_agent_stop", { stamp: operationStamp(operation), childThreadId: worker.id, targetHandle: nativeTarget }); }
        catch (reason) { throw nativeRefusal(reason); }
        if (result?.confirmed !== true) throw new HostReadError("uncertain", "This child's cutoff could not be confirmed.");
        confirmed = true;
        // An already confirmed Stop remains accepted if a UI/save callback fails.
        if (op === "agents.stop") await operation.delivery.accepted({ threadId: root });
        const current = useTaskStore.getState().tasks[worker.id];
        const sameRun = current?.agentRunId === initialTask?.agentRunId && current?.agentRunStartedAt === initialTask?.agentRunStartedAt;
        const sameTurn = !current?.activeTurnId || current.activeTurnId === expected.turnId;
        if (sameRun && sameTurn) {
          if (expected.turnId) sealStoppedTurn(worker.id, expected.turnId);
          else if (current?.status === "running" || current?.status === "starting") useTaskStore.getState().completeTurn(worker.id, undefined, "interrupted");
          // Never save an empty reconstructed transcript over real history.
          if (hydrated && initialTask?.messages.length) saveTranscript(context, worker.id);
        }
        return terminal(useTaskStore.getState().tasks[worker.id]?.status) ?? "interrupted";
      } finally { if (expected.turnId) clearProviderStopIntent(worker.id, expected.turnId); }
    }, () => { if (!confirmed) assertBeforeCutoff(); });
    if (!confirmed) throw new HostReadError("uncertain", "The shared lifecycle did not perform a confirmed child cutoff.");
    if (op === "agents.stop") return { state: "accepted", threadId: root };
    // Our own cutoff changes child status/parent activity. Keep the grant and
    // captured parent identity, not a stale public pre-cutoff resource revision.
    operation.delivery.assertAllowed();
    if (!sameStop(parent, runner.getThreadStopTarget(root))) throw stale();
    if (!operation.delivery.openOwner || !operation.delivery.childStep) throw new HostReadError("unsupported", "The native replacement instruction lifecycle is not attached.");
    ownerHandle = await operation.delivery.openOwner("start", `replace-${operation.delivery.attemptId}`, root);
    operation.delivery.assertAllowed();
    if (!sameStop(parent, runner.getThreadStopTarget(root))) throw stale();
    child = await operation.delivery.childStep("replacement-instruction", root, "prompt", parentHandle);
    const instruction = ["Mythra Code sub-agent control: replace the sub-agent I just stopped.",
      `Use the approved \`${replacement!.id}\` destination (${replacement!.label || providerDisplayName(replacement!.provider)} · ${childAgentModel(replacement!) || "provider default"}).`,
      `Restart the same delegated task: ${worker.title}`,
      "Spawn a fresh child for that task; do not resume or reuse the stopped child id."].join("\n");
    const next = { ...operation.context, remoteDelivery: child, attachments: [], skillInvocationText: "", resolveSkillMentions: false as const,
      resolveSkillPrompt: async (text: string) => text, remoteRequireIdle: true as const,
      ...(parent.turnId ? { deliveryGuard: () => sameStop(parent, runner.getThreadStopTarget(root)) } : {}) };
    const result = parent.turnId ? await runner.steerThread(next, instruction, parent) : await runner.sendPromptTo(next, instruction);
    if (result.state !== "accepted") throw new HostReadError("uncertain", "The old sub-agent stopped, but its replacement instruction was not confirmed. Check the parent before trying again.");
    // Steering does not transfer the original parent turn's ownership. Native
    // admits this one input under an empty synthetic owner, then closes it.
    if (parent.turnId) { try { await transport.invoke("remote_work_owner_finish", { generation: operation.generation, ownerHandle }); } catch { /* Never downgrade confirmed input. */ } }
    return { state: "accepted", threadId: root };
  } catch (reason) {
    if (op === "agents.stop" && confirmed) return { state: "accepted", threadId: root };
    if (confirmed) { await operation.delivery.uncertain({ threadId: root }); }
    if (ownerHandle && !child) { try { await transport.invoke("remote_work_owner_finish", { generation: operation.generation, ownerHandle }); } catch { /* No provider replay. */ } }
    throw reason;
  } finally { release(); releaseRoot(); }
}
function saveTranscript(context: TurnRunnerContext, id: string): void {
  if (context.effectiveSettings.provider === "claude") context.scheduleClaudeThreadSave(id);
  else if (context.effectiveSettings.provider === "cursor") context.scheduleCursorThreadSave(id);
}

import { invoke } from "@tauri-apps/api/core";
import type { Project, ScheduleRunSettings } from "../../../types";
import { flushPendingStateWrites } from "../../storage";
import type { WorkflowDefinition } from "../../workflows";
import type { HostContextSources } from "./hostContext";
import type { HostMutationContext } from "./workActions";
import type { RemoteTurnDelivery } from "./workTypes";
import { RemoteDeliveryJournal } from "./deliveryJournal";
import { finishRemoteEngineOwner, rememberRemoteEngineOwner, remoteEngineStopped } from "./engineOwners";
import { currentWorkGrant, remotePermission } from "./executionContext";
import { HostReadError, workspaceAllowed } from "./scope";
import { remoteProvenance, type RemoteExecutionProvenance } from "./provenance";
import { nativeRefusal } from "./nativeActions";

/** Hook-facing remote-only seams. Local workflows never call or await these. */
export interface RemoteWorkflowExecution {
  begin(workflow: WorkflowDefinition, project: Project, runId: string): Promise<{ run: ScheduleRunSettings; preparation: RemoteTurnDelivery }>;
  admitted(): Promise<void>;
  bindThread(threadId: string): Promise<void>;
  step(stepId: string, kind: "prompt" | "command", threadId: string): Promise<RemoteTurnDelivery>;
  stepAccepted?(threadId: string): void;
  assertCurrent(): void;
  finish(): Promise<boolean>;
  failed(reason: unknown): void;
  readonly ownerHandle?: string;
  readonly ownerRunId?: string;
  readonly provenance?: RemoteExecutionProvenance;
  readonly finished: boolean;
}
export interface RemoteWorkflowEngine {
  runWorkflow(id: string, source: "manual", variables: Record<string, string>, projectId: string,
    invocation: { userPrompt?: string; remote: RemoteWorkflowExecution }): Promise<string | undefined>;
  stopWorkflowRun(id: string, runId: string, stopRoot?: () => Promise<void>): Promise<boolean>;
}
interface Admission { runId: string; threadId?: string }
/** Native identities come only from the step admission API, never viewer data or
 * an invented opSeq. Missing native support refuses before first preparation. */
export function createWorkflowExecution(sources: HostContextSources,
  operation: HostMutationContext & { delivery: RemoteTurnDelivery }, isCurrent: () => boolean, variables: Readonly<Record<string, string>> = {}) {
  let handle: string | undefined, runId: string | undefined, threadId: string | undefined, permission = operation.context.effectiveSettings.permission;
  let run: ScheduleRunSettings | undefined, stopped = false, resolve!: (result: Admission) => void, reject!: (reason: unknown) => void;
  let admitted = false, terminal = false, threadBound = false;
  const admission = new Promise<Admission>((done, fail) => { resolve = done; reject = fail; });
  // Caller attaches immediately too; keep an early preflight failure handled.
  void admission.catch(() => undefined);
  const workspace = operation.context.activeWorkspace!;
  const assertCurrent = () => {
    if (stopped || !isCurrent()) throw new HostReadError("host_unavailable", "This workflow ended when the other device reconnected.");
    const grant = currentWorkGrant(sources, operation.identity.device);
    const live = sources.getWorkspaces().find((project) => project.id === workspace.id);
    if (!live || live.path !== workspace.path || !workspaceAllowed(live, grant)) throw new HostReadError("forbidden", "This workflow's workspace is no longer shared.");
    if (remotePermission(permission, grant) !== permission || sources.getSettings().permission === "read-only" && permission !== "read-only") throw new HostReadError("forbidden", "The other device permission ceiling changed.");
  };
  async function step(stepId: string, kind: "prompt" | "command", targetThread?: string): Promise<RemoteTurnDelivery> {
    assertCurrent();
    if (!handle || !run || !runId) throw new HostReadError("unsupported", "This workflow has no native owner.");
    const grant = await invoke<ReturnType<HostContextSources["getGrant"]>>("remote_work_grant", { generation: operation.generation, device: operation.identity.device });
    assertCurrent();
    if (!grant?.view || !grant.work || !workspaceAllowed(workspace, grant) || remotePermission(permission, grant) !== permission
      || kind === "command" && (!grant.capabilities.terminal || !currentWorkGrant(sources, operation.identity.device).capabilities.terminal)) throw new HostReadError("forbidden", "This workflow step is no longer allowed.");
    const nativeLocalProvider = run.provider === "claude" || run.provider === "cursor";
    if (kind === "command" && nativeLocalProvider && !threadBound) throw new HostReadError("unsupported", "A provider-native thread must be established before this recipe can run commands.");
    type Reply = { state: string; delivery: { device: string; opId: string; opSeq: number; attemptId: string; messageId: string } };
    let reply: Reply;
    try { reply = await invoke("remote_work_engine_step", { generation: operation.generation, ownerHandle: handle, stepId, kind,
      threadId: nativeLocalProvider && !threadBound ? undefined : targetThread, provider: kind === "command" || run.provider === "openrouter" || run.provider === "lmstudio" ? "openai" : run.provider, permission }); }
    catch (reason) {
      if (typeof reason === "string" && /not found|unknown command/i.test(reason)) throw new HostReadError("unsupported", "The other device has not installed per-step workflow admission.");
      throw nativeRefusal(reason);
    }
    assertCurrent();
    const id = reply.delivery;
    if (reply.state !== "preparing" || !id || id.device !== operation.identity.device || !id.opId || !Number.isSafeInteger(id.opSeq) || id.opSeq < 1 || !id.attemptId || !id.messageId) throw new HostReadError("uncertain", "This workflow step may already have run. It will not be sent again.");
    return new RemoteDeliveryJournal({ generation: operation.generation, identity: id, workspaceId: workspace.id, threadId: targetThread,
      attemptId: id.attemptId, messageId: id.messageId, permission, owner: { kind: "workflow", runId, handle, threadId: targetThread },
      isCurrent: () => !stopped && isCurrent(), assertAllowed: assertCurrent,
      validateGrant: (grant) => {
        assertCurrent();
        if (!grant?.work || !grant.view || !workspaceAllowed(workspace, grant) || remotePermission(permission, grant) !== permission
          || kind === "command" && !grant.capabilities.terminal) throw new HostReadError("forbidden", "This workflow step lost its grant.");
      } });
  }
  const execution: RemoteWorkflowExecution = {
    get finished() { return terminal; }, get ownerHandle() { return handle; }, get ownerRunId() { return runId; }, get provenance() { return runId ? { ...remoteProvenance(operation, "workflow", runId), permissionCeiling: permission } : undefined; }, assertCurrent,
    async begin(workflow, project, id) {
      assertCurrent();
      if (project.id !== workspace.id || project.path !== workspace.path || !operation.delivery.openOwner) throw new HostReadError("stale_target", "This workflow's target changed.");
      if (Object.keys(variables).some((key) => !workflow.variables?.some((variable) => variable.name === key))) throw new HostReadError("unsupported", "Only this workflow's host-defined inputs may be supplied.");
      const model = sources.getProviderCatalog().find((provider) => provider.id === workflow.run.provider)?.models.find((model) => model.id === workflow.run.model);
      if (!model) throw new HostReadError("unsupported", "This workflow's saved model is not in the other device's catalog.");
      permission = remotePermission(workflow.run.permission, currentWorkGrant(sources, operation.identity.device));
      if (sources.getSettings().permission === "read-only" || operation.context.effectiveSettings.permission === "read-only") permission = "read-only";
      else if (operation.context.effectiveSettings.permission === "ask" && permission === "full") permission = "ask";
      run = { ...workflow.run, permission, subagentsEnabled: false };
      runId = id;
      handle = await operation.delivery.openOwner("workflow", id);
      const preparation = await step("prepare", "prompt");
      return { run, preparation };
    },
    async admitted() {
      assertCurrent(); await flushPendingStateWrites();
      await operation.delivery.accepted({});
      if (operation.delivery.result().state !== "accepted") throw new HostReadError("uncertain", "This workflow admission was not confirmed.");
      admitted = true; resolve({ runId: runId! });
    },
    async bindThread(id) {
      assertCurrent();
      if (run?.provider !== "claude" && run?.provider !== "cursor") { await operation.delivery.bindOwner?.(id); threadBound = true; }
      threadId = id;
      rememberRemoteEngineOwner({ generation: operation.generation, kind: "workflow", threadId: id, runId: runId!, ownerHandle: handle! });
      await operation.delivery.accepted({ threadId: id });
    },
    step: (id, kind, target) => step(id, kind, target),
    stepAccepted(id) { if (id !== threadId) throw new HostReadError("stale_target", "This workflow's provider thread changed."); threadBound = true; },
    async finish() {
      if (terminal) return true;
      stopped = true;
      if (!admitted) reject(new HostReadError("unsupported", "The other device couldn't admit the workflow."));
      if (!handle) { terminal = true; return true; }
      if (!threadId) rememberRemoteEngineOwner({ generation: operation.generation, kind: "workflow", threadId: `preparing:${runId}`, runId: runId!, ownerHandle: handle });
      terminal = await finishRemoteEngineOwner(handle);
      return terminal;
    },
    failed(reason) { if (!admitted) reject(reason); },
  };
  return { execution, admission, retired() { stopped = true; terminal = true; if (handle) remoteEngineStopped(handle); }, cancel() { stopped = true; } };
}

import { create } from "zustand";
import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import { rpc } from "../../codex";
import { projectRunExecCommand, sanitizeProjectRunCommand } from "../../projectRun";
import { checkOutputTail, sanitizeProjectCheckCommand } from "../../projectChecks";
import { shellCommandWithWindowsQuotes } from "../../shellCommand";
import { commandSandbox } from "../../turnConfig";
import { terminalSnapshotTail, terminalSnapshotText } from "../../terminalSnapshot";
import { nativeHostTransport, type HostTransport } from "./bridge";
import { operationStamp } from "./stateCommit";
import type { HostParityActions } from "./parityActions";
import type { HostContextSources } from "./hostContext";
import type { RemoteTurnDelivery } from "./workTypes";
import { finishRemoteEngineOwner, markRemoteEngineRetiring, rememberRemoteEngineOwner, remoteEngineStopped } from "./engineOwners";
import { HostReadError, idArg, workspaceAllowed } from "./scope";
import { nativeRefusal } from "./nativeActions";
import { remotePermission } from "./executionContext";
import type { WireParityRow } from "../wire";

type CommandKind = "run" | "checks";
interface CommandState {
  id: string; kind: CommandKind; workspaceId: string; threadId?: string; root: string; command: string;
  status: "starting" | "running" | "completed" | "failed" | "interrupted" | "uncertain";
  startedAt: number; finishedAt?: number; output?: string; exitCode?: number;
}
/** Host-only shared state. Native paths are never projected in a read response. */
export const useHostCommands = create<{ records: ReadonlyMap<string, CommandState> }>(() => ({ records: new Map() }));
// Reserve before owner_open yields: two viewers must not both pass the live-row
// check while neither native admission has returned yet.
const starting = new Set<string>();
const live = (state: CommandState) => state.status === "starting" || state.status === "running" || state.status === "uncertain";
export function hostCommandBusy(root: string, kind: CommandKind): boolean {
  return starting.has(JSON.stringify([root, kind])) || [...useHostCommands.getState().records.values()].some((record) => record.root === root && record.kind === kind && live(record));
}
/** Route only a client-owned process ID. Unknown/local output stays with the
 * existing terminal controller, never whichever remote thread is selected. */
export function appendHostCommandOutput(text: string, processId?: string): boolean {
  if (!processId?.startsWith("remote-command-")) return false;
  const id = processId.slice("remote-command-".length), record = useHostCommands.getState().records.get(id);
  if (!record) return false;
  update(id, { output: terminalSnapshotTail((record.output ?? "") + terminalSnapshotText(text.slice(-12000)), 12000) });
  return true;
}
function update(id: string, patch: Partial<CommandState>) {
  useHostCommands.setState(({ records }) => { const next = new Map(records), old = next.get(id); if (old) next.set(id, { ...old, ...patch }); return { records: next }; });
}
function trim() {
  useHostCommands.setState(({ records }) => {
    const next = new Map(records);
    for (const [id, record] of next) { if (next.size < 64) break; if (!live(record)) next.delete(id); }
    return { records: next };
  });
}
export function hostCommandRows(kind: CommandKind, context: TurnRunnerContext): WireParityRow[] {
  const workspaceId = context.activeWorkspace?.id, threadId = context.activeThread?.id;
  return [...useHostCommands.getState().records.values()].filter((record) => record.kind === kind && record.workspaceId === workspaceId && record.threadId === threadId)
    .slice(-8).reverse().map((record) => ({ id: record.id, name: kind === "run" ? "Run" : "Checks", status: record.status,
      createdAt: record.startedAt, ...(record.finishedAt === undefined ? {} : { updatedAt: record.finishedAt }), command: record.command,
      ...(record.output ? { text: record.output } : {}), ...(record.exitCode === undefined ? {} : { value: record.exitCode }) }));
}
interface OwnedCommand { state: CommandState; generation: number; ownerHandle: string; retired: boolean; finished: boolean }
/** Saved commands only. No command text/provider options accepted from a viewer. */
export function createHostCommandActions(sources: HostContextSources, isCurrent: () => boolean, transport: HostTransport = nativeHostTransport) {
  const owned = new Map<string, OwnedCommand>();
  let disposed = false;
  const execute: HostParityActions["execute"] = async (op, args, operation) => {
    const kind: CommandKind = op.startsWith("checks.") ? "checks" : "run";
    const context = operation.context, workspace = context.activeWorkspace!;
    const root = sources.executionPathFor(context.activeThread?.id ?? "", workspace.path);
    if (workspace.isChat || !root) throw new HostReadError("unsupported", "A saved project is required.");
    const current = () => {
      if (disposed || !isCurrent()) throw new HostReadError("host_unavailable", "This execution lifetime ended.");
      operation.delivery.assertAllowed();
      const grant = sources.getGrant(operation.identity.device);
      const project = sources.getWorkspaces().find((item) => item.id === workspace.id);
      if (!grant?.view || !grant.work || !grant.capabilities.terminal || !project || project.path !== workspace.path || !workspaceAllowed(project, grant)
        || sources.executionPathFor(context.activeThread?.id ?? "", project.path) !== root || remotePermission(context.effectiveSettings.permission, grant) !== context.effectiveSettings.permission) throw new HostReadError("forbidden", "This command's target or authority changed.");
      return project;
    };
    current();
    if (op.endsWith(".stop")) {
      const id = idArg(args.processHandle), command = owned.get(id);
      if (!command || command.state.kind !== kind || command.state.root !== root || command.state.workspaceId !== workspace.id || command.state.threadId !== context.activeThread?.id || command.generation !== operation.generation) throw new HostReadError("stale_target", "This exact command is no longer owned here.");
      command.retired = true; markRemoteEngineRetiring(command.ownerHandle);
      let result: { confirmed: boolean };
      try { result = await transport.invoke("remote_work_owner_retire", { stamp: operationStamp(operation), ownerHandle: command.ownerHandle }); }
      catch (reason) { update(id, { status: "uncertain" }); throw nativeRefusal(reason); }
      if (result?.confirmed !== true) { update(id, { status: "uncertain" }); throw new HostReadError("uncertain", "The command cutoff could not be confirmed."); }
      update(id, { status: "interrupted", finishedAt: Date.now() }); remoteEngineStopped(command.ownerHandle); owned.delete(id);
      return { state: "accepted", processHandle: id };
    }
    const recipe = kind === "run" ? sanitizeProjectRunCommand(current().overrides?.run) : sanitizeProjectCheckCommand(current().overrides?.check);
    if (!recipe) throw new HostReadError("unsupported", "No host command is saved for this action.");
    // The native token is a process cutoff proof, not a UI command-slot lock.
    // Do not start a second server/check beside an untracked local controller.
    if (!sources.isLocalCommandRunning) throw new HostReadError("unsupported", "The host's shared command lifecycle is not attached.");
    if (sources.isLocalCommandRunning(root, kind)) throw new HostReadError("busy", "This checkout already has a local command.");
    const recipeIdentity = JSON.stringify(recipe);
    const slot = JSON.stringify([root, kind]);
    if (starting.has(slot)) throw new HostReadError("busy", "This checkout already has a starting command.");
    for (const record of useHostCommands.getState().records.values()) if (record.root === root && record.kind === kind && live(record)) throw new HostReadError("busy", "This checkout already has a live command.");
    trim();
    if (useHostCommands.getState().records.size >= 64 || !operation.delivery.openOwner || !operation.delivery.childStep) throw new HostReadError("busy", "No execution slot is available.");
    const id = crypto.randomUUID();
    starting.add(slot);
    let ownerHandle: string;
    try { ownerHandle = await operation.delivery.openOwner("start", id, context.activeThread?.id); }
    catch (reason) { starting.delete(slot); throw reason instanceof HostReadError ? reason : nativeRefusal(reason); }
    const state: CommandState = { id, kind, workspaceId: workspace.id, ...(context.activeThread ? { threadId: context.activeThread.id } : {}), root, command: recipe.command, status: "starting", startedAt: Date.now() };
    const command: OwnedCommand = { state, generation: operation.generation, ownerHandle, retired: false, finished: false };
    owned.set(id, command);
    rememberRemoteEngineOwner({ generation: operation.generation, threadId: `command:${id}`, runId: id, kind: "start", ownerHandle });
    useHostCommands.setState(({ records }) => ({ records: new Map(records).set(id, state) }));
    starting.delete(slot);
    let child: RemoteTurnDelivery | undefined;
    try {
      child = await operation.delivery.childStep("command", context.activeThread?.id, "command");
      const project = current();
      if (sources.isLocalCommandRunning(root, kind)) throw new HostReadError("busy", "A local command claimed this checkout before dispatch.");
      if (JSON.stringify(kind === "run" ? sanitizeProjectRunCommand(project.overrides?.run) : sanitizeProjectCheckCommand(project.overrides?.check)) !== recipeIdentity) throw new HostReadError("stale_target", "This saved command changed before dispatch.");
      await child.beforeDispatch({ threadId: context.activeThread?.id ?? "", messageId: child.messageId, provider: "openai", permission: context.effectiveSettings.permission });
      current();
      const completion = rpc<{ exitCode: number; stdout?: string; stderr?: string }>("command/exec", {
        command: kind === "run" ? projectRunExecCommand(recipe) : shellCommandWithWindowsQuotes(recipe.command), processId: `remote-command-${id}`, cwd: root,
        outputBytesCap: 65536, tty: kind === "run", streamStdoutStderr: kind === "run",
        ...(kind === "checks" ? { timeoutMs: 300_000 } : { disableTimeout: true }),
        sandboxPolicy: commandSandbox(context.effectiveSettings.permission, root), remoteDelivery: child.metadata(),
      });
      const settle = completion.then(async (result) => {
        command.finished = true;
        if (!command.retired) { const output = checkOutputTail(terminalSnapshotText(result.stdout ?? ""), terminalSnapshotText(result.stderr ?? "")).output || useHostCommands.getState().records.get(id)?.output; update(id, { status: result.exitCode === 0 ? "completed" : "failed", finishedAt: Date.now(), exitCode: result.exitCode, output }); }
        await child!.accepted({ threadId: context.activeThread?.id });
        if (!command.retired && await finishRemoteEngineOwner(ownerHandle, transport)) owned.delete(id);
        return true;
      }, async (reason) => {
        command.finished = true; await child!.failure(reason);
        if (!command.retired) update(id, { status: child!.result().state === "uncertain" ? "uncertain" : "failed", finishedAt: Date.now() });
        return false;
      });
      void settle.catch(() => undefined);
      // Native records acceptance at the input boundary, before command exit.
      const until = Date.now() + 15_000;
      while (!command.finished && Date.now() < until) {
        const receipt = await transport.invoke<{ disposition: string }>("remote_work_recover", { generation: operation.generation, ...child.identity });
        if (receipt?.disposition === "accepted") break;
        if (receipt?.disposition === "rejected" || receipt?.disposition === "uncertain") throw new HostReadError("uncertain", "This command admission could not be confirmed.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!command.finished && Date.now() >= until || command.finished && useHostCommands.getState().records.get(id)?.status === "uncertain") throw new HostReadError("uncertain", "This command may still be starting. Inspect its existing handle.");
      const completed = useHostCommands.getState().records.get(id);
      if (command.finished && completed?.status === "failed" && completed.exitCode === undefined) throw new HostReadError(child.result().error?.code ?? "uncertain", "The command was not confirmed at the native boundary.");
      if (!command.finished) update(id, { status: "running" });
      return { state: "accepted", processHandle: id };
    } catch (reason) {
      if (child) await child.failure(reason);
      const outcome = child?.result().state;
      // A late recovery refusal cannot downgrade the exact child's stronger
      // receipt into a safely retryable root rejection.
      if (outcome === "accepted") return { state: "accepted", processHandle: id };
      const uncertain = outcome === "uncertain";
      if (!command.retired) update(id, { status: uncertain ? "uncertain" : "failed", finishedAt: Date.now() });
      if (!uncertain && !command.retired && await finishRemoteEngineOwner(ownerHandle, transport)) owned.delete(id);
      if (uncertain) throw new HostReadError("uncertain", "This command may have run. Inspect its existing handle before starting another.");
      throw reason;
    }
  };
  return { execute, dispose() { disposed = true; /* Native lease loss fences pending writes and cuts exact owned commands. */ } };
}

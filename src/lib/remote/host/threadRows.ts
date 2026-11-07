import type { Thread } from "../../../types";
import { recoverRemoteStateRows, withRemoteStateCommit } from "../../storage";
import { sidebarThread } from "../../threadList";
import { providerFromThread } from "../../threadProvider";
import { runtimeModelProviderId } from "../../providerIds";
import { threadRuntimeConfig } from "../../turnConfig";
import { mythraCodeDeveloperInstructions } from "../../completionPrompt";
import { adoptRemoteQueuedTurns, adoptRemoteThreadRemoval, useTaskStore } from "../../taskStore";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostContextSources } from "./hostContext";
import type { HostMutationContext } from "./workActions";
import { HostReadError, idArg } from "./scope";
import { nativeRefusal } from "./nativeActions";
import { operationStamp, registerRemoteStateRecovery, type StampedRow } from "./stateCommit";

export type ThreadRowOperation = "thread.rename" | "thread.archive" | "thread.restore" | "thread.delete" | "thread.fork";
const operations = new Set<string>(["thread.rename", "thread.archive", "thread.restore", "thread.delete", "thread.fork"]);
export const isThreadRowOperation = (op: string): op is ThreadRowOperation => operations.has(op);
const commonKeys = ["kiwi.knownThreads", "kiwi.threadProjects", "kiwi.archivedThreads", "kiwi.threadWorktrees"];
const settingsKeys = ["kiwi.threadModels", "kiwi.threadReasoning", "kiwi.threadSubagentSettings", "kiwi.threadExecutionPreferences"];
export function threadRowKeys(op: ThreadRowOperation): readonly string[] {
  return op === "thread.fork" ? [...commonKeys, ...settingsKeys] : op === "thread.delete"
    ? [...commonKeys, ...settingsKeys, "kiwi.pinnedThreads", "kiwi.queuedTurns", "kiwi.parentRuns", "kiwi.checkpoints", "kiwi.checkpointHeads", "kiwi.turnDurations", "kiwi.threadPullRequests"] : commonKeys;
}
export interface ThreadRowChange {
  op: ThreadRowOperation; previous: Thread; threadId: string; thread?: Thread;
  /** Already committed/adopted native rows, for host-only refs and presentation. */
  rows: readonly StampedRow[];
}
/** App supplies the SAME title/transcript/removal ownership used by sidebar
 * actions. No provider RPCs or ordinary persistence writes in committed(). */
export interface ThreadRowLease {
  prepare(): Promise<void>;
  assertAllowed(): void;
  committed(change: ThreadRowChange): void | Promise<void>;
  release(): void;
}
export interface ThreadRowLifecycle {
  /** Synchronous reservation, before title cancellation or any native await. */
  begin(op: ThreadRowOperation, thread: Thread, operation: HostMutationContext): ThreadRowLease;
}
interface NativeResult {
  result: { opId: string; state: string; threadId?: string; workspaceId?: string };
  rows: StampedRow[]; thread?: Thread | null; replayed?: boolean;
}
const active = new Set<string>();
function exactRows(rows: readonly StampedRow[], keys: readonly string[]): void {
  if (!Array.isArray(rows) || rows.length !== keys.length || new Set(rows.map((row) => row.key)).size !== keys.length
    || keys.some((key) => !rows.some((row) => row.key === key))) throw new HostReadError("uncertain", "The native conversation bookkeeping was incomplete.");
}
function missing(reason: unknown): boolean { return typeof reason === "string" && /not found|unknown command/i.test(reason); }
/** Provider effect uses the installed typed native wrapper for the exact same
 * sidebar operations (name/set, archive, unarchive, delete, fork and local
 * transcript metadata). The journal is a latch, never an RPC retry permission. */
export async function executeThreadRow(op: ThreadRowOperation, args: Readonly<Record<string, unknown>>, operation: HostMutationContext,
  sources: HostContextSources, lifecycle: ThreadRowLifecycle, transport: HostTransport = nativeHostTransport): Promise<{ state: "accepted"; threadId: string; workspaceId: string }> {
  const previous = operation.context.activeThread, workspace = operation.context.activeWorkspace;
  if (!previous || !workspace || previous.id !== args.threadId) throw new HostReadError("stale_target", "This conversation is no longer available.");
  const id = previous.id, provider = providerFromThread(previous, operation.context.effectiveSettings.provider);
  if (op === "thread.rename" && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 256 || /[\u0000-\u001f]/.test(args.name))) throw new HostReadError("unsupported", "A valid conversation name is required.");
  if (op === "thread.delete" && args.confirmed !== true) throw new HostReadError("unsupported", "Permanent deletion must be confirmed.");
  if (op === "thread.fork" && (provider === "claude" || provider === "cursor")) throw new HostReadError("unsupported", "This provider's conversations cannot be forked.");
  if (active.has(id)) throw new HostReadError("busy", "Another row action is changing this conversation.");
  operation.assertAllowed();
  active.add(id);
  let lease: ThreadRowLease | undefined, retainLease = false;
  try {
    lease = lifecycle.begin(op, previous, operation);
    const root = sources.executionPathFor(id, workspace.path);
    const check = () => {
      operation.assertAllowed(); lease!.assertAllowed();
      if (sources.executionPathFor(id, workspace.path) !== root) throw new HostReadError("stale_target", "This conversation changed its checkout.");
      const task = useTaskStore.getState().tasks[id];
      if (op !== "thread.rename" && (task?.status === "starting" || task?.status === "running" || useTaskStore.getState().workflowOwners[id])) throw new HostReadError("busy", "Finish or stop this conversation before changing it.");
    };
    check(); await lease.prepare(); check();
    if (op === "thread.fork") { await operation.context.ensureSkillRoots(); check(); }
    const keys = threadRowKeys(op), stamp = operationStamp(operation);
    return await withRemoteStateCommit(keys, async (adopt) => {
      check();
      let snapshot: { version: number; rows: StampedRow[] };
      try { snapshot = await transport.invoke("remote_thread_snapshot", { stamp, provider, root }); }
      catch (reason) { if (missing(reason)) throw new HostReadError("unsupported", "This device has not installed stamped conversation effects yet."); throw nativeRefusal(reason); }
      if (snapshot.version !== 1) throw new HostReadError("unsupported", "This device uses a different conversation bookkeeping version.");
      exactRows(snapshot.rows, keys); check();
      const context = operation.context, settings = context.effectiveSettings, modelProvider = runtimeModelProviderId(provider);
      const nativeArgs = op === "thread.rename" ? { name: String(args.name).trim() } : op === "thread.delete" ? { confirmed: true }
        : op === "thread.fork" ? { model: settings.model, ...(modelProvider ? { modelProvider } : {}),
          config: threadRuntimeConfig({ ...settings, subagentsEnabled: false }, { customAgents: context.customAgents,
            modelContextWindow: provider === "openrouter" ? context.openRouterModels.find((entry) => entry.id === settings.model)?.context_length
              : provider === "lmstudio" ? context.lmStudioModels?.find((entry) => entry.id === settings.model)?.maxContextLength : undefined }),
          baseInstructions: "", developerInstructions: mythraCodeDeveloperInstructions(false),
          reasoning: { reasoningEffort: settings.reasoningEffort, ultra: settings.ultra }, autoCompactTokens: settings.autoCompactTokens } : {};
      const invokeArgs = { stamp, provider, root, args: nativeArgs, bookkeeping: { version: 1, rows: snapshot.rows } };
      const apply = async (reply: NativeResult, recover: boolean) => {
        if (reply.result?.opId !== stamp.opId || reply.result.state !== "accepted" || reply.result.workspaceId !== workspace.id) throw new HostReadError("uncertain", "This conversation mutation could not be confirmed.");
        const threadId = idArg(reply.result.threadId);
        if (op === "thread.fork" ? threadId === id : threadId !== id) throw new HostReadError("uncertain", "This conversation mutation returned another target.");
        exactRows(reply.rows, keys);
        const known = reply.rows.find((row) => row.key === "kiwi.knownThreads")?.value as Record<string, Thread> | null;
        const thread = known?.[threadId] ?? (reply.thread?.id === threadId ? reply.thread : undefined);
        if ((op === "thread.rename" || op === "thread.restore" || op === "thread.fork") && (!thread || thread.id !== threadId)) throw new HostReadError("uncertain", "The committed conversation identity was missing.");
        if (!recover) for (const row of reply.rows) adopt(row.key, row.value);
        if (op === "thread.delete") {
          adoptRemoteQueuedTurns(reply.rows.find((row) => row.key === "kiwi.queuedTurns")?.value);
        }
        await lease!.committed({ op, previous, threadId, ...(thread ? { thread: sidebarThread(thread) } : {}), rows: reply.rows });
        // Match local deletion order: invalidate identity/release child routes
        // while their resident records still exist, then discard the task.
        if (op === "thread.delete") adoptRemoteThreadRemoval(id);
        // Recovery releases deferred local intents. Publish raw host refs first
        // so those intents cannot rebase over pre-commit sidebar identities.
        if (recover) recoverRemoteStateRows(reply.rows);
        return { state: "accepted" as const, threadId, workspaceId: workspace.id };
      };
      let attempted = false;
      try {
        check(); attempted = true;
        const reply = await transport.invoke<NativeResult>("remote_thread_execute", invokeArgs);
        return await apply(reply, false);
      } catch (reason) {
        if (missing(reason)) throw new HostReadError("unsupported", "This device has not installed stamped conversation effects yet.");
        const refusal = reason instanceof HostReadError ? reason : nativeRefusal(reason);
        // A native refusal AFTER its provider input latch is ambiguous, even if
        // a later metadata CAS reports stale_target. Ask its durable receipt.
        if (attempted && refusal.code !== "uncertain") {
          try {
            const receipt = await transport.invoke<{ disposition: string }>("remote_work_recover", { generation: operation.generation, ...operation.identity });
            if (receipt.disposition === "preparing" || receipt.disposition === "rejected") throw Object.assign(refusal, { definitelyNotApplied: true });
          } catch (error) { if (error && typeof error === "object" && "definitelyNotApplied" in error) throw error; }
        } else if (!attempted) throw refusal;
        retainLease = true;
        registerRemoteStateRecovery(`${stamp.device}:${stamp.opId}`, async () => {
          const replay = await transport.invoke<NativeResult>("remote_thread_execute", invokeArgs);
          if (replay.replayed !== true) throw new HostReadError("uncertain", "The original conversation effect still needs reconciliation.");
          await apply(replay, true); lease!.release(); active.delete(id);
        });
        throw Object.assign(new HostReadError("uncertain", "This conversation may already have changed. Check it before trying again."), { holdRemoteState: true });
      }
    });
  } finally { if (!retainLease) { lease?.release(); active.delete(id); } }
}

import type { ChatMessage, Thread } from "../../../types";
import { recoverRemoteStateRows, withRemoteStateCommit } from "../../storage";
import { rpc, runtimeThreadState } from "../../codex";
import { timelineFromTurns } from "../../threadTimeline";
import { drainTaskDeltas } from "../../taskStore";
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
/** History changes go through the same native effect, with the same ownership. */
export type ThreadEffectOperation = ThreadRowOperation | "thread.compact" | "thread.rollback";
export function threadRowKeys(op: ThreadEffectOperation): readonly string[] {
  return op === "thread.rollback" ? [...commonKeys, "kiwi.agentQuestions"] : op === "thread.fork" ? [...commonKeys, "kiwi.checkpoints", ...settingsKeys] : op === "thread.delete"
    ? [...commonKeys, ...settingsKeys, "kiwi.pinnedThreads", "kiwi.queuedTurns", "kiwi.parentRuns", "kiwi.checkpoints", "kiwi.checkpointHeads", "kiwi.turnDurations", "kiwi.threadPullRequests",
      "kiwi.childAgentPolicies", "kiwi.childAgentLinks", "kiwi.nativeAgentLinks", "kiwi.childAgentMailbox", "kiwi.threadHandoffs", "kiwi.pendingHandoff", "kiwi.agentQuestions", "kiwi.turnContextReceipts"] : commonKeys;
}
export interface ThreadRowChange {
  op: ThreadEffectOperation; previous: Thread; threadId: string; thread?: Thread;
  /** The provider's rolled-back thread with its turns, for this machine's own timeline. */
  history?: Thread;
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
  begin(op: ThreadEffectOperation, thread: Thread, operation: HostMutationContext): ThreadRowLease;
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
interface BatchResult {
  result: { opId: string; state: string; workspaceId?: string; completedThreadIds?: unknown; remainingThreadIds?: unknown };
  rows: StampedRow[]; replayed?: boolean;
}
export const THREAD_BATCH_LIMIT = 100;
/** Archive all and Delete all: one journal root, with native giving every thread its
 * own receipt. What finished is shown as finished, and the rest stays where it was. */
export async function executeThreadBatch(op: "thread.archiveMany" | "thread.deleteMany", threads: readonly Thread[], operation: HostMutationContext,
  sources: HostContextSources, lifecycle: ThreadRowLifecycle, transport: HostTransport = nativeHostTransport): Promise<{ state: "accepted"; workspaceId: string }> {
  const workspace = operation.context.activeWorkspace, single = op === "thread.archiveMany" ? "thread.archive" as const : "thread.delete" as const;
  if (!workspace || !threads.length || threads.length > THREAD_BATCH_LIMIT) throw new HostReadError("unsupported", "Choose between 1 and 100 conversations.");
  const ids = threads.map((thread) => thread.id);
  if (ids.some((id) => active.has(id))) throw new HostReadError("busy", "Another row action is changing one of these conversations.");
  operation.assertAllowed();
  const leases = new Map<string, ThreadRowLease>();
  let retain = false;
  for (const id of ids) active.add(id);
  try {
    for (const thread of threads) leases.set(thread.id, lifecycle.begin(single, thread, operation));
    const roots = new Map(threads.map((thread) => [thread.id, sources.executionPathFor(thread.id, workspace.path)]));
    const check = () => {
      operation.assertAllowed();
      for (const thread of threads) {
        leases.get(thread.id)!.assertAllowed();
        if (sources.executionPathFor(thread.id, workspace.path) !== roots.get(thread.id)) throw new HostReadError("stale_target", "A conversation changed its checkout.");
        const task = useTaskStore.getState().tasks[thread.id];
        if (task?.status === "starting" || task?.status === "running" || useTaskStore.getState().workflowOwners[thread.id]) throw new HostReadError("busy", "Finish or stop these conversations first.");
      }
    };
    for (const lease of leases.values()) await lease.prepare();
    check();
    const keys = threadRowKeys(single), stamp = operationStamp(operation);
    const targets = threads.map((thread) => ({ threadId: thread.id, provider: providerFromThread(thread, operation.context.effectiveSettings.provider), root: roots.get(thread.id)! }));
    const outcome = await withRemoteStateCommit(keys, async (adopt) => {
      check();
      let snapshot: { version: number; rows: StampedRow[] };
      try { snapshot = await transport.invoke("remote_thread_batch_snapshot", { stamp }); }
      catch (reason) { if (missing(reason)) throw new HostReadError("unsupported", "This device has not installed stamped batches yet."); throw nativeRefusal(reason); }
      if (snapshot.version !== 1) throw new HostReadError("unsupported", "This device uses a different conversation bookkeeping version.");
      exactRows(snapshot.rows, keys); check();
      const invokeArgs = { stamp, targets, args: op === "thread.deleteMany" ? { confirmed: true } : {}, bookkeeping: { version: 1, rows: snapshot.rows } };
      const apply = async (reply: BatchResult, recover: boolean) => {
        if (reply.result?.opId !== stamp.opId || reply.result.workspaceId !== workspace.id) throw new HostReadError("uncertain", "This batch could not be confirmed.");
        exactRows(reply.rows, keys);
        const list = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && leases.has(id)) : [];
        const completed = list(reply.result.completedThreadIds), remaining = list(reply.result.remainingThreadIds);
        if (!recover) for (const row of reply.rows) adopt(row.key, row.value);
        if (op === "thread.deleteMany") adoptRemoteQueuedTurns(reply.rows.find((row) => row.key === "kiwi.queuedTurns")?.value);
        for (const thread of threads) if (completed.includes(thread.id)) {
          await leases.get(thread.id)!.committed({ op: single, previous: thread, threadId: thread.id, rows: reply.rows });
          if (op === "thread.deleteMany") adoptRemoteThreadRemoval(thread.id);
        }
        if (recover) recoverRemoteStateRows(reply.rows);
        return { accepted: reply.result.state === "accepted" && !remaining.length, remaining: remaining.length };
      };
      let attempted = false;
      try {
        check(); attempted = true;
        return await apply(await transport.invoke<BatchResult>("remote_thread_batch_execute", invokeArgs), false);
      } catch (reason) {
        if (missing(reason)) throw new HostReadError("unsupported", "This device has not installed stamped batches yet.");
        if (!attempted) throw reason instanceof HostReadError ? reason : nativeRefusal(reason);
        retain = true;
        registerRemoteStateRecovery(`${stamp.device}:${stamp.opId}`, async () => {
          const replay = await transport.invoke<BatchResult>("remote_thread_batch_execute", invokeArgs);
          if (replay.replayed !== true) throw new HostReadError("uncertain", "The original batch still needs reconciliation.");
          await apply(replay, true);
          for (const lease of leases.values()) lease.release();
          for (const id of ids) active.delete(id);
        });
        throw Object.assign(new HostReadError("uncertain", "These conversations may already have changed. Check them before trying again."), { holdRemoteState: true });
      }
    });
    if (!outcome.accepted) throw new HostReadError("uncertain", `${outcome.remaining} of these conversations may not have changed. Check them before trying again.`);
    return { state: "accepted", workspaceId: workspace.id };
  } finally {
    if (!retain) { for (const lease of leases.values()) lease.release(); for (const id of ids) active.delete(id); }
  }
}

export async function executeThreadRow(op: ThreadEffectOperation, args: Readonly<Record<string, unknown>>, operation: HostMutationContext,
  sources: HostContextSources, lifecycle: ThreadRowLifecycle, transport: HostTransport = nativeHostTransport): Promise<{ state: "accepted"; threadId: string; workspaceId: string }> {
  const previous = operation.context.activeThread, workspace = operation.context.activeWorkspace;
  if (!previous || !workspace || previous.id !== args.threadId) throw new HostReadError("stale_target", "This conversation is no longer available.");
  const id = previous.id, provider = providerFromThread(previous, operation.context.effectiveSettings.provider);
  if (op === "thread.rename" && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 256 || /[\u0000-\u001f]/.test(args.name))) throw new HostReadError("unsupported", "A valid conversation name is required.");
  if (op === "thread.delete" && args.confirmed !== true) throw new HostReadError("unsupported", "Permanent deletion must be confirmed.");
  if ((op === "thread.fork" || op === "thread.compact" || op === "thread.rollback") && (provider === "claude" || provider === "cursor")) throw new HostReadError("unsupported", "This provider manages its own history; this action is not supported.");
  if (op === "thread.rollback" && args.confirmed !== true) throw new HostReadError("unsupported", "Undoing the last turn must be confirmed.");
  const expectedMessageId = args.messageId;
  if (expectedMessageId !== undefined && useTaskStore.getState().tasks[id]?.messages.at(-1)?.id !== expectedMessageId) throw new HostReadError("stale_target", "The last exchange changed.");
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
    if (op === "thread.compact") {
      const runtime = await runtimeThreadState(id); check();
      sources.onRemoteCodexRuntimeOwned(id, runtime.instance);
    }
    if (op === "thread.fork") { await operation.context.ensureSkillRoots(); check(); }
    const keys = threadRowKeys(op), stamp = operationStamp(operation);
    return await withRemoteStateCommit(keys, async (adopt) => {
      check();
      let snapshot: { version: number; rows: StampedRow[] };
      try { snapshot = await transport.invoke("remote_thread_snapshot", { stamp, provider, root }); }
      catch (reason) { if (missing(reason)) throw new HostReadError("unsupported", "This device has not installed stamped conversation effects yet."); throw nativeRefusal(reason); }
      if (snapshot.version !== 1) throw new HostReadError("unsupported", "This device uses a different conversation bookkeeping version.");
      exactRows(snapshot.rows, keys); check();
      if (op === "thread.fork" && args.checkpointId !== undefined) {
        const records = snapshot.rows.find((row) => row.key === "kiwi.checkpoints")?.value;
        const checkpoint = Array.isArray(records) ? records.find((row) => row?.id === args.checkpointId && row.threadId === id) : undefined;
        if (!checkpoint) throw new HostReadError("stale_target", "This checkpoint is no longer available for this conversation.");
        if (typeof checkpoint.turnId !== "string" || !checkpoint.turnId) throw new HostReadError("checkpoint_turn_unavailable", "This older checkpoint has no saved conversation turn, so it cannot be forked. Choose a checkpoint with a saved turn or fork the latest conversation.");
      }
      const context = operation.context, settings = context.effectiveSettings, modelProvider = runtimeModelProviderId(provider);
      const nativeArgs = op === "thread.rollback" ? { confirmed: true, numTurns: 1 } : op === "thread.rename" ? { name: String(args.name).trim() } : op === "thread.delete" ? { confirmed: true }
        : op === "thread.fork" ? { ...(args.checkpointId !== undefined ? { checkpointId: idArg(args.checkpointId) } : {}), model: settings.model, ...(modelProvider ? { modelProvider } : {}),
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
        // Rollback is authoritative replacement, not a paged history merge:
        // removed questions and optimistic rows must not reappear from cache.
        let rolledBack: Thread | undefined;
        if (op === "thread.rollback") {
          rolledBack = reply.thread?.id === id && Array.isArray(reply.thread.turns) ? reply.thread
            : (await rpc<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: true })).thread;
          if (rolledBack.id !== id || !Array.isArray(rolledBack.turns)) throw new HostReadError("uncertain", "The changed conversation history could not be loaded.");
          // Do not overwrite a locally started turn while reconciling a reply.
          const live = useTaskStore.getState().tasks[id];
          if (live?.status === "running" || live?.status === "starting") throw new HostReadError("uncertain", "This conversation started again while its history was being reconciled.");
        }
        if (!recover) for (const row of reply.rows) adopt(row.key, row.value);
        if (op === "thread.delete") {
          adoptRemoteQueuedTurns(reply.rows.find((row) => row.key === "kiwi.queuedTurns")?.value);
        }
        if (rolledBack) {
          drainTaskDeltas();
          const history = timelineFromTurns(rolledBack.turns, { includeContextCompaction: provider === "openai" });
          // RPC forms are not in provider history. Restore ONLY the question
          // records in this native rollback's pruned rows, including on replay
          // while the old local cache is still fenced awaiting adoption.
          const records = reply.rows.find((row) => row.key === "kiwi.agentQuestions")?.value as Record<string, { threadId?: string; message?: ChatMessage }> | null;
          const ids = new Set(history.messages.map((message) => message.id)), ends = new Map<string, number>();
          let end = 0;
          for (const entry of [...history.messages, ...history.activities]) {
            end = Math.max(end, entry.timelineOrder ?? 0);
            if (entry.turnId) ends.set(entry.turnId, Math.max(ends.get(entry.turnId) ?? 0, entry.timelineOrder ?? 0));
          }
          const missing = Object.values(records ?? {}).flatMap((record) => record.threadId === id && record.message && !ids.has(record.message.id) ? [record.message] : []);
          const messages = [...history.messages, ...missing.map((message, index) => ({ ...message, timelineOrder: (ends.get(message.turnId ?? "") ?? end) + (index + 1) / (missing.length + 1) }))]
            .sort((a, b) => (a.timelineOrder ?? 0) - (b.timelineOrder ?? 0));
          useTaskStore.getState().hydrateTask(id, messages, history.activities, root,
            { nextCursor: null, hasMore: false, loading: false, paginated: false }, undefined, { preserveUnread: true, replaceTimeline: true });
        }
        await lease!.committed({ op, previous, threadId, ...(thread ? { thread: sidebarThread(thread) } : {}), ...(rolledBack ? { history: rolledBack } : {}), rows: reply.rows });
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

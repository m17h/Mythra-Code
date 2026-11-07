import type { ChildAgentLink } from "../../childAgents";
import type { ChildMailbox } from "../../childAgentMailbox";
import type { SubAgentWorker } from "../../subAgentActivity";
import type { HostParityActions } from "./parityActions";
import { commitHostState } from "./stateCommit";
import { HostReadError } from "./scope";
import { useTaskStore } from "../../taskStore";
import { childReviewToken } from "../../../hooks/useChildAgents";
import type { HostResources } from "./resources";
import type { HostContextSources } from "./hostContext";
export interface AgentAcceptanceLease {
  /** Same reservation/pending-follow-up/recovery checks as local acceptChild. */
  prepare(): Promise<void>; assertAllowed(): void; release(): void;
  /** Host-only raw-ref/resource notification; no provider call or blind save. */
  committed(childId: string): void;
}
export interface HostAgentLifecycle {
  /** Reservation is synchronous, before native recovery/preparation awaits. */
  beginAcceptance(rootThreadId: string, worker: SubAgentWorker): AgentAcceptanceLease;
  /** Shared generations/slot settlement with a supplied stamped cutoff only. */
  stopWorker?(rootThreadId: string, worker: SubAgentWorker, cutoff: () => Promise<import("../../taskStore").TaskStatus>, assertAllowed: () => void): Promise<void>;
}
type Operation = Parameters<HostParityActions["execute"]>[2];
/** Pure form of the local cancelQueued -> resolve outcomes -> close questions
 * sign-off. It changes no message into answered/read and never sends guidance. */
export function acceptedMailbox(mailbox: ChildMailbox, now: number): ChildMailbox {
  let through = Math.max(mailbox.undeliveredSeq ?? 0, mailbox.resolvedThroughSeq ?? 0, ...mailbox.messages.filter((entry) => entry.direction === "toChild" && (entry.state === "failed" || entry.state === "cancelled")).map((entry) => Number(entry.id.slice(1)) || 0));
  const messages = mailbox.messages.map((entry) => {
    if (entry.direction === "toChild" && entry.state === "queued") {
      through = Math.max(through, Number(entry.id.slice(1)) || 0);
      return { ...entry, state: "cancelled" as const, settledAt: now, reason: "Cancelled because the user accepted the sub-agent's work." };
    }
    if (entry.direction === "toParent" && entry.kind === "question" && !entry.answeredAt && !entry.closedAt) return { ...entry, closedAt: now };
    return entry;
  });
  return { ...mailbox, messages, undeliveredSeq: through, resolvedThroughSeq: through };
}
/** Shared local reservation is mandatory: a settled status alone does not prove
 * the absence of a preparing/follow-up child hidden in useChildAgents refs. */
export async function acceptHostAgent(args: Readonly<Record<string, unknown>>, operation: Operation,
  sources: HostContextSources, resources: HostResources): Promise<{ state: "accepted"; threadId: string }> {
  const root = operation.context.activeThread!.id, worker = resources.resolveWorker(String(args.target), operation.identity.device, root);
  if (worker.id !== args.agentId || worker.kind !== "cross-provider" || !worker.reviewToken || worker.review === "accepted") throw new HostReadError("stale_target", "Collect this sub-agent's current settled result before accepting it.");
  const lease = sources.getAgentLifecycle?.()?.beginAcceptance(root, worker);
  if (!lease) throw new HostReadError("unsupported", "This device's shared sub-agent sign-off lifecycle is not attached.");
  const check = () => {
    operation.assertAllowed(); lease.assertAllowed();
    const current = resources.resolveWorker(String(args.target), operation.identity.device, root);
    if (current.id !== worker.id || current.reviewToken !== worker.reviewToken || ["unknown", "starting", "working"].includes(current.status)) throw new HostReadError("stale_target", "This sub-agent started or changed its result.");
    if (["starting", "running"].includes(useTaskStore.getState().statuses[worker.id] ?? "idle")) throw new HostReadError("busy", "This sub-agent is still working.");
  };
  let retained = false;
  try {
    check(); await lease.prepare(); check();
    await commitHostState({ ...operation, assertAllowed: check }, ["kiwi.childAgentLinks", "kiwi.childAgentMailbox"], (rows) => {
      const links = rows.find((row) => row.key === "kiwi.childAgentLinks")!.value as Record<string, ChildAgentLink> | null;
      const mailboxes = rows.find((row) => row.key === "kiwi.childAgentMailbox")!.value as Record<string, ChildMailbox> | null;
      const link = links?.[worker.id], mailbox = mailboxes?.[worker.id];
      if (!link || link.rootThreadId !== root || link.signoff !== "required" || link.acceptedAt || link.activationPending || childReviewToken(link) !== worker.reviewToken
        || mailbox && mailbox.rootThreadId !== root || mailbox?.messages.some((entry) => entry.direction === "toChild" && entry.state === "delivering")) throw new HostReadError("stale_target", "The saved child assignment or guidance changed before sign-off.");
      const now = Date.now();
      return { "kiwi.childAgentLinks": { ...links, [worker.id]: { ...link, acceptedAt: now, acceptedBy: "user" } },
        "kiwi.childAgentMailbox": { ...mailboxes, ...(mailbox ? { [worker.id]: acceptedMailbox(mailbox, now) } : {}) } };
    }, { adopt: () => { if (retained) { lease.committed(worker.id); lease.release(); } } });
    lease.committed(worker.id);
    return { state: "accepted", threadId: root };
  } catch (reason) {
    retained = Boolean(reason && typeof reason === "object" && "holdRemoteState" in reason);
    throw reason;
  } finally { if (!retained) lease.release(); }
}

import type { AgentRecord } from "../components/StudioDock";
import type { ChildAgentLink } from "./childAgents";
import type { NativeAgentLink } from "./nativeAgentLinks";
import { isActiveAgentRecord } from "./subAgentActivity";
import type { TaskStatus } from "./taskStore";

/**
 * Ownership discovered from thread history is not an execution observation.
 * Unlike archive safety, runtime refresh must not invent an active "unknown"
 * status for a link this runtime has never observed. Keep explicit unresolved
 * observations, including after renderer reload. The native reservation also
 * supplies current-process child IDs, so missing renderer events cannot make
 * an actually observed child look like ownership-only imported history.
 * Live thread starting/running states are checked separately by the caller,
 * which can exempt only its own provisional preparation.
 */
export function nativeRuntimeRestartBlocker(input: {
  nativeLinks: Record<string, NativeAgentLink>;
  managedLinks: Record<string, ChildAgentLink>;
  statuses: Record<string, TaskStatus>;
  tasks: Record<string, { agents: readonly AgentRecord[] }>;
  /** Captured atomically with the native restart reservation, for final preflight. */
  observedNativeThreadIds?: ReadonlySet<string>;
}): string | null {
  const isCodex = (id: string, record: { runtime?: string; provider?: string }) => {
    // Managed roster rows can omit provider/runtime. Their ownership link is
    // authoritative; an untagged Claude/Cursor row must not become Codex work.
    const managed = input.managedLinks[id];
    if (managed) return managed.provider !== "claude" && managed.provider !== "cursor";
    const native = input.nativeLinks[id];
    const runtime = native?.runtime ?? record.runtime;
    const provider = native?.provider ?? record.provider;
    return runtime !== "claude" && provider !== "claude" && provider !== "cursor";
  };
  const unresolved = (id: string, observedStatus: string | undefined) => {
    const taskStatus = input.statuses[id];
    // An observed terminal task takes precedence over an older roster/link.
    // Seeded idle, in contrast, is not proof that a worker finished.
    if (taskStatus === "completed" || taskStatus === "interrupted" || taskStatus === "error") return false;
    return observedStatus === undefined
      ? input.observedNativeThreadIds?.has(id) === true
      : isActiveAgentRecord(observedStatus);
  };
  for (const task of Object.values(input.tasks)) {
    for (const agent of task.agents) {
      if (isCodex(agent.id, agent) && unresolved(agent.id, agent.status)) return agent.id;
    }
  }
  for (const link of Object.values(input.nativeLinks)) {
    if (!isCodex(link.childThreadId, link)) continue;
    const record = input.tasks[link.rootThreadId]?.agents.find((agent) => agent.id === link.childThreadId);
    if (unresolved(link.childThreadId, record?.status ?? link.status)) return link.childThreadId;
  }
  return null;
}

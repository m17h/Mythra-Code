import { describe, expect, it } from "vitest";
import {
  collectSubAgentWorkers,
  createClaudeCommandWorkerReconciler,
  describeSubAgentActivity,
  isActiveAgentRecord,
  isSubAgentWorkerActive,
  knownClaudeCommandWorkerIds,
  subAgentStatusLabel,
  summarizeSubAgentWorkers,
  workerStatusFromAgentRecord,
  workerStatusFromLifecycle,
} from "./subAgentActivity";
import type { ChildAgentLink } from "./childAgents";
import type { TaskStatus } from "./taskStore";
import type { AgentRecord } from "../components/StudioDock";
import type { Activity } from "../types";
import type { NativeAgentLink } from "./nativeAgentLinks";

function link(overrides: Partial<ChildAgentLink> = {}): ChildAgentLink {
  return {
    childThreadId: "child-1",
    rootThreadId: "root-1",
    sessionId: "session-1",
    targetId: "reviewer",
    provider: "claude",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    title: "Review the diff",
    createdAt: 1_000,
    ...overrides,
  };
}

function links(...entries: ChildAgentLink[]): Record<string, ChildAgentLink> {
  return Object.fromEntries(entries.map((entry) => [entry.childThreadId, entry]));
}

describe("workerStatusFromLifecycle", () => {
  it("maps the bridge lifecycle vocabulary onto worker states", () => {
    expect(workerStatusFromLifecycle("running")).toBe("working");
    expect(workerStatusFromLifecycle("starting")).toBe("starting");
    expect(workerStatusFromLifecycle("completed")).toBe("completed");
    expect(workerStatusFromLifecycle("cancelled")).toBe("cancelled");
    expect(workerStatusFromLifecycle("failed")).toBe("failed");
  });

  it("settles an unrecognised word to idle rather than guessing", () => {
    expect(workerStatusFromLifecycle("teleporting")).toBe("idle");
  });
});

describe("workerStatusFromAgentRecord", () => {
  it("accepts the words the providers actually emit", () => {
    expect(workerStatusFromAgentRecord("inProgress")).toBe("working");
    expect(workerStatusFromAgentRecord("started")).toBe("working");
    expect(workerStatusFromAgentRecord("working")).toBe("working");
    expect(workerStatusFromAgentRecord("interacted")).toBe("working");
    expect(workerStatusFromAgentRecord("starting")).toBe("starting");
    expect(workerStatusFromAgentRecord("completed")).toBe("completed");
    expect(workerStatusFromAgentRecord("interrupted")).toBe("cancelled");
    expect(workerStatusFromAgentRecord("failed")).toBe("failed");
    expect(workerStatusFromAgentRecord("errored")).toBe("failed");
    expect(workerStatusFromAgentRecord("notFound")).toBe("failed");
    expect(workerStatusFromAgentRecord("pendingInit")).toBe("starting");
    expect(workerStatusFromAgentRecord("shutdown")).toBe("cancelled");
  });

  it("retains unknown native status until evidence proves the worker settled", () => {
    expect(workerStatusFromAgentRecord("percolating")).toBe("unknown");
    expect(isSubAgentWorkerActive(workerStatusFromAgentRecord("percolating"))).toBe(true);
  });
});

describe("isActiveAgentRecord", () => {
  // The run boundary, the concurrency budget, and Stop all read this, so every
  // word a provider might use for live work has to agree across the three.
  it.each(["starting", "pending", "queued", "running", "working", "interacted", "inProgress", "inprogress"])(
    "treats %s as live work",
    (status) => expect(isActiveAgentRecord(status)).toBe(true),
  );

  it.each(["completed", "failed", "cancelled", "interrupted", "idle"])(
    "treats %s as settled",
    (status) => expect(isActiveAgentRecord(status)).toBe(false),
  );
});

describe("collectSubAgentWorkers", () => {
  const statuses: Record<string, TaskStatus> = { "child-1": "running" };

  it("has nothing to show before a thread exists", () => {
    expect(collectSubAgentWorkers({ rootThreadId: null, links: links(link()), statuses, agents: [] })).toEqual([]);
  });

  it("derives cross-provider children from links and live task state", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root-1", links: links(link()), statuses, agents: [] });
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      id: "child-1",
      kind: "cross-provider",
      status: "working",
      title: "Review the diff",
      targetId: "reviewer",
      provider: "claude",
      detail: "Claude · claude-fable-5",
    });
  });

  it("decodes entity-escaped titles from persisted and native workers", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(link({ title: "Story &amp; content audit" })),
      statuses,
      agents: [{ id: "native-1", prompt: "Economy &#38; progression audit", status: "working" }],
    });
    expect(workers.map((worker) => worker.title)).toEqual([
      "Story & content audit",
      "Economy & progression audit",
    ]);
  });

  it("ignores children belonging to a different root thread", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(link({ childThreadId: "other", rootThreadId: "root-2" })),
      statuses: {},
      agents: [],
    });
    expect(workers).toEqual([]);
  });

  it("falls back to the persisted outcome when this process has no task", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(link({ terminalStatus: "failed" })),
      statuses: {},
      agents: [],
    });
    expect(workers[0].status).toBe("failed");
  });

  it("treats an unterminated link from an earlier process as unknown", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root-1", links: links(link()), statuses: {}, agents: [] });
    expect(workers[0].status).toBe("unknown");
  });

  it("includes native provider agents the root task reported", () => {
    const agents: AgentRecord[] = [{ id: "native-1", prompt: "Write tests", status: "inProgress", path: "openai · gpt-5.6-terra" }];
    const workers = collectSubAgentWorkers({ rootThreadId: "root-1", links: {}, statuses: {}, agents });
    expect(workers).toEqual([expect.objectContaining({
      id: "native-1",
      kind: "native",
      status: "working",
      title: "Write tests",
      detail: "openai · gpt-5.6-terra",
    })]);
  });

  it("does not claim that a native child used its parent's model", () => {
    const agents: AgentRecord[] = [{ id: "native-1", prompt: "Delegated task", status: "inProgress" }];
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: {},
      statuses: {},
      agents,
      nativeLinks: { "native-1": { childThreadId: "native-1", rootThreadId: "root-1", title: "Port the parser", createdAt: 4_000 } },
      nativeProvider: "openai",
      nativeModel: "gpt-5.6-terra",
    });
    expect(workers).toEqual([expect.objectContaining({
      id: "native-1",
      kind: "native",
      status: "working",
      title: "Port the parser",
      provider: "openai",
      detail: "OpenAI · provider managed",
      createdAt: 4_000,
    })]);
  });

  it("keeps a native worktree path after the provider and model, not instead of them", () => {
    const agents: AgentRecord[] = [{ id: "native-1", prompt: "Write tests", status: "inProgress", path: "/managed/worktrees/native-1" }];
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: {},
      statuses: {},
      agents,
      nativeProvider: "openai",
      nativeModel: "gpt-5.6-terra",
    });
    expect(workers[0].detail).toBe("OpenAI · provider managed · /managed/worktrees/native-1");
  });

  it("restores the entire native descendant roster with unknown status and real model evidence", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, agents: [], nativeProvider: "openai", nativeLinks: {
      child: { childThreadId: "child", rootThreadId: "root", title: "Review", model: "actual-child", runtime: "codex", createdAt: 1 },
      nested: { childThreadId: "nested", rootThreadId: "child", title: "Investigate", runtime: "codex", createdAt: 2 },
    } });
    expect(workers).toHaveLength(2);
    expect(workers.find((worker) => worker.id === "child")).toMatchObject({ model: "actual-child", status: "unknown" });
    expect(summarizeSubAgentWorkers(workers).active).toBe(2);
  });

  it("restores bounded task/progress/result readout without inventing an actual model", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, agents: [], nativeProvider: "openai", nativeModel: "parent-model", nativeLinks: {
      child: { childThreadId: "child", rootThreadId: "root", title: "Review", task: "Actual assignment", progress: "Inspecting adapters", result: "Failure details", requestedModel: "requested-child", runtime: "codex", status: "failed", createdAt: 1 },
    } });
    expect(workers[0]).toMatchObject({ task: "Actual assignment", progress: "Inspecting adapters", result: "Failure details", requestedModel: "requested-child", status: "failed", detail: "OpenAI · provider managed" });
    expect(workers[0].model).toBeUndefined();
  });

  it("keeps native activation identity through restoration and prefers a newer live activation", () => {
    const input = { rootThreadId: "root", links: {}, statuses: {}, nativeLinks: {
      child: { childThreadId: "child", rootThreadId: "root", title: "Review", createdAt: 1, activationId: "saved-operation" },
    } };
    expect(collectSubAgentWorkers({ ...input, agents: [] })[0].activationId).toBe("saved-operation");
    expect(collectSubAgentWorkers({ ...input, agents: [{ id: "child", prompt: "Review", status: "running", activationId: "new-operation" }] })[0].activationId).toBe("new-operation");
    expect(collectSubAgentWorkers({ ...input, agents: [{ id: "child", prompt: "Review", status: "running" }] })[0].activationId).toBe("saved-operation");
  });

  it("does not resurrect prior durable execution evidence after the live activation explicitly clears it", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, nativeLinks: {
      child: { childThreadId: "child", rootThreadId: "root", title: "Review", createdAt: 1, activationId: "old", model: "old-executed", modelSource: "execution", requestedModel: "old-requested", progress: "Old progress", result: "Old result" },
    }, agents: [{ id: "child", prompt: "Fresh task", status: "starting", activationId: "new", model: "", requestedModel: "", progress: "", result: "" }] });
    expect(workers[0]).toMatchObject({ activationId: "new", requestedModel: "", progress: "", result: "" });
    expect(workers[0].model).toBeUndefined();
    expect(workers[0].modelSource).toBeUndefined();
  });

  it("does not offer fake Claude child sessions or independent cutoff", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, agents: [
      { id: "claude-native:root:tool", prompt: "Review", status: "running", runtime: "claude", provider: "claude", model: "actual-model" },
    ] });
    expect(workers[0]).toMatchObject({ detail: "Claude · actual-model", canOpen: false, canStop: false });
  });

  it("excludes positively identified legacy Claude command workers without deleting durable links", () => {
    const id = "claude-native:root:shell-tool";
    const durable: NativeAgentLink = { childThreadId: id, rootThreadId: "root", rootTurnId: "old-turn", runtime: "claude", provider: "claude", title: "Development server", createdAt: 1, status: "running" };
    const nativeLinks = { [id]: durable };
    const rootActivities: Activity[] = [{ id: "shell-tool", kind: "command", title: "npm run dev", status: "completed", turnId: "old-turn" }];
    const input = { rootThreadId: "root", links: {}, statuses: {}, nativeLinks, rootActivities, runStartedAt: 100 };
    expect(collectSubAgentWorkers({ ...input, agents: [] })).toEqual([]);
    expect(knownClaudeCommandWorkerIds({ ...input, agents: [] })).toEqual([id]);
    expect(collectSubAgentWorkers({ ...input, agents: [{ id, prompt: "Development server", runtime: "claude", rootTurnId: "old-turn", status: "running" }] })).toEqual([]);
    expect(nativeLinks[id]).toBe(durable);
    expect(nativeLinks[id].status).toBe("running");
    expect(knownClaudeCommandWorkerIds({ ...input, agents: [], nativeLinks: { [id]: { ...durable, rootTurnId: undefined } } })).toEqual([]);
  });

  it.each([
    { runtime: undefined, rootTurnId: "old-turn", commandTurnId: "old-turn", commandId: "shell-tool" },
    { runtime: "codex" as const, rootTurnId: "old-turn", commandTurnId: "old-turn", commandId: "shell-tool" },
    { runtime: "claude" as const, rootTurnId: undefined, commandTurnId: "old-turn", commandId: "shell-tool" },
    { runtime: "claude" as const, rootTurnId: "old-turn", commandTurnId: "other-turn", commandId: "shell-tool" },
    { runtime: "claude" as const, rootTurnId: "old-turn", commandTurnId: "old-turn", commandId: "other-tool" },
  ])("preserves a worker when runtime, turn or command identity lacks exact proof: %j", ({ runtime, rootTurnId, commandTurnId, commandId }) => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, agents: [
      { id: "claude-native:root:shell-tool", runtime, rootTurnId, prompt: "Reported work", status: "running" },
    ], rootActivities: [{ id: commandId, kind: "command", title: "npm run dev", turnId: commandTurnId }] });
    expect(workers).toHaveLength(1);
    expect(workers[0].status).toBe("working");
  });

  it.each([
    { rootThreadId: "foreign-root", runtime: "claude" as const, rootTurnId: "turn" },
    { rootThreadId: "root", runtime: "codex" as const, rootTurnId: "turn" },
    { rootThreadId: "root", runtime: "claude" as const, rootTurnId: "different-turn" },
  ])("preserves conflicting ownership evidence rather than trusting a command-shaped root record: %j", (ownership) => {
    const id = "claude-native:root:shared-tool";
    const input = { rootThreadId: "root", links: {}, statuses: {}, agents: [
      { id, runtime: "claude" as const, rootTurnId: "turn", prompt: "Reported work", status: "running" },
    ], nativeLinks: {
      [id]: { childThreadId: id, title: "Durable work", createdAt: 1, status: "running", ...ownership },
    }, rootActivities: [{ id: "shared-tool", kind: "command" as const, title: "Command evidence", turnId: "turn" }] };
    expect(knownClaudeCommandWorkerIds(input)).toEqual([]);
    expect(collectSubAgentWorkers(input)).toEqual([expect.objectContaining({ id, status: "working" })]);
  });

  it.each(["turn", "another-turn", undefined])("preserves positive Agent evidence on turn %s even when a command ID conflicts", (agentTurnId) => {
    const id = "claude-native:root:shared-tool";
    const workers = collectSubAgentWorkers({ rootThreadId: "root", links: {}, statuses: {}, agents: [], nativeLinks: {
      [id]: { childThreadId: id, rootThreadId: "root", rootTurnId: "turn", runtime: "claude", title: "Actual review", task: "Review ownership", createdAt: 1, status: "running" },
    }, rootActivities: [
      { id: "shared-tool", kind: "command", title: "Conflicting command", turnId: "turn" },
      { id: "positive-agent", kind: "agent", title: "Actual Agent", turnId: agentTurnId, agent: { action: "spawn", provider: "claude", threadIds: [id] } },
    ] });
    expect(workers).toEqual([expect.objectContaining({ id, status: "working", task: "Review ownership" })]);
  });

  it("never lists the root thread as one of its own workers", () => {
    // A reversed ownership record and a self-referential agent record are both
    // runtime artifacts; either one would otherwise burn a concurrency slot and
    // show the user's own conversation as a third agent.
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(link({ childThreadId: "root-1" })),
      statuses: { "root-1": "running" },
      agents: [{ id: "root-1", prompt: "Delegated task", status: "inProgress" }],
    });
    expect(workers).toEqual([]);
    expect(summarizeSubAgentWorkers(workers).active).toBe(0);
  });

  it("counts exactly the configured number of children, excluding the root", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(
        link({ childThreadId: "child-1", createdAt: 1_000 }),
        link({ childThreadId: "child-2", createdAt: 2_000 }),
      ),
      statuses: { "root-1": "running", "child-1": "running", "child-2": "running" },
      agents: [{ id: "root-1", prompt: "Delegated task", status: "inProgress" }],
    });
    expect(summarizeSubAgentWorkers(workers).active).toBe(2);
  });

  it("does not count a cross-provider child twice when it is mirrored onto the root", () => {
    const agents: AgentRecord[] = [{ id: "child-1", prompt: "Review the diff", status: "inProgress" }];
    const workers = collectSubAgentWorkers({ rootThreadId: "root-1", links: links(link()), statuses, agents });
    expect(workers).toHaveLength(1);
    expect(workers[0].kind).toBe("cross-provider");
  });

  it("does not let a late mirrored result from the previous run reappear", () => {
    const old = link({ childThreadId: "old-child", createdAt: 100 });
    const agents: AgentRecord[] = [{ id: "old-child", prompt: "Old task", status: "failed" }];
    expect(collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(old),
      statuses: { "old-child": "error" },
      agents,
      runStartedAt: 200,
    })).toEqual([]);
  });

  it("keeps an older child visible when it is still actively editing", () => {
    const old = link({ childThreadId: "old-child", createdAt: 100 });
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(old),
      statuses: { "old-child": "running" },
      agents: [],
      runStartedAt: 200,
    });
    expect(workers).toEqual([expect.objectContaining({ id: "old-child", status: "working" })]);
  });

  it("keeps live work at the top and settles terminal work below it", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(
        link({ childThreadId: "done", terminalStatus: "completed", createdAt: 5_000 }),
        link({ childThreadId: "busy", createdAt: 1_000 }),
        link({ childThreadId: "broke", terminalStatus: "failed", createdAt: 4_000 }),
      ),
      statuses: { busy: "running" },
      agents: [],
    });
    expect(workers.map((worker) => worker.id)).toEqual(["busy", "broke", "done"]);
  });
});

describe("summarizeSubAgentWorkers", () => {
  it("counts each state and treats starting plus working as holding a slot", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(
        link({ childThreadId: "a" }),
        link({ childThreadId: "b" }),
        link({ childThreadId: "c", terminalStatus: "completed" }),
        link({ childThreadId: "d", terminalStatus: "failed" }),
      ),
      statuses: { a: "running", b: "starting" },
      agents: [],
    });
    expect(summarizeSubAgentWorkers(workers)).toEqual({
      total: 4, active: 2, starting: 1, working: 1, completed: 1, cancelled: 0, failed: 1,
    });
  });
});

describe("describeSubAgentActivity", () => {
  it("says so plainly when nothing has run", () => {
    expect(describeSubAgentActivity(summarizeSubAgentWorkers([]))).toBe("No sub-agents yet");
  });

  it("leads with live work", () => {
    const workers = collectSubAgentWorkers({
      rootThreadId: "root-1",
      links: links(
        link({ childThreadId: "a" }),
        link({ childThreadId: "b", terminalStatus: "completed" }),
        link({ childThreadId: "c", terminalStatus: "failed" }),
      ),
      statuses: { a: "running" },
      agents: [],
    });
    expect(describeSubAgentActivity(summarizeSubAgentWorkers(workers))).toBe("1 working · 1 failed · 1 done");
  });
});

it("preserves reported child-model evidence even when its launch is outside the loaded page", () => {
  const id = "claude-native:root:shell-tool";
  const input = { rootThreadId: "root", agents: [], rootActivities: [{ id: "shell-tool", kind: "command" as const, title: "Conflicting command", turnId: "turn" }], nativeLinks: {
    [id]: { childThreadId: id, rootThreadId: "root", rootTurnId: "turn", runtime: "claude" as const, title: "Reported child", createdAt: 1, status: "running", model: "reported-model", modelSource: "execution" as const },
  } };
  expect(knownClaudeCommandWorkerIds(input)).toEqual([]);
  expect(collectSubAgentWorkers({ ...input, links: {}, statuses: {} })).toEqual([expect.objectContaining({ id, model: "reported-model" })]);
});

describe("subAgentStatusLabel", () => {
  it("gives every state a readable word", () => {
    expect(subAgentStatusLabel("working")).toBe("Working");
    expect(subAgentStatusLabel("starting")).toBe("Starting");
    expect(subAgentStatusLabel("completed")).toBe("Completed");
    expect(subAgentStatusLabel("cancelled")).toBe("Stopped");
    expect(subAgentStatusLabel("failed")).toBe("Failed");
    expect(subAgentStatusLabel("idle")).toBe("Idle");
  });
});

describe("Claude command-worker migration cache", () => {
  const agent = { id: "claude-native:root:shell-tool", runtime: "claude" as const, rootTurnId: "turn", status: "unknown", prompt: "Possible worker" };
  const reasoning: Activity = { id: "thinking", kind: "reasoning", title: "Thinking", turnId: "turn", detail: "Initial" };
  const command: Activity = { id: "shell-tool", kind: "command", title: "npm test", turnId: "turn" };

  it("updates exact proof after same-count replacement and removal", () => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const input = { rootThreadId: "root", agents: [agent] };
    expect(reconcile({ ...input, rootActivities: [reasoning] })).toEqual([]);
    expect(reconcile({ ...input, rootActivities: [command] })).toEqual([agent.id]);
    expect(reconcile({ ...input, rootActivities: [{ ...command, turnId: "other" }] })).toEqual([]);
    expect(reconcile({ ...input, rootActivities: [] })).toEqual([]);
    expect(reconcile({ ...input, rootActivities: [{ ...command, id: "other-tool" }] })).toEqual([]);
  });

  it("retains positive Agent evidence and checks newly introduced candidates", () => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const positive: Activity = { id: "actual-agent", kind: "agent", title: "Review", agent: { action: "spawn", threadIds: [agent.id] } };
    const input = { rootThreadId: "root", agents: [agent] };
    expect(reconcile({ ...input, rootActivities: [positive, command] })).toEqual([]);
    expect(reconcile({ ...input, rootActivities: [command] })).toEqual([]);
    const newAgent = { ...agent, id: "claude-native:root:new-shell-tool" };
    expect(reconcile({ ...input, agents: [agent, newAgent], rootActivities: [command, { ...command, id: "new-shell-tool" }] })).toEqual([newAgent.id]);
  });

  it("vetoes cached command proof when an Agent replaces its row", () => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const input = { rootThreadId: "root", agents: [agent] };
    expect(reconcile({ ...input, rootActivities: [command] })).toEqual([agent.id]);
    const positive: Activity = { ...command, kind: "agent", agent: { action: "spawn", threadIds: [agent.id] } };
    expect(reconcile({ ...input, rootActivities: [positive] })).toEqual([]);
    expect(reconcile({ ...input, rootActivities: [command] })).toEqual([]);
  });

  it("indexes existing command proof when a native candidate is introduced later", () => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const rootActivities = [command];
    expect(reconcile({ rootThreadId: "root", agents: [], rootActivities })).toEqual([]);
    expect(reconcile({ rootThreadId: "root", agents: [agent], rootActivities })).toEqual([agent.id]);
    expect(reconcile({ rootThreadId: "root", agents: [{ ...agent, model: "reported-model", modelSource: "execution" }], rootActivities })).toEqual([]);
  });

  it("does not revisit unchanged proof rows for repeated reasoning details", () => {
    let proofReads = 0;
    const unrelated = { ...command, id: "unrelated", get kind() { proofReads++; return "command" as const; } };
    const reconcile = createClaudeCommandWorkerReconciler();
    const input = { rootThreadId: "root", agents: [agent] };
    expect(reconcile({ ...input, rootActivities: [unrelated, reasoning] })).toEqual([]);
    const initialReads = proofReads;
    for (let index = 0; index < 100; index++) {
      expect(reconcile({ ...input, rootActivities: [unrelated, { ...reasoning, detail: String(index) }] })).toEqual([]);
    }
    expect(proofReads).toBe(initialReads);
  });

  it.each([false, true])("retains an Agent page before a cleanup candidate exists, execution-model veto: %s", (executionModelVeto) => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const positive: Activity = { id: "actual-agent", kind: "agent", title: "Review", agent: { action: "spawn", threadIds: [agent.id] } };
    const initialAgents: AgentRecord[] = executionModelVeto ? [{ ...agent, model: "reported-model", modelSource: "execution" }] : [];
    expect(reconcile({ rootThreadId: "root", agents: initialAgents, rootActivities: [positive] })).toEqual([]);
    expect(reconcile({ rootThreadId: "root", agents: [agent], rootActivities: [command] })).toEqual([]);
  });

  it("shares retained positive proof with the worker collector after its page leaves", () => {
    const reconcile = createClaudeCommandWorkerReconciler();
    const positive: Activity = { id: "actual-agent", kind: "agent", title: "Review", agent: { action: "spawn", threadIds: [agent.id] } };
    reconcile({ rootThreadId: "root", agents: [], rootActivities: [positive] });
    const protectedNativeAgentIds = reconcile.protectedAgentIds;
    const input = { rootThreadId: "root", agents: [agent], rootActivities: [command], protectedNativeAgentIds };
    expect(knownClaudeCommandWorkerIds(input)).toEqual([]);
    expect(collectSubAgentWorkers({ ...input, links: {}, statuses: {} })).toEqual([expect.objectContaining({ id: agent.id, status: "unknown" })]);
  });

  it.each([2, 100])("retains transient positive pages across %s queued history revisions", (revisions) => {
    const reconcile = createClaudeCommandWorkerReconciler("root");
    reconcile({ rootThreadId: "root", agents: [], rootActivities: [reasoning] });
    const positive: Activity = { id: "actual-agent", kind: "agent", title: "Review", agent: { action: "spawn", threadIds: [agent.id] } };
    reconcile.observeActivities([positive]);
    for (let index = 0; index < revisions; index++) reconcile.observeActivities([command, { ...reasoning, detail: String(index) }]);
    expect(reconcile({ rootThreadId: "root", agents: [agent], rootActivities: [command] })).toEqual([]);
    expect(reconcile.protectedAgentIds.has(agent.id)).toBe(true);
  });

  it("makes queued proof available to an immediate settings guard without destructive matching", () => {
    const reconcile = createClaudeCommandWorkerReconciler("root");
    const positive: Activity = { id: "actual-agent", kind: "agent", title: "Review", agent: { action: "spawn", threadIds: [agent.id] } };
    reconcile.observeActivities([positive]);
    reconcile.observeActivities([command]);
    reconcile.flushObservedActivities();
    const workers = collectSubAgentWorkers({ rootThreadId: "root", agents: [agent], rootActivities: [command], links: {}, statuses: {}, protectedNativeAgentIds: reconcile.protectedAgentIds });
    expect(workers).toEqual([expect.objectContaining({ id: agent.id, status: "unknown" })]);
  });
});

import { describe, expect, it } from "vitest";
import {
  collectSubAgentWorkers,
  describeSubAgentActivity,
  isActiveAgentRecord,
  isSubAgentWorkerActive,
  subAgentStatusLabel,
  summarizeSubAgentWorkers,
  workerStatusFromAgentRecord,
  workerStatusFromLifecycle,
} from "./subAgentActivity";
import type { ChildAgentLink } from "./childAgents";
import type { TaskStatus } from "./taskStore";
import type { AgentRecord } from "../components/StudioDock";

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

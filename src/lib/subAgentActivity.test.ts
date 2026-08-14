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
  });

  it("never inflates the live count with an unknown provider word", () => {
    expect(workerStatusFromAgentRecord("percolating")).toBe("idle");
    expect(isSubAgentWorkerActive(workerStatusFromAgentRecord("percolating"))).toBe(false);
  });
});

describe("isActiveAgentRecord", () => {
  // The run boundary, the concurrency budget, and Stop all read this, so every
  // word a provider might use for live work has to agree across the three.
  it.each(["starting", "pending", "queued", "running", "working", "interacted", "inProgress", "inprogress"])(
    "treats %s as live work",
    (status) => expect(isActiveAgentRecord(status)).toBe(true),
  );

  it.each(["completed", "failed", "cancelled", "interrupted", "something-else"])(
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

  it("treats an unterminated link from an earlier process as cancelled", () => {
    const workers = collectSubAgentWorkers({ rootThreadId: "root-1", links: links(link()), statuses: {}, agents: [] });
    expect(workers[0].status).toBe("cancelled");
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
    expect(subAgentStatusLabel("cancelled")).toBe("Cancelled");
    expect(subAgentStatusLabel("failed")).toBe("Failed");
    expect(subAgentStatusLabel("idle")).toBe("Idle");
  });
});

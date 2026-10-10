import { describe, expect, it } from "vitest";
import { autoArchiveSubagentCandidates, nativeArchiveActivity } from "./subAgentArchive";
import type { NativeAgentLink } from "./nativeAgentLinks";

const links = {
  "child-done": { rootThreadId: "root" },
  "child-live": { rootThreadId: "root" },
};

function nativeLink(childThreadId: string, rootThreadId = "root", status?: string): NativeAgentLink {
  return { childThreadId, rootThreadId, title: "Native task", createdAt: 1, runtime: "codex", ...(status ? { status } : {}) };
}

describe("automatic sub-agent archiving", () => {
  it("selects only settled children when their parent finishes", () => {
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root",
      links,
      statuses: { root: "completed", "child-done": "completed", "child-live": "running" },
    })).toEqual(["child-done"]);
  });

  it("selects a child that finishes after its parent", () => {
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "child-live",
      links,
      statuses: { root: "completed", "child-live": "completed" },
    })).toEqual(["child-live"]);
  });

  it("does not archive a child while its parent is still working", () => {
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "child-done",
      links,
      statuses: { root: "running", "child-done": "completed" },
    })).toEqual([]);
  });

  it("does not select a thread already in Archived", () => {
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root",
      links,
      statuses: { root: "completed", "child-done": "completed", "child-live": "completed" },
      archivedThreadIds: ["child-done"],
    })).toEqual(["child-live"]);
  });

  it.each(["starting", "running", "unknown"])('retains an idle native child with %s worker evidence after its parent completes', (status) => {
    const nativeLinks = { child: nativeLink("child", "root", status) };
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root", links: nativeLinks, nativeLinks,
      statuses: { root: "completed", child: "idle" },
    })).toEqual([]);
    expect(nativeArchiveActivity({ threadId: "child", nativeLinks, statuses: { child: "idle" } }).activeSelf).toBe(true);
  });

  it("retains restored native children whose status has never been confirmed", () => {
    const nativeLinks = { child: nativeLink("child") };
    expect(autoArchiveSubagentCandidates({ completedThreadId: "root", links: nativeLinks, nativeLinks, statuses: {} })).toEqual([]);
  });

  it("uses current parent records before older durable telemetry", () => {
    const nativeLinks = { child: nativeLink("child", "root", "completed") };
    expect(nativeArchiveActivity({
      threadId: "child", nativeLinks, statuses: { child: "idle" },
      agentRecordsByThread: { root: [{ id: "child", prompt: "Native task", status: "starting", runtime: "codex" }] },
    }).activeSelf).toBe(true);
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root", links: nativeLinks, nativeLinks, statuses: {},
      agentRecordsByThread: { root: [{ id: "child", prompt: "Native task", status: "completed", runtime: "codex" }] },
    })).toEqual(["child"]);
  });

  it.each(["completed", "interrupted", "error"] as const)("accepts confirmed child task %s over stale active telemetry", (status) => {
    const nativeLinks = { child: nativeLink("child", "root", "running") };
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root", links: nativeLinks, nativeLinks, statuses: { child: status },
      agentRecordsByThread: { root: [{ id: "child", prompt: "Native task", status: "starting", runtime: "codex" }] },
    })).toEqual(["child"]);
  });

  it("does not archive a settled native ancestor whose nested child remains unresolved", () => {
    const nativeLinks = { child: nativeLink("child", "root", "completed"), nested: nativeLink("nested", "child", "unknown") };
    expect(autoArchiveSubagentCandidates({
      completedThreadId: "root", links: nativeLinks, nativeLinks, statuses: { root: "completed", child: "completed", nested: "idle" },
    })).toEqual([]);
    expect(nativeArchiveActivity({ threadId: "root", nativeLinks, statuses: { child: "completed" } }).activeDescendants).toBe(true);
  });

  it("includes settled nested native descendants in the root completion sweep", () => {
    const nativeLinks = { child: nativeLink("child", "root", "completed"), nested: nativeLink("nested", "child", "completed") };
    expect(autoArchiveSubagentCandidates({ completedThreadId: "root", links: nativeLinks, nativeLinks, statuses: {} })).toEqual(["child", "nested"]);
  });
});

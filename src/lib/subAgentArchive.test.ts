import { describe, expect, it } from "vitest";
import { autoArchiveSubagentCandidates } from "./subAgentArchive";

const links = {
  "child-done": { rootThreadId: "root" },
  "child-live": { rootThreadId: "root" },
};

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
});

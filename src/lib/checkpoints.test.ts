import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  checkpointIsRestorable,
  checkpointStatusLabel,
  completeCheckpointSnapshot,
  createCheckpointSnapshot,
  restoreCheckpointSnapshot,
  type CheckpointRecord,
} from "./checkpoints";

const checkpoint: CheckpointRecord = {
  id: "checkpoint-1",
  threadId: "thread-1",
  workspacePath: "/project",
  label: "Run: test checkpoints",
  createdAt: 1,
  status: "ready",
  beforeCommit: "before",
  afterCommit: "after",
};

describe("checkpoints", () => {
  beforeEach(() => invoke.mockReset());

  it("requires the completed snapshot only when restoring the after state", () => {
    expect(checkpointIsRestorable(checkpoint, "before")).toBe(true);
    expect(checkpointIsRestorable(checkpoint, "after")).toBe(true);
    expect(checkpointIsRestorable({ ...checkpoint, afterCommit: undefined }, "before")).toBe(true);
    expect(checkpointIsRestorable({ ...checkpoint, afterCommit: undefined }, "after")).toBe(false);
  });

  it("keeps acceptance reversible and separate from restore status labels", () => {
    expect(checkpointStatusLabel(checkpoint)).toBe("Ready");
    expect(checkpointStatusLabel({ ...checkpoint, accepted: true })).toBe("Accepted");
    expect(checkpointStatusLabel({ ...checkpoint, status: "restored-before" })).toBe("Restored before run");
    expect(checkpointStatusLabel({ ...checkpoint, status: "interrupted" })).toBe("Run interrupted");
    expect(checkpointStatusLabel({ ...checkpoint, status: "recovered" })).toBe("Recovered after restart");
  });

  it("uses dedicated native commands for before, after, and restore", async () => {
    invoke
      .mockResolvedValueOnce({ commit: "before", repoRoot: "/project", fileCount: 2 })
      .mockResolvedValueOnce({
        snapshot: { commit: "after", repoRoot: "/project", fileCount: 3 },
        changedFiles: 1,
        additions: 4,
        deletions: 2,
      })
      .mockResolvedValueOnce({ commit: "before", repoRoot: "/project", fileCount: 2 });

    await createCheckpointSnapshot("checkpoint-1", "/project", "before");
    await completeCheckpointSnapshot("checkpoint-1", "/project", "after");
    await restoreCheckpointSnapshot("checkpoint-1", "/project", "before", "safety-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "checkpoint_create", {
      id: "checkpoint-1",
      cwd: "/project",
      label: "before",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "checkpoint_complete", {
      id: "checkpoint-1",
      cwd: "/project",
      label: "after",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "checkpoint_restore", {
      id: "checkpoint-1",
      cwd: "/project",
      target: "before",
      safetyId: "safety-1",
    });
  });
});

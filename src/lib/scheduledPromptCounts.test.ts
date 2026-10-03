import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countScheduledPrompts, scheduledCountsLabel } from "./scheduledPromptCounts";
import type { QueuedTurn } from "./taskStore";
import type { NewThreadTimedPrompt } from "./newThreadTimedPrompts";

const emptyContext = { bindings: {}, knownThreads: {}, worktrees: {}, tasks: {} };
const turn = (id: string, threadId: string, fields: Partial<QueuedTurn> = {}): QueuedTurn => ({
  id, threadId, text: "Follow up", attachments: [], createdAt: 1, status: "queued", deliverAt: 2, ...fields,
});
const firstPrompt = (status: QueuedTurn["status"] = "queued") => ({ status } as NewThreadTimedPrompt);

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe("sidebar scheduled counts", () => {
  it("separates new conversations from pending thread prompts and normalizes workspace paths", () => {
    const counts = countScheduledPrompts([
      turn("future", "t"), turn("missed", "t", { missedAt: 3 }), turn("failed", "t", { status: "failed" }),
      turn("ordinary", "t", { deliverAt: undefined }), turn("released", "t", { releasedAt: 3 }),
    ], {
      "C:\\projects\\app\\": [firstPrompt(), firstPrompt("failed"), firstPrompt("sending")],
      "C:/projects/app": [firstPrompt()],
    }, { ...emptyContext, bindings: { t: "C:/projects/app/" } });
    expect(counts).toEqual({
      workspaces: { "C:/projects/app": { newConversations: 3, threadPrompts: 3 } },
      threads: { t: 3 },
    });
  });

  it("uses a logical binding then source worktree project before execution folders, without inventing unknown ownership", () => {
    const counts = countScheduledPrompts([turn("a", "bound"), turn("b", "isolated"), turn("c", "known"), turn("d", "loaded"), turn("e", "unknown")], {}, {
      bindings: { bound: "/project" },
      worktrees: { bound: { projectPath: "/wrong" }, isolated: { projectPath: "/project/" } },
      knownThreads: { bound: { cwd: "/wrong" }, isolated: { cwd: "/worktrees/isolated" }, known: { cwd: "/chats" } },
      tasks: { loaded: { workspacePath: "/chats/" } },
    });
    expect(counts.workspaces).toEqual({
      "/project": { newConversations: 0, threadPrompts: 2 },
      "/chats": { newConversations: 0, threadPrompts: 2 },
    });
    expect(counts.threads.unknown).toBe(1);
  });

  it("counts an unopened durable queue after restart, then removes a schedule count when released or deleted", async () => {
    localStorage.setItem("kiwi.queuedTurns", JSON.stringify({ closed: [turn("restored", "closed", { deliverAt: Date.now() + 60_000 })] }));
    vi.resetModules();
    const { storedPendingTimedTurns, useTaskStore } = await import("./taskStore");
    const context = { ...emptyContext, bindings: { closed: "/project" } };
    const count = () => countScheduledPrompts(storedPendingTimedTurns(), {}, context);
    expect(useTaskStore.getState().tasks.closed).toBeUndefined();
    expect(count().workspaces["/project"].threadPrompts).toBe(1);
    useTaskStore.getState().ensureTask("closed", "/project");
    // Hydration references the durable entry; it must not count it twice.
    expect(count().threads.closed).toBe(1);
    useTaskStore.getState().releaseTimedTurnNow("closed", "restored");
    expect(count().threads.closed).toBeUndefined();
    expect(count().workspaces["/project"]).toBeUndefined();
    useTaskStore.getState().rescheduleQueuedTurn("closed", "restored", Date.now() + 120_000);
    expect(count().threads.closed).toBe(1);
    useTaskStore.getState().removeQueuedTurn("closed", "restored");
    expect(count().threads.closed).toBeUndefined();
  });

  it("attributes archived schedules even after the active sidebar metadata was forgotten", () => {
    const counts = countScheduledPrompts([turn("missed", "archived", { missedAt: 3 })], {}, {
      ...emptyContext, archivedThreads: [{ id: "archived", path: "/project/" }],
    });
    expect(counts.workspaces["/project"].threadPrompts).toBe(1);
    expect(counts.threads.archived).toBe(1);
  });

  it("describes the two schedule scopes independently", () => {
    expect(scheduledCountsLabel({ newConversations: 1, threadPrompts: 2 })).toBe("1 scheduled new conversation, 2 scheduled prompts in existing threads");
    expect(scheduledCountsLabel({ newConversations: 2, threadPrompts: 0 })).toBe("2 scheduled new conversations");
    expect(scheduledCountsLabel({ newConversations: 0, threadPrompts: 0 })).toBe("");
  });
});

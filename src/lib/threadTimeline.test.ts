import { describe, expect, it } from "vitest";
import { timelineFromTurns } from "./threadTimeline";

describe("timelineFromTurns", () => {
  it("preserves message and command chronology when a thread is resumed", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "inspect it" }] },
      { id: "command", type: "commandExecution", command: "git status", aggregatedOutput: "clean", status: "completed" },
      { id: "assistant", type: "agentMessage", text: "Everything is clean." },
    ] }]);

    expect(snapshot.messages.map((message) => [message.id, message.timelineOrder, message.turnId, message.turnStatus])).toEqual([
      ["user", 1, "turn-1", "completed"],
      ["assistant", 3, "turn-1", "completed"],
    ]);
    expect(snapshot.activities.map((activity) => [activity.id, activity.timelineOrder, activity.turnId, activity.turnStatus]))
      .toEqual([["command", 2, "turn-1", "completed"]]);
  });

  it("restores model thinking as a collapsed reasoning activity", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "reasoning", type: "reasoning", summary: ["Summary"], content: ["Detailed thinking"] },
      { id: "assistant", type: "agentMessage", text: "Answer" },
    ] }]);

    expect(snapshot.activities[0]).toMatchObject({
      id: "reasoning",
      kind: "reasoning",
      title: "Model thinking",
      detail: "Detailed thinking",
      status: "completed",
    });
  });

  it("preserves interrupted status when rebuilding persisted turns", () => {
    const snapshot = timelineFromTurns([{ id: "turn-stopped", status: "interrupted", items: [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "inspect it" }] },
      { id: "partial", type: "agentMessage", text: "I started checking" },
    ] }]);

    expect(snapshot.messages.map((message) => message.turnStatus)).toEqual(["interrupted", "interrupted"]);
  });

  it("restores local images on user messages for transcript previews", () => {
    const snapshot = timelineFromTurns([{ id: "turn-image", items: [{
      id: "user-image",
      type: "userMessage",
      content: [
        { type: "text", text: "Use this screenshot" },
        { type: "localImage", path: "C:\\Users\\Morgan\\pasted.png" },
      ],
    }] }]);

    expect(snapshot.messages[0]).toMatchObject({
      text: "Use this screenshot",
      attachments: [{
        path: "C:\\Users\\Morgan\\pasted.png",
        name: "pasted.png",
        kind: "image",
      }],
    });
  });

  it("restores structured spawn metadata for the animated dispatch card", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [{
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      prompt: "Audit the updater",
      status: "inProgress",
      receiverThreadIds: ["child"],
    }] }]);

    expect(snapshot.activities[0]).toMatchObject({
      id: "spawn",
      kind: "agent",
      status: "inProgress",
      agent: {
        action: "spawn",
        provider: "openai",
        task: "Audit the updater",
      },
    });
  });

  it("restores a Codex compaction marker in place without touching the transcript", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "user", type: "userMessage", content: [{ type: "text", text: "keep going" }] },
      { id: "compaction", type: "contextCompaction", status: "completed" },
      { id: "assistant", type: "agentMessage", text: "Continued." },
    ] }], { includeContextCompaction: true });

    expect(snapshot.activities).toMatchObject([{
      id: "compaction",
      kind: "compaction",
      title: "Context compacted",
      detail: "Codex",
      status: "completed",
      timelineOrder: 2,
      turnId: "turn-1",
      turnStatus: "completed",
    }]);
    expect(snapshot.messages.map((message) => [message.id, message.timelineOrder])).toEqual([
      ["user", 1],
      ["assistant", 3],
    ]);
  });

  it("does not report a rollout saved mid-compaction as a success", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", status: "interrupted", items: [
      { id: "compaction", type: "contextCompaction", status: "inProgress" },
    ] }], { includeContextCompaction: true });

    expect(snapshot.activities[0]).toMatchObject({ kind: "compaction", status: "failed" });
  });

  it("preserves legacy status-less completed history rather than inventing a failure", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "compaction", type: "contextCompaction", status: "inProgress" },
    ] }], { includeContextCompaction: true });
    expect(snapshot.activities[0].status).toBe("completed");
  });

  it.each(["failed", "error", "interrupted", "cancelled"])("preserves an explicit %s compaction outcome in history", (status) => {
    const snapshot = timelineFromTurns([{ id: "turn-1", status: "interrupted", items: [
      { id: "compaction", type: "contextCompaction", status },
    ] }], { includeContextCompaction: true });
    expect(snapshot.activities[0].status).toBe("failed");
  });

  it("keeps an explicitly live compaction active while its turn is still running", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", status: "inProgress", items: [
      { id: "compaction", type: "contextCompaction", status: "inProgress" },
    ] }], { includeContextCompaction: true });
    expect(snapshot.activities[0].status).toBe("inProgress");
  });

  it("does not undo a recorded compaction just because the turn later failed", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", status: "failed", items: [
      { id: "compaction", type: "contextCompaction" },
    ] }], { includeContextCompaction: true });
    expect(snapshot.activities[0].status).toBe("completed");
  });

  it("does not surface shared app-server compaction items without an OpenAI opt-in", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [
      { id: "compaction", type: "contextCompaction" },
    ] }]);

    expect(snapshot.activities).toEqual([]);
  });

  it("restores native Codex sub-agents through the same animated Relay path", () => {
    const snapshot = timelineFromTurns([{ id: "turn-1", items: [{
      id: "native-spawn",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "child",
      agentPath: "/root/audio_regression_audit",
    }] }]);

    expect(snapshot.activities[0]).toMatchObject({
      id: "native-spawn",
      kind: "agent",
      title: "Sub-agent started",
      detail: "/root/audio_regression_audit",
      status: "started",
      agent: {
        action: "spawn",
        provider: "openai",
        task: "/root/audio_regression_audit",
        count: 1,
      },
    });
  });
});

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
});

import { describe, expect, it } from "vitest";
import { buildTranscriptMarkdown, mergeTranscriptHistory } from "./transcript";

describe("transcript export", () => {
  it("combines complete durable history with fresher live entries", () => {
    const merged = mergeTranscriptHistory(
      [{ id: "old", role: "user", text: "Old", timelineOrder: 1 }, { id: "live", role: "assistant", text: "stale", timelineOrder: 2 }],
      [{ id: "tool", kind: "command", title: "Old tool", timelineOrder: 3 }],
      [{ id: "live", role: "assistant", text: "fresh", timelineOrder: 2 }, { id: "new", role: "user", text: "New", timelineOrder: 4 }],
      [{ id: "tool", kind: "command", title: "Updated tool", timelineOrder: 3 }],
    );

    expect(merged.messages.map((message) => [message.id, message.text])).toEqual([
      ["old", "Old"],
      ["live", "fresh"],
      ["new", "New"],
    ]);
    expect(merged.activities).toEqual([expect.objectContaining({ id: "tool", title: "Updated tool" })]);
  });

  it("orders entries by timeline order and renders roles", () => {
    const markdown = buildTranscriptMarkdown(
      "My thread",
      [
        { id: "m1", role: "user", text: "Question?", timelineOrder: 1 },
        { id: "m2", role: "assistant", text: "Answer.", timelineOrder: 3 },
      ],
      [{ id: "a1", kind: "command", title: "npm test", detail: "ok", status: "completed", timelineOrder: 2 }],
    );
    const userIndex = markdown.indexOf("## You");
    const commandIndex = markdown.indexOf("**command** — npm test");
    const assistantIndex = markdown.indexOf("## Assistant");
    expect(userIndex).toBeGreaterThan(-1);
    expect(commandIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(commandIndex);
    expect(markdown.startsWith("# My thread")).toBe(true);
  });

  it("wraps reasoning in a collapsed details block", () => {
    const markdown = buildTranscriptMarkdown("T", [], [
      { id: "r1", kind: "reasoning", title: "Model thinking", detail: "step by step", timelineOrder: 1 },
    ]);
    expect(markdown).toContain("<details><summary>Model thinking</summary>");
    expect(markdown).toContain("step by step");
  });
});

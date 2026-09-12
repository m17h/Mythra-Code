import { beforeEach, describe, expect, it } from "vitest";
import { resetTaskStore, useTaskStore, estimateTranscriptBytes } from "./taskStore";
import { displayedUserPrompt, reconcileUserMessages } from "./userMessageEcho";
import { mergeTranscriptHistory } from "./transcript";
import { timelineFromTurns } from "./threadTimeline";
import type { ChatMessage } from "../types";

const user = (id: string, turnId = "turn-1", text = "Check the app"): ChatMessage => ({ id, role: "user", text, turnId });
const store = () => useTaskStore.getState();

describe("provider prompt echoes", () => {
  beforeEach(resetTaskStore);
  it.each(["event", "history"])("reconciles optimistic input with a runtime ID from %s", (source) => {
    store().setActiveTurn("thread", "turn-1");
    store().appendUserMessage("thread", user("local-1"));
    if (source === "event") store().completeMessage("thread", user("runtime-1"));
    else store().hydrateTask("thread", [user("runtime-1")], []);
    store().hydrateTask("thread", [user("runtime-1")], []);
    expect(store().tasks.thread.messages).toEqual([expect.objectContaining({ id: "runtime-1", clientMessageId: "local-1", text: "Check the app" })]);
    expect(store().tasks.thread.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(store().tasks.thread.messages, []));
  });
  it("matches a child echo arriving before spawn returns exactly once", () => {
    store().completeMessage("child", user("runtime-1"));
    store().appendUserMessage("child", user("local-1"));
    store().appendUserMessage("child", user("local-1"));
    store().appendUserMessage("child", user("local-2"));
    store().completeMessage("child", user("runtime-2"));
    expect(store().tasks.child.messages.map((m) => [m.id, m.clientMessageId])).toEqual([["runtime-1", "local-1"], ["runtime-2", "local-2"]]);
  });
  it("matches a runtime echo that beats the normal turn-start response", () => {
    store().setTaskStatus("thread", "starting");
    store().appendUserMessage("thread", { id: "local-1", role: "user", text: "Check the app" });
    store().completeMessage("thread", user("runtime-1"));
    store().setActiveTurn("thread", "turn-1");
    expect(store().tasks.thread.messages).toEqual([
      expect.objectContaining({ id: "runtime-1", clientMessageId: "local-1", turnId: "turn-1" }),
    ]);
  });
  it("matches repeated pending-start prompts one-to-one", () => {
    store().setTaskStatus("thread", "starting");
    store().appendUserMessage("thread", { id: "local-1", role: "user", text: "Check the app" });
    store().appendUserMessage("thread", { id: "local-2", role: "user", text: "Check the app" });
    store().completeMessage("thread", user("runtime-1"));
    store().completeMessage("thread", user("runtime-2"));
    expect(store().tasks.thread.messages.map((message) => [message.id, message.clientMessageId])).toEqual([
      ["runtime-1", "local-1"],
      ["runtime-2", "local-2"],
    ]);
  });
  it("does not bind a stale known turn to a new pending start", () => {
    store().completeTurn("thread", "old-turn", "completed");
    store().setTaskStatus("thread", "starting");
    store().appendUserMessage("thread", { id: "local-new", role: "user", text: "Check the app" });
    store().completeMessage("thread", user("late-old", "old-turn"));
    store().completeMessage("thread", user("runtime-new", "new-turn"));
    expect(store().tasks.thread.messages.map((message) => [message.id, message.clientMessageId])).toEqual([
      ["runtime-new", "local-new"],
      ["late-old", undefined],
    ]);
  });
  it("does not mistake an intentional steer for an old prompt loaded from history", () => {
    store().setActiveTurn("thread", "turn-1");
    store().hydrateTask("thread", [user("runtime-1")], []);
    store().appendUserMessage("thread", { id: "local-steer", role: "user", text: "Check the app" });
    store().completeMessage("thread", user("runtime-steer"));
    expect(store().tasks.thread.messages.map((entry) => entry.id)).toEqual(["runtime-1", "runtime-steer"]);
  });
  it("keeps identical intentional sends in the same turn and across turns", () => {
    store().appendUserMessage("thread", user("local-1"));
    store().completeMessage("thread", user("runtime-1"));
    store().appendUserMessage("thread", user("local-2"));
    store().completeMessage("thread", user("runtime-2"));
    store().appendUserMessage("thread", user("local-3", "turn-2"));
    store().hydrateTask("thread", [user("runtime-1"), user("runtime-2"), user("runtime-3", "turn-2")], []);
    expect(store().tasks.thread.messages.map((m) => m.id)).toEqual(["runtime-1", "runtime-2", "runtime-3"]);
  });
  it("does not merge similar uncorrelated provider messages or messages without turn IDs", () => {
    const result = reconcileUserMessages([user("runtime")], [user("other-runtime"), { ...user("local-1"), turnId: undefined }]);
    expect(result.matchedIds.size).toBe(0);
  });
  it("retains original prompt and image details when matching generated context", () => {
    const attachments = [{ path: "/image.png", name: "My image", kind: "image" as const }];
    store().appendUserMessage("thread", { ...user("local-1", "turn-1", "@review this"), attachments });
    const envelope = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [{ instructions: "Review" }], userMessage: "@review this" })}\n</mythra_code_invoked_skills>\n\nAttached context:\n@/notes.md`;
    store().completeMessage("thread", { ...user("runtime", "turn-1", envelope), attachments });
    expect(store().tasks.thread.messages).toHaveLength(1);
    expect(store().tasks.thread.messages[0]).toMatchObject({ text: "@review this", attachments });
    expect(displayedUserPrompt("<mythra_code_invoked_skills>broken")).toBe("<mythra_code_invoked_skills>broken");
  });
  it("strips generated file context from history while preserving unexpected suffix text", () => {
    const envelope = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [{ instructions: "Review" }], userMessage: "@review this" })}\n</mythra_code_invoked_skills>`;
    expect(displayedUserPrompt(`${envelope}\n\nAttached context:\n@/notes.md\n@/design.md`)).toBe("@review this");
    expect(displayedUserPrompt(`${envelope}\n\nAttached context:\n@/notes.md\n\nKeep this note`)).toBe("@review this\n\nKeep this note");
    expect(displayedUserPrompt(`${envelope}\n\nUnexpected tail`)).toBe("@review this\n\nUnexpected tail");
    expect(timelineFromTurns([{ id: "turn-1", items: [{ id: "runtime", type: "userMessage", content: [{ type: "text", text: `${envelope}\n\nAttached context:\n@/notes.md` }] }] }]).messages[0].text).toBe("@review this");
  });
  it("updates steering feedback after the runtime replaces the local ID", () => {
    store().appendUserMessage("thread", { ...user("local-1"), steerStatus: "sending" });
    store().completeMessage("thread", user("runtime"));
    store().setMessageSteerStatus("thread", "local-1", "accepted");
    expect(store().tasks.thread.messages[0].steerStatus).toBe("accepted");
  });
  it("deduplicates saved transcript merges one-to-one", () => {
    const result = mergeTranscriptHistory([user("runtime-1"), user("runtime-2")], [], [user("local-1"), user("local-2")], []);
    expect(result.messages.map((m) => m.id)).toEqual(["runtime-1", "runtime-2"]);
  });
  it("clears obsolete runtime questions when stopped but keeps their inline question row", () => {
    store().setActiveTurn("thread", "turn-1");
    store().enqueueApproval({ id: 1, method: "claude/can_use_tool", threadId: "thread", params: { turnId: "turn-1", tool_name: "AskUserQuestion" }, receivedAt: 1 });
    store().enqueueApproval({ id: 2, method: "openkiwi/subagents/change", threadId: "thread", params: {}, receivedAt: 2 });
    store().completeMessage("thread", { id: "questions", role: "assistant", text: "", questions: [{ title: "Which layout?" }] });
    store().completeTurn("thread", "turn-1", "interrupted");
    store().hydrateTask("thread", [], []);
    expect(store().tasks.thread.approvals.map((entry) => entry.id)).toEqual([2]);
    expect(store().tasks.thread.messages[0].questions).toEqual([{ title: "Which layout?" }]);
  });
  it("does not discard questions belonging to a newer active turn", () => {
    store().setActiveTurn("thread", "new");
    store().enqueueApproval({ id: 1, method: "claude/can_use_tool", threadId: "thread", params: { turnId: "new", tool_name: "AskUserQuestion" }, receivedAt: 1 });
    store().completeTurn("thread", "old", "completed");
    expect(store().tasks.thread.approvals).toHaveLength(1);
  });
  it("retains structured questions in runtime history", () => {
    const questions = [{ title: "Which layout?", options: ["Compact", "Spacious"] }];
    expect(timelineFromTurns([{ id: "turn-1", items: [{ id: "question", type: "agentMessage", text: "", questions }] }]).messages[0].questions).toEqual(questions);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { resetTaskStore, useTaskStore, estimateTranscriptBytes } from "./taskStore";
import { displayedUserMessage, displayedUserPrompt, reconcileUserMessages } from "./userMessageEcho";
import { mergeTranscriptHistory } from "./transcript";
import { timelineFromTurns } from "./threadTimeline";
import type { ChatMessage, SkillDependencyReport } from "../types";
import { SKILL_DEPENDENCY_LIMITS } from "./skillDependencies";

const user = (id: string, turnId = "turn-1", text = "Check the app"): ChatMessage => ({ id, role: "user", text, turnId });
const store = () => useTaskStore.getState();
const report = (): SkillDependencyReport => ({
  version: 1, limits: { ...SKILL_DEPENDENCY_LIMITS }, roots: [{ nodeId: "review", channel: "system", name: "review" }],
  nodes: [
    { id: "review", kind: "skill", name: "review", path: "/original/review/SKILL.md", status: "loaded", characterCount: 23, depth: 0, contentHash: "a".repeat(64) },
    { id: "checklist", kind: "document", name: "checklist.md", path: "/original/review/checklist.md", status: "loaded", characterCount: 37, depth: 1, contentHash: "b".repeat(64) },
  ], edges: [{ from: "review", to: "checklist", reference: "checklist.md" }], issues: [],
});
const envelope = (payload: Record<string, unknown>) => `<mythra_code_invoked_skills>\n${JSON.stringify(payload)}\n</mythra_code_invoked_skills>`;

describe("provider prompt echoes", () => {
  beforeEach(resetTaskStore);
  it("round-trips system-only dependency provenance through a user envelope without inventing direct user references", () => {
    const graph = report();
    const wrapped = envelope({ skills: [], skillReferences: [], skillsFolder: "/original", dependencyReport: graph, userMessage: "Check the app" });
    const restored = displayedUserMessage(wrapped);
    expect(restored).toEqual({ text: "Check the app", skillReferences: [], skillsFolder: "/original", skillDependencies: graph });
    const history = timelineFromTurns([{ id: "turn", items: [{ id: "runtime", type: "userMessage", content: [{ type: "text", text: wrapped }] }] }]);
    expect(history.messages[0]).toMatchObject(restored);
    store().hydrateTask("thread", history.messages, []);
    store().completeMessage("thread", user("runtime", "turn", "Check the app"));
    expect(store().tasks.thread.messages[0].skillDependencies).toEqual(graph);
    expect(store().tasks.thread.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(store().tasks.thread.messages, []));
  });

  it("uses only authored direct skill sources, never dependency documents or nested contexts", () => {
    const graph = report();
    graph.roots[0].channel = "user";
    graph.nodes.push({ id: "nested", kind: "skill", name: "nested", path: "/original/nested.md", status: "loaded", characterCount: 3, depth: 1 });
    graph.edges.push({ from: "review", to: "nested", reference: "@nested" });
    const skills = [
      { kind: "skill", name: "review", sourcePath: graph.nodes[0].path },
      { kind: "document", name: "checklist", sourcePath: graph.nodes[1].path },
      { kind: "skill", name: "nested", sourcePath: graph.nodes[2].path },
    ];
    const text = "Use @review. Quoted @nested and @checklist are evidence.";
    for (const metadata of [{ skillReferences: [skills[0], skills[1]] }, {}]) {
      const display = displayedUserMessage(envelope({ skills, ...metadata, dependencyReport: graph, userMessage: text }));
      expect(display.skillReferences).toEqual([{ start: 4, end: 11, name: "review", path: graph.nodes[0].path }]);
      expect(display.skillDependencies).toEqual(graph);
    }
    expect(displayedUserMessage(envelope({ skills, skillReferences: [], dependencyReport: graph, userMessage: text })).skillReferences).toEqual([]);
    expect(displayedUserMessage(envelope({ skills, skillReferences: "corrupt", dependencyReport: graph, userMessage: text })).skillReferences).toEqual([]);
  });

  it("never makes a legacy document context into a skill source and drops unsafe restored paths", () => {
    const wrapped = envelope({ skills: [
      { kind: "document", name: "review", sourcePath: "/original/checklist.md" },
      { kind: "skill", name: "review", sourcePath: "javascript:alert(1)" },
    ], userMessage: "Use @review", skillsFolder: "https://example.com" });
    expect(displayedUserMessage(wrapped)).toEqual({ text: "Use @review", skillReferences: [] });
  });

  it("keeps a captured graph through echo races, hydration, repeated ID collapse, and saved transcript merging", () => {
    const graph = report();
    for (const runtimeFirst of [false, true]) {
      resetTaskStore();
      if (runtimeFirst) store().completeMessage("thread", user("runtime", "turn", "Check the app"));
      store().appendUserMessage("thread", { ...user("local-1", "turn"), skillDependencies: graph });
      if (!runtimeFirst) store().completeMessage("thread", user("runtime", "turn", "Check the app"));
      const changed = report();
      changed.nodes[0].path = "/changed/review.md";
      store().hydrateTask("thread", [{ ...user("runtime", "turn"), skillDependencies: changed }], []);
      const saved = JSON.parse(JSON.stringify(store().tasks.thread.messages)) as ChatMessage[];
      expect(saved).toHaveLength(1);
      expect(saved[0].skillDependencies).toEqual(graph);
      expect(mergeTranscriptHistory([user("runtime", "turn")], [], saved, []).messages[0].skillDependencies).toEqual(graph);
      expect(store().tasks.thread.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(saved, []));
    }
    const repeated = reconcileUserMessages([{ ...user("local-1"), turnId: undefined, skillDependencies: graph }, user("local-1")], []);
    expect(repeated.messages).toHaveLength(1);
    expect(repeated.messages[0].skillDependencies).toEqual(graph);
  });

  it.each([null, "corrupt", {}, { ...report(), nodes: [null] }, { ...report(), edges: [{ from: "missing", to: "review", reference: "@review" }] }])("discards corrupt dependency metadata at every history boundary: %j", (metadata) => {
    const message = { ...user("runtime"), skillDependencies: metadata as unknown as SkillDependencyReport };
    const wrapped = envelope({ skills: [{ kind: "skill", name: "review", sourcePath: "/original/review.md" }], dependencyReport: metadata, userMessage: "Use @review" });
    expect(displayedUserMessage(wrapped)).toEqual({ text: "Use @review", skillReferences: [] });
    expect(() => store().hydrateTask("thread", [message], [])).not.toThrow();
    expect(store().tasks.thread.messages[0].skillDependencies).toBeUndefined();
    store().prependHistory("thread", [{ ...message, id: "older" }], [], {});
    expect(store().tasks.thread.messages[0].skillDependencies).toBeUndefined();
    expect(mergeTranscriptHistory([], [], [message], []).messages[0].skillDependencies).toBeUndefined();
    resetTaskStore();
    store().appendUserMessage("thread", message);
    expect(store().tasks.thread.messages[0].skillDependencies).toBeUndefined();
    store().completeMessage("other", message);
    expect(store().tasks.other.messages[0].skillDependencies).toBeUndefined();
  });

  it("reconstructs exact reference provenance from a paired envelope without user instruction duplication", () => {
    const envelope = `<mythra_code_invoked_skills>\n${JSON.stringify({ skills: [], skillReferences: [{ name: "review", sourcePath: "/skills/review.md" }], skillsFolder: "/skills", userMessage: "Use @review then @review" })}\n</mythra_code_invoked_skills>`;
    const display = displayedUserMessage(envelope);
    expect(display).toEqual({ text: "Use @review then @review", skillsFolder: "/skills", skillReferences: [
      { start: 4, end: 11, name: "review", path: "/skills/review.md" }, { start: 17, end: 24, name: "review", path: "/skills/review.md" },
    ] });
    expect(timelineFromTurns([{ id: "turn", items: [{ id: "runtime", type: "userMessage", content: [{ type: "text", text: envelope }] }] }]).messages[0]).toMatchObject(display);
    store().completeMessage("thread", user("runtime", "turn", envelope));
    expect(store().tasks.thread.messages[0]).toMatchObject(display);
    expect(store().tasks.thread.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(store().tasks.thread.messages, []));
  });

  it("preserves captured paths and intentionally empty snapshots through events, hydration, and saved merges", () => {
    const references = [{ start: 4, end: 11, name: "review", path: "/original/review.md" }];
    for (const snapshot of [references, []]) {
      resetTaskStore();
      store().appendUserMessage("thread", { ...user("local-1", "turn-1", "Use @review"), skillReferences: snapshot, skillsFolder: "/original" });
      store().completeMessage("thread", user("runtime", "turn-1", "Use @review"));
      store().hydrateTask("thread", [user("runtime", "turn-1", "Use @review")], []);
      const message = store().tasks.thread.messages[0];
      expect(message).toMatchObject({ skillReferences: snapshot, skillsFolder: "/original" });
      expect(mergeTranscriptHistory([user("runtime", "turn-1", "Use @review")], [], [message], []).messages[0]).toMatchObject({ skillReferences: snapshot, skillsFolder: "/original" });
    }
  });

  it("keeps provenance when the runtime echo beats the append result", () => {
    const refs = [{ start: 4, end: 11, name: "review", path: "/skills/review.md" }];
    store().completeMessage("child", user("runtime", "turn", "Use @review"));
    store().appendUserMessage("child", { ...user("local-1", "turn", "Use @review"), skillReferences: refs, skillsFolder: "/skills" });
    expect(store().tasks.child.messages[0]).toMatchObject({ skillReferences: refs, skillsFolder: "/skills" });
  });

  it.each([null, "corrupt", {}, [null], [{ start: "4", end: 11, name: "review", path: "/skills/review.md" }]])("hydrates corrupt optional reference JSON without crashing memory estimation: %j", (metadata) => {
    const message = { ...user("runtime", "turn", "Use @review"), skillReferences: metadata as unknown as ChatMessage["skillReferences"] };
    expect(() => store().hydrateTask("thread", [message], [])).not.toThrow();
    expect(store().tasks.thread.messages[0].skillReferences).toEqual(metadata);
    expect(store().tasks.thread.estimatedTranscriptBytes).toBe(estimateTranscriptBytes(store().tasks.thread.messages, []));
  });
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
  it("collapses a legacy pending and identified copy only when their message IDs match", () => {
    const pending = { id: "local-first", role: "user" as const, text: "Check the app", timelineOrder: 1 };
    const identified = { ...pending, turnId: "turn-1", turnStatus: "completed" as const, timelineOrder: 3 };
    const separate = { ...identified, id: "local-second", timelineOrder: 4 };
    const incoming = [pending, { id: "reply", role: "assistant" as const, text: "Done", timelineOrder: 2 }, identified, separate];

    const result = reconcileUserMessages(incoming, []);
    expect(result.messages.map((message) => message.id)).toEqual(["local-first", "reply", "local-second"]);
    expect(result.messages[0]).toMatchObject({ turnId: "turn-1", turnStatus: "completed", timelineOrder: 1 });
    expect(result.messages[2]).toMatchObject({ text: "Check the app" });
    store().hydrateTask("thread", incoming, []);
    expect(store().tasks.thread.messages.map((message) => message.id)).toEqual(["local-first", "reply", "local-second"]);
    store().prependHistory("thread", [pending], [], { hasMore: false, nextCursor: null });
    expect(store().tasks.thread.messages.map((message) => message.id)).toEqual(["local-first", "reply", "local-second"]);
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
  it("keeps history ordering when an echoed prompt already has its runtime ID", () => {
    const history = [{ ...user("runtime"), timelineOrder: 1 }, { id: "answer", role: "assistant" as const, text: "Reply", turnId: "turn-1", timelineOrder: 2 }];
    const live = [{ ...user("runtime"), clientMessageId: "local-1", timelineOrder: 900, steerStatus: "accepted" as const }];
    const merged = mergeTranscriptHistory(history, [], live, []);
    expect(merged.messages.map((message) => message.id)).toEqual(["runtime", "answer"]);
    expect(merged.messages[0]).toMatchObject({ clientMessageId: "local-1", steerStatus: "accepted", timelineOrder: 1 });
    store().hydrateTask("thread", live, []);
    store().hydrateTask("thread", history, []);
    expect(store().tasks.thread.messages.map((message) => message.id)).toEqual(["runtime", "answer"]);
    expect(store().tasks.thread.messages[0].timelineOrder).toBeLessThan(store().tasks.thread.messages[1].timelineOrder!);
  });

  it("retains structured questions in runtime history", () => {
    const questions = [{ title: "Which layout?", options: ["Compact", "Spacious"] }];
    expect(timelineFromTurns([{ id: "turn-1", items: [{ id: "question", type: "agentMessage", text: "", questions }] }]).messages[0].questions).toEqual(questions);
  });
});

import { describe, expect, it } from "vitest";
import type { Activity, ChatMessage } from "../types";
import { compactActivityPresentation, latestCompactActivity, type CompactWorkEntry } from "./compactActivity";

const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): CompactWorkEntry => ({
  kind: "message", value: { id, text, role: "assistant", turnId: "turn", ...extra },
});
const user = (id = "prompt", extra: Partial<ChatMessage> = {}) => message(id, "Build it", { role: "user", ...extra });
const activity = (id: string, extra: Partial<Activity> = {}): CompactWorkEntry => ({
  kind: "activity", value: { id, kind: "command", title: "npm test", status: "inProgress", turnId: "turn", ...extra },
});
const present = (entries: CompactWorkEntry[], running = false, activeTurnId?: string) => compactActivityPresentation(entries, { running, activeTurnId });
const visibleIds = (entries: ReturnType<typeof present>) => entries.filter((entry) => entry.kind !== "work")
  .flatMap((entry) => entry.kind === "message" || entry.kind === "activity" ? [entry.value.id] : entry.value.map((value) => value.id));

describe("compact activity presentation", () => {
  it("retains the history opener when stopped before the first provider output", () => {
    const prompt = user("prompt", { turnStatus: "interrupted" });
    expect(present([prompt])).toEqual([prompt, { kind: "work", value: [], state: "interrupted", turnId: "turn", anchorId: "prompt" }]);
  });
  it("keeps stopped thinking, partial answers and failed operations behind one history opener", () => {
    const entries = [user("prompt", { turnStatus: "interrupted" }),
      message("comment", "Checking the implementation", { phase: "commentary", turnStatus: "interrupted" }),
      activity("thought", { kind: "reasoning", detail: "Retained thinking", turnStatus: "interrupted" }),
      activity("failed-file", { kind: "file", status: "failed", detail: "Permission denied", turnStatus: "interrupted" }),
      user("steer", { turnStatus: "interrupted" }),
      activity("warning", { kind: "warning", title: "The operation failed", turnStatus: "interrupted" }),
      message("partial", "The unfinished final response", { phase: "final", turnStatus: "interrupted" })];
    for (const activeTurnId of ["turn", undefined]) {
      const result = present(entries, false, activeTurnId);
      expect(visibleIds(result)).toEqual(["prompt", "steer"]);
      const work = result.filter((entry) => entry.kind === "work");
      expect(work).toHaveLength(1);
      expect(work[0]).toMatchObject({ state: "interrupted", value: entries.filter((entry) => entry.kind !== "message" || entry.value.role !== "user") });
    }
    expect(entries.at(-1)).toMatchObject({ value: { text: "The unfinished final response", phase: "final", turnStatus: "interrupted" } });
  });

  it("keeps unrelated completed final answers visible before and after a stopped turn", () => {
    const entries = [user("earlier-prompt", { turnId: "earlier" }),
      message("earlier-answer", "Earlier completed answer", { turnId: "earlier", phase: "final", turnStatus: "completed" }),
      user(), message("partial", "Unfinished response", { phase: "final", turnStatus: "interrupted" }),
      user("next-prompt", { turnId: "next" }),
      message("next-answer", "Next completed answer", { turnId: "next", phase: "final", turnStatus: "completed" })];
    expect(visibleIds(present(entries))).toEqual(["earlier-prompt", "earlier-answer", "prompt", "next-prompt", "next-answer"]);
    expect(present(entries).filter((entry) => entry.kind === "work")).toMatchObject([{ state: "interrupted" }]);
  });

  it("preserves an explicitly completed final from a separate recovered turn in stopped history", () => {
    const entries = [user(), message("earlier-answer", "A completed recovered result", { turnId: "earlier", phase: "final", turnStatus: "completed" }),
      message("partial", "Unfinished response", { phase: "final", turnStatus: "interrupted" })];
    expect(visibleIds(present(entries))).toEqual(["prompt", "earlier-answer"]);
    expect(present(entries).at(-1)).toMatchObject({ kind: "work", state: "interrupted", value: [entries.at(-1)] });
  });

  it("preserves only the terminal unphased answer from a separate completed recovered turn", () => {
    const entries = [user(), message("earlier-progress", "Earlier progress", { turnId: "earlier", turnStatus: "completed" }),
      message("earlier-answer", "A completed recovered result", { turnId: "earlier", turnStatus: "completed" }),
      message("partial", "Unfinished response", { phase: "final", turnStatus: "interrupted" })];
    expect(visibleIds(present(entries))).toEqual(["prompt", "earlier-answer"]);
    expect(present(entries).filter((entry) => entry.kind === "work")).toHaveLength(1);
    const terminalCommentary = [...entries.slice(0, 3), message("commentary", "More work", { turnId: "earlier", phase: "commentary", turnStatus: "completed" }), entries[3]];
    expect(visibleIds(present(terminalCommentary))).toEqual(["prompt"]);
  });

  it("does not promote stale completed metadata from the same stopped turn", () => {
    const entries = [user(), message("partial", "Unfinished response", { phase: "final", turnStatus: "completed" }),
      activity("stopped", { turnStatus: "interrupted" })];
    expect(visibleIds(present(entries))).toEqual(["prompt"]);
    expect(present(entries).at(-1)).toMatchObject({ kind: "work", state: "interrupted", value: entries.slice(1) });
  });

  it.each(["inProgress", "completed", "failed", "error", "interrupted", "cancelled", "declined", undefined])(
    "never promotes a command with status %s into chat", (status) => {
      const command: Activity = { id: "command", kind: "command", title: "npm test", detail: "Full output", status, turnId: "turn" };
      for (const grouped of [false, true]) {
        const entry: CompactWorkEntry = grouped ? { kind: "commands", value: [command] } : { kind: "activity", value: command };
        for (const running of [false, true]) {
          const result = present([user(), entry], running, "turn");
          expect(visibleIds(result)).toEqual(["prompt"]);
          expect(result.filter((item) => item.kind === "work").flatMap((item) => item.value)).toContain(entry);
        }
      }
      expect(command).toEqual({ id: "command", kind: "command", title: "npm test", detail: "Full output", status, turnId: "turn" });
    },
  );
  it("preserves each completed provider answer when paginated history lacks user prompts", () => {
    const entries = [message("older", "Earlier answer", { turnId: "older-turn", turnStatus: "completed" }),
      message("newer", "Latest answer", { turnId: "newer-turn", turnStatus: "completed" })];
    expect(visibleIds(present(entries))).toEqual(["older", "newer"]);
  });

  it("keeps original user-turn steering inside work recovered under another runtime id", () => {
    const entries = [user(), activity("old"), activity("recovered", { turnId: "recovery" }), user("steer")];
    const result = present(entries, true, "recovery");
    expect(result.filter((entry) => entry.kind === "work")).toHaveLength(1);
    expect(visibleIds(result)).toEqual(["prompt", "steer"]);
  });

  it("shows a single work disclosure for routine live text and tools, retaining every source object", () => {
    const entries = [user(), message("comment", "I am checking", { phase: "commentary" }), activity("tool"), message("unknown", "Still checking", { streaming: true })];
    const result = present(entries, true);
    expect(result).toEqual([entries[0], { kind: "work", value: entries.slice(1), state: "running", turnId: "turn" }]);
    const flattened = result.flatMap((entry) => entry.kind === "work" ? entry.value : [entry]);
    expect(flattened).toEqual(entries);
    flattened.forEach((entry, index) => expect(entry).toBe(entries[index]));
  });

  it("keeps trusted final and unphased text in details until the turn ends", () => {
    expect(visibleIds(present([user(), message("unknown", "Potential answer", { streaming: true }), message("final", "Done", { streaming: true, phase: "final" })], true)))
      .toEqual(["prompt"]);
  });

  it("creates one live work record when only a final response is streaming", () => {
    const entries = [user(), message("final", "Done", { streaming: true, phase: "final" })];
    expect(present(entries, true)).toEqual([entries[0], { kind: "work", value: [entries[1]], state: "running", turnId: "turn" }]);
  });

  it("reveals the trusted final response after successful terminal completion", () => {
    const entries = [user(), message("comment", "Working", { phase: "commentary", turnStatus: "completed" }), message("final", "Done", { phase: "final", turnStatus: "completed" })];
    expect(visibleIds(present(entries))).toEqual(["prompt", "final"]);
  });

  it("keeps an idle current turn unconfirmed without promoting its completed item or animating work", () => {
    const entries = [user(), message("comment", "Checking", { phase: "commentary" }), message("final", "Done", { phase: "final", streaming: false })];
    const result = present(entries, false, "turn");
    expect(visibleIds(result)).toEqual(["prompt"]);
    expect(result).toEqual([entries[0], { kind: "work", value: entries.slice(1), state: "unknown", turnId: "turn" }]);
  });

  it("retains questions, warnings and explicitly stopped output while the current turn is unconfirmed", () => {
    const entries = [user(), message("partial", "Stopped result", { turnStatus: "interrupted" }),
      message("draft", "Unconfirmed draft", { phase: "final", streaming: true }),
      message("question", "", { questions: [{ title: "Which folder?" }] }),
      activity("warning", { kind: "warning" }), activity("failed", { status: "failed" })];
    const result = present(entries, false, "turn");
    expect(visibleIds(result)).toEqual(["prompt", "partial", "question", "warning"]);
    expect(result.find((entry) => entry.kind === "work")).toMatchObject({ state: "unknown" });
  });

  it("preserves unknown older answers and stopped output after their active turn identity is cleared", () => {
    const entries = [user(), message("old", "An older answer"), message("partial", "Stopped output", { streaming: true })];
    expect(visibleIds(present(entries, false, "different-current-turn"))).toEqual(["prompt", "old", "partial"]);
    expect(visibleIds(present(entries))).toEqual(["prompt", "old", "partial"]);
  });

  it("accepts a recovered terminal answer when history has sealed it but active identity is stale", () => {
    const entries = [user("prompt", { turnStatus: "completed" }),
      message("comment", "Checking", { phase: "commentary", turnStatus: "completed" }),
      message("final", "Done", { phase: "final", turnStatus: "completed", streaming: false })];
    expect(visibleIds(present(entries, false, "turn"))).toEqual(["prompt", "final"]);
  });

  it.each([undefined, "not-yet-materialized"])("keeps completed history visible while a new turn starts with identity %s", (activeTurnId) => {
    const entries = [user("prompt", { turnStatus: "completed" }),
      message("comment", "Checking", { phase: "commentary", turnStatus: "completed" }),
      message("final", "Done", { phase: "final", turnStatus: "completed" })];
    const result = present(entries, true, activeTurnId);
    expect(visibleIds(result)).toEqual(["prompt", "final"]);
    expect(result.find((entry) => entry.kind === "work")).toMatchObject({ state: "completed", turnId: "turn" });
  });

  it("still compacts legacy untagged partial output without a runtime identity", () => {
    const entries = [user("prompt", { turnId: undefined }),
      message("comment", "Checking", { turnId: undefined }),
      message("partial", "Partial answer", { turnId: undefined, streaming: true })];
    expect(visibleIds(present(entries, true))).toEqual(["prompt"]);
    expect(present(entries, true).find((entry) => entry.kind === "work")).toMatchObject({ state: "running" });
  });

  it("reveals only the terminal unphased answer after successful completion", () => {
    const result = present([user(), message("early", "I'll do it", { turnStatus: "completed" }), activity("tool", { status: "completed", turnStatus: "completed" }), message("answer", "Done", { turnStatus: "completed" })]);
    expect(visibleIds(result)).toEqual(["prompt", "answer"]);
    expect(result[1]).toMatchObject({ kind: "work", state: "completed" });
  });

  it("never labels explicit commentary a final answer, even if it is last in a completed turn", () => {
    expect(visibleIds(present([user(), message("comment", "Working", { phase: "commentary", turnStatus: "completed" })])))
      .toEqual(["prompt"]);
  });

  it("preserves a recovered failed message while another runtime id continues the logical run", () => {
    const result = present([user(), message("failed-output", "The failed run's partial result", { turnStatus: "failed" }), activity("current", { turnId: "recovered" }), message("progress", "Continuing", { turnId: "recovered" })], true, "recovered");
    expect(visibleIds(result)).toEqual(["prompt", "failed-output"]);
    expect(result.at(-1)).toMatchObject({ kind: "work", state: "running", turnId: "recovered" });
  });

  it("does not select an earlier unphased segment when the terminal segment is commentary", () => {
    expect(visibleIds(present([user(), message("early", "Working", { turnStatus: "completed" }), message("comment", "More work", { phase: "commentary", turnStatus: "completed" })])))
      .toEqual(["prompt"]);
  });

  it("keeps structured input and safety warnings visible but failed commands in details", () => {
    const result = present([user(), message("question", "", { questions: [{ title: "Which folder?" }] }), activity("warning", { kind: "warning" }), activity("failed", { status: "failed" }), activity("normal")], true);
    expect(visibleIds(result)).toEqual(["prompt", "question", "warning"]);
    expect(result.at(-1)).toMatchObject({ kind: "work", state: "running" });
  });

  it("retains meaningful output from a failed provider turn", () => {
    const turnStatus = "failed";
    const result = present([user("prompt", { turnStatus }), message("partial", "The partial result", { turnStatus, phase: "commentary" }), activity("tool", { status: "completed", turnStatus })]);
    expect(visibleIds(result)).toEqual(["prompt", "partial"]);
    expect(result.at(-1)).toMatchObject({ kind: "work", state: turnStatus });
  });

  it("keeps steering chronological inside its original live turn", () => {
    const entries = [user(), activity("first"), user("steer", { steerStatus: "accepted" }), activity("second")];
    const result = present(entries, true, "turn");
    expect(result.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
    expect(visibleIds(result)).toEqual(["prompt", "steer"]);
    expect(result[1]).toMatchObject({ state: "running" });
    expect(result[1]).toMatchObject({ value: [entries[1], entries[3]] });
  });

  it("binds an optimistic untagged prompt to the first runtime item before steering", () => {
    const result = present([user("prompt", { turnId: undefined }), activity("tool"), user("steer"), message("answer", "Done", { turnStatus: "completed" })]);
    expect(visibleIds(result)).toEqual(["prompt", "steer", "answer"]);
    expect(result[1]).toMatchObject({ kind: "work", state: "completed" });
  });

  it("keeps earlier completed answers visible when another turn starts", () => {
    const result = present([user(), message("answer", "Done", { turnStatus: "completed" }), user("next", { turnId: "next" }), message("progress", "Checking", { turnId: "next" })], true, "next");
    expect(visibleIds(result)).toEqual(["prompt", "answer", "next"]);
    expect(result.at(-1)).toMatchObject({ kind: "work", state: "running", turnId: "next" });
  });

  it("preserves compaction landmarks without exposing interrupted commands", () => {
    const result = present([user(), activity("boundary", { kind: "compaction" }), { kind: "commands", value: [
      { id: "ok", kind: "command", title: "node", status: "completed" },
      { id: "stopped", kind: "command", title: "npm test", status: "interrupted" },
    ] }], true);
    expect(visibleIds(result)).toEqual(["prompt", "boundary"]);
    expect(result.filter((entry) => entry.kind === "work")).toHaveLength(1);
  });

  it("keeps a failed command and its surrounding operations together in work history", () => {
    const tools: Activity[] = [
      { id: "ok", kind: "command", title: "npm build", status: "completed", turnId: "turn" },
      { id: "bad", kind: "command", title: "npm test", status: "failed", turnId: "turn" },
      { id: "next", kind: "command", title: "npm lint", status: "inProgress", turnId: "turn" },
    ];
    const result = present([user(), { kind: "commands", value: tools }], true);
    expect(visibleIds(result)).toEqual(["prompt"]);
    const work = result.filter((entry) => entry.kind === "work");
    expect(work).toHaveLength(1);
    expect(work[0].value).toEqual([{ kind: "commands", value: tools }]);
    expect(work[0].value[0]).toMatchObject({ value: tools });
    expect(tools.map((tool) => tool.id)).toEqual(["ok", "bad", "next"]);
  });

  it("does not fabricate completion for runtime-tagged history with missing terminal status", () => {
    const result = present([user(), activity("tool", { status: "completed" }), message("uncertain", "A possible answer")]);
    expect(visibleIds(result)).toEqual(["prompt", "uncertain"]);
    expect(result[1]).toMatchObject({ kind: "work", state: "unknown" });
  });

  it("preserves legacy final answers and ignores empty or question-only tail rows", () => {
    const result = present([user("prompt", { turnId: undefined }), message("answer", "Done", { turnId: undefined }), message("empty", "", { turnId: undefined }), message("question", "", { turnId: undefined, questions: [{ title: "Next step?" }] })]);
    expect(visibleIds(result)).toEqual(["prompt", "answer", "question"]);
  });
});

describe("latest compact activity", () => {
  it.each([
    ["command", "Web Search", "research", "Researching"],
    ["command", "rg -n handler src", "research", "Researching"],
    ["file", "src/App.tsx", "files", "Editing files"],
    ["command", "npm test", "commands", "Executing commands"],
    ["reasoning", "Model thinking", "thinking", "Thinking"],
  ] as const)("categorizes %s %s", (kind, title, category, label) => {
    expect(latestCompactActivity([activity("active", { kind, title })])).toMatchObject({ category, label });
  });

  it("chooses the most recent active operation and ignores stale completed turns", () => {
    const entries = [activity("old", { turnId: "old" }), activity("reading", { title: "Web Search" }), activity("finished", { kind: "file", status: "completed" })];
    expect(latestCompactActivity(entries, { activeTurnId: "turn" })).toMatchObject({ category: "research", activity: { id: "reading" } });
    expect(latestCompactActivity([activity("stale", { turnStatus: "completed" })])).toEqual({ category: "thinking", label: "Thinking" });
  });

  it.each([
    ["research", "files", "research", "Researching"],
    ["files", "Web Search", "files", "Editing files"],
    ["commands", "rg -n handler src", "commands", "Executing commands"],
  ] as const)("prioritizes concrete provider workType %s over legacy labels", (workType, title, category, label) => {
    expect(latestCompactActivity([activity("typed", { title, workType })])).toMatchObject({ category, label });
  });

  it("identifies an actual file read even when its old title is only the path", () => {
    expect(latestCompactActivity([activity("read", { title: "/project/src/App.tsx", workType: "research" })]))
      .toMatchObject({ category: "research", label: "Researching" });
  });

  it("does not infer research from arbitrary command prose or warning titles", () => {
    expect(latestCompactActivity([activity("tool", { title: "echo 'Web Search'" })])).toMatchObject({ category: "commands" });
    expect(latestCompactActivity([activity("warning", { kind: "warning", title: "Research failed" })])).toEqual({ category: "thinking", label: "Thinking" });
  });

  it("handles empty work and grouped tools without mutating them", () => {
    expect(latestCompactActivity([])).toEqual({ category: "thinking", label: "Thinking" });
    const tools: Activity[] = [{ id: "first", kind: "command", title: "npm test", status: "completed" }, { id: "last", kind: "command", title: "Web Fetch", status: "inProgress" }];
    expect(latestCompactActivity([{ kind: "commands", value: tools }])).toMatchObject({ category: "research", activity: tools[1] });
    expect(tools.map((tool) => tool.id)).toEqual(["first", "last"]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";
import { forgetQuestionRecords, restoreQuestionRequests, savedQuestionAnswers, saveQuestionAnswers, saveQuestionRequest } from "./agentQuestionRecords";
import { DURABLE_STORAGE_KEYS, flushPendingStateWrites, hydrateNativeStorage } from "./storage";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const question: ChatMessage = { id: "question", role: "assistant", text: "", turnId: "turn", questionRequestId: 42,
  questionRequestItemId: "item", questions: [{ id: "layout", title: "Which layout?" }] };

describe("durable agent questions", () => {
  beforeEach(async () => { await flushPendingStateWrites(); localStorage.clear(); invoke.mockReset().mockResolvedValue(null); });
  it("restores RPC questions and answers from native storage after the webview cache is lost", async () => {
    expect(DURABLE_STORAGE_KEYS).toContain("kiwi.agentQuestions");
    saveQuestionRequest("thread", question);
    saveQuestionAnswers("thread", question.id, { layout: ["Compact"] });
    await flushPendingStateWrites();
    const stored = JSON.parse(localStorage.getItem("kiwi.agentQuestions")!);
    localStorage.clear();
    invoke.mockResolvedValueOnce(stored);
    await hydrateNativeStorage(["kiwi.agentQuestions"]);
    expect(restoreQuestionRequests("thread", [], [], true)).toEqual([expect.objectContaining(question)]);
    expect(savedQuestionAnswers("thread", question.id)).toEqual({ layout: ["Compact"] });
  });
  it("restores only the loaded page's questions, once, after their own turn", () => {
    saveQuestionRequest("thread", question);
    saveQuestionRequest("thread", { ...question, id: "older-question", turnId: "older" });
    const history: ChatMessage[] = [{ id: "first", role: "user", text: "one", turnId: "turn", timelineOrder: 1 },
      { id: "second", role: "user", text: "two", turnId: "next", timelineOrder: 3 }];
    const restored = restoreQuestionRequests("thread", history, []);
    expect(restored.map((message) => message.id)).toEqual(["first", "question", "second"]);
    expect(restoreQuestionRequests("thread", restored, [])).toEqual(restored);
  });
  it("removes a deleted thread's questions and answers without affecting another thread", () => {
    for (const thread of ["one", "two"]) {
      saveQuestionRequest(thread, question);
      saveQuestionAnswers(thread, question.id, { layout: [thread] });
    }
    forgetQuestionRecords("one");
    expect(restoreQuestionRequests("one", [], [], true)).toEqual([]);
    expect(savedQuestionAnswers("one", question.id)).toBeNull();
    expect(savedQuestionAnswers("two", question.id)).toEqual({ layout: ["two"] });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeTranscript } from "./claude";
import type { CursorTranscript } from "./cursor";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { deleteClaudeTranscript, loadClaudeTranscript, loadClaudeTranscriptPage, saveClaudeTranscript } from "./claude";
import { loadCursorTranscript, loadCursorTranscriptPage, saveCursorTranscript } from "./cursor";
import { listLocalTranscriptThreads, renameLocalTranscript, resetLocalTranscriptPersistenceForTests } from "./localTranscriptPersistence";

const thread = { id: "thread-a", name: "Local task", preview: "Hello", cwd: "/project", updatedAt: 1, modelProvider: "claude" };
const completed = { id: "old-answer", role: "assistant" as const, text: "Done", turnId: "turn-old", turnStatus: "completed" as const, timelineOrder: 1 };
const writeState = (generation: number) => ({ generation, headSeq: generation, tailSeq: generation + 1 });

describe("local transcript persistence adapters", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    resetLocalTranscriptPersistenceForTests();
  });

  it.each(["claude", "cursor"] as const)("renames an unopened %s thread without writing a snapshot or empty session ID", async (provider) => {
    tauri.invoke.mockResolvedValue(undefined);
    await renameLocalTranscript(provider, thread.id, "Renamed");
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("local_transcript_rename", { provider, threadId: thread.id, name: "Renamed" });
  });

  it("serializes renames after an in-flight transcript save", async () => {
    let finish!: (value: unknown) => void;
    tauri.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const saving = saveClaudeTranscript({ thread, messages: [completed], activities: [] });
    await Promise.resolve(); await Promise.resolve();
    const renaming = renameLocalTranscript("claude", thread.id, "Renamed");
    expect(tauri.invoke).not.toHaveBeenCalledWith("local_transcript_rename", expect.anything());
    finish({ ...writeState(1), rewrittenChunks: 1, totalChunks: 1, compatibilitySnapshotCreated: true });
    await saving; await renaming;
    expect(tauri.invoke.mock.calls.at(-1)).toEqual(["local_transcript_rename", { provider: "claude", threadId: thread.id, name: "Renamed" }]);
  });

  it("discovers durable local threads without loading their transcripts", async () => {
    const cursorThread = { ...thread, id: "thread-b", modelProvider: "cursor" };
    tauri.invoke.mockResolvedValueOnce([
      thread,
      cursorThread,
      { id: "broken", cwd: "/project", updatedAt: 2, modelProvider: "openai" },
      null,
    ]);

    await expect(listLocalTranscriptThreads()).resolves.toEqual([thread, cursorThread]);
    expect(tauri.invoke).toHaveBeenCalledWith("local_transcript_list", { knownThreadIds: [] });
  });

  it("passes the compact sidebar identities to native discovery", async () => {
    tauri.invoke.mockResolvedValueOnce([]);

    await expect(listLocalTranscriptThreads(["thread-a", "thread-b"])).resolves.toEqual([]);
    expect(tauri.invoke).toHaveBeenCalledWith("local_transcript_list", {
      knownThreadIds: ["thread-a", "thread-b"],
    });
  });

  it("loads a transcript and its small write token", async () => {
    const transcript: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(transcript).mockResolvedValueOnce(writeState(4));
    await expect(loadClaudeTranscript("thread-a")).resolves.toBe(transcript);
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "local_transcript_full_read", { provider: "claude", threadId: "thread-a" });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "local_transcript_write_state_read", { provider: "claude", threadId: "thread-a" });
  });

  it("keeps a readable transcript available when write-token acquisition fails", async () => {
    const transcript: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(transcript).mockRejectedValueOnce("temporary token failure");
    await expect(loadClaudeTranscript("thread-a")).resolves.toBe(transcript);
  });

  it("loads only a bounded newest page and acquires its write token", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page);

    await expect(loadClaudeTranscriptPage("thread-a")).resolves.toBe(page);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "local_transcript_page_read", {
      provider: "claude",
      threadId: "thread-a",
      cursor: null,
      byteBudget: 40 * 1024,
    });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it("fully recovers an interrupted paged tail before a new turn can replace it", async () => {
    const interrupted = { ...completed, id: "interrupted", turnId: "turn-interrupted", turnStatus: undefined };
    const page = {
      thread,
      messages: [interrupted],
      activities: [],
      nextCursor: "9:2",
      headSeq: 3,
      tailSeq: 3,
      generation: 9,
      byteLen: 8_000,
    };
    const full: ClaudeTranscript = {
      thread,
      messages: [{ ...completed, id: "older" }, interrupted],
      activities: [],
    };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce({ ...writeState(10), rewrittenChunks: 2, totalChunks: 2, compatibilitySnapshotCreated: true });

    const recovered = await loadClaudeTranscriptPage("thread-a");
    expect(recovered).toMatchObject({
      messages: full.messages,
      nextCursor: null,
      headSeq: 3,
      tailSeq: 3,
      generation: 9,
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "local_transcript_full_read", { provider: "claude", threadId: "thread-a" });

    await saveClaudeTranscript({
      thread,
      messages: [...full.messages, { id: "new-turn", role: "user", text: "continue", turnId: "turn-new", timelineOrder: 3 }],
      activities: [],
    });

    expect(tauri.invoke).toHaveBeenNthCalledWith(3, "local_transcript_snapshot_write", expect.objectContaining({
      provider: "claude",
    }));
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_tail_write")).toBe(false);
  });

  it("loads an older page without replacing the newest-page write state", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: null,
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page);

    await expect(loadClaudeTranscriptPage("thread-a", "4:2")).resolves.toBe(page);

    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("local_transcript_page_read", {
      provider: "claude",
      threadId: "thread-a",
      cursor: "4:2",
      byteBudget: 40 * 1024,
    });
  });

  it("updates metadata from a partial page without replacing unseen history", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(writeState(4));
    await loadClaudeTranscriptPage("thread-a");
    const renamed = { ...page, thread: { ...thread, name: "Renamed" } };

    await saveClaudeTranscript(renamed);

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_metadata_write", {
      provider: "claude",
      threadId: "thread-a",
      thread: renamed.thread,
      cursorSessionId: null,
      expectedGeneration: 4,
    });
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("appends a newly completed turn from a partial page instead of dropping it as metadata", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const completedNext = {
      id: "next-answer",
      role: "assistant" as const,
      text: "Finished before the debounce elapsed",
      turnId: "turn-next",
      turnStatus: "completed" as const,
      timelineOrder: 2,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(writeState(5));
    await loadClaudeTranscriptPage("thread-a");

    await saveClaudeTranscript({
      ...page,
      messages: [...page.messages, completedNext],
    });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_tail_write", {
      provider: "claude",
      expectedGeneration: 4,
      seal: true,
      value: { thread, messages: [completedNext], activities: [] },
    });
  });

  it("uses the same completed-turn tail path for Cursor transcripts", async () => {
    const cursorThread = { ...thread, modelProvider: "cursor" as const };
    const page = {
      thread: cursorThread,
      cursorSessionId: "cursor-session",
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const completedNext = {
      id: "cursor-answer",
      role: "assistant" as const,
      text: "Done",
      turnId: "cursor-turn-next",
      turnStatus: "completed" as const,
      timelineOrder: 2,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(writeState(5));
    await loadCursorTranscriptPage("thread-a");

    await saveCursorTranscript({ ...page, messages: [...page.messages, completedNext] });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_tail_write", {
      provider: "cursor",
      expectedGeneration: 4,
      seal: true,
      value: {
        thread: cursorThread,
        cursorSessionId: "cursor-session",
        messages: [completedNext],
        activities: [],
      },
    });
  });

  it("writes every completed turn that arrived within one debounce window", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const first = { ...completed, id: "first-fast", turnId: "turn-fast-1", text: "First", timelineOrder: 2 };
    const second = { ...completed, id: "second-fast", turnId: "turn-fast-2", text: "Second", timelineOrder: 3 };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(writeState(5))
      .mockResolvedValueOnce(writeState(6));
    await loadClaudeTranscriptPage("thread-a");

    await saveClaudeTranscript({ ...page, messages: [...page.messages, first, second] });

    const writes = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write");
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toMatchObject({ expectedGeneration: 4, seal: true, value: { messages: [first] } });
    expect(writes[1][1]).toMatchObject({ expectedGeneration: 5, seal: true, value: { messages: [second] } });
  });

  it("persists an intervening completed turn before the newest active turn", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const completedNext = { ...completed, id: "fast-complete", turnId: "turn-fast", timelineOrder: 2 };
    const active = {
      id: "active-answer",
      role: "assistant" as const,
      text: "Still running",
      turnId: "turn-active",
      timelineOrder: 3,
    };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(writeState(5))
      .mockResolvedValueOnce({ generation: 6, headSeq: 5, tailSeq: 5 });
    await loadClaudeTranscriptPage("thread-a");

    await saveClaudeTranscript({ ...page, messages: [...page.messages, completedNext, active] });

    const writes = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write");
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toMatchObject({
      expectedGeneration: 4,
      seal: true,
      value: { messages: [completedNext] },
    });
    expect(writes[1][1]).toMatchObject({
      expectedGeneration: 5,
      seal: false,
      value: { messages: [active] },
    });
  });

  it("persists an intervening completed turn before a pending turn id is assigned", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const completedNext = { ...completed, id: "fast-complete", turnId: "turn-fast", timelineOrder: 2 };
    const pending = { id: "pending-user", role: "user" as const, text: "Next", timelineOrder: 3 };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(writeState(5))
      .mockResolvedValueOnce({ generation: 6, headSeq: 5, tailSeq: 5 });
    await loadClaudeTranscriptPage("thread-a");

    await saveClaudeTranscript({ ...page, messages: [...page.messages, completedNext, pending] });

    const writes = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write");
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toMatchObject({ expectedGeneration: 4, seal: true, value: { messages: [completedNext] } });
    expect(writes[1][1]).toMatchObject({ expectedGeneration: 5, seal: false, value: { messages: [pending] } });
  });

  it("seals the previously saved mutable turn before appending a newer active turn", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const activeB = { id: "answer-b", role: "assistant" as const, text: "B", turnId: "turn-b", timelineOrder: 2 };
    const completedB = { ...activeB, turnStatus: "completed" as const };
    const activeC = { id: "answer-c", role: "assistant" as const, text: "C", turnId: "turn-c", timelineOrder: 3 };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ generation: 5, headSeq: 4, tailSeq: 4 })
      .mockResolvedValueOnce(writeState(6))
      .mockResolvedValueOnce({ generation: 7, headSeq: 5, tailSeq: 5 });
    await loadClaudeTranscriptPage("thread-a");
    await saveClaudeTranscript({ ...page, messages: [...page.messages, activeB] });

    await saveClaudeTranscript({ ...page, messages: [...page.messages, completedB, activeC] });

    const writes = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write");
    expect(writes).toHaveLength(3);
    expect(writes[1][1]).toMatchObject({ expectedGeneration: 5, seal: true, value: { messages: [completedB] } });
    expect(writes[2][1]).toMatchObject({ expectedGeneration: 6, seal: false, value: { messages: [activeC] } });
  });

  it("rejects a newer active turn while the previously saved mutable turn is still active", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const activeB = { id: "answer-b", role: "assistant" as const, text: "B", turnId: "turn-b", timelineOrder: 2 };
    const activeC = { id: "answer-c", role: "assistant" as const, text: "C", turnId: "turn-c", timelineOrder: 3 };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ generation: 5, headSeq: 4, tailSeq: 4 });
    await loadClaudeTranscriptPage("thread-a");
    await saveClaudeTranscript({ ...page, messages: [...page.messages, activeB] });

    await expect(saveClaudeTranscript({ ...page, messages: [...page.messages, activeB, activeC] }))
      .rejects.toThrow("full reload");
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write")).toHaveLength(1);
  });

  it("deduplicates completed turns with missing timeline order across messages and activities", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const firstMessage = { ...completed, id: "first-message", turnId: "turn-fast-1", timelineOrder: undefined };
    const secondMessage = { ...completed, id: "second-message", turnId: "turn-fast-2", timelineOrder: undefined };
    const firstActivity = {
      id: "first-activity",
      kind: "command" as const,
      title: "first",
      status: "completed",
      turnId: "turn-fast-1",
      turnStatus: "completed" as const,
    };
    const secondActivity = { ...firstActivity, id: "second-activity", title: "second", turnId: "turn-fast-2" };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(writeState(5))
      .mockResolvedValueOnce(writeState(6));
    await loadClaudeTranscriptPage("thread-a");

    await saveClaudeTranscript({
      ...page,
      messages: [...page.messages, firstMessage, secondMessage],
      activities: [firstActivity, secondActivity],
    });

    const writes = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write");
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toMatchObject({
      expectedGeneration: 4,
      value: { messages: [firstMessage], activities: [firstActivity] },
    });
    expect(writes[1][1]).toMatchObject({
      expectedGeneration: 5,
      value: { messages: [secondMessage], activities: [secondActivity] },
    });
  });

  it("does not snapshot unseen history when a completed-turn tail hits a generation conflict", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const completedNext = { ...completed, id: "next", turnId: "turn-next", timelineOrder: 2 };
    tauri.invoke.mockResolvedValueOnce(page).mockRejectedValueOnce("Local transcript generation is stale");
    await loadClaudeTranscriptPage("thread-a");

    await expect(saveClaudeTranscript({ ...page, messages: [...page.messages, completedNext] }))
      .rejects.toThrow("reload it before saving");
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("saves an active partial-page turn through the generation-safe tail", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(writeState(5));
    await loadClaudeTranscriptPage("thread-a");
    const running = {
      ...page,
      messages: [...page.messages, { id: "live", role: "assistant" as const, text: "Part", turnId: "turn-new", timelineOrder: 2 }],
    };

    await saveClaudeTranscript(running);

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_tail_write", {
      provider: "claude",
      expectedGeneration: 4,
      seal: false,
      value: { thread, messages: running.messages.slice(1), activities: [] },
    });
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("persists a context compaction marker in its chronological place", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(writeState(5));
    await loadClaudeTranscriptPage("thread-a");
    const marker = {
      id: "claude-compaction-boundary-1",
      kind: "compaction" as const,
      compaction: { boundaryId: "boundary-1", endStatusId: "end-1" },
      title: "Context compacted",
      detail: "Claude Code · Automatic · 154K tokens before",
      status: "completed",
      turnId: "turn-new",
      timelineOrder: 2,
    };
    const compacted = {
      ...page,
      messages: [...page.messages, { id: "live", role: "assistant" as const, text: "Part", turnId: "turn-new", timelineOrder: 3 }],
      activities: [marker],
    };

    await saveClaudeTranscript(compacted);

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_tail_write", {
      provider: "claude",
      expectedGeneration: 4,
      seal: false,
      value: { thread, messages: compacted.messages.slice(1), activities: [marker] },
    });
  });

  it("refuses to recover a stale partial-page tail with a destructive snapshot", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    tauri.invoke.mockResolvedValueOnce(page).mockRejectedValueOnce("Local transcript generation is stale");
    await loadClaudeTranscriptPage("thread-a");

    await expect(saveClaudeTranscript({
      ...page,
      messages: [...page.messages, { id: "live", role: "assistant", text: "Part", turnId: "turn-new", timelineOrder: 2 }],
    })).rejects.toThrow("reload it before saving");

    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("retains the partial-write guard across a full read and token failure", async () => {
    const page = {
      thread,
      messages: [completed],
      activities: [],
      nextCursor: "4:2",
      headSeq: 3,
      tailSeq: 4,
      generation: 4,
      byteLen: 12_345,
    };
    const full: ClaudeTranscript = {
      thread,
      messages: [{ ...completed, id: "older" }, completed],
      activities: [],
    };
    tauri.invoke
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(full)
      .mockRejectedValueOnce("temporary token failure")
      .mockResolvedValueOnce(writeState(4));
    await loadClaudeTranscriptPage("thread-a");
    await loadClaudeTranscript("thread-a");

    await saveClaudeTranscript({ ...page, thread: { ...thread, name: "Renamed" } });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_metadata_write", expect.objectContaining({
      expectedGeneration: 4,
    }));
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("never evicts a partial-write guard when many local tasks are opened", async () => {
    tauri.invoke.mockImplementation((command: string, args?: { threadId?: string }) => {
      if (command === "local_transcript_page_read") {
        const threadId = String(args?.threadId);
        return Promise.resolve({
          thread: { ...thread, id: threadId },
          messages: [{ ...completed, id: `answer-${threadId}` }],
          activities: [],
          nextCursor: "1:0",
          headSeq: 1,
          tailSeq: 2,
          generation: 1,
          byteLen: 1_024,
        });
      }
      if (command === "local_transcript_metadata_write") return Promise.resolve(writeState(1));
      throw new Error(`Unexpected command: ${command}`);
    });
    for (let index = 0; index < 129; index += 1) {
      await loadClaudeTranscriptPage(`thread-${index}`);
    }

    await saveClaudeTranscript({
      thread: { ...thread, id: "thread-0", name: "Oldest renamed" },
      messages: [{ ...completed, id: "answer-thread-0" }],
      activities: [],
    });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_metadata_write", expect.objectContaining({
      threadId: "thread-0",
      expectedGeneration: 1,
    }));
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_snapshot_write")).toBe(false);
  });

  it("sends only the active turn and seals it on completion", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockResolvedValueOnce(writeState(2)).mockResolvedValueOnce(writeState(3));
    await loadClaudeTranscript("thread-a");
    const running: ClaudeTranscript = {
      thread,
      messages: [completed, { id: "user", role: "user", text: "Next", turnId: "turn-new", timelineOrder: 2 }, { id: "answer", role: "assistant", text: "Part", streaming: true, turnId: "turn-new", timelineOrder: 4 }],
      activities: [{ id: "tool", kind: "command", title: "test", status: "inProgress", turnId: "turn-new", timelineOrder: 3 }],
    };
    await saveClaudeTranscript(running);
    const finished: ClaudeTranscript = {
      ...running,
      messages: running.messages.map((message) => message.turnId === "turn-new" ? { ...message, streaming: false, turnStatus: "completed" } : message),
      activities: running.activities.map((activity) => ({ ...activity, status: "completed", turnStatus: "completed" })),
    };
    await saveClaudeTranscript(finished);
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, "local_transcript_tail_write", {
      provider: "claude", expectedGeneration: 1, seal: false,
      value: { thread, messages: running.messages.slice(1), activities: running.activities },
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(4, "local_transcript_tail_write", {
      provider: "claude", expectedGeneration: 2, seal: true,
      value: { thread, messages: finished.messages.slice(1), activities: finished.activities },
    });
  });

  it("does not traverse into or transmit a large sealed history", async () => {
    const history = Array.from({ length: 2_000 }, (_, index) => ({
      id: `old-${index}`,
      role: "assistant" as const,
      text: "old",
      turnId: `turn-${index}`,
      turnStatus: "completed" as const,
      timelineOrder: index + 1,
    }));
    const baseline: ClaudeTranscript = { thread, messages: history, activities: [] };
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockResolvedValueOnce(writeState(2));
    await loadClaudeTranscript("thread-a");
    await saveClaudeTranscript({
      thread,
      messages: [...history, { id: "live", role: "assistant", text: "new", turnId: "turn-live", timelineOrder: 2_001 }],
      activities: [],
    });
    const tailCall = tauri.invoke.mock.calls.find(([command]) => command === "local_transcript_tail_write");
    expect(tailCall?.[1].value.messages).toEqual([expect.objectContaining({ id: "live" })]);
  });

  it("replaces a pending no-id tail after the runtime assigns its turn id", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(5)).mockResolvedValueOnce(writeState(6)).mockResolvedValueOnce(writeState(7));
    await loadClaudeTranscript("thread-a");
    await saveClaudeTranscript({ thread, messages: [completed, { id: "user", role: "user", text: "Go", timelineOrder: 2 }], activities: [] });
    await saveClaudeTranscript({ thread, messages: [completed, { id: "user", role: "user", text: "Go", turnId: "turn-new", timelineOrder: 2 }], activities: [] });
    expect(tauri.invoke).toHaveBeenNthCalledWith(4, "local_transcript_tail_write", expect.objectContaining({
      expectedGeneration: 6,
      value: expect.objectContaining({ messages: [expect.objectContaining({ turnId: "turn-new" })] }),
    }));
  });

  it("replaces an initial pending snapshot when that same user message receives a turn id", async () => {
    const pending = { id: "local-first", role: "user" as const, text: "Go", timelineOrder: 1 };
    const assigned = { ...pending, turnId: "turn-first" };
    tauri.invoke.mockResolvedValueOnce(writeState(1)).mockResolvedValueOnce(writeState(2));

    await saveClaudeTranscript({ thread, messages: [pending], activities: [] });
    await saveClaudeTranscript({ thread, messages: [assigned], activities: [] });

    const snapshots = tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_snapshot_write");
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1][1]).toMatchObject({ value: { messages: [assigned] } });
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_tail_write")).toBe(false);
  });

  it("fully loads a sealed pending page before its user message gets a real turn id", async () => {
    const pending = { id: "local-first", role: "user" as const, text: "Go", timelineOrder: 2 };
    const page = { thread, messages: [pending], activities: [], nextCursor: "4:1", headSeq: 4, tailSeq: 5, generation: 4, byteLen: 8_000 };
    const full: ClaudeTranscript = { thread, messages: [completed, pending], activities: [] };
    tauri.invoke.mockResolvedValueOnce(page).mockResolvedValueOnce(full).mockResolvedValueOnce(writeState(5));

    await loadClaudeTranscriptPage("thread-a");
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "local_transcript_full_read", { provider: "claude", threadId: "thread-a" });
    await saveClaudeTranscript({ ...full, messages: [completed, { ...pending, turnId: "turn-first" }] });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_snapshot_write", expect.objectContaining({
      value: expect.objectContaining({ messages: [completed, expect.objectContaining({ id: pending.id, turnId: "turn-first" })] }),
    }));
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_tail_write")).toBe(false);
  });

  it("replaces a loaded full transcript's sealed pending prompt when its turn id arrives", async () => {
    const pending = { id: "local-first", role: "user" as const, text: "Go", timelineOrder: 2 };
    const full: ClaudeTranscript = { thread, messages: [completed, pending], activities: [] };
    tauri.invoke.mockResolvedValueOnce(full).mockResolvedValueOnce(writeState(4)).mockResolvedValueOnce(writeState(5));

    await loadClaudeTranscript("thread-a");
    await saveClaudeTranscript({ ...full, messages: [completed, { ...pending, turnId: "turn-first" }] });

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_snapshot_write", expect.objectContaining({
      value: expect.objectContaining({ messages: [completed, expect.objectContaining({ id: pending.id, turnId: "turn-first" })] }),
    }));
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_tail_write")).toBe(false);
  });

  it("uses a snapshot for a completed-turn metadata edit", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockResolvedValueOnce(writeState(1));
    await loadClaudeTranscript("thread-a");
    const renamed = { ...baseline, thread: { ...thread, name: "Renamed" } };
    await saveClaudeTranscript(renamed);
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, "local_transcript_snapshot_write", { provider: "claude", value: renamed });
    expect(tauri.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps full-history completed-turn saves on the snapshot path", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    const completedNext = { ...completed, id: "next", turnId: "turn-next", timelineOrder: 2 };
    const updated: ClaudeTranscript = { thread, messages: [completed, completedNext], activities: [] };
    tauri.invoke
      .mockResolvedValueOnce(baseline)
      .mockResolvedValueOnce(writeState(1))
      .mockResolvedValueOnce(writeState(2));
    await loadClaudeTranscript("thread-a");

    await saveClaudeTranscript(updated);

    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_snapshot_write", {
      provider: "claude",
      value: updated,
    });
    expect(tauri.invoke.mock.calls.some(([command]) => command === "local_transcript_tail_write")).toBe(false);
  });

  it("recovers a stale generation and stays snapshot-only until that turn seals", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    const running: ClaudeTranscript = { thread, messages: [completed, { id: "live", role: "assistant", text: "A", turnId: "turn-live", timelineOrder: 2 }], activities: [] };
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "local_transcript_full_read") return Promise.resolve(baseline);
      if (command === "local_transcript_tail_write") return Promise.reject("Local transcript generation is stale");
      if (command === "local_transcript_write_state_read") return Promise.resolve(writeState(9));
      return Promise.resolve(writeState(9));
    });
    await loadClaudeTranscript("thread-a");
    await saveClaudeTranscript(running);
    await saveClaudeTranscript({ ...running, messages: [completed, { ...running.messages[1], text: "AB" }] });
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write")).toHaveLength(1);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_snapshot_write")).toHaveLength(2);
  });

  it("keeps an active first save snapshot-only when no load established a tail", async () => {
    const running: ClaudeTranscript = { thread, messages: [{ id: "live", role: "assistant", text: "A", turnId: "turn-live", timelineOrder: 1 }], activities: [] };
    tauri.invoke
      .mockResolvedValueOnce(writeState(1))
      .mockResolvedValueOnce(writeState(2));

    await saveClaudeTranscript(running);
    await saveClaudeTranscript({ ...running, messages: [{ ...running.messages[0], text: "AB" }] });

    expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write")).toHaveLength(0);
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_snapshot_write")).toHaveLength(2);
  });

  it("serializes saves for one thread", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    let releaseFirst!: (value: unknown) => void;
    const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockReturnValueOnce(firstWrite).mockResolvedValueOnce(writeState(3));
    await loadClaudeTranscript("thread-a");
    const first = saveClaudeTranscript({ thread, messages: [completed, { id: "live", role: "assistant", text: "A", turnId: "turn-live", timelineOrder: 2 }], activities: [] });
    const second = saveClaudeTranscript({ thread, messages: [completed, { id: "live", role: "assistant", text: "AB", turnId: "turn-live", timelineOrder: 2 }], activities: [] });
    await vi.waitFor(() => {
      expect(tauri.invoke.mock.calls.filter(([command]) => command === "local_transcript_tail_write")).toHaveLength(1);
    });
    releaseFirst(writeState(2));
    await Promise.all([first, second]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("local_transcript_tail_write", expect.objectContaining({ expectedGeneration: 2 }));
  });

  it("supports Cursor and clears persistence when deleting", async () => {
    const transcript: CursorTranscript = { thread: { ...thread, modelProvider: "cursor" }, cursorSessionId: "session-a", messages: [], activities: [] };
    tauri.invoke.mockResolvedValueOnce(transcript).mockResolvedValueOnce(writeState(1));
    await expect(loadCursorTranscript("thread-a")).resolves.toBe(transcript);
    tauri.invoke.mockResolvedValueOnce({ generation: 1 }).mockResolvedValueOnce(writeState(1));
    await saveCursorTranscript(transcript);
    tauri.invoke.mockResolvedValueOnce(undefined);
    await deleteClaudeTranscript("different-thread");
    expect(tauri.invoke).toHaveBeenCalledWith("local_transcript_full_read", { provider: "cursor", threadId: "thread-a" });
    expect(tauri.invoke).toHaveBeenLastCalledWith("state_delete", { key: "kiwi.claudeThread.different-thread" });
  });

  it("waits for an in-flight save before deleting the same thread", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    let releaseSave!: (value: unknown) => void;
    const pendingSave = new Promise((resolve) => { releaseSave = resolve; });
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockReturnValueOnce(pendingSave);
    await loadClaudeTranscript("thread-a");
    const saving = saveClaudeTranscript({ thread, messages: [completed, { id: "live", role: "assistant", text: "A", turnId: "turn-live", timelineOrder: 2 }], activities: [] });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("local_transcript_tail_write", expect.anything()));
    const deleting = deleteClaudeTranscript("thread-a");
    await Promise.resolve();
    expect(tauri.invoke.mock.calls.some(([command]) => command === "state_delete")).toBe(false);
    tauri.invoke.mockResolvedValueOnce(undefined);
    releaseSave(writeState(2));
    await Promise.all([saving, deleting]);
    expect(tauri.invoke).toHaveBeenLastCalledWith("state_delete", { key: "kiwi.claudeThread.thread-a" });
  });
});

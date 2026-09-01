import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeTranscript } from "./claude";
import type { CursorTranscript } from "./cursor";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { deleteClaudeTranscript, loadClaudeTranscript, loadClaudeTranscriptPage, saveClaudeTranscript } from "./claude";
import { loadCursorTranscript, saveCursorTranscript } from "./cursor";
import { listLocalTranscriptThreads, resetLocalTranscriptPersistenceForTests } from "./localTranscriptPersistence";

const thread = { id: "thread-a", name: "Local task", preview: "Hello", cwd: "/project", updatedAt: 1, modelProvider: "claude" };
const completed = { id: "old-answer", role: "assistant" as const, text: "Done", turnId: "turn-old", turnStatus: "completed" as const, timelineOrder: 1 };
const writeState = (generation: number) => ({ generation, headSeq: generation, tailSeq: generation + 1 });

describe("local transcript persistence adapters", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    resetLocalTranscriptPersistenceForTests();
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

  it("uses a snapshot for a completed-turn metadata edit", async () => {
    const baseline: ClaudeTranscript = { thread, messages: [completed], activities: [] };
    tauri.invoke.mockResolvedValueOnce(baseline).mockResolvedValueOnce(writeState(1)).mockResolvedValueOnce(writeState(1));
    await loadClaudeTranscript("thread-a");
    const renamed = { ...baseline, thread: { ...thread, name: "Renamed" } };
    await saveClaudeTranscript(renamed);
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, "local_transcript_snapshot_write", { provider: "claude", value: renamed });
    expect(tauri.invoke).toHaveBeenCalledTimes(3);
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

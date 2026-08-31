import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeTranscript } from "./claude";
import type { CursorTranscript } from "./cursor";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { loadClaudeTranscript, saveClaudeTranscript } from "./claude";
import { loadCursorTranscript, saveCursorTranscript } from "./cursor";

const thread = {
  id: "thread-a",
  name: "Local task",
  preview: "Hello",
  cwd: "/project",
  updatedAt: 1,
  modelProvider: "claude",
};

describe("local transcript persistence adapters", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
  });

  it("routes Claude loads and saves through the chunk store", async () => {
    const transcript: ClaudeTranscript = { thread, messages: [], activities: [] };
    tauri.invoke.mockResolvedValueOnce(transcript).mockResolvedValueOnce(undefined);

    await expect(loadClaudeTranscript("thread-a")).resolves.toBe(transcript);
    await saveClaudeTranscript(transcript);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "local_transcript_full_read", {
      provider: "claude",
      threadId: "thread-a",
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "local_transcript_snapshot_write", {
      provider: "claude",
      value: transcript,
    });
  });

  it("routes Cursor loads and saves through the chunk store", async () => {
    const transcript: CursorTranscript = {
      thread: { ...thread, modelProvider: "cursor" },
      cursorSessionId: "session-a",
      messages: [],
      activities: [],
    };
    tauri.invoke.mockResolvedValueOnce(transcript).mockResolvedValueOnce(undefined);

    await expect(loadCursorTranscript("thread-a")).resolves.toBe(transcript);
    await saveCursorTranscript(transcript);

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "local_transcript_full_read", {
      provider: "cursor",
      threadId: "thread-a",
    });
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "local_transcript_snapshot_write", {
      provider: "cursor",
      value: transcript,
    });
  });
});

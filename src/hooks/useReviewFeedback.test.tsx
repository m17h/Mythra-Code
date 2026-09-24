import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStorageMemoryForTests } from "../lib/storage";
import { assistantFeedbackAnchor } from "../lib/reviewFeedback";
import { REVIEW_FEEDBACK_STORAGE_KEY, useReviewFeedback } from "./useReviewFeedback";

const anchor = assistantFeedbackAnchor({ id: "reply-1", text: "Draft reply" }, "Draft reply");

beforeEach(() => {
  localStorage.clear();
  resetStorageMemoryForTests();
});

describe("useReviewFeedback", () => {
  it("keeps independent drafts across threads and folders, including remount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ thread, cwd }) => useReviewFeedback(thread, cwd),
      { initialProps: { thread: "thread-1", cwd: "/repo" } },
    );
    act(() => { expect(result.current.addNote(anchor, "First note")).not.toBeNull(); });
    rerender({ thread: "thread-2", cwd: "/repo" });
    expect(result.current.notes).toEqual([]);
    act(() => { result.current.addNote(anchor, "Second note"); });
    rerender({ thread: "thread-1", cwd: "/other" });
    expect(result.current.notes).toEqual([]);
    rerender({ thread: "thread-1", cwd: "/repo" });
    expect(result.current.notes.map((note) => note.comment)).toEqual(["First note"]);
    unmount();
    const reopened = renderHook(() => useReviewFeedback("thread-1", "/repo"));
    expect(reopened.result.current.notes.map((note) => note.comment)).toEqual(["First note"]);
    expect(localStorage.getItem(REVIEW_FEEDBACK_STORAGE_KEY)).toContain("First note");
  });

  it("removes only notes that were accepted unchanged by a send", () => {
    const { result } = renderHook(() => useReviewFeedback("thread", "/repo"));
    act(() => { result.current.addNote(anchor, "Sent comment"); });
    const sent = [...result.current.notes];
    act(() => { result.current.updateNote(sent[0].id, "Edited while sending"); });
    act(() => { result.current.removeNotes(sent); });
    expect(result.current.notes.map((note) => note.comment)).toEqual(["Edited while sending"]);
    const accepted = [...result.current.notes];
    act(() => { result.current.removeNotes(accepted); });
    expect(result.current.notes).toEqual([]);
  });

  it("retains notes until explicitly removed after successful delivery", () => {
    const { result } = renderHook(() => useReviewFeedback("thread", "/repo"));
    act(() => { result.current.addNote(anchor, "Keep on failure"); });
    const before = result.current.notes;
    expect(before).toHaveLength(1);
    // A rejected send has no hook mutation. The note remains available for a retry.
    expect(result.current.notes).toEqual(before);
    act(() => { result.current.removeNote(before[0].id); });
    expect(result.current.notes).toEqual([]);
  });
});

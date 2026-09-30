import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { projectChangesStore, useProjectGitChanges } from "./useProjectGitChanges";
import { projectHistoryStore, useProjectGitHistory } from "./useProjectGitHistory";
import type { GitChange, ProjectGitChanges, ProjectGitHistory } from "../lib/gitInspection";
import type { ProjectGitInspection } from "../lib/projectGit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const changesOf = (rows: GitChange[]): ProjectGitChanges => ({
  rootPath: "/p", rows, truncated: false,
  stagedFiles: rows.filter((row) => row.area === "staged").length,
  unstagedFiles: rows.filter((row) => row.area === "unstaged").length,
  untrackedFiles: rows.filter((row) => row.area === "untracked").length,
  changedFiles: new Set(rows.map((row) => row.path)).size,
});

function inspection(cwd: string, overrides: Partial<ProjectGitInspection> = {}): ProjectGitInspection {
  return {
    cwd,
    getChanges: vi.fn().mockResolvedValue(changesOf([{ path: "a.ts", originalPath: null, area: "unstaged", status: "M" }])),
    getFileDiff: vi.fn(async (_cwd: string, path: string, area) => ({ path, area, text: `diff for ${path}`, binary: false, truncated: false })),
    getHistory: vi.fn(),
    ...overrides,
  };
}

describe("useProjectGitChanges", () => {
  it("reads nothing until Changes is visible, then reads one list and no diffs", async () => {
    const api = inspection("/changes/visible");
    const { rerender, result } = renderHook(({ visible }) => useProjectGitChanges(api, visible, "r1"), { initialProps: { visible: false } });
    expect(api.getChanges).not.toHaveBeenCalled();
    rerender({ visible: true });
    await waitFor(() => expect(result.current.changes?.rows).toHaveLength(1));
    expect(api.getChanges).toHaveBeenCalledTimes(1);
    expect(api.getFileDiff).not.toHaveBeenCalled();
  });

  it("loads only the selected file's diff and follows it when it moves between groups", async () => {
    let rows: GitChange[] = [{ path: "a.ts", originalPath: null, area: "unstaged", status: "M" }, { path: "b.ts", originalPath: null, area: "unstaged", status: "M" }];
    const api = inspection("/changes/follow", { getChanges: vi.fn(async () => changesOf(rows)) });
    const { result, rerender } = renderHook(({ revision }) => useProjectGitChanges(api, true, revision), { initialProps: { revision: "1" } });
    await waitFor(() => expect(result.current.changes).not.toBeNull());
    act(() => result.current.select({ path: "a.ts", area: "unstaged" }));
    await waitFor(() => expect(result.current.diff?.text).toBe("diff for a.ts"));
    expect(api.getFileDiff).toHaveBeenCalledTimes(1);
    expect(api.getFileDiff).toHaveBeenCalledWith("/changes/follow", "a.ts", "unstaged");
    rows = [{ path: "a.ts", originalPath: null, area: "staged", status: "M" }, { path: "b.ts", originalPath: null, area: "unstaged", status: "M" }];
    rerender({ revision: "2" });
    await waitFor(() => expect(result.current.selected).toEqual({ path: "a.ts", area: "staged" }));
    await waitFor(() => expect(api.getFileDiff).toHaveBeenLastCalledWith("/changes/follow", "a.ts", "staged"));
  });

  it("stores a late result under the checkout it was read for, never the one now on screen", async () => {
    const pending = deferred<ProjectGitChanges>();
    const first = inspection("/changes/first", { getChanges: vi.fn(() => pending.promise) });
    const second = inspection("/changes/second");
    const { result, rerender } = renderHook(({ api }) => useProjectGitChanges(api, true, "r"), { initialProps: { api: first } });
    rerender({ api: second });
    await waitFor(() => expect(result.current.changes?.rows[0].path).toBe("a.ts"));
    await act(async () => pending.resolve(changesOf([{ path: "first-only.ts", originalPath: null, area: "untracked", status: "?" }])));
    expect(result.current.changes?.rows[0].path).toBe("a.ts");
    expect(projectChangesStore.get("/changes/first").changes?.rows[0].path).toBe("first-only.ts");
  });

  it("reports a malformed native answer as an error instead of crashing", async () => {
    const api = inspection("/changes/malformed", { getChanges: vi.fn().mockResolvedValue(undefined) });
    const { result } = renderHook(() => useProjectGitChanges(api, true, "r"));
    await waitFor(() => expect(result.current.error).toMatch(/no Changes list/));
  });
});

describe("useProjectGitHistory", () => {
  const page = (subjects: string[], hasMore: boolean, nextOffset: number, headOid = "h".repeat(40)): ProjectGitHistory => ({
    entries: subjects.map((subject, index) => ({ oid: `${subject}${index}`.padEnd(40, "0"), shortOid: subject.slice(0, 7), subject, authorName: "A", authoredAt: "2026-09-28T10:00:00Z" })),
    hasMore, nextOffset, headOid, truncated: false,
  });

  it("reads the first page when opened and pins later pages to that commit", async () => {
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page(["one", "two"], true, 2, "a".repeat(40)))
      .mockResolvedValueOnce(page(["three"], false, 3, "a".repeat(40)));
    const api = inspection("/history/pinned", { getHistory });
    const { result, rerender } = renderHook(({ visible }) => useProjectGitHistory(api, visible), { initialProps: { visible: false } });
    expect(getHistory).not.toHaveBeenCalled();
    rerender({ visible: true });
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(getHistory).toHaveBeenLastCalledWith("/history/pinned", 0, 30, null);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    expect(getHistory).toHaveBeenLastCalledWith("/history/pinned", 2, 30, "a".repeat(40));
    expect(result.current.hasMore).toBe(false);
  });

  it("reload starts again from the current commit and drops an older page", async () => {
    const slow = deferred<ProjectGitHistory>();
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page(["old"], true, 1, "a".repeat(40)))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(page(["new"], false, 1, "b".repeat(40)));
    const api = inspection("/history/reload", { getHistory });
    const { result } = renderHook(() => useProjectGitHistory(api, true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    act(() => result.current.loadMore());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.headOid).toBe("b".repeat(40)));
    await act(async () => slow.resolve(page(["stale"], false, 2, "a".repeat(40))));
    expect(result.current.entries.map((entry) => entry.subject)).toEqual(["new"]);
  });

  it("retries a failed reload from current HEAD even when older entries remain cached", async () => {
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page(["old"], true, 1, "a".repeat(40)))
      .mockRejectedValueOnce(new Error("reload failed"))
      .mockResolvedValueOnce(page(["new"], false, 1, "b".repeat(40)));
    const api = inspection("/history/retry-reload", { getHistory });
    const { result } = renderHook(() => useProjectGitHistory(api, true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe("reload failed"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.entries[0].subject).toBe("new"));
    expect(getHistory).toHaveBeenLastCalledWith(api.cwd, 0, 30, null);
  });

  it("preserves the pinned base page when a pending pagination scope is evicted", async () => {
    const pending = deferred<ProjectGitHistory>();
    const head = "a".repeat(40);
    const getHistory = vi.fn().mockResolvedValueOnce(page(["first"], true, 1, head)).mockReturnValueOnce(pending.promise);
    const api = inspection("/history/evicted", { getHistory });
    const { result } = renderHook(() => useProjectGitHistory(api, true));
    await waitFor(() => expect(result.current.entries[0]?.subject).toBe("first"));
    act(() => result.current.loadMore());
    act(() => {
      for (let index = 0; index < 16; index += 1) projectHistoryStore.update(`/history/eviction-${index}`, { loaded: true });
    });
    expect(projectHistoryStore.get(api.cwd).loaded).toBe(false);
    await act(async () => pending.resolve(page(["second"], false, 2, head)));
    expect(result.current.entries.map((entry) => entry.subject)).toEqual(["first", "second"]);
    expect(result.current.headOid).toBe(head);
  });

  it("retries failed older-page reads at the pinned offset even after scope eviction", async () => {
    const pending = deferred<ProjectGitHistory>();
    const head = "b".repeat(40);
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page(["first"], true, 1, head))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page(["second"], false, 2, head));
    const api = inspection("/history/evicted-failure", { getHistory });
    const { result } = renderHook(() => useProjectGitHistory(api, true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.loadMore());
    act(() => {
      for (let index = 0; index < 16; index += 1) projectHistoryStore.update(`/history/error-eviction-${index}`, { loaded: true });
    });
    await act(async () => pending.reject(new Error("older page failed")));
    expect(result.current.entries.map((entry) => entry.subject)).toEqual(["first"]);
    expect(result.current.failedRequest).toBe("more");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(getHistory).toHaveBeenLastCalledWith(api.cwd, 1, 30, head);
    expect(result.current.headOid).toBe(head);
  });

  it("an evicted old page cannot finish a newer reload's loading state or replace its HEAD", async () => {
    const older = deferred<ProjectGitHistory>();
    const latest = deferred<ProjectGitHistory>();
    const getHistory = vi.fn()
      .mockResolvedValueOnce(page(["first"], true, 1, "a".repeat(40)))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);
    const api = inspection("/history/evicted-overtaken", { getHistory });
    const { result } = renderHook(() => useProjectGitHistory(api, true));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.loadMore());
    act(() => {
      for (let index = 0; index < 16; index += 1) projectHistoryStore.update(`/history/overtaken-eviction-${index}`, { loaded: true });
      result.current.reload();
    });
    await act(async () => older.resolve(page(["stale older"], false, 2, "a".repeat(40))));
    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);
    await act(async () => latest.resolve(page(["latest"], false, 1, "b".repeat(40))));
    expect(result.current.loading).toBe(false);
    expect(result.current.headOid).toBe("b".repeat(40));
    expect(result.current.entries.map((entry) => entry.subject)).toEqual(["latest"]);
  });
});

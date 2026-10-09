import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GitWorkspaceSnapshot } from "../lib/gitWorkspace";
import type { ProjectGitChanges } from "../lib/gitInspection";
import type { ProjectGitInspection } from "../lib/projectGit";
import { useProjectGitChanges } from "./useProjectGitChanges";

const snapshot = (changes: ProjectGitChanges): GitWorkspaceSnapshot => ({ branch: "main", headOid: "oid", rootPath: changes.rootPath, stagedFiles: changes.stagedFiles, unstagedFiles: changes.unstagedFiles, changedFiles: changes.changedFiles, stagedPaths: [], branches: [], changes });
const inspection = (cwd: string): ProjectGitInspection => ({ cwd, getChanges: vi.fn(), getFileDiff: vi.fn(async (_cwd, path, area) => ({ path, area, text: `${area} diff`, binary: false, truncated: false })), getHistory: vi.fn() });

describe("shared Changes status", () => {
  it("clears cached rows and a pending preview when the owner cannot safely represent filenames", async () => {
    const api = inspection("/invalid-filename-status");
    const rows: ProjectGitChanges = { rootPath: api.cwd, rows: [{ path: "a.ts", originalPath: null, area: "unstaged", status: "M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
    const onRefresh = vi.fn();
    let finishDiff!: (value: Awaited<ReturnType<ProjectGitInspection["getFileDiff"]>>) => void;
    vi.mocked(api.getFileDiff).mockImplementationOnce(() => new Promise((resolve) => { finishDiff = resolve; }));
    const failed = { ...snapshot(rows), changes: null, changesError: "A Git filename is not valid UTF-8 and cannot be selected safely" };
    const view = renderHook(({ owner, revision }) => useProjectGitChanges(api, true, revision, { snapshot: owner, onRefresh }), { initialProps: { owner: snapshot(rows) as GitWorkspaceSnapshot, revision: "1" } });
    act(() => view.result.current.select({ path: "a.ts", area: "unstaged" }));
    view.rerender({ owner: failed, revision: "2" });
    expect(view.result.current.error).toBe(failed.changesError);
    expect(view.result.current.changes).toBeNull();
    expect(view.result.current.selected).toBeNull();
    expect(view.result.current.loading).toBe(false);
    act(() => view.result.current.select({ path: "unsafe-replacement.ts", area: "unstaged" }));
    expect(api.getFileDiff).toHaveBeenCalledOnce();
    await act(async () => finishDiff({ path: "a.ts", area: "unstaged", text: "late old diff", binary: false, truncated: false }));
    expect(view.result.current.diff).toBeNull();
    view.rerender({ owner: failed, revision: "3" });
    expect(api.getChanges).not.toHaveBeenCalled();
    act(() => view.result.current.refresh());
    expect(onRefresh).toHaveBeenCalledOnce();
    view.rerender({ owner: snapshot(rows), revision: "4" });
    expect(view.result.current.changes).toEqual(rows);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.selected).toBeNull();
  });

  it("rejects an older-runtime fallback result after an authoritative filename error", async () => {
    const api = inspection("/invalid-filename-fallback");
    const rows: ProjectGitChanges = { rootPath: api.cwd, rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    const legacy = snapshot(rows);
    delete legacy.changes;
    let finish!: (value: ProjectGitChanges) => void;
    vi.mocked(api.getChanges).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(({ owner, revision }) => useProjectGitChanges(api, true, revision, { snapshot: owner, onRefresh: vi.fn() }), { initialProps: { owner: legacy, revision: "1" } });
    expect(api.getChanges).toHaveBeenCalledOnce();
    const failed = { ...legacy, changes: null, changesError: "A Git filename is not valid UTF-8 and cannot be selected safely" };
    view.rerender({ owner: failed, revision: "2" });
    await act(async () => finish(rows));
    expect(view.result.current.error).toBe(failed.changesError);
    expect(view.result.current.changes).toBeNull();
    expect(view.result.current.loading).toBe(false);
    expect(api.getChanges).toHaveBeenCalledOnce();
  });

  it("treats an explicit missing list as unavailable rather than the legacy omitted-list contract", () => {
    const api = inspection("/explicit-null-status");
    const owner: GitWorkspaceSnapshot = { branch: "main", headOid: "oid", rootPath: api.cwd, stagedFiles: 0, unstagedFiles: 1, changedFiles: 1, stagedPaths: [], branches: [], changes: null };
    const view = renderHook(() => useProjectGitChanges(api, true, "1", { snapshot: owner, onRefresh: vi.fn() }));
    expect(view.result.current.error).toBe("Git returned no Changes list for this folder.");
    expect(view.result.current.loading).toBe(false);
    expect(api.getChanges).not.toHaveBeenCalled();
  });

  it("waits for the owner's initial read, follows staging, and routes manual refresh to that owner", async () => {
    const api = inspection("/wait-shared-status");
    const onRefresh = vi.fn();
    const rows: ProjectGitChanges = { rootPath: api.cwd, rows: [{ path: "a.ts", originalPath: null, area: "unstaged", status: "M" }], stagedFiles: 0, unstagedFiles: 1, untrackedFiles: 0, changedFiles: 1, truncated: false };
    const view = renderHook(({ owner, revision }) => useProjectGitChanges(api, true, revision, { snapshot: owner, onRefresh }), { initialProps: { owner: null as GitWorkspaceSnapshot | null, revision: "0" } });
    expect(view.result.current.loading).toBe(true);
    expect(api.getChanges).not.toHaveBeenCalled();
    view.rerender({ owner: snapshot(rows), revision: "1" });
    act(() => view.result.current.select({ path: "a.ts", area: "unstaged" }));
    await waitFor(() => expect(view.result.current.diff?.text).toBe("unstaged diff"));
    view.rerender({ owner: snapshot({ ...rows, rows: [{ ...rows.rows[0], area: "staged" }], stagedFiles: 1, unstagedFiles: 0 }), revision: "2" });
    await waitFor(() => expect(view.result.current.diff?.text).toBe("staged diff"));
    expect(view.result.current.selected?.area).toBe("staged");
    act(() => view.result.current.refresh());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(api.getChanges).not.toHaveBeenCalled();
    view.rerender({ owner: snapshot({ ...rows, rows: [], changedFiles: 0, unstagedFiles: 0 }), revision: "3" });
    expect(view.result.current.selected).toBeNull();
    expect(view.result.current.diff).toBeNull();
  });

  it("preserves older-runtime fallback and rejects a late read superseded by shared status", async () => {
    const api = inspection("/legacy-shared-status");
    const rows: ProjectGitChanges = { rootPath: api.cwd, rows: [], stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, changedFiles: 0, truncated: false };
    const legacy = snapshot(rows);
    delete legacy.changes;
    let finish!: (value: ProjectGitChanges) => void;
    vi.mocked(api.getChanges).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(({ owner }) => useProjectGitChanges(api, true, owner.changes ? "2" : "1", { snapshot: owner, onRefresh: vi.fn() }), { initialProps: { owner: legacy } });
    expect(api.getChanges).toHaveBeenCalledOnce();
    const fresh = { ...rows, rows: [{ path: "new.ts", area: "untracked" as const, originalPath: null, status: "?" }], untrackedFiles: 1, changedFiles: 1 };
    view.rerender({ owner: snapshot(fresh) });
    await act(async () => finish(rows));
    expect(view.result.current.changes).toEqual(fresh);
    expect(view.result.current.loading).toBe(false);
  });
});

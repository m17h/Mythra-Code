import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectPullRequestScope, projectPullRequestStore, useProjectPullRequests } from "./useProjectPullRequests";
import { acquirePullRequestMutation, isPullRequestMutationRunning, releasePullRequestMutation } from "../lib/pullRequestOperations";
import type { ProjectPullRequestAccess } from "../lib/projectGit";
import type { PullRequest, PullRequestSummary } from "../lib/pullRequests";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const summary = (number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, title: `PR ${number}`,
  state: "OPEN", isDraft: false, headRefName: `feature/${number}`, baseRefName: "main", updatedAt: "2026-09-28T10:00:00Z", authorLogin: "octo",
  ...overrides,
});
const detail = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  ...summary(number), body: "", headOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
  checks: [], canMerge: true, viewerCanMerge: true, autoMergeAllowed: false, mergeMethods: ["squash"], ...overrides,
});
const confirmed = (number = 7, headOid = "a".repeat(40)) => ({ repository: "owner/repo", number, headOid });

function access(cwd: string, overrides: Partial<ProjectPullRequestAccess> = {}): ProjectPullRequestAccess {
  return {
    cwd, projectPath: cwd, repository: "owner/repo", authenticated: true, threadActive: false, isolated: false,
    mutationBlockedReason: null,
    checkMutationAllowed: vi.fn(() => null),
    list: vi.fn().mockResolvedValue([summary(7), summary(8)]),
    view: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number)),
    context: vi.fn().mockResolvedValue({ repository: "owner/repo", branch: "feature/7", defaultBranch: "main", headOid: "c".repeat(40), dirty: false, ahead: 1, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"] }),
    find: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    merge: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number, { state: "MERGED" })),
    ready: vi.fn(),
    createBranch: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

describe("useProjectPullRequests", () => {
  beforeEach(() => projectPullRequestStore.clear());

  it.each(["merge", "ready"] as const)("a late %s does not overwrite another selected PR", async (action) => {
    const pending = deferred<PullRequest>();
    const api = access(`/prs/late-${action}`, { [action]: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    let writing!: Promise<void>;
    act(() => { writing = action === "merge" ? result.current.merge("squash", false, confirmed()) : result.current.markReady(confirmed()); });
    act(() => { result.current.select(null); result.current.select({ repository: "owner/repo", number: 8 }); });
    await waitFor(() => expect(result.current.detail?.number).toBe(8));
    await act(async () => { pending.resolve(detail(7, action === "merge" ? { state: "MERGED" } : { isDraft: false })); await writing; });
    expect(result.current.selected?.number).toBe(8);
    expect(result.current.detail?.number).toBe(8);
    expect(api.onChanged).toHaveBeenCalledWith(api.cwd);
  });

  it("a late creation does not replace a newer selection", async () => {
    const pending = deferred<ReturnType<typeof detail> & { creationOutcome: "created" }>();
    const api = access("/prs/late-create", { create: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.context).not.toBeNull());
    let writing!: Promise<void>;
    act(() => { writing = result.current.create({ head: "feature/7", base: "main", title: "New", body: "", draft: false, commitAll: false, expectedHeadOid: "c".repeat(40) }); });
    act(() => result.current.select({ repository: "owner/repo", number: 8 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(8));
    await act(async () => { pending.resolve({ ...detail(12, { headRefName: "feature/7" }), creationOutcome: "created" }); await writing; });
    expect(result.current.selected?.number).toBe(8);
    expect(result.current.detail?.number).toBe(8);
    expect(result.current.notice).toMatch(/#12/);
  });

  it.each(["before", "during"])("invalidates an older detail read started %s the mutation", async (timing) => {
    const pendingRead = deferred<PullRequest>();
    const pendingMerge = deferred<PullRequest>();
    const api = access(`/prs/stale-detail-${timing}`, { merge: vi.fn(() => pendingMerge.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    vi.mocked(api.view).mockImplementationOnce(() => pendingRead.promise);
    if (timing === "before") act(() => result.current.refreshDetail());
    let writing!: Promise<void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()); });
    if (timing === "during") act(() => result.current.refreshDetail());
    await act(async () => { pendingMerge.resolve(detail(7, { state: "MERGED" })); await writing; });
    expect(result.current.detail?.state).toBe("MERGED");
    await act(async () => { pendingRead.resolve(detail(7)); });
    expect(result.current.detail?.state).toBe("MERGED");
    expect(result.current.detailLoading).toBe(false);
  });

  it("a pre-mutation list response cannot overwrite the post-mutation list", async () => {
    const pendingList = deferred<PullRequestSummary[]>();
    const pendingMerge = deferred<PullRequest>();
    const api = access("/prs/stale-list", { merge: vi.fn(() => pendingMerge.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    vi.mocked(api.list).mockImplementationOnce(() => pendingList.promise).mockResolvedValue([summary(8)]);
    act(() => result.current.search("", "open"));
    let writing!: Promise<void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()); });
    await act(async () => { pendingMerge.resolve(detail(7, { state: "MERGED" })); await writing; });
    await waitFor(() => expect(result.current.items?.map((item) => item.number)).toEqual([8]));
    await act(async () => { pendingList.resolve([summary(7), summary(8)]); });
    expect(result.current.items?.map((item) => item.number)).toEqual([8]);
  });

  it("marking ready refreshes the list and branch context", async () => {
    const api = access("/prs/ready-refresh", { ready: vi.fn().mockResolvedValue(detail(7)), list: vi.fn().mockResolvedValue([summary(7, { isDraft: true })]) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    vi.mocked(api.list).mockResolvedValue([summary(7)]);
    const contextReads = vi.mocked(api.context).mock.calls.length;
    await act(() => result.current.markReady(confirmed()));
    await waitFor(() => expect(result.current.items?.[0].isDraft).toBe(false));
    expect(vi.mocked(api.context).mock.calls.length).toBeGreaterThan(contextReads);
  });

  it("does not submit a typed search draft when an earlier mutation completes", async () => {
    const pending = deferred<PullRequest>();
    const api = access("/prs/search-draft", { merge: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    let writing!: Promise<void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()); });
    act(() => { result.current.select(null); result.current.setQuery("author:unsubmitted"); });
    await act(async () => { pending.resolve(detail(7, { state: "MERGED" })); await writing; });
    expect(api.list).toHaveBeenLastCalledWith(api.projectPath, api.repository, { search: undefined, state: "open", limit: 30 });
    expect(result.current.query).toBe("author:unsubmitted");
    expect(result.current.appliedQuery).toBe("");
  });

  it("retries the failed applied search without submitting a newer input draft", async () => {
    const api = access("/prs/search-retry");
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    vi.mocked(api.list).mockRejectedValueOnce(new Error("Search unavailable"));
    act(() => result.current.search("author:applied", "merged"));
    await waitFor(() => expect(result.current.listError).toBe("Search unavailable"));
    act(() => result.current.setQuery("author:unsubmitted"));
    act(() => result.current.retryList());
    await waitFor(() => expect(result.current.listError).toBeNull());
    expect(api.list).toHaveBeenLastCalledWith(api.projectPath, api.repository, { search: "author:applied", state: "merged", limit: 30 });
    expect(result.current.query).toBe("author:unsubmitted");
    expect(result.current.appliedQuery).toBe("author:applied");
  });

  it.each(["merge", "ready"] as const)("refuses a stale %s confirmation for a different PR even when both share a head", async (action) => {
    const api = access(`/prs/shared-head-${action}`);
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    const target = confirmed();
    act(() => result.current.select({ repository: "owner/repo", number: 8 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(8));
    const writing = action === "merge" ? result.current.merge("squash", false, target) : result.current.markReady(target);
    await act(async () => { await expect(writing).rejects.toThrow(/selected pull request changed/); });
    expect(api[action]).not.toHaveBeenCalled();
    expect(result.current.selected?.number).toBe(8);
    expect(result.current.detail?.number).toBe(8);
  });

  it("refuses a confirmation whose head changed on the same PR", async () => {
    const api = access("/prs/changed-head");
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    vi.mocked(api.view).mockResolvedValue(detail(7, { headOid: "b".repeat(40) }));
    act(() => result.current.refreshDetail());
    await waitFor(() => expect(result.current.detail?.headOid).toBe("b".repeat(40)));
    await act(async () => { await expect(result.current.merge("squash", false, confirmed())).rejects.toThrow(/selected pull request changed/); });
    expect(api.merge).not.toHaveBeenCalled();
  });

  it.each(["merge", "ready"] as const)("rejects a %s response identifying a different PR", async (action) => {
    const api = access(`/prs/wrong-result-${action}`, { [action]: vi.fn().mockResolvedValue(detail(8)) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    await act(async () => { await expect(action === "merge" ? result.current.merge("squash", false, confirmed()) : result.current.markReady(confirmed())).rejects.toThrow(/different pull request/); });
    expect(result.current.detail?.number).toBe(7);
    expect(api.onChanged).not.toHaveBeenCalled();
  });

  it("publishes a late result when the same target was deliberately reselected", async () => {
    const pending = deferred<PullRequest>();
    const api = access("/prs/reselected", { merge: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    let writing!: Promise<void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()); });
    act(() => { result.current.select(null); result.current.select({ repository: "owner/repo", number: 7 }); });
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    await act(async () => { pending.resolve(detail(7, { state: "MERGED" })); await writing; });
    expect(result.current.detail?.state).toBe("MERGED");
    expect(result.current.selected?.number).toBe(7);
  });

  it("resumes a different selected PR's read invalidated by completion", async () => {
    const oldRead = deferred<PullRequest>();
    const pending = deferred<PullRequest>();
    const api = access("/prs/resume-read", { merge: vi.fn(() => pending.promise) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    let writing!: Promise<void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()); });
    vi.mocked(api.view).mockImplementationOnce(() => oldRead.promise).mockResolvedValue(detail(8, { state: "CLOSED" }));
    act(() => result.current.select({ repository: "owner/repo", number: 8 }));
    expect(result.current.detailLoading).toBe(true);
    await act(async () => { pending.resolve(detail(7, { state: "MERGED" })); await writing; });
    await waitFor(() => expect(result.current.detail?.state).toBe("CLOSED"));
    await act(async () => { oldRead.resolve(detail(8)); });
    expect(result.current.detail?.number).toBe(8);
    expect(result.current.detail?.state).toBe("CLOSED");
    expect(result.current.detailLoading).toBe(false);
  });

  it("keeps a late failure and its cleanup in the originating checkout", async () => {
    const pending = deferred<PullRequest>();
    const first = access("/prs/failed-first", { merge: vi.fn(() => pending.promise) });
    const second = access("/prs/failed-second");
    const { result, rerender } = renderHook(({ api }) => useProjectPullRequests(api, true), { initialProps: { api: first } });
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    let writing!: Promise<string | void>;
    act(() => { writing = result.current.merge("squash", false, confirmed()).catch((error: Error) => error.message); });
    rerender({ api: second });
    act(() => result.current.select({ repository: "owner/repo", number: 8 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(8));
    await act(async () => { pending.reject(new Error("Native merge refused")); await writing; });
    expect(result.current.error).toBeNull();
    expect(result.current.detail?.number).toBe(8);
    const origin = projectPullRequestStore.get(projectPullRequestScope(first.cwd, first.repository));
    expect(origin.error).toBe("Native merge refused");
    expect(origin.busy).toBe(false);
    expect(isPullRequestMutationRunning(first.cwd)).toBe(false);
    expect(first.onChanged).not.toHaveBeenCalled();
  });

  it("refuses a retained callback after checkout navigation even with an identical PR head", async () => {
    const first = access("/prs/callback-first");
    const second = access("/prs/callback-second");
    const { result, rerender } = renderHook(({ api }) => useProjectPullRequests(api, true), { initialProps: { api: first } });
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    const retained = result.current.merge;
    rerender({ api: second });
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    await act(async () => { await expect(retained("squash", false, confirmed())).rejects.toThrow(/selected checkout changed/); });
    expect(first.merge).not.toHaveBeenCalled();
    expect(second.merge).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it.each(["back", "unmount"])("does not auto-select a late creation after %s navigation", async (navigation) => {
    const pending = deferred<PullRequest & { creationOutcome: "created" }>();
    const api = access(`/prs/create-${navigation}`, { create: vi.fn(() => pending.promise) });
    const view = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    let writing!: Promise<void>;
    act(() => { writing = view.result.current.create({ head: "feature/7", base: "main", title: "New", body: "", draft: false, commitAll: false, expectedHeadOid: "c".repeat(40) }); });
    if (navigation === "back") act(() => { view.result.current.select({ repository: "owner/repo", number: 8 }); view.result.current.select(null); });
    else view.unmount();
    await act(async () => { pending.resolve({ ...detail(12, { headRefName: "feature/7" }), creationOutcome: "created" }); await writing; });
    const origin = projectPullRequestStore.get(projectPullRequestScope(api.cwd, api.repository));
    expect(origin.selected).toBeNull();
    expect(origin.notice).toMatch(/Created pull request #12/);
    expect(api.onChanged).toHaveBeenCalledWith(api.cwd);
  });
  it("lists and searches without a thread, bounded to one page", async () => {
    const api = access("/prs/list");
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api.list).toHaveBeenCalledWith("/prs/list", "owner/repo", { search: undefined, state: "open", limit: 30 });
    act(() => result.current.search("  author:octo  ", "all"));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith("/prs/list", "owner/repo", { search: "author:octo", state: "all", limit: 30 }));
  });

  it("does not read GitHub while hidden or signed out", async () => {
    const hidden = access("/prs/hidden");
    renderHook(() => useProjectPullRequests(hidden, false));
    const signedOut = access("/prs/signed-out", { authenticated: false });
    renderHook(() => useProjectPullRequests(signedOut, true));
    await new Promise((done) => setTimeout(done, 10));
    expect(hidden.list).not.toHaveBeenCalled();
    expect(signedOut.list).not.toHaveBeenCalled();
    expect(signedOut.context).not.toHaveBeenCalled();
  });

  it("merges the confirmed head under the folder lease and never attaches", async () => {
    let leaseHeld = false;
    const api = access("/prs/merge", {
      view: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number, { headOid: "f".repeat(40) })),
      merge: vi.fn(async (cwd: string, _repository: string, number: number) => {
        leaseHeld = isPullRequestMutationRunning(cwd);
        return detail(number, { state: "MERGED" });
      }),
    });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail?.number).toBe(7));
    await act(() => result.current.merge("squash", false, confirmed(7, "f".repeat(40))));
    expect(api.merge).toHaveBeenCalledWith("/prs/merge", "owner/repo", 7, "squash", "f".repeat(40), false);
    expect(leaseHeld).toBe(true);
    expect(isPullRequestMutationRunning("/prs/merge")).toBe(false);
    expect(result.current.notice).toMatch(/merged on GitHub\. Your local folder is unchanged/);
    expect(api.onChanged).toHaveBeenCalled();
  });

  it("refuses a write while blocked or while another Git operation holds the folder", async () => {
    const blocked = access("/prs/blocked", { mutationBlockedReason: "Switch to Ask or Full access." });
    const { result } = renderHook(() => useProjectPullRequests(blocked, true));
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    await expect(result.current.merge("squash", false, confirmed())).rejects.toThrow("Switch to Ask");
    expect(blocked.merge).not.toHaveBeenCalled();

    const busy = access("/prs/busy");
    const held = renderHook(() => useProjectPullRequests(busy, true));
    act(() => held.result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(held.result.current.detail).not.toBeNull());
    const lease = acquirePullRequestMutation("/prs/busy")!;
    await expect(held.result.current.merge("squash", false, confirmed())).rejects.toThrow(/current Git operation/);
    releasePullRequestMutation(lease);
    expect(busy.merge).not.toHaveBeenCalled();
  });

  it("creates a project-owned pull request and reports that it is not attached", async () => {
    const api = access("/prs/create", { create: vi.fn().mockResolvedValue({ ...detail(12, { headRefName: "feature/7" }), creationOutcome: "created" }) });
    const { result } = renderHook(() => useProjectPullRequests(api, true));
    await waitFor(() => expect(result.current.context).not.toBeNull());
    await act(() => result.current.create({ head: "feature/7", base: "main", title: "T", body: "", draft: false, commitAll: false, expectedHeadOid: "c".repeat(40) }));
    expect(api.create).toHaveBeenCalledWith("/prs/create", "owner/repo", expect.objectContaining({ expectedHeadOid: "c".repeat(40) }));
    expect(result.current.notice).toMatch(/Created pull request #12\. It is not attached to any conversation/);
    expect(result.current.selected).toEqual({ repository: "owner/repo", number: 12 });
  });

  it("lands a late merge result in the checkout it started in", async () => {
    const pending = deferred<PullRequest>();
    const first = access("/prs/first", { merge: vi.fn(() => pending.promise) });
    const second = access("/prs/second");
    const { result, rerender } = renderHook(({ api }) => useProjectPullRequests(api, true), { initialProps: { api: first } });
    act(() => result.current.select({ repository: "owner/repo", number: 7 }));
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    let merging!: Promise<void>;
    act(() => { merging = result.current.merge("squash", false, confirmed()); });
    rerender({ api: second });
    await act(async () => { pending.resolve(detail(7, { state: "MERGED" })); await merging; });
    expect(result.current.notice).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(projectPullRequestStore.get(projectPullRequestScope("/prs/first", "owner/repo")).notice).toMatch(/#7 merged/);
  });
});

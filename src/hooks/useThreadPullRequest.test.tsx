import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, PullRequestContext, ThreadPullRequestLink } from "../lib/pullRequests";
import { useThreadPullRequest, type UseThreadPullRequestOptions } from "./useThreadPullRequest";

const native = vi.hoisted(() => ({
  context: vi.fn(),
  view: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  merge: vi.fn(),
  ready: vi.fn(),
  branch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../lib/pullRequests", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/pullRequests")>();
  return {
    ...original,
    getPullRequestContext: native.context,
    getPullRequest: native.view,
    findPullRequest: native.find,
    createPullRequest: native.create,
    mergePullRequest: native.merge,
    markPullRequestReady: native.ready,
    createPullRequestBranch: native.branch,
  };
});

const context = (repository = "m17h/Mythra-Code", branch = "feature"): PullRequestContext => ({
  repository,
  branch,
  defaultBranch: "main",
  headOid: `${branch}-oid`,
  dirty: false,
  ahead: 1,
  behind: 0,
  pushRemote: "origin",
  permission: "write",
  mergeMethods: ["squash", "merge"],
});

const pullRequest = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  repository: "m17h/Mythra-Code",
  number,
  url: `https://github.com/m17h/Mythra-Code/pull/${number}`,
  title: `PR ${number}`,
  body: "",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature",
  baseRefName: "main",
  headOid: "feature-oid",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "",
  checks: [],
  updatedAt: "2026-09-22T12:00:00Z",
  canMerge: true,
  mergeMethods: ["squash", "merge"],
  ...overrides,
});

function seed(id: string, pr: PullRequest) {
  const link: ThreadPullRequestLink = { repository: pr.repository, number: pr.number, url: pr.url, attachedAt: 1, snapshot: pr };
  localStorage.setItem("kiwi.threadPullRequests", JSON.stringify({ [id]: link }));
}

function options(overrides: Partial<UseThreadPullRequestOptions> = {}): UseThreadPullRequestOptions {
  return {
    threadId: "alpha",
    cwd: "/project/alpha",
    projectPath: "/project",
    isolated: true,
    enabled: true,
    visible: true,
    mutationBlockedReason: null,
    checkMutationAllowed: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  Object.values(native).forEach((mock) => mock.mockReset());
  native.context.mockResolvedValue(context());
  native.find.mockResolvedValue(null);
  native.view.mockImplementation((_cwd, _repository, number) => Promise.resolve(pullRequest(number)));
  native.create.mockResolvedValue(pullRequest(101));
  native.merge.mockResolvedValue(pullRequest(101, { state: "MERGED" }));
  native.ready.mockResolvedValue(pullRequest(101, { isDraft: false }));
  native.branch.mockResolvedValue(undefined);
});

describe("useThreadPullRequest", () => {
  it("persists a created PR to the thread that started the action after navigation", async () => {
    let finish!: (value: PullRequest) => void;
    native.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook((props: UseThreadPullRequestOptions) => useThreadPullRequest(props), { initialProps: options() });
    await waitFor(() => expect(view.result.current.context?.repository).toBe("m17h/Mythra-Code"));
    let createPromise!: Promise<void>;
    act(() => {
      createPromise = view.result.current.onCreate({ head: "feature", base: "main", title: "Title", body: "", draft: false, commitAll: false, expectedHeadOid: "feature-oid" });
    });
    view.rerender(options({ threadId: "beta", cwd: "/project/beta" }));
    await waitFor(() => expect(native.context.mock.calls.some(([cwd]) => cwd === "/project/beta")).toBe(true));
    const betaCalls = native.context.mock.calls.filter(([cwd]) => cwd === "/project/beta").length;
    await act(async () => { finish(pullRequest(41)); await createPromise; });
    await waitFor(() => expect(native.context.mock.calls.filter(([cwd]) => cwd === "/project/alpha").length).toBeGreaterThan(1));
    expect(native.context.mock.calls.filter(([cwd]) => cwd === "/project/beta")).toHaveLength(betaCalls);
    expect(view.result.current.pullRequest).toBeNull();
    const stored = JSON.parse(localStorage.getItem("kiwi.threadPullRequests") ?? "{}") as Record<string, ThreadPullRequestLink>;
    expect(stored.alpha.number).toBe(41);
    expect(stored.beta).toBeUndefined();
  });

  it("does not resurrect a link when its thread is forgotten during create", async () => {
    let finish!: (value: PullRequest) => void;
    native.create.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useThreadPullRequest(options()));
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    let createPromise!: Promise<void>;
    act(() => { createPromise = view.result.current.onCreate({ head: "feature", base: "main", title: "Title", body: "", draft: false, commitAll: false, expectedHeadOid: "feature-oid" }); });
    act(() => view.result.current.forgetThread("alpha"));
    await act(async () => { finish(pullRequest(42)); await createPromise; });
    expect(JSON.parse(localStorage.getItem("kiwi.threadPullRequests") ?? "{}").alpha).toBeUndefined();
  });

  it("does not restore a detached PR when an older refresh finishes", async () => {
    seed("alpha", pullRequest(7));
    let finish!: (value: PullRequest) => void;
    native.view.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useThreadPullRequest(options()));
    await waitFor(() => expect(native.view).toHaveBeenCalled());
    act(() => view.result.current.onDetach());
    await act(async () => finish(pullRequest(7, { title: "late" })));
    expect(view.result.current.linked).toBe(false);
    expect(JSON.parse(localStorage.getItem("kiwi.threadPullRequests") ?? "{}").alpha).toBeUndefined();
  });

  it("rejects duplicate synchronous actions for the same cwd", async () => {
    let finish!: (value: PullRequest) => void;
    native.view.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useThreadPullRequest(options({ visible: false })));
    let first!: Promise<void>;
    act(() => { first = view.result.current.onAttach("https://github.com/m17h/Mythra-Code/pull/12"); });
    await expect(view.result.current.onAttach("https://github.com/m17h/Mythra-Code/pull/12")).rejects.toThrow("already being attached");
    expect(native.view).toHaveBeenCalledTimes(1);
    await act(async () => { finish(pullRequest(12)); await first; });
  });

  it("does not let an attachment race an in-flight mutation for the same thread", async () => {
    seed("alpha", pullRequest(13));
    let finishMerge!: (value: PullRequest) => void;
    native.merge.mockImplementation(() => new Promise((resolve) => { finishMerge = resolve; }));
    const view = renderHook(() => useThreadPullRequest(options({ visible: false })));
    let mergePromise!: Promise<void>;
    act(() => { mergePromise = view.result.current.onMerge("squash", false); });
    await expect(view.result.current.onAttach("https://github.com/m17h/Mythra-Code/pull/14"))
      .rejects.toThrow("already running for this thread");
    expect(native.view).not.toHaveBeenCalled();
    await act(async () => { finishMerge(pullRequest(13, { state: "MERGED" })); await mergePromise; });
    expect(view.result.current.pullRequest?.number).toBe(13);
    expect(view.result.current.pullRequest?.state).toBe("MERGED");
  });

  it("does no context, discovery, or polling work while hidden", async () => {
    vi.useFakeTimers();
    seed("alpha", pullRequest(8));
    renderHook(() => useThreadPullRequest(options({ visible: false })));
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(native.context).not.toHaveBeenCalled();
    expect(native.find).not.toHaveBeenCalled();
    expect(native.view).not.toHaveBeenCalled();
  });

  it("keeps the stored merge status after failure and remains retryable", async () => {
    seed("alpha", pullRequest(9));
    native.merge.mockRejectedValueOnce(new Error("checks are pending"));
    const view = renderHook(() => useThreadPullRequest(options({ visible: false })));
    await act(async () => {
      await expect(view.result.current.onMerge("squash", true)).rejects.toThrow("checks are pending");
    });
    expect(view.result.current.pullRequest?.state).toBe("OPEN");
    expect(view.result.current.error).toContain("checks are pending");
    native.merge.mockResolvedValueOnce(pullRequest(9, { state: "OPEN", mergeStateStatus: "QUEUED" }));
    await act(async () => view.result.current.onMerge("squash", true));
    expect(view.result.current.pullRequest?.mergeStateStatus).toBe("QUEUED");
    expect(view.result.current.notice).toContain("Not merged yet");
  });

  it("shows a discovered shared-workspace candidate without attaching it", async () => {
    native.find.mockResolvedValue(pullRequest(17));
    const view = renderHook(() => useThreadPullRequest(options({ isolated: false })));
    await waitFor(() => expect(view.result.current.pullRequest?.number).toBe(17));
    expect(view.result.current.linked).toBe(false);
    expect(localStorage.getItem("kiwi.threadPullRequests")).toBeNull();
  });

  it("restores a scoped candidate when returning within the refresh limit", async () => {
    native.find.mockImplementation((_cwd, _repository, branch) => Promise.resolve(branch === "feature" ? pullRequest(19) : null));
    const view = renderHook((props: UseThreadPullRequestOptions) => useThreadPullRequest(props), {
      initialProps: options({ isolated: false, cwd: "/project/a" }),
    });
    await waitFor(() => expect(view.result.current.pullRequest?.number).toBe(19));
    native.context.mockResolvedValueOnce(context("m17h/Mythra-Code", "other"));
    view.rerender(options({ threadId: "beta", cwd: "/project/b", isolated: false }));
    await waitFor(() => expect(view.result.current.context?.branch).toBe("other"));
    view.rerender(options({ isolated: false, cwd: "/project/a" }));
    expect(view.result.current.pullRequest?.number).toBe(19);
    expect(view.result.current.linked).toBe(false);
  });

  it("uses a retry-safe attach notice when create returns an existing PR", async () => {
    native.create.mockResolvedValueOnce({ ...pullRequest(20), creationOutcome: "existing" });
    const view = renderHook(() => useThreadPullRequest(options({ isolated: false })));
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    await act(async () => view.result.current.onCreate({
      head: "feature",
      base: "main",
      title: "Existing",
      body: "",
      draft: false,
      commitAll: true,
      expectedHeadOid: "feature-oid",
    }));
    expect(view.result.current.notice).toBe(
      "Attached existing pull request #20. No local changes were committed or pushed. Use Push commits or Commit & push to update it.",
    );
  });

  it("reports when a create race pushed before attaching an existing PR", async () => {
    native.create.mockResolvedValueOnce({ ...pullRequest(21), creationOutcome: "updated" });
    const view = renderHook(() => useThreadPullRequest(options()));
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    await act(async () => view.result.current.onCreate({
      head: "feature",
      base: "main",
      title: "Raced",
      body: "",
      draft: false,
      commitAll: true,
      expectedHeadOid: "feature-oid",
    }));
    expect(view.result.current.notice).toBe("Pushed the branch and attached existing pull request #21.");
  });

  it("allows a local attachment even when repository mutations are blocked", async () => {
    const view = renderHook(() => useThreadPullRequest(options({
      visible: false,
      mutationBlockedReason: "Read-only mode",
      checkMutationAllowed: () => "Read-only mode",
    })));
    await act(async () => view.result.current.onAttach("https://github.com/m17h/Mythra-Code/pull/23"));
    expect(native.view).toHaveBeenCalledWith("/project", "m17h/Mythra-Code", 23);
    expect(view.result.current.linked).toBe(true);
    expect(view.result.current.pullRequest?.number).toBe(23);
  });

  it("marks a draft ready and stores the returned status", async () => {
    seed("alpha", pullRequest(24, { isDraft: true }));
    native.ready.mockResolvedValueOnce(pullRequest(24, { isDraft: false }));
    const view = renderHook(() => useThreadPullRequest(options({ visible: false })));
    await act(async () => view.result.current.onReady());
    expect(native.ready).toHaveBeenCalledWith("/project", "m17h/Mythra-Code", 24, "feature-oid");
    expect(view.result.current.pullRequest?.isDraft).toBe(false);
    expect(view.result.current.notice).toContain("ready for review");
  });

  it("does not show context from the same thread after its cwd changes", async () => {
    const view = renderHook((props: UseThreadPullRequestOptions) => useThreadPullRequest(props), { initialProps: options() });
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    native.context.mockImplementationOnce(() => new Promise(() => {}));
    view.rerender(options({ cwd: "/project/replaced" }));
    expect(view.result.current.context).toBeNull();
  });

  it("queues one fresh read after a mutation invalidates an older inflight refresh", async () => {
    seed("alpha", pullRequest(31));
    let finishOld!: (value: PullRequest) => void;
    native.view
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(pullRequest(31, { state: "MERGED", title: "fresh merged" }));
    native.merge.mockResolvedValueOnce(pullRequest(31, { state: "MERGED", title: "merge result" }));
    const view = renderHook(() => useThreadPullRequest(options()));
    await waitFor(() => expect(native.view).toHaveBeenCalledTimes(1));
    await act(async () => view.result.current.onMerge("squash", false));
    act(() => view.result.current.onRefresh());
    await act(async () => finishOld(pullRequest(31, { title: "stale open" })));
    await waitFor(() => expect(native.view).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.pullRequest?.title).toBe("fresh merged"));
    expect(view.result.current.pullRequest?.state).toBe("MERGED");
  });

  it("rate-limits focus bursts across context and PR status reads", async () => {
    seed("alpha", pullRequest(32));
    const view = renderHook(() => useThreadPullRequest(options({ cwd: "/project/focus" })));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(native.context).toHaveBeenCalledTimes(1);
    expect(native.view).toHaveBeenCalledTimes(1);
    act(() => {
      for (let index = 0; index < 8; index += 1) window.dispatchEvent(new Event("focus"));
    });
    await act(async () => Promise.resolve());
    expect(native.context).toHaveBeenCalledTimes(1);
    expect(native.view).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite durable links when polling returns unchanged PR state", async () => {
    vi.useFakeTimers();
    seed("alpha", pullRequest(34));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderHook(() => useThreadPullRequest(options({ cwd: "/project/poll" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(native.view).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.threadPullRequests")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(native.view).toHaveBeenCalledTimes(2);
    expect(setItem.mock.calls.filter(([key]) => key === "kiwi.threadPullRequests")).toHaveLength(0);
    setItem.mockRestore();
  });

  it("uses the logical project path for attached PR remote actions", async () => {
    seed("alpha", pullRequest(33, { isDraft: true }));
    native.merge.mockResolvedValueOnce(pullRequest(33, { isDraft: true }));
    const view = renderHook(() => useThreadPullRequest(options({ visible: false, cwd: "/missing/worktree", projectPath: "/logical/project" })));
    await act(async () => view.result.current.onMerge("squash", false));
    expect(native.merge).toHaveBeenCalledWith("/logical/project", "m17h/Mythra-Code", 33, "squash", "feature-oid", false);
    native.ready.mockResolvedValueOnce(pullRequest(33, { isDraft: false }));
    await act(async () => view.result.current.onReady());
    expect(native.ready).toHaveBeenCalledWith("/logical/project", "m17h/Mythra-Code", 33, "feature-oid");
  });

  it("refreshes the branch owner after navigation without refreshing the new thread again", async () => {
    let finishBranch!: () => void;
    native.branch.mockImplementation(() => new Promise<void>((resolve) => { finishBranch = resolve; }));
    const view = renderHook((props: UseThreadPullRequestOptions) => useThreadPullRequest(props), {
      initialProps: options({ isolated: false, cwd: "/project/owner" }),
    });
    await waitFor(() => expect(view.result.current.context).not.toBeNull());
    let branchPromise!: Promise<void>;
    act(() => { branchPromise = view.result.current.onCreateBranch("new-branch"); });
    view.rerender(options({ threadId: "beta", cwd: "/project/beta", isolated: false }));
    await waitFor(() => expect(native.context.mock.calls.some(([cwd]) => cwd === "/project/beta")).toBe(true));
    const betaCalls = native.context.mock.calls.filter(([cwd]) => cwd === "/project/beta").length;
    native.context.mockImplementation((cwd) => Promise.resolve(cwd === "/project/owner" ? context("m17h/Mythra-Code", "new-branch") : context()));
    await act(async () => { finishBranch(); await branchPromise; });
    await waitFor(() => expect(native.context.mock.calls.filter(([cwd]) => cwd === "/project/owner").length).toBeGreaterThan(1));
    expect(native.context.mock.calls.filter(([cwd]) => cwd === "/project/beta")).toHaveLength(betaCalls);
    view.rerender(options({ isolated: false, cwd: "/project/owner" }));
    expect(view.result.current.context?.branch).toBe("new-branch");
  });

  it("never leaks a late refresh result into the next thread", async () => {
    seed("alpha", pullRequest(18));
    let finish!: (value: PullRequest) => void;
    native.view.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook((props: UseThreadPullRequestOptions) => useThreadPullRequest(props), { initialProps: options() });
    await waitFor(() => expect(native.view).toHaveBeenCalled());
    view.rerender(options({ threadId: "beta", cwd: "/project/beta" }));
    expect(view.result.current.pullRequest).toBeNull();
    await act(async () => finish(pullRequest(18, { title: "late alpha" })));
    expect(view.result.current.pullRequest).toBeNull();
  });
});

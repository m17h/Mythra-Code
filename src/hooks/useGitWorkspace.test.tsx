import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorkspaceSnapshot } from "../lib/gitWorkspace";
import { useGitWorkspace } from "./useGitWorkspace";

const native = vi.hoisted(() => ({
  get: vi.fn(),
  branch: vi.fn(),
  fetch: vi.fn(),
  update: vi.fn(),
}));
const locks = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));

vi.mock("../lib/gitWorkspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/gitWorkspace")>(),
  getGitWorkspace: native.get,
  changeGitBranch: native.branch,
  fetchGitWorkspace: native.fetch,
  updateLocalGitBase: native.update,
}));
vi.mock("../lib/pullRequestOperations", () => ({
  acquirePullRequestMutation: locks.acquire,
  releasePullRequestMutation: locks.release,
}));

const snapshot = (rootPath: string, branch = "main", headOid = `${branch}-oid`): GitWorkspaceSnapshot => ({
  branch,
  headOid,
  branches: [{ name: branch, current: true, worktreePath: rootPath }],
  stagedFiles: 0,
  unstagedFiles: 0,
  changedFiles: 0,
  stagedPaths: [],
  rootPath,
});

type Options = Parameters<typeof useGitWorkspace>[0];
const options = (overrides: Partial<Options> = {}): Options => ({
  cwd: "/project/a",
  projectPath: "/project/a",
  enabled: true,
  isolated: false,
  blocked: () => null,
  confirmUpdate: async () => true,
  onChanged: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  Object.values(native).forEach((mock) => mock.mockReset());
  Object.values(locks).forEach((mock) => mock.mockReset());
  locks.acquire.mockImplementation((path: string) => `lease:${path}`);
  native.get.mockImplementation((cwd: string) => Promise.resolve(snapshot(cwd)));
  native.branch.mockImplementation((cwd: string, name: string) => Promise.resolve(snapshot(cwd, name)));
  native.fetch.mockImplementation((cwd: string) => Promise.resolve(snapshot(cwd)));
  native.update.mockImplementation((cwd: string, _repository: string, base: string) => Promise.resolve(snapshot(cwd, base)));
});

describe("useGitWorkspace", () => {
  it("starts a new-folder read immediately while the previous folder read is pending", async () => {
    const pending = new Map<string, (value: GitWorkspaceSnapshot) => void>();
    native.get.mockImplementation((cwd: string) => new Promise((resolve) => pending.set(cwd, resolve)));
    const view = renderHook((props: Options) => useGitWorkspace(props), { initialProps: options() });
    await waitFor(() => expect(native.get).toHaveBeenCalledWith("/project/a"));
    view.rerender(options({ cwd: "/project/b", projectPath: "/project/b" }));
    await waitFor(() => expect(native.get).toHaveBeenCalledWith("/project/b"));
    await act(async () => pending.get("/project/b")?.(snapshot("/project/b", "beta")));
    expect(view.result.current.snapshot?.branch).toBe("beta");
    await act(async () => pending.get("/project/a")?.(snapshot("/project/a", "late-alpha")));
    expect(view.result.current.snapshot?.branch).toBe("beta");
  });

  it("refreshes promptly when navigation returns to a folder whose old read is stale", async () => {
    const requests = new Map<string, Array<(value: GitWorkspaceSnapshot) => void>>();
    native.get.mockImplementation((cwd: string) => new Promise((resolve) => {
      requests.set(cwd, [...(requests.get(cwd) ?? []), resolve]);
    }));
    const view = renderHook((props: Options) => useGitWorkspace(props), { initialProps: options() });
    await waitFor(() => expect(requests.get("/project/a")).toHaveLength(1));
    view.rerender(options({ cwd: "/project/b", projectPath: "/project/b" }));
    await waitFor(() => expect(requests.get("/project/b")).toHaveLength(1));
    view.rerender(options());
    await act(async () => requests.get("/project/a")?.[0](snapshot("/project/a", "stale")));
    await waitFor(() => expect(requests.get("/project/a")).toHaveLength(2));
    await act(async () => requests.get("/project/a")?.[1](snapshot("/project/a", "fresh")));
    expect(view.result.current.snapshot?.branch).toBe("fresh");
  });

  it("allows a mutation in the navigated folder while an old-folder mutation is pending", async () => {
    let finishA!: (value: GitWorkspaceSnapshot) => void;
    native.branch.mockImplementation((cwd: string, name: string) => cwd === "/project/a"
      ? new Promise((resolve) => { finishA = resolve; })
      : Promise.resolve(snapshot(cwd, name)));
    const changedA = vi.fn();
    const changedB = vi.fn();
    const view = renderHook((props: Options) => useGitWorkspace(props), {
      initialProps: options({ onChanged: changedA }),
    });
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    let first!: Promise<boolean>;
    act(() => { first = view.result.current.onBranch("alpha", true); });
    await waitFor(() => expect(native.branch).toHaveBeenCalledWith("/project/a", "alpha", true, "main-oid", "main"));
    view.rerender(options({ cwd: "/project/b", projectPath: "/project/b", onChanged: changedB }));
    await waitFor(() => expect(view.result.current.snapshot?.rootPath).toBe("/project/b"));
    await act(async () => view.result.current.onBranch("beta", true));
    expect(native.branch).toHaveBeenCalledWith("/project/b", "beta", true, "main-oid", "main");
    expect(changedB).toHaveBeenCalledOnce();
    native.get.mockImplementation((cwd: string) => Promise.resolve(snapshot(cwd, cwd === "/project/b" ? "beta" : "main")));
    await act(async () => { finishA(snapshot("/project/a", "alpha")); await first; });
    expect(changedA).not.toHaveBeenCalled();
    expect(view.result.current.snapshot?.branch).toBe("beta");
  });

  it("treats cancelled update confirmation as unchanged and releases every lease", async () => {
    const onChanged = vi.fn();
    const confirmUpdate = vi.fn(async () => false);
    const view = renderHook(() => useGitWorkspace(options({
      cwd: "/worktree/a",
      projectPath: "/project/a",
      isolated: true,
      onChanged,
      confirmUpdate,
    })));
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    await act(async () => view.result.current.updateBase("owner/repo", "main"));
    expect(confirmUpdate).toHaveBeenCalledOnce();
    expect(native.update).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(locks.release).toHaveBeenCalledTimes(2);
    expect(view.result.current.busy).toBe(false);
  });

  it("uses the latest blocker after confirmation and never invokes the mutation", async () => {
    let finishConfirm!: (value: boolean) => void;
    const confirmUpdate = vi.fn(() => new Promise<boolean>((resolve) => { finishConfirm = resolve; }));
    const initial = options({ confirmUpdate, blocked: () => null });
    const view = renderHook((props: Options) => useGitWorkspace(props), { initialProps: initial });
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    let update!: Promise<void>;
    act(() => { update = view.result.current.updateBase("owner/repo", "release"); });
    await waitFor(() => expect(confirmUpdate).toHaveBeenCalled());
    const blocked = vi.fn(() => "An agent started working.");
    view.rerender(options({ confirmUpdate, blocked }));
    await act(async () => { finishConfirm(true); await update; });
    expect(native.update).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenLastCalledWith(["/project/a"]);
    expect(view.result.current.error).toContain("An agent started working");
  });

  it("rechecks both isolated and shared folders after update confirmation", async () => {
    let finishConfirm!: (value: boolean) => void;
    const confirmUpdate = vi.fn(() => new Promise<boolean>((resolve) => { finishConfirm = resolve; }));
    const blocked = vi.fn(() => null as string | null);
    const view = renderHook((props: Options) => useGitWorkspace(props), {
      initialProps: options({
        cwd: "/worktree/a",
        projectPath: "/project/a",
        isolated: true,
        confirmUpdate,
        blocked,
      }),
    });
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    let update!: Promise<void>;
    act(() => { update = view.result.current.updateBase("owner/repo", "release"); });
    await waitFor(() => expect(confirmUpdate).toHaveBeenCalled());
    blocked.mockReturnValue("The isolated worktree became busy.");
    await act(async () => { finishConfirm(true); await update; });
    expect(blocked).toHaveBeenLastCalledWith(["/worktree/a", "/project/a"]);
    expect(native.update).not.toHaveBeenCalled();
  });

  it("trims a local branch name and passes the displayed identity guard", async () => {
    const view = renderHook(() => useGitWorkspace(options()));
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    let result: boolean | undefined;
    await act(async () => { result = await view.result.current.onBranch("  feature/local  ", true); });
    expect(result).toBe(true);
    expect(native.branch).toHaveBeenCalledWith("/project/a", "feature/local", true, "main-oid", "main");
    expect(view.result.current.notice).toContain("Created local branch feature/local");
  });

  it("returns false and retains the error when branch creation fails", async () => {
    native.branch.mockRejectedValueOnce(new Error("branch is occupied"));
    const onChanged = vi.fn();
    const view = renderHook(() => useGitWorkspace(options({ onChanged })));
    await waitFor(() => expect(view.result.current.snapshot).not.toBeNull());
    let result: boolean | undefined;
    await act(async () => { result = await view.result.current.onBranch("feature/fails", true); });
    expect(result).toBe(false);
    expect(view.result.current.error).toContain("branch is occupied");
    expect(onChanged).not.toHaveBeenCalled();
  });
});

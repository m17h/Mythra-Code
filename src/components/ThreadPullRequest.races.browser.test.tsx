import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useThreadPullRequest } from "../hooks/useThreadPullRequest";
import { ThreadPullRequestPanel } from "./ThreadPullRequestPanel";
import type { PullRequest, PullRequestContext, ThreadPullRequestLink } from "../lib/pullRequests";
import "../styles.css";

const native = vi.hoisted(() => ({ view: vi.fn(), merge: vi.fn(), context: vi.fn(), find: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const context = (branch = "feature"): PullRequestContext => ({
  repository: "owner/repo", branch, defaultBranch: "main", headOid: "a".repeat(40),
  dirty: false, ahead: 1, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"],
});
const pr = (state: PullRequest["state"] = "OPEN"): PullRequest => ({
  repository: "owner/repo", number: 73, url: "https://github.com/owner/repo/pull/73", title: "Guard late PR reads", body: "",
  state, isDraft: false, headRefName: "feature", baseRefName: "main", headOid: "a".repeat(40),
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [],
  updatedAt: "2026-09-28T10:00:00Z", canMerge: true, viewerCanMerge: true, autoMergeAllowed: false, mergeMethods: ["squash"],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function Owner({ cwd = "/browser-race/worktree" }: { cwd?: string }) {
  const owner = useThreadPullRequest({
    threadId: "browser-race", cwd, projectPath: "/browser-race",
    isolated: true, enabled: true, visible: true, mutationBlockedReason: null, checkMutationAllowed: () => null,
  });
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 360 }}>
    <ThreadPullRequestPanel {...owner} threadId="browser-race" isolated mutationBlockedReason={null}
      onOpenWorktrees={() => undefined} onOpenGitHubSettings={() => undefined} />
  </div>;
}
beforeEach(() => {
  localStorage.removeItem("kiwi.threadPullRequests");
  Object.values(native).forEach((mock) => mock.mockReset());
  native.context.mockResolvedValue(context());
  native.find.mockResolvedValue(null);
  native.view.mockResolvedValue(pr());
  // Exercise the real wrapper/hook, substituting only the native IPC boundary.
  // Browser imports can be optimized before a module-level mock is installed.
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "github_pr_context") return native.context(args.cwd);
    if (command === "github_pr_find") return native.find(args.cwd, args.repository, args.branch);
    if (command === "github_pr_view") return native.view(args.cwd, args.repository, args.number);
    if (command === "github_pr_merge") return native.merge(args.cwd, args.repository, args.number);
    if (command === "state_write") return;
    throw new Error(`Unexpected fixture command: ${command}`);
  } });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the merged card after a refresh launched while its merge was running", async () => {
  const stored = pr();
  const link: ThreadPullRequestLink = { repository: stored.repository, number: stored.number, url: stored.url, attachedAt: 1, snapshot: stored };
  localStorage.setItem("kiwi.threadPullRequests", JSON.stringify({ "browser-race": link }));
  const merge = deferred<PullRequest>();
  const refresh = deferred<PullRequest>();
  native.merge.mockReturnValueOnce(merge.promise);
  render(<Owner />);
  await expect.poll(() => native.view.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
  await page.getByRole("button", { name: "Merge #73 on GitHub", exact: true }).click();
  native.view.mockReturnValueOnce(refresh.promise);
  await page.getByRole("button", { name: "Refresh pull request status", exact: true }).click();
  await expect.poll(() => native.view.mock.calls.length).toBe(2);
  await act(async () => merge.resolve(pr("MERGED")));
  await expect.element(page.getByText("Merged", { exact: true })).toBeVisible();
  await act(async () => refresh.resolve(pr()));
  await expect.element(page.getByText("Merged", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Merge on GitHub…", exact: true })).not.toBeInTheDocument();
});

it("removes a discovered PR when a new branch is read before its discovery finishes", async () => {
  const refresh = deferred<PullRequest | null>();
  native.find.mockResolvedValueOnce(pr()).mockReturnValueOnce(refresh.promise);
  render(<Owner />);
  await expect.element(page.getByRole("button", { name: "Attach to this thread", exact: true })).toBeVisible();
  native.context.mockResolvedValueOnce(context("other-branch"));
  await page.getByRole("button", { name: "Refresh pull request status", exact: true }).click();
  await expect.element(page.getByText("other-branch", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Attach to this thread", exact: true })).not.toBeInTheDocument();
  await act(async () => refresh.resolve(null));
  await expect.element(page.getByRole("button", { name: "Create a pull request", exact: true })).toBeVisible();
});

it("settles the same thread's replacement checkout instead of leaving its refresh permanently disabled", async () => {
  const stored = pr();
  localStorage.setItem("kiwi.threadPullRequests", JSON.stringify({ "browser-race": { repository: stored.repository, number: stored.number, url: stored.url, attachedAt: 1, snapshot: stored } }));
  const merge = deferred<PullRequest>();
  const refresh = deferred<PullRequest>();
  native.merge.mockReturnValueOnce(merge.promise);
  const view = render(<Owner cwd="/browser-race/old-checkout" />);
  await expect.poll(() => native.view.mock.calls.length).toBe(1);
  await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
  await page.getByRole("button", { name: "Merge #73 on GitHub", exact: true }).click();
  native.view.mockReturnValueOnce(refresh.promise);
  view.rerender(<Owner cwd="/browser-race/replacement-checkout" />);
  await expect.poll(() => native.view.mock.calls.length).toBe(2);
  await act(async () => merge.resolve(pr("MERGED")));
  await act(async () => refresh.resolve(pr()));
  await expect.element(page.getByText("Merged", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Refresh pull request status", exact: true })).toBeEnabled();
});

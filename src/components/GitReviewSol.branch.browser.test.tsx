import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useThreadPullRequest } from "../hooks/useThreadPullRequest";
import { ThreadPullRequestPanel } from "./ThreadPullRequestPanel";
import type { PullRequest, PullRequestContext } from "../lib/pullRequests";
import "../styles.css";

const native = vi.hoisted(() => ({ context: vi.fn(), find: vi.fn(), branch: vi.fn(), create: vi.fn(), view: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const context = (branch: string): PullRequestContext => ({
  repository: "owner/repo", branch, defaultBranch: "main", headOid: "a".repeat(40), dirty: false,
  ahead: 0, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"],
});
const pullRequest = (): PullRequest => ({
  repository: "owner/repo", number: 81, url: "https://github.com/owner/repo/pull/81", title: "Cached owner PR", body: "",
  state: "OPEN", isDraft: false, headRefName: "feature/first", baseRefName: "main", headOid: "a".repeat(40),
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [], updatedAt: "2026-09-28T10:00:00Z",
  canMerge: true, viewerCanMerge: true, autoMergeAllowed: false, mergeMethods: ["squash"],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function Owner({ threadId = "sol-review-branch", cwd = "/sol-review-branch" }: { threadId?: string; cwd?: string }) {
  const owner = useThreadPullRequest({ threadId, cwd, projectPath: cwd,
    isolated: false, enabled: true, visible: true, mutationBlockedReason: null, checkMutationAllowed: () => null });
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 360 }}>
    <ThreadPullRequestPanel key={threadId} {...owner} threadId={threadId} isolated={false} mutationBlockedReason={null}
      onOpenWorktrees={() => undefined} onOpenGitHubSettings={() => undefined} />
  </div>;
}
beforeEach(() => {
  localStorage.removeItem("kiwi.threadPullRequests");
  Object.values(native).forEach((mock) => mock.mockReset());
  native.context.mockResolvedValue(context("main"));
  native.find.mockResolvedValue(null);
  native.branch.mockResolvedValue(undefined);
  native.create.mockResolvedValue({ ...pullRequest(), creationOutcome: "created" });
  native.view.mockResolvedValue(pullRequest());
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "github_pr_context") return native.context(args.cwd);
    if (command === "github_pr_find") return native.find(args.cwd, args.repository, args.branch);
    if (command === "github_pr_branch") return native.branch(args.cwd, args.name);
    if (command === "github_pr_create") return native.create(args.cwd, args.repository, args);
    if (command === "github_pr_view") return native.view(args.cwd, args.repository, args.number);
    if (command === "state_write") return;
    throw new Error(`Unexpected fixture command: ${command}`);
  } });
});

it.each(["create", "attach"] as const)("can %s using the returning thread's cached repository context", async (action) => {
  native.context.mockImplementation((cwd: string) => Promise.resolve(cwd === "/sol-context-first"
    ? context("feature/first") : { ...context("feature/other"), repository: "other/repo", headOid: "b".repeat(40) }));
  const view = render(<Owner threadId="sol-context-first" cwd="/sol-context-first" />);
  await expect.element(page.getByText("feature/first", { exact: true })).toBeVisible();
  view.rerender(<Owner threadId="sol-context-other" cwd="/sol-context-other" />);
  await expect.element(page.getByText("feature/other", { exact: true })).toBeVisible();
  view.rerender(<Owner threadId="sol-context-first" cwd="/sol-context-first" />);
  await expect.element(page.getByText("feature/first", { exact: true })).toBeVisible();
  if (action === "create") {
    await page.getByRole("button", { name: "Create a pull request", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Cached owner PR");
    await page.getByRole("button", { name: "Push and create", exact: true }).click();
    await expect.poll(() => native.create.mock.calls.length).toBe(1);
    expect(native.create.mock.calls[0].slice(0, 2)).toEqual(["/sol-context-first", "owner/repo"]);
  } else {
    await page.getByRole("textbox", { name: "Pull request number or link", exact: true }).fill("#81");
    await page.getByRole("button", { name: "Attach", exact: true }).click();
    await expect.poll(() => native.view.mock.calls.length).toBe(1);
    expect(native.view).toHaveBeenCalledWith("/sol-context-first", "owner/repo", 81);
  }
  await expect.element(page.getByText("Cached owner PR", { exact: true })).toBeVisible();
});

it("can create a branch from the cached context after switching to another thread and back", async () => {
  const view = render(<Owner threadId="sol-cached-first" cwd="/sol-cached-first" />);
  await expect.element(page.getByRole("textbox", { name: "New branch name", exact: true })).toBeVisible();
  view.rerender(<Owner threadId="sol-cached-second" cwd="/sol-cached-second" />);
  await expect.poll(() => native.context.mock.calls.length).toBe(2);
  await expect.element(page.getByRole("textbox", { name: "New branch name", exact: true })).toBeVisible();
  view.rerender(<Owner threadId="sol-cached-first" cwd="/sol-cached-first" />);
  await page.getByRole("textbox", { name: "New branch name", exact: true }).fill("feature/cached");
  await page.getByRole("button", { name: "Create branch", exact: true }).click();
  await expect.poll(() => native.branch.mock.calls.length).toBe(1);
  expect(native.branch).toHaveBeenCalledWith("/sol-cached-first", "feature/cached");
});
afterEach(() => vi.unstubAllGlobals());

it("offers PR creation after a branch change whose follow-up native context read is slow", async () => {
  const next = deferred<PullRequestContext>();
  native.context.mockResolvedValueOnce(context("main")).mockReturnValueOnce(next.promise);
  render(<Owner />);
  await expect.element(page.getByRole("textbox", { name: "New branch name", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "New branch name", exact: true }).fill("feature/review");
  await page.getByRole("button", { name: "Create branch", exact: true }).click();
  await expect.element(page.getByText("Created branch feature/review.", { exact: true })).toBeVisible();
  await expect.poll(() => native.context.mock.calls.length).toBe(2);
  await act(async () => next.resolve(context("feature/review")));
  await expect.element(page.getByRole("button", { name: "Create a pull request", exact: true })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "New branch name", exact: true })).not.toBeInTheDocument();
});

it("stores a late branch follow-up in its originating thread while another thread is visible", async () => {
  const branch = deferred<void>();
  const next = deferred<PullRequestContext>();
  native.branch.mockReturnValueOnce(branch.promise);
  native.context.mockImplementation((cwd: string) => cwd === "/sol-owner-other"
    ? Promise.resolve(context("feature/other")) : next.promise);
  native.context.mockResolvedValueOnce(context("main"));
  const view = render(<Owner threadId="sol-owner-first" cwd="/sol-owner-first" />);
  await page.getByRole("textbox", { name: "New branch name", exact: true }).fill("feature/owner");
  await page.getByRole("button", { name: "Create branch", exact: true }).click();
  view.rerender(<Owner threadId="sol-owner-other" cwd="/sol-owner-other" />);
  await expect.element(page.getByText("feature/other", { exact: true })).toBeVisible();
  await act(async () => branch.resolve());
  await expect.poll(() => native.context.mock.calls.filter(([cwd]) => cwd === "/sol-owner-first").length).toBe(2);
  await act(async () => next.resolve(context("feature/owner")));
  await expect.element(page.getByText("feature/other", { exact: true })).toBeVisible();
  await expect.element(page.getByText("feature/owner", { exact: true })).not.toBeInTheDocument();
  view.rerender(<Owner threadId="sol-owner-first" cwd="/sol-owner-first" />);
  await expect.element(page.getByText("feature/owner", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create a pull request", exact: true })).toBeVisible();
});

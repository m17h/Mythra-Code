import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import ProjectPullRequestsView from "./ProjectPullRequestsView";
import { projectPullRequestStore } from "../hooks/useProjectPullRequests";
import type { ProjectPullRequestAccess } from "../lib/projectGit";
import type { PullRequest, PullRequestSummary } from "../lib/pullRequests";
import "../styles.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
const detail = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, title: `PR ${number}`, body: "",
  state: "OPEN", isDraft: false, headRefName: `feature/${number}`, baseRefName: "main", headOid: "a".repeat(40),
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: [], updatedAt: "2026-09-28T10:00:00Z",
  canMerge: true, viewerCanMerge: true, autoMergeAllowed: true, mergeMethods: ["squash"], ...overrides,
});
const rows = (): PullRequestSummary[] => [7, 8].map((number) => ({ ...detail(number), authorLogin: "octo" }));
function access(overrides: Partial<ProjectPullRequestAccess> = {}): ProjectPullRequestAccess {
  return {
    cwd: "/browser-prs", projectPath: "/browser-prs", repository: "owner/repo", authenticated: true, threadActive: true,
    isolated: false, mutationBlockedReason: null, checkMutationAllowed: () => null,
    list: vi.fn().mockResolvedValue(rows()), view: vi.fn(async (_cwd, _repo, number) => detail(number)),
    context: vi.fn().mockResolvedValue({ repository: "owner/repo", branch: "feature/7", defaultBranch: "main", headOid: "a".repeat(40), dirty: false, ahead: 1, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"] }),
    find: vi.fn().mockResolvedValue(null), create: vi.fn(), merge: vi.fn(), ready: vi.fn(), createBranch: vi.fn(), ...overrides,
  };
}
function mount(api: ProjectPullRequestAccess) {
  return render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 360 }}>
    <ProjectPullRequestsView access={api} visible onOpenGitHubSettings={() => undefined} />
  </div>);
}
beforeEach(() => projectPullRequestStore.clear());
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("project pull request navigation", () => {
  it("focuses the opened detail and restores the originating row on Back", async () => {
    mount(access());
    const row = page.getByRole("button", { name: /#7 PR 7,/ });
    await row.click();
    await expect.element(page.getByRole("heading", { name: "PR 7", exact: true })).toHaveFocus();
    await page.getByRole("button", { name: "All pull requests", exact: true }).click();
    await expect.element(row).toHaveFocus();
  });

  it("does not present cached Open rows under a failed Merged query", async () => {
    const api = access({ list: vi.fn(async (_cwd, _repo, query) => {
      if (query.state === "merged") throw new Error("Merged search unavailable");
      return rows();
    }) });
    mount(api);
    await expect.element(page.getByRole("button", { name: /#7 PR 7,/ })).toBeVisible();
    await page.getByRole("button", { name: "Merged", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Merged search unavailable");
    await expect.element(page.getByRole("button", { name: /#7 PR 7,/ })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /#7 PR 7,/ })).toBeVisible();
  });

  it.each(["merge", "ready"] as const)("keeps the newly opened PR when an earlier %s completes", async (action) => {
    const pending = deferred<PullRequest>();
    const api = access({ [action]: vi.fn(() => pending.promise), view: vi.fn(async (_cwd, _repo, number) => detail(number, { isDraft: action === "ready" && number === 7 })) });
    mount(api);
    await page.getByRole("button", { name: /#7 PR 7,/ }).click();
    if (action === "merge") {
      await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
      await page.getByRole("button", { name: /Merge #7/ }).click();
    } else {
      await page.getByRole("button", { name: "Mark ready…", exact: true }).click();
      await page.getByRole("button", { name: "Mark ready for review", exact: true }).click();
    }
    await page.getByRole("button", { name: "All pull requests", exact: true }).click();
    await page.getByRole("button", { name: /#8 PR 8,/ }).click();
    await expect.element(page.getByRole("heading", { name: "PR 8", exact: true })).toHaveFocus();
    if (action === "merge") vi.mocked(api.list).mockResolvedValue([rows()[1]]);
    await act(async () => { pending.resolve(detail(7, action === "merge" ? { state: "MERGED" } : { isDraft: false })); });
    await expect.element(page.getByRole("heading", { name: "PR 8", exact: true })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "PR 7", exact: true })).not.toBeInTheDocument();
    if (action === "merge") expect(api.merge).toHaveBeenCalledWith(api.projectPath, "owner/repo", 7, "squash", "a".repeat(40), false);
    else expect(api.ready).toHaveBeenCalledWith(api.projectPath, "owner/repo", 7, "a".repeat(40));
  });

  it("does not select a created PR over the user's newer selection", async () => {
    const pending = deferred<PullRequest & { creationOutcome: "created" }>();
    const api = access({ threadActive: false, create: vi.fn(() => pending.promise) });
    mount(api);
    await page.getByRole("button", { name: "Create a pull request", exact: true }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("New PR title");
    await page.getByRole("button", { name: "Push and create", exact: true }).click();
    await page.getByRole("button", { name: /#8 PR 8,/ }).click();
    await expect.element(page.getByRole("heading", { name: "PR 8", exact: true })).toBeVisible();
    await act(async () => { pending.resolve({ ...detail(12, { headRefName: "feature/7" }), creationOutcome: "created" }); });
    await expect.element(page.getByRole("heading", { name: "PR 8", exact: true })).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "PR 12", exact: true })).not.toBeInTheDocument();
  });

  it("does not reopen a merged PR when an older refresh completes", async () => {
    const pending = deferred<PullRequest>();
    const api = access({ merge: vi.fn().mockResolvedValue(detail(7, { state: "MERGED" })) });
    mount(api);
    await page.getByRole("button", { name: /#7 PR 7,/ }).click();
    await expect.element(page.getByRole("heading", { name: "PR 7", exact: true })).toBeVisible();
    vi.mocked(api.view).mockImplementationOnce(() => pending.promise);
    vi.mocked(api.list).mockResolvedValue([rows()[1]]);
    await page.getByRole("button", { name: "Refresh this pull request", exact: true }).click();
    await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
    await page.getByRole("button", { name: /Merge #7/ }).click();
    await expect.element(document.querySelector<HTMLElement>(".thread-pr-card > .thread-pr-card-head > .thread-pr-state.merged")).toHaveTextContent("Merged");
    await act(async () => { pending.resolve(detail(7)); });
    await expect.element(document.querySelector<HTMLElement>(".thread-pr-card > .thread-pr-card-head > .thread-pr-state.merged")).toHaveTextContent("Merged");
    await expect.element(page.getByRole("button", { name: "Merge on GitHub…", exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "All pull requests", exact: true }).click();
    await expect.element(page.getByRole("searchbox", { name: "Search pull requests" })).toHaveFocus();
  });

  it("keeps merge consent temporary when another PR is opened directly", async () => {
    const api = access({ threadActive: false, find: vi.fn().mockResolvedValue(detail(8)), context: vi.fn().mockResolvedValue({ repository: "owner/repo", branch: "feature/8", defaultBranch: "main", headOid: "a".repeat(40), dirty: false, ahead: 1, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"] }) });
    mount(api);
    await page.getByRole("button", { name: /#7 PR 7,/ }).click();
    await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
    await page.getByRole("checkbox", { name: /^Ask GitHub to merge it when it is ready/ }).click();
    await page.getByRole("button", { name: /found for feature\/8/ }).click();
    await expect.element(page.getByRole("heading", { name: "PR 8", exact: true })).toHaveFocus();
    await expect.element(page.getByRole("group", { name: /Confirm merge/ })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
    await expect.element(page.getByRole("checkbox", { name: /^Ask GitHub to merge it when it is ready/ })).not.toBeChecked();
    expect(api.merge).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "All pull requests", exact: true }).click();
    await expect.element(page.getByRole("button", { name: /found for feature\/8/ })).toHaveFocus();
  });

  it("retains an unsubmitted search draft after a mutation finishes", async () => {
    const pending = deferred<PullRequest>();
    const api = access({ merge: vi.fn(() => pending.promise) });
    mount(api);
    await page.getByRole("button", { name: /#7 PR 7,/ }).click();
    await page.getByRole("button", { name: "Merge on GitHub…", exact: true }).click();
    await page.getByRole("button", { name: /Merge #7/ }).click();
    await page.getByRole("button", { name: "All pull requests", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search pull requests" }).fill("author:unsubmitted");
    await act(async () => { pending.resolve(detail(7, { state: "MERGED" })); });
    await expect.element(page.getByRole("searchbox", { name: "Search pull requests" })).toHaveValue("author:unsubmitted");
    await expect.element(page.getByText("Press Enter to search pull requests.", { exact: true })).toBeVisible();
    expect(api.list).toHaveBeenLastCalledWith(api.projectPath, api.repository, { search: undefined, state: "open", limit: 30 });
  });
});

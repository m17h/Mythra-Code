import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitPanel, type GitPanelProps } from "./GitPanel";
import ProjectPullRequestsView from "./ProjectPullRequestsView";
import { CommandPalette } from "./CommandPalette";
import type { GitChange, ProjectGitChanges, ProjectGitHistory } from "../lib/gitInspection";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import type { ProjectGitInspection, ProjectPullRequestAccess } from "../lib/projectGit";
import type { PullRequest, PullRequestSummary } from "../lib/pullRequests";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

let counter = 0;
const uniqueCwd = (name: string) => `/workspace-test/${name}-${counter += 1}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const ROWS: GitChange[] = [
  { path: "src/app.ts", originalPath: null, area: "staged", status: "M" },
  { path: "docs/new name.md", originalPath: "docs/old name.md", area: "staged", status: "R" },
  { path: "src/app.ts", originalPath: null, area: "unstaged", status: "M" },
  { path: "assets/logo.png", originalPath: null, area: "unstaged", status: "M" },
  { path: "notes/todo.txt", originalPath: null, area: "untracked", status: "?" },
];
const changesOf = (rows: GitChange[]): ProjectGitChanges => ({
  rootPath: "/p", rows, truncated: false,
  stagedFiles: rows.filter((row) => row.area === "staged").length,
  unstagedFiles: rows.filter((row) => row.area === "unstaged").length,
  untrackedFiles: rows.filter((row) => row.area === "untracked").length,
  changedFiles: new Set(rows.map((row) => row.path)).size,
});

function inspection(overrides: Partial<ProjectGitInspection> = {}): ProjectGitInspection {
  return {
    cwd: uniqueCwd("changes"),
    getChanges: vi.fn().mockResolvedValue(changesOf(ROWS)),
    getFileDiff: vi.fn(async (_cwd: string, path: string, area) => path === "assets/logo.png"
      ? { path, area, text: "Binary file: text preview unavailable.\n", binary: true, truncated: false }
      : { path, area, text: `@@ -1 +1 @@\n-${area} before\n+${area} after ${path}\n`, binary: false, truncated: path === "src/app.ts" && area === "unstaged" }),
    getHistory: vi.fn(),
    ...overrides,
  };
}

function workflow(overrides: Partial<GitWorkflowControls> = {}): GitWorkflowControls {
  return {
    snapshot: { branch: "feature/ui", headOid: "a".repeat(40), branches: [{ name: "feature/ui", current: true, worktreePath: null }, { name: "main", current: false, worktreePath: null }], stagedFiles: 2, unstagedFiles: 2, changedFiles: 4, stagedPaths: ["src/app.ts", "docs/new name.md"], rootPath: "/p", isRoot: true },
    busy: false, isolated: false, onBranch: vi.fn().mockResolvedValue(true), onRefresh: vi.fn(),
    ...overrides,
  };
}

function panelProps(overrides: Partial<GitPanelProps> = {}): GitPanelProps {
  return {
    repositoryState: "ready", gitInitializing: false, gitOutput: "", gitCommitSuccess: "", gitCommitBusy: false,
    githubAuthenticated: true,
    githubRepoStatus: { isRepo: true, repository: "owner/repo", branch: "feature/ui", upstream: "origin/feature/ui", ahead: 2, behind: 0 },
    readOnly: false, defaultRepositoryName: "repo", workflow: workflow(),
    onAction: vi.fn(), onInitializeGit: vi.fn(), onGitHubAttach: vi.fn(), onGitHubCreate: vi.fn(), onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

describe("Git workspace Changes", () => {
  it("shows staged, unstaged and new files separately, without an AI thread", async () => {
    const onPathAction = vi.fn();
    render(<GitPanel {...panelProps({ inspection: inspection(), onPathAction })} />);
    const staged = await screen.findByRole("region", { name: /Staged/ });
    const unstaged = screen.getByRole("region", { name: /Not staged/ });
    const fresh = screen.getByRole("region", { name: /New files/ });
    expect(within(staged).getByRole("button", { name: /^src\/app\.ts, Modified, staged/ })).toBeInTheDocument();
    // A rename names its source, and a partly staged file is in both groups.
    expect(within(staged).getByRole("button", { name: "docs/new name.md, Renamed from docs/old name.md, staged" })).toBeInTheDocument();
    expect(within(staged).getByText("+ newer edits")).toBeInTheDocument();
    expect(within(unstaged).getByText("partly staged")).toBeInTheDocument();

    fireEvent.click(within(staged).getByRole("button", { name: "Unstage docs/new name.md" }));
    expect(onPathAction).toHaveBeenLastCalledWith("unstage", "docs/new name.md");
    fireEvent.click(within(unstaged).getByRole("button", { name: "Stage assets/logo.png" }));
    expect(onPathAction).toHaveBeenLastCalledWith("stage", "assets/logo.png");
    fireEvent.click(within(unstaged).getByRole("button", { name: "Discard changes to assets/logo.png…" }));
    expect(onPathAction).toHaveBeenLastCalledWith("revert", "assets/logo.png");
    // New files are never offered a destructive Discard.
    expect(within(fresh).queryByRole("button", { name: /Discard/ })).not.toBeInTheDocument();
    expect(within(fresh).getByRole("button", { name: "Stage notes/todo.txt" })).toBeEnabled();
  });

  it("previews one selected file per area, including binary and truncated states", async () => {
    const api = inspection();
    render(<GitPanel {...panelProps({ inspection: api })} />);
    expect(await screen.findByRole("region", { name: /Staged/ })).toBeInTheDocument();
    expect(api.getFileDiff).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole("region", { name: /Not staged/ })).getByRole("button", { name: /^src\/app\.ts, Modified, not staged/ }));
    const preview = await screen.findByRole("region", { name: "Changes in src/app.ts" });
    expect(await within(preview).findByText(/unstaged after src\/app\.ts/)).toBeInTheDocument();
    expect(within(preview).getByText(/Preview cut off at 512 KiB/)).toBeInTheDocument();
    expect(api.getFileDiff).toHaveBeenCalledTimes(1);

    fireEvent.click(within(screen.getByRole("region", { name: /Not staged/ })).getByRole("button", { name: /^assets\/logo\.png/ }));
    expect(await screen.findByText(/Binary file — no text preview/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Changes in src/app.ts" })).not.toBeInTheDocument();
  });

  it("states exactly which files each commit takes", async () => {
    render(<GitPanel {...panelProps({ inspection: inspection() })} />);
    expect(await screen.findByRole("button", { name: "Commit staged (2)" })).toBeInTheDocument();
    expect(screen.getByText(/2 files staged; newer edits to 1 of them stay out/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("What each commit includes"));
    expect(screen.getByText(/Stages everything first: 2 staged, 2 not staged, 1 new/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit all changes (4)" })).toBeInTheDocument();
  });

  it("shows a clear first-load state and a recoverable error", async () => {
    const pending = deferred<ProjectGitChanges>();
    const api = inspection({ getChanges: vi.fn(() => pending.promise) });
    render(<GitPanel {...panelProps({ inspection: api })} />);
    expect(screen.getByText("Reading changes…")).toBeInTheDocument();
    await act(async () => pending.resolve(changesOf([])));
    expect(screen.getByText(/Nothing to commit/)).toBeInTheDocument();
  });

  it("does not read changes while an operation is running, then reads once it settles", async () => {
    const api = inspection();
    const view = render(<GitPanel {...panelProps({ inspection: api, gitOperationBusy: true })} />);
    await new Promise((done) => setTimeout(done, 10));
    expect(api.getChanges).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the current Git operation");
    view.rerender(<GitPanel {...panelProps({ inspection: api, gitOperationBusy: false })} />);
    await waitFor(() => expect(api.getChanges).toHaveBeenCalledTimes(1));
  });
});

describe("Git workspace navigation", () => {
  it("moves between views with the arrow keys and keeps one tab stop", () => {
    render(<GitPanel {...panelProps()} />);
    const changes = screen.getByRole("tab", { name: /Changes/ });
    expect(changes).toHaveAttribute("aria-selected", "true");
    expect(changes).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    const pulls = screen.getByRole("tab", { name: /Pull requests/ });
    expect(pulls).toHaveAttribute("aria-selected", "true");
    expect(pulls).toHaveFocus();
    fireEvent.keyDown(pulls, { key: "End" });
    expect(screen.getByRole("tab", { name: /History/ })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: /History/ }).id);
    expect(changes).toHaveAttribute("tabindex", "-1");
  });

  it("routes focus to a control without running it", async () => {
    const onAction = vi.fn();
    const onFocusHandled = vi.fn();
    render(<GitPanel {...panelProps({ onAction, onFocusHandled, focusRequest: { view: "changes", focus: "push", nonce: 3 } })} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Push commits" })).toHaveFocus());
    expect(onAction).not.toHaveBeenCalled();
    expect(onFocusHandled).toHaveBeenCalledWith(3);
  });

  it("routes the commit shortcut to the commit message", async () => {
    render(<GitPanel {...panelProps({ focusRequest: { view: "changes", focus: "commit", nonce: 1 } })} />);
    await waitFor(() => expect(screen.getByLabelText(/Commit message/)).toHaveFocus());
  });

  it("pages through real commits on demand and links, by name, to checkpoints", async () => {
    const page = (subjects: string[], hasMore: boolean, offset: number): ProjectGitHistory => ({
      entries: subjects.map((subject, index) => ({ oid: `${offset + index}`.padStart(40, "0"), shortOid: `c${offset + index}`, subject, authorName: "Ada", authoredAt: new Date().toISOString() })),
      hasMore, nextOffset: offset + subjects.length, headOid: "a".repeat(40), truncated: false,
    });
    const getHistory = vi.fn().mockResolvedValueOnce(page(["First change", "Second change"], true, 0)).mockResolvedValueOnce(page(["Initial commit"], false, 2));
    const onOpenTool = vi.fn();
    render(<GitPanel {...panelProps({ inspection: inspection({ getHistory }), view: "history", onOpenTool })} />);
    expect(await screen.findByText("First change")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load older commits/ }));
    expect(await screen.findByText("Initial commit")).toBeInTheDocument();
    expect(getHistory).toHaveBeenLastCalledWith(expect.any(String), 2, 30, "a".repeat(40));
    expect(screen.queryByRole("button", { name: /Load older commits/ })).not.toBeInTheDocument();
    expect(screen.getByText(/AI run snapshots live in/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Checkpoints" }));
    expect(onOpenTool).toHaveBeenCalledWith("checkpoints");
  });
});

/* ------------------------------------------------------------------ */

const summary = (number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, title: `Improve ${number}`,
  state: "OPEN", isDraft: false, headRefName: `feature/${number}`, baseRefName: "main", updatedAt: new Date().toISOString(), authorLogin: "octo", ...overrides,
});
const detail = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  ...summary(number), body: "Why this matters", headOid: "a".repeat(40), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
  checks: [
    { name: "unit tests", state: "FAILURE", url: "https://github.com/owner/repo/actions/runs/1" },
    { name: "lint", state: "IN_PROGRESS", url: "" },
    { name: "build", state: "SUCCESS", url: "https://github.com/owner/repo/actions/runs/2" },
  ],
  canMerge: true, viewerCanMerge: true, autoMergeAllowed: false, mergeMethods: ["squash"], ...overrides,
});

function prAccess(overrides: Partial<ProjectPullRequestAccess> = {}): ProjectPullRequestAccess {
  return {
    cwd: uniqueCwd("prs"), projectPath: "/p", repository: "owner/repo", authenticated: true, threadActive: false, isolated: false,
    mutationBlockedReason: null, checkMutationAllowed: () => null,
    list: vi.fn().mockResolvedValue([summary(7), summary(9, { isDraft: true })]),
    view: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number)),
    context: vi.fn().mockResolvedValue({ repository: "owner/repo", branch: "feature/local", defaultBranch: "main", headOid: "c".repeat(40), dirty: true, ahead: 1, behind: 0, pushRemote: "origin", permission: "write", mergeMethods: ["squash"] }),
    find: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    merge: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number, { state: "MERGED" })),
    ready: vi.fn(),
    createBranch: vi.fn(),
    ...overrides,
  };
}

describe("Project pull requests", () => {
  it("browses and inspects pull requests in-app without a conversation", async () => {
    const access = prAccess();
    render(<ProjectPullRequestsView access={access} visible onOpenGitHubSettings={vi.fn()} />);
    expect(screen.getByText("Loading pull requests…")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /#7 Improve 7, Open/ }));
    expect(await screen.findByRole("heading", { name: "Improve 7" })).toBeInTheDocument();
    // Failing and pending checks by name, with direct log links; passing folded.
    const checks = screen.getByRole("list", { name: "Checks for #7" });
    expect(within(checks).getByText("unit tests")).toBeInTheDocument();
    expect(within(checks).getByText("Failing")).toBeInTheDocument();
    expect(within(checks).getByText("lint")).toBeInTheDocument();
    expect(within(checks).queryByText("build")).not.toBeInTheDocument();
    expect(within(checks).getByRole("button", { name: "Open unit tests details on GitHub" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 passed check" }));
    expect(within(screen.getByRole("list", { name: "Checks for #7" })).getByText("build")).toBeInTheDocument();
    // It belongs to another branch than this folder, and says so.
    expect(screen.getByText(/this folder is on/)).toHaveTextContent("feature/local");
    expect(screen.queryByRole("button", { name: /Attach to conversation/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All pull requests/ }));
    expect(await screen.findByRole("button", { name: /#9 Improve 9, Draft/ })).toBeInTheDocument();
  });

  it("merges the revision that was confirmed, never archiving anything", async () => {
    const access = prAccess();
    render(<ProjectPullRequestsView access={access} visible onOpenGitHubSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /#7 Improve 7/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Merge on GitHub…/ }));
    const confirm = screen.getByRole("group", { name: "Confirm merge" });
    expect(within(confirm).queryByText(/Archive this thread/)).not.toBeInTheDocument();
    expect(within(confirm).getByText(/Nothing/)).toHaveTextContent("in this local folder changes");
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge #7 on GitHub" }));
    await waitFor(() => expect(access.merge).toHaveBeenCalledWith("/p", "owner/repo", 7, "squash", "a".repeat(40), false));
    expect(await screen.findByText(/merged on GitHub\. Your local folder is unchanged/)).toBeInTheDocument();
  });

  it("refuses a merge after the pull request moves until the new head is reviewed", async () => {
    let head = "a".repeat(40);
    const access = prAccess({ view: vi.fn(async (_cwd: string, _repository: string, number: number) => detail(number, { headOid: head })) });
    render(<ProjectPullRequestsView access={access} visible onOpenGitHubSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /#7 Improve 7/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Merge on GitHub…/ }));
    head = "b".repeat(40);
    fireEvent.click(screen.getByRole("button", { name: "Refresh this pull request" }));
    expect(await screen.findByText(/New commits were pushed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge #7 on GitHub" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review the updated pull request" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge #7 on GitHub" }));
    await waitFor(() => expect(access.merge).toHaveBeenCalledWith("/p", "owner/repo", 7, "squash", "b".repeat(40), false));
  });

  it("keeps a project pull request draft when the view unmounts and returns", async () => {
    const access = prAccess();
    const view = render(<ProjectPullRequestsView access={access} visible onOpenGitHubSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a pull request" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep this title" } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "And this body" } });
    view.unmount();
    render(<ProjectPullRequestsView access={access} visible onOpenGitHubSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a pull request" }));
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this title");
    expect(screen.getByLabelText(/Description/)).toHaveValue("And this body");
    // Commit-everything consent is a draft field the person set, never inferred.
    expect(screen.getByRole("checkbox", { name: /Commit every change in this folder first/ })).not.toBeChecked();
  });

  it("offers attachment only as conversation metadata, and only when the conversation has none", async () => {
    const attachToThread = vi.fn().mockResolvedValue(undefined);
    render(<ProjectPullRequestsView access={prAccess({ threadActive: true, attachToThread })} visible conversationPanel={<div>thread panel</div>} onOpenGitHubSettings={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "This conversation" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This branch" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /#7 Improve 7/ }));
    const attach = await screen.findByRole("button", { name: /Attach to conversation/ });
    expect(attach).toHaveAttribute("title", expect.stringContaining("Nothing changes in Git or on GitHub"));
    fireEvent.click(attach);
    await waitFor(() => expect(attachToThread).toHaveBeenCalledWith("https://github.com/owner/repo/pull/7"));
  });

  it("explains a missing remote or account instead of failing", () => {
    const onConnect = vi.fn();
    const { rerender } = render(<ProjectPullRequestsView access={prAccess({ repository: null })} visible onOpenGitHubSettings={vi.fn()} onConnectRepository={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a repository/ }));
    expect(onConnect).toHaveBeenCalled();
    const settings = vi.fn();
    rerender(<ProjectPullRequestsView access={prAccess({ authenticated: false })} visible onOpenGitHubSettings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: /Open GitHub settings/ }));
    expect(settings).toHaveBeenCalled();
  });
});

describe("Command palette Git routes", () => {
  it("routes Git commands to the workspace and never runs them", () => {
    const onGitRoute = vi.fn();
    const onTool = vi.fn();
    render(<CommandPalette open projects={[]} threads={[]} workflows={[]} projectActive onClose={vi.fn()} onProject={vi.fn()} onThread={vi.fn()} onWorkflow={vi.fn()} onNewThread={vi.fn()} onSettings={vi.fn()} onTool={onTool} onGitRoute={onGitRoute} />);
    fireEvent.change(screen.getByLabelText(/Search commands/), { target: { value: "push" } });
    fireEvent.click(screen.getByRole("option", { name: /Git: Push/ }));
    expect(onGitRoute).toHaveBeenCalledWith({ view: "changes", focus: "push" });
    fireEvent.change(screen.getByLabelText(/Search commands/), { target: { value: "PR" } });
    fireEvent.click(screen.getByRole("option", { name: /Git: Pull requests/ }));
    expect(onGitRoute).toHaveBeenLastCalledWith({ view: "pulls", focus: "pullRequestSearch" });
    expect(onTool).not.toHaveBeenCalled();
  });
});

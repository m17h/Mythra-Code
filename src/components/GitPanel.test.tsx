import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { GitPanel, type GitPanelProps } from "./GitPanel";

function panelProps(overrides: Partial<GitPanelProps> = {}): GitPanelProps {
  return {
    repositoryState: "ready",
    gitInitializing: false,
    gitOutput: "",
    gitCommitSuccess: "",
    gitCommitBusy: false,
    githubAuthenticated: false,
    githubRepoStatus: null,
    readOnly: false,
    defaultRepositoryName: "project",
    onAction: vi.fn(),
    onInitializeGit: vi.fn(),
    onGitHubAttach: vi.fn(),
    onGitHubCreate: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

const attached = {
  isRepo: true,
  repository: "m17h/Mythra-Code",
  branch: "feature/ui-polish",
  upstream: "origin/feature/ui-polish",
  ahead: 2,
  behind: 1,
};

/** A workspace snapshot shaped like the one `src/lib/gitWorkspace.ts` returns. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    branch: "feature/ui-polish",
    headOid: "abc123",
    branches: [
      { name: "feature/ui-polish", current: true, worktreePath: null },
      { name: "main", current: false, worktreePath: null },
      { name: "mythra/held", current: false, worktreePath: "/worktrees/held" },
    ],
    stagedFiles: 0,
    unstagedFiles: 3,
    changedFiles: 3,
    stagedPaths: [],
    rootPath: "/project",
    isRoot: true,
    ...overrides,
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: snapshot(),
    busy: false,
    isolated: false,
    onBranch: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn(),
    ...overrides,
  } as unknown as NonNullable<GitPanelProps["workflow"]>;
}

describe("GitPanel commit controls", () => {
  it("makes bulk revert's added-file preservation contract explicit", () => {
    const props = panelProps();
    render(<GitPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More local Git actions" }));
    const revert = screen.getByRole("menuitem", { name: /Revert all changes/ });
    expect(revert).toHaveTextContent("Added and new files are kept");
    expect(revert).toHaveAttribute("title", "Restore committed files; keep added, renamed-destination and untracked file contents");
    fireEvent.click(revert);
    expect(props.onAction).toHaveBeenCalledWith("revert");
  });

  it("consumes a confirmed repeated message even without an intermediate busy render", () => {
    const input = panelProps({ gitCommitSuccess: "Repeat was saved.", gitCommitSuccessRevision: 4 });
    const view = render(<GitPanel {...input} />);
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Repeat" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitSuccessRevision={5} />);
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("");
  });

  it("does not consume a rejected commit draft using an earlier success notification", () => {
    function Owner() {
      const [draft, setDraft] = useState({ commitMessage: "Keep this next draft", remoteInput: "", repositoryName: "project", visibility: "private" as const });
      const [output, setOutput] = useState("");
      return <GitPanel {...panelProps({ gitCommitSuccess: "Earlier commit was saved", gitOutput: output, draft, onAction: () => setOutput("Wait for agents in this folder to finish.") })} onDraftChange={(next) => setDraft({ ...next, visibility: "private" })} />;
    }
    render(<Owner />);
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Keep this next draft");
    expect(screen.getByText(/Wait for agents/)).toBeInTheDocument();
  });

  it("requires the repository root before changing a nested selected project folder", () => {
    const input = panelProps({ selectedFolder: "/project/packages/app", workflow: workflow({ snapshot: snapshot({ isRoot: false }) }), githubAuthenticated: true, githubRepoStatus: attached });
    render(<GitPanel {...input} />);
    expect(screen.getByRole("alert")).toHaveTextContent("/project");
    const commitButton = screen.getByRole("button", { name: "Commit all changes locally" });
    expect(commitButton).toBeDisabled();
    expect(commitButton).toHaveAttribute("title", expect.stringContaining("repository root"));
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "More local Git actions" }));
    expect(screen.getByRole("menuitem", { name: /Show git status output/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Show full diff output/ })).toBeEnabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.submit(commitButton.closest("form")!);
    expect(input.onAction).not.toHaveBeenCalled();
  });

  it("accepts a selected root with different native slash conventions", () => {
    render(<GitPanel {...panelProps({ selectedFolder: "C:\\project\\", workflow: workflow({ snapshot: snapshot({ rootPath: "C:/project", isRoot: true }) }) })} />);
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { selectedFolder: "C:\\project", rootPath: "\\\\?\\C:\\Project" },
    { selectedFolder: "\\\\server\\share\\project", rootPath: "\\\\?\\UNC\\server\\share\\project" },
    { selectedFolder: "/projects/symlink", rootPath: "/projects/canonical" },
  ])("accepts the native root identity despite canonical path differences: %j", ({ selectedFolder, rootPath }) => {
    render(<GitPanel {...panelProps({ selectedFolder, workflow: workflow({ snapshot: snapshot({ rootPath, isRoot: true }) }) })} />);
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a new draft when an earlier commit completes", () => {
    const input = panelProps();
    const view = render(<GitPanel {...input} />);
    const message = screen.getByLabelText(/Commit message/i);
    fireEvent.change(message, { target: { value: "First commit" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitBusy />);
    fireEvent.change(message, { target: { value: "Next commit draft" } });
    view.rerender(<GitPanel {...input} gitCommitSuccess="First commit was saved." />);
    expect(message).toHaveValue("Next commit draft");
  });

  it("clears only the submitted message after a successful commit and keeps it on failure", () => {
    const input = panelProps();
    const view = render(<GitPanel {...input} />);
    const message = screen.getByLabelText(/Commit message/i);
    fireEvent.change(message, { target: { value: "Keep on failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitBusy />);
    view.rerender(<GitPanel {...input} gitOutput="Commit hook rejected the change" />);
    expect(message).toHaveValue("Keep on failure");
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    view.rerender(<GitPanel {...input} gitCommitSuccess="Keep on failure was saved." />);
    expect(message).toHaveValue("");
  });

  it("uses the checkout's retained draft and reports edits back to its owner", () => {
    const onDraftChange = vi.fn();
    const draft = { commitMessage: "Stored commit", remoteInput: "https://github.com/m17h/existing", repositoryName: "stored-repo", visibility: "public" as const };
    render(<GitPanel {...panelProps({ draft, onDraftChange, githubAuthenticated: true })} />);
    expect(screen.getByLabelText(/Commit message/i)).toHaveValue("Stored commit");
    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Next stored draft" } });
    expect(onDraftChange).toHaveBeenCalledWith({ ...draft, commitMessage: "Next stored draft" });
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    expect(screen.getByLabelText("Existing repository URL")).toHaveValue(draft.remoteInput);
    expect(screen.getByLabelText("New GitHub repository name")).toHaveValue(draft.repositoryName);
    expect(screen.getByRole("button", { name: "Repository visibility" })).toHaveTextContent("Public");
  });

  it.each([{ readOnly: true }, { gitCommitBusy: true }, { gitOperationBusy: true }, { githubBusy: true }, { repositoryState: "absent" as const }])(
    "guards form submission while the commit is unavailable: %j", (overrides) => {
      const input = panelProps(overrides);
      const view = render(<GitPanel {...input} />);
      fireEvent.submit(view.container.querySelector(".git-commit-card")!);
      expect(input.onAction).not.toHaveBeenCalled();
    },
  );

  it("sends the message the person can see to Commit & push", () => {
    // The reported bug: the button committed under a default message while
    // the text they had typed sat in the field directly above it.
    const onAction = vi.fn();
    render(<GitPanel {...panelProps({ onAction, githubRepoStatus: attached })} />);

    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Tighten the merge copy" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));

    expect(onAction).toHaveBeenCalledWith("commitPush", "Tighten the merge copy");
  });

  it("offers staged and everything as separate commits, sharing one message", () => {
    const onAction = vi.fn();
    render(
      <GitPanel
        {...panelProps({
          onAction,
          githubRepoStatus: attached,
          workflow: workflow({ snapshot: snapshot({ stagedFiles: 2, unstagedFiles: 1, changedFiles: 3, stagedPaths: ["a.ts", "b.ts"] }) }),
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Commit message/i), { target: { value: "Just the staged two" } });

    fireEvent.click(screen.getByRole("button", { name: "Commit staged (2)" }));
    expect(onAction).toHaveBeenCalledWith("commitStaged", "Just the staged two");

    fireEvent.click(screen.getByRole("button", { name: "Commit all changes (3)" }));
    expect(onAction).toHaveBeenCalledWith("commit", "Just the staged two");

    // The push variant follows whichever commit is the primary one, so it can
    // never quietly push more than the button above it promised.
    fireEvent.click(screen.getByRole("button", { name: /Commit & push/ }));
    expect(onAction).toHaveBeenCalledWith("commitStagedPush", "Just the staged two");
  });

  it("keeps the single plain commit button when nothing is staged", () => {
    const onAction = vi.fn();
    render(<GitPanel {...panelProps({ onAction, workflow: workflow() })} />);

    expect(screen.queryByRole("button", { name: /Commit staged/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Commit all changes locally" }));
    expect(onAction).toHaveBeenCalledWith("commit", "");
  });
});

describe("GitPanel local branch", () => {
  it("uses a detached local snapshot instead of a stale named GitHub branch", () => {
    render(<GitPanel {...panelProps({ githubRepoStatus: attached, workflow: workflow({ snapshot: snapshot({ branch: null }) }) })} />);
    expect(screen.getByText("No branch checked out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Push commits" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit & push" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit all changes locally" })).toBeEnabled();
  });

  it("switches branches through the app's own menu, and refuses one held by another worktree", () => {
    const controls = workflow();
    render(<GitPanel {...panelProps({ workflow: controls })} />);

    expect(screen.getByText("feature/ui-polish")).toBeInTheDocument();
    expect(screen.getByText(/Shared project folder/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    // Never an OS drop-down: the menu is the app's own, with real menu roles.
    expect(screen.getByRole("menu", { name: "Switch or create a branch" })).toBeInTheDocument();

    const held = screen.getByRole("menuitem", { name: /mythra\/held/ });
    expect(held).toBeDisabled();
    expect(held).toHaveAttribute("title", expect.stringContaining("checked out in /worktrees/held"));

    fireEvent.click(screen.getByRole("menuitem", { name: /^main/ }));
    expect(controls.onBranch).toHaveBeenCalledWith("main", false);
  });

  it("creates a branch without GitHub, and says who else moves with it", async () => {
    const controls = workflow();
    render(<GitPanel {...panelProps({ workflow: controls, githubAuthenticated: false })} />);

    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch…/ }));

    expect(screen.getByText(/Every thread using this folder moves to the new branch too/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent to GitHub/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/next" } });
    fireEvent.click(screen.getByRole("button", { name: /Create branch/ }));
    expect(controls.onBranch).toHaveBeenCalledWith("feature/next", true);
  });

  it("keeps the branch draft visible when its owner rejects the operation", async () => {
    const controls = workflow({ onBranch: vi.fn().mockResolvedValue(false) });
    render(<GitPanel {...panelProps({ workflow: controls })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch/ }));
    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/keep-me" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await vi.waitFor(() => expect(controls.onBranch).toHaveBeenCalled());
    expect(screen.getByLabelText("New branch name")).toHaveValue("feature/keep-me");
  });

  it("keeps managed isolated work on its assigned branch", () => {
    render(<GitPanel {...panelProps({ workflow: workflow({ isolated: true }) })} />);

    expect(screen.getByText(/Isolated worktree/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    const create = screen.getByRole("menuitem", { name: /New branch…/ });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("title", expect.stringContaining("keeps its isolated branch"));
  });

  it("closes a shared-folder branch draft when the checkout becomes isolated", () => {
    const shared = workflow();
    const view = render(<GitPanel {...panelProps({ workflow: shared, selectedFolder: "/project" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /New branch/ }));
    fireEvent.change(screen.getByLabelText("New branch name"), { target: { value: "feature/from-shared" } });

    const isolated = workflow({ isolated: true });
    view.rerender(<GitPanel {...panelProps({ workflow: isolated, selectedFolder: "/project" })} />);
    expect(screen.queryByLabelText("New branch name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch or create a branch" }));
    expect(screen.getByRole("menuitem", { name: /New branch/ })).toBeDisabled();
    expect(shared.onBranch).not.toHaveBeenCalled();
    expect(isolated.onBranch).not.toHaveBeenCalled();
  });
});

describe("GitPanel GitHub section", () => {
  it("allows signed-out users to attach an existing remote and connects an account only for creation", () => {
    const input = panelProps();
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    fireEvent.change(screen.getByLabelText("Existing repository URL"), { target: { value: "https://github.com/m17h/existing" } });
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/existing");
    expect(screen.queryByRole("form", { name: "Create a GitHub repository" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub account" }));
    expect(input.onOpenGitHubSettings).toHaveBeenCalledOnce();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
  });

  it("shows connection progress, blocks repeated submission, and preserves fields on failure", () => {
    const input = panelProps({ githubAuthenticated: true });
    const view = render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    const url = screen.getByLabelText("Existing repository URL");
    fireEvent.change(url, { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach remote" }));
    view.rerender(<GitPanel {...input} githubBusy />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting this project to GitHub");
    expect(screen.getByRole("button", { name: "Attaching…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Repository visibility" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    fireEvent.submit(screen.getByRole("form", { name: "Create a GitHub repository" }));
    expect(input.onGitHubAttach).toHaveBeenCalledOnce();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
    view.rerender(<GitPanel {...input} githubOperationError="GitHub rejected this repository address." />);
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub rejected this repository address.");
    expect(url).toHaveValue("https://github.com/m17h/example.git");
    expect(screen.getByLabelText("New GitHub repository name")).toHaveValue("project");
    expect(screen.getByRole("button", { name: "Attach remote" })).toBeEnabled();
  });

  it("guards both publishing forms in a read-only thread", () => {
    const input = panelProps({ githubAuthenticated: true, readOnly: true });
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    fireEvent.change(screen.getByLabelText("Existing repository URL"), { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.submit(screen.getByRole("form", { name: "Attach an existing GitHub repository" }));
    fireEvent.submit(screen.getByRole("form", { name: "Create a GitHub repository" }));
    expect(input.onGitHubAttach).not.toHaveBeenCalled();
    expect(input.onGitHubCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("keeps the remote URL for retry when attaching does not establish a repository", () => {
    const input = panelProps({ githubAuthenticated: true });
    render(<GitPanel {...input} />);
    fireEvent.click(screen.getByRole("button", { name: /Connect a GitHub repository/ }));
    const url = screen.getByLabelText("Existing repository URL");
    fireEvent.change(url, { target: { value: "https://github.com/m17h/example.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach remote" }));
    expect(input.onGitHubAttach).toHaveBeenCalledWith("https://github.com/m17h/example.git");
    expect(url).toHaveValue("https://github.com/m17h/example.git");
  });

  it("reports ahead and behind as last known, against the branch they were measured from", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: attached,
          workflow: workflow({ lastFetchedAt: Date.now() - 4 * 60_000 }),
        })}
      />,
    );

    // The tracked branch has this branch's name, so the remote alone names it;
    // the full upstream stays available on the line itself.
    const line = screen.getByText(/Compared with origin:/);
    expect(line).toHaveAttribute("title", "Tracking origin/feature/ui-polish");
    expect(line).toHaveTextContent("2 to push");
    expect(line).toHaveTextContent("1 to pull");
    expect(line).toHaveTextContent("fetched 4 min ago");
    // The counts sit beside the branch too, where a long name cannot hide them.
    expect(screen.getByLabelText("2 to push")).toBeInTheDocument();
    expect(screen.getByLabelText("1 to pull")).toBeInTheDocument();
  });

  it("spells out an upstream whose name differs from the local branch", () => {
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: { ...attached, upstream: "origin/release/next" } })} />);
    expect(screen.getByText(/Compared with origin\/release\/next: 2 to push, 1 to pull/)).toBeInTheDocument();
  });

  it("does not read a missing upstream as proof that nothing was ever published", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: { ...attached, upstream: undefined, ahead: 0, behind: 0 },
        })}
      />,
    );

    expect(screen.queryByText(/not pushed yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has no tracked branch here yet/)).toBeInTheDocument();
  });

  it("shows the console only once there is output in it", () => {
    const { rerender } = render(<GitPanel {...panelProps()} />);
    expect(screen.queryByText(/Choose an action to inspect/)).not.toBeInTheDocument();
    expect(screen.queryByText("Git output")).not.toBeInTheDocument();

    rerender(<GitPanel {...panelProps({ gitOutput: "$ git status\nnothing to commit" })} />);
    expect(screen.getByText("Git output")).toBeInTheDocument();
    expect(screen.getByText(/nothing to commit/)).toBeInTheDocument();
  });
});

describe("GitPanel automatic publishing", () => {
  const autoPublish = (overrides: Record<string, unknown> = {}) => workflow({
    autoPublish: {
      enabled: false,
      status: "idle",
      message: "",
      repository: "m17h/Mythra-Code",
      onToggle: vi.fn(),
      onRetry: vi.fn(),
      ...overrides,
    },
  });

  it("is off until it is switched on and confirmed, and names the repository it would push to", () => {
    const controls = autoPublish();
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: attached, workflow: controls })} />);

    const toggle = screen.getByRole("switch", { name: /Automatically publish branches and commits/ });
    expect(toggle).not.toBeChecked();

    const scope = screen.getByText(/including work from agents, the terminal/);
    expect(scope).toHaveTextContent("m17h/Mythra-Code");
    expect(scope).toHaveTextContent("Uncommitted files stay local");
    expect(scope).toHaveTextContent("overwrites remote history");
    // Compact while off: the consequences are folded away, but still describe the switch.
    expect(scope).not.toBeVisible();
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining("including work from agents"));

    // No status line while it is off: there is nothing being watched.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    // Turning it on shows every consequence first and waits for a decision.
    expect(controls.autoPublish?.onToggle).not.toHaveBeenCalled();
    expect(scope).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep it off" }));
    expect(controls.autoPublish?.onToggle).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Turn on and publish/ }));
    expect(controls.autoPublish?.onToggle).toHaveBeenCalledWith(true);
  });

  it("surfaces a paused state with the reason and destination review instructions", () => {
    const controls = autoPublish({
      enabled: true,
      status: "paused",
      message: "Paused — main was rejected by GitHub (protected branch). 3 commits waiting.",
    });
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: attached, workflow: controls })} />);

    expect(screen.getByRole("switch", { name: /Automatically publish branches and commits/ })).toBeChecked();
    expect(screen.getByText(/protected branch/)).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText(/off and on to review the destination/)).toBeInTheDocument();
  });

  it("offers no retry while it is simply publishing", () => {
    render(
      <GitPanel
        {...panelProps({
          githubAuthenticated: true,
          githubRepoStatus: attached,
          workflow: autoPublish({ enabled: true, status: "publishing", message: "Publishing feature/ui-polish…" }),
        })}
      />,
    );

    expect(screen.getByText("Publishing feature/ui-polish…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("allows turning off a paused configuration after its remote is removed", () => {
    const controls = autoPublish({ enabled: true, status: "paused", message: "Publishing remote changed." });
    render(<GitPanel {...panelProps({ workflow: controls })} />);
    fireEvent.click(screen.getByRole("switch", { name: /Automatically publish/ }));
    expect(controls.autoPublish?.onToggle).toHaveBeenCalledWith(false);
  });

  it("retries a waiting network failure without resetting the destination", () => {
    const controls = autoPublish({ enabled: true, status: "waiting", message: "GitHub is unavailable." });
    render(<GitPanel {...panelProps({ githubRepoStatus: attached, workflow: controls })} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(controls.autoPublish?.onRetry).toHaveBeenCalledOnce();
  });

  it("stays hidden entirely where there is no repository to publish to", () => {
    render(<GitPanel {...panelProps({ githubAuthenticated: true, workflow: autoPublish() })} />);
    expect(screen.queryByRole("switch", { name: /Automatically publish branches and commits/ })).not.toBeInTheDocument();
  });
});

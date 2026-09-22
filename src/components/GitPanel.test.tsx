import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});

describe("GitPanel GitHub section", () => {
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

    const line = screen.getByText(/Compared with origin\/feature\/ui-polish/);
    expect(line).toHaveTextContent("2 to push");
    expect(line).toHaveTextContent("1 to pull");
    expect(line).toHaveTextContent("checked 4 min ago");
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

  it("is off until it is switched on, and names the repository it would push to", () => {
    const controls = autoPublish();
    render(<GitPanel {...panelProps({ githubAuthenticated: true, githubRepoStatus: attached, workflow: controls })} />);

    const toggle = screen.getByRole("switch", { name: /Automatically publish branches and commits/ });
    expect(toggle).not.toBeChecked();

    const scope = screen.getByText(/including work from agents, the terminal/);
    expect(scope).toHaveTextContent("m17h/Mythra-Code");
    expect(scope).toHaveTextContent("Uncommitted files stay local");
    expect(scope).toHaveTextContent("overwrites remote history");

    // No status line while it is off: there is nothing being watched.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(toggle);
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

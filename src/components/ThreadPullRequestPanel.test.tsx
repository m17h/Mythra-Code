import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadPullRequestPanel, type ThreadPullRequestPanelProps } from "./ThreadPullRequestPanel";
import type { PullRequest, PullRequestContext, PullRequestPanelProps } from "../lib/pullRequests";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

function context(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    repository: "m17h/Mythra-Code",
    branch: "codex/pr-workflow",
    defaultBranch: "main",
    headOid: "abc1234",
    dirty: false,
    ahead: 1,
    behind: 0,
    pushRemote: "origin",
    permission: "write",
    mergeMethods: ["squash", "merge"],
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: "m17h/Mythra-Code",
    number: 123,
    url: "https://github.com/m17h/Mythra-Code/pull/123",
    title: "Thread pull request workflow",
    body: "",
    state: "OPEN",
    isDraft: false,
    headRefName: "codex/pr-workflow",
    baseRefName: "main",
    headOid: "abc1234",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    checks: [{ name: "build", state: "SUCCESS", url: "https://example.test/1" }],
    updatedAt: "2026-09-22T10:00:00Z",
    canMerge: true,
    viewerCanMerge: true,
    autoMergeAllowed: true,
    mergeMethods: ["squash", "merge"],
    ...overrides,
  };
}

function panelProps(overrides: Partial<PullRequestPanelProps> = {}): PullRequestPanelProps {
  return {
    threadId: "thread-1",
    context: context(),
    pullRequest: null,
    linked: false,
    isolated: false,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    mutationBlockedReason: null,
    onRefresh: vi.fn(),
    onAttach: vi.fn().mockResolvedValue(undefined),
    onDetach: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onMerge: vi.fn().mockResolvedValue(undefined),
    onCreateBranch: vi.fn().mockResolvedValue(undefined),
    onOpenWorktrees: vi.fn(),
    onOpenGitHubSettings: vi.fn(),
    ...overrides,
  };
}

describe("ThreadPullRequestPanel — attaching", () => {
  it("never attaches a discovered pull request on its own", () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    render(<ThreadPullRequestPanel {...panelProps({ pullRequest: pullRequest(), linked: false, onAttach })} />);

    // It is offered, and plainly marked as not yet attached.
    expect(screen.getByText("Found on this branch")).toBeInTheDocument();
    expect(screen.getByText(/not attached until you attach it/i)).toBeInTheDocument();
    expect(onAttach).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /attach to this thread/i }));
    // The full URL, not "123": a candidate can live in a different repository
    // than this folder points at, and a bare number resolves against the wrong
    // one.
    expect(onAttach).toHaveBeenCalledWith("https://github.com/m17h/Mythra-Code/pull/123");
  });

  it("only enables Attach once the reference can actually be read", () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    render(<ThreadPullRequestPanel {...panelProps({ onAttach })} />);
    const field = screen.getByLabelText(/pull request number or link/i);
    const attach = screen.getByRole("button", { name: /^attach$/i });

    expect(attach).toBeDisabled();

    fireEvent.change(field, { target: { value: "not a pull request" } });
    expect(attach).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/number like #123/i);

    fireEvent.change(field, { target: { value: "#456" } });
    expect(attach).toBeEnabled();
    fireEvent.click(attach);
    expect(onAttach).toHaveBeenCalledWith("#456");
  });

  it("keeps what was typed when the attach fails", async () => {
    const onAttach = vi.fn().mockRejectedValue(new Error("no such pull request"));
    render(<ThreadPullRequestPanel {...panelProps({ onAttach })} />);
    const field = screen.getByLabelText(/pull request number or link/i);

    fireEvent.change(field, { target: { value: "#456" } });
    fireEvent.click(screen.getByRole("button", { name: /^attach$/i }));
    await vi.waitFor(() => expect(onAttach).toHaveBeenCalled());

    expect(field).toHaveValue("#456");
  });

  it("says a removal is local only, without a standing paragraph about it", () => {
    render(<ThreadPullRequestPanel {...panelProps({ pullRequest: pullRequest(), linked: true })} />);

    // The reassurance belongs on the control it describes, not as prose that
    // sits there whether or not anyone is considering the action.
    expect(screen.getByRole("button", { name: /remove from thread/i }))
      .toHaveAttribute("title", "Removes the link from this thread only. Nothing is closed or changed on GitHub.");
    expect(screen.queryByText(/only clears the link held by this thread/i)).not.toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — creating", () => {
  function openEditor(props: Partial<PullRequestPanelProps> = {}) {
    const merged = panelProps(props);
    render(<ThreadPullRequestPanel {...merged} />);
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));
    return merged;
  }

  it("offers no commit-everything box when the folder is clean", () => {
    openEditor();
    expect(screen.queryByText(/commit every change in this folder first/i)).not.toBeInTheDocument();
  });

  it("leaves commitAll false when the box is never ticked", async () => {
    const props = openEditor({ context: context({ dirty: true }) });

    // The box exists, is offered unticked, and the consequence is spelled out.
    const box = screen.getByRole("checkbox", { name: /commit every change in this folder first/i });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/stay out of the pull request unless you tick the box/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "A change" } });
    fireEvent.click(screen.getByRole("button", { name: /push and create/i }));

    await vi.waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({
      commitAll: false,
      commitMessage: undefined,
      head: "codex/pr-workflow",
      base: "main",
      expectedHeadOid: "abc1234",
      title: "A change",
      draft: false,
    }));
  });

  it("commits everything only when the box is ticked, and says so first", async () => {
    const props = openEditor({ context: context({ dirty: true }) });

    fireEvent.click(screen.getByRole("checkbox", { name: /commit every change in this folder first/i }));
    fireEvent.change(screen.getByLabelText(/commit message/i), { target: { value: "Save the work" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "A change" } });

    // The combined action states its three steps before it is used.
    const plan = screen.getByLabelText("What this will do");
    expect(within(plan).getByText(/Commit every change in this folder as/)).toBeInTheDocument();
    expect(within(plan).getByText(/Push/)).toBeInTheDocument();
    expect(within(plan).getByText(/Open a pull request into/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /commit, push and create/i }));
    await vi.waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ commitAll: true, commitMessage: "Save the work" }));
  });

  it("warns that a shared folder's changes are not the thread's alone", () => {
    openEditor({ context: context({ dirty: true }), isolated: false });
    expect(screen.getByText(/belong to the folder, not to this thread alone/i)).toBeInTheDocument();
  });

  it("offers a branch instead of a create form on the default branch", () => {
    const props = panelProps({ context: context({ branch: "main" }) });
    render(<ThreadPullRequestPanel {...props} />);

    expect(screen.queryByRole("button", { name: /create a pull request/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/new branch name/i), { target: { value: "feature/thing" } });
    fireEvent.click(screen.getByRole("button", { name: /create branch/i }));
    expect(props.onCreateBranch).toHaveBeenCalledWith("feature/thing");
  });

  it("points an isolated thread at worktrees rather than a shared branch", () => {
    const props = panelProps({ context: context({ branch: "main" }), isolated: true });
    render(<ThreadPullRequestPanel {...props} />);

    expect(screen.queryByLabelText(/new branch name/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open worktrees/i }));
    expect(props.onOpenWorktrees).toHaveBeenCalled();
  });
});

describe("ThreadPullRequestPanel — merging", () => {
  function openMerge(props: Partial<PullRequestPanelProps> = {}) {
    const merged = panelProps({ linked: true, pullRequest: pullRequest(), ...props });
    render(<ThreadPullRequestPanel {...merged} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    return merged;
  }

  it("names the repository, the pull request and both branches before merging", async () => {
    const props = openMerge();
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByText("m17h/Mythra-Code #123")).toBeInTheDocument();
    expect(within(confirm).getByText(/Thread pull request workflow/)).toBeInTheDocument();
    expect(within(confirm).getAllByText("codex/pr-workflow")[0]).toBeInTheDocument();
    expect(within(confirm).getAllByText("main")[0]).toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole("button", { name: /merge #123/i }));
    await vi.waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("squash", false));
  });

  it("offers only the merge methods the repository allows", () => {
    openMerge({ pullRequest: pullRequest({ mergeMethods: ["rebase"] }) });
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByRole("radio", { name: /rebase and merge/i })).toBeInTheDocument();
    expect(within(confirm).queryByRole("radio", { name: /squash and merge/i })).not.toBeInTheDocument();
    expect(within(confirm).queryByRole("radio", { name: /merge commit/i })).not.toBeInTheDocument();
  });

  it("merges the selected pull request even when the folder sits on another branch", async () => {
    const props = openMerge({
      pullRequest: pullRequest({ number: 77, headRefName: "codex/other-branch" }),
      context: context({ branch: "codex/pr-workflow" }),
    });

    expect(screen.getByText(/Everything below acts on the pull request, not on your current branch/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /merge #77/i }));
    await vi.waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("squash", false));
  });

  it("stops a draft and a conflicted pull request outright", () => {
    const stoppers: [Partial<PullRequest>, RegExp][] = [
      [{ isDraft: true }, /still a draft/i],
      [{ mergeable: "CONFLICTING" }, /conflicts with its base branch/i],
    ];
    for (const [overrides, reason] of stoppers) {
      const { unmount } = render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest(overrides) })} />);
      fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
      const confirm = screen.getByRole("group", { name: /confirm merge/i });
      expect(within(confirm).getByText(reason)).toBeInTheDocument();
      expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();
      // A stopped merge offers no method or auto-merge choice at all.
      expect(within(confirm).queryByRole("radio")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("offers no merge at all once the pull request is closed or merged", () => {
    for (const state of ["CLOSED", "MERGED"] as const) {
      const { unmount } = render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ state }) })} />);
      expect(screen.queryByRole("button", { name: /merge on github…/i })).not.toBeInTheDocument();
      // The status is still reported, and the link can still be removed.
      expect(screen.getByText(state === "CLOSED" ? "Closed" : "Merged")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /remove from thread/i })).toBeInTheDocument();
      unmount();
    }
  });

  it("refuses an immediate merge while checks run, but offers to enable auto merge", async () => {
    const props = openMerge({
      pullRequest: pullRequest({ canMerge: false, checks: [{ name: "build", state: "IN_PROGRESS", url: "" }] }),
    });
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByText(/1 check is still running/i)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();

    // The wording promises a request, not a merge.
    const auto = within(confirm).getByRole("checkbox", { name: /merge it when it is ready/i });
    expect(within(confirm).getByText(/Nothing merges now/i)).toBeInTheDocument();

    fireEvent.click(auto);
    const enable = within(confirm).getByRole("button", { name: /enable auto merge/i });
    expect(enable).toBeEnabled();
    fireEvent.click(enable);
    await vi.waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("squash", true));
  });

  it("keeps the confirmation open when the merge fails", async () => {
    const onMerge = vi.fn().mockRejectedValue(new Error("base branch moved"));
    openMerge({ onMerge });

    fireEvent.click(screen.getByRole("button", { name: /merge #123/i }));
    await vi.waitFor(() => expect(onMerge).toHaveBeenCalled());
    expect(screen.getByRole("group", { name: /confirm merge/i })).toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — when nothing may change", () => {
  it("keeps attaching available in read only, and says so", () => {
    // Attaching writes the thread's own notes. No Git write, no GitHub write,
    // so read-only mode and a running turn have no business blocking it.
    const blocked = "Switch this thread from Read only before changing GitHub.";
    const props = panelProps({ mutationBlockedReason: blocked, pullRequest: pullRequest(), linked: false });
    render(<ThreadPullRequestPanel {...props} />);

    expect(screen.getByText(/Attaching and removing a pull request still work/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /attach to this thread/i })).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/pull request number or link/i), { target: { value: "#9" } });
    expect(screen.getByRole("button", { name: /^attach$/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /^attach$/i }));
    expect(props.onAttach).toHaveBeenCalledWith("#9");
  });

  it("keeps removing available in read only too", () => {
    const props = panelProps({ mutationBlockedReason: "Read only.", linked: true, pullRequest: pullRequest() });
    render(<ThreadPullRequestPanel {...props} />);

    const remove = screen.getByRole("button", { name: /remove from thread/i });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(props.onDetach).toHaveBeenCalled();
  });

  it("still holds attaching and removing back while another operation is in flight", () => {
    // Read-only is not a reason; a competing in-flight operation is.
    const candidate = render(<ThreadPullRequestPanel {...panelProps({ busy: true, pullRequest: pullRequest(), linked: false })} />);
    expect(screen.getByRole("button", { name: /attach to this thread/i })).toBeDisabled();
    candidate.unmount();

    render(<ThreadPullRequestPanel {...panelProps({ busy: true, pullRequest: pullRequest(), linked: true })} />);
    expect(screen.getByRole("button", { name: /remove from thread/i })).toBeDisabled();
  });

  it("disables the merge outright when the thread may not change anything", () => {
    const blocked = "This thread is read only.";
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest(), mutationBlockedReason: blocked })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    const confirm = screen.getByRole("group", { name: /confirm merge/i });
    expect(within(confirm).getByText(blocked)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();
  });

  it("still merges an attached pull request with no local checkout at all", () => {
    // A pull request stays mergeable after its worktree is removed. It lives
    // on GitHub, so a missing local context is not a reason to refuse.
    const props = panelProps({ context: null, linked: true, pullRequest: pullRequest(), error: "Could not read the local repository." });
    render(<ThreadPullRequestPanel {...props} />);

    expect(screen.getByText("#123")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText(/lives on GitHub, not in this folder/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read the local repository.");

    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    fireEvent.click(screen.getByRole("button", { name: /merge #123/i }));
    expect(props.onMerge).toHaveBeenCalledWith("squash", false);
  });

  it("asks for a thread before offering any of this", () => {
    render(<ThreadPullRequestPanel {...panelProps({ threadId: null })} />);
    expect(screen.getByText(/start a thread to work on a pull request/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create a pull request/i })).not.toBeInTheDocument();
  });

  it("points at settings when there is no repository context at all", () => {
    const props = panelProps({ context: null });
    render(<ThreadPullRequestPanel {...props} />);

    expect(screen.getByText(/cannot read this folder's Git repository/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open github settings/i }));
    expect(props.onOpenGitHubSettings).toHaveBeenCalled();
  });
});

describe("ThreadPullRequestPanel — check states", () => {
  function checksFor(states: string[]) {
    render(<ThreadPullRequestPanel {...panelProps({
      linked: true,
      pullRequest: pullRequest({ checks: states.map((state, index) => ({ name: `check-${index}`, state, url: "" })) }),
    })} />);
    return screen.getByText("Checks").parentElement!;
  }

  it("counts only SUCCESS, NEUTRAL and SKIPPED as passing", () => {
    const row = checksFor(["SUCCESS", "NEUTRAL", "SKIPPED"]);
    expect(row).toHaveTextContent("3 checks passed");
    expect(row.className).toContain("good");
  });

  it("never paints an unrecognised or empty check state green", () => {
    for (const unknown of ["", "SOMETHING_NEW", "stale"]) {
      const { unmount } = render(<ThreadPullRequestPanel {...panelProps({
        linked: true,
        pullRequest: pullRequest({ checks: [{ name: "build", state: "SUCCESS", url: "" }, { name: "odd", state: unknown, url: "" }] }),
      })} />);
      const row = screen.getByText("Checks").parentElement!;
      expect(row).toHaveTextContent("1 of 2 checks did not report a result");
      expect(row.className).not.toContain("good");
      expect(row.className).toContain("wait");
      unmount();
    }
  });

  it("keeps failing ahead of running, and running ahead of unknown", () => {
    expect(checksFor(["FAILURE", "IN_PROGRESS", ""])).toHaveTextContent("1 of 3 checks failing");
  });

  it("explains an unknown check as a reason a merge is not ready", () => {
    render(<ThreadPullRequestPanel {...panelProps({
      linked: true,
      pullRequest: pullRequest({ canMerge: false, reviewDecision: "", checks: [{ name: "odd", state: "MYSTERY", url: "" }] }),
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    expect(screen.getByText(/1 check has not reported a result/i)).toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — merge permission", () => {
  it("refuses outright when the account cannot merge in that repository", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ viewerCanMerge: false }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByText(/cannot merge pull requests in m17h\/Mythra-Code/i)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();
    // A hard blocker must take auto merge with it, not leave a way around.
    expect(within(confirm).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(confirm).queryByRole("radio")).not.toBeInTheDocument();
  });

  it("offers a refresh rather than a guess when permission was never reported", () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ viewerCanMerge: undefined }) });
    render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByText(/permission to merge in m17h\/Mythra-Code has not been confirmed/i)).toBeInTheDocument();
    // Unknown is not "probably fine": the merge waits for a real answer.
    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();

    fireEvent.click(within(confirm).getByRole("button", { name: /refresh/i }));
    expect(props.onRefresh).toHaveBeenCalled();
  });

  it("offers auto merge only where the repository allows it", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ autoMergeAllowed: false }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).queryByRole("checkbox", { name: /merge it when it is ready/i })).not.toBeInTheDocument();
    expect(within(confirm).getByText(/Auto merge is not turned on for this repository/i)).toBeInTheDocument();
  });

  it("says so plainly when auto merge support was never reported", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ autoMergeAllowed: undefined }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).queryByRole("checkbox", { name: /merge it when it is ready/i })).not.toBeInTheDocument();
    expect(within(confirm).getByText(/Auto merge support has not been confirmed yet/i)).toBeInTheDocument();
  });

  it("leaves a not-ready pull request unmergeable when auto merge is unavailable", () => {
    render(<ThreadPullRequestPanel {...panelProps({
      linked: true,
      pullRequest: pullRequest({ canMerge: false, autoMergeAllowed: false, checks: [{ name: "build", state: "IN_PROGRESS", url: "" }] }),
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    expect(screen.getByRole("button", { name: /merge #123/i })).toBeDisabled();
  });

  it("never borrows merge methods from the local repository", () => {
    // The folder allows three; this pull request's own repository allows none.
    render(<ThreadPullRequestPanel {...panelProps({
      linked: true,
      context: context({ mergeMethods: ["squash", "merge", "rebase"] }),
      pullRequest: pullRequest({ mergeMethods: [] }),
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByText(/allows no merge method/i)).toBeInTheDocument();
    expect(within(confirm).queryByRole("radio")).not.toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();
  });
});

describe("ThreadPullRequestPanel — the world moving under an open form", () => {
  it("refuses to create against a revision that was never shown, and keeps the text", () => {
    const props = panelProps({ context: context({ headOid: "aaa1111" }) });
    const view = render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My careful title" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "My careful body" } });

    // A commit lands while the form is open.
    view.rerender(<ThreadPullRequestPanel {...props} context={context({ headOid: "bbb2222" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/has new commits since you opened this form/i);
    expect(screen.getByRole("button", { name: /push and create/i })).toBeDisabled();
    expect(screen.getByLabelText("Title")).toHaveValue("My careful title");
    expect(screen.getByLabelText(/description/i)).toHaveValue("My careful body");

    // Looking at the refreshed details is what re-arms it.
    fireEvent.click(screen.getByRole("button", { name: /use the current details/i }));
    expect(screen.getByRole("button", { name: /push and create/i })).toBeEnabled();
  });

  it("submits the revision it displayed, not the newest one", async () => {
    const props = panelProps({ context: context({ headOid: "aaa1111" }) });
    const view = render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "A change" } });

    // The branch moves, then is reviewed and accepted at its new revision.
    view.rerender(<ThreadPullRequestPanel {...props} context={context({ headOid: "bbb2222" })} />);
    fireEvent.click(screen.getByRole("button", { name: /use the current details/i }));
    fireEvent.click(screen.getByRole("button", { name: /push and create/i }));

    await vi.waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "bbb2222" }));
  });

  it("notices the folder changing branch under an open form", () => {
    const props = panelProps({ context: context({ branch: "codex/one" }) });
    const view = render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));
    view.rerender(<ThreadPullRequestPanel {...props} context={context({ branch: "codex/two" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/moved from codex\/one to codex\/two/i);
    expect(screen.getByRole("button", { name: /push and create/i })).toBeDisabled();
  });

  it("refuses to merge a pull request that moved since the confirmation opened", () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ headOid: "aaa1111" }) });
    const view = render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    view.rerender(<ThreadPullRequestPanel {...props} pullRequest={pullRequest({ headOid: "bbb2222" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/New commits were pushed to this pull request/i);
    expect(screen.getByRole("button", { name: /merge #123/i })).toBeDisabled();
    expect(props.onMerge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /review the updated pull request/i }));
    expect(screen.getByRole("button", { name: /merge #123/i })).toBeEnabled();
  });

  it("refuses when the thread's attached pull request is swapped underneath", () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ number: 123 }) });
    const view = render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    view.rerender(<ThreadPullRequestPanel {...props} pullRequest={pullRequest({ number: 456 })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/changed to m17h\/Mythra-Code #456/i);
    expect(screen.getByRole("button", { name: /merge #456/i })).toBeDisabled();
  });
});

describe("ThreadPullRequestPanel — marking a draft ready", () => {
  const draft = () => pullRequest({ isDraft: true, canMerge: false });

  it("offers nothing when the app cannot do it", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: draft(), onReady: undefined })} />);
    expect(screen.queryByRole("button", { name: /mark ready/i })).not.toBeInTheDocument();
  });

  it("confirms by name, and does not merge anything", async () => {
    const onReady = vi.fn().mockResolvedValue(undefined);
    const props = panelProps({ linked: true, pullRequest: draft(), onReady });
    render(<ThreadPullRequestPanel {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /mark ready…/i }));
    const confirm = screen.getByRole("group", { name: /confirm mark ready for review/i });

    expect(within(confirm).getByText("m17h/Mythra-Code #123")).toBeInTheDocument();
    expect(within(confirm).getByText(/Nothing is merged now/i)).toBeInTheDocument();
    // The merge confirmation must not be open at the same time.
    expect(screen.queryByRole("group", { name: /confirm merge/i })).not.toBeInTheDocument();

    fireEvent.click(within(confirm).getByRole("button", { name: /mark ready for review/i }));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(props.onMerge).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open when GitHub refuses", async () => {
    const onReady = vi.fn().mockRejectedValue(new Error("only the author can do that"));
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: draft(), onReady })} />);

    fireEvent.click(screen.getByRole("button", { name: /mark ready…/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark ready for review/i }));

    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    expect(screen.getByRole("group", { name: /confirm mark ready for review/i })).toBeInTheDocument();
  });

  it("is a mutation, so read only stops it", () => {
    const blocked = "This thread is read only.";
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: draft(), onReady: vi.fn(), mutationBlockedReason: blocked })} />);

    fireEvent.click(screen.getByRole("button", { name: /mark ready…/i }));
    const confirm = screen.getByRole("group", { name: /confirm mark ready for review/i });
    expect(within(confirm).getByText(blocked)).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: /mark ready for review/i })).toBeDisabled();
  });

  it("points a blocked merge at the in-app action instead of the website", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: draft(), onReady: vi.fn() })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    expect(screen.getByText("This pull request is still a draft. Mark it ready for review first.")).toBeInTheDocument();
    expect(screen.queryByText(/draft.*on GitHub first/i)).not.toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — reviewing what goes in", () => {
  const rich = () => context({
    dirty: true,
    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts"],
    changedFileCount: 8,
    commits: ["Add the pull request panel", "Fix the narrow dock"],
  });

  it("leads with counts and keeps the paths behind one toggle", () => {
    render(<ThreadPullRequestPanel {...panelProps({ context: rich() })} />);
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));

    // The counts are what everyone needs; the paths are detail.
    const toggle = screen.getByRole("button", { name: "8 uncommitted files · 2 commits" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: /uncommitted files/i })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const files = screen.getByRole("list", { name: /uncommitted files/i });
    expect(within(files).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByRole("button", { name: /show all 8/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /show all 8/i }));
    expect(within(screen.getByRole("list", { name: /uncommitted files/i })).getAllByRole("listitem")).toHaveLength(8);

    const commits = screen.getByRole("list", { name: /commits on this branch/i });
    expect(within(commits).getAllByRole("listitem")).toHaveLength(2);
  });

  it("fills the title from the first commit, and says where it came from", () => {
    render(<ThreadPullRequestPanel {...panelProps({ context: rich() })} />);
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));

    expect(screen.getByLabelText("Title")).toHaveValue("Add the pull request panel");
    expect(screen.getByText(/From your first commit/i)).toBeInTheDocument();
    // No claim that anything was written for them.
    expect(screen.queryByText(/suggested|generated|written for you/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Mine" } });
    expect(screen.queryByText(/Edit it freely/i)).not.toBeInTheDocument();
  });

  it("falls back to the branch name when there are no commits", () => {
    render(<ThreadPullRequestPanel {...panelProps({ context: context({ commits: [] }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));

    expect(screen.getByLabelText("Title")).toHaveValue("Pr workflow");
    expect(screen.getByText(/From the branch name/i)).toBeInTheDocument();
  });

  it("lets the base branch be changed, and refuses the impossible ones", async () => {
    const props = panelProps();
    render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));

    const base = screen.getByLabelText("Merge into");
    expect(base).toHaveValue("main");

    fireEvent.change(base, { target: { value: "" } });
    expect(screen.getByText("Choose a branch to merge into.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /push and create/i })).toBeDisabled();

    fireEvent.change(base, { target: { value: "codex/pr-workflow" } });
    expect(screen.getByText(/cannot merge a branch into itself/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /push and create/i })).toBeDisabled();

    fireEvent.change(base, { target: { value: "release/2.0" } });
    fireEvent.click(screen.getByRole("button", { name: /push and create/i }));
    await vi.waitFor(() => expect(props.onCreate).toHaveBeenCalled());
    expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ base: "release/2.0", head: "codex/pr-workflow" }));
  });
});

describe("ThreadPullRequestPanel — the merge button cannot outrun what is known", () => {
  it("refuses to merge while merge permission is merely unknown", async () => {
    // Unknown is not "probably yes". Until a refresh turns it into a real
    // answer, every route to a merge stays shut.
    const props = panelProps({ linked: true, pullRequest: pullRequest({ viewerCanMerge: undefined, autoMergeAllowed: true }) });
    render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    const confirm = screen.getByRole("group", { name: /confirm merge/i });

    expect(within(confirm).getByRole("button", { name: /merge #123/i })).toBeDisabled();

    // Not even by way of auto merge.
    fireEvent.click(within(confirm).getByRole("checkbox", { name: /merge it when it is ready/i }));
    expect(within(confirm).getByRole("button", { name: /enable auto merge/i })).toBeDisabled();

    await Promise.resolve();
    expect(props.onMerge).not.toHaveBeenCalled();
  });

  it("merges normally once permission is actually confirmed", async () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ viewerCanMerge: true }) });
    render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    fireEvent.click(screen.getByRole("button", { name: /merge #123/i }));
    await vi.waitFor(() => expect(props.onMerge).toHaveBeenCalledWith("squash", false));
  });

  it("drops a ticked auto merge if the repository stops allowing it", () => {
    // The box was ticked while auto merge was allowed. A refresh says it is
    // not, so the stale tick must not survive as a live instruction.
    const props = panelProps({ linked: true, pullRequest: pullRequest({ autoMergeAllowed: true, canMerge: false }) });
    const view = render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /merge it when it is ready/i }));
    expect(screen.getByRole("button", { name: /enable auto merge/i })).toBeEnabled();

    view.rerender(<ThreadPullRequestPanel {...props} pullRequest={pullRequest({ autoMergeAllowed: false, canMerge: false })} />);

    expect(screen.getByRole("button", { name: /enable auto merge/i })).toBeDisabled();
    expect(screen.getByText(/Auto merge is not turned on for this repository/i)).toBeInTheDocument();
    expect(props.onMerge).not.toHaveBeenCalled();
  });
});

describe("ThreadPullRequestPanel — where a merge actually happens", () => {
  it("says GitHub in the button, and says the folder is untouched before the confirmation", () => {
    // The whole reason this panel was reviewed: "Merge" read as "merge
    // everything, here and there", and nothing on screen said otherwise.
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest() })} />);

    const open = screen.getByRole("button", { name: /merge on github…/i });
    expect(open).toHaveAttribute("title", expect.stringContaining("Your files here do not change"));
    fireEvent.click(open);

    const confirm = screen.getByRole("group", { name: /confirm merge/i });
    const effect = within(confirm).getByText(/Nothing on this Mac changes/);
    expect(effect).toHaveTextContent("codex/pr-workflow");
    expect(effect).toHaveTextContent(/main.*is not updated until you ask for it/);
    expect(within(confirm).getByRole("button", { name: "Merge #123 on GitHub" })).toBeInTheDocument();
  });

  it("says the same thing about a queued auto merge, in the future tense", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ canMerge: false }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /merge it when it is ready/i }));

    expect(screen.getByText(/When GitHub merges it, nothing on this Mac changes/)).toBeInTheDocument();
  });

  it("drops the local-effect line when the merge is refused outright", () => {
    // A refusal is not the moment to explain what a successful merge would
    // not have done.
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest({ isDraft: true }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    expect(screen.queryByText(/Nothing on this Mac changes/)).not.toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — after the merge", () => {
  const merged = () => pullRequest({ state: "MERGED", baseRefName: "main" });

  it("reports the merge as GitHub's, names the branch this folder is still on, and offers the update", async () => {
    const onUpdateLocal = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged(), context: context({ branch: "codex/pr-workflow" }) })}
        onUpdateLocal={onUpdateLocal}
      />,
    );

    const note = screen.getByText(/Merged into/);
    expect(note).toHaveTextContent("on GitHub");
    expect(note).toHaveTextContent("Your files here have not changed");
    expect(note).toHaveTextContent("codex/pr-workflow");

    // No claim about how far behind the local branch is: that would need a
    // fetch and a comparison against the real base ref, and neither happened.
    expect(note).not.toHaveTextContent(/behind/i);

    const update = screen.getByRole("button", { name: "Update local main" });
    expect(update).toHaveAttribute("title", expect.stringContaining("Refused if this folder has uncommitted changes"));
    fireEvent.click(update);
    await vi.waitFor(() => expect(onUpdateLocal).toHaveBeenCalledOnce());
  });

  it("still explains the outcome when the app cannot offer to update anything", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: merged() })} />);

    expect(screen.getByText(/Merged into/)).toHaveTextContent("on GitHub");
    expect(screen.queryByRole("button", { name: /Update local/ })).not.toBeInTheDocument();
  });

  it("shows the update as busy and surfaces why one was refused", () => {
    render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged() })}
        onUpdateLocal={vi.fn().mockResolvedValue(undefined)}
        updateLocalBusy
        updateLocalNotice="Commit or stash your changes in this folder first."
      />,
    );

    expect(screen.getByRole("button", { name: /Updating…/ })).toBeDisabled();
    expect(screen.getByText("Commit or stash your changes in this folder first.")).toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — merging and archiving the thread", () => {
  const archiveBox = () => screen.getByRole("checkbox", { name: /archive this thread once it is merged/i });

  function openMerge(overrides: Partial<PullRequestPanelProps> = {}, extra: Partial<ThreadPullRequestPanelProps> = {}) {
    const onMergeAndArchive = vi.fn().mockResolvedValue(undefined);
    const props: ThreadPullRequestPanelProps = {
      ...panelProps({ linked: true, pullRequest: pullRequest(), ...overrides }),
      onMergeAndArchive,
      ...extra,
    };
    render(<ThreadPullRequestPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    return { props, onMergeAndArchive };
  }

  it("offers nothing to archive when the app cannot archive", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: pullRequest() })} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    expect(screen.queryByRole("checkbox", { name: /archive this thread/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge #123 on GitHub" })).toBeInTheDocument();
  });

  it("archives nothing unless it is asked to, and says where the choice leads", () => {
    const { props, onMergeAndArchive } = openMerge();

    // Offered, plainly, and off. The ordinary merge is what an untouched
    // confirmation does.
    expect(archiveBox()).not.toBeChecked();
    expect(screen.getByText(/It moves to Archived, where you can restore it/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Merge #123 on GitHub" }));
    expect(props.onMerge).toHaveBeenCalledWith("squash", false);
    expect(onMergeAndArchive).not.toHaveBeenCalled();
  });

  it("names both steps, and what stays untouched, before archiving anything", async () => {
    const { props, onMergeAndArchive } = openMerge();
    fireEvent.click(archiveBox());

    const plan = screen.getByLabelText("What merging and archiving will do");
    expect(within(plan).getByText(/Merge/)).toHaveTextContent("on GitHub");
    expect(within(plan).getByText(/Move this thread to/)).toHaveTextContent(/Archived, where you can restore it/);
    // The merge is still GitHub's, and archiving is still not a file operation.
    expect(screen.getByText(/Nothing on this Mac changes/))
      .toHaveTextContent(/does not move, change or delete its folder/);

    const confirm = screen.getByRole("button", { name: "Merge #123 and archive thread" });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(onMergeAndArchive).toHaveBeenCalledWith("squash"));
    // One merge, by one route: the archiving call is the merge.
    expect(props.onMerge).not.toHaveBeenCalled();
  });

  it("never lets an archive ride along with an auto merge", () => {
    const { onMergeAndArchive } = openMerge();
    const auto = screen.getByRole("checkbox", { name: /merge it when it is ready/i });

    fireEvent.click(archiveBox());
    // Auto merge steps aside rather than quietly cancelling the archive.
    expect(auto).toBeDisabled();
    expect(screen.getByText(/archiving needs a merge that happens now/i)).toBeInTheDocument();

    fireEvent.click(archiveBox());
    expect(auto).toBeEnabled();
    fireEvent.click(auto);
    expect(archiveBox()).toBeDisabled();
    expect(screen.getByText(/Not available with auto merge/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enable auto merge/i })).toBeInTheDocument();
    expect(onMergeAndArchive).not.toHaveBeenCalled();
  });

  it("refuses to archive behind a merge GitHub is not ready to run", () => {
    openMerge({ pullRequest: pullRequest({ canMerge: false, checks: [{ name: "build", state: "IN_PROGRESS", url: "" }] }) });

    expect(archiveBox()).toBeDisabled();
    expect(screen.getByText(/Available once GitHub is ready to merge this now/i)).toBeInTheDocument();
  });

  it("stops at a blocked archive while leaving the plain merge alone", () => {
    const { props, onMergeAndArchive } = openMerge({}, { archiveBlockedReason: "This thread is running. Stop it before archiving." });

    expect(archiveBox()).toBeDisabled();
    expect(screen.getByText("This thread is running. Stop it before archiving.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Merge #123 on GitHub" }));
    expect(props.onMerge).toHaveBeenCalledWith("squash", false);
    expect(onMergeAndArchive).not.toHaveBeenCalled();
  });

  it("drops the choice when the pull request moves under the confirmation", () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest({ headOid: "aaa1111" }) });
    const onMergeAndArchive = vi.fn().mockResolvedValue(undefined);
    const view = render(<ThreadPullRequestPanel {...props} onMergeAndArchive={onMergeAndArchive} />);

    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    fireEvent.click(archiveBox());
    expect(screen.getByRole("button", { name: "Merge #123 and archive thread" })).toBeEnabled();

    view.rerender(<ThreadPullRequestPanel {...props} pullRequest={pullRequest({ headOid: "bbb2222" })} onMergeAndArchive={onMergeAndArchive} />);
    expect(screen.getByRole("button", { name: "Merge #123 and archive thread" })).toBeDisabled();

    // Looking at the new revision re-arms the merge, and asks for the archive
    // decision again rather than carrying an old one forward.
    fireEvent.click(screen.getByRole("button", { name: /review the updated pull request/i }));
    expect(archiveBox()).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Merge #123 on GitHub" })).toBeEnabled();
    expect(onMergeAndArchive).not.toHaveBeenCalled();
  });

  it("forgets the choice when the thread changes", () => {
    const props = panelProps({ linked: true, pullRequest: pullRequest() });
    const onMergeAndArchive = vi.fn().mockResolvedValue(undefined);
    const view = render(<ThreadPullRequestPanel {...props} onMergeAndArchive={onMergeAndArchive} />);

    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));
    fireEvent.click(archiveBox());

    view.rerender(<ThreadPullRequestPanel {...props} threadId="thread-2" onMergeAndArchive={onMergeAndArchive} />);
    fireEvent.click(screen.getByRole("button", { name: /merge on github…/i }));

    expect(archiveBox()).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Merge #123 on GitHub" })).toBeInTheDocument();
  });

  it("keeps the confirmation open when the merge-and-archive fails", async () => {
    const onMergeAndArchive = vi.fn().mockRejectedValue(new Error("GitHub refused the merge"));
    openMerge({}, { onMergeAndArchive });

    fireEvent.click(archiveBox());
    fireEvent.click(screen.getByRole("button", { name: "Merge #123 and archive thread" }));

    await vi.waitFor(() => expect(onMergeAndArchive).toHaveBeenCalled());
    expect(screen.getByRole("group", { name: /confirm merge/i })).toBeInTheDocument();
    expect(archiveBox()).toBeChecked();
  });
});

describe("ThreadPullRequestPanel — archiving a thread whose merge already happened", () => {
  const merged = () => pullRequest({ state: "MERGED", baseRefName: "main" });

  it("offers the archive again, which is the retry after one that failed", async () => {
    const onArchiveMergedThread = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged() })}
        onArchiveMergedThread={onArchiveMergedThread}
      />,
    );

    // The merge is GitHub's and stands; only the archive is outstanding.
    expect(screen.getByText(/Merged into/)).toBeInTheDocument();
    const archive = screen.getByRole("button", { name: /archive thread/i });
    expect(archive).toHaveAttribute("title", expect.stringContaining("its folder is left exactly as it is"));

    fireEvent.click(archive);
    await vi.waitFor(() => expect(onArchiveMergedThread).toHaveBeenCalledOnce());
  });

  it("holds the retry back while the thread may not be archived", () => {
    render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged() })}
        onArchiveMergedThread={vi.fn().mockResolvedValue(undefined)}
        archiveBlockedReason="This thread is still running."
      />,
    );

    expect(screen.getByRole("button", { name: /archive thread/i })).toBeDisabled();
    expect(screen.getByText("This thread is still running.")).toBeInTheDocument();
  });

  it("holds it back while another operation is in flight, or nothing may change", () => {
    const busy = render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged(), busy: true })}
        onArchiveMergedThread={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: /archive thread/i })).toBeDisabled();
    busy.unmount();

    render(
      <ThreadPullRequestPanel
        {...panelProps({ linked: true, pullRequest: merged(), mutationBlockedReason: "This thread is read only." })}
        onArchiveMergedThread={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: /archive thread/i })).toBeDisabled();
  });

  it("says nothing about archiving when the app cannot archive", () => {
    render(<ThreadPullRequestPanel {...panelProps({ linked: true, pullRequest: merged() })} />);
    expect(screen.queryByRole("button", { name: /archive thread/i })).not.toBeInTheDocument();
  });
});

describe("ThreadPullRequestPanel — the create editor owns its heading", () => {
  it("replaces the button with the form rather than stacking both", () => {
    render(<ThreadPullRequestPanel {...panelProps()} />);

    fireEvent.click(screen.getByRole("button", { name: /create a pull request/i }));

    expect(screen.queryByRole("button", { name: /^Create a pull request$/i })).not.toBeInTheDocument();
    expect(screen.getByText("New pull request")).toBeInTheDocument();
  });

  it("collapses routine ahead and behind counts into one fact that names its baseline", () => {
    render(<ThreadPullRequestPanel {...panelProps({ context: context({ ahead: 3, behind: 1, dirty: true }) })} />);

    const fact = screen.getByText(/3 ahead · 1 behind of main/);
    expect(fact).toHaveAttribute("title", "Last known, compared with main");
    // The warning keeps its own pill: it is the one that is not routine.
    expect(screen.getByText("Uncommitted changes")).toBeInTheDocument();
  });
});

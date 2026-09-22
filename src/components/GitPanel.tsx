import "./git-workflow.css";
import { memo, useEffect, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  CodeXml,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { AppActionMenu, type AppActionMenuItem } from "./AppActionMenu";
import { AppSelectMenu } from "./AppSelectMenu";
import type { GitHubRepoStatus } from "../lib/github";
// Shapes owned by the Git workspace module. Imported as types only, so this
// panel neither pulls the Tauri bridge into component tests nor breaks before
// that module lands.
import type { GitWorkflowControls } from "../lib/gitWorkspace";

/**
 * What the app knows about the project folder's own Git repository.
 *
 * `unknown` matters: the GitHub repo probe can fail transiently (no network,
 * `gh` missing, a slow mount). Treating that failure as "no repository"
 * disabled every purely local Git action for a project that has one.
 */
export type GitRepositoryState = "ready" | "absent" | "unknown";

export type GitPanelAction =
  | "status" | "diff" | "stage" | "unstage" | "revert"
  | "commit" | "commitStaged" | "commitPush" | "commitStagedPush"
  | "fetch" | "pull" | "push" | "comments" | "ci" | "pr";

export interface GitPanelProps {
  repositoryState: GitRepositoryState;
  repositoryStateDetail?: string;
  gitInitializing: boolean;
  gitOutput: string;
  gitCommitSuccess: string;
  gitCommitBusy: boolean;
  githubAuthenticated: boolean;
  githubRepoStatus: GitHubRepoStatus | null;
  githubRepoError?: string;
  readOnly: boolean;
  defaultRepositoryName: string;
  /**
   * True when the app supplies the per-thread pull request workflow.
   *
   * Only "Draft PR" and "CI checks" retire: the workflow opens pull requests
   * itself and reports check state as real UI, so keeping those would offer
   * two answers to one question. "Review comments" stays — the workflow has no
   * comment viewer, and silently removing the only way to read review
   * comments in the app would be taking a capability away rather than
   * replacing it. Defaults to false so existing callers keep the whole row.
   */
  hasPullRequestWorkflow?: boolean;
  /**
   * The per-thread pull request workflow, rendered *between* the local work
   * and the GitHub section.
   *
   * Order is the point. A pull request is something you reach after committing
   * locally, so putting it first made the panel open on the most remote,
   * least-used step and pushed "commit" below the fold.
   */
  pullRequestPanel?: ReactNode;
  /**
   * Local branch and staging state, branch switching, and the opt-in automatic
   * publishing controls. Optional throughout: without it the panel falls back
   * to exactly the behaviour it had before, driven by `githubRepoStatus`.
   */
  workflow?: GitWorkflowControls;
  onAction: (action: GitPanelAction, commitMessage?: string) => void;
  onInitializeGit: () => void;
  onGitHubAttach: (url: string) => void;
  onGitHubCreate: (name: string, visibility: "private" | "public") => void;
  onOpenGitHubSettings: () => void;
}

const READ_ONLY_REASON = "Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.";

/** "just now" / "4 min ago" / "2 h ago" — never a bare timestamp nobody reads. */
function lastCheckedLabel(at: number | undefined): string | null {
  if (!at) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `checked ${hours} h ago`;
  return `checked ${Math.round(hours / 24)} d ago`;
}

function files(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

function GitPanelInner(props: GitPanelProps) {
  // These fields are local so typing a commit message does not re-render the
  // conversation, the sidebar, and every other Workspace surface.
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteInput, setRemoteInput] = useState("");
  const [repositoryName, setRepositoryName] = useState(props.defaultRepositoryName);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [branchDraft, setBranchDraft] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [showGitHub, setShowGitHub] = useState(false);

  // A confirmed commit consumes the message it was made with.
  const success = props.gitCommitSuccess;
  useEffect(() => {
    if (success) setCommitMessage("");
  }, [success]);

  const absent = props.repositoryState === "absent";
  // Only a *known* missing repository disables local Git. An unreadable
  // repository probe is a failure of the probe, not evidence that the project
  // has no repository, so the actions stay available and report a real error
  // if they turn out to be impossible.
  const localDisabled = props.readOnly || absent;
  const localDisabledReason = props.readOnly
    ? READ_ONLY_REASON
    : "Initialize Git for this project before changing it.";

  const workflow = props.workflow;
  const snapshot = workflow?.snapshot ?? null;
  const workflowBusy = !!workflow?.busy;
  const staged = snapshot?.stagedFiles ?? 0;
  const changed = snapshot?.changedFiles ?? 0;
  const hasStaged = staged > 0;
  const repository = props.githubRepoStatus?.repository;
  const upstream = props.githubRepoStatus?.upstream;
  // Last known, from the snapshot when there is one and from the GitHub probe
  // otherwise. Never invented, and never described as current.
  const branch = snapshot?.branch ?? props.githubRepoStatus?.branch ?? null;
  const freshness = lastCheckedLabel(workflow?.lastFetchedAt);

  const changeBranch = async (name: string, create: boolean) => {
    if (!workflow) return;
    try {
      if (await workflow.onBranch(name, create) === false) return;
      setBranchDraft("");
      setCreatingBranch(false);
    } catch {
      /* The owner reports the failure through `workflow.error`. */
    }
  };

  const branchItems: AppActionMenuItem[] = workflow
    ? [
      ...(snapshot?.branches ?? [])
        .filter((item) => !item.current)
        .map((item) => ({
          id: `branch:${item.name}`,
          label: item.name,
          description: item.worktreePath ? "Checked out in another worktree" : undefined,
          icon: <GitBranch size={13} aria-hidden="true" />,
          disabled: localDisabled || workflowBusy || workflow.isolated || !!item.worktreePath,
          title: workflow.isolated ? "This thread keeps its isolated branch. Use a shared project thread to change branches." : item.worktreePath
            ? `${item.name} is checked out in ${item.worktreePath}. Two checkouts cannot share one branch.`
            : `Switch this folder to ${item.name}`,
          onSelect: () => { void changeBranch(item.name, false); },
        })),
      {
        id: "branch:new",
        label: "New branch…",
        description: workflow.autoPublish?.enabled ? "Branches from the current commit and publishes automatically." : "Branches from the current commit. Nothing is pushed.",
        icon: <GitBranchPlus size={13} aria-hidden="true" />,
        disabled: localDisabled || workflowBusy || workflow.isolated,
        title: localDisabled ? localDisabledReason : workflow.isolated ? "This thread keeps its isolated branch. Use a shared project thread to change branches." : "Create a branch here and switch to it",
        onSelect: () => setCreatingBranch(true),
      },
    ]
    : [];

  const advancedItems: AppActionMenuItem[] = [
    {
      id: "stage",
      label: "Stage all",
      description: "Marks every current change for the next commit.",
      icon: <Plus size={13} aria-hidden="true" />,
      disabled: localDisabled,
      title: localDisabled ? localDisabledReason : "Stage every current change",
      onSelect: () => props.onAction("stage"),
    },
    {
      id: "unstage",
      label: "Unstage all",
      description: "Keeps the edits; removes them from the next commit.",
      icon: <Minus size={13} aria-hidden="true" />,
      disabled: localDisabled || (!!snapshot && !hasStaged),
      title: localDisabled
        ? localDisabledReason
        : !!snapshot && !hasStaged ? "Nothing is staged." : "Unstage everything currently staged",
      onSelect: () => props.onAction("unstage"),
    },
    {
      id: "revert",
      label: "Revert all changes",
      description: "Discards tracked edits. Untracked files are kept.",
      icon: <RotateCcw size={13} aria-hidden="true" />,
      danger: true,
      disabled: localDisabled,
      title: localDisabled ? localDisabledReason : "Discard every tracked staged and working-tree change",
      onSelect: () => props.onAction("revert"),
    },
  ];

  const remoteItems: AppActionMenuItem[] = repository ? [
    {
      id: "fetch",
      label: "Fetch from GitHub",
      description: "Updates what Mythra Code knows. Your files do not change.",
      icon: <RefreshCw size={13} aria-hidden="true" />,
      disabled: props.readOnly,
      title: props.readOnly ? READ_ONLY_REASON : "Fetch from origin",
      onSelect: () => props.onAction("fetch"),
    },
    {
      id: "pull",
      label: "Update this branch from GitHub",
      description: upstream ? "Fast-forward only." : "This branch has no tracked branch yet.",
      icon: <RotateCw size={13} aria-hidden="true" />,
      disabled: props.readOnly || !upstream,
      title: props.readOnly ? READ_ONLY_REASON : upstream ? "Fast-forward this branch from its tracked branch" : "Set a tracked branch first",
      onSelect: () => props.onAction("pull"),
    },
    {
      id: "comments",
      label: "Review comments",
      icon: <CodeXml size={13} aria-hidden="true" />,
      disabled: props.readOnly,
      title: props.readOnly ? READ_ONLY_REASON : "Read this pull request's review comments",
      onSelect: () => props.onAction("comments"),
    },
    ...(props.hasPullRequestWorkflow ? [] : [
      {
        id: "ci",
        label: "CI checks",
        icon: <ShieldCheck size={13} aria-hidden="true" />,
        disabled: props.readOnly,
        title: props.readOnly ? READ_ONLY_REASON : "Read this pull request's checks",
        onSelect: () => props.onAction("ci"),
      },
      {
        id: "pr",
        label: "Draft PR",
        icon: <GitFork size={13} aria-hidden="true" />,
        disabled: props.readOnly,
        title: props.readOnly ? READ_ONLY_REASON : "Open a draft pull request",
        onSelect: () => props.onAction("pr"),
      },
    ]),
  ] : [];

  const autoPublish = workflow?.autoPublish;
  const autoPublishStatus = autoPublish?.status ?? "idle";

  return (
    <>
      {props.readOnly && <div className="history-warning"><ShieldCheck size={13} /> Read only allows Status and Diff. Switch thread access to Ask or Full access before changing Git or contacting GitHub.</div>}
      {absent && (
        <div className="git-initialize-card">
          <span className="github-repo-icon"><GitBranch size={16} /></span>
          <div>
            <strong>This project is not a Git repository yet</strong>
            <small>Create one locally to enable commits, per-file staging, checkpoints, and isolated worktrees. Nothing is pushed anywhere.</small>
          </div>
          <button className="github-secondary-button" onClick={props.onInitializeGit} disabled={props.gitInitializing || props.readOnly} aria-busy={props.gitInitializing} title={props.readOnly ? READ_ONLY_REASON : "Create a local Git repository and initial snapshot"}>
            {props.gitInitializing ? <LoaderCircle className="spin" size={13} /> : <GitBranch size={13} />}
            {props.gitInitializing ? "Preparing…" : "Initialize Git"}
          </button>
        </div>
      )}
      {props.repositoryState === "unknown" && (
        <div className="history-warning">
          <ShieldCheck size={13} /> {props.repositoryStateDetail || "Mythra Code could not read this project's repository status."} Local Git actions stay available; GitHub actions need a working connection.
        </div>
      )}

      {/* ---------------------- this folder, right now ---------------------- */}

      {!absent && (
        <section className="git-local-card" aria-label="Local repository">
          <div className="git-local-head">
            <span className="github-repo-icon"><GitBranch size={16} /></span>
            <div>
              <strong title={branch ?? undefined}>{branch ?? "No branch checked out"}</strong>
              <small>
                {workflow ? (workflow.isolated ? "Isolated worktree" : "Shared project folder") : "Local repository"}
                {snapshot ? ` · ${changed ? files(changed) + " changed" : "no changes"}${hasStaged ? ` · ${staged} staged` : ""}` : ""}
              </small>
            </div>
            {workflow && (
              <AppActionMenu
                label="Branch"
                ariaLabel="Switch or create a branch"
                items={branchItems}
                disabled={workflowBusy}
              />
            )}
          </div>

          {creatingBranch && (
            <div className="git-branch-create">
              <label className="dock-field">
                <span>New branch name</span>
                <input
                  value={branchDraft}
                  onChange={(event) => setBranchDraft(event.target.value)}
                  placeholder="feature/short-description"
                  aria-label="New branch name"
                  spellCheck={false}
                  autoFocus
                />
              </label>
              <div className="studio-actions">
                <button
                  onClick={() => void changeBranch(branchDraft.trim(), true)}
                  disabled={localDisabled || workflowBusy || !branchDraft.trim()}
                  title={localDisabled ? localDisabledReason : "Create this branch and switch to it"}
                ><GitBranchPlus size={13} /> Create branch</button>
                <button onClick={() => { setCreatingBranch(false); setBranchDraft(""); }}>Cancel</button>
              </div>
              <small className="git-fineprint">
                {workflow?.isolated
                  ? "This thread keeps its isolated branch. Use a shared project thread to change branches."
                  : `Every thread using this folder moves to the new branch too. ${autoPublish?.enabled ? "Automatic publishing will publish it to GitHub." : "Nothing is sent to GitHub."}`}
              </small>
            </div>
          )}

          {workflow?.branchNotice && <p className="git-fineprint">{workflow.branchNotice}</p>}
          {workflow?.error && (
            <div className="git-local-note bad" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              <span>{workflow.error}</span>
              <button type="button" className="thread-pr-inline-button" onClick={workflow.onRefresh}>Try again</button>
            </div>
          )}
          {workflow?.notice && !workflow.error && (
            <div className="git-local-note" role="status" aria-live="polite">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>{workflow.notice}</span>
            </div>
          )}
        </section>
      )}

      {/* Inspection stays available even in a folder that is not a repository
          yet: "what does Git think is here?" is exactly the question someone
          asks at that moment, and the answer is a legitimate one. */}
      <div className="studio-actions wrap git-inspect-row">
        <button onClick={() => props.onAction("status")}><RefreshCw size={13} /> Status</button>
        <button onClick={() => props.onAction("diff")}><CodeXml size={13} /> Diff</button>
        <AppActionMenu label="More" ariaLabel="More local Git actions" items={advancedItems} />
      </div>

      {/* --------------------------- commit --------------------------- */}

      <form
        className="git-commit-card"
        onSubmit={(event) => {
          event.preventDefault();
          props.onAction(hasStaged ? "commitStaged" : "commit", commitMessage);
        }}
      >
        <div className="git-commit-heading">
          <span><GitCommitHorizontal size={17} /></span>
          <div>
            <strong>Commit changes locally</strong>
            <small>{hasStaged
              ? `${files(staged)} staged. ${autoPublish?.enabled ? "Saved locally, then pushed by automatic publishing." : "Saved to this repository only — nothing is pushed."}`
              : `Stages all current changes and saves them to this repository. ${autoPublish?.enabled ? "Automatic publishing will push the commit." : "Nothing is pushed."}`}</small>
          </div>
        </div>
        {props.gitCommitSuccess && (
          <div className="git-commit-success" role="status" aria-live="polite">
            <CheckCircle2 size={18} />
            <div><strong>Committed successfully</strong><small>{props.gitCommitSuccess}</small></div>
          </div>
        )}
        <label className="dock-field"><span>Commit message <em>Optional</em></span><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Update project files" /></label>
        {hasStaged ? (
          <>
            <button className="git-commit-button" type="submit" disabled={localDisabled || props.gitCommitBusy} title={localDisabled ? localDisabledReason : `Commit the ${files(staged)} you staged`}>
              {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
              {props.gitCommitBusy ? "Committing…" : `Commit staged (${staged})`}
            </button>
            <button
              type="button"
              className="github-secondary-button git-commit-secondary"
              onClick={() => props.onAction("commit", commitMessage)}
              disabled={localDisabled || props.gitCommitBusy}
              title={localDisabled ? localDisabledReason : "Stage and commit every current change"}
            ><GitCommitHorizontal size={13} /> Commit all changes{changed ? ` (${changed})` : ""}</button>
          </>
        ) : (
          <button className="git-commit-button" type="submit" disabled={localDisabled || props.gitCommitBusy} title={localDisabled ? localDisabledReason : "Stage and commit every current change to the local repository"}>
            {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
            {props.gitCommitBusy ? "Committing…" : "Commit all changes locally"}
          </button>
        )}
        {repository && (
          <button
            type="button"
            className="github-secondary-button git-commit-secondary"
            // The same message the person is looking at. Reading it from the
            // shared field is the whole point: the button used to commit under
            // a default message while their own text sat above it.
            onClick={() => props.onAction(hasStaged ? "commitStagedPush" : "commitPush", commitMessage)}
            disabled={localDisabled || props.gitCommitBusy || !props.githubRepoStatus?.branch}
            title={localDisabled
              ? localDisabledReason
              : !props.githubRepoStatus?.branch
                ? "Check out a named branch before pushing"
                : `Commit${hasStaged ? " the staged files" : " every current change"} and push it to ${repository}`}
          ><Upload size={13} /> Commit &amp; push</button>
        )}
      </form>

      {/* The pull request workflow: after the local work, before GitHub's own
          settings. */}
      {props.pullRequestPanel}

      {/* --------------------------- GitHub --------------------------- */}

      <div className="github-repo-card">
        <span className="github-repo-icon"><GitFork size={16} /></span>
        <div>
          <strong title={repository ?? undefined}>{repository || (props.githubRepoError ? "GitHub status unavailable" : "No GitHub remote configured")}</strong>
          <small>{props.githubRepoError || (repository
            // Counts are the last ones read, against a named baseline. They are
            // not evidence about GitHub *now*, and they do not claim to be.
            ? upstream
              ? `Compared with ${upstream}: ${props.githubRepoStatus?.ahead ?? 0} to push, ${props.githubRepoStatus?.behind ?? 0} to pull${freshness ? ` · ${freshness}` : " · last known"}`
              : `${branch ?? "This branch"} has no tracked branch here yet`
            : props.githubAuthenticated
              ? "This project has no GitHub remote set up in Mythra Code."
              : "Connect GitHub in Settings to publish this project.")}</small>
        </div>
        {!props.githubAuthenticated && <button className="github-secondary-button" onClick={props.onOpenGitHubSettings}>Connect</button>}
        {repository && (
          <button
            className="github-secondary-button"
            onClick={() => props.onAction("push")}
            disabled={props.readOnly || !props.githubRepoStatus?.branch}
            title={props.readOnly
              ? READ_ONLY_REASON
              : !props.githubRepoStatus?.branch ? "Check out a named branch before pushing" : `Push committed changes to ${repository}`}
          ><Upload size={13} /> Push commits</button>
        )}
      </div>

      {repository && remoteItems.length > 0 && (
        <div className="studio-actions wrap">
          <AppActionMenu label="GitHub actions" ariaLabel="More GitHub actions" items={remoteItems} align="start" />
        </div>
      )}

      {/* Publishing this project to GitHub is optional and stays folded away
          until asked for. It is not a step anyone is behind on. */}
      {!repository && props.githubAuthenticated && (
        <div className="github-connect-project">
          {!showGitHub ? (
            <button className="github-secondary-button" onClick={() => setShowGitHub(true)} aria-expanded={false}>
              <CloudUpload size={13} /> Publish this project to GitHub…
            </button>
          ) : (
            <>
              <label className="dock-field"><span>Existing repository URL</span><input value={remoteInput} onChange={(event) => setRemoteInput(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
              <button
                className="github-secondary-button"
                onClick={() => {
                  props.onGitHubAttach(remoteInput.trim());
                  setRemoteInput("");
                }}
                disabled={localDisabled || !remoteInput.trim()}
                title={localDisabled ? localDisabledReason : "Attach this GitHub repository as the origin remote"}
              ><GitFork size={13} /> Attach remote</button>
              <small className="git-fineprint">Attaching only records the address. Nothing is uploaded until you push.</small>
              <div className="github-create-divider"><span>or create one</span></div>
              <div className="github-create-row">
                <input className="github-repo-name-input" value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="repository-name" aria-label="New GitHub repository name" />
                <AppSelectMenu
                  value={visibility}
                  options={[{ value: "private", label: "Private" }, { value: "public", label: "Public" }]}
                  ariaLabel="Repository visibility"
                  portal
                  onChange={(value) => setVisibility(value === "public" ? "public" : "private")}
                />
                <button
                  className="github-create-button"
                  onClick={() => props.onGitHubCreate(repositoryName.trim(), visibility)}
                  disabled={localDisabled || !repositoryName.trim()}
                  title={localDisabled ? localDisabledReason : "Create this repository on GitHub and attach it"}
                ><Plus size={13} /> Create</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ------------------- optional automatic publishing ------------------- */}

      {autoPublish && (repository || autoPublish.enabled) && (
        <section className={`git-auto-publish ${autoPublishStatus}`} aria-label="Automatic publishing">
          <label className="git-auto-publish-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={autoPublish.enabled}
              onChange={(event) => autoPublish.onToggle(event.target.checked)}
              disabled={props.readOnly}
            />
            <span>
              <strong>Automatically publish branches and commits</strong>
              <small>
                Push new branches and commits to {autoPublish.repository || repository}, including
                work from agents, the terminal, and isolated threads. Turning this on also publishes
                branches currently checked out in this project. Uncommitted files stay local.
                Mythra Code watches while open and checks again on restart. It never commits,
                switches branches, pulls, or overwrites remote history for you. A push already running may finish after you turn this off.
              </small>
            </span>
          </label>
          {autoPublish.enabled && (
            <div className="git-auto-publish-status" role="status" aria-live="polite">
              <span className={`git-auto-publish-orb ${autoPublishStatus}`} aria-hidden="true" />
              <span>{autoPublish.message || "Watching this project for new commits."}</span>
              {autoPublishStatus === "waiting" && (
                <button type="button" className="thread-pr-inline-button" onClick={autoPublish.onRetry}>Retry</button>
              )}
              {autoPublishStatus === "paused" && <small>Resolve the issue above, then turn automatic publishing off and on to review the destination again.</small>}
            </div>
          )}
        </section>
      )}

      {/* The console is evidence, not furniture: it appears once there is
          something in it. An empty 210px box was the largest thing in the
          panel and said nothing. */}
      {props.gitOutput && (
        <details className="git-console" open>
          <summary><ChevronRight size={12} aria-hidden="true" /> Git output</summary>
          <pre className="git-screen">{props.gitOutput}</pre>
        </details>
      )}
    </>
  );
}

export const GitPanel = memo(GitPanelInner);

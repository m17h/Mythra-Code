import { memo, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CodeXml,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import type { GitHubRepoStatus } from "../lib/github";

/**
 * What the app knows about the project folder's own Git repository.
 *
 * `unknown` matters: the GitHub repo probe can fail transiently (no network,
 * `gh` missing, a slow mount). Treating that failure as "no repository"
 * disabled every purely local Git action for a project that has one.
 */
export type GitRepositoryState = "ready" | "absent" | "unknown";

export type GitPanelAction =
  | "status" | "diff" | "stage" | "revert" | "commit" | "commitPush"
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
  onAction: (action: GitPanelAction, commitMessage?: string) => void;
  onInitializeGit: () => void;
  onGitHubAttach: (url: string) => void;
  onGitHubCreate: (name: string, visibility: "private" | "public") => void;
  onOpenGitHubSettings: () => void;
}

const READ_ONLY_REASON = "Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.";

function GitPanelInner(props: GitPanelProps) {
  // These fields are local so typing a commit message does not re-render the
  // conversation, the sidebar, and every other Workspace surface.
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteInput, setRemoteInput] = useState("");
  const [repositoryName, setRepositoryName] = useState(props.defaultRepositoryName);
  const [visibility, setVisibility] = useState<"private" | "public">("private");

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
      <div className="github-repo-card">
        <span className="github-repo-icon"><GitFork size={16} /></span>
        <div>
          <strong>{props.githubRepoStatus?.repository || (props.githubRepoError ? "GitHub status unavailable" : "No GitHub repository attached")}</strong>
          <small>{props.githubRepoError || (props.githubRepoStatus?.repository
            ? `${props.githubRepoStatus.branch || "detached"}${props.githubRepoStatus.upstream ? ` · ${props.githubRepoStatus.ahead} ahead · ${props.githubRepoStatus.behind} behind` : " · not pushed yet"}`
            : props.githubAuthenticated ? "Attach an existing repository or create a new one." : "Connect GitHub in Settings to publish this project.")}</small>
        </div>
        {!props.githubAuthenticated && <button className="github-secondary-button" onClick={props.onOpenGitHubSettings}>Connect</button>}
      </div>
      {!props.githubRepoStatus?.repository && props.githubAuthenticated && (
        <div className="github-connect-project">
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
          <div className="github-create-divider"><span>or create one</span></div>
          <div className="github-create-row">
            <input className="github-repo-name-input" value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="repository-name" aria-label="New GitHub repository name" />
            <span className="github-visibility-select">
              <select value={visibility} onChange={(event) => setVisibility(event.target.value as "private" | "public")} aria-label="Repository visibility"><option value="private">Private</option><option value="public">Public</option></select>
              <ChevronDown size={13} aria-hidden="true" />
            </span>
            <button
              className="github-create-button"
              onClick={() => props.onGitHubCreate(repositoryName.trim(), visibility)}
              disabled={localDisabled || !repositoryName.trim()}
              title={localDisabled ? localDisabledReason : "Create this repository on GitHub and attach it"}
            ><Plus size={13} /> Create</button>
          </div>
        </div>
      )}
      <form className="git-commit-card" onSubmit={(event) => { event.preventDefault(); props.onAction("commit", commitMessage); }}>
        <div className="git-commit-heading">
          <span><GitCommitHorizontal size={17} /></span>
          <div><strong>Commit changes locally</strong><small>Stages all current changes and saves them to this repository. Nothing is pushed.</small></div>
        </div>
        {props.gitCommitSuccess && (
          <div className="git-commit-success" role="status" aria-live="polite">
            <CheckCircle2 size={18} />
            <div><strong>Committed successfully</strong><small>{props.gitCommitSuccess}</small></div>
          </div>
        )}
        <label className="dock-field"><span>Commit message <em>Optional</em></span><input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Update project files" /></label>
        <button className="git-commit-button" type="submit" disabled={localDisabled || props.gitCommitBusy} title={localDisabled ? localDisabledReason : "Stage and commit every current change to the local repository"}>
          {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
          {props.gitCommitBusy ? "Committing…" : "Commit all changes locally"}
        </button>
      </form>
      <div className="studio-actions wrap">
        <button onClick={() => props.onAction("status")}><RefreshCw size={13} /> Status</button>
        <button onClick={() => props.onAction("diff")}><CodeXml size={13} /> Diff</button>
        <button onClick={() => props.onAction("stage")} disabled={localDisabled} title={localDisabled ? localDisabledReason : "Stage every current change"}><Plus size={13} /> Stage all</button>
        <button className="danger-action" onClick={() => props.onAction("revert")} aria-label="Revert all Git changes" disabled={localDisabled} title={localDisabled ? localDisabledReason : "Discard every tracked staged and working-tree change"}><RotateCcw size={13} /> Revert all</button>
      </div>
      <pre className="git-screen">{props.gitOutput || "Choose an action to inspect the repository."}</pre>
      <div className="studio-actions wrap">
        <button onClick={() => props.onAction("commitPush")} disabled={localDisabled || props.gitCommitBusy || !props.githubRepoStatus?.repository || !props.githubRepoStatus.branch} title={localDisabled ? localDisabledReason : "Commit every current change and push it to GitHub"}><Upload size={13} /> Commit &amp; push</button>
        <button onClick={() => props.onAction("fetch")} disabled={props.readOnly || !props.githubRepoStatus?.repository} title={props.readOnly ? READ_ONLY_REASON : "Fetch from origin"}><RefreshCw size={13} /> Fetch</button>
        <button onClick={() => props.onAction("pull")} disabled={props.readOnly || !props.githubRepoStatus?.upstream} title={props.readOnly ? READ_ONLY_REASON : "Fast-forward this branch from its upstream"}><RotateCw size={13} /> Pull</button>
        <button onClick={() => props.onAction("push")} disabled={props.readOnly || !props.githubRepoStatus?.repository || !props.githubRepoStatus.branch} title={props.readOnly ? READ_ONLY_REASON : !props.githubRepoStatus?.branch ? "Check out a named branch before pushing" : "Push committed changes to GitHub"}><Upload size={13} /> Push commits</button>
        <button onClick={() => props.onAction("comments")} disabled={props.readOnly || !props.githubRepoStatus?.repository} title={props.readOnly ? READ_ONLY_REASON : "Read this pull request's review comments"}><CodeXml size={13} /> Review comments</button>
        <button onClick={() => props.onAction("ci")} disabled={props.readOnly || !props.githubRepoStatus?.repository} title={props.readOnly ? READ_ONLY_REASON : "Read this pull request's checks"}><ShieldCheck size={13} /> CI checks</button>
        <button onClick={() => props.onAction("pr")} disabled={props.readOnly || !props.githubRepoStatus?.repository} title={props.readOnly ? READ_ONLY_REASON : "Open a draft pull request"}><GitFork size={13} /> Draft PR</button>
      </div>
    </>
  );
}

export const GitPanel = memo(GitPanelInner);

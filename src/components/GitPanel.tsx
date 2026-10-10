import "./git-workflow.css";
import "./thread-pull-requests.css";
import { lazy, memo, Suspense, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  CodeXml,
  FileDiff,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  History,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { AppActionMenu, type AppActionMenuItem } from "./AppActionMenu";
import { AppSelectMenu } from "./AppSelectMenu";
import { GitChangesView, type GitPathAction } from "./GitChangesView";
import { GitHistoryView } from "./GitHistoryView";
import type { GitHubRepoStatus } from "../lib/github";
// Shapes owned by the Git workspace module. Imported as types only, so this
// panel neither pulls the Tauri bridge into component tests nor breaks before
// that module lands.
import type { GitWorkflowControls, GitWorkspaceSnapshot } from "../lib/gitWorkspace";
import type { GitFocusTarget, GitRoute, GitView, ProjectGitInspection, ProjectPullRequestAccess } from "../lib/projectGit";
import type { StudioTab } from "../lib/studioTabs";
import { commitPlan, fileCount, relativeAge, type CommitPlan } from "../lib/gitChanges";
import { useProjectGitChanges } from "../hooks/useProjectGitChanges";
import { useProjectGitHistory } from "../hooks/useProjectGitHistory";

// Pull requests load their own code the first time the view opens.
const ProjectPullRequestsView = lazy(() => import("./ProjectPullRequestsView"));

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

export interface GitPanelDraft {
  commitMessage: string;
  remoteInput: string;
  repositoryName: string;
  visibility: "private" | "public";
}

export interface GitPanelProps {
  repositoryState: GitRepositoryState;
  repositoryStateDetail?: string;
  gitInitializing: boolean;
  gitOutput: string;
  gitCommitSuccess: string;
  gitCommitSuccessRevision?: number;
  gitCommitBusy: boolean;
  githubAuthenticated: boolean;
  githubRepoStatus: GitHubRepoStatus | null;
  githubRepoError?: string;
  githubBusy?: boolean;
  githubOperationError?: string;
  gitOperationBusy?: boolean;
  readOnly: boolean;
  defaultRepositoryName: string;
  selectedFolder?: string;
  /** The dock can retain per-checkout drafts when this tab closes. */
  draft?: GitPanelDraft;
  onDraftChange?: (draft: GitPanelDraft) => void;
  /**
   * True when the app supplies a pull request workflow. Only "Draft PR" and
   * "CI checks" retire then; "Review comments" stays, because nothing else in
   * the app reads review comments. Defaults to false.
   */
  hasPullRequestWorkflow?: boolean;
  /** The selected conversation's pull request workflow, shown in Pull requests. */
  pullRequestPanel?: ReactNode;
  /** Project-owned pull request browsing, details, create and merge. */
  pullRequests?: ProjectPullRequestAccess;
  /** Bounded native Changes and History reads for this checkout. */
  inspection?: ProjectGitInspection;
  /** Per-file stage, unstage and guarded discard, owned by the app. */
  onPathAction?: (action: GitPathAction, path: string) => void;
  /**
   * Local branch and staging state, branch switching, and the opt-in automatic
   * publishing controls. Optional throughout: without it the panel falls back
   * to what `githubRepoStatus` reports.
   */
  workflow?: GitWorkflowControls;
  /** Which Git view is showing; the dock keeps it across tab switches. */
  view?: GitView;
  onViewChange?: (view: GitView) => void;
  /** A pending "go here" request from a shortcut or the command palette. */
  focusRequest?: GitRoute | null;
  onFocusHandled?: (nonce: number) => void;
  onOpenTool?: (tab: StudioTab) => void;
  onAction: (action: GitPanelAction, commitMessage?: string) => void;
  onInitializeGit: () => void;
  onGitHubAttach: (url: string) => void;
  onGitHubCreate: (name: string, visibility: "private" | "public") => void;
  onOpenGitHubSettings: () => void;
}

const READ_ONLY_REASON = "Switch this thread from Read only to Ask or Full access before changing Git or contacting GitHub.";

const VIEWS: Array<{ id: GitView; label: string; icon: typeof FileDiff }> = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "history", label: "History", icon: History },
];

function focusTarget(root: HTMLElement | null, target: GitFocusTarget): HTMLElement | null {
  const node = root?.querySelector<HTMLElement>(`[data-git-focus="${target}"]`);
  if (!node) return null;
  return node.matches("button, input, textarea, [tabindex]") ? node : node.querySelector<HTMLElement>("button, input, textarea");
}

function focusDestination(root: HTMLElement | null, node: HTMLElement) {
  const header = root?.closest(".studio-panel")?.querySelector<HTMLElement>(":scope > .studio-header");
  // Measure in CSS pixels, so the clearance follows the real header's height
  // and UI zoom. The variable and scroll margin stay inside this Git workspace.
  root?.style.setProperty("--git-route-header-height", `${header?.offsetHeight ?? 0}px`);
  node.scrollIntoView?.({ block: "nearest" });
  // Native focus scrolling does not account for a sticky sibling header and
  // must not undo the explicitly cleared destination scroll position.
  node.focus({ preventScroll: true });
}

/**
 * What the commit card can honestly offer. "dirty" also stands for *unknown*:
 * without a successful owner snapshot the ordinary commit buttons stay, since
 * a missing or failed read is never evidence of a clean folder. The snapshot
 * owns button availability: independently loaded file rows can finish after
 * a commit and must not replace the owner's refreshed summary.
 * Once clean, "push" and "synced" come from the snapshot's own tracking
 * counts, else from a GitHub comparison of this very branch; anything less is
 * "push-unknown", which still offers Push.
 */
type CommitReadiness = "dirty" | "detached" | "push" | "push-unknown" | "synced";

function commitReadiness(input: {
  snapshot: GitWorkspaceSnapshot | null;
  workflowReadError?: string;
  repoStatus: GitHubRepoStatus | null;
  repoError?: string;
}): CommitReadiness {
  const { snapshot } = input;
  if (!snapshot || input.workflowReadError) return "dirty";
  if (snapshot.stagedFiles !== 0 || snapshot.unstagedFiles !== 0 || snapshot.changedFiles !== 0) return "dirty";
  if (!snapshot.branch) return "detached";
  // An unborn branch has no commit to push.
  if (!snapshot.headOid) return "synced";
  // Older runtimes leave tracking out of the snapshot entirely.
  if (snapshot.upstream !== undefined || snapshot.ahead !== undefined) {
    if (!snapshot.upstream) return "push";
    if (snapshot.upstreamRemote !== undefined ? snapshot.upstreamRemote !== "origin" : !snapshot.upstream.startsWith("origin/")) return "push-unknown";
    if (typeof snapshot.ahead !== "number") return "push-unknown";
    return snapshot.ahead > 0 ? "push" : "synced";
  }
  const status = input.repoStatus;
  if (input.repoError || !status || status.branch !== snapshot.branch) return "push-unknown";
  if (!status.upstream) return "push";
  if (!status.upstream.startsWith("origin/")) return "push-unknown";
  return status.ahead > 0 ? "push" : "synced";
}

function GitPanelInner(props: GitPanelProps) {
  // These fields are local so typing a commit message does not re-render the
  // conversation, the sidebar, and every other Workspace surface.
  const [localDraft, setLocalDraft] = useState<GitPanelDraft>({ commitMessage: "", remoteInput: "", repositoryName: props.defaultRepositoryName, visibility: "private" });
  const draft = props.draft ?? localDraft;
  const { commitMessage, remoteInput, repositoryName, visibility } = draft;
  const onDraftChange = props.onDraftChange;
  const setDraft = useCallback((next: GitPanelDraft) => {
    setLocalDraft(next);
    onDraftChange?.(next);
  }, [onDraftChange]);
  const updateDraft = (patch: Partial<GitPanelDraft>) => setDraft({ ...draft, ...patch });
  const [branchDraft, setBranchDraft] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [showGitHub, setShowGitHub] = useState(false);
  const [publishAction, setPublishAction] = useState<"attach" | "create" | null>(null);
  const [localView, setLocalView] = useState<GitView>("changes");
  const view = props.view ?? localView;
  const setView = (next: GitView) => { setLocalView(next); props.onViewChange?.(next); };
  const submittedMessage = useRef<{ message: string; previousSuccess: string; previousRevision?: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const routeNoticeRef = useRef<HTMLParagraphElement>(null);
  const handledFocusNonce = useRef<number | null>(null);
  const [routeNotice, setRouteNotice] = useState<{ nonce: number; text: string } | null>(null);
  const tabsId = useId();
  const syncId = useId();

  // A confirmed commit consumes the message it was made with.
  const success = props.gitCommitSuccess;
  useEffect(() => {
    const submitted = submittedMessage.current;
    if (!submitted) return;
    if (!success) { submitted.previousSuccess = ""; return; }
    // A rejected attempt can rerender its owner while an older success stays
    // visible. Only a new confirmation may consume this submission's draft.
    const confirmed = props.gitCommitSuccessRevision === undefined
      ? success !== submitted.previousSuccess
      : props.gitCommitSuccessRevision > (submitted.previousRevision ?? 0);
    if (props.gitCommitBusy || !confirmed) return;
    submittedMessage.current = null;
    if (draft.commitMessage === submitted.message) setDraft({ ...draft, commitMessage: "" });
  }, [success, props.gitCommitSuccessRevision, props.gitCommitBusy, draft, setDraft]);

  const absent = props.repositoryState === "absent";
  const workflow = props.workflow;
  const workspaceError = workflow?.readError || workflow?.error;
  const snapshot = workflow?.snapshot ?? null;
  const outsideRepositoryRoot = snapshot?.isRoot === false;
  const rootRequiredReason = `Open the repository root (${snapshot?.rootPath}) as your project before changing Git. This selected folder is inside that repository.`;
  // Only a *known* missing repository disables local Git. An unreadable
  // repository probe is a failure of the probe, not evidence that the project
  // has no repository, so the actions stay available and report a real error
  // if they turn out to be impossible.
  const localDisabled = props.readOnly || absent || outsideRepositoryRoot;
  const localDisabledReason = props.readOnly
    ? READ_ONLY_REASON
    : outsideRepositoryRoot ? rootRequiredReason : "Initialize Git for this project before changing it.";

  const workflowBusy = !!workflow?.busy;
  const mutationBusy = workflowBusy || props.gitCommitBusy || !!props.gitOperationBusy || !!props.githubBusy || props.gitInitializing;
  const mutationDisabled = localDisabled || mutationBusy;
  const mutationDisabledReason = localDisabled ? localDisabledReason : "Wait for the current Git operation to finish.";
  const repository = props.githubRepoStatus?.repository;
  // Last known, from the snapshot when there is one and from the GitHub probe
  // otherwise. Never invented, and never described as current.
  const branch = snapshot ? snapshot.branch : props.githubRepoStatus?.branch ?? null;
  const matchingStatus = !props.githubRepoError && props.githubRepoStatus?.branch === branch ? props.githubRepoStatus : null;
  const upstream = snapshot?.upstream !== undefined ? snapshot.upstream : matchingStatus?.upstream;
  const upstreamRemote = snapshot?.upstreamRemote !== undefined ? snapshot.upstreamRemote : upstream?.startsWith("origin/") ? "origin" : null;
  const ahead = snapshot?.ahead !== undefined ? snapshot.ahead : matchingStatus?.ahead ?? null;
  const behind = snapshot?.behind !== undefined ? snapshot.behind : matchingStatus?.behind ?? null;
  const fetched = relativeAge(workflow?.lastFetchedAt);
  const autoPublish = workflow?.autoPublish;
  // "origin" is enough when the tracked branch has this branch's own name;
  // a differently named upstream is spelled out in full.
  const upstreamLabel = upstream && branch && upstream.endsWith(`/${branch}`) ? upstream.slice(0, -branch.length - 1) : upstream;

  // Changes follow the owner's snapshot and settle after every operation, so
  // they are re-read when something happened — not on a timer of their own.
  const changesRevision = [workflow?.readRevision, snapshot?.headOid, snapshot?.branch, snapshot?.stagedFiles, snapshot?.unstagedFiles, snapshot?.changedFiles, snapshot?.stagedPaths?.join("\0"), props.gitCommitSuccessRevision, props.gitCommitSuccess].join("|");
  const changes = useProjectGitChanges(absent ? undefined : props.inspection, view === "changes" && !mutationBusy, changesRevision,
    workflow && (workflow.readRevision !== undefined || snapshot?.changes !== undefined || snapshot?.changesError !== undefined) ? workflow : undefined);
  const history = useProjectGitHistory(absent ? undefined : props.inspection, view === "history");
  const plan = commitPlan(changes.changes, snapshot);
  const staged = snapshot?.stagedFiles ?? plan.staged;
  const changed = plan.all;
  const readiness = commitReadiness({
    snapshot,
    workflowReadError: workflow?.readError,
    repoStatus: props.githubRepoStatus,
    repoError: props.githubRepoError,
  });
  const nothingToCommit = readiness !== "dirty";
  // A settled clean snapshot outranks staged rows the older list still shows.
  const hasStaged = !nothingToCommit && staged > 0;
  const nothingToPush = !!snapshot && !workflow?.readError && (!snapshot.headOid || (!!upstream && upstreamRemote === "origin" && ahead === 0));

  // Route requests move focus only. A palette entry named "Push" lands on the
  // Push button; it never presses it.
  const focusRequest = props.focusRequest;
  const onFocusHandled = props.onFocusHandled;
  const checkoutScope = props.inspection?.cwd || props.selectedFolder || snapshot?.rootPath || "";
  const routeStateRef = useRef({ repository, localDisabled, mutationBusy, mutationDisabledReason, repositoryState: props.repositoryState, repoKnown: Boolean(props.githubRepoStatus), repoError: props.githubRepoError });
  routeStateRef.current = { repository, localDisabled, mutationBusy, mutationDisabledReason, repositoryState: props.repositoryState, repoKnown: Boolean(props.githubRepoStatus), repoError: props.githubRepoError };
  useEffect(() => { setRouteNotice(null); }, [checkoutScope]);
  useEffect(() => {
    setCreatingBranch(false);
    setBranchDraft("");
  }, [checkoutScope, workflow?.isolated]);
  useEffect(() => {
    if (!focusRequest || handledFocusNonce.current === focusRequest.nonce) return;
    setRouteNotice(null);
    if (focusRequest.view !== view) setView(focusRequest.view);
    const target = focusRequest.focus;
    let frames = 0;
    let noticeFrames = 0;
    let handle = 0;
    let fallbackText: string | null = null;
    const finish = () => {
      handledFocusNonce.current = focusRequest.nonce;
      onFocusHandled?.(focusRequest.nonce);
    };
    const fallback = (text: string) => {
      fallbackText = text;
      setRouteNotice({ nonce: focusRequest.nonce, text });
      handle = requestAnimationFrame(attempt);
    };
    const focusView = () => {
      const tab = rootRef.current?.querySelector<HTMLButtonElement>(`[data-git-view="${focusRequest.view}"]`);
      if (tab) focusDestination(rootRef.current, tab);
    };
    const attempt = () => {
      if (fallbackText) {
        const notice = routeNoticeRef.current;
        if (notice?.dataset.gitRouteNonce === String(focusRequest.nonce)) {
          focusDestination(rootRef.current, notice);
          finish();
        } else if ((noticeFrames += 1) < 40) handle = requestAnimationFrame(attempt);
        else {
          focusView();
          finish();
        }
        return;
      }
      if (!target) {
        focusView();
        finish();
        return;
      }
      const current = routeStateRef.current;
      const node = focusTarget(rootRef.current, target);
      if (node) {
        if (node.matches(":disabled, [aria-disabled=\"true\"]")) {
          fallback(current.localDisabled || current.mutationBusy ? current.mutationDisabledReason : target === "pull"
            ? "Pull needs a tracked branch first. Push this branch to set one, or switch to a branch that already tracks the remote."
            : node.title || "This Git action is unavailable in the current checkout.");
          return;
        }
        focusDestination(rootRef.current, node);
        finish();
        return;
      }
      if ((target === "push" || target === "pull" || target === "fetch") && !current.repository) {
        // A null probe during initial mount is not proof of an absent remote.
        // Keep this bounded, but let deferred owner reads add the real target.
        if (!current.repoKnown && !current.repoError && current.repositoryState !== "absent" && (frames += 1) < 40) {
          handle = requestAnimationFrame(attempt);
          return;
        }
        fallback(current.repoError
          ? "GitHub connection status is unavailable. Try again after the connection recovers, or check the connection above."
          : current.repoKnown || current.repositoryState === "absent"
            ? `Connect a GitHub repository before ${target === "push" ? "pushing commits" : target === "pull" ? "pulling changes" : "fetching remote status"}. Use Connect a GitHub repository above.`
            : "GitHub connection status is unavailable. Try again after status is read, or check the connection above.");
        return;
      }
      if ((frames += 1) < 40) handle = requestAnimationFrame(attempt);
      else fallback("This Git control is unavailable here. Check the current checkout and GitHub connection, or choose another Git view.");
    };
    handle = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(handle);
    // The request's nonce identifies it; view changes it causes must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  const commit = (action: "commit" | "commitStaged" | "commitPush" | "commitStagedPush") => {
    if (mutationDisabled) return;
    submittedMessage.current = { message: commitMessage, previousSuccess: props.gitCommitSuccess, previousRevision: props.gitCommitSuccessRevision };
    props.onAction(action, commitMessage);
  };

  const changeBranch = async (name: string, create: boolean) => {
    if (!workflow || mutationDisabled || workflow.isolated) return;
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
          disabled: mutationDisabled || workflow.isolated || !!item.worktreePath,
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
        disabled: mutationDisabled || workflow.isolated,
        title: localDisabled ? localDisabledReason : workflow.isolated ? "This thread keeps its isolated branch. Use a shared project thread to change branches." : "Create a branch here and switch to it",
        onSelect: () => setCreatingBranch(true),
      },
    ]
    : [];

  const localItems: AppActionMenuItem[] = [
    {
      id: "stage",
      label: "Stage all",
      description: "Marks every current change for the next commit.",
      icon: <Plus size={13} aria-hidden="true" />,
      disabled: mutationDisabled,
      title: mutationDisabled ? mutationDisabledReason : "Stage every current change",
      onSelect: () => props.onAction("stage"),
    },
    {
      id: "unstage",
      label: "Unstage all",
      description: "Keeps the edits; removes them from the next commit.",
      icon: <Minus size={13} aria-hidden="true" />,
      disabled: mutationDisabled || (!!snapshot && !hasStaged),
      title: mutationDisabled
        ? mutationDisabledReason
        : !!snapshot && !hasStaged ? "Nothing is staged." : "Unstage everything currently staged",
      onSelect: () => props.onAction("unstage"),
    },
    {
      id: "revert",
      label: "Revert all changes…",
      description: "Restores committed files and unstages everything. Added and new files are kept. Asks first.",
      icon: <RotateCcw size={13} aria-hidden="true" />,
      danger: true,
      disabled: mutationDisabled,
      title: mutationDisabled ? mutationDisabledReason : "Restore committed files; keep added, renamed-destination and untracked file contents",
      onSelect: () => props.onAction("revert"),
    },
    // Raw Git output stays one step away for anyone who wants Git's own words.
    {
      id: "status",
      label: "Show git status output",
      description: "Read-only. Prints Git's own summary below.",
      icon: <RefreshCw size={13} aria-hidden="true" />,
      onSelect: () => props.onAction("status"),
    },
    {
      id: "diff",
      label: "Show full diff output",
      description: "Read-only. Every tracked change against the last commit.",
      icon: <CodeXml size={13} aria-hidden="true" />,
      onSelect: () => props.onAction("diff"),
    },
  ];

  const remoteItems: AppActionMenuItem[] = repository ? [
    {
      id: "comments",
      label: "Review comments",
      description: "Prints this branch's pull request comments below.",
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
        disabled: mutationDisabled,
        title: mutationDisabled ? mutationDisabledReason : "Open a draft pull request",
        onSelect: () => props.onAction("pr"),
      },
    ]),
  ] : [];

  const syncText = props.githubRepoError || (repository
    // Counts are the last ones read, against a named baseline. They are not
    // evidence about GitHub *now*, and they do not claim to be.
    ? upstream
      ? ahead !== null && behind !== null
        ? `Compared with ${upstreamLabel}: ${ahead} to push, ${behind} to pull · ${fetched ? `fetched ${fetched}` : "last known · not fetched this session"}`
        : `Tracking ${upstreamLabel}; push and pull counts are unavailable. Refresh to check again.`
      : `${branch ?? "This branch"} has no tracked branch here yet. Pushing sets one.`
    : props.githubAuthenticated
      ? "This project has no GitHub remote set up in Mythra Code."
      : "Attach an existing repository, or connect your GitHub account to create one.");

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = VIEWS.findIndex((entry) => entry.id === view);
    const next = event.key === "ArrowRight" ? (index + 1) % VIEWS.length
      : event.key === "ArrowLeft" ? (index - 1 + VIEWS.length) % VIEWS.length
        : event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setView(VIEWS[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-git-view="${VIEWS[next].id}"]`)?.focus();
  };

  const commitCard = (
    <form
      className="git-commit-card"
      aria-busy={props.gitCommitBusy}
      onSubmit={(event) => {
        event.preventDefault();
        // Enter in the message field must not attempt an empty commit.
        if (nothingToCommit) return;
        commit(hasStaged ? "commitStaged" : "commit");
      }}
    >
      <div className="git-commit-heading">
        <span><GitCommitHorizontal size={17} /></span>
        <div>
          <strong>Commit changes locally</strong>
          <small>{nothingToCommit
            ? `The working folder matches the last commit.${repository && (readiness === "push" || readiness === "push-unknown") ? " Saved commits can still be pushed." : ""}`
            : hasStaged
              ? `${fileCount(staged)} staged${plan.heldBack ? `; newer edits to ${plan.heldBack} of them stay out` : ""}. ${autoPublish?.enabled ? "Saved locally, then pushed by automatic publishing." : "Saved to this repository only — nothing is pushed."}`
              : `Stages all current changes and saves them to this repository. ${autoPublish?.enabled ? "Automatic publishing will push the commit." : "Nothing is pushed."}`}</small>
        </div>
      </div>
      {props.gitCommitSuccess && (
        <div className="git-commit-success" role="status" aria-live="polite">
          <CheckCircle2 size={18} />
          <div><strong>Committed successfully</strong><small>{props.gitCommitSuccess}</small></div>
        </div>
      )}
      <label className="dock-field"><span>Commit message <em>Optional</em></span><input value={commitMessage} onChange={(event) => updateDraft({ commitMessage: event.target.value })} placeholder="Update project files" data-git-focus="commit" /></label>
      {hasStaged ? (
        <>
          <button className="git-commit-button" type="submit" disabled={mutationDisabled} title={mutationDisabled ? mutationDisabledReason : `Commit the ${fileCount(staged)} you staged`}>
            {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
            {props.gitCommitBusy ? "Committing…" : `Commit staged (${staged})`}
          </button>
          <button
            type="button"
            className="github-secondary-button git-commit-secondary"
            onClick={() => commit("commit")}
            disabled={mutationDisabled}
            title={mutationDisabled ? mutationDisabledReason : "Stage and commit every current change"}
          ><GitCommitHorizontal size={13} /> Commit all changes{changed ? ` (${changed})` : ""}</button>
        </>
      ) : nothingToCommit ? (
        <button className="git-commit-button git-commit-empty" type="submit" disabled title={mutationDisabled ? mutationDisabledReason : "Nothing to commit: no staged, unstaged or new files."}>
          {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
          {props.gitCommitBusy ? "Committing…" : "Nothing to commit"}
        </button>
      ) : (
        <button className="git-commit-button" type="submit" disabled={mutationDisabled} title={mutationDisabled ? mutationDisabledReason : "Stage and commit every current change to the local repository"}>
          {props.gitCommitBusy ? <LoaderCircle className="spin" size={16} /> : <GitCommitHorizontal size={16} />}
          {props.gitCommitBusy ? "Committing…" : "Commit all changes locally"}
        </button>
      )}
      {repository && nothingToCommit && (
        readiness === "synced" ? (
          <button
            type="button"
            className="github-secondary-button git-commit-secondary git-commit-empty"
            disabled
            title={mutationDisabled ? mutationDisabledReason : `Nothing to commit, and ${branch} has no commits waiting to push.`}
          ><Upload size={13} /> Nothing to commit and push</button>
        ) : (
          <button
            type="button"
            className="github-secondary-button git-commit-secondary"
            // Pushes existing commits only: no commit, and the message stays.
            onClick={() => { if (!mutationDisabled && branch) props.onAction("push"); }}
            disabled={mutationDisabled || readiness === "detached"}
            title={mutationDisabled
              ? mutationDisabledReason
              : readiness === "detached"
                ? "Check out a named branch before pushing"
                : readiness === "push" && !upstream
                  ? `Push ${branch} to ${repository} and track it there. Nothing new is committed.`
                  : `Push saved commits on ${branch} to ${repository}. Nothing new is committed.`}
          ><Upload size={13} /> Push</button>
        )
      )}
      {repository && !nothingToCommit && (
        <button
          type="button"
          className="github-secondary-button git-commit-secondary"
          // The same message the person is looking at: the button once
          // committed under a default message while their text sat above it.
          onClick={() => commit(hasStaged ? "commitStagedPush" : "commitPush")}
          disabled={mutationDisabled || !branch}
          title={mutationDisabled
            ? mutationDisabledReason
            : !branch
              ? "Check out a named branch before pushing"
              : `Commit${hasStaged ? " the staged files" : " every current change"} and push it to ${repository}`}
        ><Upload size={13} /> Commit &amp; push</button>
      )}
      {!nothingToCommit && <CommitIncludes plan={plan} />}
    </form>
  );

  return (
    <div className="git-workspace" ref={rootRef}>
      {props.readOnly && <div className="history-warning"><ShieldCheck size={13} /> Read only: you can inspect changes, history and pull requests. Switch thread access to Ask or Full access before changing Git or contacting GitHub.</div>}
      {outsideRepositoryRoot && <div className="git-local-note bad" role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{rootRequiredReason}</span></div>}
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

      {/* ------------------- which checkout, and where it stands ------------------- */}

      {!absent && (
        <section className="git-checkout" aria-label="Checkout">
          <div className="git-checkout-repo">
            <GitFork size={13} aria-hidden="true" />
            <strong title={repository ?? undefined}>{repository || (props.githubRepoError ? "GitHub status unavailable" : "No GitHub remote configured")}</strong>
            <span className={`git-folder-chip${workflow?.isolated ? " isolated" : ""}`}>
              {workflow ? (workflow.isolated ? "Isolated worktree" : "Shared project folder") : "Local repository"}
            </span>
            {remoteItems.length > 0 && <AppActionMenu compact ariaLabel="More GitHub actions" items={remoteItems} />}
          </div>
          <div className="git-checkout-branch" data-git-focus="branch">
            {workflow ? (
              <AppActionMenu
                className="git-branch-menu"
                label={branch ?? "No branch checked out"}
                icon={<GitBranch size={13} aria-hidden="true" />}
                ariaLabel="Switch or create a branch"
                items={branchItems}
                disabled={mutationBusy}
                align="start"
              />
            ) : (
              <span className="git-branch-static" title={branch ?? undefined}><GitBranch size={13} aria-hidden="true" /><span>{branch ?? "No branch checked out"}</span></span>
            )}
            {repository && upstream && ahead !== null && behind !== null && (
              <span className="git-sync-counts" title={`Compared with ${upstream}`}>
                <span className={ahead ? "active" : ""} aria-label={`${ahead} to push`}><Upload size={11} aria-hidden="true" />{ahead}</span>
                <span className={behind ? "active" : ""} aria-label={`${behind} to pull`}><ArrowDownToLine size={11} aria-hidden="true" />{behind}</span>
              </span>
            )}
          </div>
          <p className="git-sync-line" id={syncId} title={upstream ? `Tracking ${upstream}` : undefined}>{syncText}</p>

          {repository && (
            <div className="git-remote-actions" role="group" aria-label="Remote actions">
              <button
                type="button"
                data-git-focus="fetch"
                onClick={() => props.onAction("fetch")}
                disabled={mutationDisabled}
                title={mutationDisabled ? mutationDisabledReason : "Download what changed on GitHub. Your files and branches do not change."}
              ><RefreshCw size={13} aria-hidden="true" /> Fetch</button>
              <button
                type="button"
                data-git-focus="pull"
                onClick={() => props.onAction("pull")}
                disabled={mutationDisabled || !upstream}
                aria-describedby={syncId}
                title={mutationDisabled ? mutationDisabledReason : upstream ? `Fast-forward ${branch ?? "this branch"} from ${upstream}. Never merges or rewrites.` : "Set a tracked branch first"}
              ><ArrowDownToLine size={13} aria-hidden="true" /> Pull</button>
              <button
                type="button"
                data-git-focus="push"
                aria-label="Push commits"
                aria-describedby={syncId}
                onClick={() => props.onAction("push")}
                disabled={mutationDisabled || !branch || nothingToPush}
                title={mutationDisabled
                  ? mutationDisabledReason
                  : !branch ? "Check out a named branch before pushing" : nothingToPush ? "No saved commits are waiting to push." : `Push committed changes on ${branch} to ${repository}`}
              ><Upload size={13} aria-hidden="true" /> Push{upstream && ahead !== null && ahead > 0 ? <b>{ahead}</b> : null}</button>
              {!props.githubAuthenticated && <button type="button" onClick={props.onOpenGitHubSettings}>Connect account</button>}
            </div>
          )}
          {repository && !upstream && branch && <p className="git-fineprint">Fetch updates what is known; Pull only fast-forwards; Push uploads committed work. None of them commits for you.</p>}
          {/* Commit, connect and initialize show their own progress. */}
          {(workflowBusy || props.gitOperationBusy) && (
            <p className="git-fineprint" role="status"><LoaderCircle className="spin" size={11} aria-hidden="true" /> Waiting for the current Git operation to finish…</p>
          )}

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
                  disabled={mutationDisabled || !!workflow?.isolated || !branchDraft.trim()}
                  title={localDisabled ? localDisabledReason : workflow?.isolated
                    ? "This thread keeps its isolated branch. Use a shared project thread to change branches."
                    : "Create this branch and switch to it"}
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
          {workspaceError && (
            <div className="git-local-note bad" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              <span>{workspaceError}</span>
              <button type="button" className="thread-pr-inline-button" onClick={workflow.onRefresh}>Try again</button>
            </div>
          )}
          {workflow?.notice && !workspaceError && (
            <div className="git-local-note" role="status" aria-live="polite">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>{workflow.notice}</span>
            </div>
          )}

          {autoPublish && (repository || autoPublish.enabled) && (
            <AutoPublishControl
              autoPublish={autoPublish}
              repository={autoPublish.repository || repository || "GitHub"}
              disabled={props.readOnly || (outsideRepositoryRoot && !autoPublish.enabled)}
              disabledReason={props.readOnly ? READ_ONLY_REASON : outsideRepositoryRoot && !autoPublish.enabled ? rootRequiredReason : undefined}
            />
          )}
        </section>
      )}

      {/* Publishing this project to GitHub is optional and stays folded away
          until asked for. It is not a step anyone is behind on. */}
      {!repository && (
        <div className="github-connect-project">
          {!showGitHub ? (
            <button className="github-secondary-button" onClick={() => setShowGitHub(true)} aria-expanded={false}>
              <CloudUpload size={13} /> Connect a GitHub repository…
            </button>
          ) : (
            <>
              <form className="git-connect-form" aria-label="Attach an existing GitHub repository" aria-busy={!!props.githubBusy} onSubmit={(event) => {
                event.preventDefault();
                if (mutationDisabled || !remoteInput.trim()) return;
                setPublishAction("attach");
                props.onGitHubAttach(remoteInput.trim());
              }}>
                <label className="dock-field"><span>Existing repository URL</span><input value={remoteInput} onChange={(event) => updateDraft({ remoteInput: event.target.value })} placeholder="https://github.com/owner/repository.git" spellCheck={false} disabled={!!props.githubBusy} autoFocus /></label>
                <button
                  type="submit"
                  className="github-secondary-button"
                  disabled={mutationDisabled || !remoteInput.trim()}
                  title={mutationDisabled ? mutationDisabledReason : "Attach this GitHub repository as the origin remote"}
                >{props.githubBusy && publishAction === "attach" ? <LoaderCircle className="spin" size={13} /> : <GitFork size={13} />} {props.githubBusy && publishAction === "attach" ? "Attaching…" : "Attach remote"}</button>
              </form>
              <small className="git-fineprint">Attaching only records the address. Nothing is uploaded until you push.</small>
              <div className="github-create-divider"><span>or create one</span></div>
              {props.githubAuthenticated ? <form className="git-connect-form" aria-label="Create a GitHub repository" aria-busy={!!props.githubBusy} onSubmit={(event) => {
                event.preventDefault();
                if (mutationDisabled || !props.githubAuthenticated || !repositoryName.trim()) return;
                setPublishAction("create");
                props.onGitHubCreate(repositoryName.trim(), visibility);
              }}>
                <fieldset className="github-create-row" disabled={mutationDisabled}>
                  <label className="dock-field github-name-field"><span>New repository name</span><input className="github-repo-name-input" value={repositoryName} onChange={(event) => updateDraft({ repositoryName: event.target.value })} placeholder="repository-name" aria-label="New GitHub repository name" spellCheck={false} /></label>
                  <div className="dock-field github-visibility-field">
                    <span>Visibility</span>
                    <AppSelectMenu
                      value={visibility}
                      options={[{ value: "private", label: "Private" }, { value: "public", label: "Public" }]}
                      ariaLabel="Repository visibility"
                      portal
                      onChange={(value) => updateDraft({ visibility: value === "public" ? "public" : "private" })}
                    />
                  </div>
                  <button
                    type="submit"
                    className="github-create-button"
                    disabled={mutationDisabled || !repositoryName.trim()}
                    title={mutationDisabled ? mutationDisabledReason : "Create this repository on GitHub and attach it"}
                  >{props.githubBusy && publishAction === "create" ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} {props.githubBusy && publishAction === "create" ? "Creating…" : "Create"}</button>
                </fieldset>
                <small className="git-fineprint">Creates an empty repository and attaches it. Your files stay local until you push.</small>
              </form> : <div className="git-connect-form">
                <small className="git-fineprint">Connect your GitHub account in Settings to create a repository.</small>
                <button type="button" className="github-secondary-button" onClick={props.onOpenGitHubSettings}>Connect GitHub account</button>
              </div>}
              {props.githubBusy && <div className="git-local-note" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" /><span>Connecting this project to GitHub…</span></div>}
              {props.githubOperationError && <div className="git-local-note bad" role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{props.githubOperationError}</span></div>}
            </>
          )}
        </div>
      )}

      {/* ------------------------------- views ------------------------------- */}

      {routeNotice && <p className="git-blocked-reason git-route-notice" role="status" tabIndex={-1} ref={routeNoticeRef} data-git-route-nonce={routeNotice.nonce}>{routeNotice.text}</p>}
      <div className="git-view-tabs" role="tablist" aria-label="Git views" onKeyDown={onTabKeyDown}>
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${tabsId}-${id}`}
            data-git-view={id}
            aria-selected={view === id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={view === id ? 0 : -1}
            className={view === id ? "active" : ""}
            onClick={() => setView(id)}
          >
            <Icon size={13} aria-hidden="true" />
            <span>{label}</span>
            {id === "changes" && changed > 0 && <b aria-label={`${changed} changed`}>{changed}</b>}
          </button>
        ))}
      </div>
      <div className="git-view-panel" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${view}`} key={view}>
        {view === "changes" && (
          <GitChangesView
            changes={changes}
            snapshot={snapshot}
            absent={absent}
            mutationDisabled={mutationDisabled}
            mutationDisabledReason={mutationDisabledReason}
            onPathAction={props.onPathAction}
            onStageAll={() => props.onAction("stage")}
            onUnstageAll={() => props.onAction("unstage")}
            moreItems={localItems}
            commit={commitCard}
          />
        )}
        {view === "pulls" && (
          <Suspense fallback={<p className="git-changes-empty" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Loading pull requests…</p>}>
            <ProjectPullRequestsView
              access={props.pullRequests}
              visible
              checkout={snapshot ?? (workflow && !workspaceError ? null : undefined)}
              conversationPanel={props.pullRequestPanel}
              onOpenGitHubSettings={props.onOpenGitHubSettings}
              onConnectRepository={() => setShowGitHub(true)}
            />
          </Suspense>
        )}
        {view === "history" && (
          <GitHistoryView history={history} branch={branch} currentHeadOid={snapshot?.headOid ?? null} currentHeadKnown={snapshot !== null} absent={absent} onOpenTool={props.onOpenTool} />
        )}
      </div>

      {/* The console is evidence, not furniture: it appears once there is
          something in it. */}
      {props.gitOutput && (
        <details className="git-console" open>
          <summary><ChevronRight size={12} aria-hidden="true" /> Git output</summary>
          <pre className="git-screen">{props.gitOutput}</pre>
        </details>
      )}
    </div>
  );
}

/** Exactly which files each commit button records, on request. */
function CommitIncludes({ plan }: { plan: CommitPlan }) {
  if (!plan.exact || (!plan.staged && !plan.all)) return null;
  const limit = 40;
  const list = (paths: string[]) => (
    <ul>
      {paths.slice(0, limit).map((path) => <li key={path} title={path}>{path}</li>)}
      {paths.length > limit && <li className="more">and {paths.length - limit} more</li>}
    </ul>
  );
  return (
    <details className="git-commit-includes">
      <summary><ChevronRight size={11} aria-hidden="true" /> What each commit includes</summary>
      {plan.staged > 0 && (
        <div>
          <strong>Commit staged · {fileCount(plan.staged)}</strong>
          <small>{plan.heldBack ? `Newer unstaged edits to ${plan.heldBack} of these stay out.` : "Only the staged versions shown under Staged."}</small>
          {list(plan.stagedPaths)}
        </div>
      )}
      <div>
        <strong>Commit all changes · {fileCount(plan.all)}</strong>
        <small>Stages everything first: {plan.staged} staged, {plan.unstaged} not staged, {plan.untracked} new.</small>
        {list(plan.allPaths)}
      </div>
    </details>
  );
}

/**
 * Automatic publishing as a status row. Its full consequences are one click
 * away while it is off, and always shown — with an explicit confirmation —
 * before it can be turned on.
 */
function AutoPublishControl({ autoPublish, repository, disabled, disabledReason }: {
  autoPublish: NonNullable<GitWorkflowControls["autoPublish"]>;
  repository: string;
  disabled: boolean;
  disabledReason?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const explanationId = useId();
  const status = autoPublish.status ?? "idle";
  const enabled = autoPublish.enabled;
  const showDetail = expanded || confirming;
  return (
    <section className={`git-auto-publish ${enabled ? status : "off"}`} aria-label="Automatic publishing">
      <div className="git-auto-publish-row">
        <label className="git-auto-publish-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            aria-describedby={explanationId}
            onChange={(event) => {
              if (event.target.checked && !enabled) { setConfirming(true); return; }
              setConfirming(false);
              autoPublish.onToggle(event.target.checked);
            }}
            disabled={disabled}
            title={disabledReason}
          />
          <span>
            <strong>Automatically publish branches and commits</strong>
            <small>{enabled ? `On for ${repository}` : "Off — nothing is pushed unless you push"}</small>
          </span>
        </label>
        {!confirming && (
          <button type="button" className="thread-pr-inline-button" aria-expanded={expanded} aria-controls={explanationId} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide details" : "What it does"}
          </button>
        )}
      </div>
      <small className="git-auto-publish-detail" id={explanationId} hidden={!showDetail}>
        Push new branches and commits to {repository}, including
        work from agents, the terminal, and isolated threads. Turning this on also publishes
        branches currently checked out in this project. Uncommitted files stay local.
        Mythra Code watches while open and checks again on restart. It never commits,
        switches branches, pulls, or overwrites remote history for you. A push already running may finish after you turn this off.
      </small>
      {confirming && (
        <div className="git-auto-publish-confirm" role="group" aria-label="Confirm automatic publishing">
          <button type="button" className="github-create-button" onClick={() => { setConfirming(false); autoPublish.onToggle(true); }} disabled={disabled}>
            <CloudUpload size={13} aria-hidden="true" /> Turn on and publish
          </button>
          <button type="button" className="github-secondary-button" onClick={() => setConfirming(false)}>Keep it off</button>
        </div>
      )}
      {enabled && (
        <div className="git-auto-publish-status" role="status" aria-live="polite">
          <span className={`git-auto-publish-orb ${status}`} aria-hidden="true" />
          <span>{autoPublish.message || "Watching this project for new commits."}</span>
          {status === "waiting" && (
            <button type="button" className="thread-pr-inline-button" onClick={autoPublish.onRetry}>Retry</button>
          )}
          {status === "paused" && <small>Resolve the issue above, then turn automatic publishing off and on to review the destination again.</small>}
        </div>
      )}
    </section>
  );
}

export const GitPanel = memo(GitPanelInner);

import "./git-workflow.css";
import "./thread-pull-requests.css";
import { lazy, memo, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  Info,
  ListTree,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import { createPortal } from "react-dom";
import { AppActionMenu, type AppActionMenuItem } from "./AppActionMenu";
import { AppSelectMenu } from "./AppSelectMenu";
import { FriendlyGitError, GitChangesView, type GitPathAction } from "./GitChangesView";
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
import { getCommitMessageContext, type CommitMessageContext, type CommitMessageSuggestion } from "../lib/commitMessages";

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
  commitMessageEdited?: boolean;
  commitMessageSuggestionId?: string;
  commitMessageToken?: string;
  commitScope?: "staged" | "all";
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
  /** Replaces the thread-permission wording where something else makes this read only. */
  readOnlyReason?: string;
  defaultRepositoryName: string;
  selectedFolder?: string;
  /** The dock can retain per-checkout drafts when this tab closes. */
  draft?: GitPanelDraft;
  onDraftChange?: (draft: GitPanelDraft) => void;
  commitSuggestion?: CommitMessageSuggestion;
  onRegenerateCommitMessage?: () => void;
  commitSuggestionBusy?: boolean;
  /** Where the suggestion's freshness comes from when the folder is on another machine. */
  readCommitContext?: () => Promise<Pick<CommitMessageContext, "stagedToken" | "changesToken">>;
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
  /**
   * Which part of Git this instance shows. "changes" is the Tools panel dock's
   * Changes tab: the commit box and the changed files (as a list, or as the
   * full diff when `diffView` is given). "repository" is its Git tab: the
   * checkout (branch, fetch, pull, push), pull requests and history.
   * Omitted, the panel shows everything behind its own view switcher.
   */
  surface?: "changes" | "repository";
  /** Changes surface only: the full diff review shown under "Diff". */
  diffView?: ReactNode;
  /**
   * Changes surface only: the diff review, given the file selected in Files so
   * both views stay on the same file. Wins over `diffView`.
   */
  renderDiff?: (context: {
    selectedPath: string | null;
    onSelectPath: (path: string | null) => void;
    /** Paths with uncommitted edits right now (the Files list), once read. */
    livePaths: ReadonlySet<string> | null;
  }) => ReactNode;
  /** Changes surface only: a line above the commit bar when the diff shows something other than what Commit records. */
  commitContextNote?: ReactNode;
  /**
   * Changes surface only: the Diff shows a read-only comparison (since last
   * push), not the uncommitted set. While it does, the footer offers no commit
   * and the "…" menu no bulk Git changes, so nothing acts on a different set
   * from the one listed; one action switches to Uncommitted instead.
   */
  comparison?: { onSwitch: () => void };
  /**
   * Changes surface only: the Diff can show the staged version alone. When a
   * staged commit would record something other than the full diff, the
   * commit bar says so and links here (Sol R5 B01).
   */
  stagedReview?: { active: boolean; onChange: (on: boolean) => void };
  /** Changes surface only: the diff couldn't be read, so Commit steps back behind the recovery path. */
  diffUnavailable?: boolean;
  /** Changes surface only: a line above the commit bar (an unsent review note in wide review). */
  footerNote?: ReactNode;
  /** Changes surface only: commands placed first in the "…" menu (AI review, wrap long lines). */
  extraMenuItems?: AppActionMenuItem[];
  /** Changes surface only: how many files the Diff view lists, shown on its toggle. */
  diffCount?: number;
  /** Changes surface only: extra commands for the toolbar row (Run checks). */
  toolbarExtra?: ReactNode;
  /** Changes surface only: reports each settled read of the file list. */
  onChangesLoaded?: (state: { loadedAt: number | null; loading: boolean }) => void;
  /** Changes surface only: where the "More Git actions" menu goes (the panel header), instead of the toolbar. */
  moreMenuHost?: HTMLElement | null;
  /** Changes surface only: select this file (from the transcript), once per nonce. */
  selectRequest?: { path: string; nonce: number } | null;
  /** Changes surface only: list or full diff; the dock keeps it across tab switches. */
  changesMode?: "list" | "diff";
  onChangesModeChange?: (mode: "list" | "diff") => void;
  /** Changes surface only: the dock header already offers Refresh. */
  hideChangesRefresh?: boolean;
  /** Changes surface only: +added −removed lines per repository path, when a diff against HEAD is loaded. */
  lineCounts?: ReadonlyMap<string, { additions: number; deletions: number }>;
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

const THREAD_READ_ONLY_REASON = "Switch this thread from Read only to Ask to act or Full access before changing Git or contacting GitHub.";

const VIEWS: Array<{ id: GitView; label: string; icon: typeof FileDiff }> = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest },
  { id: "history", label: "History", icon: History },
];
/** The dock's Git tab: Changes has a tab of its own there. */
const REPOSITORY_VIEWS = VIEWS.filter((entry) => entry.id !== "changes");

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
  const READ_ONLY_REASON = props.readOnlyReason ?? THREAD_READ_ONLY_REASON;
  // These fields are local so typing a commit message does not re-render the
  // conversation, the sidebar, and every other Tools surface.
  const [localDraft, setLocalDraft] = useState<GitPanelDraft>({ commitMessage: "", remoteInput: "", repositoryName: props.defaultRepositoryName, visibility: "private" });
  const draft = props.draft ?? localDraft;
  const { commitMessage, remoteInput, repositoryName, visibility } = draft;
  const onDraftChange = props.onDraftChange;
  const setDraft = useCallback((next: GitPanelDraft) => {
    setLocalDraft(next);
    onDraftChange?.(next);
  }, [onDraftChange]);
  const updateDraft = (patch: Partial<GitPanelDraft>) => setDraft({ ...draft, ...patch });
  const messageRef = useRef<HTMLTextAreaElement>(null);
  // In the Changes tab the commit bar rests as one line (message + button) and
  // opens into the full editor while the message field has focus.
  const [commitEditing, setCommitEditing] = useState(false);
  const commitCollapsedRef = useRef(false);
  const [preparingCommit, setPreparingCommit] = useState(false);
  const preparingCommitRef = useRef(false);
  const [commitDraftNotice, setCommitDraftNotice] = useState("");
  const currentCommitContext = { folder: props.selectedFolder, draft, branch: props.workflow?.snapshot?.branch, head: props.workflow?.snapshot?.headOid,
    blocked: props.readOnly || props.gitCommitBusy || props.gitOperationBusy || props.githubBusy || props.gitInitializing || props.workflow?.busy };
  const commitContextRef = useRef(currentCommitContext);
  commitContextRef.current = currentCommitContext;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const surface = props.surface;
  const [localView, setLocalView] = useState<GitView>(surface === "repository" ? "history" : "changes");
  const requestedView = props.view ?? localView;
  // Each surface shows only its own views.
  const view: GitView = surface === "changes" ? "changes"
    : surface === "repository" && requestedView === "changes" ? "history" : requestedView;
  const views = surface === "repository" ? REPOSITORY_VIEWS : VIEWS;
  const [localChangesMode, setLocalChangesMode] = useState<"list" | "diff">("list");
  const hasDiffView = Boolean(props.renderDiff || props.diffView);
  const changesMode = hasDiffView ? props.changesMode ?? localChangesMode : "list";
  const setChangesMode = (mode: "list" | "diff") => { setLocalChangesMode(mode); props.onChangesModeChange?.(mode); };
  // Grow with the message up to the CSS cap, then scroll. Width changes only
  // matter for wrapping, so the observer ignores the height this sets.
  const resizeMessage = useCallback(() => {
    const node = messageRef.current;
    if (!node) return;
    if (commitCollapsedRef.current) { node.style.height = ""; return; }
    node.style.height = "auto";
    node.style.height = `${Math.min(220, Math.max(54, node.scrollHeight + node.offsetHeight - node.clientHeight))}px`;
  }, []);
  useLayoutEffect(resizeMessage, [commitMessage, resizeMessage, commitEditing]);
  useLayoutEffect(() => {
    const node = messageRef.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      resizeMessage();
    });
    observer.observe(node);
    resizeMessage();
    return () => observer.disconnect();
  }, [view, props.repositoryState, resizeMessage]);
  const [branchDraft, setBranchDraft] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [showGitHub, setShowGitHub] = useState(false);
  const [publishAction, setPublishAction] = useState<"attach" | "create" | null>(null);
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
    if (draft.commitMessage === submitted.message) setDraft({ ...draft, commitMessage: "", commitMessageEdited: false, commitMessageSuggestionId: undefined, commitMessageToken: undefined, commitScope: undefined });
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
  const commitProgress = preparingCommit || props.gitCommitBusy || !!props.gitOperationBusy;
  const mutationBusy = preparingCommit || workflowBusy || props.gitCommitBusy || !!props.gitOperationBusy || !!props.githubBusy || props.gitInitializing;
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
  const onChangesLoaded = props.onChangesLoaded;
  useEffect(() => {
    if (surface === "changes") onChangesLoaded?.({ loadedAt: changes.loadedAt, loading: changes.loading });
  }, [changes.loadedAt, changes.loading, onChangesLoaded, surface]);
  // Selecting a file by path (Diff, or a file named in the transcript) picks
  // the row Files shows for it: the newest edits first, then staged, then new.
  const changeRows = changes.changes?.rows;
  const changesSelect = changes.select;
  const selectPath = useCallback((path: string | null) => {
    if (!path) { changesSelect(null); return; }
    const rows = (changeRows ?? []).filter((row) => row.path === path);
    const row = rows.find((entry) => entry.area === "unstaged") ?? rows.find((entry) => entry.area === "staged") ?? rows[0];
    changesSelect(row ? { path: row.path, area: row.area } : null);
  }, [changeRows, changesSelect]);
  const [requestedPath, setRequestedPath] = useState<string | null>(null);
  const handledSelectNonce = useRef(0);
  const selectRequest = props.selectRequest;
  useEffect(() => {
    if (!selectRequest || selectRequest.nonce <= handledSelectNonce.current || !changeRows) return;
    handledSelectNonce.current = selectRequest.nonce;
    // A path the list doesn't hold (only in the push comparison, or no longer
    // changed) can still open in Diff. The explicit request always wins over
    // whatever was selected before, so Diff never falls back to an older file.
    if (changeRows.some((row) => row.path === selectRequest.path)) { setRequestedPath(null); selectPath(selectRequest.path); }
    else { changesSelect(null); setRequestedPath(selectRequest.path); }
    window.requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(".git-change-row.selected")?.scrollIntoView?.({ block: "nearest" });
    });
  }, [changeRows, changesSelect, selectPath, selectRequest]);
  const diffSelectedPath = requestedPath ?? changes.selected?.path ?? null;
  const livePaths = useMemo(() => changeRows ? new Set(changeRows.map((row) => row.path)) : null, [changeRows]);
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
  const commitStaged = hasStaged && draft.commitScope !== "all";
  const suggestedMessage = commitStaged ? props.commitSuggestion?.stagedMessage : props.commitSuggestion?.message;
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
    // A surface only switches between its own views; the checkout and the
    // commit box are always visible on theirs.
    if (focusRequest.view !== view && surface !== "changes" && !(surface === "repository" && focusRequest.view === "changes")) setView(focusRequest.view);
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

  const commit = async (action: "commit" | "commitStaged" | "commitPush" | "commitStagedPush") => {
    if (mutationDisabled || preparingCommitRef.current) return;
    const stagedOnly = action === "commitStaged" || action === "commitStagedPush";
    const captured = commitContextRef.current;
    const suggestion = props.commitSuggestion;
    let message = commitMessage;
    if (!draft.commitMessageEdited && draft.commitMessageSuggestionId) {
      if (!suggestion || !props.selectedFolder && !props.readCommitContext) return;
      preparingCommitRef.current = true;
      setPreparingCommit(true);
      setCommitDraftNotice("");
      try {
        const context = await (props.readCommitContext?.() ?? getCommitMessageContext(props.selectedFolder!));
        const latest = commitContextRef.current;
        if (!mountedRef.current || latest.blocked || latest.folder !== captured.folder || latest.branch !== captured.branch
          || latest.head !== captured.head || latest.draft !== captured.draft) return;
        const expected = stagedOnly ? suggestion.context.stagedToken : suggestion.context.changesToken;
        if ((stagedOnly ? context.stagedToken : context.changesToken) !== expected) {
          setCommitDraftNotice("The changes have moved on since this suggestion. Regenerate it or edit the message before committing.");
          return;
        }
        // Commit exactly the draft the user reviewed, even while a newer
        // suggestion is waiting for React to apply it to the field.
        const expectedMessage = stagedOnly ? suggestion.stagedMessage ?? "" : suggestion.message;
        if (message !== expectedMessage || draft.commitMessageToken !== expected) {
          setCommitDraftNotice("The suggestion is updating. Review the message and try again.");
          return;
        }
        if (!message) {
          setCommitDraftNotice("There is no suggestion for these staged changes. Regenerate it or write a message.");
          return;
        }
      } catch {
        setCommitDraftNotice("Could not confirm the changes for this suggestion. Try again or edit the message yourself.");
        return;
      } finally {
        preparingCommitRef.current = false;
        setPreparingCommit(false);
      }
    }
    submittedMessage.current = { message, previousSuccess: props.gitCommitSuccess, previousRevision: props.gitCommitSuccessRevision };
    props.onAction(action, message);
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

  // One line per item; the one destructive command sits last, apart.
  const localItems: AppActionMenuItem[] = [
    {
      id: "stage",
      label: "Stage all",
      icon: <Plus size={13} aria-hidden="true" />,
      disabled: mutationDisabled,
      title: mutationDisabled ? mutationDisabledReason : "Mark every current change for the next commit",
      onSelect: () => props.onAction("stage"),
    },
    {
      id: "unstage",
      label: "Unstage all",
      icon: <Minus size={13} aria-hidden="true" />,
      disabled: mutationDisabled || (!!snapshot && !hasStaged),
      title: mutationDisabled
        ? mutationDisabledReason
        : !!snapshot && !hasStaged ? "Nothing is staged." : "Keep the edits, but take them out of the next commit",
      onSelect: () => props.onAction("unstage"),
    },
    // Raw Git output stays one step away for anyone who wants Git's own words.
    {
      id: "status",
      label: "Show Git status output",
      icon: <RefreshCw size={13} aria-hidden="true" />,
      title: "Read-only. Prints Git's own summary below.",
      onSelect: () => props.onAction("status"),
    },
    {
      id: "diff",
      label: "Show full diff output",
      icon: <CodeXml size={13} aria-hidden="true" />,
      title: "Read-only. Every tracked change against the last commit.",
      onSelect: () => props.onAction("diff"),
    },
    {
      id: "revert",
      label: "Revert all changes…",
      icon: <RotateCcw size={13} aria-hidden="true" />,
      danger: true,
      disabled: mutationDisabled,
      title: mutationDisabled ? mutationDisabledReason : "Restore committed files and unstage everything. Added and new files are kept. Asks first.",
      onSelect: () => props.onAction("revert"),
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
        ? `Tracking ${upstreamLabel} · ${fetched ? `fetched ${fetched}` : "not fetched yet this session"}`
        : `Tracking ${upstreamLabel}; push and pull counts are unavailable. Refresh to check again.`
      : `${branch ?? "This branch"} isn't on ${repository} yet. Pushing publishes it.`
    : props.githubAuthenticated
      ? "This project has no GitHub remote set up in Mythra Code."
      : "Attach an existing repository, or connect your GitHub account to create one.");
  // Opus R6 D12: the everyday case fits one line at the default dock width
  // ("Shared folder · origin · not fetched"); the full sentence stays in the
  // tooltip and for assistive tech.
  const syncShort = !props.githubRepoError && repository && upstream && ahead !== null && behind !== null
    ? `${upstreamLabel} · ${fetched ? `fetched ${fetched}` : "not fetched"}`
    : null;

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = views.findIndex((entry) => entry.id === view);
    const next = event.key === "ArrowRight" ? (index + 1) % views.length
      : event.key === "ArrowLeft" ? (index - 1 + views.length) % views.length
        : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setView(views[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-git-view="${views[next].id}"]`)?.focus();
  };

  const pushReady = !!repository && (readiness === "push" || readiness === "push-unknown");
  // The label names exactly what the button records: the staged files, or
  // every uncommitted file (the Files list, and the default Diff scope).
  const commitLabel = commitStaged ? `Commit ${staged} staged` : changed ? `Commit all ${fileCount(changed)}` : "Commit";
  const commitTitle = mutationDisabled
    ? mutationDisabledReason
    : commitStaged
      ? `Commit the ${fileCount(staged)} you staged${plan.heldBack ? `; newer edits to ${plan.heldBack} of them stay out` : ""}. ${autoPublish?.enabled ? "Automatic publishing pushes it." : "Nothing is pushed."}`
      : `Stage and commit every current change to this repository. ${autoPublish?.enabled ? "Automatic publishing pushes it." : "Nothing is pushed."}`;
  const commitMenuItems: AppActionMenuItem[] = repository ? [{
    id: "commit-push",
    label: commitStaged ? "Commit staged & push" : "Commit & push",
    icon: <Upload size={13} aria-hidden="true" />,
    disabled: mutationDisabled || !branch,
    // The same message the person is looking at: the button once
    // committed under a default message while their text sat above it.
    title: mutationDisabled
      ? mutationDisabledReason
      : !branch
        ? "Check out a named branch before pushing"
        : `Commit${commitStaged ? " the staged files" : " every current change"} and push it to ${repository}`,
    onSelect: () => void commit(commitStaged ? "commitStagedPush" : "commitPush"),
  }] : [];
  const generateLabel = props.commitSuggestion ? "Write a new message" : "Generate message";
  const commitSuccessNote = props.gitCommitSuccess ? (
    <div className="git-commit-success" role="status" aria-live="polite">
      <CheckCircle2 size={14} aria-hidden="true" />
      <div><strong>Committed</strong><small>{props.gitCommitSuccess}</small></div>
    </div>
  ) : null;

  // Review first, commit last: in the Changes tab the bar is the panel's
  // footer, the same place for one file or a hundred. At rest it is one line
  // (message and button); it opens into the full editor while the message
  // field has focus, or while something needs reading (a notice, progress).
  const commitCollapsed = surface === "changes" && !commitEditing && !commitProgress && !commitDraftNotice;
  // A staged commit records less than (or something other than) the full
  // diff whenever other files changed too or a staged file has newer edits.
  // Say what it records, one click from seeing exactly that.
  const stagedDiverges = commitStaged && (plan.heldBack > 0 || changed > staged);
  const stagedReview = props.stagedReview;
  const commitTargetNote = surface === "changes" && stagedReview && !commitProgress && (stagedDiverges || stagedReview.active) ? (
    <p className="git-commit-target">
      <span>{stagedReview.active && !commitStaged
        // Sol R6 B01: never let the patch and the commit target disagree
        // silently. Choosing All changes leaves the staged view (below);
        // if the view is staged anyway, say what Commit includes.
        ? `Viewing staged only · Commit includes all ${fileCount(changed)}.`
        : stagedReview.active
          ? `Showing the staged version: what Commit ${staged} staged records.`
          : `Commit records the staged version of ${fileCount(staged)}${plan.heldBack ? `; newer edits to ${plan.heldBack} stay out` : ""}${changed > staged ? `, not the other ${fileCount(changed - staged)}` : ""}.`}</span>
      <button type="button" onClick={() => { stagedReview.onChange(!stagedReview.active); }}>{stagedReview.active ? (commitStaged ? "Show all changes" : "Review all changes") : "Review staged"}</button>
    </p>
  ) : null;
  commitCollapsedRef.current = commitCollapsed;
  const commitCard = nothingToCommit && !commitProgress ? null : (
    <form
      className={`git-commit-card git-commit-bar${commitCollapsed ? " collapsed" : ""}${surface === "changes" && props.diffUnavailable && changesMode === "diff" ? " diff-unavailable" : ""}`}
      aria-label="Commit"
      aria-busy={commitProgress}
      onFocus={(event) => { if ((event.target as Element) === messageRef.current) setCommitEditing(true); }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        // Menus that render outside the form (More ways to commit) keep it open.
        if (next && (event.currentTarget.contains(next) || (next instanceof Element && next.closest(".app-action-list")))) return;
        setCommitEditing(false);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        // Enter in the message field must not attempt an empty commit.
        if (nothingToCommit) return;
        void commit(commitStaged ? "commitStaged" : "commit");
      }}
    >
      {props.commitContextNote && <p className="git-commit-context">{props.commitContextNote}</p>}
      {/* Sol R6 M01: Commit still works when the diff can't be read (the Git
          snapshot is valid), so the footer says how to review first. */}
      {surface === "changes" && props.diffUnavailable && changesMode === "diff" && !commitProgress && !nothingToCommit && <p className="git-commit-target">
        <span>Full diff unavailable · review the changed files before committing.</span>
        <button type="button" onClick={() => setChangesMode("list")}>Show changed files</button>
      </p>}
      {commitTargetNote}
      {hasStaged && !commitCollapsed && <div className="git-commit-scope" role="group" aria-label="Changes to commit">
        <button type="button" aria-pressed={commitStaged} disabled={mutationBusy} onClick={() => updateDraft({ commitScope: "staged" })}>Staged ({staged})</button>
        <button type="button" aria-pressed={!commitStaged} disabled={mutationBusy} onClick={() => {
          updateDraft({ commitScope: "all" });
          // Sol R6 B01: committing everything while the staged-only patch is
          // on screen would contradict what's shown, so the review follows
          // the commit target. The draft and focus stay where they are.
          if (stagedReview?.active) stagedReview.onChange(false);
        }}>All changes{changed ? ` (${changed})` : ""}</button>
      </div>}
      <div className={`git-commit-field${draft.commitMessageSuggestionId && !draft.commitMessageEdited ? " suggested" : ""}`}>
        <textarea ref={messageRef} className="git-commit-message" rows={commitCollapsed ? 1 : 2} wrap={commitCollapsed ? "off" : "soft"} maxLength={8000} value={commitMessage} readOnly={commitProgress} aria-label="Commit message" onChange={(event) => {
          setCommitDraftNotice("");
          updateDraft({ commitMessage: event.target.value, commitMessageEdited: true });
        }} onKeyDown={(event) => {
          // Enter adds a body line; the modifier keeps the old keyboard commit.
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }} placeholder={commitCollapsed ? "Commit message" : "Commit message (optional)"} data-git-focus="commit" />
        {!commitCollapsed && (props.onRegenerateCommitMessage || (suggestedMessage && draft.commitMessageEdited) || (draft.commitMessageSuggestionId && !draft.commitMessageEdited)) && <div className="git-commit-field-actions">
          {draft.commitMessageSuggestionId && !draft.commitMessageEdited && <span className="git-commit-suggested">Suggested</span>}
          {suggestedMessage && draft.commitMessageEdited && <button type="button" className="git-commit-field-button" disabled={mutationBusy} onClick={() => {
            const suggestion = props.commitSuggestion!;
            updateDraft({ commitMessage: suggestedMessage, commitMessageEdited: false, commitMessageSuggestionId: suggestion.id, commitMessageToken: commitStaged ? suggestion.context.stagedToken : suggestion.context.changesToken });
            setCommitDraftNotice("");
          }}>Use suggestion</button>}
          {props.onRegenerateCommitMessage && <button
            type="button"
            className="git-commit-field-button"
            disabled={mutationBusy || props.commitSuggestionBusy}
            onClick={props.onRegenerateCommitMessage}
            title={props.commitSuggestionBusy ? "The agent is busy. Generate a message when it finishes." : "Ask the agent to write a message for these changes"}
          ><Sparkles size={12} aria-hidden="true" /> {generateLabel}</button>}
        </div>}
      </div>
      {commitDraftNotice && <p className="git-local-note bad" role="status">{commitDraftNotice}</p>}
      <div className="git-commit-actions">
        {commitProgress ? (
          <button className="git-commit-button" type="button" disabled>
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
            {props.gitCommitBusy ? "Committing…" : "Working…"}
          </button>
        ) : (
          <button className="git-commit-button" type="submit" disabled={mutationDisabled} title={commitTitle} aria-keyshortcuts="Meta+Enter Control+Enter">
            <GitCommitHorizontal size={14} aria-hidden="true" />
            {commitLabel}
          </button>
        )}
        {commitMenuItems.length > 0 && !commitProgress && (
          <AppActionMenu className="git-commit-more" label="" ariaLabel="More ways to commit" items={commitMenuItems} disabled={mutationDisabled} />
        )}
      </div>
      {!commitProgress && !commitCollapsed && <CommitIncludes plan={plan} />}
      {!commitProgress && autoPublish?.enabled && (
        <p className="git-commit-publish"><Upload size={11} aria-hidden="true" /> Publishing is on: the commit is also pushed to {autoPublish.repository || repository || "GitHub"}.</p>
      )}
    </form>
  );

  /** A clean folder that still has saved commits to push offers just that. */
  const cleanPush = nothingToCommit && !commitProgress && pushReady ? (
    <div className="git-clean-push">
      <span>{ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} not pushed yet` : "Saved commits may not be pushed yet"}</span>
      <button
        type="button"
        className="github-secondary-button"
        // Pushes existing commits only: no commit, and the message stays.
        onClick={() => { if (!mutationDisabled && branch) props.onAction("push"); }}
        disabled={mutationDisabled}
        title={mutationDisabled
          ? mutationDisabledReason
          : readiness === "push" && !upstream
            ? `Push ${branch} to ${repository} and track it there. Nothing new is committed.`
            : `Push saved commits on ${branch} to ${repository}. Nothing new is committed.`}
      ><Upload size={13} aria-hidden="true" /> Push</button>
    </div>
  ) : null;

  const initializeState = (
    <div className="studio-empty git-initialize-state">
      <GitBranch size={20} aria-hidden="true" />
      <strong>Not a Git repository</strong>
      <span>Initialize Git to review changes, commit, and use checkpoints and worktrees. Nothing is uploaded.</span>
      <button type="button" className="studio-empty-action" onClick={props.onInitializeGit} disabled={props.gitInitializing || props.readOnly} aria-busy={props.gitInitializing} title={props.readOnly ? READ_ONLY_REASON : "Create a local Git repository and initial snapshot"}>
        {props.gitInitializing ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <GitBranch size={13} aria-hidden="true" />}
        {props.gitInitializing ? "Initializing…" : "Initialize Git"}
      </button>
    </div>
  );

  // The console is evidence, not furniture: it appears once there is
  // something in it.
  const gitConsole = props.gitOutput ? (
    <details className="git-console" open>
      <summary><ChevronRight size={12} aria-hidden="true" /> Git output</summary>
      <pre className="git-screen">{props.gitOutput}</pre>
    </details>
  ) : null;
  const comparing = surface === "changes" && changesMode === "diff" && Boolean(props.comparison);
  // In a comparison only Git's read-only printouts stay beside it.
  const menuLocalItems = comparing ? localItems.filter((item) => item.id === "status" || item.id === "diff") : localItems;
  const changesMenuItems: AppActionMenuItem[] = props.extraMenuItems?.length
    ? [...props.extraMenuItems, { ...menuLocalItems[0], separatorBefore: true }, ...menuLocalItems.slice(1)]
    : menuLocalItems;
  const comparisonFooter = comparing ? (
    <div className="git-comparison-footer" role="group" aria-label="Commit">
      <p>
        <strong>Read-only comparison</strong> with the tracked remote branch: commits not pushed yet, plus current edits.{" "}
        {changed
          ? `Commit, stage and discard the ${fileCount(changed)} not committed yet under Uncommitted.`
          : "Nothing is waiting to be committed."}
      </p>
      <button type="button" className="github-secondary-button" onClick={props.comparison!.onSwitch} title="Show the uncommitted files, where Commit, Stage and Discard act on exactly what is listed">
        <GitCommitHorizontal size={13} aria-hidden="true" /> {changed ? `Switch to Uncommitted (${changed})` : "Switch to Uncommitted"}
      </button>
    </div>
  ) : null;

  if (absent) {
    return (
      <div className="git-workspace" ref={rootRef}>
        {props.readOnly && <div className="history-warning"><ShieldCheck size={13} /> {props.readOnlyReason ?? "Read only: switch thread access to Ask to act or Full access to initialize Git."}</div>}
        {initializeState}
      </div>
    );
  }

  return (
    <div className={`git-workspace${surface === "changes" ? " changes-surface" : ""}`} ref={rootRef}>
      {props.readOnly && <div className="history-warning"><ShieldCheck size={13} /> {props.readOnlyReason ?? "Read only: you can inspect changes, history and pull requests. Switch thread access to Ask to act or Full access before changing Git or contacting GitHub."}</div>}
      {outsideRepositoryRoot && <div className="git-local-note bad" role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{rootRequiredReason}</span></div>}
      {props.repositoryState === "unknown" && (
        <div className="history-warning">
          <ShieldCheck size={13} /> {props.repositoryStateDetail || "Mythra Code could not read this project's repository status."} Local Git actions stay available; GitHub actions need a working connection.
        </div>
      )}

      {/* ------------------- which checkout, and where it stands ------------------- */}

      {!absent && surface !== "changes" && (
        <section className="git-checkout" aria-label="Checkout">
          <div className="git-checkout-repo">
            <GitFork size={13} aria-hidden="true" />
            <strong title={repository ?? undefined}>{repository || (props.githubRepoError ? "GitHub status unavailable" : "No GitHub remote configured")}</strong>
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
          </div>
          {/* Repository, branch and where this checkout stands each get a line:
              the folder kind and push/pull counts no longer squeeze the names. */}
          <p className="git-sync-line" id={syncId} title={syncShort ? `${workflow ? (workflow.isolated ? "Isolated worktree" : "Shared project folder") : "Local repository"} · ${syncText}` : upstream ? `Tracking ${upstream}` : undefined}>
            {syncShort ? <>
              <span aria-hidden="true"><span className={`git-folder-label${workflow?.isolated ? " isolated" : ""}`}>{workflow ? (workflow.isolated ? "Isolated worktree" : "Shared folder") : "Local repository"}</span>{" · "}{syncShort}</span>
              <span className="sr-only">{workflow ? (workflow.isolated ? "Isolated worktree" : "Shared project folder") : "Local repository"} · {syncText}</span>
            </> : <>
              <span className={`git-folder-label${workflow?.isolated ? " isolated" : ""}`}>{workflow ? (workflow.isolated ? "Isolated worktree" : "Shared project folder") : "Local repository"}</span>
              {" · "}{syncText}
            </>}
          </p>

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
              ><ArrowDownToLine size={13} aria-hidden="true" /> Pull{upstream && behind !== null && behind > 0 ? <b aria-label={`${behind} to pull`}>{behind}</b> : null}</button>
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
          {workspaceError && <FriendlyGitError raw={workspaceError} onRetry={workflow.onRefresh} />}
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
      {!repository && surface !== "changes" && (
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
      {surface === "changes" ? <>
        {commitSuccessNote}
        <div className="git-changes-toolbar">
          {hasDiffView && (
            <div className="git-view-tabs git-changes-mode" role="group" aria-label="Show changes as">
              <button type="button" aria-pressed={changesMode === "list"} className={changesMode === "list" ? "active" : ""} onClick={() => setChangesMode("list")} title="Uncommitted files grouped as staged, not staged and new. Select one to see its diff.">
                <ListTree size={13} aria-hidden="true" /><span>Files</span>
                {changed > 0 && <b aria-label={`${changed} changed`}>{changed}</b>}
              </button>
              <button type="button" aria-pressed={changesMode === "diff"} className={changesMode === "diff" ? "active" : ""} onClick={() => setChangesMode("diff")} title="Each changed file's diff, with notes for the agent">
                <FileDiff size={13} aria-hidden="true" /><span>Diff</span>
                {props.diffCount ? <b aria-label={`${props.diffCount} in the diff`}>{props.diffCount}</b> : null}
              </button>
            </div>
          )}
          {/* A comparison can't act on anything, so its toolbar holds no checks (Opus I4). */}
          {props.toolbarExtra && !comparing && <div className="git-changes-extra studio-actions">{props.toolbarExtra}</div>}
          <span className="git-changes-spacer" aria-hidden="true" />
          {props.moreMenuHost
            ? createPortal(<AppActionMenu compact ariaLabel="More Git actions" triggerTitle="More Git actions" items={changesMenuItems} />, props.moreMenuHost)
            : <AppActionMenu compact ariaLabel="More Git actions" triggerTitle="More Git actions" items={changesMenuItems} />}
        </div>
        {/* The list or diff scrolls on its own; the commit bar below is the
            panel's footer and never moves with it. */}
        <div className="git-changes-scroll">
        {changesMode === "diff" ? (props.renderDiff ? props.renderDiff({ selectedPath: diffSelectedPath, livePaths, onSelectPath: (path) => { setRequestedPath(null); selectPath(path); } }) : props.diffView) : (
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
            commit={null}
            hideRefresh={props.hideChangesRefresh}
            hideToolbar
            lineCounts={props.lineCounts}
            cleanNote={cleanPush}
          />
        )}
        {gitConsole}
        </div>
        {props.footerNote}
        {comparing ? comparisonFooter : commitCard}
      </> : <>
      <div className="git-view-tabs" role="tablist" aria-label="Git views" onKeyDown={onTabKeyDown}>
        {views.map(({ id, label, icon: Icon }) => (
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
      </>}

      {surface !== "changes" && gitConsole}
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
      <summary><ChevronRight size={11} aria-hidden="true" /> What's included</summary>
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
              autoPublish.onToggle?.(event.target.checked);
            }}
            disabled={disabled || !autoPublish.onToggle}
            title={autoPublish.hostOnly ?? disabledReason}
          />
          <span>
            <strong>Publish automatically</strong>
            <small>{enabled
              ? `On for this project: new commits and branches are pushed to ${repository}`
              : "Off for this project: nothing is pushed until you choose Push"}</small>
          </span>
        </label>
        {!confirming && (
          <button type="button" className="git-auto-publish-info" aria-expanded={expanded} aria-controls={explanationId} aria-label={expanded ? "Hide what automatic publishing does" : "What automatic publishing does"} title={expanded ? "Hide details" : "What it does"} onClick={() => setExpanded(!expanded)}>
            <Info size={13} aria-hidden="true" />
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
          <button type="button" className="github-create-button" onClick={() => { setConfirming(false); autoPublish.onToggle?.(true); }} disabled={disabled}>
            <CloudUpload size={13} aria-hidden="true" /> Turn on and publish
          </button>
          <button type="button" className="github-secondary-button" onClick={() => setConfirming(false)}>Keep it off</button>
        </div>
      )}
      {enabled && (
        <div className="git-auto-publish-status" role="status" aria-live="polite">
          <span className={`git-auto-publish-orb ${status}`} aria-hidden="true" />
          <span>{autoPublish.message || "Watching this project for new commits."}</span>
          {status === "waiting" && autoPublish.onRetry && (
            <button type="button" className="thread-pr-inline-button" onClick={autoPublish.onRetry}>Retry</button>
          )}
          {autoPublish.hostOnly && <small>{autoPublish.hostOnly}</small>}
          {status === "paused" && !autoPublish.hostOnly && <small>Resolve the issue above, then turn automatic publishing off and on to review the destination again.</small>}
        </div>
      )}
    </section>
  );
}

export const GitPanel = memo(GitPanelInner);

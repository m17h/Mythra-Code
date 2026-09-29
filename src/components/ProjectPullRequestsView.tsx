import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clock,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitFork,
  GitMerge,
  GitPullRequest,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  CreateEditor,
  MergeConfirmation,
  PullRequestChecks,
  ReadyConfirmation,
  checksLine,
  createDrift,
  createSnapshotOf,
  pullRequestDrift,
  pullRequestSnapshotOf,
  reviewLine,
  stateOf,
  titleFromBranch,
  type CreateSnapshot,
  type PullRequestSnapshot,
} from "./ThreadPullRequestPanel";
import { emptyPullRequestCreationDraft } from "../lib/pullRequestCreationDrafts";
import { relativeAge } from "../lib/gitChanges";
import type { ProjectPullRequestAccess } from "../lib/projectGit";
import type { PullRequest, PullRequestContext, PullRequestCreationDraft, PullRequestListState, PullRequestMergeMethod, PullRequestSummary } from "../lib/pullRequests";
import { PULL_REQUEST_PAGE, projectPullRequestDrafts, projectPullRequestListKey, useProjectPullRequests, type PullRequestRef } from "../hooks/useProjectPullRequests";
import "./thread-pull-requests.css";

type ProjectPullRequests = ReturnType<typeof useProjectPullRequests>;

const FILTERS: Array<{ value: PullRequestListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const MERGE_STATE_LABELS: Record<string, { tone: string; text: string }> = {
  CLEAN: { tone: "good", text: "Ready to merge" },
  HAS_HOOKS: { tone: "good", text: "Ready to merge" },
  UNSTABLE: { tone: "wait", text: "Mergeable, some checks not passing" },
  BLOCKED: { tone: "wait", text: "Blocked by branch rules" },
  BEHIND: { tone: "wait", text: "Behind its base branch" },
  DIRTY: { tone: "bad", text: "Has conflicts" },
  DRAFT: { tone: "quiet", text: "Draft" },
};

function mergeStateLine(pullRequest: PullRequest): { tone: string; text: string } {
  if (pullRequest.state === "MERGED") return { tone: "good", text: "Merged" };
  if (pullRequest.state === "CLOSED") return { tone: "quiet", text: "Closed without merging" };
  if ((pullRequest.mergeable || "").toUpperCase() === "CONFLICTING") return { tone: "bad", text: "Has conflicts" };
  return MERGE_STATE_LABELS[(pullRequest.mergeStateStatus || "").toUpperCase()] ?? { tone: "quiet", text: "Not reported yet" };
}

function ToneIcon({ tone }: { tone: string }) {
  if (tone === "good") return <CircleCheck size={12} aria-hidden="true" />;
  if (tone === "bad") return <CircleAlert size={12} aria-hidden="true" />;
  if (tone === "wait") return <Clock size={12} aria-hidden="true" />;
  return <CircleDot size={12} aria-hidden="true" />;
}

const sameRepository = (left?: string | null, right?: string | null) => Boolean(left && right && left.toLowerCase() === right.toLowerCase());
const targetKey = (target: PullRequestRef) => `${target.repository.toLowerCase()}#${target.number}`;

export interface ProjectPullRequestsViewProps {
  access?: ProjectPullRequestAccess;
  visible: boolean;
  /** The selected conversation's own pull request workflow, when there is one. */
  conversationPanel?: ReactNode;
  onOpenGitHubSettings: () => void;
  onConnectRepository?: () => void;
}

export default function ProjectPullRequestsView(props: ProjectPullRequestsViewProps) {
  const { access } = props;
  const pr = useProjectPullRequests(access, props.visible);
  const conversationHeading = useId();
  const browseHeading = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<{ scope: string; target: string; origin: "list" | "branch" } | null>(null);
  const previousSelectionRef = useRef("");
  const pendingDetailFocusRef = useRef<string | null>(null);
  const openTarget = (target: PullRequestRef, origin: "list" | "branch") => {
    returnFocusRef.current = { scope: pr.scope, target: targetKey(target), origin };
    pr.select(target);
  };
  useLayoutEffect(() => {
    const selection = pr.selected ? `${pr.scope}\0${targetKey(pr.selected)}` : "";
    if (selection !== previousSelectionRef.current) {
      previousSelectionRef.current = selection;
      if (pr.selected) {
        if (returnFocusRef.current?.scope !== pr.scope || returnFocusRef.current.target !== targetKey(pr.selected)) {
          returnFocusRef.current = { scope: pr.scope, target: targetKey(pr.selected), origin: "list" };
        }
        headingRef.current?.focus();
        pendingDetailFocusRef.current = targetKey(pr.selected);
      } else {
        pendingDetailFocusRef.current = null;
        const target = returnFocusRef.current;
        const row = target?.scope === pr.scope ? Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-pr-row]") ?? [])
          .find((element) => element.dataset.prRow === target.target && element.dataset.prOrigin === target.origin) : undefined;
        (row ?? rootRef.current?.querySelector<HTMLElement>("[data-git-focus='pullRequestSearch']") ?? headingRef.current)?.focus();
      }
    }
    if (pr.detail && pendingDetailFocusRef.current === targetKey(pr.detail)) {
      // An async read must not steal focus if the person already moved elsewhere.
      if (document.activeElement === headingRef.current) rootRef.current?.querySelector<HTMLElement>("[data-pr-detail-heading]")?.focus();
      pendingDetailFocusRef.current = null;
    }
  }, [pr.scope, pr.selected, pr.detail, pr.items]);

  const conversation = props.conversationPanel && (
    <section className="git-pr-section" aria-labelledby={conversationHeading}>
      <div className="git-pr-section-head">
        <h3 id={conversationHeading} tabIndex={-1} data-git-focus="conversationPullRequest">This conversation</h3>
      </div>
      <p className="git-fineprint">Attaching links a pull request to this conversation only; it changes nothing in Git or on GitHub.</p>
      {props.conversationPanel}
    </section>
  );

  if (!access) {
    return <div className="git-pulls">{conversation || <p className="git-changes-empty">Open a project folder to browse its pull requests.</p>}</div>;
  }
  if (!access.repository) {
    return (
      <div className="git-pulls">
        {conversation}
        <div className="git-pr-empty">
          <GitPullRequest size={20} aria-hidden="true" />
          <strong>Pull requests need a GitHub repository</strong>
          <span>This project has no GitHub remote set up in Mythra Code. Connecting one records its address; nothing is uploaded until you push.</span>
          {props.onConnectRepository && <button type="button" className="github-secondary-button" onClick={props.onConnectRepository}><GitFork size={13} aria-hidden="true" /> Connect a repository…</button>}
        </div>
      </div>
    );
  }
  if (!access.authenticated) {
    return (
      <div className="git-pulls">
        {conversation}
        <div className="git-pr-empty">
          <GitPullRequest size={20} aria-hidden="true" />
          <strong>Connect your GitHub account to see pull requests</strong>
          <span>{access.repository} is attached. Signing in lets Mythra Code read its pull requests, checks and reviews.</span>
          <button type="button" className="github-secondary-button" onClick={props.onOpenGitHubSettings}><ShieldCheck size={13} aria-hidden="true" /> Open GitHub settings</button>
        </div>
      </div>
    );
  }

  return (
    <div className="git-pulls" ref={rootRef}>
      {pr.busy && pr.operationLabel && <p className="thread-pr-note" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" /> {pr.operationLabel} Browsing still works.</p>}
      {pr.error && (
        <div className="thread-pr-note bad" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pr.error}</span>
        </div>
      )}
      {pr.notice && !pr.error && (
        <div className="thread-pr-note good" role="status" aria-live="polite">
          <CircleCheck size={13} aria-hidden="true" />
          <span>{pr.notice}</span>
        </div>
      )}
      {access.mutationBlockedReason && (
        <p className="git-blocked-reason">{access.mutationBlockedReason} Browsing and reading pull requests still work.</p>
      )}

      {conversation}
      {!access.threadActive && <ProjectBranchSection key={pr.scope} pr={pr} access={access} onOpen={(target) => openTarget(target, "branch")} />}

      <section className="git-pr-section" aria-labelledby={browseHeading}>
        <div className="git-pr-section-head">
          <h3 id={browseHeading} ref={headingRef} tabIndex={-1}>{pr.selected ? "Pull request" : "All pull requests"}</h3>
          <small title={access.repository}>{access.repository}</small>
          <button
            type="button"
            className="icon-button tiny"
            onClick={pr.selected ? pr.refreshDetail : pr.refresh}
            disabled={pr.selected ? pr.detailLoading : pr.listLoading}
            aria-busy={pr.selected ? pr.detailLoading : pr.listLoading}
            aria-label={pr.selected ? "Refresh this pull request" : "Refresh pull requests"}
            title="Check GitHub for the latest status"
          >
            <RefreshCw size={13} className={(pr.selected ? pr.detailLoading : pr.listLoading) ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        {pr.selected
          ? <PullRequestDetails key={`${pr.scope}\0${targetKey(pr.selected)}`} pr={pr} access={access} onBack={() => pr.select(null)} />
          : <PullRequestBrowser pr={pr} access={access} onOpen={(target) => openTarget(target, "list")} />}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function PullRequestBrowser({ pr, access, onOpen }: { pr: ProjectPullRequests; access: ProjectPullRequestAccess; onOpen: (target: PullRequestRef) => void }) {
  const items = pr.itemsQuery === projectPullRequestListKey(pr.query, pr.filter) ? pr.items : null;
  const draftSearch = pr.query.trim() !== pr.appliedQuery;
  const filterLabel = FILTERS.find((filter) => filter.value === pr.filter)?.label.toLowerCase() ?? "";
  return (
    <>
      <form className="git-pr-search" role="search" onSubmit={(event) => { event.preventDefault(); pr.search(pr.query, pr.filter); }}>
        <input
          type="search"
          value={pr.query}
          onChange={(event) => pr.setQuery(event.target.value)}
          placeholder="Search titles, author:login, label:bug…"
          aria-label="Search pull requests"
          maxLength={256}
          spellCheck={false}
          data-git-focus="pullRequestSearch"
        />
        <button type="submit" className="icon-button tiny" aria-label="Search pull requests now" disabled={pr.listLoading}><Search size={13} aria-hidden="true" /></button>
      </form>
      <div className="git-pr-filters" role="group" aria-label="Pull request state">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={pr.filter === filter.value}
            className={pr.filter === filter.value ? "active" : ""}
            onClick={() => pr.search(pr.query, filter.value)}
          >{filter.label}</button>
        ))}
      </div>

      {pr.listError && (
        <div className="thread-pr-note bad" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pr.listError}</span>
          <button type="button" className="thread-pr-inline-button" onClick={pr.retryList}>Try again</button>
        </div>
      )}
      {!items && pr.listLoading && !draftSearch && (
        <p className="git-changes-empty" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Loading pull requests…</p>
      )}
      {!items && draftSearch && <p className="git-fineprint">Press Enter to search pull requests.</p>}
      {items && items.length === 0 && !pr.listError && (
        <p className="git-changes-empty">{pr.query.trim() ? "No pull requests match this search." : `No ${filterLabel === "all" ? "" : `${filterLabel} `}pull requests in ${access.repository}.`}</p>
      )}
      {items && items.length > 0 && (
        <ul className={`git-pr-list${pr.listLoading ? " refreshing" : ""}`} aria-label={`Pull requests in ${access.repository}`} aria-busy={pr.listLoading}>
          {items.map((item) => (
            <PullRequestRow
              key={`${item.repository}#${item.number}`}
              item={item}
              context={pr.context}
              linked={Boolean(access.threadLink && sameRepository(access.threadLink.repository, item.repository) && access.threadLink.number === item.number)}
              onOpen={() => onOpen({ repository: item.repository, number: item.number })}
            />
          ))}
        </ul>
      )}
      {items && items.length >= PULL_REQUEST_PAGE && (
        <p className="git-fineprint">Showing the {PULL_REQUEST_PAGE} most recently updated. Search to find others.</p>
      )}
    </>
  );
}

function PullRequestRow({ item, context, linked, onOpen }: { item: PullRequestSummary; context: PullRequestContext | null; linked: boolean; onOpen: () => void }) {
  const state = stateOf(item);
  const onThisBranch = Boolean(context && sameRepository(context.repository, item.repository) && context.branch === item.headRefName);
  const updated = relativeAge(item.updatedAt);
  return (
    <li>
      <button type="button" className="git-pr-row" data-pr-row={targetKey(item)} data-pr-origin="list" onClick={onOpen} aria-label={`#${item.number} ${item.title || "Untitled pull request"}, ${state.label}. Open details`}>
        <span className={`thread-pr-state ${state.key}`}><state.icon size={12} aria-hidden="true" /></span>
        <span className="git-pr-row-main">
          <strong title={item.title}>{item.title || "Untitled pull request"}</strong>
          <small>
            #{item.number} · <span className="git-pr-ref" title={`${item.headRefName} into ${item.baseRefName}`}>{item.headRefName} → {item.baseRefName}</span>
            {item.authorLogin ? ` · ${item.authorLogin}` : ""}{updated ? ` · ${updated}` : ""}
          </small>
        </span>
        {(onThisBranch || linked) && (
          <span className="git-pr-row-tags">
            {onThisBranch && <em>This branch</em>}
            {linked && <em>Conversation</em>}
          </span>
        )}
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ */

function PullRequestDetails({ pr, access, onBack }: { pr: ProjectPullRequests; access: ProjectPullRequestAccess; onBack: () => void }) {
  const detail = pr.detail;
  const [card, setCard] = useState<"none" | "merge" | "ready">("none");
  const [snapshot, setSnapshot] = useState<PullRequestSnapshot | null>(null);
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(null);
  const [auto, setAuto] = useState(false);
  const [pending, setPending] = useState<"none" | "merge" | "ready" | "attach" | "update">("none");
  const blocked = access.mutationBlockedReason;
  const busy = pr.busy;
  const openCard = (next: "merge" | "ready") => {
    if (!detail || card === next) { setCard("none"); return; }
    setSnapshot(pullRequestSnapshotOf(detail));
    setCard(next);
  };
  const run = async (kind: typeof pending, action: () => Promise<void>) => {
    setPending(kind);
    try { await action(); setCard("none"); }
    catch { /* The hook reports the failure; the card stays open. */ }
    finally { setPending("none"); }
  };
  const back = (
    <button type="button" className="thread-pr-inline-button git-pr-back" onClick={onBack}>
      <ArrowLeft size={12} aria-hidden="true" /> All pull requests
    </button>
  );

  if (!detail) {
    return (
      <>
        {back}
        {pr.detailLoading && <p className="git-changes-empty" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Loading #{pr.selected?.number}…</p>}
        {pr.detailError && (
          <div className="thread-pr-note bad" role="alert">
            <CircleAlert size={13} aria-hidden="true" />
            <span>{pr.detailError}</span>
            <button type="button" className="thread-pr-inline-button" onClick={pr.refreshDetail}>Try again</button>
          </div>
        )}
      </>
    );
  }

  const state = stateOf(detail);
  const checks = checksLine(detail.checks);
  const review = reviewLine(detail.reviewDecision);
  const mergeState = mergeStateLine(detail);
  const context = pr.context;
  const otherRepository = context && !sameRepository(context.repository, detail.repository) ? context.repository : null;
  const otherBranch = context && !otherRepository && context.branch !== detail.headRefName ? context.branch : null;
  const linkedHere = Boolean(access.threadLink && sameRepository(access.threadLink.repository, detail.repository) && access.threadLink.number === detail.number);
  const methods = detail.mergeMethods ?? [];
  const chosenMethod = method && methods.includes(method) ? method : (methods.includes("squash") ? "squash" : methods[0] ?? null);
  const canMarkReady = detail.isDraft && detail.state === "OPEN";
  const updated = relativeAge(detail.updatedAt);
  const checked = relativeAge(pr.detailAt);
  const refreshing = pr.detailLoading;

  return (
    <>
      {back}
      {pr.detailError && (
        <div className="thread-pr-note bad" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pr.detailError} Showing the last details read.</span>
          <button type="button" className="thread-pr-inline-button" onClick={pr.refreshDetail}>Try again</button>
        </div>
      )}
      <article className={`thread-pr-card ${state.key}`} aria-busy={refreshing}>
        <div className="thread-pr-card-head">
          <span className={`thread-pr-state ${state.key}`}><state.icon size={12} aria-hidden="true" />{state.label}</span>
          <span className="thread-pr-number">#{detail.number}</span>
          {linkedHere && <span className="thread-pr-fact quiet">In this conversation</span>}
        </div>
        <h4 className="thread-pr-title" title={detail.title} tabIndex={-1} data-pr-detail-heading>{detail.title || "Untitled pull request"}</h4>
        <p className="thread-pr-refs" title={detail.repository}><GitFork size={11} aria-hidden="true" /><span>{detail.repository}</span></p>
        <p className="thread-pr-refs" title={`${detail.headRefName} into ${detail.baseRefName}`}>
          <GitBranch size={11} aria-hidden="true" /><span>{detail.headRefName}</span><span aria-hidden="true">→</span><span>{detail.baseRefName}</span>
        </p>
        <dl className="thread-pr-signals">
          <div className={`thread-pr-signal ${checks.tone}`}><ToneIcon tone={checks.tone} /><dt>Checks</dt><dd>{checks.text}</dd></div>
          <div className={`thread-pr-signal ${review.tone}`}><ToneIcon tone={review.tone} /><dt>Review</dt><dd>{review.text}</dd></div>
          <div className={`thread-pr-signal ${mergeState.tone}`}><ToneIcon tone={mergeState.tone} /><dt>Merge</dt><dd>{mergeState.text}</dd></div>
        </dl>
        <PullRequestChecks checks={detail.checks} label={`Checks for #${detail.number}`} />
        <p className="thread-pr-fineprint">
          {updated ? `Updated on GitHub ${updated}` : "Update time not reported"}{checked ? ` · checked ${checked}` : ""}{refreshing ? " · refreshing…" : ""}
        </p>

        {otherRepository && (
          <div className="thread-pr-note" role="status">
            <TriangleAlert size={13} aria-hidden="true" />
            <span>This pull request belongs to <strong>{detail.repository}</strong>; this folder points at <strong>{otherRepository}</strong>. Actions here act on GitHub only.</span>
          </div>
        )}
        {otherBranch && detail.state === "OPEN" && (
          <div className="thread-pr-note" role="status">
            <TriangleAlert size={13} aria-hidden="true" />
            <span>Its branch is <strong>{detail.headRefName}</strong>; this folder is on <strong>{otherBranch}</strong>. Merging or marking it ready acts on GitHub, not on your files.</span>
          </div>
        )}

        {detail.state === "MERGED" && (
          <div className="thread-pr-note" role="status">
            <GitMerge size={13} aria-hidden="true" />
            <span>Merged into <strong>{detail.baseRefName}</strong> on GitHub. Your files here have not changed.</span>
            {access.onUpdateLocal && sameRepository(access.repository, detail.repository) && (
              <button
                type="button"
                className="thread-pr-inline-button"
                onClick={() => void run("update", () => access.onUpdateLocal!(detail.repository, detail.baseRefName))}
                disabled={busy || pending !== "none" || !!blocked}
                aria-busy={pending === "update"}
                title={blocked ?? `Check out ${detail.baseRefName} and fast-forward it from GitHub. Asks first; refused if this folder has uncommitted changes.`}
              >{pending === "update" ? <><LoaderCircle className="spin" size={12} /> Updating…</> : `Update local ${detail.baseRefName}…`}</button>
            )}
          </div>
        )}

        {detail.body.trim() && (
          <details className="git-pr-body">
            <summary>Description</summary>
            <div>{detail.body}</div>
          </details>
        )}

        <div className="thread-pr-actions">
          <button type="button" onClick={() => { void openUrl(detail.url).catch(() => undefined); }} title={`Open ${detail.repository} #${detail.number} in your browser, including its review comments`}>
            <ExternalLink size={13} aria-hidden="true" /> Open on GitHub
          </button>
          {access.attachToThread && !linkedHere && (
            <button
              type="button"
              onClick={() => void run("attach", () => access.attachToThread!(detail.url))}
              disabled={busy || pending === "attach"}
              aria-busy={pending === "attach"}
              title="Links this pull request to the selected conversation. Nothing changes in Git or on GitHub."
            >
              {pending === "attach" ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} aria-hidden="true" />} Attach to conversation
            </button>
          )}
          {canMarkReady && (
            <button type="button" className="primary" onClick={() => openCard("ready")} aria-expanded={card === "ready"} disabled={busy}>
              <Send size={13} aria-hidden="true" /> Mark ready…
            </button>
          )}
          {detail.state === "OPEN" && (
            <button
              type="button"
              className={canMarkReady ? "" : "primary"}
              onClick={() => openCard("merge")}
              aria-expanded={card === "merge"}
              disabled={busy}
              title={`Merge #${detail.number} on GitHub. Your files here do not change.`}
            >
              <GitMerge size={13} aria-hidden="true" /> Merge on GitHub…
            </button>
          )}
        </div>

        {card === "ready" && snapshot && (
          <ReadyConfirmation
            pullRequest={detail}
            drift={pullRequestDrift(snapshot, detail, "This pull request could not be read again.")}
            busy={busy || pending === "ready"}
            mutationBlockedReason={blocked}
            onReview={() => setSnapshot(pullRequestSnapshotOf(detail))}
            onCancel={() => setCard("none")}
            onConfirm={() => void run("ready", () => pr.markReady(snapshot))}
          />
        )}
        {card === "merge" && snapshot && (
          <MergeConfirmation
            pullRequest={detail}
            localBranch={context?.branch}
            methods={methods}
            method={chosenMethod}
            onMethod={setMethod}
            auto={auto}
            onAuto={setAuto}
            archiveOffered={false}
            archive={false}
            onArchive={() => undefined}
            archiveBlockedReason={null}
            drift={pullRequestDrift(snapshot, detail, "This pull request could not be read again.")}
            busy={busy || pending === "merge"}
            loading={refreshing}
            mutationBlockedReason={blocked}
            onRefresh={pr.refreshDetail}
            onReview={() => { setSnapshot(pullRequestSnapshotOf(detail)); setAuto(false); }}
            onCancel={() => setCard("none")}
            onConfirm={() => {
              if (!chosenMethod) return;
              // The revision confirmed is the one sent: GitHub refuses the merge if the head moved.
              void run("merge", () => pr.merge(chosenMethod, auto, snapshot));
            }}
          />
        )}
      </article>
    </>
  );
}

/* ------------------------------------------------------------------ */

/** The checkout's branch when no conversation owns the pull request workflow. */
function ProjectBranchSection({ pr, access, onOpen }: { pr: ProjectPullRequests; access: ProjectPullRequestAccess; onOpen: (target: PullRequestRef) => void }) {
  const heading = useId();
  const context = pr.context;
  const [creating, setCreating] = useState(false);
  const [createSnapshot, setCreateSnapshot] = useState<CreateSnapshot | null>(null);
  const [draft, setDraft] = useState<PullRequestCreationDraft>(emptyPullRequestCreationDraft);
  const [draftScope, setDraftScope] = useState("");
  const [branchName, setBranchName] = useState("");
  const [pending, setPending] = useState<"none" | "create" | "branch">("none");
  const blocked = access.mutationBlockedReason;
  const canChange = !blocked && !pr.busy;
  const found = pr.branchPullRequest;
  const onDefault = Boolean(context && context.branch === context.defaultBranch);

  const scopeOf = (current: PullRequestContext) => `${pr.scope}\0${JSON.stringify([current.repository.toLowerCase(), current.branch, current.headOid])}`;
  const remember = (scope: string, value: PullRequestCreationDraft) => {
    projectPullRequestDrafts.write(scope, value);
    setDraft(value);
    setDraftScope(scope);
  };
  const patch = (value: Partial<PullRequestCreationDraft>) => remember(draftScope, { ...draft, ...value });
  const openCreate = () => {
    if (creating || !context) { setCreating(false); return; }
    const scope = scopeOf(context);
    const next = { ...(projectPullRequestDrafts.read(scope) ?? emptyPullRequestCreationDraft()) };
    if (!next.title) {
      const firstCommit = context.commits?.[0]?.trim();
      if (firstCommit) { next.title = firstCommit; next.titleSource = "commit"; }
      else { next.title = titleFromBranch(context.branch); next.titleSource = "branch"; }
    }
    if (!next.base) next.base = context.defaultBranch;
    remember(scope, next);
    setCreateSnapshot(createSnapshotOf(context));
    setCreating(true);
  };
  const run = async (kind: "create" | "branch", action: () => Promise<void>) => {
    const submitted = kind === "create" ? projectPullRequestDrafts.read(draftScope) : undefined;
    setPending(kind);
    try {
      await action();
      if (kind === "create") {
        // Clear only the version that was sent, never text typed since.
        if (submitted && projectPullRequestDrafts.read(draftScope) === submitted) projectPullRequestDrafts.clear(draftScope);
        setCreating(false);
        setDraft(emptyPullRequestCreationDraft());
      } else setBranchName("");
    } catch { /* The hook reports it; every field stays as typed. */ }
    finally { setPending("none"); }
  };

  return (
    <section className="git-pr-section" aria-labelledby={heading}>
      <div className="git-pr-section-head">
        <h3 id={heading}>This branch</h3>
        {pr.contextLoading && <LoaderCircle className="spin" size={12} aria-label="Checking this checkout" />}
      </div>
      {context ? (
        <div className="thread-pr-context">
          <span className="thread-pr-fact" title={`Current branch: ${context.branch}`}><GitBranch size={11} aria-hidden="true" />{context.branch}</span>
          <span className={`thread-pr-fact ${access.isolated ? "isolated" : "quiet"}`}>{access.isolated ? "Isolated worktree" : "Shared folder"}</span>
          {context.dirty && <span className="thread-pr-fact warn">Uncommitted changes</span>}
          {(context.ahead > 0 || context.behind > 0) && (
            <span className="thread-pr-fact quiet">{[context.ahead ? `${context.ahead} ahead` : null, context.behind ? `${context.behind} behind` : null].filter(Boolean).join(" · ")} of {context.defaultBranch}</span>
          )}
        </div>
      ) : pr.contextLoading ? (
        <p className="git-changes-empty" role="status">Checking this checkout…</p>
      ) : null}
      {pr.contextError && (
        <div className="thread-pr-note bad" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{pr.contextError}</span>
          <button type="button" className="thread-pr-inline-button" onClick={pr.refreshContext} disabled={pr.contextLoading}>Try again</button>
        </div>
      )}

      {found ? (
        <div className="thread-pr-slot">
          <button type="button" className="git-pr-row" data-pr-row={targetKey(found)} data-pr-origin="branch" onClick={() => onOpen({ repository: found.repository, number: found.number })}>
            <span className="thread-pr-state found"><GitPullRequest size={12} aria-hidden="true" /></span>
            <span className="git-pr-row-main">
              <strong title={found.title}>{found.title || "Untitled pull request"}</strong>
              <small>#{found.number} · found for {found.headRefName} · open details</small>
            </span>
          </button>
          <p className="thread-pr-fineprint">Not attached to any conversation. Open a thread to attach it, or work with it here.</p>
        </div>
      ) : context && onDefault ? (
        <div className="thread-pr-slot">
          <div className="thread-pr-slot-head">
            <GitBranchPlus size={14} aria-hidden="true" />
            <div>
              <strong>This folder is on {context.defaultBranch}</strong>
              <small>A pull request needs its own branch.{access.isolated ? " This isolated folder keeps its own branch." : " Create one and this folder switches to it."}</small>
            </div>
          </div>
          {!access.isolated && (
            <form className="thread-pr-row" onSubmit={(event) => { event.preventDefault(); if (branchName.trim() && canChange) void run("branch", () => pr.createBranch(branchName.trim())); }}>
              <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="feature/short-description" aria-label="New branch name for a pull request" spellCheck={false} />
              <button type="submit" className="thread-pr-wide-button" disabled={!canChange || !branchName.trim() || pending === "branch"} aria-busy={pending === "branch"} title={blocked ?? "Create this branch and switch the folder to it"}>
                {pending === "branch" ? <LoaderCircle className="spin" size={13} /> : <GitBranchPlus size={13} aria-hidden="true" />} Create branch
              </button>
            </form>
          )}
        </div>
      ) : context ? (
        <div className="thread-pr-slot">
          {!creating && (
            <button type="button" className="thread-pr-wide-button primary" onClick={openCreate} disabled={pr.busy} aria-expanded={false}>
              <GitPullRequest size={13} aria-hidden="true" /> Create a pull request
            </button>
          )}
          {creating && createSnapshot && (
            <CreateEditor
              context={context}
              snapshot={createSnapshot}
              drift={createDrift(createSnapshot, context)}
              isolated={access.isolated}
              title={draft.title}
              titleSource={draft.titleSource}
              onTitle={(value) => patch({ title: value, titleSource: null })}
              body={draft.body} onBody={(value) => patch({ body: value })}
              base={draft.base} onBase={(value) => patch({ base: value })}
              draft={draft.draft} onDraft={(value) => patch({ draft: value })}
              commitAll={draft.commitAll} onCommitAll={(value) => patch({ commitAll: value })}
              commitMessage={draft.commitMessage} onCommitMessage={(value) => patch({ commitMessage: value })}
              busy={pr.busy || pending === "create"}
              loading={pr.contextLoading}
              disabled={!canChange}
              disabledReason={blocked}
              onRefresh={pr.refreshContext}
              onReview={() => { remember(scopeOf(context), draft); setCreateSnapshot(createSnapshotOf(context)); }}
              onCancel={() => setCreating(false)}
              onSubmit={() => void run("create", () => pr.create({
                head: createSnapshot.branch,
                base: draft.base.trim(),
                title: draft.title.trim(),
                body: draft.body,
                draft: draft.draft,
                commitAll: context.dirty && draft.commitAll,
                commitMessage: context.dirty && draft.commitAll ? (draft.commitMessage.trim() || undefined) : undefined,
                expectedHeadOid: createSnapshot.headOid,
              }))}
            />
          )}
          <p className="thread-pr-fineprint">Created here, it is not attached to any conversation.</p>
        </div>
      ) : null}
    </section>
  );
}

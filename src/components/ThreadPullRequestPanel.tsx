import { memo, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  ChevronRight,
  CircleDot,
  Clock,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitBranchPlus,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import {
  parsePullRequestReference,
  type PullRequest,
  type PullRequestContext,
  type PullRequestMergeMethod,
  type PullRequestPanelProps,
} from "../lib/pullRequests";
import "./thread-pull-requests.css";

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** Which inline card is expanded. Only one at a time: the dock is narrow, and
 *  two open editors in 265px is how people lose their place. Keeping merge and
 *  "mark ready" on separate keys is also what stops one confirmation from ever
 *  being mistaken for the other. */
type OpenCard = "none" | "create" | "merge" | "ready" | "branch";

/** How many list rows show before "Show all", and the ceiling once expanded. */
const LIST_PREVIEW = 6;
const LIST_CEILING = 200;

/* ------------------------------------------------------------------ *
 * Reading GitHub's vocabulary back out in plain words
 * ------------------------------------------------------------------ */

function stateOf(pullRequest: PullRequest) {
  if (pullRequest.state === "MERGED") return { key: "merged", label: "Merged", icon: GitMerge };
  if (pullRequest.state === "CLOSED") return { key: "closed", label: "Closed", icon: GitPullRequestClosed };
  if (pullRequest.isDraft) return { key: "draft", label: "Draft", icon: GitPullRequestDraft };
  return { key: "open", label: "Open", icon: GitPullRequest };
}

const FAILING_CHECKS = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const RUNNING_CHECKS = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
/**
 * Only these three mean "this check is not going to stop a merge". Anything
 * else — including an empty string, a state GitHub adds later, or one we
 * simply failed to read — is reported as unknown. A check whose result we do
 * not understand must never be painted green.
 */
const PASSING_CHECKS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function summarizeChecks(checks: PullRequest["checks"]) {
  let failing = 0;
  let running = 0;
  let unknown = 0;
  let passed = 0;
  for (const check of checks) {
    const state = (check.state || "").toUpperCase();
    if (FAILING_CHECKS.has(state)) failing += 1;
    else if (RUNNING_CHECKS.has(state)) running += 1;
    else if (PASSING_CHECKS.has(state)) passed += 1;
    else unknown += 1;
  }
  return { failing, running, unknown, passed, total: checks.length };
}

function checksLine(checks: PullRequest["checks"]): { tone: string; text: string } {
  const { failing, running, unknown, passed, total } = summarizeChecks(checks);
  if (!total) return { tone: "quiet", text: "No checks reported" };
  if (failing) return { tone: "bad", text: `${failing} of ${total} check${total === 1 ? "" : "s"} failing` };
  if (running) return { tone: "wait", text: `${running} of ${total} check${total === 1 ? "" : "s"} still running` };
  if (unknown) return { tone: "wait", text: `${unknown} of ${total} check${total === 1 ? "" : "s"} did not report a result` };
  return { tone: "good", text: `${passed} check${passed === 1 ? "" : "s"} passed` };
}

function reviewLine(decision: string): { tone: string; text: string } {
  switch ((decision || "").toUpperCase()) {
    case "APPROVED": return { tone: "good", text: "Approved" };
    case "CHANGES_REQUESTED": return { tone: "bad", text: "Changes requested" };
    case "REVIEW_REQUIRED": return { tone: "wait", text: "Review required" };
    default: return { tone: "quiet", text: "No review yet" };
  }
}

/** A branch name turned into a first-draft title the person can edit. */
function titleFromBranch(branch: string): string {
  const tail = branch.split("/").pop() ?? branch;
  const words = tail.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * Two kinds of reason a merge cannot go ahead.
 *
 * `hard` means nothing done here will help: closed, conflicted, still a draft,
 * the thread may not change anything, or this GitHub account cannot merge in
 * that repository. Every merge control is disabled.
 *
 * `soft` means GitHub is simply not ready *yet* — checks running, a review
 * outstanding. Merging now is refused; asking GitHub to merge it later is not,
 * where the repository allows that.
 *
 * Note what is deliberately absent: the local checkout. A pull request stays
 * mergeable after its worktree is removed, so a missing local context is never
 * a reason to refuse.
 */
function mergeBlockers(pullRequest: PullRequest, mutationBlockedReason: string | null) {
  const hard: string[] = [];
  const soft: string[] = [];
  if (mutationBlockedReason) hard.push(mutationBlockedReason);
  if (pullRequest.state === "MERGED") hard.push("This pull request is already merged.");
  if (pullRequest.state === "CLOSED") hard.push("This pull request is closed. Reopen it on GitHub to merge it.");
  if (pullRequest.isDraft) hard.push("This pull request is still a draft. Mark it ready for review first.");
  if ((pullRequest.mergeable || "").toUpperCase() === "CONFLICTING") hard.push("This pull request has conflicts with its base branch. Resolve them first.");
  // Permission is read from the pull request's own repository. It is never
  // inferred from whatever repository this folder happens to point at.
  if (pullRequest.viewerCanMerge === false) hard.push(`Your GitHub account cannot merge pull requests in ${pullRequest.repository}.`);
  if (!pullRequest.mergeMethods.length) hard.push(`${pullRequest.repository} allows no merge method Mythra Code can use.`);

  if (!hard.length && !pullRequest.canMerge) {
    const checks = summarizeChecks(pullRequest.checks);
    if (checks.failing) soft.push(`${checks.failing} check${checks.failing === 1 ? " is" : "s are"} failing.`);
    else if (checks.running) soft.push(`${checks.running} check${checks.running === 1 ? " is" : "s are"} still running.`);
    else if (checks.unknown) soft.push(`${checks.unknown} check${checks.unknown === 1 ? " has" : "s have"} not reported a result.`);
    const decision = (pullRequest.reviewDecision || "").toUpperCase();
    if (decision === "CHANGES_REQUESTED") soft.push("A reviewer asked for changes.");
    else if (decision === "REVIEW_REQUIRED") soft.push("A review is still required.");
    if (!soft.length) soft.push("GitHub does not consider this pull request ready to merge yet.");
  }
  return { hard, soft };
}

/* ------------------------------------------------------------------ *
 * Snapshots
 *
 * Both editors pin what they were opened against, and submit that. If the
 * world moves underneath an open form, submission is refused until the
 * refreshed details have actually been looked at — so the revision shown is
 * always the revision sent.
 * ------------------------------------------------------------------ */

interface CreateSnapshot { repository: string; branch: string; headOid: string }
interface PullRequestSnapshot { repository: string; number: number; headOid: string }

const createSnapshotOf = (context: PullRequestContext): CreateSnapshot =>
  ({ repository: context.repository, branch: context.branch, headOid: context.headOid });

const pullRequestSnapshotOf = (pullRequest: PullRequest): PullRequestSnapshot =>
  ({ repository: pullRequest.repository, number: pullRequest.number, headOid: pullRequest.headOid });

/** What moved, said specifically enough to be worth reading. */
function createDrift(snapshot: CreateSnapshot, context: PullRequestContext | null): string | null {
  if (!context) return "Mythra Code can no longer read this folder's Git repository.";
  if (context.repository !== snapshot.repository) return `This folder now points at ${context.repository}.`;
  if (context.branch !== snapshot.branch) return `This folder moved from ${snapshot.branch} to ${context.branch}.`;
  if (context.headOid !== snapshot.headOid) return `${context.branch} has new commits since you opened this form.`;
  return null;
}

function pullRequestDrift(snapshot: PullRequestSnapshot, pullRequest: PullRequest | null): string | null {
  if (!pullRequest) return "This pull request is no longer attached to the thread.";
  if (pullRequest.repository !== snapshot.repository || pullRequest.number !== snapshot.number) {
    return `The attached pull request changed to ${pullRequest.repository} #${pullRequest.number}.`;
  }
  if (pullRequest.headOid !== snapshot.headOid) return "New commits were pushed to this pull request since you opened this.";
  return null;
}

/* ------------------------------------------------------------------ *
 * Bringing a merged pull request back down to the folder
 *
 * Merging happens entirely on GitHub. Nothing about it changes a single file
 * on this machine, and the panel used to end there — which is exactly where
 * people concluded that "Merge" had also merged their local branch. These
 * props add the missing half as an explicit, guarded action rather than an
 * automatic pull: updating a checkout while an agent is writing in it is not
 * something to do behind anyone's back.
 *
 * Declared here rather than in `src/lib/pullRequests.ts` so the shared props
 * type stays owned by one place; the app passes the same object either way.
 */
export interface ThreadPullRequestPanelProps extends PullRequestPanelProps {
  /** Fast-forward the local base branch from GitHub. Refused by the caller
   *  when the folder is dirty, diverged, busy, or checked out elsewhere. */
  onUpdateLocal?: () => Promise<void>;
  updateLocalBusy?: boolean;
  /** Why the update cannot run, or what the last one did. */
  updateLocalNotice?: string;
  /** Merge on GitHub now, then archive the thread. Immediate merges only:
   *  there is no "archive it whenever GitHub gets around to merging". */
  onMergeAndArchive?: (method: PullRequestMergeMethod) => Promise<void>;
  /** Archive the thread on its own — the retry after a merge that landed on
   *  GitHub while the archive did not, and the way to finish a thread whose
   *  pull request was merged somewhere else. */
  onArchiveMergedThread?: () => Promise<void>;
  /** Why this thread cannot be archived right now. */
  archiveBlockedReason?: string | null;
}

/* ------------------------------------------------------------------ */

function ThreadPullRequestPanelInner(props: ThreadPullRequestPanelProps) {
  const { context, pullRequest, linked, isolated, busy, loading } = props;
  const [card, setCard] = useState<OpenCard>("none");
  const [reference, setReference] = useState("");
  const [branchName, setBranchName] = useState("");
  const [title, setTitle] = useState("");
  const [titleSource, setTitleSource] = useState<"commit" | "branch" | null>(null);
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [commitAll, setCommitAll] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [createSnapshot, setCreateSnapshot] = useState<CreateSnapshot | null>(null);
  const [actionSnapshot, setActionSnapshot] = useState<PullRequestSnapshot | null>(null);
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(null);
  const [auto, setAuto] = useState(false);
  // Never remembered between openings. Archiving a thread is a decision about
  // this merge, made now, on purpose — not a preference that quietly persists.
  const [archive, setArchive] = useState(false);
  const [pending, setPending] = useState<OpenCard | "attach" | "none">("none");

  // Switching threads must not carry one thread's half-written pull request
  // into the next one.
  const threadId = props.threadId;
  useEffect(() => {
    setCard("none");
    setReference("");
    setTitle("");
    setTitleSource(null);
    setBody("");
    setBase("");
    setDraft(false);
    setCommitAll(false);
    setCommitMessage("");
    setCreateSnapshot(null);
    setActionSnapshot(null);
    setAuto(false);
    setArchive(false);
  }, [threadId]);

  // And not between pull requests either. A tick made against #123 must not
  // survive into #456 being attached in its place — the drift notice refuses
  // the merge, but the choice itself has to go with the pull request it was
  // made about.
  const attachedKey = pullRequest ? `${pullRequest.repository}#${pullRequest.number}` : "";
  useEffect(() => { setArchive(false); }, [attachedKey]);

  // Merge methods come from the pull request's own repository. There is no
  // fallback to the local context's methods: a different repository's rules
  // are not this pull request's rules.
  const methods = pullRequest?.mergeMethods ?? [];
  const chosenMethod = method && methods.includes(method) ? method : (methods.includes("squash") ? "squash" : methods[0] ?? null);

  const onDefaultBranch = !!context && context.branch === context.defaultBranch;
  const blocked = props.mutationBlockedReason;
  // Attaching and detaching only write this thread's own metadata: no Git
  // write, no GitHub write. They stay available in read-only mode and while a
  // turn is running. Only a competing in-flight operation holds them back.
  const canAttach = !busy;
  const canChange = !blocked && !busy;

  async function run(kind: OpenCard | "attach", action: () => Promise<void>) {
    setPending(kind);
    try {
      await action();
      // Only a success closes the editor. A rejection leaves every field the
      // person typed exactly where it was, next to the error the hook reports.
      setCard("none");
      if (kind === "attach") setReference("");
    } catch {
      /* The parent hook owns error reporting; the card stays open. */
    } finally {
      setPending("none");
    }
  }

  function openCreate() {
    if (card === "create" || !context) { setCard("none"); return; }
    const firstCommit = context.commits?.[0]?.trim();
    if (!title) {
      // Straight from the branch or the first commit subject the person wrote.
      // Nothing here is generated, and the form says which one it used.
      if (firstCommit) { setTitle(firstCommit); setTitleSource("commit"); }
      else { setTitle(titleFromBranch(context.branch)); setTitleSource("branch"); }
    }
    if (!base) setBase(context.defaultBranch);
    setCreateSnapshot(createSnapshotOf(context));
    setCard("create");
  }

  function openPullRequestCard(next: "merge" | "ready") {
    if (card === next || !pullRequest) { setCard("none"); return; }
    setActionSnapshot(pullRequestSnapshotOf(pullRequest));
    // Archiving is re-chosen every time this opens; auto merge keeps whatever
    // it had, exactly as it did before archiving existed.
    if (next === "merge") setArchive(false);
    setCard(next);
  }

  const openOnGitHub = (url: string) => { void openUrl(url).catch(() => undefined); };

  /* ---------------- states where there is nothing to act on --------------- */

  if (!props.threadId) {
    return (
      <section className="thread-pr" aria-label="Pull request">
        <div className="thread-pr-empty">
          <GitPullRequest size={20} aria-hidden="true" />
          <strong>Start a thread to work on a pull request</strong>
          <span>Open or create a thread in this project, then attach an existing pull request or open a new one from here.</span>
        </div>
      </section>
    );
  }

  const state = pullRequest ? stateOf(pullRequest) : null;
  const checks = pullRequest ? checksLine(pullRequest.checks) : null;
  const review = pullRequest ? reviewLine(pullRequest.reviewDecision) : null;
  const headElsewhere = !!(pullRequest && context && pullRequest.headRefName !== context.branch);
  const canMarkReady = !!(pullRequest && props.onReady && pullRequest.isDraft && pullRequest.state === "OPEN");

  return (
    <section className="thread-pr" aria-label="Pull request">
      <header className="thread-pr-head">
        <span className="thread-pr-head-icon">{state ? <state.icon size={16} aria-hidden="true" /> : <GitPullRequest size={16} aria-hidden="true" />}</span>
        <div>
          <strong>Pull request</strong>
          {/* The repository is already the first context chip below. It is
              only repeated here when there are no chips to carry it. */}
          <small>{linked && pullRequest
            ? (context ? "Attached to this thread" : `Attached to this thread · ${pullRequest.repository}`)
            : context ? "No pull request yet" : "This thread has no pull request yet"}</small>
        </div>
        <button
          type="button"
          className="icon-button tiny"
          onClick={props.onRefresh}
          disabled={loading}
          aria-busy={loading}
          title="Check GitHub for the latest status"
          aria-label="Refresh pull request status"
        >
          {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </header>

      {/* Context first: which repository, which branch, and whether the files
          being changed are this thread's alone. */}
      {context ? (
        <div className="thread-pr-context">
          <span className="thread-pr-fact" title={context.repository}><GitFork size={11} aria-hidden="true" />{context.repository}</span>
          <span className="thread-pr-fact" title={`Current branch: ${context.branch}`}><GitBranch size={11} aria-hidden="true" />{context.branch}</span>
          <span className={`thread-pr-fact ${isolated ? "isolated" : "quiet"}`}>{isolated ? "Isolated worktree" : "Shared folder"}</span>
          {context.dirty && <span className="thread-pr-fact warn">Uncommitted changes</span>}
          {/* One fact, not two, and it names its baseline. Six equal pills in a
              265px dock wrapped to three rows of things that mostly were not
              warnings; the warnings above are what deserve that weight. */}
          {(context.ahead > 0 || context.behind > 0) && (
            <span className="thread-pr-fact quiet" title={`Last known, compared with ${context.defaultBranch}`}>
              {[
                context.ahead > 0 ? `${context.ahead} ahead` : null,
                context.behind > 0 ? `${context.behind} behind` : null,
              ].filter(Boolean).join(" · ")} of {context.defaultBranch}
            </span>
          )}
        </div>
      ) : (
        <div className="thread-pr-note" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>
            Mythra Code cannot read this folder's Git repository. Creating a pull request or a branch needs it.
            {linked ? " An attached pull request still works — it lives on GitHub, not in this folder." : " Refresh once it is readable, or connect GitHub in Settings."}
          </span>
        </div>
      )}

      {props.error && (
        <div className="thread-pr-note bad" role="alert">
          <CircleAlert size={13} aria-hidden="true" />
          <span>{props.error}</span>
          <button type="button" className="thread-pr-inline-button" onClick={props.onRefresh} disabled={loading}>Try again</button>
        </div>
      )}
      {props.notice && !props.error && (
        <div className="thread-pr-note good" role="status" aria-live="polite">
          <CircleCheck size={13} aria-hidden="true" />
          <span>{props.notice}</span>
        </div>
      )}
      {blocked && (
        <div className="thread-pr-note" role="status">
          <ShieldCheck size={13} aria-hidden="true" />
          <span>{blocked} Attaching and removing a pull request still work.</span>
        </div>
      )}

      {/* --------------------------- attached ---------------------------- */}

      {linked && pullRequest && state && checks && review && (
        <article className={`thread-pr-card ${state.key}`}>
          <div className="thread-pr-card-head">
            <span className={`thread-pr-state ${state.key}`}><state.icon size={12} aria-hidden="true" />{state.label}</span>
            <span className="thread-pr-number">#{pullRequest.number}</span>
          </div>
          <h4 className="thread-pr-title" title={pullRequest.title}>{pullRequest.title || "Untitled pull request"}</h4>
          <p className="thread-pr-refs" title={`${pullRequest.headRefName} into ${pullRequest.baseRefName}`}>
            <GitBranch size={11} aria-hidden="true" />
            <span>{pullRequest.headRefName}</span>
            <span aria-hidden="true">→</span>
            <span>{pullRequest.baseRefName}</span>
          </p>
          <dl className="thread-pr-signals">
            <div className={`thread-pr-signal ${checks.tone}`}>
              {checks.tone === "good" ? <CircleCheck size={12} aria-hidden="true" /> : checks.tone === "bad" ? <CircleAlert size={12} aria-hidden="true" /> : checks.tone === "wait" ? <Clock size={12} aria-hidden="true" /> : <CircleDot size={12} aria-hidden="true" />}
              <dt>Checks</dt><dd>{checks.text}</dd>
            </div>
            <div className={`thread-pr-signal ${review.tone}`}>
              {review.tone === "good" ? <CircleCheck size={12} aria-hidden="true" /> : review.tone === "bad" ? <CircleAlert size={12} aria-hidden="true" /> : <CircleDot size={12} aria-hidden="true" />}
              <dt>Review</dt><dd>{review.text}</dd>
            </div>
          </dl>

          {headElsewhere && (
            <div className="thread-pr-note" role="status">
              <TriangleAlert size={13} aria-hidden="true" />
              <span>This pull request is on <strong>{pullRequest.headRefName}</strong>, and this folder is on <strong>{context?.branch}</strong>. Everything below acts on the pull request, not on your current branch.</span>
            </div>
          )}

          {/* The merge happened on GitHub. Saying so, and saying what did not
              happen here, is the whole difference between a finished task and
              an hour spent wondering why the local branch looks unchanged. */}
          {pullRequest.state === "MERGED" && (
            <div className="thread-pr-note" role="status">
              <GitMerge size={13} aria-hidden="true" />
              <span>
                Merged into <strong>{pullRequest.baseRefName}</strong> on GitHub.
                {context
                  ? <> Your files here have not changed — this folder is still on <strong>{context.branch}</strong>.</>
                  : " Nothing in this folder was changed."}
                {props.onUpdateLocal ? " Bring the merged work down when you are ready." : ""}
              </span>
              {props.onUpdateLocal && (
                <button
                  type="button"
                  className="thread-pr-inline-button"
                  onClick={() => { void props.onUpdateLocal?.().catch(() => undefined); }}
                  disabled={busy || props.updateLocalBusy}
                  aria-busy={props.updateLocalBusy}
                  title={`Check out ${pullRequest.baseRefName} and fast-forward it from GitHub. Refused if this folder has uncommitted changes or has moved on.`}
                >
                  {props.updateLocalBusy
                    ? <><LoaderCircle className="spin" size={12} /> Updating…</>
                    : `Update local ${pullRequest.baseRefName}`}
                </button>
              )}
              {/* The retry, and the ordinary finish. A merge that GitHub
                  accepted is not undone by an archive that failed afterwards,
                  so the thread is left merged and the archive is offered again
                  here — which is also the only route for a pull request that
                  was merged on the website. */}
              {props.onArchiveMergedThread && (
                <button
                  type="button"
                  className="thread-pr-inline-button"
                  onClick={() => { void props.onArchiveMergedThread?.().catch(() => undefined); }}
                  disabled={busy || !!blocked || !!props.archiveBlockedReason}
                  title={props.archiveBlockedReason ?? blocked ?? "Move this thread to Archived. You can restore it from there, and its folder is left exactly as it is."}
                >
                  <Archive size={12} aria-hidden="true" /> Archive thread
                </button>
              )}
            </div>
          )}
          {pullRequest.state === "MERGED" && props.onArchiveMergedThread && props.archiveBlockedReason && (
            <p className="thread-pr-fineprint">{props.archiveBlockedReason}</p>
          )}
          {pullRequest.state === "MERGED" && props.updateLocalNotice && (
            <p className="thread-pr-fineprint">{props.updateLocalNotice}</p>
          )}

          <div className="thread-pr-actions">
            <button type="button" onClick={() => openOnGitHub(pullRequest.url)} title={`Open ${pullRequest.repository} #${pullRequest.number} in your browser, including its review comments`}>
              <ExternalLink size={13} aria-hidden="true" /> Open on GitHub
            </button>
            {canMarkReady && (
              <button
                type="button"
                className="primary"
                onClick={() => openPullRequestCard("ready")}
                aria-expanded={card === "ready"}
                disabled={busy}
              >
                <Send size={13} aria-hidden="true" /> Mark ready…
              </button>
            )}
            {pullRequest.state === "OPEN" && (
              <button
                type="button"
                className={canMarkReady ? "" : "primary"}
                onClick={() => openPullRequestCard("merge")}
                aria-expanded={card === "merge"}
                disabled={busy}
                title={`Merge #${pullRequest.number} on GitHub. Your files here do not change.${props.onMergeAndArchive ? " You can archive this thread in the same step." : ""}`}
              >
                {/* Named for where it happens. The worktree panel has a merge
                    of its own that changes local files, and one bare "Merge"
                    in each place is how the two got confused. */}
                <GitMerge size={13} aria-hidden="true" /> Merge on GitHub…
              </button>
            )}
            <button type="button" onClick={props.onDetach} disabled={!canAttach} title="Removes the link from this thread only. Nothing is closed or changed on GitHub.">
              <Unlink size={13} aria-hidden="true" /> Remove from thread
            </button>
          </div>

          {card === "ready" && actionSnapshot && (
            <ReadyConfirmation
              pullRequest={pullRequest}
              drift={pullRequestDrift(actionSnapshot, pullRequest)}
              busy={busy || pending === "ready"}
              mutationBlockedReason={blocked}
              onReview={() => setActionSnapshot(pullRequestSnapshotOf(pullRequest))}
              onCancel={() => setCard("none")}
              onConfirm={() => { if (props.onReady) void run("ready", props.onReady); }}
            />
          )}

          {card === "merge" && actionSnapshot && (
            <MergeConfirmation
              pullRequest={pullRequest}
              localBranch={context?.branch}
              methods={methods}
              method={chosenMethod}
              onMethod={setMethod}
              auto={auto}
              onAuto={(next) => { setAuto(next); if (next) setArchive(false); }}
              archiveOffered={!!props.onMergeAndArchive}
              archive={archive}
              onArchive={(next) => { setArchive(next); if (next) setAuto(false); }}
              archiveBlockedReason={props.archiveBlockedReason ?? null}
              drift={pullRequestDrift(actionSnapshot, pullRequest)}
              busy={busy || pending === "merge"}
              loading={loading}
              mutationBlockedReason={blocked}
              onRefresh={props.onRefresh}
              // The pull request moved. Both add-ons go back to off: they were
              // chosen about a revision that is no longer the one on screen.
              onReview={() => { setActionSnapshot(pullRequestSnapshotOf(pullRequest)); setAuto(false); setArchive(false); }}
              onCancel={() => setCard("none")}
              onConfirm={() => {
                if (!chosenMethod) return;
                const mergeAndArchive = props.onMergeAndArchive;
                if (archive && mergeAndArchive) void run("merge", () => mergeAndArchive(chosenMethod));
                else void run("merge", () => props.onMerge(chosenMethod, auto));
              }}
            />
          )}
        </article>
      )}

      {linked && !pullRequest && (
        <div className="thread-pr-note bad" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          <span>This thread has a pull request attached, but its status could not be loaded.</span>
          <button type="button" className="thread-pr-inline-button" onClick={props.onRefresh} disabled={loading}>Refresh</button>
          <button type="button" className="thread-pr-inline-button" onClick={props.onDetach} disabled={!canAttach}>Remove from thread</button>
        </div>
      )}

      {/* ------------------------- not attached -------------------------- */}

      {!linked && (
        <>
          {pullRequest && (
            <article className="thread-pr-card candidate">
              <div className="thread-pr-card-head">
                <span className="thread-pr-state found"><GitPullRequest size={12} aria-hidden="true" /> Found on this branch</span>
                <span className="thread-pr-number">#{pullRequest.number}</span>
              </div>
              <h4 className="thread-pr-title" title={pullRequest.title}>{pullRequest.title || "Untitled pull request"}</h4>
              <p className="thread-pr-refs" title={pullRequest.repository}><GitFork size={11} aria-hidden="true" /><span>{pullRequest.repository}</span></p>
              <p className="thread-pr-refs"><GitBranch size={11} aria-hidden="true" /><span>{pullRequest.headRefName}</span><span aria-hidden="true">→</span><span>{pullRequest.baseRefName}</span></p>
              <p className="thread-pr-fineprint">Found for the current branch. Not attached until you attach it.</p>
              <div className="thread-pr-actions">
                <button
                  type="button"
                  className="primary"
                  // The full URL, never a bare number: a candidate can live in
                  // a different repository than this folder points at, and a
                  // bare "#123" would be read against the wrong one.
                  onClick={() => void run("attach", () => props.onAttach(pullRequest.url || String(pullRequest.number)))}
                  disabled={!canAttach || pending === "attach"}
                  aria-busy={pending === "attach"}
                  title={`Attach ${pullRequest.repository} #${pullRequest.number} to this thread`}
                >
                  {pending === "attach" ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} aria-hidden="true" />} Attach to this thread
                </button>
                <button type="button" onClick={() => openOnGitHub(pullRequest.url)}><ExternalLink size={13} aria-hidden="true" /> Open on GitHub</button>
              </div>
            </article>
          )}

          {card !== "create" && <AttachByReference
            repository={context?.repository ?? pullRequest?.repository}
            value={reference}
            onChange={setReference}
            busy={pending === "attach"}
            disabled={!canAttach}
            onAttach={(value) => void run("attach", () => props.onAttach(value))}
          />}

          {/* Creating a pull request needs a branch of its own. On the default
              branch we offer the way out instead of a form that cannot work. */}
          {context && onDefaultBranch ? (
            <div className="thread-pr-slot">
              <div className="thread-pr-slot-head">
                <GitBranchPlus size={14} aria-hidden="true" />
                <div>
                  <strong>This folder is on {context.defaultBranch}</strong>
                  <small>A pull request needs its own branch. {isolated ? "This thread runs in an isolated worktree — pick or create one there." : "Create one here and this folder switches to it."}</small>
                </div>
              </div>
              {isolated ? (
                <button type="button" className="thread-pr-wide-button" onClick={props.onOpenWorktrees}>
                  <GitFork size={13} aria-hidden="true" /> Open worktrees
                </button>
              ) : (
                <div className="thread-pr-row">
                  <input
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder="feature/short-description"
                    aria-label="New branch name"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="thread-pr-wide-button"
                    onClick={() => void run("branch", () => props.onCreateBranch(branchName.trim()))}
                    disabled={!canChange || !branchName.trim() || pending === "branch"}
                    aria-busy={pending === "branch"}
                    title={blocked ?? "Create this branch and switch the folder to it"}
                  >
                    {pending === "branch" ? <LoaderCircle className="spin" size={13} /> : <GitBranchPlus size={13} aria-hidden="true" />} Create branch
                  </button>
                </div>
              )}
              {!isolated && <p className="thread-pr-fineprint">Every thread using this folder moves to the new branch too.</p>}
            </div>
          ) : context ? (
            <div className="thread-pr-slot">
              {/* Once the editor is open it is the heading. Leaving the button
                  above it gave the form two titles and two apparent primary
                  actions, one of which only closed it again. */}
              {card !== "create" && (
                <button
                  type="button"
                  className="thread-pr-wide-button primary"
                  onClick={openCreate}
                  aria-expanded={false}
                  disabled={busy}
                >
                  <GitPullRequest size={13} aria-hidden="true" /> Create a pull request
                </button>
              )}

              {card === "create" && createSnapshot && (
                <CreateEditor
                  context={context}
                  snapshot={createSnapshot}
                  drift={createDrift(createSnapshot, context)}
                  isolated={isolated}
                  title={title}
                  titleSource={titleSource}
                  onTitle={(value) => { setTitle(value); setTitleSource(null); }}
                  body={body} onBody={setBody}
                  base={base} onBase={setBase}
                  draft={draft} onDraft={setDraft}
                  commitAll={commitAll} onCommitAll={setCommitAll}
                  commitMessage={commitMessage} onCommitMessage={setCommitMessage}
                  busy={busy || pending === "create"}
                  loading={loading}
                  disabled={!canChange}
                  disabledReason={blocked}
                  onRefresh={props.onRefresh}
                  onReview={() => setCreateSnapshot(createSnapshotOf(context))}
                  onCancel={() => setCard("none")}
                  onSubmit={() => void run("create", () => props.onCreate({
                    // Head and expected revision come from the pinned
                    // snapshot, not from whatever context says at this instant.
                    head: createSnapshot.branch,
                    base: base.trim(),
                    title: title.trim(),
                    body,
                    draft,
                    // Never inferred: the box is off unless the person ticked
                    // it, and it cannot even be shown on a clean folder.
                    commitAll: context.dirty && commitAll,
                    commitMessage: context.dirty && commitAll ? (commitMessage.trim() || undefined) : undefined,
                    expectedHeadOid: createSnapshot.headOid,
                  }))}
                />
              )}
            </div>
          ) : null}

          {!context && (
            <div className="thread-pr-slot">
              <button type="button" className="thread-pr-wide-button" onClick={props.onOpenGitHubSettings}>
                <ShieldCheck size={13} aria-hidden="true" /> Open GitHub settings
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * A bounded, expandable list
 * ------------------------------------------------------------------ */

function BoundedList({ id, icon: Icon, label, items, count }: {
  id: string;
  icon: typeof FileDiff;
  label: string;
  items: string[];
  count: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items.slice(0, LIST_CEILING) : items.slice(0, LIST_PREVIEW);
  const hidden = count - shown.length;

  return (
    <div className="thread-pr-review-group">
      <p className="thread-pr-review-label" id={id}><Icon size={11} aria-hidden="true" /> {label} <b>{count}</b></p>
      {items.length > 0 && (
        <ul className="thread-pr-review-list" aria-labelledby={id}>
          {shown.map((item, index) => <li key={`${item}-${index}`} title={item}>{item}</li>)}
        </ul>
      )}
      {hidden > 0 && (
        expanded || items.length <= LIST_PREVIEW
          // Past the ceiling there is nothing useful left to render into a
          // 265px column, so the remainder is counted rather than listed.
          ? <p className="thread-pr-fineprint">and {hidden} more</p>
          : <button type="button" className="thread-pr-inline-button" onClick={() => setExpanded(true)}>Show all {count}</button>
      )}
    </div>
  );
}

/**
 * What a commit-and-push would actually sweep up.
 *
 * The counts are the part everyone needs, so they are always on screen; the
 * paths and commit subjects are detail for the people who want them, and
 * listing them is a lot of a 265px column to spend by default.
 */
function ChangeReview({ context }: { context: PullRequestContext }) {
  const [open, setOpen] = useState(false);
  const files = context.changedFiles ?? [];
  const fileCount = context.changedFileCount ?? files.length;
  const commits = context.commits ?? [];
  if (!fileCount && !commits.length) return null;

  const summary = [
    fileCount > 0 ? `${fileCount} uncommitted file${fileCount === 1 ? "" : "s"}` : null,
    commits.length > 0 ? `${commits.length} commit${commits.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="thread-pr-review">
      <button type="button" className="thread-pr-review-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} aria-hidden="true" />
        <span>{summary}</span>
      </button>
      {open && (
        <div className="thread-pr-review-body">
          {fileCount > 0 && <BoundedList id="thread-pr-files" icon={FileDiff} label="Uncommitted files" items={files} count={fileCount} />}
          {commits.length > 0 && <BoundedList id="thread-pr-commits" icon={GitCommitHorizontal} label="Commits on this branch" items={commits} count={commits.length} />}
        </div>
      )}
    </div>
  );
}

/** A form that was opened against a world that has since moved. */
function DriftNotice({ drift, onReview, onRefresh, loading, reviewLabel }: {
  drift: string;
  onReview: () => void;
  onRefresh?: () => void;
  loading?: boolean;
  reviewLabel: string;
}) {
  return (
    <div className="thread-pr-note bad" role="alert">
      <TriangleAlert size={13} aria-hidden="true" />
      <span>{drift} Nothing was sent, and what you typed is kept.</span>
      {onRefresh && <button type="button" className="thread-pr-inline-button" onClick={onRefresh} disabled={loading}>Refresh</button>}
      <button type="button" className="thread-pr-inline-button" onClick={onReview}>{reviewLabel}</button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Attach by number or link
 * ------------------------------------------------------------------ */

function AttachByReference({ repository, value, onChange, busy, disabled, onAttach }: {
  repository?: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  onAttach: (value: string) => void;
}) {
  const trimmed = value.trim();
  const parsed = trimmed ? parsePullRequestReference(trimmed, repository) : null;
  const unreadable = trimmed.length > 0 && !parsed;

  return (
    <form
      className="thread-pr-slot"
      onSubmit={(event) => { event.preventDefault(); if (parsed) onAttach(trimmed); }}
    >
      <label className="thread-pr-field" htmlFor="thread-pr-reference">
        <span>Attach an existing pull request</span>
        <input
          id="thread-pr-reference"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="#123 or https://github.com/owner/repo/pull/123"
          aria-label="Pull request number or link"
          aria-invalid={unreadable}
          spellCheck={false}
        />
      </label>
      {unreadable && <p className="thread-pr-fineprint bad" role="alert">Enter a pull request number like #123, or a full link to one.</p>}
      {parsed && <p className="thread-pr-fineprint">Attaches {parsed.repository} #{parsed.number} to this thread.</p>}
      <button
        type="submit"
        className="thread-pr-wide-button"
        disabled={disabled || !parsed || busy}
        aria-busy={busy}
        title="Link this pull request to the thread."
      >
        {busy ? <LoaderCircle className="spin" size={13} /> : <Link2 size={13} aria-hidden="true" />} Attach
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

function CreateEditor(props: {
  context: PullRequestContext;
  snapshot: CreateSnapshot;
  drift: string | null;
  isolated: boolean;
  title: string; titleSource: "commit" | "branch" | null; onTitle: (value: string) => void;
  body: string; onBody: (value: string) => void;
  base: string; onBase: (value: string) => void;
  draft: boolean; onDraft: (value: boolean) => void;
  commitAll: boolean; onCommitAll: (value: boolean) => void;
  commitMessage: string; onCommitMessage: (value: string) => void;
  busy: boolean;
  loading: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onRefresh: () => void;
  onReview: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { context, snapshot, drift, isolated, commitAll, busy, disabled } = props;
  const willCommit = context.dirty && commitAll;
  const base = props.base.trim();
  // The backend validates for real; this only stops an obviously impossible
  // submission from making the round trip.
  const baseProblem = !base
    ? "Choose a branch to merge into."
    : base === snapshot.branch
      ? "A pull request cannot merge a branch into itself."
      : null;
  const ready = props.title.trim().length > 0 && !baseProblem && !drift;

  return (
    <form
      className="thread-pr-editor"
      onSubmit={(event) => { event.preventDefault(); if (ready && !disabled && !busy) props.onSubmit(); }}
    >
      {/* The form owns its heading now that the button above it is gone. */}
      <div className="thread-pr-editor-head">
        <GitPullRequest size={14} aria-hidden="true" />
        <strong>New pull request</strong>
      </div>

      {/* Source is shown, not chosen: the branch the form was opened against
          is the branch the pull request comes from. */}
      <p className="thread-pr-refs strong" title={`${snapshot.branch} into ${base || "?"}`}>
        <GitBranch size={11} aria-hidden="true" />
        <span>{snapshot.branch}</span>
        <span aria-hidden="true">→</span>
        <span>{base || "?"}</span>
      </p>

      {drift && <DriftNotice drift={drift} onReview={props.onReview} onRefresh={props.onRefresh} loading={props.loading} reviewLabel="Use the current details" />}

      <ChangeReview context={context} />

      <label className="thread-pr-field" htmlFor="thread-pr-base">
        <span>Merge into</span>
        <input id="thread-pr-base" value={props.base} onChange={(event) => props.onBase(event.target.value)} placeholder={context.defaultBranch} aria-invalid={!!baseProblem} spellCheck={false} />
      </label>
      {baseProblem && <p className="thread-pr-fineprint bad" role="alert">{baseProblem}</p>}

      <label className="thread-pr-field" htmlFor="thread-pr-title">
        <span>Title</span>
        <input id="thread-pr-title" value={props.title} onChange={(event) => props.onTitle(event.target.value)} placeholder="What this change does" />
      </label>
      {props.titleSource && (
        <p className="thread-pr-fineprint">From {props.titleSource === "commit" ? "your first commit" : "the branch name"}. Edit it freely.</p>
      )}
      <label className="thread-pr-field" htmlFor="thread-pr-body">
        <span>Description <em>Optional</em></span>
        <textarea id="thread-pr-body" rows={4} value={props.body} onChange={(event) => props.onBody(event.target.value)} placeholder="Why the change exists, and anything a reviewer should know." />
      </label>

      <label className="thread-pr-check">
        <input type="checkbox" checked={props.draft} onChange={(event) => props.onDraft(event.target.checked)} />
        <span><strong>Open as a draft</strong><small>Reviewers are not requested yet. You can mark it ready here later.</small></span>
      </label>

      {/* The commit-everything box exists only when there is something
          uncommitted to commit, and it is never ticked on your behalf. */}
      {context.dirty ? (
        <>
          <label className="thread-pr-check">
            <input type="checkbox" checked={commitAll} onChange={(event) => props.onCommitAll(event.target.checked)} />
            <span>
              <strong>Commit every change in this folder first</strong>
              <small>{isolated ? "This worktree belongs to the thread." : "These changes belong to the folder, not to this thread alone — other threads using it share them."}</small>
            </span>
          </label>
          {commitAll && (
            <label className="thread-pr-field" htmlFor="thread-pr-commit-message">
              <span>Commit message <em>Optional</em></span>
              <input id="thread-pr-commit-message" value={props.commitMessage} onChange={(event) => props.onCommitMessage(event.target.value)} placeholder="Update project files" />
            </label>
          )}
        </>
      ) : null}

      {context.dirty && !commitAll && (
        <p className="thread-pr-fineprint">Uncommitted changes stay out of the pull request unless you tick the box above.</p>
      )}

      {/* Say what the one button is about to do, in order, before it is used. */}
      <div className="thread-pr-plan" aria-label="What this will do">
        <strong>When you continue</strong>
        <ol>
          {willCommit && <li>Commit every change in this folder as “{props.commitMessage.trim() || "Update project files"}”.</li>}
          <li>Push <b>{snapshot.branch}</b> to {context.pushRemote || "the remote"}.</li>
          <li>Open a {props.draft ? "draft " : ""}pull request into <b>{base || context.defaultBranch}</b>.</li>
        </ol>
      </div>

      <div className="thread-pr-actions end">
        <button type="button" onClick={props.onCancel} disabled={busy}>Cancel</button>
        <button
          type="submit"
          className="primary"
          disabled={disabled || !ready || busy}
          aria-busy={busy}
          title={props.disabledReason ?? (drift ? "Check the refreshed details first" : baseProblem ?? (props.title.trim() ? undefined : "Add a title first"))}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <GitPullRequest size={13} aria-hidden="true" />} {willCommit ? "Commit, push and create" : "Push and create"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Mark ready for review
 * ------------------------------------------------------------------ */

function ReadyConfirmation(props: {
  pullRequest: PullRequest;
  drift: string | null;
  busy: boolean;
  mutationBlockedReason: string | null;
  onReview: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { pullRequest, drift, busy } = props;
  const blocked = props.mutationBlockedReason;

  return (
    <div className={`thread-pr-editor confirm${blocked || drift ? " stopped" : ""}`} role="group" aria-label="Confirm mark ready for review">
      <p className="thread-pr-confirm-line">
        Mark <b>{pullRequest.repository} #{pullRequest.number}</b>
        {pullRequest.title ? <> — “{pullRequest.title}”</> : null} ready for review.
      </p>
      <p className="thread-pr-fineprint">It stops being a draft and becomes ready to review and merge. Nothing is merged now.</p>

      {drift && <DriftNotice drift={drift} onReview={props.onReview} reviewLabel="Use the current details" />}
      {blocked && (
        <ul className="thread-pr-blockers hard"><li><CircleAlert size={12} aria-hidden="true" />{blocked}</li></ul>
      )}

      <div className="thread-pr-actions end">
        <button type="button" onClick={props.onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="primary"
          onClick={props.onConfirm}
          disabled={!!blocked || !!drift || busy}
          aria-busy={busy}
          title={blocked ?? (drift ? "Check the refreshed details first" : undefined)}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : <Send size={13} aria-hidden="true" />} Mark ready for review
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

function MergeConfirmation(props: {
  pullRequest: PullRequest;
  /** The branch this folder is on, when the app can read it. */
  localBranch?: string | null;
  methods: PullRequestMergeMethod[];
  method: PullRequestMergeMethod | null;
  onMethod: (method: PullRequestMergeMethod) => void;
  auto: boolean;
  onAuto: (auto: boolean) => void;
  /** Whether the app can archive threads at all. */
  archiveOffered: boolean;
  archive: boolean;
  onArchive: (archive: boolean) => void;
  archiveBlockedReason: string | null;
  drift: string | null;
  busy: boolean;
  loading: boolean;
  mutationBlockedReason: string | null;
  onRefresh: () => void;
  onReview: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { pullRequest, methods, method, auto, archive, busy, drift } = props;
  const { hard, soft } = mergeBlockers(pullRequest, props.mutationBlockedReason);
  const stopped = hard.length > 0;
  // Auto merge is offered only where the repository is known to allow it.
  // Anything else — refused, or simply not reported — is explained instead.
  const autoAllowed = pullRequest.autoMergeAllowed === true;
  const permissionUnknown = pullRequest.viewerCanMerge === undefined;
  /**
   * Archiving rides on a merge that happens *now*. An auto merge is a request
   * GitHub may satisfy hours later, and there is no promise to keep it company
   * until then — so the two are offered as alternatives, never together, and a
   * pull request GitHub is not ready to merge cannot be archived through here
   * at all.
   */
  const archiveUnavailable = props.archiveBlockedReason
    ?? (auto ? "Not available with auto merge: archiving happens straight after a merge that runs now." : null)
    ?? (soft.length ? "Available once GitHub is ready to merge this now. An auto merge cannot carry it." : null);
  const archiving = props.archiveOffered && archive;

  // Unconfirmed merge permission is not a licence to try: an unknown answer
  // is refused until a refresh turns it into a real one. And `auto` can still
  // be ticked from a moment when the repository allowed it, so it is checked
  // against what the repository allows *now*, not against what it allowed when
  // the box was clicked. The same goes for a ticked archive that has since
  // become impossible.
  const canConfirm = !stopped && !drift && !busy && !!method
    && !permissionUnknown
    && (!auto || autoAllowed)
    && (auto || soft.length === 0)
    && (!archiving || !archiveUnavailable);

  return (
    <div className={`thread-pr-editor confirm${stopped || drift ? " stopped" : ""}`} role="group" aria-label="Confirm merge">
      {/* Name the thing being merged in full. Nobody should have to scroll up
          to learn what a "Merge" button is about to act on. */}
      <p className="thread-pr-confirm-line">
        Merge <b>{pullRequest.repository} #{pullRequest.number}</b>
        {pullRequest.title ? <> — “{pullRequest.title}”</> : null}
      </p>
      <p className="thread-pr-refs strong"><GitBranch size={11} aria-hidden="true" /><span>{pullRequest.headRefName}</span><span aria-hidden="true">→</span><span>{pullRequest.baseRefName}</span></p>

      {drift && <DriftNotice drift={drift} onReview={props.onReview} onRefresh={props.onRefresh} loading={props.loading} reviewLabel="Review the updated pull request" />}

      {(hard.length > 0 || soft.length > 0) && (
        <ul className={`thread-pr-blockers ${stopped ? "hard" : "soft"}`}>
          {(stopped ? hard : soft).map((reason) => (
            <li key={reason}>{stopped ? <CircleAlert size={12} aria-hidden="true" /> : <Clock size={12} aria-hidden="true" />}{reason}</li>
          ))}
        </ul>
      )}

      {!stopped && permissionUnknown && (
        <div className="thread-pr-note" role="status">
          <CircleDot size={13} aria-hidden="true" />
          <span>Your permission to merge in {pullRequest.repository} has not been confirmed. Refresh to check.</span>
          <button type="button" className="thread-pr-inline-button" onClick={props.onRefresh} disabled={props.loading}>Refresh</button>
        </div>
      )}

      {!stopped && (
        <>
          <fieldset className="thread-pr-methods">
            <legend>How to merge</legend>
            {methods.map((option) => (
              <label key={option} className="thread-pr-check">
                <input type="radio" name="thread-pr-merge-method" value={option} checked={method === option} onChange={() => props.onMethod(option)} />
                <span><strong>{MERGE_METHOD_LABELS[option]}</strong></span>
              </label>
            ))}
          </fieldset>

          {autoAllowed ? (
            <label className="thread-pr-check">
              <input
                type="checkbox"
                checked={auto}
                // The mirror of the archive box below: each one holds the other
                // back while it is on, and neither is ever cleared silently.
                disabled={busy || (!auto && archiving)}
                onChange={(event) => props.onAuto(event.target.checked)}
              />
              <span>
                <strong>Ask GitHub to merge it when it is ready</strong>
                <small>{!auto && archiving
                  ? "Not available while this thread is set to archive: archiving needs a merge that happens now."
                  : "Nothing merges now. GitHub merges it once its own requirements pass."}</small>
              </span>
            </label>
          ) : (
            <p className="thread-pr-fineprint">
              {pullRequest.autoMergeAllowed === false
                ? "Auto merge is not turned on for this repository."
                : "Auto merge support has not been confirmed yet. Refresh to check."}
            </p>
          )}

          {/* Finishing the thread, offered where the decision is already being
              made, and never taken on anyone's behalf: the box starts empty
              every time this confirmation opens. A box rather than a second
              button in the row above, because "Merge" and "Merge & archive"
              sitting side by side reads as two merges. */}
          {props.archiveOffered && (
            <label className="thread-pr-check">
              <input
                type="checkbox"
                checked={archive}
                // Always untickable, even once it has become unavailable —
                // otherwise a refresh could strand a ticked box behind a
                // disabled confirm button with no way back.
                disabled={busy || (!archive && !!archiveUnavailable)}
                onChange={(event) => props.onArchive(event.target.checked)}
              />
              <span>
                <strong>Archive this thread once it is merged</strong>
                <small>{archiveUnavailable ?? "It moves to Archived, where you can restore it. Its folder is left exactly as it is."}</small>
              </span>
            </label>
          )}

          {archiving && (
            <div className="thread-pr-plan" aria-label="What merging and archiving will do">
              <strong>When you continue</strong>
              <ol>
                <li>Merge <b>#{pullRequest.number}</b> into <b>{pullRequest.baseRefName}</b> on GitHub.</li>
                <li>Move this thread to <b>Archived</b>, where you can restore it.</li>
              </ol>
            </div>
          )}
        </>
      )}

      {/* The single most misread thing in this panel. A merge here is a change
          on GitHub and nothing else: no checkout moves, no file is rewritten,
          nothing is downloaded. Said before the button, not after it. */}
      {!stopped && (
        <p className="thread-pr-fineprint local-effect">
          <ShieldCheck size={11} aria-hidden="true" />
          <span>
            {auto ? "When GitHub merges it, nothing" : "Nothing"} on this Mac changes.
            {props.localBranch
              ? <> This folder stays on <b>{props.localBranch}</b>, and <b>{pullRequest.baseRefName}</b> here is not updated until you ask for it.</>
              : <> Your local <b>{pullRequest.baseRefName}</b> is not updated until you ask for it.</>}
            {archiving ? " Archiving puts the thread away; it does not move, change or delete its folder." : ""}
          </span>
        </p>
      )}

      <div className="thread-pr-actions end">
        <button type="button" onClick={props.onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="primary"
          onClick={props.onConfirm}
          disabled={!canConfirm}
          aria-busy={busy}
          title={stopped ? hard[0]
            : drift ? "Review the updated pull request first"
            : archiving && archiveUnavailable ? archiveUnavailable
            : soft.length && !auto ? soft[0]
            : archiving ? `Merge #${pullRequest.number} on GitHub, then move this thread to Archived. Nothing in its folder changes.`
            : undefined}
        >
          {busy ? <LoaderCircle className="spin" size={13} /> : auto ? <Clock size={13} aria-hidden="true" /> : archiving ? <Archive size={13} aria-hidden="true" /> : <GitMerge size={13} aria-hidden="true" />}
          {auto ? "Enable auto merge" : archiving ? `Merge #${pullRequest.number} and archive thread` : `Merge #${pullRequest.number} on GitHub`}
        </button>
      </div>
    </div>
  );
}

export const ThreadPullRequestPanel = memo(ThreadPullRequestPanelInner);

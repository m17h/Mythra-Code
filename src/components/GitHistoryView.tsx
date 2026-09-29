import { CircleAlert, GitCommitHorizontal, History, LoaderCircle, RefreshCw } from "lucide-react";
import { readTime, relativeAge } from "../lib/gitChanges";
import type { useProjectGitHistory } from "../hooks/useProjectGitHistory";
import type { StudioTab } from "../lib/studioTabs";

/**
 * Real Git commits on the checked-out branch, one bounded page at a time.
 * Deliberately not AI checkpoints or conversation undo: those are separate
 * tools with separate meanings, and this view links to them by name.
 */
export function GitHistoryView(props: {
  history: ReturnType<typeof useProjectGitHistory>;
  branch: string | null;
  /** The checkout's current commit, to notice when the list is out of date. */
  currentHeadOid: string | null;
  /** False while no checkout summary has arrived; null HEAD can mean unborn. */
  currentHeadKnown?: boolean;
  absent: boolean;
  onOpenTool?: (tab: StudioTab) => void;
}) {
  const { history } = props;
  const moved = Boolean(history.loaded && props.currentHeadKnown && props.currentHeadOid !== history.headOid);
  const pinnedHead = moved ? history.headOid?.slice(0, 7) : null;
  const listLabel = moved ? pinnedHead ? `Commits at ${pinnedHead}` : "Previously read commits"
    : props.branch ? `Commits on ${props.branch}` : "Commits";
  const freshness = readTime(history.loadedAt);
  return (
    <div className="git-history">
      <div className="git-view-toolbar">
        <div className="git-view-summary">
          <span><strong>Commits</strong>{moved ? pinnedHead ? <> at <code title={history.headOid ?? undefined}>{pinnedHead}</code></> : " previously read"
            : props.branch ? <> on <code title={props.branch}>{props.branch}</code></> : ""}</span>
          {freshness && <small>read {freshness}</small>}
        </div>
        {history.available && !props.absent && (
          <button type="button" className="icon-button tiny" onClick={history.reload} disabled={history.loading} aria-busy={history.loading} aria-label="Reload commit history" title="Read commit history again from the current commit">
            <RefreshCw size={13} className={history.loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        )}
      </div>

      {props.absent ? (
        <p className="git-changes-empty">Initialize Git to start recording commits.</p>
      ) : !history.available ? (
        <p className="git-changes-empty">Commit history is available for project folders.</p>
      ) : (
        <>
          {moved && (
            <div className="git-local-note" role="status">
              <GitCommitHorizontal size={13} aria-hidden="true" />
              <span>The branch has moved since this list was read.</span>
              <button type="button" className="thread-pr-inline-button" onClick={history.reload}>Show latest</button>
            </div>
          )}
          {history.error && (
            <div className="git-local-note bad" role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              <span>{history.error}</span>
              <button type="button" className="thread-pr-inline-button" onClick={history.retry}>Try again</button>
            </div>
          )}
          {!history.loaded && history.loading && (
            <p className="git-changes-empty" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Reading commits…</p>
          )}
          {history.loaded && history.entries.length === 0 && !history.error && !moved && (
            <p className="git-changes-empty">No commits yet. Your first commit will appear here.</p>
          )}
          {history.entries.length > 0 && (
            <ol className="git-history-list" aria-label={listLabel}>
              {history.entries.map((entry) => (
                <li key={entry.oid}>
                  <code className="git-history-oid" title={entry.oid}>{entry.shortOid}</code>
                  <div>
                    <strong title={entry.subject}>{entry.subject || "(no message)"}</strong>
                    <small>{entry.authorName}{relativeAge(entry.authoredAt) ? ` · ${relativeAge(entry.authoredAt)}` : ""}</small>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {history.truncated && <p className="git-fineprint">Some commit details were too large to list here.</p>}
          {history.hasMore && (
            <button type="button" className="github-secondary-button git-history-more" onClick={history.loadMore} disabled={history.loading} aria-busy={history.loading}>
              {history.loading ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null} Load older commits
            </button>
          )}
        </>
      )}

      <div className="git-history-tools">
        <History size={13} aria-hidden="true" />
        <p>
          This is your Git commit history. AI run snapshots live in <b>Checkpoints</b>, and isolated branches in <b>Worktrees</b>.
          Neither one rewrites these commits.
        </p>
        {props.onOpenTool && (
          <span className="git-history-links">
            <button type="button" className="thread-pr-inline-button" onClick={() => props.onOpenTool?.("checkpoints")}>Open Checkpoints</button>
            <button type="button" className="thread-pr-inline-button" onClick={() => props.onOpenTool?.("worktrees")}>Open Worktrees</button>
          </span>
        )}
      </div>
    </div>
  );
}

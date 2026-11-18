import { GitCommitHorizontal, History, LoaderCircle, RefreshCw } from "lucide-react";
import { relativeAge } from "../lib/gitChanges";
import { FriendlyGitError, GitUpdatedAt } from "./GitChangesView";
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
  return (
    <div className="git-history">
      <div className="git-view-toolbar">
        <div className="git-view-summary">
          <span><strong>Commits</strong>{moved ? pinnedHead ? <> at <code title={history.headOid ?? undefined}>{pinnedHead}</code></> : " previously read"
            : props.branch ? <> on <code title={props.branch}>{props.branch}</code></> : ""}</span>
          {history.loaded && <GitUpdatedAt at={history.loadedAt} />}
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
              <button type="button" className="thread-pr-inline-button" onClick={history.reload} disabled={history.loading} aria-busy={history.loading}>Show latest</button>
            </div>
          )}
          {history.error && <FriendlyGitError raw={history.error} onRetry={history.retry} />}
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
                  {/* The subject leads; the hash is a detail at the end of the meta line. */}
                  <div>
                    <strong title={entry.subject}>{entry.subject || "(no message)"}</strong>
                    <small>{entry.authorName}{relativeAge(entry.authoredAt) ? ` · ${relativeAge(entry.authoredAt)}` : ""} · <code className="git-history-oid" title={entry.oid}>{entry.shortOid}</code></small>
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

      {props.onOpenTool && (
        <p className="git-history-tools">
          <History size={12} aria-hidden="true" />
          <span>AI run snapshots are in <button type="button" className="thread-pr-inline-button" onClick={() => props.onOpenTool?.("checkpoints")}>Checkpoints</button>; isolated branches in <button type="button" className="thread-pr-inline-button" onClick={() => props.onOpenTool?.("worktrees")}>Worktree</button>.</span>
        </p>
      )}
    </div>
  );
}

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, FileWarning, LoaderCircle, Minus, Plus, RefreshCw, Undo2, ChevronRight } from "lucide-react";
import { AppActionMenu, type AppActionMenuItem } from "./AppActionMenu";
import { DISCARD_LABEL, DiffText } from "./DiffView";
import { HighlightedCode } from "./SyntaxCode";
import {
  CHANGE_AREA_LABELS,
  CHANGE_AREAS,
  changeKey,
  changeStatusLabel,
  discardBlockedReason,
  fileCount,
  groupChanges,
  partiallyStagedPaths,
  relativeAge,
  splitChangePath,
} from "../lib/gitChanges";
import type { GitChange, GitChangeArea } from "../lib/gitInspection";
import type { GitWorkspaceSnapshot } from "../lib/gitWorkspace";
import type { useProjectGitChanges } from "../hooks/useProjectGitChanges";

export type GitPathAction = "stage" | "unstage" | "revert";

/** Rows per group before "Show all". The list is bounded natively, but a few
 *  hundred interactive rows in a narrow dock is still a wall. */
const GROUP_PREVIEW = 120;

/** Group explanations live in the heading's tooltip, not under every heading. */
const AREA_HELP: Record<GitChangeArea, string> = {
  staged: "Included when you commit staged changes.",
  unstaged: "Edits to tracked files that are not staged yet.",
  untracked: "Files Git is not tracking yet.",
};

/** Re-renders now and then so "2 min ago" stays true while a panel is idle. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** "Updated just now" with the exact time on hover. */
export function GitUpdatedAt({ at, loading }: { at: number | null | undefined; loading?: boolean }) {
  const now = useNow();
  if (loading && !at) return <span className="git-updated-at" role="status"><LoaderCircle className="spin" size={11} aria-hidden="true" /> Reading…</span>;
  const age = at ? relativeAge(at, now) : null;
  if (!age || !at) return <span className="git-updated-at" />;
  return <span className="git-updated-at" title={`Read at ${new Date(at).toLocaleString()}`}>Updated {age}</span>;
}

/**
 * Git's own error text is for the details disclosure. The sentence people
 * read first names what happened in plain words.
 */
export function friendlyGitMessage(raw: string, fallback = "Couldn't read this folder's Git status."): string {
  if (/not a git repository/i.test(raw)) return "This folder isn't a Git repository.";
  if (/index\.lock|unable to create .*\.lock|another git process/i.test(raw)) return "Another Git command is using this repository. Try again in a moment.";
  if (/dubious ownership|safe\.directory/i.test(raw)) return "Git doesn't trust this folder because another user owns it.";
  if (/program not found|command not found|no such file or directory.*git|failed to spawn/i.test(raw)) return "Git couldn't be started. Check that Git is installed.";
  if (/permission denied/i.test(raw)) return "Git doesn't have permission to read this folder.";
  if (/timed? ?out/i.test(raw)) return "Git took too long to answer. Try again.";
  return fallback;
}

export function FriendlyGitError({ raw, onRetry, fallback }: { raw: string; onRetry?: () => void; fallback?: string }) {
  const message = friendlyGitMessage(raw, fallback);
  return (
    <div className="git-local-note bad git-friendly-error" role="alert">
      <CircleAlert size={13} aria-hidden="true" />
      <div>
        <span>{message}</span>
        {raw.trim() && raw.trim() !== message && <details><summary className="lm-summary"><ChevronRight size={12} aria-hidden="true" className="lm-chevron" />Details</summary><code>{raw.trim()}</code></details>}
      </div>
      {onRetry && <button type="button" className="thread-pr-inline-button" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export interface GitChangesViewProps {
  changes: ReturnType<typeof useProjectGitChanges>;
  snapshot: GitWorkspaceSnapshot | null;
  absent: boolean;
  mutationDisabled: boolean;
  mutationDisabledReason: string;
  onPathAction?: (action: GitPathAction, path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  moreItems: AppActionMenuItem[];
  commit: ReactNode;
  /** The surrounding panel already offers Refresh. */
  hideRefresh?: boolean;
  /** The surrounding panel already shows the summary, freshness and More menu. */
  hideToolbar?: boolean;
  /** +added −removed lines per path, when the panel has a diff against HEAD. */
  lineCounts?: ReadonlyMap<string, { additions: number; deletions: number }>;
  /** Shown with the clean state, e.g. a Push for saved commits. */
  cleanNote?: ReactNode;
}

export function GitChangesView(props: GitChangesViewProps) {
  const { changes: state, snapshot } = props;
  const listed = state.changes;
  const rows = listed?.rows ?? [];
  const groups = groupChanges(rows);
  const partial = partiallyStagedPaths(rows);
  const staged = listed?.stagedFiles ?? snapshot?.stagedFiles ?? 0;
  const changed = listed?.changedFiles ?? snapshot?.changedFiles ?? 0;
  const canUnstageAll = !listed && !snapshot ? true : staged > 0;
  const canStageAll = !listed ? true : listed.unstagedFiles + listed.untrackedFiles > 0;

  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches("[data-change-row]")) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-change-row]")];
    const index = all.indexOf(target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= all.length) return;
    event.preventDefault();
    all[next].focus();
  };

  return (
    <div className="git-changes">
      {props.commit}

      {!props.hideToolbar && <div className="git-view-toolbar">
        <div className="git-view-summary">
          {props.absent
            ? <span>No repository yet</span>
            : state.loading && !listed
              ? <span><LoaderCircle className="spin" size={12} aria-hidden="true" /> Reading changes…</span>
              : <span><strong>{changed ? fileCount(changed) : "No changes"}</strong>{staged ? ` · ${staged} staged` : ""}</span>}
          {listed && <GitUpdatedAt at={state.loadedAt} />}
        </div>
        {state.available && !props.absent && !props.hideRefresh && (
          <button
            type="button"
            className="icon-button tiny"
            onClick={state.refresh}
            disabled={state.loading}
            aria-busy={state.loading}
            aria-label="Refresh changes"
            title="Read this folder's changes again"
          >
            <RefreshCw size={13} className={state.loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        )}
        <AppActionMenu compact ariaLabel="More Git actions" items={props.moreItems} />
      </div>}

      {props.hideToolbar && state.loading && !listed && !props.absent && !state.error && (
        <p className="git-changes-loading" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Reading changes…</p>
      )}

      {state.error && !props.absent && <FriendlyGitError raw={state.error} onRetry={state.refresh} />}

      {listed?.truncated && (
        <p className="git-fineprint">This folder has more changes than Mythra Code lists at once. Counts are at least what is shown; use the terminal for the complete list.</p>
      )}

      {state.available && listed && rows.length === 0 && !state.error && (
        <div className="studio-empty git-clean-state">
          <CheckCircle2 size={20} aria-hidden="true" />
          <strong>No changes</strong>
          <span>Everything matches the last commit.</span>
          {props.cleanNote}
        </div>
      )}

      {rows.length > 0 && (
        <div className="git-change-groups" onKeyDown={moveFocus}>
          {CHANGE_AREAS.map((area) => groups[area].length > 0 && (
            <ChangeGroup
              key={area}
              area={area}
              rows={groups[area]}
              allRows={rows}
              partial={partial}
              state={state}
              mutationDisabled={props.mutationDisabled}
              mutationDisabledReason={props.mutationDisabledReason}
              onPathAction={props.onPathAction}
              lineCounts={props.lineCounts}
              bulk={area === "staged"
                ? { label: "Unstage all", icon: Minus, run: props.onUnstageAll, enabled: canUnstageAll, title: "Keep every edit, but take it all out of the next commit" }
                : { label: "Stage all", icon: Plus, run: props.onStageAll, enabled: canStageAll, title: "Stage every unstaged and new file" }}
            />
          ))}
        </div>
      )}

    </div>
  );
}

function ChangeGroup(props: {
  area: GitChangeArea;
  rows: GitChange[];
  allRows: GitChange[];
  partial: Set<string>;
  state: GitChangesViewProps["changes"];
  mutationDisabled: boolean;
  mutationDisabledReason: string;
  onPathAction?: (action: GitPathAction, path: string) => void;
  lineCounts?: GitChangesViewProps["lineCounts"];
  bulk: { label: string; icon: typeof Plus; run: () => void; enabled: boolean; title: string };
}) {
  const { area, rows, state } = props;
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const shown = expanded ? rows : rows.slice(0, GROUP_PREVIEW);
  const Bulk = props.bulk.icon;
  // Only one group carries the bulk action for unstaged + new files.
  const showBulk = area === "staged" || area === "unstaged" || !props.allRows.some((row) => row.area === "unstaged");
  return (
    <section className={`git-change-group ${area}`} aria-labelledby={headingId}>
      <header>
        <h3 id={headingId} title={AREA_HELP[area]}>{CHANGE_AREA_LABELS[area]} <b>{rows.length}</b></h3>
        {showBulk && (
          <button
            type="button"
            className="git-row-action"
            onClick={props.bulk.run}
            disabled={props.mutationDisabled || !props.bulk.enabled}
            title={props.mutationDisabled ? props.mutationDisabledReason : props.bulk.title}
          ><Bulk size={12} aria-hidden="true" /> {props.bulk.label}</button>
        )}
      </header>
      <ul>
        {shown.map((row) => (
          <ChangeRow
            key={changeKey(row)}
            row={row}
            allRows={props.allRows}
            partial={props.partial.has(row.path)}
            selected={state.selected?.path === row.path && state.selected.area === row.area}
            state={state}
            mutationDisabled={props.mutationDisabled}
            mutationDisabledReason={props.mutationDisabledReason}
            onPathAction={props.onPathAction}
            // A file both staged and not staged has one HEAD-relative count, which
            // describes neither area alone: show no numbers rather than wrong ones.
            counts={row.area === "untracked" || props.partial.has(row.path) ? undefined : props.lineCounts?.get(row.path)}
          />
        ))}
      </ul>
      {rows.length > shown.length && (
        <button type="button" className="thread-pr-inline-button" onClick={() => setExpanded(true)}>Show all {rows.length}</button>
      )}
    </section>
  );
}

function ChangeRow(props: {
  row: GitChange;
  allRows: GitChange[];
  partial: boolean;
  selected: boolean;
  state: GitChangesViewProps["changes"];
  mutationDisabled: boolean;
  mutationDisabledReason: string;
  onPathAction?: (action: GitPathAction, path: string) => void;
  counts?: { additions: number; deletions: number };
}) {
  const { row, state, selected } = props;
  const { name, directory } = splitChangePath(row.path);
  const status = changeStatusLabel(row);
  const previewId = useId();
  const discardReason = discardBlockedReason(row, props.allRows);
  const index: GitPathAction = row.area === "staged" ? "unstage" : "stage";
  const actionsUnavailable = props.mutationDisabled || !props.onPathAction;
  const reason = props.onPathAction ? props.mutationDisabledReason : "Per-file actions are unavailable here.";
  return (
    <li className={`git-change-row${selected ? " selected" : ""}`}>
      <div className="git-change-line">
        <button
          type="button"
          className="git-change-select"
          data-change-row=""
          aria-expanded={selected}
          aria-controls={selected ? previewId : undefined}
          aria-label={`${row.path}, ${status}${row.originalPath ? ` from ${row.originalPath}` : ""}, ${CHANGE_AREA_LABELS[row.area].toLowerCase()}${props.counts && (props.counts.additions > 0 || props.counts.deletions > 0) ? `, ${props.counts.additions} lines added, ${props.counts.deletions} removed` : ""}`}
          title={row.originalPath ? `${row.originalPath} → ${row.path}` : row.path}
          onClick={() => state.select(selected ? null : { path: row.path, area: row.area })}
        >
          <span className={`git-change-status s-${row.status === "?" ? "new" : row.status}`} aria-hidden="true">{row.status === "?" ? "N" : row.status}</span>
          <span className="git-change-name">{name}</span>
          {(directory || row.originalPath || props.partial) && (
            <span className="git-change-sub">
              {directory && <span className="git-change-dir">{directory}</span>}
              {row.originalPath && <span className="git-change-from">from {row.originalPath}</span>}
              {props.partial && <span className="git-change-chip">{row.area === "staged" ? "+ newer edits" : "partly staged"}</span>}
            </span>
          )}
          {props.counts && (props.counts.additions > 0 || props.counts.deletions > 0) && (
            <span className="git-change-counts" aria-hidden="true">
              <ins>+{props.counts.additions}</ins><del>−{props.counts.deletions}</del>
            </span>
          )}
        </button>
        <button
          type="button"
          className="git-row-action"
          onClick={() => props.onPathAction?.(index, row.path)}
          disabled={actionsUnavailable}
          title={actionsUnavailable ? reason : index === "stage" ? `Stage ${row.path}` : `Unstage ${row.path}; the edits are kept`}
          aria-label={`${index === "stage" ? "Stage" : "Unstage"} ${row.path}`}
        >{index === "stage" ? <Plus size={12} aria-hidden="true" /> : <Minus size={12} aria-hidden="true" />}<span>{index === "stage" ? "Stage" : "Unstage"}</span></button>
        {!discardReason && (
          <button
            type="button"
            className="git-row-action danger"
            onClick={() => props.onPathAction?.("revert", row.path)}
            disabled={actionsUnavailable}
            title={actionsUnavailable ? reason : `${DISCARD_LABEL} Throws away the staged and unstaged edits to ${row.path}. Asks first.`}
            aria-label={`Discard local changes to ${row.path}…`}
          ><Undo2 size={12} aria-hidden="true" /></button>
        )}
      </div>
      {selected && (
        <div className="git-change-preview" id={previewId} role="region" aria-label={`Changes in ${row.path}`}>
          <ChangePreview state={state} row={row} discardReason={discardReason} />
        </div>
      )}
    </li>
  );
}

function ChangePreview({ state, row, discardReason }: { state: GitChangesViewProps["changes"]; row: GitChange; discardReason: string | null }) {
  const key = changeKey(row);
  const diff = state.diffKey === key ? state.diff : null;
  return (
    <>
      <p className="git-change-meta">
        {changeStatusLabel(row)} · {row.area === "staged" ? "what the next staged commit records" : row.area === "untracked" ? "file contents; Git does not track it yet" : "edits not staged yet"}
        {row.originalPath ? ` · renamed from ${row.originalPath}` : ""}
      </p>
      {discardReason && <p className="git-change-meta muted">{discardReason}</p>}
      {state.diffKey === key && state.diffLoading && !diff && (
        <p className="git-change-meta" role="status"><LoaderCircle className="spin" size={12} aria-hidden="true" /> Loading preview…</p>
      )}
      {state.diffKey === key && state.diffError && (
        <p className="git-change-meta bad" role="alert"><CircleAlert size={12} aria-hidden="true" /> {state.diffError}</p>
      )}
      {diff && diff.binary && (
        <p className="git-change-meta"><FileWarning size={12} aria-hidden="true" /> Binary file — no text preview.</p>
      )}
      {diff && diff.truncated && (
        <p className="git-change-meta"><FileWarning size={12} aria-hidden="true" /> Preview cut off at 512 KiB. The whole file is still what Git will stage and commit.</p>
      )}
      {diff && !diff.binary && (
        row.area === "untracked"
          ? <pre className="diff-view git-change-raw" tabIndex={0} role="region" aria-label={`New file contents for ${row.path}`}>{diff.text ? <HighlightedCode code={diff.text} path={row.path} /> : "Empty file."}</pre>
          : diff.text.trim()
            ? <DiffText text={diff.text} initialLines={300} path={row.path} scrollLabel={`Diff preview for ${row.path}`} />
            : <p className="git-change-meta">No textual difference (for example, only file mode changed).</p>
      )}
    </>
  );
}

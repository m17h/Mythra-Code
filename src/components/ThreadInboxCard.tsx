import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  CornerDownRight,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Pin,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import { workerStatusFromAgentRecord } from "../lib/subAgentActivity";
import type { ParentRunPhase } from "../lib/parentRun";
import type { PullRequest } from "../lib/pullRequests";
import type { Provider } from "../types";
import { ThreadTitle } from "./ThreadTitle";
import { ProviderLogo } from "./BrandLogos";
import { ScheduledCountBadge } from "./ScheduledCountBadge";
import { PixelWorkingMark } from "./PixelWorkingMark";
import { formatWorkingDuration, visibleWorkingDuration } from "../lib/sidebarAttention";

/** Wraps each case-insensitive occurrence of the search words in <mark>. */
export function highlightMatches(text: string, query: string): ReactNode {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return text;
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (let from = lower.indexOf(term); from !== -1; from = lower.indexOf(term, from + term.length)) ranges.push([from, from + term.length]);
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={from}>{text.slice(from, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Only what a card can show. Deliberately not the whole pull request: the
 *  inbox renders hundreds of these, and a card that accepted the full object
 *  would invite someone to put checks and review state on it. */
export type ThreadCardPullRequest = Pick<PullRequest, "number" | "repository" | "state" | "isDraft">;

export { formatWorkingDuration };

export function compactDirectory(path: string, segments = 2): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return path || "No directory";
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return "/";
  return parts.slice(-Math.max(1, segments)).join("/");
}

function WorkingDuration({ startedAt, active }: { startedAt: number; active: boolean }) {
  const [label, setLabel] = useState(() => visibleWorkingDuration(Date.now() - startedAt));
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    let disposed = false;
    // Wait for real geometry when supported; hidden/offscreen rows need no clock.
    let onScreen = typeof IntersectionObserver !== "function";
    const sync = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (disposed || !onScreen || document.hidden) return;
      const elapsed = Date.now() - startedAt;
      setLabel(visibleWorkingDuration(elapsed));
      if (!Number.isFinite(elapsed)) return;
      // Below a minute the label shows seconds; afterwards it shows minutes,
      // including the hours/minutes form. Align to the next displayed boundary.
      const precision = elapsed < 60_000 ? 1_000 : 60_000;
      // A clock rollback can put the start in the future. Recheck promptly
      // so correcting the wall clock does not strand this label at zero.
      const delay = elapsed < 0 ? 1_000 : precision - elapsed % precision;
      timer = window.setTimeout(sync, Math.min(delay, 2_147_483_647));
    };
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1]?.isIntersecting ?? false;
          sync();
        })
      : null;
    // Observe the status pill, not this label: the label is hidden for the
    // first seconds, and a hidden element never reports itself on screen.
    const host = hostRef.current?.parentElement ?? hostRef.current;
    if (host) observer?.observe(host);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [active, startedAt]);
  return <span ref={hostRef} className="thread-card-duration" hidden={!label}>{label}</span>;
}

/** What another machine reports for one thread. A card given this never reads
 * this machine's task store, where the same id could mean something else. */
export interface ThreadCardPresence { status: string; startedAt?: number; approvals: number; unread: boolean }

/** `fallback` fills the status slot when there is no live status (the
 * "Unavailable" mark of a thread that failed to open). */
function ThreadInboxStatus({ threadId, id, active, presence, fallback = null }: { threadId: string; id: string; active: boolean; presence?: ThreadCardPresence; fallback?: ReactNode }) {
  const storedStatus = useTaskStore((state) => state.statuses[threadId] ?? "idle");
  const storedStartedAt = useTaskStore((state) => state.tasks[threadId]?.workingStartedAt);
  const storedApprovalCount = useTaskStore((state) => state.tasks[threadId]?.approvals.length ?? 0);
  const storedUnread = useTaskStore((state) => Boolean(state.tasks[threadId]?.unread));
  const storedParentPhase = useTaskStore((state) => state.parentRuns[threadId]?.phase);
  const storedUncertainStart = useTaskStore((state) => state.statuses[threadId] === "starting"
    && state.parentRuns[threadId]?.phase === "paused" && state.parentRuns[threadId]?.pause?.reason === "start_uncertain");
  const status = presence ? presence.status : storedStatus;
  const startedAt = presence ? presence.startedAt : storedStartedAt;
  const approvalCount = presence ? presence.approvals : storedApprovalCount;
  const unread = presence ? presence.unread : storedUnread;
  const parentPhase = presence ? undefined : storedParentPhase;
  const uncertainStart = presence ? false : storedUncertainStart;

  if (approvalCount > 0) {
    return (
      <span id={id} className="thread-card-status approval">
        Needs approval
      </span>
    );
  }
  if (uncertainStart) {
    return <span id={id} className="thread-card-status approval">Status unknown</span>;
  }
  if (status === "starting" || status === "running") {
    return (
      <span id={id} className="thread-card-status working">
        <PixelWorkingMark className="thread-card-working-mark" />
        <span>{status === "starting" ? "Starting" : "Working"}</span>
        {status === "running" && startedAt !== undefined && <WorkingDuration startedAt={startedAt} active={active} />}
      </span>
    );
  }
  if (parentPhase === "waiting") {
    return <span id={id} className="thread-card-status">Waiting</span>;
  }
  if (parentPhase === "paused") {
    return <span id={id} className="thread-card-status approval">Needs input</span>;
  }
  if (status === "error") {
    return <span id={id} className="thread-card-status error">Failed</span>;
  }
  if (unread) {
    return <span id={id} className="thread-card-status done">Done</span>;
  }
  return <>{fallback}</>;
}

/**
 * The saved pull request, read the same way the dock panel reads it.
 *
 * The mapping is repeated here rather than imported from the panel on purpose:
 * the panel ships with its own stylesheet and is loaded with the Git dock, and
 * importing from it would drag that CSS into the inbox for one 40px pill.
 */
export function threadCardPullRequestState(pullRequest: ThreadCardPullRequest) {
  if (pullRequest.state === "MERGED") return { key: "merged", label: "Merged", icon: GitMerge };
  if (pullRequest.state === "CLOSED") return { key: "closed", label: "Closed", icon: GitPullRequestClosed };
  if (pullRequest.isDraft) return { key: "draft", label: "Draft", icon: GitPullRequestDraft };
  return { key: "open", label: "Open", icon: GitPullRequest };
}

/**
 * The attached pull request, as a fact in the metadata row.
 *
 * It is a span, not a button: the whole card is already one button, and a
 * nested control inside it is neither reachable nor announceable. The number
 * carries the ellipsis, so an implausibly long one shrinks to "#123…" rather
 * than pushing the provider mark off the row.
 */
function ThreadCardPullRequestBadge({ pullRequest }: { pullRequest: ThreadCardPullRequest }) {
  const state = threadCardPullRequestState(pullRequest);
  const description = `${pullRequest.repository} #${pullRequest.number} · ${state.label}`;
  return (
    <span
      className={`thread-card-pr ${state.key}`}
      role="img"
      aria-label={`Pull request ${description}`}
      title={description}
    >
      <state.icon size={11} aria-hidden="true" />
      <span className="thread-card-pr-number">#{pullRequest.number}</span>
    </span>
  );
}

interface ThreadInboxCardProps {
  threadId: string;
  title: string;
  titlePending?: boolean;
  /** Renderer-owned first send, before the provider assigns a thread ID. */
  pendingStatus?: "starting" | "stopping";
  workspaceName: string;
  directory: string;
  provider: Provider;
  providerName: string;
  pinned: boolean;
  isolated?: boolean;
  branch?: string;
  /** The pull request saved against this thread, when there is one. */
  pullRequest?: ThreadCardPullRequest | null;
  scheduledPromptCount?: number;
  /** Sub-agents only: who started this child, spoken after the title. */
  parentLabel?: string;
  /** Sub-agents only: the direct parent, when it is not the group's parent. */
  parentVia?: string;
  /** Main cards only: this parent's descendants, independent of inbox filters. */
  subAgentIds?: readonly string[];
  nativeAgents?: Readonly<Record<string, { status?: string }>>;
  /** Whether the inbox surface is open and uncovered. Geometry/document
   * visibility additionally suspend the working-duration clock. */
  active?: boolean;
  /** Set for a thread on another machine. */
  presence?: ThreadCardPresence;
  /** The thread on screen; announced as the current page. */
  current?: boolean;
  /** The sidebar search, highlighted in the title. */
  highlight?: string;
  /** The last open failed; the row stays (with its title) until dismissed. */
  unavailable?: boolean;
  onOpen: () => void;
}

/** Lifecycle class for the card shell: `live` breathes in the provider's
 * accent while a task runs, `settled` replays the completion sweep when a
 * turn finishes with unread output. */
function threadCardLifecycle(status: string, unread: boolean, approvals: number, parentPhase?: ParentRunPhase, uncertainStart = false): string {
  if (approvals > 0) return "attention";
  if (uncertainStart) return "attention";
  if (status === "starting" || status === "running") return "live";
  if (parentPhase === "paused") return "attention";
  if (parentPhase === "waiting") return "waiting";
  if (status === "error") return "faulted";
  if (unread) return "settled";
  return "";
}

export const ThreadInboxCard = memo(function ThreadInboxCard({
  threadId,
  title,
  titlePending = false,
  pendingStatus,
  workspaceName,
  directory,
  provider,
  providerName,
  pinned,
  isolated = false,
  branch,
  pullRequest = null,
  scheduledPromptCount = 0,
  parentLabel,
  parentVia,
  subAgentIds,
  nativeAgents,
  active = true,
  presence,
  current = false,
  highlight = "",
  unavailable = false,
  onOpen,
}: ThreadInboxCardProps) {
  const statusId = useId();
  const workingSubAgents = useTaskStore((state) => {
    let count = 0;
    for (const id of subAgentIds ?? []) {
      const status = state.statuses[id];
      if (status === "starting" || status === "running") count++;
      else if (!status || status === "idle") {
        const nativeStatus = workerStatusFromAgentRecord(nativeAgents?.[id]?.status ?? "");
        if (nativeStatus === "starting" || nativeStatus === "working") count++;
      }
    }
    return count;
  });
  const subAgentLabel = subAgentIds?.length
    ? `${workingSubAgents} sub-agent${workingSubAgents === 1 ? "" : "s"} working`
    : null;
  const storedLifecycle = useTaskStore((state) => threadCardLifecycle(
    state.statuses[threadId] ?? "idle",
    Boolean(state.tasks[threadId]?.unread),
    state.tasks[threadId]?.approvals.length ?? 0,
    state.parentRuns[threadId]?.phase,
    state.statuses[threadId] === "starting" && state.parentRuns[threadId]?.phase === "paused"
      && state.parentRuns[threadId]?.pause?.reason === "start_uncertain",
  ));
  const lifecycle = pendingStatus ? "live" : presence ? threadCardLifecycle(presence.status, presence.unread, presence.approvals) : unavailable && !storedLifecycle ? "unavailable" : storedLifecycle;
  // A labelled button hides its own contents from a screen reader, so the pill
  // below would otherwise be seen by sighted people only. It is named here too.
  const accessibleTitle = titlePending ? "Generating title" : title;
  const openLabel = `${unavailable ? "Retry opening" : "Open"} ${accessibleTitle}${parentLabel ? ` · ${parentLabel}` : ""}${subAgentLabel ? ` · ${subAgentLabel}` : ""}`;
  const statusNode = pendingStatus ? <span id={statusId} className="thread-card-status working">
    <PixelWorkingMark className="thread-card-working-mark" live={pendingStatus === "starting"} />
    <span>{pendingStatus === "stopping" ? "Stopping" : "Starting"}</span>
  </span> : <ThreadInboxStatus threadId={threadId} id={statusId} active={active} presence={presence}
    fallback={unavailable ? <span id={statusId} className="thread-card-status unavailable" title="Couldn’t be opened last time. Open it to try again.">Unavailable</span> : null} />;
  const baseLabel = pullRequest
    ? `${openLabel} · Pull request #${pullRequest.number} in ${pullRequest.repository}, ${threadCardPullRequestState(pullRequest).label}`
    : openLabel;
  const label = scheduledPromptCount > 0
    ? `${baseLabel} · ${scheduledPromptCount} scheduled prompt${scheduledPromptCount === 1 ? "" : "s"} in this thread`
    : baseLabel;
  // The inbox card, as before round 1: the title (with its pin and provider
  // mark) on the first line; the folder or branch, and the live status, on
  // the second. The status never shrinks; the folder name gives way first.
  return (
    <button className={`thread-card ${lifecycle} provider-${provider}`} onClick={onOpen} aria-label={label} aria-current={current ? "page" : undefined} aria-describedby={lifecycle ? statusId : undefined}>
      <span className="thread-card-context">
        {subAgentLabel ? <span className="thread-card-workspace thread-card-subagents" title={subAgentLabel}>
          <Folder size={14} aria-hidden="true" />
          <span>{subAgentLabel}</span>
        </span> : <span className="thread-card-workspace" title={directory}>
          {isolated ? <GitBranch size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
          <span>{isolated ? branch || "Isolated" : workspaceName}</span>
        </span>}
        {statusNode}
      </span>
      {highlight.trim() && !titlePending
        ? <span className="thread-title thread-card-title" data-state="settled"><span className="thread-title-text">{highlightMatches(title, highlight)}</span></span>
        : <ThreadTitle className="thread-card-title" title={title} pending={titlePending} />}
      {parentVia && (
        <span className="thread-card-via" title={`Started by ${parentVia}`}>
          <CornerDownRight size={11} aria-hidden="true" />
          <span>via {parentVia}</span>
        </span>
      )}
      <span className="thread-card-meta">
        <span className="thread-card-directory" title={directory}>{compactDirectory(directory)}</span>
        {/* After the directory, not before the title: the pull request is
            context for the work, and the work's name comes first. */}
        {pullRequest && <ThreadCardPullRequestBadge pullRequest={pullRequest} />}
        <ScheduledCountBadge threadPrompts={scheduledPromptCount} label={`${scheduledPromptCount} scheduled prompt${scheduledPromptCount === 1 ? "" : "s"} in this thread`} />
        {pinned && <Pin className="thread-card-pin" size={12} aria-label="Pinned" />}
        <span className={`thread-card-provider ${provider}`} title={`${providerName} thread`} aria-label={`${providerName} thread`}>
          <ProviderLogo provider={provider} size={provider === "claude" ? 14 : 13} />
        </span>
      </span>
    </button>
  );
});

import { useEffect, useState } from "react";
import {
  CircleDashed,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Pin,
} from "lucide-react";
import { useTaskStore } from "../lib/taskStore";
import type { PullRequest } from "../lib/pullRequests";
import type { Provider } from "../types";
import { ThreadTitle } from "./ThreadTitle";
import { ProviderLogo } from "./BrandLogos";

/** Only what a card can show. Deliberately not the whole pull request: the
 *  inbox renders hundreds of these, and a card that accepted the full object
 *  would invite someone to put checks and review state on it. */
export type ThreadCardPullRequest = Pick<PullRequest, "number" | "repository" | "state" | "isDraft">;

export function formatWorkingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function compactDirectory(path: string, segments = 2): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return path || "No directory";
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return "/";
  return parts.slice(-Math.max(1, segments)).join("/");
}

function WorkingDuration({ startedAt }: { startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return <span className="thread-card-duration">{formatWorkingDuration(Date.now() - startedAt)}</span>;
}

function ThreadInboxStatus({ threadId }: { threadId: string }) {
  const status = useTaskStore((state) => state.statuses[threadId] ?? "idle");
  const startedAt = useTaskStore((state) => state.tasks[threadId]?.workingStartedAt);
  const approvalCount = useTaskStore((state) => state.tasks[threadId]?.approvals.length ?? 0);
  const unread = useTaskStore((state) => Boolean(state.tasks[threadId]?.unread));

  if (approvalCount > 0) {
    return (
      <span className="thread-card-status approval" role="status">
        Needs approval
      </span>
    );
  }
  if (status === "starting" || status === "running") {
    return (
      <span className="thread-card-status working" role="status">
        <CircleDashed className="thread-card-spinner" size={14} />
        <span>{status === "starting" ? "Starting" : "Working"}</span>
        {status === "running" && startedAt !== undefined && <WorkingDuration startedAt={startedAt} />}
      </span>
    );
  }
  if (status === "error") {
    return <span className="thread-card-status error" role="status">Failed</span>;
  }
  if (unread) {
    return <span className="thread-card-status done" role="status">Done</span>;
  }
  return null;
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
  workspaceName: string;
  directory: string;
  provider: Provider;
  providerName: string;
  pinned: boolean;
  isolated?: boolean;
  branch?: string;
  /** The pull request saved against this thread, when there is one. */
  pullRequest?: ThreadCardPullRequest | null;
  onOpen: () => void;
}

/** Lifecycle class for the card shell: `live` breathes in the provider's
 * accent while a task runs, `settled` replays the completion sweep when a
 * turn finishes with unread output. */
function threadCardLifecycle(status: string, unread: boolean, approvals: number): string {
  if (approvals > 0) return "attention";
  if (status === "starting" || status === "running") return "live";
  if (status === "error") return "faulted";
  if (unread) return "settled";
  return "";
}

export function ThreadInboxCard({
  threadId,
  title,
  titlePending = false,
  workspaceName,
  directory,
  provider,
  providerName,
  pinned,
  isolated = false,
  branch,
  pullRequest = null,
  onOpen,
}: ThreadInboxCardProps) {
  const lifecycle = useTaskStore((state) => threadCardLifecycle(
    state.statuses[threadId] ?? "idle",
    Boolean(state.tasks[threadId]?.unread),
    state.tasks[threadId]?.approvals.length ?? 0,
  ));
  // A labelled button hides its own contents from a screen reader, so the pill
  // below would otherwise be seen by sighted people only. It is named here too.
  const accessibleTitle = titlePending ? "Generating title" : title;
  const label = pullRequest
    ? `Open ${accessibleTitle} · Pull request #${pullRequest.number} in ${pullRequest.repository}, ${threadCardPullRequestState(pullRequest).label}`
    : `Open ${accessibleTitle}`;
  return (
    <button className={`thread-card ${lifecycle} provider-${provider}`} onClick={onOpen} aria-label={label}>
      <span className="thread-card-context">
        <span className="thread-card-workspace" title={directory}>
          {isolated ? <GitBranch size={14} /> : <Folder size={14} />}
          <span>{isolated ? branch || "Isolated" : workspaceName}</span>
        </span>
        <ThreadInboxStatus threadId={threadId} />
      </span>
      <ThreadTitle className="thread-card-title" title={title} pending={titlePending} />
      <span className="thread-card-meta">
        <span className="thread-card-directory" title={directory}>{compactDirectory(directory)}</span>
        {/* After the directory, not before the title: the pull request is
            context for the work, and the work's name comes first. */}
        {pullRequest && <ThreadCardPullRequestBadge pullRequest={pullRequest} />}
        {pinned && <Pin className="thread-card-pin" size={12} aria-label="Pinned" />}
        <span className={`thread-card-provider ${provider}`} title={`${providerName} thread`} aria-label={`${providerName} thread`}>
          <ProviderLogo provider={provider} size={13} />
        </span>
      </span>
    </button>
  );
}

import { memo } from "react";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PullRequest } from "../lib/pullRequests";
import "./thread-pull-request-chip.css";

export interface ThreadPullRequestChipProps {
  /** Repository this thread's folder points at, when the app knows one. */
  repository?: string | null;
  pullRequest: PullRequest | null;
  /** True once the thread actually holds the link. A pull request that is
   *  merely *discovered* for the current branch arrives with `linked: false`
   *  and must never look like it already belongs to the thread. */
  linked: boolean;
  onClick: () => void;
}

/** Open / Draft / Merged / Closed, said the way GitHub says it. */
function stateOf(pullRequest: PullRequest): { key: string; label: string; icon: typeof GitPullRequest } {
  if (pullRequest.state === "MERGED") return { key: "merged", label: "Merged", icon: GitMerge };
  if (pullRequest.state === "CLOSED") return { key: "closed", label: "Closed", icon: GitPullRequestClosed };
  if (pullRequest.isDraft) return { key: "draft", label: "Draft", icon: GitPullRequestDraft };
  return { key: "open", label: "Open", icon: GitPullRequest };
}

/**
 * The thread header is already crowded, so this chip spends the minimum a
 * person needs to recognise state at a glance: one icon, one number. The
 * repository, title and status live in the hover/focus description and in the
 * panel the chip opens — never in the header itself, which has no room for
 * them.
 *
 * Three appearances, because three situations are genuinely different:
 *   linked + pull request  — this thread's pull request, accent-coloured
 *   pull request only      — a candidate found on this branch, dashed outline
 *   neither                — a plain "GitHub" affordance that opens the panel
 */
function ThreadPullRequestChipInner({ repository, pullRequest, linked, onClick }: ThreadPullRequestChipProps) {
  const repositoryLabel = (pullRequest?.repository || repository || "").trim();

  if (!pullRequest) {
    const description = repositoryLabel
      ? `Pull requests for ${repositoryLabel}. No pull request is linked to this thread yet.`
      : "Pull requests. No pull request is linked to this thread yet.";
    return (
      <button type="button" className="thread-pr-chip empty" onClick={onClick} title={description} aria-label={description}>
        <GitPullRequest size={13} aria-hidden="true" />
        <span>GitHub</span>
      </button>
    );
  }

  const { key, label, icon: Icon } = stateOf(pullRequest);
  const title = pullRequest.title.trim();
  const where = repositoryLabel ? `${repositoryLabel} ` : "";
  const description = linked
    ? `${label} pull request ${where}#${pullRequest.number}${title ? `: ${title}` : ""}. Open the pull request panel.`
    : `${label} pull request ${where}#${pullRequest.number}${title ? `: ${title}` : ""} was found for this branch. Open the panel to attach it to this thread.`;

  return (
    <button
      type="button"
      className={`thread-pr-chip ${key}${linked ? "" : " candidate"}`}
      onClick={onClick}
      title={description}
      aria-label={description}
      data-linked={linked ? "true" : "false"}
    >
      <Icon size={13} aria-hidden="true" />
      <span>#{pullRequest.number}</span>
      {!linked && <em aria-hidden="true">found</em>}
    </button>
  );
}

export const ThreadPullRequestChip = memo(ThreadPullRequestChipInner);

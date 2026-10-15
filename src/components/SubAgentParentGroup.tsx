import { useId, useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, GitFork } from "lucide-react";
import type { Provider } from "../types";
import type { SubAgentParentState } from "../lib/subAgentParents";
import { ProviderLogo } from "./BrandLogos";
import { PixelWorkingMark } from "./PixelWorkingMark";
import { useTaskStore } from "../lib/taskStore";

interface SubAgentParentGroupProps {
  title: string;
  /** The parent's provider, when anything still records it. */
  provider?: Provider;
  providerName?: string;
  /** Null for the bucket of sub-agents that carry no parent ID at all. */
  state: SubAgentParentState | null;
  reported: boolean;
  shortId?: string;
  count: number;
  threadIds: string[];
  /** Omitted when there is nothing to open. */
  onOpenParent?: () => void;
  children: ReactNode;
}

const STATE_TAGS: Partial<Record<SubAgentParentState, { label: string; detail: string }>> = {
  archived: { label: "Archived", detail: "The parent conversation is archived" },
  elsewhere: { label: "Other project", detail: "The parent conversation belongs to a different chat or project" },
};

/**
 * One parent's children in the Sub-agents inbox.
 *
 * A labelled group with a real heading, so heading navigation lands on each
 * parent. Open parent is a sibling of the heading, never inside a card: cards
 * are already buttons and cannot contain another control.
 */
export function SubAgentParentGroup({
  title,
  provider,
  providerName,
  state,
  reported,
  shortId,
  count,
  threadIds,
  onOpenParent,
  children,
}: SubAgentParentGroupProps) {
  const headingId = useId();
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  // A primitive snapshot avoids rerendering the heading for every text delta.
  const activity = useTaskStore((store) => {
    let working = 0;
    let approvals = 0;
    let failed = 0;
    for (const id of threadIds) {
      if (store.statuses[id] === "starting" || store.statuses[id] === "running") working++;
      if (store.tasks[id]?.approvals.length) approvals++;
      if (store.statuses[id] === "error") failed++;
    }
    return `${working}:${approvals}:${failed}`;
  });
  const [working, approvals, failed] = activity.split(":").map(Number);
  const tag = state ? STATE_TAGS[state] : undefined;
  const countLabel = `${count} sub-agent${count === 1 ? "" : "s"}`;
  const tooltip = [
    title,
    shortId ? `ID ending ${shortId}` : "",
    providerName ? `${providerName} thread` : "",
    tag?.detail ?? "",
    reported ? "Parent reported by the provider, not by a Mythra Code ownership record" : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="subagent-group" data-expanded={expanded} role="group" aria-labelledby={headingId}>
      <div className="subagent-group-heading">
        <h2 id={headingId} className="subagent-group-title">
         <button type="button" className="subagent-group-toggle" title={tooltip}
          aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
          <ChevronRight className="subagent-group-chevron" size={13} aria-hidden="true" />
          {provider ? (
            <span className={`thread-card-provider subagent-group-provider ${provider}`} aria-hidden="true">
              <ProviderLogo provider={provider} size={provider === "claude" ? 11 : 10} />
            </span>
          ) : <GitFork className="subagent-group-fallback-icon" size={12} aria-hidden="true" />}
          <span className="subagent-group-name">{title}</span>
          {/* Visible marks are terse; the spoken heading gets the full words. */}
          {shortId && <>
            <span className="subagent-group-id" aria-hidden="true">#{shortId}</span>
            <span className="sr-only">{`, ID ending ${shortId}`}</span>
          </>}
          {tag && <>
            <span className="sr-only">, </span>
            <span className="subagent-group-tag">{tag.label}</span>
          </>}
          {reported && <>
            <span className="subagent-group-tag" aria-hidden="true">Reported</span>
            <span className="sr-only">, reported by the provider</span>
          </>}
          {providerName && <span className="sr-only">{`, ${providerName} thread`}</span>}
          <span className="subagent-group-count" aria-hidden="true">{count}</span>
          <span className="sr-only">{`, ${countLabel}`}</span>
          {working > 0 && <span className="subagent-group-activity"><PixelWorkingMark />{working} working</span>}
          {approvals > 0 && <span className="subagent-group-tag">{approvals} need approval</span>}
          {failed > 0 && <span className="subagent-group-tag">{failed} failed</span>}
         </button>
        </h2>
        {onOpenParent && (
          <button
            type="button"
            className="subagent-group-open"
            onClick={onOpenParent}
            aria-label={`Open parent conversation ${title}${shortId ? `, ID ending ${shortId}` : ""}`}
            title={`Open parent conversation: ${title}`}
          >
            <ArrowUpRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      <div id={contentId} className="subagent-group-content" aria-hidden={!expanded} inert={!expanded}>
        <div className="subagent-group-content-clip"><div className="subagent-group-rows">{children}</div></div>
      </div>
    </div>
  );
}

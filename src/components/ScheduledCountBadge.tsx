import { Clock3, MessageSquarePlus } from "lucide-react";
import { scheduledCountsLabel, type WorkspaceScheduledCounts } from "../lib/scheduledPromptCounts";

/** The owning button repeats the meaning in its accessible name. */
export function ScheduledCountBadge({ newConversations = 0, threadPrompts = 0, label }: Partial<WorkspaceScheduledCounts> & { label?: string }) {
  if (!newConversations && !threadPrompts) return null;
  return <span className="scheduled-counts" title={label ?? scheduledCountsLabel({ newConversations, threadPrompts })} aria-hidden="true">
    {newConversations > 0 && <span className="scheduled-count"><MessageSquarePlus size={12} /><span>{newConversations}</span></span>}
    {threadPrompts > 0 && <span className="scheduled-count"><Clock3 size={12} /><span>{threadPrompts}</span></span>}
  </span>;
}

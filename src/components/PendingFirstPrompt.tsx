import type { PendingFirstPrompt as PendingPrompt } from "../lib/pendingFirstPrompt";
import { PixelWorkingMark } from "./PixelWorkingMark";
import "./ActivityStatus.css";
import "./PendingFirstPrompt.css";

/** Acknowledges Send while guarded preparation still owns the authored prompt. */
export function PendingFirstPrompt({ prompt, accepted = false, activityStatus = prompt.status }: { prompt: PendingPrompt; accepted?: boolean; activityStatus?: "starting" | "stopping" | "working" | null }) {
  const stopping = activityStatus === "stopping";
  return (
    <div className="flow-timeline pending-first-prompt" aria-label={accepted ? "Conversation" : "Starting conversation"}>
      <div className="timeline-top-space" />
      <div className="timeline-entry timeline-entry-message">
        <article className="message user" aria-label={accepted ? "Your prompt" : "Your pending prompt"}>
          <div className="message-body">
            <div className="message-text">{prompt.text}</div>
            {Boolean(prompt.attachmentNames?.length) && <div className="pending-prompt-attachments" aria-label="Pending attachments">{prompt.attachmentNames!.join(" · ")}</div>}
          </div>
        </article>
      </div>
      {activityStatus && <div className="timeline-entry timeline-entry-activity">
        <div className="activity-status state-running live" role="status">
          <span className="activity-status-pill">
            <span className="activity-status-mark working"><PixelWorkingMark live={!stopping} /></span>
            <span className="activity-status-text">{stopping ? "Stopping…" : activityStatus === "working" ? "Working…" : "Starting…"}</span>
          </span>
        </div>
      </div>}
    </div>
  );
}

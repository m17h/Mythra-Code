import { CreditCard, Hourglass } from "lucide-react";
import "./ClaudeContinuationNotice.css";

export type ClaudeContinuationVariant = "grace" | "paid";

/**
 * Compact composer notice for a live Claude Code turn that has passed a
 * subscription limit. The two variants are deliberately distinct: the
 * wrap-up allowance is included subscription usage that Anthropic grants
 * automatically and caps, while paid usage means Claude Code reports that
 * usage credits are being spent. Neither copy promises the task will finish,
 * states a quota, or offers to turn anything on.
 */
export function ClaudeContinuationNotice({ variant, onOpenUsage }: {
  variant: ClaudeContinuationVariant;
  onOpenUsage?: () => void;
}) {
  const grace = variant === "grace";
  return (
    <div className={`claude-continuation-notice is-${variant}`} role="status" aria-live="polite">
      <span className="claude-continuation-icon" aria-hidden="true">
        {grace ? <Hourglass size={13} /> : <CreditCard size={13} />}
      </span>
      <span className="claude-continuation-copy">
        <strong>{grace ? "Included wrap-up allowance in use" : "Claude usage credits in use"}</strong>
        <small>
          {grace
            ? "Your five-hour limit was reached. Claude Code is continuing this response with your plan's included wrap-up allowance, which counts toward your weekly usage. The allowance is capped by Anthropic and may end before the task is finished."
            : "Claude Code reports that usage credits (extra usage) are being used for this turn. Additional charges may apply."}
        </small>
      </span>
      {onOpenUsage && (
        <button type="button" onClick={onOpenUsage}>View usage</button>
      )}
    </div>
  );
}

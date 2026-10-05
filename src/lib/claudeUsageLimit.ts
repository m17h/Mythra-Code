/** Explain a provider refusal without claiming an account's eligibility or
 * offering an unsupported way to extend its allowance. No billing changes. */
export const CLAUDE_USAGE_LIMIT_EXPLANATION = "The included wrap-up allowance is automatic but not guaranteed. Claude controls eligibility, rollout and whether any allowance remains; it only applies to a response already in progress. Mythra Code cannot extend it and has not enabled paid usage.";

/** SDK error results may contain errors[] instead of the success-only result
 * field. Preserve supplied error strings, never stringify arbitrary objects. */
export function claudeResultError(message: Record<string, unknown>): string {
  if (typeof message.result === "string" && message.result.trim()) return message.result;
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
  return errors.join("\n") || "Claude could not complete this request.";
}

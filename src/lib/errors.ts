import { SkillDependencyError } from "./skillDependencies";

const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/runtimeWorkspaceRoots requires experimentalApi capability/i, "Mythra Code needs to reconnect before it can reopen this project thread. Restart the runtime and try again."],
  [/(could not start.*codex app-server|codex.*not.*path)/i, "The Codex runtime could not be found. Install the official Codex CLI, then try again."],
  [/(unauthori[sz]ed|status\s*401|authentication required|not signed in)/i, "Your account is not connected. Sign in from Models & accounts in Settings, then try again."],
  [/(timed? out|timeout)/i, "The runtime took too long to respond. Check that it is running, then try again."],
  [/(connection.*closed|broken pipe|server.*stopped|runtime.*stopped)/i, "The local runtime connection stopped unexpectedly. Restart it and try again."],
  [/not a git repository/i, "Git tools are unavailable because this project folder is not a Git repository."],
  [/(permission denied|operation not permitted)/i, "Mythra Code does not have permission to complete that action. Check the project folder and permission mode."],
];

export function friendlyError(reason: unknown): string {
  // Dependency resolution already supplies a bounded reason chain. Generic
  // runtime classification must not hide which selected source failed.
  const raw = safeErrorText(reason);
  try {
    if (reason instanceof SkillDependencyError) return raw;
  } catch { /* Revoked proxies can even throw during instanceof. */ }
  for (const [pattern, message] of TEXT_REPLACEMENTS) {
    if (pattern.test(raw)) return message;
  }
  const cleaned = raw
    .replace(/^Error:\s*/i, "")
    .replace(/^App Server error:\s*/i, "")
    .replace(/^RPC\s+[^:]+:\s*/i, "")
    .trim();
  return cleaned || "Something went wrong. Try again, or export diagnostics from Settings if it keeps happening.";
}

export const GIT_ERROR_MAX_LENGTH = 16_384;
const GIT_ERROR_FALLBACK = "The Git operation failed without details. Refresh and inspect the repository before trying again.";
// Headers name what happened (a created URL, the failed step); native code
// appends recovery footers after up to 512 KiB of Git or hook output. Keep both.
const GIT_ERROR_HEAD_SHARE = 0.25;
const GIT_ERROR_LINE_SNAP = 512;

/** Error reporting must also work for rejected values whose conversion or
 * message getter throws. Bound retained text before it reaches UI or logs. */
export function safeErrorText(reason: unknown, fallback = "Unknown error"): string {
  return boundErrorText(errorText(reason, fallback), "error output");
}

function errorText(reason: unknown, fallback: string): string {
  try {
    if (reason == null) return fallback;
    const value: unknown = reason instanceof Error ? reason.message : reason;
    return typeof value === "string" ? value : String(value);
  } catch {
    return fallback;
  }
}

/**
 * Native Git and GitHub failures carry their own recovery guidance: whether a
 * commit may already be saved, a created repository's URL, or which path was
 * refused. Unlike `friendlyError`, never replace that text with runtime
 * setup advice; only drop a transport prefix and bound its length, omitting
 * the middle so both the leading context and the trailing recovery note remain.
 */
export function formatGitError(reason: unknown): string {
  return formatNativeOperationError(reason, GIT_ERROR_FALLBACK, "Git output");
}

/** File-operation failures can name a partial new file or encryption refusal. */
export function formatSkillFileError(reason: unknown): string {
  return formatNativeOperationError(reason, "The skill file operation failed without details. Rescan and inspect the skills folder before trying again.", "file-operation output");
}

function formatNativeOperationError(reason: unknown, fallback: string, outputKind: string): string {
  const raw = errorText(reason, "");
  const cleaned = raw.replace(/^Error:\s*/i, "").trim();
  if (!cleaned) return fallback;
  return boundErrorText(cleaned, outputKind);
}

function boundErrorText(cleaned: string, outputKind: string): string {
  if (cleaned.length <= GIT_ERROR_MAX_LENGTH) return cleaned;
  // Reserve room for the widest possible marker before choosing the cuts.
  const budget = GIT_ERROR_MAX_LENGTH - omissionMarker(cleaned.length, outputKind).length;
  let headEnd = Math.floor(budget * GIT_ERROR_HEAD_SHARE);
  let tailStart = cleaned.length - (budget - headEnd);
  // Prefer whole lines when a boundary is close, so paths and URLs stay intact.
  const headLine = cleaned.lastIndexOf("\n", headEnd);
  if (headLine > headEnd - GIT_ERROR_LINE_SNAP && headLine > 0) headEnd = headLine;
  const tailLine = cleaned.indexOf("\n", tailStart);
  if (tailLine !== -1 && tailLine < tailStart + GIT_ERROR_LINE_SNAP) tailStart = tailLine + 1;
  // Never leave half of a surrogate pair at either cut.
  if (/[\uD800-\uDBFF]/.test(cleaned[headEnd - 1] ?? "")) headEnd -= 1;
  if (/[\uDC00-\uDFFF]/.test(cleaned[tailStart] ?? "")) tailStart += 1;
  return `${cleaned.slice(0, headEnd)}${omissionMarker(tailStart - headEnd, outputKind)}${cleaned.slice(tailStart)}`;
}

function omissionMarker(omitted: number, outputKind: string): string {
  return `\n[${omitted.toLocaleString("en-US")} characters of ${outputKind} omitted]\n`;
}

/** Authentication rejection, not a transient error while contacting auth. */
export function isAuthenticationError(reason: unknown): boolean {
  return /\b401\b|unauthori[sz]ed|refresh_token_(?:reused|expired|invalidated)|(?:token|authentication|sign.in).*(?:expired|invalid|revoked|required)|(?:sign|log) in again/i.test(safeErrorText(reason, ""));
}

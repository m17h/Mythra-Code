/**
 * Human-readable names for the raw enum strings the runtimes, Git worktrees,
 * and MCP hand back. The Workspace used to print those identifiers verbatim
 * ("inProgress", "oAuth", "removed"), which reads as a leaked internal value
 * rather than a status.
 */

const AGENT_STATUS_LABELS: Record<string, string> = {
  started: "Starting",
  inProgress: "Working",
  in_progress: "Working",
  running: "Working",
  completed: "Finished",
  succeeded: "Finished",
  failed: "Failed",
  error: "Failed",
  cancelled: "Stopped",
  canceled: "Stopped",
  interrupted: "Stopped",
  queued: "Queued",
  pending: "Queued",
};

const WORKTREE_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  applied: "Applied to project",
  merged: "Merged",
  removed: "Removed",
  missing: "Missing on disk",
};

/**
 * `authStatus` from `mcpServerStatus/list` names how a reachable server
 * authenticated; anything else means it still needs to be connected.
 */
const MCP_STATUS_LABELS: Record<string, string> = {
  ready: "Connected",
  oAuth: "Connected · OAuth",
  bearerToken: "Connected · token",
  needsAuth: "Sign-in required",
  failed: "Failed to start",
  error: "Failed to start",
  disconnected: "Not connected",
  starting: "Starting",
};

/** Splits a camelCase or snake_case identifier into sentence-case words. */
function humanize(value: string): string {
  const words = value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : value;
}

export function agentStatusLabel(status: string): string {
  return AGENT_STATUS_LABELS[status] ?? humanize(status);
}

export function worktreeStatusLabel(status: string): string {
  return WORKTREE_STATUS_LABELS[status] ?? humanize(status);
}

export function mcpStatusLabel(status: string): string {
  return MCP_STATUS_LABELS[status] ?? humanize(status);
}

/** MCP states that mean the server is usable without further user action. */
export function mcpServerConnected(status: string): boolean {
  return status === "ready" || status === "oAuth" || status === "bearerToken";
}

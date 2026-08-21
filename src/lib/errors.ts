const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/runtimeWorkspaceRoots requires experimentalApi capability/i, "OpenKiwi needs to reconnect before it can reopen this project thread. Restart the runtime and try again."],
  [/(no such file or directory|could not start.*codex app-server|codex.*not.*path)/i, "The Codex runtime could not be found. Install Codex CLI for Windows, then try again."],
  [/(unauthori[sz]ed|status\s*401|authentication required|not signed in)/i, "Your account is not connected. Sign in from Models & accounts in Settings, then try again."],
  [/(timed? out|timeout)/i, "The runtime took too long to respond. Check that it is running, then try again."],
  [/(connection.*closed|broken pipe|server.*stopped|runtime.*stopped)/i, "The local runtime connection stopped unexpectedly. Restart it and try again."],
  [/not a git repository/i, "Git tools are unavailable because this project folder is not a Git repository."],
  [/(permission denied|operation not permitted)/i, "OpenKiwi does not have permission to complete that action. Check the project folder and permission mode."],
];

export function friendlyError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "Unknown error");
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

import type { PendingApproval } from "../../../types";
import { respond, auditEvent, type JsonObject } from "../../codex";
import { respondToClaudePermission } from "../../claude";
import { respondToCursorPermission } from "../../cursor";
import { friendlyError } from "../../errors";
import { useTaskStore } from "../../taskStore";
import { HostReadError } from "./scope";

export function isQuestion(approval: PendingApproval): boolean {
  return approval.method === "item/tool/requestUserInput" || approval.method === "cursor/ask_question"
    || approval.method === "claude/can_use_tool" && approval.params.tool_name === "AskUserQuestion";
}
function cursorOption(approval: PendingApproval, kind: string): string | number | undefined {
  const rows = Array.isArray(approval.params.options) ? approval.params.options : [];
  const row = rows.find((entry) => entry && typeof entry === "object" && (entry as JsonObject).kind === kind) as JsonObject | undefined;
  return typeof row?.optionId === "string" || typeof row?.optionId === "number" ? row.optionId : undefined;
}
export function approvalPolicy(approval: PendingApproval): { canAllowOnce: boolean; canDeny: boolean; summary: string } | null {
  if (isQuestion(approval)) return null;
  switch (approval.method) {
    case "execCommandApproval": case "item/commandExecution/requestApproval":
      return { canAllowOnce: true, canDeny: true, summary: "The agent requests permission to run a command." };
    case "applyPatchApproval": case "item/fileChange/requestApproval":
      return { canAllowOnce: true, canDeny: true, summary: "The agent requests permission to change files." };
    case "claude/can_use_tool": return { canAllowOnce: true, canDeny: true, summary: "Claude requests permission to use a tool." };
    case "item/permissions/requestApproval": return { canAllowOnce: false, canDeny: true, summary: "Additional permissions can only be allowed on the host." };
    case "cursor/request_permission": return { canAllowOnce: cursorOption(approval, "allow_once") !== undefined,
      canDeny: cursorOption(approval, "reject_once") !== undefined, summary: "Cursor requests permission to continue." };
    default: return null;
  }
}
/** Explicit method adapters; never choose allowAlways/session or permission updates. */
export function remoteApprovalResponse(approval: PendingApproval, decision: "allowOnce" | "deny"): JsonObject {
  const policy = approvalPolicy(approval);
  if (!policy || !(decision === "allowOnce" ? policy.canAllowOnce : policy.canDeny)) {
    throw new HostReadError("unsupported", "This decision must be made on the host.");
  }
  if (approval.method === "cursor/request_permission") {
    return { outcome: { outcome: "selected", optionId: cursorOption(approval, decision === "allowOnce" ? "allow_once" : "reject_once") } };
  }
  if (approval.method === "claude/can_use_tool") {
    return decision === "deny" ? { behavior: "deny", message: "The user denied this action." }
      : { behavior: "allow", ...(approval.params.input === undefined ? {} : { updatedInput: approval.params.input }) };
  }
  if (approval.method === "item/permissions/requestApproval") {
    return { permissions: { network: { enabled: false }, fileSystem: { read: [], write: [], entries: [] } }, scope: "turn" };
  }
  const legacy = approval.method === "execCommandApproval" || approval.method === "applyPatchApproval";
  return { decision: legacy ? decision === "allowOnce" ? "approved" : "denied" : decision === "allowOnce" ? "accept" : "decline" };
}
export function resolveExactApproval(approval: PendingApproval): void {
  const store = useTaskStore.getState();
  if (store.tasks[approval.threadId]?.approvals.includes(approval)) store.resolveApproval(approval.threadId, approval.id);
}
/** Extracted local routing, including existing terminal-error/banner semantics. */
export async function respondToHostApproval(approval: PendingApproval, result: JsonObject, sources: {
  respondToSettingsProposal(approval: PendingApproval, result: JsonObject): Promise<void>;
  setError(message: string): void;
}): Promise<void> {
  try {
    if (approval.method === "openkiwi/subagents/change") await sources.respondToSettingsProposal(approval, result);
    else if (approval.method === "claude/can_use_tool") await respondToClaudePermission(approval.threadId, String(approval.id), result);
    else if (approval.method === "cursor/request_permission" || approval.method === "cursor/ask_question") await respondToCursorPermission(approval.threadId, approval.id, result);
    else await respond(approval.id, result, approval.method === "item/tool/requestUserInput" ? {
      method: approval.method, threadId: approval.threadId,
      turnId: typeof approval.params.turnId === "string" ? approval.params.turnId : undefined,
      itemId: typeof approval.params.itemId === "string" ? approval.params.itemId : undefined,
    } : undefined);
    void auditEvent("approval.resolved", { method: approval.method, responseRecorded: true }, approval.threadId).catch(() => undefined);
    resolveExactApproval(approval);
  } catch (reason) {
    const message = friendlyError(reason);
    const terminal = approval.method.startsWith("openkiwi/") || /no longer|not currently running|unknown request|not found|closed/i.test(message);
    if (terminal) resolveExactApproval(approval);
    sources.setError(message);
    if (!terminal) throw reason instanceof Error ? reason : new Error(message);
  }
}

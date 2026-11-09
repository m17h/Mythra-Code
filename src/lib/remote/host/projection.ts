import { hostAttachmentMetadata } from "../hostSources";
import type { Activity, ChatMessage, PendingApproval } from "../../../types";
import { savedQuestionAnswers } from "../../agentQuestionRecords";
import { isAssistantOutputActive, type ThreadTaskState } from "../../taskStore";
import type { WireActivity, WireApproval, WireMessage, WireQueuedTurn, WireThreadState, WireAvailability, WireTurnStatus } from "../wire";

export function boundedText(value: unknown, limit = 2048): string {
  if (typeof value !== "string") return "";
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[Truncated on remote viewer]`;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function terminal(value: unknown): WireTurnStatus | null {
  return value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed" ? value : null;
}
function fileName(value: string): string { return boundedText(value.replace(/\\/g, "/").split("/").at(-1), 64); }

export function projectMessage(threadId: string, message: ChatMessage, order: number): WireMessage {
  const text = boundedText(message.text, 16_384);
  const result: WireMessage = {
    id: boundedText(message.id, 512), order, role: message.role === "user" ? "user" : "assistant", text,
    turnId: message.turnId ? boundedText(message.turnId, 256) : null,
    streaming: message.streaming === true, turnStatus: terminal(message.turnStatus),
  };
  if (text !== message.text) result.truncated = true;
  if (message.phase === "commentary" || message.phase === "final") result.phase = message.phase;
  if (finite(message.turnDurationMs)) result.turnDurationMs = message.turnDurationMs;
  if (message.provenance === "mythra-notice") result.provenance = message.provenance;
  if (["sending", "accepted", "queued", "read", "unconfirmed"].includes(message.steerStatus ?? "")) result.steerStatus = message.steerStatus;
  if (message.attachments?.length) {
    result.attachmentMetadata = hostAttachmentMetadata(message.attachments);
    result.attachmentNames = message.attachments.slice(0, 8).map((attachment) => fileName(attachment.name));
    const images = message.attachments.slice(0, 8).flatMap((attachment, index) => attachment.kind === "image" ? [index] : []);
    if (images.length) result.attachmentImages = images;
  }
  if (message.questions?.length) {
    if (message.questions.length > 8) result.truncated = true;
    const answers = savedQuestionAnswers(threadId, message.id);
    result.questions = message.questions.slice(0, 8).map((question, index) => {
      const id = question.id ?? String(index);
      const recorded = answers?.[id];
      return {
        id: boundedText(id, 128), title: boundedText(question.title, 256), secret: question.secret === true,
        options: (question.options ?? []).slice(0, 8).map((option) => boundedText(option, 128)),
        answered: Boolean(recorded),
        ...(recorded ? { answers: question.secret ? ["[Redacted]"] : recorded.slice(0, 8).map((answer) => boundedText(answer, 256)) } : {}),
      };
    });
  }
  return result;
}

export function projectActivity(activity: Activity, order: number): WireActivity {
  // Warning is the normalized diagnostic provenance (runtime/host), not a
  // title/text heuristic. Diagnostics can duplicate task.error, so sanitizing
  // just projectState would leave the same exception in snapshots and replay.
  // Model/tool output has other kinds and keeps its original transcript text.
  if (activity.kind === "warning") return {
    id: boundedText(activity.id, 512), order, kind: "warning",
    title: "Notice from the other device", detail: "This conversation reported an issue. Inspect it on the other device.",
    status: ["inProgress", "completed", "failed", "interrupted"].includes(activity.status ?? "") ? activity.status! : null,
    turnId: activity.turnId ? boundedText(activity.turnId, 256) : null, turnStatus: terminal(activity.turnStatus),
  };
  const title = boundedText(activity.title, 1024);
  const detail = activity.detail === undefined ? undefined : boundedText(activity.detail, 16_384);
  const result: WireActivity = {
    id: boundedText(activity.id, 512), order, kind: activity.kind,
    title, ...(detail === undefined ? {} : { detail }), status: activity.status ? boundedText(activity.status, 64) : null,
    turnId: activity.turnId ? boundedText(activity.turnId, 256) : null, turnStatus: terminal(activity.turnStatus),
  };
  if (title !== activity.title || detail !== activity.detail) result.truncated = true;
  if (activity.workType === "research" || activity.workType === "files" || activity.workType === "commands") result.workType = activity.workType;
  if (finite(activity.turnDurationMs)) result.turnDurationMs = activity.turnDurationMs;
  if (finite(activity.itemCount)) result.itemCount = activity.itemCount;
  if (activity.agent) {
    const agent = activity.agent;
    result.agent = { action: agent.action,
      ...(["openai", "openrouter", "lmstudio", "claude", "cursor"].includes(agent.provider ?? "") ? { provider: agent.provider } : {}),
      ...(agent.model ? { model: boundedText(agent.model, 128) } : {}),
      ...(finite(agent.count) ? { count: agent.count } : {}) };
  }
  return result;
}

/** Fixed method table: no raw params, JSON, tool input, or arbitrary reason. */
function approvalSummary(approval: PendingApproval): Pick<WireApproval, "kind" | "summary"> {
  switch (approval.method) {
    case "item/tool/requestUserInput": case "cursor/ask_question": return { kind: "question", summary: "The agent needs your input. Continue on the other device to answer." };
    case "claude/can_use_tool": return approval.params.tool_name === "AskUserQuestion"
      ? { kind: "question", summary: "Claude needs your input. Continue on the other device to answer." }
      : { kind: "permissions", summary: "Claude is waiting for tool permission on the other device." };
    case "execCommandApproval": case "item/commandExecution/requestApproval": return { kind: "command", summary: "A command needs approval on the other device." };
    case "applyPatchApproval": case "item/fileChange/requestApproval": return { kind: "file", summary: "File changes need approval on the other device." };
    case "item/permissions/requestApproval": case "cursor/request_permission": return { kind: "permissions", summary: "The agent is waiting for permission on the other device." };
    case "openkiwi/subagents/change": return { kind: "settings", summary: "A settings change needs approval on the other device." };
    default: return { kind: "other", summary: "Continue on the other device to answer this request." };
  }
}
export function projectApprovals(task: ThreadTaskState | undefined): WireApproval[] {
  return [...(task?.approvals ?? []).slice(0, 64).map((approval, index): WireApproval => ({
    id: `approval-${Number.isFinite(approval.receivedAt) ? approval.receivedAt : 0}-${index}`,
    ...approvalSummary(approval), hostOnly: true,
  })), ...(task?.expiredApprovals ?? []).slice(-16).map((entry): WireApproval => ({ id: entry.id, kind: "other", summary: entry.summary, hostOnly: true }))].slice(0, 64);
}
export function projectQueue(task: ThreadTaskState | undefined): WireQueuedTurn[] {
  return (task?.queuedTurns ?? []).slice(0, 16).map((turn) => {
    const text = boundedText(turn.text, 512);
    return { id: boundedText(turn.id, 256), text, status: turn.status, createdAt: turn.createdAt,
      attachmentNames: turn.attachments.slice(0, 8).map((attachment) => fileName(attachment.name)),
      ...(text !== turn.text ? { truncated: true } : {}) };
  });
}
export function projectState(task: ThreadTaskState | undefined, availability: WireAvailability): WireThreadState {
  const startedAt = task?.workingStartedAt;
  return {
    status: task?.status ?? "idle", availability: task ? availability : "recovering",
    activeTurnId: task?.activeTurnId ? boundedText(task.activeTurnId, 256) : null,
    assistantOutputActive: isAssistantOutputActive(task),
    workingStartedAt: finite(startedAt) ? startedAt : null,
    // Exceptions can contain credentials or local paths. Do not forward them.
    error: task?.error ? "This conversation reported an error. Inspect it on the other device." : null,
  };
}

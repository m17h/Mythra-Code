import type { PendingApproval } from "../../../types";
import type { JsonObject } from "../../codex";
import type { WireQuestion } from "../wire";
import { isQuestion } from "./approvalActions";
import { HostReadError } from "./scope";

const invalid = () => new HostReadError("unsupported", "These questions cannot be answered remotely. Continue on the host.");
/** Only live pending-request forms. Timeline records never authorize an answer. */
export function requestQuestions(approval: PendingApproval): WireQuestion[] {
  if (!isQuestion(approval)) throw invalid();
  const rawInput = approval.method === "claude/can_use_tool" ? approval.params.input : approval.params;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) throw invalid();
  const raw = (rawInput as JsonObject).questions;
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw invalid();
  const ids = new Set<string>(), titles = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const question = entry as JsonObject;
    const id = question.id === undefined ? String(index) : question.id;
    const title = typeof question.question === "string" ? question.question : question.title;
    if (typeof id !== "string" || !id || id.length > 256 || ids.has(id)
      || typeof title !== "string" || !title || title.length > 8192) throw invalid();
    if (approval.method === "claude/can_use_tool" && titles.has(title)) throw invalid();
    ids.add(id); titles.add(title);
    const options: string[] = [];
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length > 64) throw invalid();
      for (const value of question.options) {
        const label = typeof value === "string" ? value : value && typeof value === "object" ? (value as JsonObject).label : undefined;
        if (typeof label !== "string" || !label || label.length > 2048) throw invalid();
        options.push(label);
      }
    }
    return { id, title, options, secret: question.isSecret === true || question.secret === true, answered: false };
  });
}
/** Values are transient: no drafts, queue, audit payload, receipt or transcript. */
export function remoteQuestionResponse(approval: PendingApproval, answers: unknown, cancel: unknown): JsonObject {
  const questions = requestQuestions(approval);
  const claude = approval.method === "claude/can_use_tool";
  if (cancel === true) {
    if (answers !== undefined) throw invalid();
    return claude ? { behavior: "deny", message: "The user cancelled the questions." } : { answers: {} };
  }
  if (cancel !== undefined || !answers || typeof answers !== "object" || Array.isArray(answers)) throw invalid();
  const input = answers as Record<string, unknown>;
  if (Object.keys(input).length !== questions.length || Object.keys(input).some((id) => !questions.some((q) => q.id === id))) throw invalid();
  let size = 0;
  const checked = Object.fromEntries(questions.map((question) => {
    const values = input[question.id];
    if (!Array.isArray(values) || !values.length || values.length > 64) throw invalid();
    for (const value of values) {
      if (typeof value !== "string" || !value.trim() || value.length > 8192) throw invalid();
      size += new TextEncoder().encode(value).byteLength;
      if (size > 65536) throw invalid();
    }
    return [question.id, [...values] as string[]];
  }));
  return claude ? { behavior: "allow", updatedInput: { ...(approval.params.input as JsonObject),
    answers: Object.fromEntries(questions.map((q) => [q.title, checked[q.id].join(", ")])) } }
    : { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: checked[q.id] }])) };
}

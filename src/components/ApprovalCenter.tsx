import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink, MessageSquare, ShieldAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonObject } from "../lib/codex";
import type { PendingApproval } from "../types";

type Decision = "accept" | "acceptForSession" | "decline";

export const APPROVAL_GRACE_MS = 250;

/**
 * One decision per mounted approval. The first activation latches and disables
 * every action button so a double-click or repeated Enter cannot answer the
 * next queued request that swaps into the same DOM, and an activation grace
 * after mount keeps the buttons disabled long enough that an approval popping
 * up mid-typing cannot consume a stray Enter/Space already in flight.
 */
function useDecisionLock(grace = true): { locked: boolean; decide: (action: () => void) => void } {
  const [submitted, setSubmitted] = useState(false);
  const [settling, setSettling] = useState(grace);
  useEffect(() => {
    if (!grace) return;
    const timer = window.setTimeout(() => setSettling(false), APPROVAL_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [grace]);
  const locked = submitted || settling;
  return {
    locked,
    decide: (action: () => void) => {
      if (locked) return;
      setSubmitted(true);
      action();
    },
  };
}

function ApprovalButtons({ onDecision, allowSession = true, autoFocusDeny = true, disabled = false, denyLabel = "Deny", acceptLabel = "Allow once", dangerDeny = true }: { onDecision: (value: Decision) => void; allowSession?: boolean; autoFocusDeny?: boolean; disabled?: boolean; denyLabel?: string; acceptLabel?: string; dangerDeny?: boolean }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  // Deny is the safe default focus target, but only once the activation grace
  // has passed — a disabled button cannot take focus, and focusing it earlier
  // is exactly the focus steal that let mid-flight typing answer the request.
  useEffect(() => {
    if (disabled || !autoFocusDeny) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.getAttribute("role") === "alertdialog") denyRef.current?.focus();
  }, [autoFocusDeny, disabled]);
  return <div className="approval-actions"><button ref={denyRef} className={`secondary-button${dangerDeny ? " danger" : ""}`} disabled={disabled} onClick={() => onDecision("decline")}>{denyLabel}</button>{allowSession && <button className="secondary-button" disabled={disabled} onClick={() => onDecision("acceptForSession")}>Allow for session</button>}<button className="primary-button" disabled={disabled} onClick={() => onDecision("accept")}>{acceptLabel}</button></div>;
}

/** Maps a button decision onto the wire format each approval method expects. */
export function approvalResponse(approval: PendingApproval, decision: Decision): JsonObject {
  if (approval.method === "cursor/request_permission") {
    const options = Array.isArray(approval.params.options) ? approval.params.options as JsonObject[] : [];
    const desired = decision === "decline"
      ? ["reject_once", "reject_always"]
      : decision === "acceptForSession"
        ? ["allow_always", "allow_once"]
        : ["allow_once", "allow_always"];
    const selected = desired.map((kind) => options.find((option) => option.kind === kind)).find(Boolean) ?? options[0];
    const optionId = selected?.optionId;
    return optionId === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } };
  }
  if (approval.method === "claude/can_use_tool") {
    if (decision === "decline") {
      return { behavior: "deny", message: "The user denied this action." };
    }
    return {
      behavior: "allow",
      ...(approval.params.input === undefined ? {} : { updatedInput: approval.params.input }),
      updatedPermissions: decision === "acceptForSession" ? approval.params.permission_suggestions : undefined,
    };
  }
  if (approval.method === "item/permissions/requestApproval") {
    const requested = (approval.params.permissions ?? {}) as JsonObject;
    return {
      permissions: decision === "decline" ? { network: { enabled: false }, fileSystem: { read: [], write: [], entries: [] } } : requested,
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }
  const legacy = approval.method === "execCommandApproval" || approval.method === "applyPatchApproval";
  return { decision: legacy ? decision === "accept" ? "approved" : decision === "acceptForSession" ? "approved_for_session" : "denied" : decision };
}

export function approvalSummary(approval: PendingApproval): { title: string; reason: string; command: string } {
  if (approval.method === "openkiwi/subagents/change") {
    return {
      title: String(approval.params.title ?? "Update this project's sub-agents?"),
      reason: String(approval.params.reason ?? "The agent requested a project sub-agent crew change."),
      command: String(approval.params.command ?? ""),
    };
  }
  if (approval.method === "claude/can_use_tool") {
    const input = (approval.params.input ?? {}) as JsonObject;
    return {
      title: String(approval.params.title ?? approval.params.display_name ?? `Allow ${approval.params.tool_name ?? "this action"}?`),
      reason: String(approval.params.reason ?? approval.params.description ?? "Claude is requesting permission to continue."),
      command: String(input.command ?? input.file_path ?? approval.params.command ?? ""),
    };
  }
  const isFile = approval.method.includes("fileChange") || approval.method.includes("applyPatch");
  const permissions = approval.method === "item/permissions/requestApproval";
  const commandValue = approval.params.command;
  return {
    title: isFile ? "Allow file changes?" : permissions ? "Grant additional permissions?" : "Allow this action?",
    reason: String(approval.params.reason ?? "The agent is requesting permission to continue."),
    command: Array.isArray(commandValue) ? commandValue.join(" ") : String(commandValue ?? ""),
  };
}

/**
 * Approval rendered inline in the conversation for the thread the user is
 * looking at — no app-global modal takeover. Buttons do not steal focus.
 */
export function InlineApprovalCard({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void }) {
  const { title, reason, command } = approvalSummary(approval);
  // Latch only — the inline card never steals focus, so no activation grace.
  const { locked, decide } = useDecisionLock(false);
  return (
    <div className="inline-approval" role="group" aria-label={title}>
      <div className="inline-approval-head"><ShieldAlert size={14} /><strong>{title}</strong></div>
      <p>{reason}</p>
      {command && <pre className="approval-command">{command}</pre>}
      <ApprovalButtons
        autoFocusDeny={false}
        disabled={locked}
        allowSession={approval.method !== "openkiwi/subagents/change"}
        denyLabel={approval.method === "openkiwi/subagents/change" ? "Keep current settings" : "Deny"}
        acceptLabel={approval.method === "openkiwi/subagents/change" ? "Apply to project" : "Allow once"}
        dangerDeny={approval.method !== "openkiwi/subagents/change"}
        onDecision={(decision) => decide(() => onRespond(approvalResponse(approval, decision)))}
      />
    </div>
  );
}

interface ApprovalContext { threadLabel?: string; pendingCount?: number }

function StandardApproval({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void } & ApprovalContext) {
  const { title, reason, command } = approvalSummary(approval);
  const { locked, decide } = useDecisionLock();
  const projectSubagents = approval.method === "openkiwi/subagents/change";
  return <Modal title={title} description={reason} threadLabel={threadLabel} pendingCount={pendingCount}>{command && <pre className="approval-command">{command}</pre>}<ApprovalButtons disabled={locked} allowSession={!projectSubagents} denyLabel={projectSubagents ? "Keep current settings" : "Deny"} acceptLabel={projectSubagents ? "Apply to project" : "Allow once"} dangerDeny={!projectSubagents} onDecision={(decision) => decide(() => onRespond(approvalResponse(approval, decision)))} /></Modal>;
}

interface UserQuestion { id: string; header: string; question: string; isSecret?: boolean; options?: Array<{ label: string; description: string }> | null }

function UserInputRequest({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void } & ApprovalContext) {
  const questions = (approval.params.questions ?? []) as UserQuestion[];
  // Every question gets an entry up front so untouched ones still reach the
  // submitted payload instead of being silently dropped.
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, ""])));
  const { locked, decide } = useDecisionLock();
  return <Modal title="The agent needs your input" description="Answer these questions to continue the task." threadLabel={threadLabel} pendingCount={pendingCount}><div className="request-fields">{questions.map((question) => <label key={question.id}><span>{question.header}</span><small>{question.question}</small>{question.options?.length ? <select value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="">Choose…</option>{question.options.map((option, index) => <option key={index} value={option.label}>{option.label} — {option.description}</option>)}</select> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div><div className="approval-actions"><button className="secondary-button danger" disabled={locked} onClick={() => decide(() => onRespond({ answers: {} }))}>Cancel</button><button className="primary-button" disabled={locked} onClick={() => decide(() => onRespond({ answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answers: [value] }])) }))}>Continue</button></div></Modal>;
}

interface JsonSchemaProperty { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[] }

/**
 * Numeric fields keep the raw typed string in state — coercing per keystroke
 * turns "" into 0 and partial input like "1e" into NaN. Conversion happens
 * once on submit, and only when the input parses to a finite number.
 */
function submittedFieldValue(value: unknown, field: JsonSchemaProperty): unknown {
  if ((field.type === "number" || field.type === "integer") && typeof value === "string") {
    const numeric = Number(value);
    return value.trim() !== "" && Number.isFinite(numeric) ? numeric : value;
  }
  return value;
}

function McpRequest({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void } & ApprovalContext) {
  const mode = String(approval.params.mode ?? "form");
  const message = String(approval.params.message ?? "An MCP server is requesting information.");
  const url = typeof approval.params.url === "string" ? approval.params.url : null;
  const schema = (approval.params.requestedSchema ?? {}) as { properties?: Record<string, JsonSchemaProperty>; required?: string[] };
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema.properties]);
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(([key, value]) => [key, value.default ?? ""])));
  const { locked, decide } = useDecisionLock();
  const submittedContent = () => Object.fromEntries(fields.map(([key, field]) => [key, submittedFieldValue(content[key], field)]));
  return <Modal title={`${String(approval.params.serverName ?? "MCP")} needs your input`} description={message} threadLabel={threadLabel} pendingCount={pendingCount}>{url && <button className="elicitation-url" onClick={() => void openUrl(url)}><ExternalLink size={13} /> Open secure request</button>}{mode !== "url" && <div className="request-fields">{fields.map(([key, field]) => <label key={key}><span>{field.title || key}{schema.required?.includes(key) ? " *" : ""}</span>{field.description && <small>{field.description}</small>}{field.type === "boolean" ? <select value={String(content[key] ?? false)} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value === "true" }))}><option value="false">No</option><option value="true">Yes</option></select> : field.enum ? <select value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value }))}>{field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value }))} />}</label>)}</div>}<div className="approval-actions"><button className="secondary-button danger" disabled={locked} onClick={() => decide(() => onRespond({ action: "decline", content: null, _meta: null }))}>Decline</button><button className="primary-button" disabled={locked} onClick={() => decide(() => onRespond({ action: "accept", content: mode === "url" ? null : submittedContent(), _meta: null }))}>{mode === "url" ? "I’m done" : "Submit"}</button></div></Modal>;
}

function Modal({ title, description, threadLabel, pendingCount, children }: { title: string; description: string; threadLabel?: string; pendingCount?: number; children: ReactNode }) {
  const modalRef = useRef<HTMLDivElement>(null);
  // Keep Tab cycling inside the modal — the app behind it stays reachable
  // otherwise, because nothing else is inert while an approval is pending.
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = modal.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
  // Move keyboard focus behind the aria-modal boundary on mount: the first
  // form field when the request has one, otherwise the dialog itself. Action
  // buttons are still disabled at this point (activation grace), so the modal
  // cannot rely on them as the initial target.
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal || modal.contains(document.activeElement)) return;
    (modal.querySelector<HTMLElement>("input, select, textarea") ?? modal).focus();
  }, []);
  return <div className="modal-backdrop approval-backdrop"><div ref={modalRef} className="approval-modal" data-approval-modal="" role="alertdialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="approval-shield"><ShieldAlert size={22} /></div><h2>{title}</h2><p>{description}</p>{threadLabel && <div className="approval-thread-line"><MessageSquare size={12} /> Requested by <strong>{threadLabel}</strong></div>}{children}{pendingCount != null && pendingCount > 0 && <div className="approval-queue-note">{pendingCount} more approval{pendingCount === 1 ? "" : "s"} waiting</div>}</div></div>;
}

export function ApprovalCenter({ approval, threadLabel, pendingCount, onRespond }: { approval: PendingApproval; threadLabel?: string; pendingCount?: number; onRespond: (value: JsonObject) => void }) {
  const context = { threadLabel, pendingCount };
  if (approval.method === "item/tool/requestUserInput" || approval.method === "cursor/ask_question") return <UserInputRequest approval={approval} onRespond={onRespond} {...context} />;
  if (approval.method === "mcpServer/elicitation/request") return <McpRequest approval={approval} onRespond={onRespond} {...context} />;
  return <StandardApproval approval={approval} onRespond={onRespond} {...context} />;
}

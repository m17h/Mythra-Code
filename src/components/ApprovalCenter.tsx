import { AgentQuestionForm, type FormQuestion } from "./AgentQuestionForm";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, ExternalLink, MessageSquare, ShieldAlert, TriangleAlert, ChevronRight } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JsonObject } from "../lib/codex";
import { approvalChoices, approvalFacts, riskSummary, type ApprovalChoice, type ApprovalPlan } from "../lib/approvalChoices";
import { isTopModalLayer, useModalFocus } from "../hooks/useModalFocus";
import { friendlyError } from "../lib/errors";
import type { PendingApproval } from "../types";

export const APPROVAL_GRACE_MS = 250;

/**
 * One decision per mounted approval. The first activation latches and disables
 * every action button so a double-click or repeated Enter cannot answer the
 * next queued request that swaps into the same DOM, and an activation grace
 * after mount keeps the buttons disabled long enough that an approval popping
 * up mid-typing cannot consume a stray Enter/Space already in flight.
 */
function useDecisionLock(grace = true): { locked: boolean; error: string; decide: (action: () => void | Promise<void>) => void } {
  const [submitted, setSubmitted] = useState(false);
  const [settling, setSettling] = useState(grace);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!grace) return;
    const timer = window.setTimeout(() => setSettling(false), APPROVAL_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [grace]);
  const locked = submitted || settling;
  return {
    locked,
    error,
    decide: (action: () => void | Promise<void>) => {
      if (locked) return;
      setSubmitted(true);
      setError("");
      const failed = (reason: unknown) => {
          setError(friendlyError(reason));
          setSubmitted(false);
      };
      try {
        const pending = action();
        if (pending) void pending.catch(failed);
      } catch (reason) {
        failed(reason);
      }
    },
  };
}

function ApprovalResponseError({ error }: { error: string }) {
  return error ? <div className="approval-response-error" role="alert">{error} You can try again.</div> : null;
}

function ApprovalFacts({ approval, id }: { approval: PendingApproval; id?: string }) {
  const facts = approvalFacts(approval);
  if (!facts.length) return null;
  return <dl className="approval-facts" id={id}>
    {facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd className={fact.mono ? "mono" : undefined}>{fact.value}</dd></div>)}
  </dl>;
}

/** A compound or destructive command says so above the answers. */
function ApprovalRisk({ plan, id }: { plan: ApprovalPlan; id?: string }) {
  const text = riskSummary(plan.risk);
  return text ? <p className="approval-risk" id={id}><TriangleAlert size={13} aria-hidden="true" /><span>{text}</span></p> : null;
}

/** Exact scope of one wider grant: what it covers, how long, where it's saved. */
/**
 * One wider choice (Sol M05): the exact scope leads as a compact block (what
 * runs now, what later runs it allows, what it doesn't cover, how long it
 * lasts, where it is saved), then the explanation as a quieter note, then the
 * exact rule behind a disclosure. Nothing is removed; only the reading order
 * changes, so the facts come before the prose that restates them.
 */
function GrantScope({ choice, id }: { choice: ApprovalChoice; id: string }) {
  const hasScope = Boolean(choice.scope && choice.scope.length > 0);
  const exactLabel = choice.id === "execpolicy" ? "Exact rule the Codex CLI saves"
    : choice.id === "claude-suggestions" ? "Exact rule Claude saves" : "Exact access requested";
  return <div className="approval-grant-body" id={id}>
    {hasScope && <dl className="approval-scope">
      {choice.scope!.map((row, index) => <div key={`${row.label}-${index}`} className={row.excluded ? "excluded" : undefined}>
        <dt>{row.label}</dt><dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
      </div>)}
    </dl>}
    {choice.detail && <p className={`approval-grant-detail${hasScope ? " secondary" : ""}`}>{choice.detail}</p>}
    {choice.exact && <details className="approval-exact">
      <summary className="lm-summary"><ChevronRight size={12} aria-hidden="true" className="lm-chevron" />{exactLabel}</summary>
      <pre>{choice.exact}</pre>
    </details>}
  </div>;
}

function ApprovalButtons({ plan, onChoose, disabled = false, riskId }: { plan: ApprovalPlan; onChoose: (choice: ApprovalChoice) => void; disabled?: boolean; riskId?: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const moreId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const grantRefs = useRef(new Map<string, HTMLButtonElement>());
  const deny = plan.choices.find((choice) => choice.kind === "deny");
  const once = plan.choices.find((choice) => choice.kind === "once");
  const more = plan.choices.filter((choice) => choice.kind === "broader" || choice.kind === "denyBroader");
  // A risky command gets no filled "grant" button: Deny and Allow once weigh the same.
  const equal = Boolean(plan.risk);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);
  const cancelConfirm = () => {
    const id = confirming;
    setConfirming(null);
    if (id) window.requestAnimationFrame(() => grantRefs.current.get(id)?.focus());
  };
  // ←/→ move between the answers (a toolbar), so a keyboard user who tabbed
  // in on Deny can reach Allow without passing other controls.
  return <div className="approval-answer" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    // Escape steps back (confirmation, then More choices); it never answers.
    if (confirming) { event.preventDefault(); event.stopPropagation(); cancelConfirm(); }
    else if (moreOpen) { event.preventDefault(); event.stopPropagation(); setMoreOpen(false); toggleRef.current?.focus(); }
  }}>
    <ApprovalRisk plan={plan} id={riskId} />
    <div className="approval-actions" role="toolbar" aria-label="Answer" onKeyDown={(event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (!buttons.length || index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
      buttons[next].focus();
    }}>
      {deny && <button type="button" className={`secondary-button approval-deny${deny.id === "decline" && deny.label !== "Deny" ? " neutral" : ""}`} disabled={disabled} onClick={() => onChoose(deny)}>{deny.label}</button>}
      {once && <button type="button" className={`${equal ? "secondary-button" : "primary-button"} approval-allow${equal ? " equal" : ""}`} disabled={disabled} onClick={() => onChoose(once)}>{once.label}</button>}
      {more.length > 0 && <button ref={toggleRef} type="button" className="approval-more-toggle" disabled={disabled} aria-expanded={moreOpen} aria-controls={moreId}
        onClick={() => { setMoreOpen((value) => !value); setConfirming(null); }}>
        <span>{moreOpen ? "Fewer choices" : "More choices"}</span><ChevronDown size={12} aria-hidden="true" />
      </button>}
    </div>
    {more.length > 0 && <ul className="approval-more" id={moreId} aria-label="Wider choices" hidden={!moreOpen}>
      {more.map((choice) => {
        const bodyId = `${moreId}-${choice.id}`;
        const isConfirming = confirming === choice.id;
        return <li key={choice.id} className={`approval-grant${choice.kind === "denyBroader" ? " deny" : ""}${isConfirming ? " confirming" : ""}`}>
          <GrantScope choice={choice} id={bodyId} />
          {isConfirming ? <div className="approval-confirm" role="group" aria-label={`Confirm: ${choice.label}`} aria-describedby={`${bodyId}-confirm`}>
            <p id={`${bodyId}-confirm`}><TriangleAlert size={13} aria-hidden="true" /><span>{choice.confirm}</span></p>
            <div className="approval-confirm-actions">
              <button ref={cancelRef} type="button" className="secondary-button" onClick={cancelConfirm}>Cancel</button>
              <button type="button" className="secondary-button approval-grant-button confirm" disabled={disabled} onClick={() => onChoose(choice)}>{choice.confirmLabel ?? choice.label}</button>
            </div>
          </div> : <div className="approval-grant-actions">
            <button ref={(node) => { if (node) grantRefs.current.set(choice.id, node); else grantRefs.current.delete(choice.id); }} type="button"
              className={`secondary-button approval-grant-button${choice.kind === "denyBroader" ? " deny" : ""}`} disabled={disabled} aria-describedby={bodyId}
              onClick={() => { if (choice.confirm) setConfirming(choice.id); else onChoose(choice); }}>
              {choice.label}{choice.confirm ? "…" : ""}
            </button>
          </div>}
        </li>;
      })}
    </ul>}
    {plan.note && <p className="approval-note">{plan.note}</p>}
  </div>;
}

/** Window event that asks the visible approval card (or dialog) to take focus. */
export const FOCUS_APPROVAL_EVENT = "mythra:focus-approval";

export function approvalSummary(approval: PendingApproval): { title: string; reason: string; command: string } {
  if (approval.method === "openkiwi/subagents/change") {
    return {
      title: String(approval.params.title ?? "Update this project's sub-agents?"),
      reason: String(approval.params.reason ?? "The agent requested a project sub-agent setup change."),
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
  const isCommand = approval.method === "item/commandExecution/requestApproval" || approval.method === "execCommandApproval";
  const isNetwork = approval.method === "item/commandExecution/requestApproval" && approval.params.networkApprovalContext != null;
  const commandValue = approval.params.command;
  return {
    title: isFile ? "Allow these file changes?" : permissions ? "Grant extra access?" : isNetwork ? "Allow this network connection?" : isCommand ? "Run this command?"
      : approval.method === "cursor/request_permission" ? "Allow this Cursor action?" : "Allow this action?",
    reason: String(approval.params.reason ?? "The agent is requesting permission to continue."),
    command: Array.isArray(commandValue) ? commandValue.join(" ") : String(commandValue ?? ""),
  };
}

/**
 * Approval rendered inline in the conversation for the thread the user is
 * looking at — no app-global modal takeover. Buttons do not steal focus;
 * the card only takes focus when asked to (FOCUS_APPROVAL_EVENT), and then
 * the card itself, never an answer, so a stray Enter grants nothing.
 */
export function InlineApprovalCard({ approval, onRespond }: { approval: PendingApproval; onRespond: (value: JsonObject) => void | Promise<void> }) {
  const { title, reason, command } = approvalSummary(approval);
  const plan = useMemo(() => approvalChoices(approval), [approval]);
  // Latch only — the inline card never steals focus, so no activation grace.
  const { locked, error, decide } = useDecisionLock(false);
  const describedId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusCard = () => {
      const card = cardRef.current;
      if (!card || document.querySelector("[data-approval-modal]")) return;
      card.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      card.focus({ preventScroll: true });
    };
    window.addEventListener(FOCUS_APPROVAL_EVENT, focusCard);
    return () => window.removeEventListener(FOCUS_APPROVAL_EVENT, focusCard);
  }, []);
  const hasFacts = approvalFacts(approval).length > 0;
  const described = [`${describedId}-reason`, command && `${describedId}-command`, hasFacts && `${describedId}-facts`, plan.risk && `${describedId}-risk`].filter(Boolean).join(" ");
  return (
    <div ref={cardRef} className="inline-approval" role="group" aria-label={title} aria-describedby={described} tabIndex={-1} data-inline-approval="">
      <span className="sr-only" role="status">Waiting for your approval</span>
      <div className="inline-approval-head"><span className="approval-shield" aria-hidden="true"><ShieldAlert size={14} /></span><strong>{title}</strong></div>
      <p id={`${describedId}-reason`}>{reason}</p>
      {command && <pre className="approval-command" id={`${describedId}-command`}>{command}</pre>}
      <ApprovalFacts approval={approval} id={`${describedId}-facts`} />
      <ApprovalResponseError error={error} />
      <ApprovalButtons disabled={locked} plan={plan} riskId={`${describedId}-risk`} onChoose={(choice) => decide(() => onRespond(choice.response))} />
    </div>
  );
}

interface ApprovalContext { threadLabel?: string; pendingCount?: number }

function StandardApproval({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void | Promise<void> } & ApprovalContext) {
  const { title, reason, command } = approvalSummary(approval);
  const plan = useMemo(() => approvalChoices(approval), [approval]);
  const { locked, error, decide } = useDecisionLock();
  const id = useId();
  const hasFacts = approvalFacts(approval).length > 0;
  const describedBy = [command && `${id}-command`, hasFacts && `${id}-facts`, plan.risk && `${id}-risk`].filter(Boolean).join(" ");
  return <Modal title={title} description={reason} threadLabel={threadLabel} pendingCount={pendingCount} describedBy={describedBy}>{command && <pre className="approval-command" id={`${id}-command`}>{command}</pre>}<ApprovalFacts approval={approval} id={`${id}-facts`} /><ApprovalResponseError error={error} /><ApprovalButtons disabled={locked} plan={plan} riskId={`${id}-risk`} onChoose={(choice) => decide(() => onRespond(choice.response))} /></Modal>;
}

function UserInputRequest({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void | Promise<void> } & ApprovalContext) {
  const claude = approval.method === "claude/can_use_tool";
  const input = (claude ? approval.params.input : approval.params) as JsonObject;
  const raw = (Array.isArray(input?.questions) ? input.questions : []) as Array<{ id?: string; question: string; isSecret?: boolean; multiSelect?: boolean; options?: FormQuestion["options"] }>;
  const questions = raw.map((question, index) => ({ id: question.id ?? String(index), title: question.question,
    options: question.options, multiSelect: question.multiSelect, secret: question.isSecret }));
  const { locked } = useDecisionLock();
  return <Modal title="The agent needs your input" description="Answer these questions to continue the task." threadLabel={threadLabel} pendingCount={pendingCount} questionDialog>
    <AgentQuestionForm focusOnMount draftKey={`approval:${JSON.stringify([approval.threadId, approval.id, approval.params.turnId, approval.params.itemId, approval.receivedAt])}`} questions={questions} disabled={locked} submitLabel="Continue"
      onCancel={() => onRespond(claude ? { behavior: "deny", message: "The user cancelled the questions." } : { answers: {} })}
      onSubmit={(answers) => onRespond(claude ? { behavior: "allow", updatedInput: { ...input,
        answers: Object.fromEntries(questions.map((question) => [question.title, answers[question.id].join(", ")])) } }
        : { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: answers[question.id] }])) })} />
  </Modal>;
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

function McpRequest({ approval, onRespond, threadLabel, pendingCount }: { approval: PendingApproval; onRespond: (value: JsonObject) => void | Promise<void> } & ApprovalContext) {
  const mode = String(approval.params.mode ?? "form");
  const message = String(approval.params.message ?? "An MCP server is requesting information.");
  const url = typeof approval.params.url === "string" ? approval.params.url : null;
  const schema = (approval.params.requestedSchema ?? {}) as { properties?: Record<string, JsonSchemaProperty>; required?: string[] };
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema.properties]);
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(([key, value]) => [key, value.default ?? ""])));
  const { locked, error, decide } = useDecisionLock();
  const submittedContent = () => Object.fromEntries(fields.map(([key, field]) => [key, submittedFieldValue(content[key], field)]));
  return <Modal title={`${String(approval.params.serverName ?? "MCP")} needs your input`} description={message} threadLabel={threadLabel} pendingCount={pendingCount}>{url && <button className="elicitation-url" onClick={() => void openUrl(url)}><ExternalLink size={13} /> Open secure request</button>}{mode !== "url" && <div className="request-fields">{fields.map(([key, field]) => <label key={key}><span>{field.title || key}{schema.required?.includes(key) ? " *" : ""}</span>{field.description && <small>{field.description}</small>}{field.type === "boolean" ? <select value={String(content[key] ?? false)} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value === "true" }))}><option value="false">No</option><option value="true">Yes</option></select> : field.enum ? <select value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value }))}>{field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : <input type={field.type === "number" || field.type === "integer" ? "number" : "text"} value={String(content[key] ?? "")} onChange={(event) => setContent((current) => ({ ...current, [key]: event.target.value }))} />}</label>)}</div>}<ApprovalResponseError error={error} /><div className="approval-actions"><button className="secondary-button danger" disabled={locked} onClick={() => decide(() => onRespond({ action: "decline", content: null, _meta: null }))}>Decline</button><button className="primary-button" disabled={locked} onClick={() => decide(() => onRespond({ action: "accept", content: mode === "url" ? null : submittedContent(), _meta: null }))}>{mode === "url" ? "I’m done" : "Submit"}</button></div></Modal>;
}

function Modal({ title, description, threadLabel, pendingCount, questionDialog = false, describedBy = "", children }: { title: string; description: string; threadLabel?: string; pendingCount?: number; questionDialog?: boolean; describedBy?: string; children: ReactNode }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useModalFocus(modalRef, true, {
    // Keep the approval buttons out of initial focus so Enter cannot answer.
    initialFocus: () => modalRef.current?.querySelector<HTMLElement>("input, select, textarea") ?? headingRef.current,
  });
  useEffect(() => {
    const focusModal = () => { const modal = modalRef.current; if (modal && isTopModalLayer(modal) && !modal.contains(document.activeElement)) (headingRef.current ?? modal).focus(); };
    window.addEventListener(FOCUS_APPROVAL_EVENT, focusModal);
    return () => window.removeEventListener(FOCUS_APPROVAL_EVENT, focusModal);
  }, []);
  return <div className="modal-backdrop approval-backdrop"><div ref={modalRef} className={`approval-modal${questionDialog ? " approval-question-modal" : ""}`} data-approval-modal="" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={[`${id}-description`, describedBy].filter(Boolean).join(" ")} tabIndex={-1} onKeyDown={(event) => {
    // The inner card can use Escape to step back. Unhandled Escape never answers.
    if (event.key !== "Escape" || !isTopModalLayer(event.currentTarget)) return;
    event.preventDefault();
    event.stopPropagation();
  }}><div className="approval-heading"><div className="approval-shield"><ShieldAlert size={22} aria-hidden="true" /></div><h2 ref={headingRef} id={`${id}-title`} tabIndex={-1}>{title}</h2></div><p id={`${id}-description`}>{description}</p>{threadLabel && <div className="approval-thread-line"><MessageSquare size={12} aria-hidden="true" /> Requested by <strong>{threadLabel}</strong></div>}{children}{pendingCount != null && pendingCount > 0 && <div className="approval-queue-note">{pendingCount} more approval{pendingCount === 1 ? "" : "s"} waiting</div>}</div></div>;
}

export function ApprovalCenter({ approval, threadLabel, pendingCount, onRespond }: { approval: PendingApproval; threadLabel?: string; pendingCount?: number; onRespond: (value: JsonObject) => void | Promise<void> }) {
  const context = { threadLabel, pendingCount };
  if ((approval.method === "claude/can_use_tool" && approval.params.tool_name === "AskUserQuestion") || approval.method === "item/tool/requestUserInput" || approval.method === "cursor/ask_question") return <UserInputRequest approval={approval} onRespond={onRespond} {...context} />;
  if (approval.method === "mcpServer/elicitation/request") return <McpRequest approval={approval} onRespond={onRespond} {...context} />;
  return <StandardApproval approval={approval} onRespond={onRespond} {...context} />;
}

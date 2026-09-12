import "./AgentQuestionForm.css";
import { useEffect, useId, useRef, useState } from "react";

import type { AgentQuestionFormProps, QuestionAnswers } from "./AgentQuestionForm";
const drafts = new Map<string, { selected: QuestionAnswers; custom: Record<string, string> }>();

export default function AgentQuestionFields({ questions, onSubmit, onCancel, initialSelection = false, draftKey, focusOnMount, submitLabel = "Submit answers", disabled = false }: AgentQuestionFormProps) {
  const name = useId();
  const [selected, setSelected] = useState<QuestionAnswers>(() => (draftKey && drafts.get(draftKey)?.selected) || Object.fromEntries(questions.map((q) => [q.id, initialSelection && q.options?.length ? [q.options[0].label] : []])));
  const [custom, setCustom] = useState<Record<string, string>>(() => (draftKey && drafts.get(draftKey)?.custom) || {});
  useEffect(() => {
    if (!draftKey) return;
    drafts.delete(draftKey);
    drafts.set(draftKey, { selected, custom });
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  }, [draftKey, selected, custom]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const answers = Object.fromEntries(questions.map((q) => [q.id, custom[q.id]?.trim() ? [...(q.multiSelect ? selected[q.id] ?? [] : []), custom[q.id].trim()] : selected[q.id] ?? []]));
  const valid = questions.length > 0 && questions.every((q) => answers[q.id].length > 0);
  const submit = async (action: () => void | Promise<void>) => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); if (draftKey) drafts.delete(draftKey); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <form className="agent-question-form" onSubmit={(event) => { event.preventDefault(); if (valid) void submit(() => onSubmit(answers)); }}>
    {questions.map((q) => <fieldset key={q.id} disabled={busy}>
      <legend>{q.title}</legend>
      {q.options?.map((option, index) => <label className="agent-question-option" key={index}>
        <input autoFocus={focusOnMount && q === questions[0] && index === 0} type={q.multiSelect ? "checkbox" : "radio"} name={`${name}-${q.id}`} checked={(q.multiSelect || !custom[q.id]) && (selected[q.id] ?? []).includes(option.label)} onChange={() => {
          if (!q.multiSelect) setCustom((current) => ({ ...current, [q.id]: "" }));
          setSelected((current) => ({ ...current, [q.id]: q.multiSelect
            ? (current[q.id] ?? []).includes(option.label) ? current[q.id].filter((value) => value !== option.label) : [...(current[q.id] ?? []), option.label]
            : [option.label] }));
        }} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      <label className="agent-question-custom"><span>{q.options?.length ? q.multiSelect ? "Add your own answer" : "Or write your own answer" : "Your answer"}</span>
        <input autoFocus={focusOnMount && q === questions[0] && !q.options?.length} type={q.secret ? "password" : "text"} value={custom[q.id] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [q.id]: event.target.value }))} />
      </label>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div className="approval-actions">{onCancel && <button type="button" className="secondary-button" disabled={disabled || busy} onClick={() => void submit(onCancel)}>Cancel</button>}
      <button type="submit" className="primary-button" disabled={disabled || busy || !valid}>{busy ? "Sending answers…" : submitLabel}</button></div>
  </form>;
}

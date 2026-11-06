import { createContext, useContext, useState } from "react";
import type { ChatMessage } from "../../types";
import { answerRemoteApproval, answerRemoteQuestion, refreshRemoteCapabilities, useRemoteWork } from "../../lib/remote/remoteWork";
import type { WireApproval, WireQuestion, WireWorkApproval, WireWorkCapabilities } from "../../lib/remote/wire";
import { AgentQuestionForm, type FormQuestion, type QuestionAnswers } from "../AgentQuestionForm";

export interface RemoteThreadScope { device: string; name: string; threadId: string; connected: boolean; workspaceId?: string }
export const RemoteThreadContext = createContext<RemoteThreadScope | null>(null);

function formQuestions(questions: WireQuestion[]): FormQuestion[] {
  return questions.map((question) => ({
    id: question.id, title: question.title, secret: question.secret,
    options: question.options.map((label) => ({ label })),
  }));
}
const hasQuestions = (approval: WireWorkApproval) => Boolean(approval.questions?.length);

/** The request a message's questions belong to, if this device may answer it. */
function approvalFor(capabilities: WireWorkCapabilities | null | undefined, questions: WireQuestion[]): WireWorkApproval | undefined {
  const ids = new Set(questions.map((question) => question.id));
  return capabilities?.approvals.find((approval) => approval.questions?.some((question) => ids.has(question.id)));
}

function QuestionAnswer({ scope, approval }: { scope: RemoteThreadScope; approval: WireWorkApproval }) {
  const [error, setError] = useState("");
  const finish = (message: string | null) => {
    setError(message ?? "");
    void refreshRemoteCapabilities(scope.device, scope.threadId);
  };
  // No draftKey: the form must not keep answers, because some are secret.
  return <>
    <AgentQuestionForm questions={formQuestions(approval.questions ?? [])} disabled={!scope.connected}
      onSubmit={(answers: QuestionAnswers) => answerRemoteQuestion(scope.device, scope.name, scope.threadId, approval.target.handle, answers).then(finish)}
      onCancel={() => answerRemoteQuestion(scope.device, scope.name, scope.threadId, approval.target.handle, null).then(finish)} />
    {error && <p className="remote-composer-error" role="alert">{error}</p>}
  </>;
}

/** Questions inside the timeline. Answering uses the host's handle or nothing:
 * without one, this says where to answer instead. */
export function RemoteMessageQuestions({ message, questions }: { message: ChatMessage; questions: WireQuestion[] }) {
  const scope = useContext(RemoteThreadContext);
  const capabilities = useRemoteWork((state) => scope ? state.capabilities[scope.device] : undefined);
  const name = scope?.name ?? "the other device";
  const approval = approvalFor(capabilities, questions);
  return <section className="agent-questions remote-question" aria-label={`Questions on ${name}`} data-message={message.id}>
    <strong>Questions on {name}</strong>
    {scope && approval
      ? <QuestionAnswer scope={scope} approval={approval} />
      : <dl>{questions.map((question) => <div key={question.id}><dt>{question.title}</dt><dd>
        {question.answered ? question.secret ? `Private answer submitted on ${name}.` : question.answers?.join(", ") || `Answer submitted on ${name}.`
          : `Continue on ${name} to answer this request.`}
      </dd></div>)}</dl>}
  </section>;
}

function ApprovalRow({ scope, approval }: { scope: RemoteThreadScope; approval: WireWorkApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = (decision: "allowOnce" | "deny") => {
    setBusy(true);
    setError("");
    void answerRemoteApproval(scope.device, scope.name, scope.threadId, approval.target.handle, decision).then((message) => {
      setError(message ?? "");
      setBusy(false);
      void refreshRemoteCapabilities(scope.device, scope.threadId);
    });
  };
  return <div className="remote-request">
    <p>{approval.summary}</p>
    <div className="remote-row-actions">
      {approval.canDeny && <button type="button" className="secondary-button" disabled={busy || !scope.connected} onClick={() => answer("deny")}>Deny</button>}
      {approval.canAllowOnce && <button type="button" className="primary-button" disabled={busy || !scope.connected} onClick={() => answer("allowOnce")}>Allow once</button>}
    </div>
    {error && <p className="remote-composer-error" role="alert">{error}</p>}
  </div>;
}

/** Everything waiting on an answer. Only what the host's capabilities offer is
 * actionable, so the controls can't exceed what the grant allows. */
export function RemoteRequests({ scope, summaries, capabilities, questionsInTimeline }: {
  scope: RemoteThreadScope;
  summaries: WireApproval[];
  capabilities: WireWorkCapabilities | null | undefined;
  questionsInTimeline: ReadonlySet<string>;
}) {
  const actionable = capabilities?.approvals ?? [];
  const decisions = actionable.filter((approval) => !hasQuestions(approval));
  const looseQuestions = actionable.filter((approval) => hasQuestions(approval)
    && !approval.questions?.some((question) => questionsInTimeline.has(question.id)));
  const hostOnly = summaries.slice(actionable.length);
  if (!decisions.length && !looseQuestions.length && !hostOnly.length) return null;
  return <div className="remote-banner remote-requests" role="status">
    <strong>Waiting on you</strong>
    {decisions.map((approval) => <ApprovalRow key={approval.target.handle} scope={scope} approval={approval} />)}
    {looseQuestions.map((approval) => <QuestionAnswer key={approval.target.handle} scope={scope} approval={approval} />)}
    {hostOnly.map((entry) => <p key={entry.id}>{entry.summary} Continue on {scope.name} to answer this request.</p>)}
  </div>;
}

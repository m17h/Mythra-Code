import { useContext, useState } from "react";
import type { ChatMessage } from "../types";
import { savedQuestionAnswers, saveQuestionAnswers } from "../lib/agentQuestionRecords";
import { AgentQuestionForm, type QuestionAnswers } from "./AgentQuestionForm";

import { AgentQuestionDelivery } from "../lib/agentQuestionContext";

const deliveries = new Map<string, Promise<QuestionAnswers>>();

export function AsyncAgentQuestions({ message }: { message: ChatMessage }) {
  const delivery = useContext(AgentQuestionDelivery);
  const key = `kiwi.questionAnswer:${delivery?.threadId}:${message.id}`;
  const [saved, setSaved] = useState<QuestionAnswers | null>(() => savedQuestionAnswers(delivery?.threadId ?? "", message.id));
  if (!delivery || !message.questions?.length) return null;
  const questions = message.questions.map((question, index) => ({ id: question.id ?? String(index), title: question.title,
    secret: question.secret, options: question.options?.map((label) => ({ label })) }));
  return <section className="agent-questions" aria-label="Agent questions">
    <strong>{saved ? "Answers sent" : "Your input"}</strong>
    {saved ? <dl>{questions.map((question) => <div key={question.id}><dt>{question.title}</dt><dd>{saved[question.id]?.join(", ")}</dd></div>)}</dl> : <>
      <p>The agent can keep working. Submit your answers to guide its work, or continue the task if it has finished.</p>
      <AgentQuestionForm draftKey={key} questions={questions} initialSelection onSubmit={async (answers) => {
        const text = `Answers to your questions:\n\n${questions.map((question) => `${question.title}\n${answers[question.id].join(", ")}`).join("\n\n")}`;
        let pending = deliveries.get(key);
        if (!pending) {
          pending = (async () => {
            const existing = savedQuestionAnswers(delivery?.threadId ?? "", message.id);
            if (existing) return existing;
            if (!await delivery.send(delivery.threadId, text, { message, answers })) throw new Error("The answers were not sent. Please try again.");
            const recorded = Object.fromEntries(questions.map((question) => [question.id, question.secret ? ["Answer sent"] : answers[question.id]]));
            saveQuestionAnswers(delivery.threadId, message.id, recorded);
            return recorded;
          })();
          deliveries.set(key, pending);
        }
        try { setSaved(await pending); }
        finally { if (deliveries.get(key) === pending) deliveries.delete(key); }
      }} />
    </>}
  </section>;
}

import { lazy, Suspense } from "react";

export interface FormQuestion {
  id: string;
  title: string;
  options?: Array<{ label: string; description?: string }> | null;
  multiSelect?: boolean;
  secret?: boolean;
}
export type QuestionAnswers = Record<string, string[]>;

export interface AgentQuestionFormProps {
  questions: FormQuestion[];
  onSubmit: (answers: QuestionAnswers) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  initialSelection?: boolean;
  draftKey?: string;
  submitLabel?: string;
  disabled?: boolean;
  focusOnMount?: boolean;
}

const Fields = lazy(() => import("./AgentQuestionFields"));

export function AgentQuestionForm(props: AgentQuestionFormProps) {
  return <Suspense fallback={<p role="status">Loading questions…</p>}><Fields key={props.draftKey} {...props} /></Suspense>;
}

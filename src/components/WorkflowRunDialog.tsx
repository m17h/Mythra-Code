import { useEffect, useRef, useState } from "react";
import { Play, TerminalSquare, X } from "lucide-react";
import { useModalFocus } from "../hooks/useModalFocus";
import { interpolateWorkflowText, type WorkflowDefinition } from "../lib/workflows";
import type { Project } from "../types";
import { AppSelectMenu } from "./AppSelectMenu";

export function WorkflowRunDialog({ workflow, projects, initialProjectId, userPrompt, onClose, onRun }: {
  workflow: WorkflowDefinition;
  projects: Project[];
  initialProjectId?: string;
  userPrompt?: string;
  onClose: () => void;
  onRun: (workflowId: string, variables: Record<string, string>, projectId: string) => void;
}) {
  const [projectId, setProjectId] = useState(() => projects.some((project) => project.id === initialProjectId)
    ? initialProjectId! : projects.some((project) => project.id === workflow.projectId) ? workflow.projectId : projects[0]?.id ?? "");
  const [variables, setVariables] = useState(() => Object.fromEntries((workflow.variables ?? []).map((variable) => [variable.name, variable.value])));
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, true);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onClose]);
  const project = projects.find((item) => item.id === projectId);
  const previewVariables = { ...variables, projectPath: project?.path ?? "", projectName: project?.name ?? "", workflowName: workflow.name };
  return (
    <div className="workflow-dialog-backdrop" onMouseDown={onClose}>
      <div className="workflow-run-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={`Run ${workflow.name}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="workflow-editor-header">
          <span><Play size={15} /><strong>Run {workflow.name}</strong></span>
          <button className="icon-button" onClick={onClose} aria-label="Close run workflow dialog"><X size={14} /></button>
        </div>
        <p>{workflow.description || `Run ${workflow.steps.length} ordered step${workflow.steps.length === 1 ? "" : "s"} in a new project thread.`}</p>
        <div className="workflow-select-field"><span>Run in project</span><AppSelectMenu ariaLabel="Run in project" value={projectId} options={projects.map((item) => ({ value: item.id, label: item.name, detail: item.path }))} portal onChange={setProjectId} /></div>
        {userPrompt?.trim() && <div className="workflow-user-prompt"><strong>Additional instructions</strong><p>{userPrompt}</p></div>}
        {(workflow.variables ?? []).filter((variable) => variable.promptOnRun).map((variable) => (
          <label className="workflow-run-input" key={variable.id}><span>{variable.name}</span><input value={variables[variable.name] ?? ""} onChange={(event) => setVariables({ ...variables, [variable.name]: event.target.value })} placeholder={variable.value || "Value for this run"} /></label>
        ))}
        {workflow.steps.some((step) => step.type === "command") && (
          <div className="workflow-command-warning"><TerminalSquare size={14} /><span><strong>Shell commands included</strong><small>Commands run in the selected project with {workflow.run.permission} permissions. Input values are substituted literally; step-result variables resolve while running.</small>{workflow.steps.filter((step) => step.type === "command").map((step) => <code key={step.id}>{interpolateWorkflowText(step.command, previewVariables)}</code>)}</span></div>
        )}
        <div className="workflow-run-summary"><span>{workflow.steps.length} steps</span><span>{({ openai: "OpenAI", claude: "Claude", cursor: "Cursor", openrouter: "OpenRouter", lmstudio: "LM Studio" })[workflow.run.provider]} · {workflow.run.model}</span><span>{workflow.run.reasoningEffort}{workflow.run.ultra ? " + Ultra" : ""}</span></div>
        {!projects.length && <p>Add a project before running this recipe.</p>}
        <div className="workflow-editor-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!project} onClick={() => onRun(workflow.id, variables, projectId)}><Play size={12} /> Run now</button></div>
      </div>
    </div>
  );
}

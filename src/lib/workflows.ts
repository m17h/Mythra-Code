import type { ScheduleRunSettings, ScheduledTask } from "../types";

export type WorkflowTrigger =
  | { type: "manual" }
  | { type: "interval"; intervalMinutes: number }
  | { type: "app-start" };

export type WorkflowStepCondition =
  | { type: "always" }
  | { type: "previous-succeeded" }
  | { type: "previous-failed" }
  | { type: "variable-equals"; variable: string; value: string };

export interface WorkflowVariable {
  id: string;
  name: string;
  value: string;
  promptOnRun: boolean;
}

interface WorkflowStepBehavior {
  continueOnError: boolean;
  condition?: WorkflowStepCondition;
  retryCount?: number;
  retryDelaySeconds?: number;
}

export type WorkflowStep =
  | WorkflowStepBehavior & {
      id: string;
      type: "agent";
      name: string;
      prompt: string;
    }
  | WorkflowStepBehavior & {
      id: string;
      type: "command";
      name: string;
      command: string;
    };

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  projectId: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  skillNames: string[];
  variables?: WorkflowVariable[];
  run: ScheduleRunSettings;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastThreadId?: string;
  consecutiveFailures?: number;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "interrupted";
export type WorkflowRunSource = "manual" | "interval" | "app-start";
export type WorkflowRunStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "interrupted";

export interface WorkflowRunStepRecord {
  stepId: string;
  name: string;
  type: WorkflowStep["type"];
  status: WorkflowRunStepStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  output?: string;
  error?: string;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  threadId?: string;
  source: WorkflowRunSource;
  startedAt: number;
  finishedAt?: number;
  currentStep: number;
  stepCount: number;
  status: WorkflowRunStatus;
  variables?: Record<string, string>;
  steps?: WorkflowRunStepRecord[];
  stopRequestedAt?: number;
  recovered?: boolean;
  error?: string;
}

export function nextWorkflowRunAt(trigger: WorkflowTrigger, now = Date.now()): number | undefined {
  return trigger.type === "interval"
    ? now + Math.max(5, trigger.intervalMinutes) * 60_000
    : undefined;
}

export function nextWorkflowFailureAt(
  trigger: WorkflowTrigger,
  consecutiveFailures: number,
  now = Date.now(),
): number | undefined {
  if (trigger.type !== "interval") return undefined;
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const delayMinutes = Math.min(
    24 * 60,
    Math.max(5, trigger.intervalMinutes) * (2 ** Math.min(5, failures - 1)),
  );
  return now + delayMinutes * 60_000;
}

export function workflowTriggerLabel(trigger: WorkflowTrigger): string {
  if (trigger.type === "interval") return `Every ${Math.max(5, trigger.intervalMinutes)} min`;
  if (trigger.type === "app-start") return "When Mythra Code starts";
  return "Manual";
}

export function workflowStepText(step: WorkflowStep): string {
  return step.type === "agent" ? step.prompt : step.command;
}

export function workflowStepCondition(step: WorkflowStep): WorkflowStepCondition {
  return step.condition ?? { type: "always" };
}

export function workflowStepRetries(step: WorkflowStep): { count: number; delaySeconds: number } {
  return {
    count: Math.min(5, Math.max(0, Math.floor(step.retryCount ?? 0))),
    delaySeconds: Math.min(300, Math.max(0, Math.floor(step.retryDelaySeconds ?? 0))),
  };
}

export function normalizeWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return {
    ...workflow,
    consecutiveFailures: Math.max(0, Math.floor(workflow.consecutiveFailures ?? 0)),
    variables: workflow.variables ?? [],
    steps: workflow.steps.map((step) => ({
      ...step,
      condition: workflowStepCondition(step),
      retryCount: workflowStepRetries(step).count,
      retryDelaySeconds: workflowStepRetries(step).delaySeconds,
    })),
  };
}

export function compactWorkflowRun(
  run: WorkflowRunRecord,
  outputLimit = 4_000,
): WorkflowRunRecord {
  if (run.status === "running") return run;
  const compactOutput = (output: string | undefined) => output && output.length > outputLimit
    ? `…${output.slice(-outputLimit)}`
    : output;
  return {
    ...run,
    variables: run.variables
      ? { ...run.variables, previousStepOutput: compactOutput(run.variables.previousStepOutput) ?? "" }
      : undefined,
    steps: run.steps?.map((step) => ({
      ...step,
      output: compactOutput(step.output),
    })),
  };
}

export function normalizeWorkflows(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
  return workflows.map(normalizeWorkflow);
}

export function interpolateWorkflowText(text: string, variables: Record<string, string>): string {
  return text.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g, (match, name: string) => (
    Object.hasOwn(variables, name) ? variables[name] : match
  ));
}

export function shouldRunWorkflowStep(
  step: WorkflowStep,
  previousStatus: "none" | "completed" | "failed" | "skipped",
  variables: Record<string, string>,
): boolean {
  const condition = workflowStepCondition(step);
  if (condition.type === "previous-succeeded") return previousStatus === "completed";
  if (condition.type === "previous-failed") return previousStatus === "failed";
  if (condition.type === "variable-equals") return (variables[condition.variable] ?? "") === interpolateWorkflowText(condition.value, variables);
  return true;
}

export function recoverWorkflowRuns(runs: WorkflowRunRecord[], now = Date.now()): WorkflowRunRecord[] {
  return runs.map((run) => run.status !== "running" ? run : {
    ...run,
    status: "interrupted",
    finishedAt: now,
    recovered: true,
    error: "Mythra Code closed before this workflow finished.",
    steps: run.steps?.map((step) => step.status !== "running" ? step : {
      ...step,
      status: "interrupted",
      finishedAt: now,
      error: "Interrupted when Mythra Code closed.",
    }),
  });
}

export function validateWorkflow(workflow: WorkflowDefinition): string | null {
  if (!workflow.name.trim()) return "Give the workflow a name.";
  if (!workflow.projectId) return "Choose a project.";
  if (!workflow.steps.length) return "Add at least one workflow step.";
  if (workflow.trigger.type === "interval" && workflow.trigger.intervalMinutes < 5) {
    return "Intervals must be at least five minutes.";
  }
  for (const [index, step] of workflow.steps.entries()) {
    if (!step.name.trim()) return `Step ${index + 1} needs a name.`;
    if (!workflowStepText(step).trim()) return `Step ${index + 1} is empty.`;
    const retries = workflowStepRetries(step);
    if ((step.retryCount ?? 0) !== retries.count) return `Step ${index + 1} retries must be between 0 and 5.`;
    if ((step.retryDelaySeconds ?? 0) !== retries.delaySeconds) return `Step ${index + 1} retry delay must be between 0 and 300 seconds.`;
    const condition = workflowStepCondition(step);
    if (condition.type === "variable-equals" && !condition.variable.trim()) return `Step ${index + 1} needs a condition variable.`;
  }
  const seenVariables = new Set<string>();
  for (const variable of workflow.variables ?? []) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(variable.name)) {
      return `Variable “${variable.name || "unnamed"}” needs a simple name containing letters, numbers, dashes, or underscores.`;
    }
    if (seenVariables.has(variable.name)) return `Variable “${variable.name}” is duplicated.`;
    seenVariables.add(variable.name);
  }
  return null;
}

export function workflowPrompt(
  workflow: WorkflowDefinition,
  step: Extract<WorkflowStep, { type: "agent" }>,
  stepIndex: number,
  variables: Record<string, string> = {},
): string {
  const prompt = interpolateWorkflowText(step.prompt.trim(), variables);
  const skills = workflow.skillNames.length
    ? `\n\nSkills available for this step: ${workflow.skillNames.map((name) => `@${name}`).join(", ")}. Use them when relevant.`
    : "";
  return `[Workflow: ${workflow.name} · Step ${stepIndex + 1}/${workflow.steps.length}: ${step.name}]\n\n${prompt}${skills}`;
}

export function workflowFromSchedule(
  scheduled: ScheduledTask,
  run: ScheduleRunSettings,
  now = Date.now(),
): WorkflowDefinition {
  return {
    id: crypto.randomUUID(),
    name: scheduled.name,
    description: "Imported from a simple scheduled task.",
    projectId: scheduled.projectId ?? "",
    // Keep the source schedule intact for rollback, but never let the converted
    // workflow run alongside it until the user explicitly enables the workflow.
    enabled: false,
    trigger: { type: "interval", intervalMinutes: Math.max(5, scheduled.intervalMinutes) },
    steps: [{
      id: crypto.randomUUID(),
      type: "agent",
      name: "Run prompt",
      prompt: scheduled.prompt,
      continueOnError: false,
    }],
    skillNames: [],
    variables: [],
    run: scheduled.run ?? run,
    createdAt: now,
    updatedAt: now,
    nextRunAt: scheduled.nextRunAt || nextWorkflowRunAt({ type: "interval", intervalMinutes: scheduled.intervalMinutes }, now),
    lastRunAt: scheduled.lastRunAt,
    lastThreadId: scheduled.lastThreadId,
  };
}

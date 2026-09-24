import type { ScheduleRunSettings } from "../types";
import { validateWorkflow, type WorkflowDefinition, type WorkflowStepCondition } from "./workflows";

export const MAX_RECIPE_BYTES = 256_000;

// Deliberate allowlist: recipes never transfer runtime credentials/prompts,
// permissions, project bindings, schedules, history, or local identities.
export function exportWorkflowRecipe(workflow: WorkflowDefinition): string {
  if (workflow.steps.length > 100 || workflow.skillNames.length > 100 || (workflow.variables?.length ?? 0) > 100) throw new Error("Shared recipes support up to 100 steps, skills, and inputs each.");
  const contents = JSON.stringify({
    format: "mythra-workflow", version: 1,
    name: workflow.name, description: workflow.description,
    steps: workflow.steps.map((step) => ({
      type: step.type, name: step.name,
      ...(step.type === "agent" ? { prompt: step.prompt } : { command: step.command }),
      continueOnError: step.continueOnError,
      condition: condition(step.condition), retryCount: step.retryCount, retryDelaySeconds: step.retryDelaySeconds,
    })),
    skills: workflow.skillNames,
    variables: (workflow.variables ?? []).map(({ name, value, promptOnRun }) => ({ name, value, promptOnRun })),
  }, null, 2) + "\n";
  if (new TextEncoder().encode(contents).byteLength > MAX_RECIPE_BYTES) throw new Error("Recipe files must be smaller than 256 KB.");
  return contents;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recipe: expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error("Invalid recipe: expected text.");
  return value;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Invalid recipe: expected a list of at most ${limit} items.`);
  return value;
}
function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("Invalid recipe: expected true or false.");
  return value;
}
function number(value: unknown, max: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw new Error("Invalid recipe: retry settings are out of range.");
  return value;
}
function condition(value: unknown): WorkflowStepCondition {
  if (value === undefined) return { type: "always" };
  const entry = object(value);
  if (entry.type === "always" || entry.type === "previous-succeeded" || entry.type === "previous-failed") return { type: entry.type };
  if (entry.type === "variable-equals") return { type: entry.type, variable: text(entry.variable), value: text(entry.value) };
  throw new Error("Invalid recipe: unknown step condition.");
}

export function importWorkflowRecipe(contents: string, run: ScheduleRunSettings): WorkflowDefinition {
  if (new TextEncoder().encode(contents).byteLength > MAX_RECIPE_BYTES) throw new Error("Recipe files must be smaller than 256 KB.");
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch { throw new Error("This file is not a valid workflow recipe."); }
  const value = object(parsed);
  if (value.format !== "mythra-workflow" || value.version !== 1) throw new Error("Unsupported workflow recipe format or version.");
  const now = Date.now();
  const workflow: WorkflowDefinition = {
    id: crypto.randomUUID(), name: text(value.name), description: text(value.description, ""),
    projectId: "", enabled: true, trigger: { type: "manual" }, run: structuredClone(run),
    createdAt: now, updatedAt: now,
    steps: list(value.steps, 100).map((item) => {
      const step = object(item);
      const common = { id: crypto.randomUUID(), name: text(step.name), continueOnError: flag(step.continueOnError),
        condition: condition(step.condition), retryCount: number(step.retryCount, 5), retryDelaySeconds: number(step.retryDelaySeconds, 300) };
      if (step.type === "agent") return { ...common, type: "agent", prompt: text(step.prompt) };
      if (step.type === "command") return { ...common, type: "command", command: text(step.command) };
      throw new Error("Invalid recipe: unknown step type.");
    }),
    skillNames: list(value.skills ?? [], 100).map((item) => text(item)),
    variables: list(value.variables ?? [], 100).map((item) => {
      const variable = object(item);
      return { id: crypto.randomUUID(), name: text(variable.name), value: text(variable.value, ""), promptOnRun: flag(variable.promptOnRun) };
    }),
  };
  const error = validateWorkflow(workflow);
  if (error) throw new Error(error);
  return workflow;
}

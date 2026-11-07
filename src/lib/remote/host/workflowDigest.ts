import type { WorkflowDefinition } from "../../workflows";
import { HostReadError } from "./scope";

/** Same fields as App's reviewed-launch snapshot. Object key order is not
 * meaningful, but array order (steps, inputs and skills) always is. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export function workflowRecipeSnapshot(workflow: WorkflowDefinition): string {
  return canonical([workflow.name, workflow.steps, workflow.variables, workflow.skillNames, workflow.run]);
}
export async function workflowRecipeDigest(workflow: WorkflowDefinition): Promise<string> {
  return snapshotDigest(workflowRecipeSnapshot(workflow));
}
async function snapshotDigest(snapshot: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function workflowChanged(host: string): HostReadError {
  return new HostReadError("workflow_changed", `This workflow changed on ${host} after you reviewed it. Review it again before running.`);
}
/** The caller rechecks the returned snapshot synchronously immediately before
 * engine.runWorkflow; hashing must not introduce a recipe-swap race. */
export async function reviewedWorkflowSnapshot(resolve: () => WorkflowDefinition | undefined, digest: string, host: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new HostReadError("invalid", "That workflow digest is not valid.");
  const workflow = resolve();
  if (!workflow) throw workflowChanged(host);
  const snapshot = workflowRecipeSnapshot(workflow);
  if (await snapshotDigest(snapshot) !== digest) throw workflowChanged(host);
  return snapshot;
}

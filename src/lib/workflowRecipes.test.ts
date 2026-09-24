import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./appConfig";
import { scheduleRunSnapshot } from "./turnConfig";
import { exportWorkflowRecipe, importWorkflowRecipe } from "./workflowRecipes";
import type { WorkflowDefinition } from "./workflows";

const run = scheduleRunSnapshot(DEFAULT_SETTINGS);
const recipe: WorkflowDefinition = {
  id: "private-id", name: "Review branch", description: "Reusable review", projectId: "private-project",
  enabled: true, trigger: { type: "interval", intervalMinutes: 10 },
  run: { ...run, systemPrompt: "private custom instructions" },
  createdAt: 1, updatedAt: 2, lastThreadId: "private-thread", nextRunAt: 3,
  skillNames: ["review"], variables: [{ id: "v", name: "branch", value: "main", promptOnRun: true }],
  steps: [{ id: "step", name: "Check", type: "command", command: "git status", continueOnError: false, retryCount: 2, retryDelaySeconds: 1 }],
};

describe("portable workflow recipes", () => {
  it("roundtrips recipe contents but removes machine settings and automation", () => {
    const contents = exportWorkflowRecipe(recipe);
    for (const privateValue of ["private-id", "private-project", "private custom instructions", "private-thread", "interval"]) expect(contents).not.toContain(privateValue);
    const result = importWorkflowRecipe(contents, run);
    expect(result).toMatchObject({ name: recipe.name, projectId: "", trigger: { type: "manual" }, run, skillNames: ["review"] });
    expect(result.steps[0]).toMatchObject({ command: "git status", retryCount: 2 });
    expect(result.variables?.[0]).toMatchObject({ name: "branch", value: "main", promptOnRun: true });
    expect(result.id).not.toBe(recipe.id);
    expect(result.steps[0].id).not.toBe(recipe.steps[0].id);
    expect(result.lastThreadId).toBeUndefined();
  });
  it("ignores injected permissions, project binding, and startup triggers", () => {
    const data = { ...JSON.parse(exportWorkflowRecipe(recipe)), run: { permission: "full-access" }, projectId: "other", trigger: { type: "app-start" } };
    expect(importWorkflowRecipe(JSON.stringify(data), run)).toMatchObject({ run, projectId: "", trigger: { type: "manual" } });
  });
  it("rejects imported names with leading whitespace and keeps valid spaces", () => {
    const data = JSON.parse(exportWorkflowRecipe(recipe));
    expect(() => importWorkflowRecipe(JSON.stringify({ ...data, name: "\u00a0Review branch" }), run))
      .toThrow("Workflow names cannot start with whitespace.");
    expect(importWorkflowRecipe(JSON.stringify({ ...data, name: "Review this branch" }), run).name)
      .toBe("Review this branch");
  });
  it.each([
    { version: 2 }, { steps: "not a list" }, { steps: [{ type: "surprise" }] },
    { steps: [{ name: "Bad", type: "agent", prompt: "x", retryCount: 99 }] },
    { variables: [{ name: "bad name", value: "", promptOnRun: true }] },
    { steps: [{ name: "Bad", type: "agent", prompt: "x", condition: { type: "unknown" } }] },
  ])("rejects malformed recipe contents %j", (patch) => {
    expect(() => importWorkflowRecipe(JSON.stringify({ ...JSON.parse(exportWorkflowRecipe(recipe)), ...patch }), run)).toThrow();
  });
  it("rejects excessive files and too many steps", () => {
    expect(() => importWorkflowRecipe(" ".repeat(256001), run)).toThrow("256 KB");
    expect(() => importWorkflowRecipe(JSON.stringify({ ...JSON.parse(exportWorkflowRecipe(recipe)), steps: Array(101).fill({}) }), run)).toThrow("100 items");
  });
});

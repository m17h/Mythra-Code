import { describe, expect, it, vi } from "vitest";
import type { ScheduleRunSettings } from "../types";
import {
  compactWorkflowRun,
  nextWorkflowFailureAt,
  nextWorkflowRunAt,
  interpolateWorkflowText,
  normalizeWorkflow,
  recoverWorkflowRuns,
  shouldRunWorkflowStep,
  validateWorkflow,
  workflowFromSchedule,
  workflowPrompt,
  workflowTriggerLabel,
  type WorkflowDefinition,
} from "./workflows";

const run: ScheduleRunSettings = {
  provider: "openai",
  model: "gpt-test",
  permission: "ask",
  systemPrompt: "",
  projectInstructionsEnabled: false,
  subagentsEnabled: false,
  subagentMax: 3,
  reasoningEffort: "medium",
  ultra: false,
  serviceTier: null,
};

function workflow(): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Release check",
    description: "",
    projectId: "project-1",
    enabled: true,
    trigger: { type: "manual" },
    steps: [{
      id: "step-1",
      type: "agent",
      name: "Review",
      prompt: "Review the release.",
      continueOnError: false,
    }],
    skillNames: ["release-review"],
    run,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("workflow definitions", () => {
  it("validates required project and step content", () => {
    expect(validateWorkflow(workflow())).toBeNull();
    expect(validateWorkflow({ ...workflow(), projectId: "" })).toBe("Choose a project.");
    expect(validateWorkflow({ ...workflow(), steps: [] })).toBe("Add at least one workflow step.");
  });

  it("builds a visible, user-authored step prompt with selected skills", () => {
    const item = workflow();
    const step = item.steps[0];
    if (step.type !== "agent") throw new Error("Expected agent step");
    expect(workflowPrompt(item, step, 0)).toContain("Review the release.");
    expect(workflowPrompt(item, step, 0)).toContain("@release-review");
  });

  it("normalizes interval timing and labels", () => {
    expect(nextWorkflowRunAt({ type: "interval", intervalMinutes: 1 }, 1_000)).toBe(301_000);
    expect(nextWorkflowFailureAt({ type: "interval", intervalMinutes: 60 }, 1, 1_000)).toBe(3_601_000);
    expect(nextWorkflowFailureAt({ type: "interval", intervalMinutes: 60 }, 2, 1_000)).toBe(7_201_000);
    expect(nextWorkflowFailureAt({ type: "interval", intervalMinutes: 60 }, 10, 1_000)).toBe(86_401_000);
    expect(workflowTriggerLabel({ type: "interval", intervalMinutes: 30 })).toBe("Every 30 min");
  });

  it("interpolates variables and evaluates step conditions", () => {
    expect(interpolateWorkflowText("Ship ${branch} from ${projectPath}", {
      branch: "main",
      projectPath: "/tmp/project",
    })).toBe("Ship main from /tmp/project");
    expect(interpolateWorkflowText("Keep ${unknown}", {})).toBe("Keep ${unknown}");
    const step = { ...workflow().steps[0], condition: { type: "variable-equals" as const, variable: "branch", value: "main" } };
    expect(shouldRunWorkflowStep(step, "none", { branch: "main" })).toBe(true);
    expect(shouldRunWorkflowStep(step, "none", { branch: "feature" })).toBe(false);
    expect(shouldRunWorkflowStep({ ...step, condition: { type: "previous-failed" } }, "failed", {})).toBe(true);
  });

  it("normalizes legacy steps and recovers unfinished runs after an app exit", () => {
    const normalized = normalizeWorkflow(workflow());
    expect(normalized.variables).toEqual([]);
    expect(normalized.steps[0]).toMatchObject({
      condition: { type: "always" },
      retryCount: 0,
      retryDelaySeconds: 0,
    });
    const recovered = recoverWorkflowRuns([{
      id: "run-1",
      workflowId: "workflow-1",
      workflowName: "Release check",
      projectId: "project-1",
      source: "manual",
      startedAt: 1,
      currentStep: 1,
      stepCount: 1,
      status: "running",
      steps: [{ stepId: "step-1", name: "Review", type: "agent", status: "running", attempts: 1 }],
    }], 5_000);
    expect(recovered[0]).toMatchObject({ status: "interrupted", finishedAt: 5_000, recovered: true });
    expect(recovered[0].steps?.[0]).toMatchObject({ status: "interrupted", finishedAt: 5_000 });
  });

  it("imports a scheduled task without losing its runtime snapshot", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const imported = workflowFromSchedule({
      id: "schedule-1",
      name: "Nightly review",
      prompt: "Review recent changes.",
      projectId: "project-1",
      intervalMinutes: 60,
      enabled: true,
      nextRunAt: 50_000,
      run,
    }, run, 10_000);
    expect(imported.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(imported.steps[0]).toMatchObject({ id: "00000000-0000-4000-8000-000000000002", type: "agent", prompt: "Review recent changes." });
    expect(imported.enabled).toBe(false);
    expect(imported.run).toEqual(run);
    expect(imported.nextRunAt).toBe(50_000);
  });

  it("compacts completed run output while preserving live output", () => {
    const baseRun = {
      id: "run-1",
      workflowId: "workflow-1",
      workflowName: "Release check",
      projectId: "project-1",
      source: "manual" as const,
      startedAt: 1,
      currentStep: 1,
      stepCount: 1,
      status: "completed" as const,
      variables: { previousStepOutput: "abcdefghij" },
      steps: [{
        stepId: "step-1",
        name: "Review",
        type: "agent" as const,
        status: "completed" as const,
        attempts: 1,
        output: "0123456789",
      }],
    };
    expect(compactWorkflowRun(baseRun, 4).steps?.[0].output).toBe("…6789");
    expect(compactWorkflowRun(baseRun, 4).variables?.previousStepOutput).toBe("…ghij");
    expect(compactWorkflowRun({ ...baseRun, status: "running" }, 4).steps?.[0].output).toBe("0123456789");
    expect(compactWorkflowRun({ ...baseRun, status: "running" }, 4).variables?.previousStepOutput).toBe("abcdefghij");
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { WorkflowManager } from "./WorkflowManager";

const project = { id: "project-1", name: "OpenKiwi", path: "/tmp/openkiwi" };

describe("WorkflowManager", () => {
  it("creates a transparent agent workflow with a runtime snapshot", () => {
    const onWorkflows = vi.fn();
    render(
      <WorkflowManager
        workflows={[]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={onWorkflows}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByPlaceholderText("Release readiness"), { target: { value: "Release readiness" } });
    fireEvent.change(screen.getByPlaceholderText("Tell the agent exactly what to accomplish and how to verify it."), {
      target: { value: "Run the tests and summarize any failures." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));

    expect(onWorkflows).toHaveBeenCalledOnce();
    const created = onWorkflows.mock.calls[0][0][0];
    expect(created).toMatchObject({
      name: "Release readiness",
      projectId: "project-1",
      trigger: { type: "manual" },
      run: { provider: DEFAULT_SETTINGS.provider, model: DEFAULT_SETTINGS.model },
    });
    expect(created.steps[0]).toMatchObject({
      type: "agent",
      prompt: "Run the tests and summarize any failures.",
    });
  });

  it("shows validation errors without saving an incomplete recipe", () => {
    const onWorkflows = vi.fn();
    render(
      <WorkflowManager
        workflows={[]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={onWorkflows}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(screen.getByText("Give the workflow a name.")).toBeInTheDocument();
    expect(onWorkflows).not.toHaveBeenCalled();
  });

  it("lets the interval field hold transient values while typing and clamps on blur", () => {
    render(
      <WorkflowManager
        workflows={[]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={vi.fn()}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Trigger" }), { target: { value: "interval" } });
    const interval = screen.getByRole("spinbutton", { name: "Every (minutes)" });

    // Typing "45" passes through "4", which must not snap to the minimum.
    fireEvent.change(interval, { target: { value: "4" } });
    expect(interval).toHaveValue(4);
    fireEvent.change(interval, { target: { value: "45" } });
    fireEvent.blur(interval);
    expect(interval).toHaveValue(45);

    fireEvent.change(interval, { target: { value: "2" } });
    fireEvent.blur(interval);
    expect(interval).toHaveValue(5);
  });

  it("moves focus into the run dialog and closes it on Escape", () => {
    const onRun = vi.fn();
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Release",
      description: "",
      projectId: project.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{ id: "step-1", type: "command", name: "Check", command: "git status", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <WorkflowManager
        workflows={[workflow]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={vi.fn()}
        onRun={onRun}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const dialog = screen.getByRole("dialog", { name: "Run Release" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Run Release" })).not.toBeInTheDocument();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("collects prompted variables before a manual run", () => {
    const onRun = vi.fn();
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Release",
      description: "Prepare a release.",
      projectId: project.id,
      enabled: true,
      trigger: { type: "manual" },
      variables: [{ id: "variable-1", name: "branch", value: "main", promptOnRun: true }],
      steps: [{ id: "step-1", type: "command", name: "Check", command: "git status", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <WorkflowManager
        workflows={[workflow]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={vi.fn()}
        onRun={onRun}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.change(screen.getByRole("textbox", { name: "branch" }), { target: { value: "release/next" } });
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(onRun).toHaveBeenCalledWith("workflow-1", { branch: "release/next" });
  });

  it("edits conditions and preserves reordered steps", () => {
    const onWorkflows = vi.fn();
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Recovery",
      description: "",
      projectId: project.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{
        id: "step-1",
        type: "command",
        name: "Check",
        command: "npm test",
        continueOnError: true,
      }, {
        id: "step-2",
        type: "agent",
        name: "Recover",
        prompt: "Fix it",
        continueOnError: false,
      }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    render(
      <WorkflowManager
        workflows={[workflow]}
        runs={[]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={onWorkflows}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const conditions = screen.getAllByRole("combobox", { name: "Run when" });
    fireEvent.change(conditions[1], { target: { value: "previous-failed" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Recover up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));

    const updated = onWorkflows.mock.calls[0][0][0] as WorkflowDefinition;
    expect(updated.steps.map((step) => step.name)).toEqual(["Recover", "Check"]);
    expect(updated.steps[0].condition).toEqual({ type: "previous-failed" });
  });

  it("shows step attempts, output, and errors in run details", () => {
    const workflow: WorkflowDefinition = {
      id: "workflow-1",
      name: "Release",
      description: "",
      projectId: project.id,
      enabled: true,
      trigger: { type: "manual" },
      steps: [{ id: "step-1", type: "command", name: "Tests", command: "npm test", continueOnError: false }],
      skillNames: [],
      run: scheduleRunSnapshot(DEFAULT_SETTINGS),
      createdAt: 1,
      updatedAt: 1,
    };
    const run: WorkflowRunRecord = {
      id: "run-1",
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: project.id,
      source: "manual",
      startedAt: 1,
      finishedAt: 2,
      currentStep: 1,
      stepCount: 1,
      status: "failed",
      error: "Tests failed",
      steps: [{
        stepId: "step-1",
        name: "Tests",
        type: "command",
        status: "failed",
        attempts: 2,
        output: "1 failing test",
        error: "Command exited with code 1.",
      }],
    };
    render(
      <WorkflowManager
        workflows={[workflow]}
        runs={[run]}
        projects={[project]}
        skills={[]}
        settings={DEFAULT_SETTINGS}
        onWorkflows={vi.fn()}
        onRun={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(screen.getAllByText("Tests failed")).not.toHaveLength(0);
    expect(screen.getByText("command · failed · 2 attempts")).toBeInTheDocument();
    expect(screen.getByText("1 failing test")).toBeInTheDocument();
    expect(screen.getByText("Command exited with code 1.")).toBeInTheDocument();
  });
});

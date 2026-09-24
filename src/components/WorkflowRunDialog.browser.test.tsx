import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { WorkflowRunDialog } from "./WorkflowRunDialog";
import { DEFAULT_SETTINGS } from "../lib/appConfig";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import type { WorkflowDefinition } from "../lib/workflows";
import "../styles.css";

const projects = [{ id: "a", name: "Project A", path: "/projects/a" }, { id: "b", name: "Project B", path: "/projects/b" }];
const workflow: WorkflowDefinition = {
  id: "recipe", name: "Review branch", description: "", projectId: "a", enabled: true,
  trigger: { type: "manual" }, skillNames: [], run: scheduleRunSnapshot(DEFAULT_SETTINGS), createdAt: 1, updatedAt: 1,
  steps: [{ id: "step", type: "command", name: "Check", command: "git -C ${projectPath} diff ${branch}", continueOnError: false }],
  variables: [{ id: "branch", name: "branch", value: "main", promptOnRun: true }],
};
it("shows the chosen project and previews its command before starting", async () => {
  const run = vi.fn();
  render(<WorkflowRunDialog workflow={workflow} projects={projects} initialProjectId="b" onClose={vi.fn()} onRun={run} />);
  expect(screen.getByRole("button", { name: "Run in project" })).toHaveTextContent("Project B");
  expect(screen.getByText("git -C /projects/b diff main")).toBeVisible();
  expect(run).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Run in project" }).click();
  await page.getByRole("menuitemradio", { name: /Project A/ }).click();
  fireEvent.change(screen.getByRole("textbox", { name: "branch" }), { target: { value: "dev" } });
  expect(screen.getByText("git -C /projects/a diff dev")).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).click();
  expect(run).toHaveBeenCalledWith("recipe", { branch: "dev" }, "a");
});
it("shows saved access before an agent-only recipe can run", async () => {
  const agentOnly: WorkflowDefinition = {
    ...workflow,
    run: { ...workflow.run, permission: "full" },
    steps: [{ id: "agent", type: "agent", name: "Review", prompt: "Review the project", continueOnError: false }],
  };
  render(<WorkflowRunDialog workflow={agentOnly} projects={projects} onClose={vi.fn()} onRun={vi.fn()} />);
  expect(screen.getByText("Access: Full")).toBeVisible();
  expect(screen.queryByText("Shell commands included")).not.toBeInTheDocument();
});
it("keeps long command previews and many inputs inside a short viewport", async () => {
  await page.viewport(700, 520);
  const large: WorkflowDefinition = { ...workflow, steps: [{ ...workflow.steps[0], type: "command", command: "echo " + "long-unbroken-value".repeat(50) }], variables: Array.from({ length: 15 }, (_, i) => ({ id: String(i), name: `input${i}`, value: "", promptOnRun: true })) };
  render(<WorkflowRunDialog workflow={large} projects={projects} onClose={vi.fn()} onRun={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight));
  expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await page.getByRole("button", { name: "Run now" }).click();
  const rect = screen.getByRole("button", { name: "Run now" }).getBoundingClientRect();
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
});

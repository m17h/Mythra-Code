import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalCenter } from "./ApprovalCenter";
import type { PendingApproval } from "../types";
import "../styles.css";

afterEach(async () => { await page.viewport(1400, 900); });

it("keeps the question dialog compact with the shield beside its heading", async () => {
  await page.viewport(1400, 900);
  const approval: PendingApproval = {
    id: 1,
    method: "claude/can_use_tool",
    params: { tool_name: "AskUserQuestion", input: { questions: Array.from({ length: 4 }, (_, index) => ({
      question: `Question ${index + 1}?`,
      options: [{ label: "First option" }, { label: "Second option" }],
    })) } },
    threadId: "thread-1",
    receivedAt: 1,
  };

  render(<div className="app-shell" data-color-scheme="dark"><ApprovalCenter approval={approval} onRespond={vi.fn()} /></div>);
  await screen.findAllByRole("radio", { name: "First option" });
  const dialog = screen.getByRole("alertdialog");
  const heading = screen.getByRole("heading", { name: "The agent needs your input" });
  const shield = dialog.querySelector<HTMLElement>(".approval-shield");
  const bounds = dialog.getBoundingClientRect();
  expect(shield).not.toBeNull();
  expect(bounds.width).toBeGreaterThan(620);
  expect(bounds.width).toBeLessThan(630);
  expect(bounds.height).toBeGreaterThan(560);
  expect(bounds.height).toBeLessThan(580);
  expect(Math.abs((bounds.top + bounds.bottom) / 2 - window.innerHeight / 2)).toBeLessThan(2);
  expect(shield!.getBoundingClientRect().left).toBeGreaterThanOrEqual(heading.getBoundingClientRect().right);
  expect(Math.abs(shield!.getBoundingClientRect().top - heading.getBoundingClientRect().top)).toBeLessThan(12);
});

it.each([[1, 900], [1.25, 900], [1.5, 900], [1.5, 600]])("keeps a long question request scrollable at %sx scale and %spx height", async (scale, height) => {
  await page.viewport(height === 600 ? 980 : 1400, height);
  const onRespond = vi.fn();
  const questions = Array.from({ length: 4 }, (_, index) => ({
    question: `Question ${index + 1}?`,
    options: Array.from({ length: 3 }, (_, option) => ({
      label: `Choice ${index + 1}.${option + 1}`,
      description: "A detailed answer that wraps over several lines in the dialog.",
    })),
  }));
  const approval: PendingApproval = {
    id: 1,
    method: "claude/can_use_tool",
    params: { tool_name: "AskUserQuestion", input: { questions } },
    threadId: "thread-1",
    receivedAt: 1,
  };

  render(<div className="app-shell" data-color-scheme="dark" style={{ zoom: scale }}><ApprovalCenter approval={approval} threadLabel={height === 600 ? "SpaceGame".repeat(20) : undefined} onRespond={onRespond} /></div>);
  const lastAnswer = await screen.findByRole("radio", { name: /Choice 4\.3/ });
  const dialog = screen.getByRole("alertdialog");
  const bounds = dialog.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  expect(dialog.scrollHeight).toBeGreaterThan(dialog.clientHeight);

  for (let index = 1; index <= 3; index++) {
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(`Choice ${index}\\.1`) }));
  }
  await userEvent.wheel(dialog, { delta: { y: 10000 } });
  await waitFor(() => expect(dialog.scrollTop).toBeGreaterThan(0));
  expect(lastAnswer.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top);
  expect(lastAnswer.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
  fireEvent.click(lastAnswer);
  const continueButton = screen.getByRole("button", { name: "Continue" });
  expect(continueButton.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top);
  expect(continueButton.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
  await waitFor(() => expect(continueButton).toBeEnabled());
  fireEvent.click(continueButton);
  await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
  expect(onRespond).toHaveBeenCalledWith({ behavior: "allow", updatedInput: {
    questions,
    answers: { "Question 1?": "Choice 1.1", "Question 2?": "Choice 2.1", "Question 3?": "Choice 3.1", "Question 4?": "Choice 4.3" },
  } });
  dialog.scrollTop = 0;
  dialog.focus();
  await userEvent.keyboard("{PageDown}");
  await waitFor(() => expect(dialog.scrollTop).toBeGreaterThan(0));
});

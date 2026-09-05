import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { ProjectPromptControl } from "./ProjectPromptControl";
import "../styles.css";

const props = { projectName: "Mythra", appPrompt: "", promptMode: "replace" as const, provider: "openai" as const, threadStarted: false, onSave: vi.fn(), onAppPromptSettings: vi.fn() };
afterEach(async () => { await commands.setStreamTestReducedMotion(false); });

it("opens only on click, fades both ways and reverses without a flash", async () => {
  const view = render(<ProjectPromptControl {...props} />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  fireEvent.pointerOver(trigger, { pointerType: "mouse" });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  const panel = view.getByRole("dialog");
  const entrance = panel.getAnimations()[0];
  entrance.pause(); entrance.currentTime = 110;
  expect(Number(getComputedStyle(panel).opacity)).toBeGreaterThan(0);
  expect(Number(getComputedStyle(panel).opacity)).toBeLessThan(1);
  act(() => entrance.finish());
  await waitFor(() => expect(getComputedStyle(panel).opacity).toBe("1"));
  fireEvent.click(view.getByText("Cancel"));
  expect(panel.isConnected).toBe(true);
  expect(panel.inert).toBe(true);
  expect(view.queryByRole("dialog")).toBeNull();
  expect(getComputedStyle(panel).pointerEvents).toBe("none");
  const exit = panel.getAnimations()[0];
  exit.pause(); exit.currentTime = 90;
  const reached = Number(getComputedStyle(panel).opacity);
  expect(reached).toBeGreaterThan(0);
  expect(reached).toBeLessThan(1);
  fireEvent.click(trigger);
  expect(view.getByRole("dialog")).toBe(panel);
  const reversal = panel.getAnimations()[0];
  reversal.pause(); reversal.currentTime = 0;
  expect(Number(getComputedStyle(panel).opacity)).toBeCloseTo(reached, 2);
  act(() => reversal.finish());
  await waitFor(() => expect(getComputedStyle(panel).opacity).toBe("1"));
  fireEvent.keyDown(document.body, { key: "Escape" });
  act(() => panel.getAnimations()[0].finish());
  await waitFor(() => expect(panel.isConnected).toBe(false));
});

it("honors reduced motion and still saves and dismisses on outside click", async () => {
  await commands.setStreamTestReducedMotion(true);
  const onSave = vi.fn();
  const view = render(<ProjectPromptControl {...props} onSave={onSave} />);
  const trigger = view.getByRole("button", { name: /Project instructions:/ });
  fireEvent.click(trigger);
  expect(view.getByRole("dialog").getAnimations()).toHaveLength(0);
  fireEvent.click(view.getByText("Use app prompt"));
  expect(onSave).toHaveBeenCalledWith(undefined, "replace");
  expect(view.container.querySelector(".project-prompt-popover")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(view.container.querySelector(".project-prompt-popover")).toBeNull();
});

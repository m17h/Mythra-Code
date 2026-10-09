import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ChatTimeline } from "./ChatTimeline";
import { emptySkillDependencyReport } from "../lib/skillDependencies";
import type { ChatMessage, SkillDependencyReport } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function report(name: string): SkillDependencyReport {
  return { ...emptySkillDependencyReport(),
    roots: [{ nodeId: name, name, channel: "system" }],
    nodes: [{ id: name, name, kind: "skill", path: `/skills/${name}/SKILL.md`, status: "loaded", characterCount: 40, depth: 0 }],
  };
}

it("shows only the selected run's skills, including system-prompt skills outside its hidden work rows", async () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "Build the interface", turnId: "t1", turnStatus: "completed", timelineOrder: 1, skillDependencies: report("frontend-design") },
    { id: "a1", role: "assistant", text: "Interface done", phase: "final", turnId: "t1", turnStatus: "completed", timelineOrder: 3 },
    { id: "u2", role: "user", text: "Test the app", turnId: "t2", turnStatus: "completed", timelineOrder: 4, skillDependencies: report("webapp-testing") },
    { id: "a2", role: "assistant", text: "Tests done", phase: "final", turnId: "t2", turnStatus: "completed", timelineOrder: 6 },
  ];
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <ChatTimeline messages={messages} activities={[
      { id: "c1", kind: "command", title: "npm run build", status: "completed", turnId: "t1", turnStatus: "completed", timelineOrder: 2 },
      { id: "c2", kind: "command", title: "python test.py", status: "completed", turnId: "t2", turnStatus: "completed", timelineOrder: 5 },
    ]} running={false} thinkingLabel="Thinking" />
  </div>);
  const openers = screen.getAllByRole("button", { name: /View activity/ });
  expect(openers).toHaveLength(2);
  await userEvent.click(openers[0]);
  let dialog = await screen.findByRole("dialog", { name: "Activity" });
  let count = within(dialog).getByRole("button", { name: /1 skill used/i });
  await userEvent.click(count);
  expect(within(dialog).getByText("frontend-design", { exact: true })).toBeVisible();
  expect(within(dialog).queryByText("webapp-testing", { exact: true })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(dialog).toBeVisible();
  await userEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
  await userEvent.click(openers[1]);
  dialog = await screen.findByRole("dialog", { name: "Activity" });
  count = within(dialog).getByRole("button", { name: /1 skill used/i });
  await userEvent.click(count);
  expect(within(dialog).getByText("webapp-testing", { exact: true })).toBeVisible();
  expect(within(dialog).queryByText("frontend-design", { exact: true })).not.toBeInTheDocument();
});

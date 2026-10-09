import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ChatTimeline } from "./ChatTimeline";
import { emptySkillDependencyReport } from "../lib/skillDependencies";
import type { ChatMessage } from "../types";
import "../styles.css";
import "../styles/lumen/index.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

function finalOnlyRun(name = "review", turnId = "skill-turn", firstOrder = 1): ChatMessage[] {
  return [
    { id: `${turnId}-prompt`, role: "user", text: `Use the loaded ${name} skill`, turnId, turnStatus: "completed", timelineOrder: firstOrder,
      skillDependencies: { ...emptySkillDependencyReport(),
        roots: [{ nodeId: name, name, channel: "system" }],
        nodes: [{ id: name, name, kind: "skill", path: `/skills/${name}/SKILL.md`, status: "loaded", characterCount: 40, depth: 0 }],
      } },
    { id: `${turnId}-answer`, role: "assistant", text: `${name}: final answer without intermediate work`, phase: "final", turnId, turnStatus: "completed", timelineOrder: firstOrder + 1 },
  ];
}

function shell(messages: ChatMessage[], running = false) {
  return <div className="app-shell" data-theme="mythra" data-color-scheme="dark">
    <ChatTimeline messages={messages} activities={[]} running={running} activeTurnId={running ? messages[0]?.turnId : undefined} thinkingLabel="Thinking" />
  </div>;
}

it("opens recorded skills for a completed final-only run without inventing tool work", async () => {
  const messages = finalOnlyRun();
  const view = render(shell(messages));
  expect(screen.getByText(messages[1].text)).toBeVisible();
  const opener = screen.getByRole("button", { name: /View activity/ });
  expect(opener).toHaveAccessibleName("Work completed. View activity: 1 skill used");
  const rows = Array.from(view.container.querySelectorAll("[data-entry-kind]"));
  expect(rows.map((row) => row.getAttribute("data-entry-kind"))).toEqual(["message", "work", "message"]);
  await userEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Activity" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: /1 skill used/i })).toBeVisible());
  expect(within(dialog).queryByText("1 command")).not.toBeInTheDocument();
  expect(dialog.querySelector(".activity-details-meta")).toHaveTextContent(/^$/);
  expect(within(dialog).queryByText("0 steps")).not.toBeInTheDocument();
});

it("keeps adjacent final-only skill runs separate and opens each run's own names", async () => {
  render(shell([...finalOnlyRun("review", "first"), ...finalOnlyRun("testing", "second", 3)]));
  const openers = screen.getAllByRole("button", { name: /View activity/ });
  expect(openers).toHaveLength(2);
  for (const [index, name] of ["review", "testing"].entries()) {
    await userEvent.click(openers[index]);
    const dialog = await screen.findByRole("dialog", { name: "Activity" });
    await userEvent.click(within(dialog).getByRole("button", { name: /1 skill used/ }));
    expect(within(dialog).getByText(name, { exact: true })).toBeVisible();
    expect(within(dialog).queryByText(index === 0 ? "testing" : "review", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
  }
});

it("adds no metadata opener when real folded work already provides one, or when no skills are recorded", () => {
  const messages = finalOnlyRun();
  const view = render(<ChatTimeline messages={messages} activities={[
    { id: "command", kind: "command", title: "npm test", status: "completed", turnId: "skill-turn", turnStatus: "completed", timelineOrder: 1.5 },
  ]} running={false} thinkingLabel="Thinking" />);
  expect(screen.getAllByRole("button", { name: /View activity/ })).toHaveLength(1);
  expect(screen.getByRole("button", { name: /View activity/ })).toHaveAccessibleName("Work completed. View activity: 1 command");
  view.rerender(shell(messages.map(({ skillDependencies: _report, ...message }) => message)));
  expect(screen.queryByRole("button", { name: /View activity/ })).not.toBeInTheDocument();
});

it("refreshes a memoized metadata opener when history supplies an additional loaded skill", () => {
  const messages = finalOnlyRun();
  const view = render(shell(messages));
  expect(screen.getByRole("button", { name: /View activity/ })).toHaveAccessibleName("Work completed. View activity: 1 skill used");
  const report = messages[0].skillDependencies!;
  view.rerender(shell([{ ...messages[0], skillDependencies: { ...report,
    roots: [...report.roots, { nodeId: "testing", name: "testing", channel: "user" }],
    nodes: [...report.nodes, { id: "testing", name: "testing", kind: "skill", path: "/skills/testing/SKILL.md", status: "loaded", characterCount: 40, depth: 0 }],
  } }, messages[1]]));
  expect(screen.getByRole("button", { name: /View activity/ })).toHaveAccessibleName("Work completed. View activity: 2 skills used");
});

it.each([
  ["failed", "Run failed"], ["interrupted", "Run stopped"], [undefined, "Activity"],
] as const)("keeps the truthful %s outcome for a metadata-only skill run", (status, label) => {
  const messages = finalOnlyRun().map((message) => ({ ...message, turnStatus: status, ...(status === undefined ? { turnId: undefined } : {}) }));
  render(shell(messages));
  expect(screen.getByRole("button", { name: /View activity/ })).toHaveAccessibleName(`${label}. View activity: 1 skill used`);
});

it("keeps an open final-only run's details through completion and returns focus to its metadata opener", async () => {
  const finished = finalOnlyRun();
  const started = finished.map((message) => ({ ...message, turnStatus: "inProgress" as const,
    ...(message.role === "assistant" ? { streaming: true } : {}) }));
  const view = render(shell(started, true));
  await userEvent.click(screen.getByRole("button", { name: /View activity/ }));
  const dialog = await screen.findByRole("dialog", { name: "Activity" });
  view.rerender(shell(finished));
  await waitFor(() => expect(within(dialog).getByText("Work completed")).toBeVisible());
  expect(screen.getByRole("dialog", { name: "Activity" })).toBe(dialog);
  expect(screen.getAllByRole("button", { name: /View activity/ })).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole("button", { name: "Close activity" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /View activity/ })).toHaveFocus());
});

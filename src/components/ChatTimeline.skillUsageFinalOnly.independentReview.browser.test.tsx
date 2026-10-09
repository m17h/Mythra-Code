import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChatTimeline } from "./ChatTimeline";
import { emptySkillDependencyReport } from "../lib/skillDependencies";
import type { ChatMessage } from "../types";
import "../styles.css";
import "../styles/lumen/index.css";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

it("does not treat a completed user echo as a completed skill-only run before provider output", () => {
  const prompt: ChatMessage = {
    id: "echo", role: "user", text: "Use review", timelineOrder: 1,
    turnId: "active-turn", turnStatus: "completed",
    skillDependencies: { ...emptySkillDependencyReport(),
      roots: [{ nodeId: "review", name: "review", channel: "user" }],
      nodes: [{ id: "review", name: "review", kind: "skill", path: "/skills/review/SKILL.md", status: "loaded", characterCount: 40, depth: 0 }],
    },
  };
  render(<ChatTimeline messages={[prompt]} activities={[]} running={false} activeTurnId="active-turn" thinkingLabel="Thinking" />);
  const opener = screen.getByRole("button", { name: /View activity/ });
  expect(opener).not.toHaveAccessibleName(/Work completed/);
  expect(opener).toHaveAccessibleName(/1 skill used/);
});

it.each([
  { turnStatus: "inProgress" as const },
  { streaming: true },
])("does not reuse older terminal output when newer output is unfinished (%j)", (unfinished) => {
  const messages: ChatMessage[] = [
    { id: "prompt", role: "user", text: "Use review", timelineOrder: 1, turnId: "active-turn",
      skillUsage: [{ source: "codex-skill-input", status: "selected", name: "review", path: "/skills/review/SKILL.md" }] },
    { id: "earlier", role: "assistant", text: "Earlier output", phase: "final", timelineOrder: 2,
      turnId: "active-turn", turnStatus: "completed" },
    { id: "newer", role: "assistant", text: "More output", phase: "final", timelineOrder: 3,
      turnId: "active-turn", ...unfinished },
  ];
  render(<ChatTimeline messages={messages} activities={[]} running={false} thinkingLabel="Thinking" />);
  expect(screen.getByRole("button", { name: /View activity/ })).not.toHaveAccessibleName(/Work completed/);
});

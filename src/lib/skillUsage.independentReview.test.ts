import { beforeEach, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { resetTaskStore, useTaskStore } from "./taskStore";
import { usedSkillsForRun } from "./skillUsage";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import { timelineFromTurns } from "./threadTimeline";

beforeEach(() => { localStorage.clear(); resetTaskStore(); });

it("keeps bare Claude skills separate from a same-named explicitly injected app skill", () => {
  const report = skillDependencyFixture();
  report.nodes = report.nodes.filter((node) => node.id === "review");
  report.edges = [];
  const used = usedSkillsForRun([
    { kind: "message", value: { id: "prompt", role: "user", text: "Use @review", skillDependencies: report } },
    { kind: "activity", value: { id: "home-skill", kind: "command", title: "Skill", status: "completed",
      skillUsage: [{ name: "review", source: "claude-skill-tool", status: "loaded" }] } },
  ]);
  expect(used).toHaveLength(2);
  expect(used.filter((skill) => skill.path)).toHaveLength(1);
});

it("preserves native Codex skill inputs through an optimistic echo and an older hydration snapshot", () => {
  const store = useTaskStore.getState();
  store.ensureTask("thread");
  store.setActiveTurn("thread", "turn");
  store.appendUserMessage("thread", { id: "local-prompt", role: "user", text: "Review this", turnId: "turn" });
  const snapshot = timelineFromTurns([{ id: "turn", items: [{ id: "native-prompt", type: "userMessage", content: [
    { type: "text", text: "Review this" },
    { type: "skill", name: "review", path: "/captured/review/SKILL.md" },
  ] }] }]);
  store.completeMessage("thread", snapshot.messages[0]);
  const oldSnapshot = timelineFromTurns([{ id: "turn", items: [{ id: "native-prompt", type: "userMessage", content: [
    { type: "text", text: "Review this" },
  ] }] }]);
  store.hydrateTask("thread", oldSnapshot.messages, []);
  const messages = useTaskStore.getState().tasks.thread.messages;
  expect(messages).toHaveLength(1);
  expect(messages[0].skillUsage).toEqual([{ name: "review", path: "/captured/review/SKILL.md", source: "codex-skill-input", status: "selected" }]);
});

it("does not promote reference identities to load evidence after discarding a corrupt dependency graph", () => {
  const message: ChatMessage = { id: "user", role: "user", text: "Use @review", turnId: "turn", turnStatus: "completed",
    skillReferences: [{ start: 4, end: 11, name: "review", path: "/skills/review/SKILL.md" }],
    skillDependencies: { version: 999 } as unknown as ChatMessage["skillDependencies"],
  };
  useTaskStore.getState().hydrateTask("thread", [JSON.parse(JSON.stringify(message))], []);
  const entries = useTaskStore.getState().tasks.thread.messages.map((value) => ({ kind: "message" as const, value }));
  expect(usedSkillsForRun(entries)).toEqual([]);
});

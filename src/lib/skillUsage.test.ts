import { describe, expect, it } from "vitest";
import type { Activity, ChatMessage } from "../types";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import type { CompactWorkEntry } from "./compactActivity";
import { estimateSkillUsageBytes, sanitizeSkillUsage, usedSkillsForRun, validSkillUsage } from "./skillUsage";

const message = (value: Partial<ChatMessage> = {}): CompactWorkEntry => ({ kind: "message",
  value: { id: "user", role: "user", text: "Review @review", ...value } });
const activity = (value: Partial<Activity> = {}): Activity => ({ id: "tool", kind: "command", title: "Skill", ...value });

describe("usedSkillsForRun", () => {
  it("counts loaded system/user roots and dependency skills, excluding supporting documents", () => {
    expect(usedSkillsForRun([message({ skillDependencies: skillDependencyFixture() })])).toEqual([
      { identity: "path:/skills/review/SKILL.md", name: "review", path: "/skills/review/SKILL.md" },
      { identity: "path:/skills/tests/SKILL.md", name: "tests", path: "/skills/tests/SKILL.md" },
    ]);
  });

  it("does not count partially read dependencies when resolution blocked the model start", () => {
    const report = skillDependencyFixture(true);
    report.nodes.push({ id: "blocked", name: "blocked", path: "", kind: "skill", status: "blocked", depth: 1, characterCount: 0 });
    expect(usedSkillsForRun([message({ skillDependencies: report,
      skillReferences: [{ start: 7, end: 14, name: "review", path: "/skills/review/SKILL.md" }] })])).toEqual([]);
  });

  it("uses captured references only for historical messages without a dependency report", () => {
    const entry = message({ skillReferences: [{ start: 7, end: 14, name: "review", path: "/old/review.md" }] });
    expect(usedSkillsForRun([entry])).toEqual([{ identity: "path:/old/review.md", name: "review", path: "/old/review.md" }]);
    if (entry.kind !== "message") throw new Error("Expected message");
    entry.value.skillDependencies = { ...skillDependencyFixture(), roots: [], nodes: [], edges: [] };
    expect(usedSkillsForRun([entry])).toEqual([]);
    entry.value.skillDependencies = { version: 999 } as unknown as ChatMessage["skillDependencies"];
    expect(usedSkillsForRun([entry])).toEqual([]);
  });

  it("ignores assistant prose, catalogs, and mismatched captured-reference offsets", () => {
    expect(usedSkillsForRun([
      message({ role: "assistant", text: "I used @review", skillDependencies: skillDependencyFixture() }),
      message({ text: "Use @review", skillReferences: [{ start: 0, end: 7, name: "review", path: "/skills/review/SKILL.md" }] }),
      { kind: "activity", value: activity({ title: "Using Skill: review", detail: "Available skills: review, tests" }) },
    ])).toEqual([]);
  });

  it("deduplicates repeated steering reports, grouped activities, and the known Claude bridge namespace", () => {
    const loaded = activity({ skillUsage: [{ name: "openkiwi-skills:review", source: "claude-skill-tool", status: "loaded" }] });
    expect(usedSkillsForRun([
      { kind: "commands", value: [loaded, loaded] },
      message({ skillDependencies: skillDependencyFixture(), turnId: "turn" }),
      message({ id: "steer", skillDependencies: skillDependencyFixture(), turnId: "turn" }),
    ])).toEqual([
      { identity: "path:/skills/review/SKILL.md", name: "review", path: "/skills/review/SKILL.md" },
      { identity: "path:/skills/tests/SKILL.md", name: "tests", path: "/skills/tests/SKILL.md" },
    ]);
  });

  it("counts successfully loaded native skills but never pending/failed calls, even in completed turns", () => {
    expect(usedSkillsForRun(["pending", "failed", "loaded"].map((status) => ({ kind: "activity", value: activity({
      status: "completed", turnStatus: "completed", skillUsage: [{ name: status, source: "claude-skill-tool", status: status as "loaded" }],
    }) })))).toEqual([{ identity: "name:loaded", name: "loaded" }]);
  });

  it("maps explicit root aliases to the same source for native bridge deduplication", () => {
    const report = skillDependencyFixture();
    report.roots.push({ nodeId: "review", channel: "user", name: "second-alias" });
    expect(usedSkillsForRun([
      message({ skillDependencies: report }),
      { kind: "activity", value: activity({ skillUsage: [{ name: "openkiwi-skills:second-alias", source: "claude-skill-tool", status: "loaded" }] }) },
    ])).toHaveLength(2);
  });

  it("retains same-named distinct paths and third-party namespaces while normalizing Windows paths", () => {
    expect(usedSkillsForRun([
      message({ skillUsage: [
        { name: "review", path: "C:\\Skills\\review\\SKILL.md", source: "codex-skill-input", status: "selected" },
        { name: "review", path: "c:/skills/review/SKILL.md", source: "codex-skill-input", status: "selected" },
        { name: "review", path: "/repo/review/SKILL.md", source: "codex-skill-input", status: "selected" },
      ] }),
      { kind: "activity", value: activity({ skillUsage: [{ name: "third-party:review", source: "claude-skill-tool", status: "loaded" }] }) },
    ]).map((skill) => skill.identity)).toEqual([
      "path:c:/skills/review/skill.md", "path:/repo/review/SKILL.md", "name:third-party:review",
    ]);
  });

  it("does not guess that a bare native Claude skill is the same as a same-named loaded local file", () => {
    expect(usedSkillsForRun([
      message({ skillDependencies: skillDependencyFixture() }),
      { kind: "activity", value: activity({ skillUsage: [
        { name: "review", source: "claude-skill-tool", status: "loaded" },
        { name: "third-party:review", source: "claude-skill-tool", status: "loaded" },
      ] }) },
    ]).map((skill) => skill.identity)).toEqual([
      "path:/skills/review/SKILL.md", "path:/skills/tests/SKILL.md", "name:review", "name:third-party:review",
    ]);
  });

  it("deduplicates Windows UNC paths across slash styles and casing", () => {
    const paths = ["\\\\SERVER\\Share\\Review\\SKILL.md", "//SERVER/Share/Review/SKILL.md"];
    expect(usedSkillsForRun([message({ skillUsage: paths.map((path) => ({ name: "review", path, source: "codex-skill-input", status: "selected" })) })]))
      .toEqual([{ identity: "path://server/share/review/skill.md", name: "review", path: paths[0] }]);
  });

  it("preserves case and literal backslashes in distinct POSIX source paths", () => {
    const paths = ["/Skills/review/SKILL.md", "/skills/review/SKILL.md", "/skills/review\\notes/SKILL.md", "/skills/review/notes/SKILL.md",
      "//Users/Morgan/review/SKILL.md", "//users/morgan/review/SKILL.md"];
    expect(usedSkillsForRun([message({ skillUsage: paths.map((path) => ({ name: "review", path, source: "codex-skill-input", status: "selected" })) })])).toHaveLength(6);
  });

  it("bounds persisted runtime evidence and includes its retained memory cost", () => {
    const valid = [{ name: "review", source: "claude-skill-tool", status: "loaded" }];
    expect(validSkillUsage([...valid,
      { name: "bad\0name", source: "claude-skill-tool", status: "loaded" },
      { name: "review", source: "catalog", status: "loaded" },
      { name: "review", source: "claude-skill-tool", status: "selected" },
      { name: "review", source: "codex-skill-input", status: "selected", path: "https://example.com" },
    ])).toEqual(valid);
    expect(validSkillUsage(Array.from({ length: 65 }, () => valid[0]))).toEqual([]);
    expect(estimateSkillUsageBytes(valid)).toBeGreaterThan(128);
    expect(sanitizeSkillUsage(activity({ skillUsage: [{ name: "", source: "claude-skill-tool", status: "loaded" }] })).skillUsage).toBeUndefined();
  });
});

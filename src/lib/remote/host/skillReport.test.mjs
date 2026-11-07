import test from "node:test";
import assert from "node:assert/strict";
import { hostNeutralSkillReport } from "./engineAdapters.ts";
import { validSkillDependencyReport } from "../../skillDependencies.ts";

const LIMITS = { maxDepth: 4, maxSkills: 8, maxFiles: 24, maxCharacters: 120000, maxFileBytes: 1048576 };
const report = (nodes, issues = []) => ({ version: 1, limits: LIMITS, roots: [{ nodeId: nodes[0].id, channel: "user", name: nodes[0].name }], nodes, edges: [], issues });
const node = (id, path, extra = {}) => ({ id, kind: "skill", name: id, path, status: "loaded", characterCount: 10, depth: 0, ...extra });

test("absolute host paths under the skills folder become /host-skills paths", () => {
  const neutral = hostNeutralSkillReport(report([node("plan", "/Users/zed/skills/plan/SKILL.md"), node("doc", "/Users/zed/skills/plan/notes.md", { kind: "document", depth: 1 })],
    [{ code: "missing-file", message: "Missing /Users/zed/skills/plan/gone.md", chain: ["plan"], sourcePath: "/Users/zed/skills/plan/SKILL.md" }]), "/Users/zed/skills/");
  assert.deepEqual(neutral.nodes.map((entry) => entry.path), ["/host-skills/plan/SKILL.md", "/host-skills/plan/notes.md"]);
  assert.equal(neutral.issues[0].sourcePath, "/host-skills/plan/SKILL.md");
  assert.equal(neutral.issues[0].message, "Missing /host-skills/plan/gone.md");
  assert.ok(!JSON.stringify(neutral).includes("/Users/zed"));
  assert.ok(validSkillDependencyReport(neutral), "the neutral report still validates on the viewer");
});

test("Windows backslash paths are normalized and made relative", () => {
  const neutral = hostNeutralSkillReport(report([node("plan", "C:\\Users\\Zed\\skills\\plan\\SKILL.md")]), "C:\\Users\\Zed\\skills");
  assert.equal(neutral.nodes[0].path, "/host-skills/plan/SKILL.md");
  assert.ok(!JSON.stringify(neutral).includes("Zed"));
});

test("a path outside the skills folder keeps only its file name", () => {
  const neutral = hostNeutralSkillReport(report([node("plan", "/Users/zed/skills/plan/SKILL.md"), node("away", "/etc/private/secret.md", { kind: "document", depth: 1 })]), "/Users/zed/skills");
  assert.equal(neutral.nodes[1].path, "/host-skills/secret.md");
  assert.ok(!JSON.stringify(neutral).includes("/etc/private"));
});

test("blocked nodes without a path keep an empty path", () => {
  const neutral = hostNeutralSkillReport(report([node("plan", "/Users/zed/skills/plan/SKILL.md"), node("gone", "", { status: "blocked", depth: 1 })]), "/Users/zed/skills");
  assert.equal(neutral.nodes[1].path, "");
});

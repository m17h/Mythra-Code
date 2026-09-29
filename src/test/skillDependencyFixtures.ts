import type { SkillDependencyReport } from "../types";

export function skillDependencyFixture(blocked = false): SkillDependencyReport {
  return {
    version: 1,
    limits: { maxDepth: 4, maxSkills: 8, maxFiles: 24, maxCharacters: 120000, maxFileBytes: 1048576 },
    roots: [{ nodeId: "review", channel: "system", name: "review" }],
    nodes: [
      { id: "review", kind: "skill", name: "review", path: "/skills/review/SKILL.md", status: "loaded", characterCount: 41, depth: 0 },
      { id: "tests", kind: "skill", name: "tests", path: "/skills/tests/SKILL.md", status: "loaded", characterCount: 37, depth: 1 },
      { id: "checklist", kind: "document", name: "checklist.md", path: "/skills/references/checklist.md", status: blocked ? "blocked" : "loaded", characterCount: blocked ? 0 : 25, depth: 2 },
    ],
    edges: [{ from: "review", to: "tests", reference: "@tests" }, { from: "tests", to: "checklist", reference: "[Checklist](../references/checklist.md)" }],
    issues: blocked ? [{ code: "missing-file", message: "Reference document was not found.", rootName: "review", chain: ["@review", "@tests", "references/checklist.md"], sourcePath: "/skills/tests/SKILL.md", reference: "[Checklist](../references/checklist.md)" }] : [],
  };
}

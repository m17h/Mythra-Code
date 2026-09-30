import { describe, expect, it } from "vitest";
import type { ChatMessage, SkillDependencyReport } from "../types";
import { estimateSkillDependencyBytes, isSkillDependencyPath, sanitizeMessageSkillDependencies, SKILL_DEPENDENCY_LIMITS, SkillDependencyError, validSkillDependencyReport } from "./skillDependencies";

const report = (): SkillDependencyReport => ({
  version: 1,
  limits: { ...SKILL_DEPENDENCY_LIMITS },
  roots: [{ nodeId: "skill:/skills/review/SKILL.md", channel: "system", name: "review" }],
  nodes: [
    { id: "skill:/skills/review/SKILL.md", kind: "skill", name: "review", path: "/skills/review/SKILL.md", status: "loaded", characterCount: 75, depth: 0, contentHash: "a".repeat(64) },
    { id: "document:/skills/review/references/checklist.md", kind: "document", name: "checklist.md", path: "/skills/review/references/checklist.md", status: "loaded", characterCount: 110, depth: 1, contentHash: "b".repeat(64) },
  ],
  edges: [{ from: "skill:/skills/review/SKILL.md", to: "document:/skills/review/references/checklist.md", reference: "references/checklist.md" }],
  issues: [],
});

describe("persisted skill dependency provenance", () => {
  it("keeps exact graph identity, edge provenance, source hashes, and status without retaining instructions", () => {
    const source = { ...report(), instructions: "private skill contents", nodes: report().nodes.map((node) => ({ ...node, instructions: "do not retain" })) };
    expect(validSkillDependencyReport(source)).toEqual(report());
    expect(JSON.stringify(validSkillDependencyReport(source))).not.toContain("instructions");
    expect(estimateSkillDependencyBytes(source)).toBeGreaterThan(JSON.stringify(report()).length * 2);
  });

  it("allows one source to have both authored channels and shared dependencies", () => {
    const source = report();
    source.roots.push({ ...source.roots[0], channel: "user" });
    source.roots.push({ ...source.roots[0], name: "audit" });
    expect(validSkillDependencyReport(source)).toEqual(source);
  });

  it("keeps blocked discoveries beyond the load budget for an honest diagnostic", () => {
    const source = report();
    source.nodes[1] = { ...source.nodes[1], status: "blocked", depth: 5 };
    source.issues.push({ code: "depth-limit", message: "Maximum depth is 4.", rootName: "review", chain: ["review", "checklist.md"], sourcePath: "/skills/review/SKILL.md", reference: "references/checklist.md" });
    const error = new SkillDependencyError(source);
    expect(validSkillDependencyReport(source)).toEqual(source);
    expect(error.report).toEqual(source);
    expect(error.skillDependencies).toEqual(source);
    expect(error.message).toContain("review → checklist.md: Maximum depth is 4.");
    expect(error.message).toContain("Skills were not loaded and the model was not started.");
  });

  it("retains exact issue-to-node provenance for a blocked nested document", () => {
    const source = report();
    source.nodes[1] = { ...source.nodes[1], status: "blocked", characterCount: 0 };
    source.issues.push({ code: "unsupported-document", message: "This document type cannot be loaded.",
      rootName: "review", chain: ["review", "checklist.md"],
      targetNodeId: source.nodes[1].id, sourceNodeId: source.nodes[0].id });
    expect(validSkillDependencyReport(source)).toEqual(source);
    const damaged = structuredClone(source);
    damaged.issues[0].targetNodeId = "a-missing-node";
    expect(validSkillDependencyReport(damaged)).toBeUndefined();
    const missingSource = structuredClone(source);
    missingSource.issues[0].sourceNodeId = "a-missing-parent";
    expect(validSkillDependencyReport(missingSource)).toBeUndefined();
  });

  it.each([
    null, "corrupt", [], {}, { ...report(), version: 2 },
    { ...report(), limits: { ...SKILL_DEPENDENCY_LIMITS, maxFiles: 999 } },
    { ...report(), roots: [{ ...report().roots[0], nodeId: "unknown" }] },
    { ...report(), roots: [{ ...report().roots[0], nodeId: report().nodes[1].id }] },
    { ...report(), nodes: [report().nodes[0], report().nodes[0]] },
    { ...report(), nodes: [{ ...report().nodes[0], characterCount: -1 }] },
    { ...report(), nodes: [{ ...report().nodes[0], characterCount: Number.MAX_SAFE_INTEGER }] },
    { ...report(), nodes: [{ ...report().nodes[0], path: "https://example.com/skill.md" }] },
    { ...report(), nodes: [{ ...report().nodes[0], path: "/skills/\u0000bad.md" }] },
    { ...report(), nodes: [{ ...report().nodes[0], contentHash: "wrong" }] },
    { ...report(), edges: [{ from: "unknown", to: report().nodes[0].id, reference: "@review" }] },
    { ...report(), issues: [{ code: "missing", message: "Missing", chain: "review" }] },
    { ...report(), issues: [{ code: "missing", message: "Missing", chain: [], sourcePath: "javascript:alert(1)" }] },
    { ...report(), nodes: Array.from({ length: 257 }, (_, index) => ({ ...report().nodes[0], id: String(index) })) },
    { ...report(), edges: Array.from({ length: 1025 }, () => report().edges[0]) },
  ])("discards malformed graph metadata without crashing or retaining file links: %j", (source) => {
    expect(() => validSkillDependencyReport(source)).not.toThrow();
    expect(validSkillDependencyReport(source)).toBeUndefined();
    expect(estimateSkillDependencyBytes(source)).toBe(0);
    const message = { id: "user", role: "user", text: "Do work", skillDependencies: source } as ChatMessage;
    expect(sanitizeMessageSkillDependencies(message)).toEqual({ id: "user", role: "user", text: "Do work" });
  });

  it("bounds total retained metadata as well as each array", () => {
    const source = report();
    source.issues = Array.from({ length: 256 }, () => ({ code: "missing", message: "x".repeat(8192), chain: [] }));
    expect(validSkillDependencyReport(source)).toBeUndefined();
  });

  it("rejects reports that claim loading beyond any native turn budget", () => {
    const excessiveSkills = report();
    excessiveSkills.nodes = Array.from({ length: 9 }, (_, index) => ({ ...report().nodes[0], id: String(index) }));
    excessiveSkills.roots = [];
    excessiveSkills.edges = [];
    const excessiveFiles = report();
    excessiveFiles.nodes = Array.from({ length: 25 }, (_, index) => ({ ...report().nodes[1], id: String(index) }));
    excessiveFiles.roots = [];
    excessiveFiles.edges = [];
    const excessiveCharacters = report();
    excessiveCharacters.nodes[0].characterCount = 120000;
    const excessiveDepth = report();
    excessiveDepth.nodes[1].depth = 5;
    for (const source of [excessiveSkills, excessiveFiles, excessiveCharacters, excessiveDepth]) expect(validSkillDependencyReport(source)).toBeUndefined();
  });

  it("retains an unresolved blocked identity with no openable source path", () => {
    const source = report();
    source.nodes[1] = { ...source.nodes[1], path: "", status: "blocked" };
    expect(validSkillDependencyReport(source)).toEqual(source);
    expect(isSkillDependencyPath(source.nodes[1].path)).toBe(false);
    source.nodes[1].status = "loaded";
    expect(validSkillDependencyReport(source)).toBeUndefined();
  });

  it.each(["/skills/review.md", "C:\\Skills\\review.md", "C:/Skills/review.md", "\\\\pc\\share\\review.md"])("recognizes local paths for safe graph opening: %s", (path) => {
    expect(isSkillDependencyPath(path)).toBe(true);
  });

  it.each(["", "skills/review.md", "https://example.com/review.md", "file:///skills/review.md", "javascript:alert(1)", "/skills/a\nb.md"])("rejects unsafe graph link paths: %s", (path) => {
    expect(isSkillDependencyPath(path)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { SkillDependencyReport } from "../types";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import { buildSkillReferenceMap, describeSkillReferenceMap, type SkillMapItem } from "./skillReferenceMap";

type Report = SkillDependencyReport;
const limits = skillDependencyFixture().limits;
const skill = (id: string, status: "loaded" | "blocked" = "loaded", depth = 0) =>
  ({ id, kind: "skill" as const, name: id, path: status === "blocked" ? "" : `/skills/${id}/SKILL.md`, status, characterCount: status === "loaded" ? 10 : 0, depth });
const doc = (id: string, status: "loaded" | "blocked" = "loaded", depth = 1) =>
  ({ id, kind: "document" as const, name: id, path: `/skills/docs/${id}`, status, characterCount: status === "loaded" ? 5 : 0, depth });
const flat = (item?: SkillMapItem): SkillMapItem[] => item ? [item, ...item.children.flatMap(flat)] : [];
const find = (item: SkillMapItem | undefined, label: string) => flat(item).find((entry) => entry.label === label);

describe("per-reference skill dependency map", () => {
  it("maps the root-to-failure path with the specific nested reason", () => {
    const map = buildSkillReferenceMap("Review", { report: skillDependencyFixture(true) });
    expect(map.state).toBe("blocked");
    expect(map.flagged).toBe(true);
    expect(map.failure).toEqual(["@review", "@tests", "checklist.md"]);
    expect(find(map.root, "@review")).toMatchObject({ status: "held", failurePath: true });
    expect(find(map.root, "checklist.md")).toMatchObject({ status: "blocked", reasonLabel: "Missing file", reason: "Reference document was not found." });
    expect(map.counts).toMatchObject({ held: 2, blocked: 1, skills: 2, documents: 1 });
    expect(describeSkillReferenceMap(map)).toBe("@review: blocked at @review → @tests → checklist.md. Reference document was not found.");
  });

  it("keeps a clean reference out of another reference's failure", () => {
    const report = skillDependencyFixture(true);
    report.roots.push({ nodeId: "release", channel: "system", name: "release" });
    report.nodes.push(skill("release"));
    const release = buildSkillReferenceMap("release", { report });
    expect(release).toMatchObject({ state: "held", flagged: false, blockedElsewhere: ["@review"] });
    expect(release.root).toMatchObject({ label: "@release", status: "held", children: [] });
    expect(buildSkillReferenceMap("release", { report: skillDependencyFixture(false) }).state).toBe("unknown");
  });

  it("shows a shared blocked file under every reference that reaches it", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "user", name: "a" }, { nodeId: "b", channel: "user", name: "b" }],
      nodes: [skill("a"), skill("b"), doc("big.md", "blocked")],
      edges: [{ from: "a", to: "big.md", reference: "big.md" }, { from: "b", to: "big.md", reference: "big.md" }],
      issues: [{ code: "character-limit", message: "Too large.", rootName: "a", chain: ["@a", "big.md"], sourcePath: "/skills/a/SKILL.md", reference: "big.md" }],
    };
    for (const name of ["a", "b"]) {
      const map = buildSkillReferenceMap(name, { report });
      expect(map.flagged).toBe(true);
      expect(find(map.root, "big.md")).toMatchObject({ status: "blocked", reasonLabel: "Over size budget", reason: "Too large." });
    }
  });

  it("stops at a cycle and does not blame the loaded node for its closing reference", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "system", name: "a" }],
      nodes: [skill("a"), skill("b", "loaded", 1)],
      edges: [{ from: "a", to: "b", reference: "@b" }, { from: "b", to: "a", reference: "@a" }],
      issues: [{ code: "cycle", message: "Skill dependency cycle detected.", rootName: "a", chain: ["@a", "@b", "@a"], sourcePath: "/skills/b/SKILL.md", reference: "@a" }],
    };
    const map = buildSkillReferenceMap("a", { report, channel: "system" });
    expect(map.flagged).toBe(true);
    expect(map.root).toMatchObject({ label: "@a", status: "held" });
    const cycle = map.root!.children[0].children[0];
    expect(cycle).toMatchObject({ label: "@a", status: "cycle", reason: "Skill dependency cycle detected.", children: [] });
    expect(map.failure).toEqual(["@a", "@b", "@a"]);
    expect(map.rootIssues).toEqual([]);
  });

  it("keeps unsupported and over-limit objects visible with their reasons", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "user", name: "a" }],
      nodes: [skill("a"), doc("manual.docx", "blocked"), skill("ninth", "blocked", 1), doc("ok.md")],
      edges: [
        { from: "a", to: "ok.md", reference: "ok.md" },
        { from: "a", to: "manual.docx", reference: "manual.docx" },
        { from: "a", to: "ninth", reference: "@ninth" },
      ],
      issues: [
        { code: "unsupported-document", message: "Only text documents load.", rootName: "a", chain: ["@a", "manual.docx"], reference: "manual.docx" },
        { code: "skill-limit", message: "Invoke no more than 8 skills in one model turn.", rootName: "a", chain: ["@a", "@ninth"], reference: "@ninth" },
      ],
    };
    const map = buildSkillReferenceMap("a", { report });
    expect(map.root!.children.map((child) => [child.label, child.status, child.reasonLabel])).toEqual([
      ["ok.md", "held", undefined], ["manual.docx", "blocked", "Unsupported type"], ["@ninth", "blocked", "Over skill limit"],
    ]);
    expect(map.counts.blocked).toBe(2);
  });

  it("marks repeated shared files once and lists later visits as repeats", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "user", name: "a" }],
      nodes: [skill("a"), doc("x.md"), doc("y.md")],
      edges: [{ from: "a", to: "x.md", reference: "x.md" }, { from: "a", to: "y.md", reference: "y.md" }, { from: "y.md", to: "x.md", reference: "x.md" }],
      issues: [],
    };
    const map = buildSkillReferenceMap("a", { report });
    expect(map).toMatchObject({ state: "ready", flagged: false });
    expect(find(map.root, "y.md")!.children[0]).toMatchObject({ status: "repeat", repeatOf: "loads" });
    expect(map.counts).toMatchObject({ loads: 3, documents: 2, characters: 20 });
  });

  it("is honest about missing, stale, failed and incomplete reports", () => {
    expect(buildSkillReferenceMap("a", { report: null, pending: true })).toMatchObject({ state: "checking", flagged: false });
    expect(buildSkillReferenceMap("a", { report: null, error: "offline" })).toMatchObject({ state: "unavailable", flagged: false, error: "offline" });
    const invalid = buildSkillReferenceMap("a", { report: null, invalid: true });
    expect(invalid).toMatchObject({ state: "incomplete", flagged: true });
    expect(invalid.root).toBeUndefined();
    const truncated: Report = { version: 1, limits, roots: [], nodes: [], edges: [], issues: [
      { code: "report-limit", message: "Diagnostics too large.", rootName: "first", chain: ["@first"] },
    ] };
    for (const name of ["first", "second"]) {
      const map = buildSkillReferenceMap(name, { report: truncated });
      expect(map).toMatchObject({ state: "incomplete", flagged: true });
      expect(map.root).toBeUndefined();
    }
  });

  it("blocks every reference for turn-level problems and names root-limit overflow", () => {
    const report = skillDependencyFixture(false);
    report.issues.push({ code: "folder-error", message: "Skills folder is unavailable.", chain: [] });
    expect(buildSkillReferenceMap("review", { report })).toMatchObject({ state: "blocked", flagged: true, turnIssues: [expect.objectContaining({ code: "folder-error" })] });
    const overflow = skillDependencyFixture(false);
    overflow.issues.push({ code: "root-limit", message: "Too many authored skill roots.", rootName: "extra", chain: ["@extra"] });
    expect(buildSkillReferenceMap("extra", { report: overflow })).toMatchObject({ state: "blocked", flagged: true, rootIssues: [expect.objectContaining({ code: "root-limit" })] });
    expect(buildSkillReferenceMap("review", { report: overflow })).toMatchObject({ state: "held", flagged: false });
  });

  it("prefers exact parent-to-target provenance over chain and reference text", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "user", name: "a" }],
      nodes: [skill("a"), doc("x.md", "loaded", 1), doc("y.md", "loaded", 1), doc("gone.md", "blocked", 2)],
      edges: [
        { from: "a", to: "x.md", reference: "x.md" }, { from: "a", to: "y.md", reference: "y.md" },
        { from: "x.md", to: "gone.md", reference: "gone.md" }, { from: "y.md", to: "gone.md", reference: "gone.md" },
      ],
      issues: [
        // Chains deliberately disagree with the graph; provenance is authoritative.
        { code: "missing-file", message: "Missing via x.", rootName: "a", chain: ["@a", "y.md", "gone.md"], reference: "gone.md", targetNodeId: "gone.md", sourceNodeId: "x.md" },
        { code: "read-error", message: "Unreadable via y.", rootName: "a", chain: ["@a", "x.md", "gone.md"], reference: "gone.md", targetNodeId: "gone.md", sourceNodeId: "y.md" },
      ],
    };
    const map = buildSkillReferenceMap("a", { report });
    expect(find(map.root, "x.md")!.children[0]).toMatchObject({ status: "blocked", reason: "Missing via x." });
    // The second edge's own failure stays on its row instead of floating free.
    expect(find(map.root, "y.md")!.children[0]).toMatchObject({ status: "repeat", repeatOf: "blocked", reasonLabel: "Unreadable", reason: "Unreadable via y.", failurePath: true });
    expect(map.rootIssues).toEqual([]);
  });

  it("never moves an identified issue to a different parent of the same target", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "system", name: "a" }, { nodeId: "b", channel: "system", name: "b" }],
      nodes: [skill("a"), skill("b"), doc("big.md", "blocked")],
      edges: [{ from: "a", to: "big.md", reference: "big.md" }, { from: "b", to: "big.md", reference: "big.md" }],
      // Reported only where @a links it; text and chain would also match @b.
      issues: [{ code: "character-limit", message: "Too large via a.", rootName: "a", chain: ["@b", "big.md"], sourcePath: "/skills/b/SKILL.md", reference: "big.md", targetNodeId: "big.md", sourceNodeId: "a" }],
    };
    expect(find(buildSkillReferenceMap("a", { report }).root, "big.md")).toMatchObject({ status: "blocked", reason: "Too large via a." });
    const b = buildSkillReferenceMap("b", { report });
    const shared = find(b.root, "big.md")!;
    // Still blocked by its node status, but without borrowing @a's reason.
    expect(shared).toMatchObject({ status: "blocked", reasonLabel: "Blocked" });
    expect(shared.reason).not.toContain("via a");
    expect(b.rootIssues).toEqual([]);
  });

  it("keeps each repeated authored link on its own edge", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "system", name: "a" }],
      nodes: [skill("a"), doc("x.md", "loaded", 1), doc("gone.md", "blocked", 2)],
      edges: [
        { from: "a", to: "x.md", reference: "x.md" },
        { from: "x.md", to: "gone.md", reference: "[Gone](gone.md)" },
        { from: "x.md", to: "gone.md", reference: "[Gone](gone.md)" },
      ],
      issues: [
        { code: "missing-file", message: "First link.", rootName: "a", chain: ["@a", "x.md", "[Gone](gone.md)"], reference: "[Gone](gone.md)", targetNodeId: "gone.md", sourceNodeId: "x.md" },
        { code: "missing-file", message: "Second link.", rootName: "a", chain: ["@a", "x.md", "[Gone](gone.md)"], reference: "[Gone](gone.md)", targetNodeId: "gone.md", sourceNodeId: "x.md" },
      ],
    };
    const map = buildSkillReferenceMap("a", { report });
    expect(find(map.root, "x.md")!.children.map((child) => [child.status, child.reason])).toEqual([["blocked", "First link."], ["repeat", "Second link."]]);
    expect(map.rootIssues).toEqual([]);
    // One report per edge: a third identical link has nothing left to claim.
    report.edges.push({ from: "x.md", to: "gone.md", reference: "[Gone](gone.md)" });
    const third = find(buildSkillReferenceMap("a", { report }).root, "x.md")!.children[2];
    expect(third).toMatchObject({ status: "repeat", repeatOf: "blocked", failurePath: false });
    expect(third.reason).toBeUndefined();
  });

  it("reports an edge-only failure below a node that otherwise loads", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "system", name: "a" }],
      nodes: [skill("a"), doc("x.md", "loaded", 1), doc("y.md", "loaded", 1)],
      edges: [{ from: "a", to: "x.md", reference: "x.md" }, { from: "a", to: "y.md", reference: "y.md" }, { from: "y.md", to: "x.md", reference: "../x.md" }],
      issues: [{ code: "character-limit", message: "Second inclusion is over budget.", rootName: "a", chain: ["@a", "y.md", "../x.md"], reference: "../x.md", targetNodeId: "x.md", sourceNodeId: "y.md" }],
    };
    const map = buildSkillReferenceMap("a", { report });
    expect(map).toMatchObject({ state: "blocked", flagged: true, failure: ["@a", "y.md", "x.md"] });
    expect(map.firstFailure).toMatchObject({ status: "repeat", reasonLabel: "Over size budget" });
    expect(find(map.root, "x.md")).toMatchObject({ status: "held" });
  });

  it("names each item's folder so same-named files are distinguishable", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "a", channel: "system", name: "a" }],
      nodes: [
        { ...skill("a"), path: "/lib/skills/a/SKILL.md" }, { ...skill("b", "loaded", 1), path: "/lib/skills/team/b/SKILL.md" },
        { ...doc("one"), name: "notes.md", path: "/lib/skills/a/references/notes.md" },
        { ...doc("two"), name: "notes.md", path: "/lib/skills/team/b/notes.md" },
        { ...doc("far", "blocked"), name: "notes.md", path: "/elsewhere/notes.md" },
      ],
      edges: [{ from: "a", to: "one", reference: "references/notes.md" }, { from: "a", to: "b", reference: "@b" },
        { from: "b", to: "two", reference: "notes.md" }, { from: "b", to: "far", reference: "../../../../elsewhere/notes.md" }],
      issues: [],
    };
    const items = flat(buildSkillReferenceMap("a", { report }).root);
    expect(items.map((item) => [item.label, item.location])).toEqual([
      ["@a", "/lib/skills/a"], ["notes.md", "/lib/skills/a/references"],
      ["@b", "/lib/skills/team/b"], ["notes.md", "/lib/skills/team/b"], ["notes.md", "/elsewhere"],
    ]);
    const windows = structuredClone(report);
    for (const node of windows.nodes) node.path = `C:${node.path.replaceAll("/", "\\")}`;
    expect(flat(buildSkillReferenceMap("a", { report: windows }).root)[1].location).toBe("C:\\lib\\skills\\a\\references");
  });

  it("shows a truthful full parent path for a lone deeply nested package", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "review", channel: "user", name: "review" }],
      nodes: [
        { ...skill("review"), path: "/lib/skills/team/deep/review/SKILL.md" },
        { ...doc("notes.md"), path: "/lib/skills/team/deep/review/references/notes.md" },
      ],
      edges: [{ from: "review", to: "notes.md", reference: "references/notes.md" }],
      issues: [],
    };
    expect(flat(buildSkillReferenceMap("review", { report }).root).map((item) => item.location))
      .toEqual(["/lib/skills/team/deep/review", "/lib/skills/team/deep/review/references"]);
    const windows = structuredClone(report);
    for (const node of windows.nodes) node.path = `C:${node.path.replaceAll("/", "\\")}`;
    expect(flat(buildSkillReferenceMap("review", { report: windows }).root).map((item) => item.location))
      .toEqual(["C:\\lib\\skills\\team\\deep\\review", "C:\\lib\\skills\\team\\deep\\review\\references"]);
  });

  it("keeps locations relative to the selected folder with flat and packaged skills", () => {
    const report: Report = {
      version: 1, limits,
      roots: [{ nodeId: "review", channel: "user", name: "review" }],
      nodes: [
        { ...skill("review"), path: "/lib/skills/review.md" },
        { ...skill("tests", "loaded", 1), path: "/lib/skills/team/tests/SKILL.md" },
        { ...doc("notes.md", "loaded", 2), path: "/lib/skills/team/tests/references/notes.md" },
      ],
      edges: [
        { from: "review", to: "tests", reference: "@tests" },
        { from: "tests", to: "notes.md", reference: "references/notes.md" },
      ],
      issues: [],
    };
    expect(flat(buildSkillReferenceMap("review", { report }).root).map((item) => item.location))
      .toEqual([undefined, "team/tests", "team/tests/references"]);
    const windows = structuredClone(report);
    for (const node of windows.nodes) node.path = `C:${node.path.replaceAll("/", "\\")}`;
    expect(flat(buildSkillReferenceMap("review", { report: windows }).root).map((item) => item.location))
      .toEqual([undefined, "team\\tests", "team\\tests\\references"]);
  });

  it("maps a nested reference authored in a skill's own source as the subtree under its edge", () => {
    const report = skillDependencyFixture(true);
    report.roots[0].channel = "user";
    const map = buildSkillReferenceMap("tests", { report });
    expect(map).toMatchObject({ state: "blocked", flagged: true, failure: ["@tests", "checklist.md"] });
    expect(map.root).toMatchObject({ label: "@tests", reference: "@tests" });
    expect(map.firstFailure).toMatchObject({ label: "checklist.md", reason: "Reference document was not found." });
  });

  it("flags an unknown system alias the resolver blocks, but never an alias it did not report", () => {
    const report = skillDependencyFixture(false);
    report.issues.push({ code: "unknown-skill", message: "No enabled skill is named @nope.", rootName: "nope", chain: ["@nope"], reference: "@nope" });
    const unknown = buildSkillReferenceMap("nope", { report, channel: "system" });
    expect(unknown).toMatchObject({ state: "blocked", flagged: true, rootIssues: [expect.objectContaining({ code: "unknown-skill" })] });
    expect(unknown.root).toBeUndefined();
    expect(describeSkillReferenceMap(unknown)).toBe("@nope: blocked. No enabled skill is named @nope.");
    // Ordinary message text: the resolver leaves an unknown alias alone.
    expect(buildSkillReferenceMap("plain", { report: skillDependencyFixture(false), channel: "user" })).toMatchObject({ state: "unknown", flagged: false });
  });

  it("prefers the prompt's own channel when a name is authored in both", () => {
    const report = skillDependencyFixture(true);
    report.roots.push({ nodeId: "tests", channel: "user", name: "review" });
    expect(buildSkillReferenceMap("review", { report, channel: "user" }).root?.label).toBe("@tests");
    expect(buildSkillReferenceMap("review", { report, channel: "system" }).root?.label).toBe("@review");
  });
});

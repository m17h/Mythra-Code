import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { skillDependencyFixture } from "../test/skillDependencyFixtures";
import { blockedSkillNames, SkillDependencyDetails } from "./SkillDependencyDetails";
import { SkillDependencyNotice } from "./SkillDependencyNotice";
import { SkillPromptEditor } from "./SkillPromptEditor";
import { validSkillDependencyReport } from "../lib/skillDependencies";

describe("skill dependency diagnostics", () => {
  it("explains unsupported documents without implying that their contents were loaded", () => {
    const report = skillDependencyFixture(true);
    report.nodes[2] = { ...report.nodes[2], name: "manual.pdf", path: "/skills/references/manual.pdf" };
    report.edges[1].reference = "[Manual](../references/manual.pdf)";
    report.issues = [{ code: "unsupported-document", message: "This local document format is not supported.", rootName: "review", chain: ["@review", "@tests", "references/manual.pdf"], reference: report.edges[1].reference }];
    const view = render(<><SkillDependencyNotice report={report} /><SkillDependencyDetails report={report} /></>);
    expect(screen.getByText(/Only UTF-8/)).toHaveTextContent(".md, .markdown, and .txt");
    expect(screen.getByText(/Only UTF-8/)).toHaveTextContent("PDF or Word extraction is not available");
    expect(screen.getByText("@review → @tests → references/manual.pdf", { selector: ".skill-dependency-issue small" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Skill context · 2 skills · 1 document · blocked"));
    expect(view.container.querySelector(".skill-dependency-nodes > li:last-child")).toHaveTextContent("Blocked · 0 characters");
    expect(view.container.querySelector(".skill-dependency-edges > li:last-child.is-blocked")).toHaveTextContent("[Manual](../references/manual.pdf)");
  });
  it.each([true, false])("marks a rootless report-limit diagnostic's named root red (rootName present: %s)", (named) => {
    const report = { ...skillDependencyFixture(), roots: [], nodes: [], edges: [], issues: [{ code: "report-limit", message: "The dependency report exceeded its metadata limit.", ...(named ? { rootName: "review" } : {}), chain: ["@review", "references/checklist.md"] }] };
    expect(validSkillDependencyReport(report)).toBeDefined();
    expect([...blockedSkillNames(report)]).toEqual(["review"]);
    const view = render(<SkillPromptEditor value="Use @review" skills={[{ name: "review" }]} dependencyReport={report} />);
    expect(view.container.querySelector(".skill-prompt-token.is-blocked")).toHaveTextContent("@review");
    expect(screen.getByText("The dependency report exceeded its metadata limit.")).toBeInTheDocument();
  });

  it("marks every reported root blocked for a graph-wide issue without a named chain", () => {
    const report = skillDependencyFixture();
    report.roots.push({ nodeId: "tests", channel: "user", name: "tests" });
    report.issues = [{ code: "report-limit", message: "The graph exceeded its metadata limit.", chain: [] }];
    expect([...blockedSkillNames(report)]).toEqual(["review", "tests"]);
  });
  it("announces only three reasons and the remaining count while keeping every visual error", () => {
    const report = skillDependencyFixture(true);
    report.issues = Array.from({ length: 128 }, (_, index) => ({ code: "missing-file", message: `Missing reference ${index + 1}.`, chain: ["@review", `missing-${index + 1}.md`], rootName: "review" }));
    const view = render(<SkillDependencyNotice report={report} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Missing reference 1.");
    expect(alert).toHaveTextContent("Missing reference 3.");
    expect(alert).not.toHaveTextContent("Missing reference 4.");
    expect(alert).toHaveTextContent("125 more errors; inspect the dependency notice");
    expect(alert.textContent!.length).toBeLessThan(400);
    expect(view.container.querySelectorAll(".skill-dependency-issue")).toHaveLength(128);
    view.rerender(<SkillDependencyNotice report={{ ...report, issues: report.issues.map((issue) => ({ ...issue, message: `${issue.message}${" Long reference detail.".repeat(200)}` })) }} />);
    expect(screen.getByRole("alert").textContent!.length).toBeLessThan(750);
    expect(screen.getByRole("alert")).toHaveTextContent("125 more errors; inspect the dependency notice");
    expect(view.container.querySelectorAll(".skill-dependency-issue")).toHaveLength(128);
  });
  it("discards corrupt graph metadata before creating links or file rows", () => {
    const report = { ...skillDependencyFixture(), nodes: "corrupt" };
    const view = render(<SkillDependencyDetails report={report as unknown as ReturnType<typeof skillDependencyFixture>} skills={[{ name: "review", path: "/skills/review/SKILL.md" }]} onOpenSkill={vi.fn()} />);
    expect(view.container.querySelector("details")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("propagates blocked documents to every ancestor skill and shows the full failing chain", () => {
    const report = skillDependencyFixture(true);
    expect([...blockedSkillNames(report)]).toEqual(["review", "tests"]);
    render(<SkillDependencyNotice report={report} />);
    expect(screen.getByText("Turn blocked by skill dependencies")).toBeInTheDocument();
    expect(screen.getByText("@review → @tests → references/checklist.md")).toBeInTheDocument();
    expect(screen.getByText("[Checklist](../references/checklist.md)")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Reference document was not found.");
  });

  it("links only exact current skill paths and leaves documents read-only", () => {
    const onOpenSkill = vi.fn();
    const report = skillDependencyFixture();
    render(<SkillDependencyDetails report={report} skills={[{ name: "renamed", path: report.nodes[0].path }, { name: "tests", path: "/replacement/tests/SKILL.md" }]} onOpenSkill={onOpenSkill} />);
    const summary = screen.getByText("Skill context · 2 skills · 1 document");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("link", { name: "@review" }));
    expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith(report.nodes[0].path);
    expect(screen.queryByRole("link", { name: "@tests" })).toBeNull();
    expect(screen.queryByRole("link", { name: "checklist.md" })).toBeNull();
    expect(screen.getByText("System: @review")).toBeInTheDocument();
    expect(screen.getByText("/skills/references/checklist.md")).toBeInTheDocument();
  });

  it("does not change alert content for a repeated equivalent preview", () => {
    const report = skillDependencyFixture(true);
    const view = render(<SkillDependencyNotice report={report} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Turn blocked by skill dependencies");
    view.rerender(<SkillDependencyNotice report={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<SkillDependencyNotice report={skillDependencyFixture(true)} />);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<SkillDependencyNotice report={skillDependencyFixture()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Skill dependencies ready.");
  });
});

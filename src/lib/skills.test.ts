import { describe, expect, it } from "vitest";
import { normalizeSkillName, resolveLocalSkills, type LocalSkillFile } from "./skills";

const file = (path: string, defaultName: string): LocalSkillFile => ({
  path,
  relativePath: path.split("/").at(-1) || path,
  fileName: path.split("/").at(-1) || path,
  defaultName,
  description: "A local workflow",
  supportingMarkdownCount: 0,
});

describe("local skills", () => {
  it("turns existing Markdown filenames into valid invocation names", () => {
    expect(normalizeSkillName(" Careful Code Review.md ")).toBe("careful-code-review-md");
    expect(normalizeSkillName("Release & Ship")).toBe("release-ship");
  });

  it("keeps app-only aliases and resolves duplicate filenames deterministically", () => {
    const skills = resolveLocalSkills(
      [file("/skills/review.md", "review"), file("/skills/team/SKILL.md", "review")],
      { "/skills/review.md": "security review" },
      ["/skills/team/SKILL.md"],
    );
    expect(skills.map((skill) => skill.name)).toEqual(["security-review", "review"]);
    expect(skills.map((skill) => skill.enabled)).toEqual([true, false]);
  });

  it("suffixes duplicate invocation names without modifying source paths", () => {
    const skills = resolveLocalSkills(
      [file("/skills/a.md", "deploy"), file("/skills/b.md", "deploy")],
      {},
      [],
    );
    expect(skills.map((skill) => skill.name)).toEqual(["deploy", "deploy-2"]);
    expect(skills.map((skill) => skill.path)).toEqual(["/skills/a.md", "/skills/b.md"]);
  });

  it("omits app-only removals while leaving their source files untouched", () => {
    const skills = resolveLocalSkills(
      [file("/skills/review.md", "review"), file("/skills/release.md", "release")],
      {},
      [],
      ["/skills/review.md"],
    );
    expect(skills.map((skill) => skill.path)).toEqual(["/skills/release.md"]);
  });
});

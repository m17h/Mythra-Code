import { describe, expect, it } from "vitest";
import { captureSkillReferences, validSkillReferences } from "./skillReferences";
import type { LocalSkill } from "./skills";

const skill: LocalSkill = { name: "review", defaultName: "review", path: "/skills/review.md", relativePath: "review.md", fileName: "review.md", enabled: true, description: "", supportingMarkdownCount: 0 };

describe("skill reference snapshots", () => {
  it("captures UTF-16 source offsets only for recognized enabled exact mentions", () => {
    expect(captureSkillReferences("📚 @review, @unknown x@review.test", [skill])).toEqual([{ start: 3, end: 10, name: "review", path: skill.path }]);
    expect(captureSkillReferences("Use @review", [{ ...skill, enabled: false }])).toEqual([]);
  });
  it("rejects stale, overlapping, and malformed persisted ranges", () => {
    const exact = { start: 4, end: 11, name: "review", path: skill.path };
    expect(validSkillReferences("Use @review", [exact, { ...exact, start: 5 }, { ...exact, end: 900 }, { ...exact, name: "other" }])).toEqual([exact]);
    expect(validSkillReferences("Changed text", [exact])).toEqual([]);
  });
  it.each([null, false, 5, "[]", {}, { start: 4, end: 11 }, [null], [false], ["reference"]])("rejects corrupt top-level metadata and entries: %j", (references) => {
    expect(validSkillReferences("Use @review", references)).toEqual([]);
  });
  it("validates primitive fields and UTF-16 boundaries before accepting a captured range", () => {
    const exact = { start: 3, end: 10, name: "review", path: skill.path };
    const invalid = [
      { ...exact, start: "3" }, { ...exact, end: null }, { ...exact, start: NaN },
      { ...exact, start: 2 }, { ...exact, end: 9 }, { ...exact, start: -1 }, { ...exact, end: 3.5 },
      { ...exact, name: null }, { ...exact, name: "review_" }, { ...exact, name: "" },
      { ...exact, path: null }, { ...exact, path: " \t" }, { ...exact, path: "/skills/\0review.md" },
    ];
    expect(validSkillReferences("📚 @review", invalid)).toEqual([]);
    expect(validSkillReferences("📚 @review", [exact])).toEqual([exact]);
    expect(validSkillReferences("x@review.test", [{ ...exact, start: 1, end: 8 }])).toEqual([]);
    expect(validSkillReferences("@review/file", [{ ...exact, start: 0, end: 7 }])).toEqual([]);
  });
});

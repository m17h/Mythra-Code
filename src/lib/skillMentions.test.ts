import { describe, expect, it } from "vitest";
import { skillMentionQuery, skillMentionRanges, skillMentionSuggestions } from "./skillMentions";

const skill = { name: "review", path: "/selected/review.md" };
const names = (text: string) => skillMentionRanges(text, [skill]).map((range) => text.slice(range.start, range.end));

describe("exact selected-folder skill mentions", () => {
  it("returns all recognized mentions with original casing and UTF-16 positions", () => {
    const text = "🙂 use @REVIEW, then\n@review. ";
    const ranges = skillMentionRanges(text, [skill]);
    expect(ranges).toEqual([{ start: 7, end: 14, skill }, { start: 21, end: 28, skill }]);
    expect(names(text)).toEqual(["@REVIEW", "@review"]);
  });

  it.each(["@review", "@review.", "@review. next", "@review,", "@review;", "@review:", "@review!", "@review?", "@review)", "@review]", "@review}", "@review🙂", "\u0085@review", "\u2003@review"])("recognizes runtime boundary %s", (text) => {
    expect(names(text)).toEqual(["@review"]);
  });

  it.each(["mail@review", "(@review)", "/@review", "@review.md", "@review.more", "@review/path", "@review\\path", "@review_extra", "@review-longer", "@reviewé", "@review٣", "@review𝟙", "\ufeff@review", "@-review"])("rejects non-invocation %s", (text) => {
    expect(names(text)).toEqual([]);
  });

  it("rejects disabled, missing, and overlong configured names", () => {
    expect(skillMentionRanges("@review @unknown", [{ ...skill, enabled: false }])).toEqual([]);
    const long = "a".repeat(65);
    expect(skillMentionRanges(`@${long}`, [{ name: long }])).toEqual([]);
    expect(skillMentionRanges(`@${"a".repeat(64)}`, [{ name: "a".repeat(64) }])).toHaveLength(1);
  });

  it("finds only partial skill names at a word-start caret", () => {
    expect(skillMentionQuery("Use @rev later", 8)).toEqual({ start: 4, end: 8, query: "rev" });
    expect(skillMentionQuery("Use @", 5)).toEqual({ start: 4, end: 5, query: "" });
    for (const text of ["mail@rev", "@review/path", "@review.md", "@-review", `@${"a".repeat(65)}`]) {
      expect(skillMentionQuery(text, text.length)).toBeNull();
    }
  });

  it("suggests enabled local skills by name and description with prefix matches first", () => {
    expect(skillMentionSuggestions([
      { name: "z-review" }, { name: "review" }, { name: "helper", description: "Review helper" },
      { name: "review-disabled", enabled: false }, { name: "invalid_name" },
    ], "rev").map((candidate) => candidate.name)).toEqual(["review", "helper", "z-review"]);
  });
});

import { describe, expect, it } from "vitest";
import { parseDiffSections, unquoteGitPath } from "./gitDiff";

const simple = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
].join("\n");

describe("parseDiffSections", () => {
  it("splits files and counts changed lines without counting markers", () => {
    const [section] = parseDiffSections(simple);
    expect(section.path).toBe("src/app.ts");
    expect(section.displayPath).toBe("src/app.ts");
    expect(section.additions).toBe(1);
    expect(section.deletions).toBe(1);
    expect(section.text.startsWith("diff --git ")).toBe(true);
  });

  it("recovers a path containing spaces from the marker lines", () => {
    // The header alone is ambiguous here: `a/my file b/my file` can be split
    // in more than one place, so the unambiguous `+++ b/…` line decides.
    const [section] = parseDiffSections([
      "diff --git a/my file b/my file",
      "--- a/my file",
      "+++ b/my file",
      "@@ -0,0 +1 @@",
      "+one",
    ].join("\n"));
    expect(section.path).toBe("my file");
    expect(section.additions).toBe(1);
  });

  it("decodes a quoted non-ASCII path", () => {
    const [section] = parseDiffSections([
      'diff --git "a/caf\\303\\251/men\\303\\274.md" "b/caf\\303\\251/men\\303\\274.md"',
      '--- "a/caf\\303\\251/men\\303\\274.md"',
      '+++ "b/caf\\303\\251/men\\303\\274.md"',
      "@@ -0,0 +1 @@",
      "+one",
    ].join("\n"));
    expect(section.path).toBe("café/menü.md");
  });

  it("decodes a quoted path containing a quote character", () => {
    const [section] = parseDiffSections([
      'diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"',
      '--- "a/say \\"hi\\".txt"',
      '+++ "b/say \\"hi\\".txt"',
      "@@ -0,0 +1 @@",
      "+one",
    ].join("\n"));
    expect(section.path).toBe('say "hi".txt');
  });

  it("uses the surviving side for added and deleted files", () => {
    const added = parseDiffSections([
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+one",
    ].join("\n"));
    expect(added[0].path).toBe("new.txt");

    const removed = parseDiffSections([
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-one",
    ].join("\n"));
    expect(removed[0].path).toBe("gone.txt");
    expect(removed[0].deletions).toBe(1);
  });

  it("falls back to an unambiguous header when there are no marker lines", () => {
    const [section] = parseDiffSections([
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n"));
    expect(section.path).toBe("script.sh");
  });

  it("uses the rename target for a hunk-less rename", () => {
    // The header `a/old name b/new name` has no split where both sides agree,
    // so only the explicit `rename to` line can name the file.
    const [section] = parseDiffSections([
      "diff --git a/old name b/new name",
      "similarity index 100%",
      "rename from old name",
      "rename to new name",
    ].join("\n"));
    expect(section.path).toBe("new name");
  });

  it("withholds a path for a malformed quoted header instead of guessing", () => {
    const [section] = parseDiffSections([
      'diff --git "a/broken\\q" "b/broken\\q"',
      "old mode 100644",
      "new mode 100755",
    ].join("\n"));
    expect(section.path).toBeNull();
    expect(section.displayPath).toBe('"a/broken\\q" "b/broken\\q"');
  });

  it("withholds a path when a quoted marker line cannot be decoded", () => {
    const [section] = parseDiffSections([
      'diff --git "a/broken\\q" "b/broken\\q"',
      '--- "a/broken\\q"',
      '+++ "b/broken\\q"',
      "@@ -0,0 +1 @@",
      "+one",
    ].join("\n"));
    expect(section.path).toBeNull();
    expect(section.additions).toBe(1);
  });

  it("handles several files in one diff", () => {
    const sections = parseDiffSections(`${simple}\n${simple.replace(/app\.ts/g, "other.ts")}`);
    expect(sections.map((section) => section.path)).toEqual(["src/app.ts", "src/other.ts"]);
  });

  it("returns nothing for empty text", () => {
    expect(parseDiffSections("")).toEqual([]);
  });
});

describe("unquoteGitPath", () => {
  it("decodes octal byte sequences and named escapes", () => {
    expect(unquoteGitPath("caf\\303\\251")).toBe("café");
    expect(unquoteGitPath("tab\\there")).toBe("tab\there");
    expect(unquoteGitPath("back\\\\slash")).toBe("back\\slash");
  });

  it("rejects malformed input instead of guessing", () => {
    expect(unquoteGitPath("trailing\\")).toBeNull();
    expect(unquoteGitPath("bad\\q")).toBeNull();
    expect(unquoteGitPath("short\\77")).toBeNull();
    // Lone continuation byte: not decodable UTF-8.
    expect(unquoteGitPath("\\200")).toBeNull();
  });
});

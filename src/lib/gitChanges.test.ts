import { describe, expect, it } from "vitest";
import { commitPlan, discardBlockedReason, groupChanges, partiallyStagedPaths, readTime, relativeAge, splitChangePath } from "./gitChanges";
import type { GitChange, ProjectGitChanges } from "./gitInspection";

const row = (path: string, area: GitChange["area"], status: string, originalPath: string | null = null): GitChange => ({ path, area, status, originalPath });

function changes(rows: GitChange[], truncated = false): ProjectGitChanges {
  return {
    rootPath: "/project",
    rows,
    stagedFiles: rows.filter((item) => item.area === "staged").length,
    unstagedFiles: rows.filter((item) => item.area === "unstaged").length,
    untrackedFiles: rows.filter((item) => item.area === "untracked").length,
    changedFiles: new Set(rows.map((item) => item.path)).size,
    truncated,
  };
}

describe("Git changes helpers", () => {
  it("keeps a partly staged file in both groups and names it", () => {
    const rows = [row("src/a.ts", "staged", "M"), row("src/a.ts", "unstaged", "M"), row("b.ts", "unstaged", "D"), row("new.md", "untracked", "?")];
    const groups = groupChanges(rows);
    expect(groups.staged.map((item) => item.path)).toEqual(["src/a.ts"]);
    expect(groups.unstaged.map((item) => item.path)).toEqual(["src/a.ts", "b.ts"]);
    expect(groups.untracked.map((item) => item.path)).toEqual(["new.md"]);
    expect([...partiallyStagedPaths(rows)]).toEqual(["src/a.ts"]);
  });

  it("says exactly what each commit includes, including held-back edits", () => {
    const plan = commitPlan(changes([
      row("src/a.ts", "staged", "M"), row("src/a.ts", "unstaged", "M"),
      row("new name.ts", "staged", "R", "old name.ts"), row("b.ts", "unstaged", "M"), row("c.md", "untracked", "?"),
    ]), null);
    expect(plan).toMatchObject({ staged: 2, heldBack: 1, all: 4, unstaged: 2, untracked: 1, exact: true });
    expect(plan.stagedPaths).toEqual(["src/a.ts", "new name.ts"]);
    expect(plan.allPaths).toEqual(["src/a.ts", "new name.ts", "b.ts", "c.md"]);
  });

  it("falls back to snapshot counts without claiming an exact list", () => {
    const plan = commitPlan(null, { branch: "main", headOid: null, branches: [], stagedFiles: 1, unstagedFiles: 2, changedFiles: 3, stagedPaths: ["x"], rootPath: "/p" });
    expect(plan).toMatchObject({ staged: 1, all: 3, exact: false, stagedPaths: ["x"], allPaths: [] });
    expect(commitPlan(changes([row("a", "staged", "M")], true), null).exact).toBe(false);
  });

  it("never offers discard where restoring would delete a file", () => {
    const rows = [row("new.md", "untracked", "?"), row("added.ts", "staged", "A"), row("added.ts", "unstaged", "M"), row("both.ts", "unstaged", "U"), row("to.ts", "staged", "R", "from.ts"), row("edit.ts", "unstaged", "M")];
    expect(discardBlockedReason(rows[0], rows)).toMatch(/never deleted/);
    expect(discardBlockedReason(rows[1], rows)).toMatch(/no committed version/);
    expect(discardBlockedReason(rows[2], rows)).toMatch(/no committed version/);
    expect(discardBlockedReason(rows[3], rows)).toMatch(/conflict/);
    // A rename has a committed source, which the native revert restores as a pair.
    expect(discardBlockedReason(rows[4], rows)).toBeNull();
    expect(discardBlockedReason(rows[5], rows)).toBeNull();
  });

  it("splits exact paths without reordering punctuation", () => {
    expect(splitChangePath(".github/workflows/ci.yml")).toEqual({ name: "ci.yml", directory: ".github/workflows" });
    expect(splitChangePath("README")).toEqual({ name: "README", directory: "" });
  });

  it("describes ages relative to now and ignores unreadable times", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(relativeAge(now - 10_000, now)).toBe("just now");
    expect(relativeAge(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(relativeAge("2026-09-28T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeAge("not a date", now)).toBeNull();
    expect(relativeAge(undefined, now)).toBeNull();
  });

  it("anchors read freshness to a date and time instead of an idle relative label", () => {
    const at = Date.parse("2026-09-28T12:00:00Z");
    expect(readTime(at)).toBe(`at ${new Date(at).toLocaleString()}`);
    expect(readTime(at)).not.toMatch(/just now|ago/);
    expect(readTime(0)).toBe(`at ${new Date(0).toLocaleString()}`);
    expect(readTime(undefined)).toBeNull();
    expect(readTime(Number.NaN)).toBeNull();
    expect(readTime(1e50)).toBeNull();
  });
});

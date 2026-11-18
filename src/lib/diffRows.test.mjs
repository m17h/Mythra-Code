import test from "node:test";
import assert from "node:assert/strict";
import { gutterDigits, highlightDiff, numberDiffLines } from "./diffRows.ts";

test("hunk headers set the old and new line numbers", () => {
  const rows = numberDiffLines([
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,3 +10,4 @@ function x() {",
    " keep",
    "-old",
    "+new",
    "+more",
    "\\ No newline at end of file",
  ]);
  assert.deepEqual(rows.map((row) => row.kind), ["header", "header", "header", "hunk", "context", "del", "add", "add", "note"]);
  assert.deepEqual(rows[4], { kind: "context", oldLine: 10, newLine: 10 });
  assert.deepEqual(rows[5], { kind: "del", oldLine: 11 });
  assert.deepEqual(rows[6], { kind: "add", newLine: 11 });
  assert.deepEqual(rows[7], { kind: "add", newLine: 12 });
  assert.equal(gutterDigits(rows), 2);
});

test("a synthetic new-file hunk numbers the new side from 1", () => {
  const rows = numberDiffLines(["@@ new file · 2 lines @@", "+a", "+b"]);
  assert.deepEqual(rows.slice(1), [{ kind: "add", newLine: 1 }, { kind: "add", newLine: 2 }]);
});

test("a second file's header resets the hunk state", () => {
  const rows = numberDiffLines(["@@ -1 +1 @@", " a", "diff --git a/b.py b/b.py", "index 1..2", "@@ -5 +5 @@", "+x"]);
  assert.equal(rows[3].kind, "header");
  assert.deepEqual(rows[5], { kind: "add", newLine: 5 });
  assert.equal(gutterDigits(numberDiffLines(["@@ -1200 +1200 @@", " a"])), 4);
});

test("highlighting follows each file's language in a multi-file diff", () => {
  const lines = [
    "diff --git a/a.ts b/a.ts",
    "@@ -1 +1 @@",
    "+const a = 1;",
    "diff --git a/b.py b/b.py",
    "@@ -1 +1 @@",
    "+def b(): pass",
  ];
  const tokens = highlightDiff(lines);
  assert.equal(tokens[0], null);
  assert.ok(tokens[2].some((token) => token.kind === "keyword" && token.text === "const"));
  assert.ok(tokens[5].some((token) => token.kind === "keyword" && token.text === "def"));
});

test("a single file's diff uses the path it was given", () => {
  const tokens = highlightDiff(["@@ -1 +1 @@", "-x = 1", "+fn main() {}"], "src/main.rs");
  assert.ok(tokens[2].some((token) => token.kind === "keyword" && token.text === "fn"));
});

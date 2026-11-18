import test from "node:test";
import assert from "node:assert/strict";
import { diffReadState, projectRelativePath } from "./changesScope.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

test("a complete read is ok and keeps its text", () => {
  assert.deepEqual(diffReadState({ text: DIFF }), { kind: "ok", text: DIFF });
  assert.deepEqual(diffReadState({ text: "" }), { kind: "ok", text: "" });
});

test("a failed read is an error, never an empty diff", () => {
  const state = diffReadState({ text: "Could not inspect repository changes: boom", error: "boom" });
  assert.equal(state.kind, "error");
  assert.equal(state.text, "");
  assert.equal(state.error, "boom");
});

test("a capped read is partial, flagged or only marked in the text", () => {
  assert.equal(diffReadState({ text: DIFF, truncated: true }).kind, "partial");
  const marked = `${DIFF}\n\n[Diff preview truncated at 512 KiB. Select a file in Changes to inspect it.]\n`;
  const state = diffReadState({ text: marked });
  assert.equal(state.kind, "partial");
  assert.equal(state.text, DIFF);
  assert.ok(!state.text.includes("truncated"));
});

test("provider paths become repository-relative", () => {
  assert.equal(projectRelativePath("/repo/src/a.ts", ["/repo"]), "src/a.ts");
  assert.equal(projectRelativePath("./src/a.ts", [null]), "src/a.ts");
});

import { diffEmptyCopy, partialCommitNote, stagedDiffSections, STAGED_DIFF_FILE_LIMIT } from "./changesScope.ts";
import { parseDiffSections } from "./gitDiff.ts";

const staged = (path, body = "@@ -1 +1 @@\n-a\n+b\n") => ({
  path,
  text: `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`,
  binary: false,
  truncated: false,
});

test("staged view: one section per staged file, path taken from the row", () => {
  // A quoted header can't be decoded unambiguously; the row's exact path still wins.
  const odd = { path: "src/café menu.ts", text: 'diff --git "a/src/caf\\303\\251 menu.ts" "b/src/caf\\303\\251 menu.ts"\n--- "a/src/caf\\303\\251 menu.ts"\n+++ "b/src/caf\\303\\251 menu.ts"\n@@ -1 +1,2 @@\n x\n+y\n', binary: false, truncated: false };
  const result = stagedDiffSections([staged("src/a.ts"), odd], 2, parseDiffSections);
  assert.equal(result.partial, false);
  assert.deepEqual(result.sections.map((section) => section.path), ["src/a.ts", "src/café menu.ts"]);
  assert.deepEqual(result.sections.map((section) => [section.additions, section.deletions]), [[1, 1], [1, 0]]);
});

test("staged view: a staged edit undone on disk still shows (the cancellation case)", () => {
  // Net diff (worktree vs HEAD) is empty, but the index holds the edit Commit records.
  const result = stagedDiffSections([staged("src/cart/OrderTotal.tsx")], 1, parseDiffSections);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].additions, 1);
});

test("staged view: capped, failed and over-limit reads are partial and never dropped silently", () => {
  assert.equal(stagedDiffSections([staged("a")], STAGED_DIFF_FILE_LIMIT + 5, parseDiffSections).partial, true);
  const capped = { ...staged("a"), text: `${staged("a").text}\n\n[File preview truncated at 512 KiB.]\n` };
  const cappedResult = stagedDiffSections([capped], 1, parseDiffSections);
  assert.equal(cappedResult.partial, true);
  assert.ok(!cappedResult.sections[0].text.includes("truncated"));
  const failed = stagedDiffSections([staged("a"), { path: "b", error: "boom" }], 2, parseDiffSections);
  assert.equal(failed.partial, true);
  assert.deepEqual(failed.failed, ["b"]);
  const binary = stagedDiffSections([{ path: "logo.png", text: "Binary file: text preview unavailable.\n", binary: true, truncated: false }], 1, parseDiffSections);
  assert.equal(binary.sections[0].path, "logo.png");
});

test("empty diff copy: never 'No differences' while something is staged or listed", () => {
  const net = diffEmptyCopy({ scope: "working", stagedView: false, staged: 1, changed: 1 });
  assert.equal(net.title, "No net change");
  assert.equal(net.action, "staged");
  assert.match(net.text, /1 file staged/);
  assert.equal(diffEmptyCopy({ scope: "working", stagedView: false, staged: 0, changed: 2 }).action, "files");
  assert.equal(diffEmptyCopy({ scope: "working", stagedView: false, staged: 0, changed: 0 }).title, "No differences");
  assert.equal(diffEmptyCopy({ scope: "working", stagedView: true, staged: 0, changed: 3 }).title, "Nothing staged");
  assert.equal(diffEmptyCopy({ scope: "pushed", stagedView: false, staged: 2, changed: 2 }).title, "No differences");
});

test("partial-diff commit note follows the commit target", () => {
  assert.equal(partialCommitNote({ stagedOnly: true, staged: 2 }), "Commit records only the 2 files staged.");
  assert.equal(partialCommitNote({ stagedOnly: false, staged: 2 }), "Commit still includes every uncommitted file.");
});

test("no-net-change copy follows the commit target (Sol R6 B01)", () => {
  const staged = diffEmptyCopy({ scope: "working", stagedView: false, staged: 1, changed: 1 });
  assert.match(staged.text, /Commit records the staged version/);
  const all = diffEmptyCopy({ scope: "working", stagedView: false, staged: 1, changed: 1, commitAll: true });
  assert.equal(all.title, "No net change");
  assert.doesNotMatch(all.text, /Commit records the staged version/);
  assert.match(all.text, /Committing all changes records the files on disk/);
  assert.equal(all.action, "staged");
});

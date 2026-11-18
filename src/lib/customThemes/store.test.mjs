import test from "node:test";
import assert from "node:assert/strict";
import {
  STORE_LIMITS,
  canUndo,
  cleanText,
  libraryBytes,
  libraryCommit,
  libraryCreate,
  libraryDelete,
  libraryRename,
  libraryRestoreDeleted,
  librarySetDesigner,
  librarySetDisabled,
  librarySetFocus,
  libraryUndo,
  pruneLibrary,
  resolveThemeSetting,
  sanitizeLibrary,
  summarize,
} from "./store.ts";

const EMPTY = { version: 1, themes: [], threadFocus: {} };
const user = { kind: "user" };
const claude = { kind: "model", provider: "claude", model: "claude-opus-5-5", threadId: "t1" };

function spec(overrides = {}) {
  return {
    schema: "mythra.theme/1",
    name: "Nebula",
    description: "Indigo night",
    base: "mythra",
    tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff" },
    shape: "standard",
    elevation: "soft",
    typography: {},
    surfaces: { translucency: 0 },
    effects: {},
    motion: { enabled: true },
    customCss: "",
    ...overrides,
  };
}

let counter = 0;
const ids = () => `ct_${String(++counter).padStart(10, "0")}`;

function created(name = "Nebula", library = EMPTY, at = 1) {
  const { library: next, result } = libraryCreate(library, spec({ name }), { by: claude, summary: "First version" }, at, ids);
  assert.equal(result.ok, true);
  return { library: next, id: result.record.id };
}

function edit(library, id, accent, at, summary = `Accent ${accent}`) {
  const current = library.themes.find((record) => record.id === id);
  const head = current.revisions.at(-1).spec;
  const { library: next, result } = libraryCommit(library, id, { ...head, tokens: { ...head.tokens, accent } }, { by: claude, summary, kind: "edit" }, at);
  assert.equal(result.ok, true, result.error);
  return next;
}

const record = (library, id) => library.themes.find((entry) => entry.id === id);
const head = (library, id) => record(library, id).revisions.at(-1);

test("create makes revision 1 with no earlier state", () => {
  const { library, id } = created();
  const theme = record(library, id);
  assert.equal(theme.head, 1);
  assert.deepEqual(theme.revisions.map((revision) => [revision.n, revision.kind, revision.prev]), [[1, "create", null]]);
  assert.equal(theme.createdBy.provider, "claude");
  assert.equal(summarize(theme).scheme, "dark");
});

test("edits append revisions that point at the previous head", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2);
  library = edit(library, id, "#00ff00", 3);
  const theme = record(library, id);
  assert.equal(theme.head, 3);
  assert.deepEqual(theme.revisions.map((revision) => [revision.n, revision.kind, revision.prev]), [[1, "create", null], [2, "edit", 1], [3, "edit", 2]]);
  assert.equal(theme.updatedAt, 3);
});

test("an identical edit records nothing", () => {
  const { library, id } = created();
  const { library: next, result } = libraryCommit(library, id, spec(), { by: claude, summary: "Same", kind: "edit" }, 5);
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(next, library);
});

test("repeated undos walk back through the logical states, and each undo is a revision", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2, "Red accent");
  library = edit(library, id, "#00ff00", 3, "Green accent");
  let step = libraryUndo(library, id, { by: claude }, 4);
  assert.equal(step.result.ok, true);
  library = step.library;
  assert.equal(head(library, id).spec.tokens.accent, "#ff0000");
  assert.deepEqual([head(library, id).kind, head(library, id).restoredFrom, head(library, id).prev], ["undo", 2, 1]);
  assert.equal(head(library, id).summary, "Undo: green accent");
  step = libraryUndo(library, id, { by: claude }, 5);
  library = step.library;
  assert.equal(head(library, id).spec.tokens.accent, "#b794ff");
  assert.deepEqual([head(library, id).n, head(library, id).restoredFrom, head(library, id).prev], [5, 1, null]);
  assert.equal(head(library, id).summary, "Undo: red accent");
  step = libraryUndo(library, id, { by: claude }, 6);
  assert.equal(step.result.ok, false);
  assert.match(step.result.error, /Nothing earlier to undo: r1 is how “Nebula” was first created/);
  assert.equal(step.library, library);
  assert.equal(record(library, id).revisions.length, 5);
});

test("steps undo several changes in one revision", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2);
  library = edit(library, id, "#00ff00", 3);
  library = edit(library, id, "#0000ff", 4);
  const { library: next, result } = libraryUndo(library, id, { by: user, steps: 2 }, 5);
  assert.equal(result.ok, true);
  assert.equal(result.undone.length, 2);
  assert.equal(head(next, id).spec.tokens.accent, "#ff0000");
  assert.equal(head(next, id).summary, "Undo 2 changes");
  assert.equal(head(next, id).prev, 1);
  // More steps than there are changes go as far back as possible.
  const all = libraryUndo(library, id, { by: user, steps: 10 }, 5);
  assert.equal(all.result.ok, true);
  assert.equal(head(all.library, id).spec.tokens.accent, "#b794ff");
});

test("restore is a deliberate change, so undoing it returns to where you were", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2);
  library = edit(library, id, "#00ff00", 3);
  const restored = libraryUndo(library, id, { by: user, toRevision: 1 }, 4);
  assert.equal(restored.result.ok, true);
  library = restored.library;
  assert.deepEqual([head(library, id).kind, head(library, id).restoredFrom, head(library, id).prev], ["restore", 1, 3]);
  assert.equal(head(library, id).spec.tokens.accent, "#b794ff");
  const back = libraryUndo(library, id, { by: user }, 5);
  assert.equal(head(back.library, id).spec.tokens.accent, "#00ff00");
});

test("redo after an undo is a restore of the undone revision", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2, "Red accent");
  library = libraryUndo(library, id, { by: claude }, 3).library;
  assert.equal(head(library, id).spec.tokens.accent, "#b794ff");
  const redo = libraryUndo(library, id, { by: user, toRevision: 2 }, 4);
  assert.equal(redo.result.ok, true);
  assert.equal(head(redo.library, id).spec.tokens.accent, "#ff0000");
  assert.equal(head(redo.library, id).summary, "Restored r2: red accent");
});

test("restore refuses the current version and versions that don't exist", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2);
  assert.match(libraryUndo(library, id, { by: user, toRevision: 2 }, 3).result.error, /already the current version/);
  assert.match(libraryUndo(library, id, { by: user, toRevision: 9 }, 3).result.error, /has no r9; its newest version is r2/);
});

test("expectedRevision guards against overwriting a newer edit", () => {
  let { library, id } = created();
  library = libraryRename(library, id, "Nebula Two", user, 2).library;
  const { result } = libraryCommit(library, id, spec({ name: "Nebula Two", description: "x" }), { by: claude, summary: "x", kind: "edit", expectedRevision: 1 }, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /“Nebula Two” changed since you read it \(now r2: “Renamed to “Nebula Two” by you”\)/);
  assert.equal(libraryUndo(library, id, { by: claude, expectedRevision: 1 }, 3).result.ok, false);
  assert.equal(libraryUndo(library, id, { by: claude, expectedRevision: 2 }, 3).result.ok, true);
});

test("renames are undoable revisions and names are cleaned", () => {
  let { library, id } = created();
  const renamed = libraryRename(library, id, "  Deep\u0007 sea\n ", user, 2);
  assert.equal(renamed.result.ok, true);
  library = renamed.library;
  assert.equal(head(library, id).spec.name, "Deep sea");
  assert.equal(head(library, id).kind, "rename");
  assert.equal(libraryRename(library, id, "   ", user, 3).result.ok, false);
  const undone = libraryUndo(library, id, { by: user }, 3);
  assert.equal(head(undone.library, id).spec.name, "Nebula");
  assert.equal(cleanText("x".repeat(50), 40).length, 40);
});

test("the theme limit refuses a 25th theme with an actionable message", () => {
  let library = EMPTY;
  for (let index = 0; index < STORE_LIMITS.maxThemes; index++) library = created(`Theme ${index}`, library, index).library;
  const { library: next, result } = libraryCreate(library, spec(), { by: claude }, 99, ids);
  assert.equal(result.ok, false);
  assert.match(result.error, /You have 24 custom themes, the limit/);
  assert.equal(next, library);
});

test("each theme keeps at most 30 revisions and always its head", () => {
  let { library, id } = created();
  for (let index = 0; index < 40; index++) library = edit(library, id, `#0000${(index + 16).toString(16)}`, index + 2);
  const theme = record(library, id);
  assert.equal(theme.revisions.length, STORE_LIMITS.maxRevisions);
  assert.equal(theme.head, 41);
  assert.equal(theme.revisions.at(-1).n, 41);
  assert.equal(theme.revisions[0].n, 12);
  // Undo still works inside the kept window, and stops cleanly at its edge.
  const restore = libraryUndo(library, id, { by: user, toRevision: 3 }, 50);
  assert.match(restore.result.error, /r3 of “Nebula” was cleared to save space\. The oldest saved version is r12/);
});

test("pruning for space drops the oldest non-head revisions first and keeps the four newest", () => {
  const big = "x".repeat(4000);
  let library = EMPTY;
  const made = [];
  for (let theme = 0; theme < 3; theme++) {
    const result = libraryCreate(library, spec({ name: `T${theme}`, description: big.slice(0, 100), customCss: big }), { by: claude }, theme, ids);
    library = result.library;
    made.push(result.result.record.id);
  }
  let at = 10;
  for (let round = 0; round < 10; round++) {
    for (const id of made) {
      const current = head(library, id).spec;
      library = libraryCommit(library, id, { ...current, customCss: `${big}${round}` }, { by: claude, summary: `r${round}`, kind: "edit" }, at++).library;
    }
  }
  const budget = Math.floor(libraryBytes(library) * 0.6);
  const pruned = pruneLibrary(library, budget);
  assert.ok(libraryBytes(pruned) <= budget);
  for (const id of made) {
    const theme = record(pruned, id);
    assert.ok(theme.revisions.length >= STORE_LIMITS.keepRecent);
    assert.equal(theme.revisions.at(-1).n, theme.head);
    const kept = theme.revisions.map((revision) => revision.n);
    // The newest four of each theme survive.
    assert.deepEqual(kept.slice(-4), record(library, id).revisions.slice(-4).map((revision) => revision.n));
  }
  // The oldest revisions went first across every theme.
  const oldestKept = Math.min(...pruned.themes.flatMap((theme) => theme.revisions.map((revision) => revision.at)));
  assert.ok(oldestKept > 0);
  // A tiny budget falls back to heads only rather than growing without limit.
  const heads = pruneLibrary(library, 1);
  for (const theme of heads.themes) assert.deepEqual(theme.revisions.map((revision) => revision.n), [theme.head]);
});

test("undo stops with a clear message when the earlier version was pruned", () => {
  let { library, id } = created();
  library = edit(library, id, "#ff0000", 2);
  library = { ...library, themes: library.themes.map((theme) => ({ ...theme, revisions: theme.revisions.filter((revision) => revision.n !== 1) })) };
  const { result } = libraryUndo(library, id, { by: user }, 3);
  assert.equal(result.ok, false);
  assert.match(result.error, /\(r1\) was cleared to save space/);
  assert.deepEqual(canUndo(record(library, id)), { ok: false, reason: "The earlier version was cleared to save space" });
});

test("delete removes the theme and its focus; restore puts both back in place", () => {
  let first = created("A");
  let second = created("B", first.library);
  let library = librarySetFocus(second.library, "thread-1", first.id);
  library = librarySetFocus(library, "thread-2", second.id);
  library = librarySetDesigner(library, "thread-1", { at: 1, targetThemeId: first.id });
  const { library: without, deleted } = libraryDelete(library, first.id);
  assert.deepEqual(without.themes.map((theme) => theme.id), [second.id]);
  assert.deepEqual(without.threadFocus, { "thread-2": second.id });
  assert.equal(without.designerThreads["thread-1"].targetThemeId, undefined);
  const { library: back, restored } = libraryRestoreDeleted(without, deleted);
  assert.equal(restored, true);
  assert.deepEqual(back.themes.map((theme) => theme.id), [first.id, second.id]);
  assert.equal(back.threadFocus["thread-1"], first.id);
  assert.equal(record(back, first.id).revisions.length, 1);
  assert.equal(libraryRestoreDeleted(back, deleted).restored, false);
});

test("thread focus is an LRU capped at 300 conversations", () => {
  let { library, id } = created();
  for (let index = 0; index < 320; index++) library = librarySetFocus(library, `t${index}`, id);
  const keys = Object.keys(library.threadFocus);
  assert.equal(keys.length, STORE_LIMITS.maxThreadFocus);
  assert.equal(keys[0], "t20");
  library = librarySetFocus(library, "t20", id);
  assert.equal(Object.keys(library.threadFocus).at(-1), "t20");
  assert.equal(librarySetFocus(library, "tx", "ct_missing000"), library);
});

test("safe mode switches a theme off without losing it, and the next edit turns it back on", () => {
  let { library, id } = created();
  library = librarySetDisabled(library, id, "boot-failure");
  const resolved = resolveThemeSetting(`custom:${id}`, library);
  assert.equal(resolved.custom, null);
  assert.equal(resolved.base, "mythra");
  assert.deepEqual(resolved.fallback, { id, reason: "boot-failure" });
  library = edit(library, id, "#abcdef", 2);
  assert.equal(record(library, id).disabledReason, undefined);
  assert.equal(resolveThemeSetting(`custom:${id}`, library).custom.id, id);
});

test("a theme setting resolves to its base, and a missing theme to the fallback", () => {
  const { library, id } = created();
  const light = libraryCreate(library, spec({ name: "Paper", base: "light-mythra" }), { by: user }, 2, ids);
  const paperId = light.result.record.id;
  assert.equal(resolveThemeSetting(`custom:${paperId}`, light.library).base, "light-mythra");
  assert.equal(resolveThemeSetting("synthwave", library).base, "synthwave");
  assert.deepEqual(resolveThemeSetting("custom:ct_zzzzzzzzzz", library, "kiwi"), { requested: "custom:ct_zzzzzzzzzz", base: "kiwi", custom: null, fallback: { id: "ct_zzzzzzzzzz", reason: "missing" } });
  assert.equal(resolveThemeSetting(`custom:${id}`, library).custom.id, id);
});

test("stored libraries are sanitized: bad entries dropped, head is the newest revision", () => {
  const { library, id } = created();
  const raw = JSON.parse(JSON.stringify(library));
  raw.themes[0].head = 99;
  raw.themes[0].revisions.push({ n: 2, at: 5, by: { kind: "model", provider: "nope" }, kind: "weird", summary: "\u0000x", prev: 1, spec: spec({ name: "Two" }) });
  raw.themes.push({ id: "not-an-id", revisions: [] }, { id: "ct_bbbbbbbbbb", revisions: [{ n: 1, spec: { name: "", base: "mythra", tokens: {} } }] });
  raw.threadFocus = { a: id, b: "ct_cccccccccc" };
  const clean = sanitizeLibrary(raw);
  assert.equal(clean.themes.length, 1);
  assert.equal(clean.themes[0].head, 2);
  assert.equal(clean.themes[0].revisions[1].kind, "edit");
  assert.deepEqual(clean.themes[0].revisions[1].by, { kind: "user" });
  assert.equal(clean.themes[0].revisions[1].summary, "x");
  assert.deepEqual(clean.threadFocus, { a: id });
  assert.deepEqual(sanitizeLibrary("garbage"), EMPTY);
});

import test from "node:test";
import assert from "node:assert/strict";
import { SETTINGS_TILE_LIMIT, filterThemes, isThemeLibrarySort, libraryView, settingsTiles, sortThemes } from "./library.ts";

const user = { kind: "user" };
function record(id, name, { createdAt = 0, updatedAt = createdAt, description = "" } = {}) {
  const spec = { schema: "mythra.theme/1", name, description, base: "mythra", tokens: { bg: "#111111", text: "#eeeeee", accent: "#33ccff" }, effects: {}, motion: { enabled: true } };
  return { id, createdAt, updatedAt, createdBy: user, head: 1, revisions: [{ n: 1, at: createdAt, by: user, kind: "create", summary: "First version", prev: null, spec }] };
}

const themes = [
  record("ct_a", "Nebula", { createdAt: 10, updatedAt: 90, description: "Indigo night with a slow aurora" }),
  record("ct_b", "ember tide", { createdAt: 50, updatedAt: 60, description: "Warm charcoal" }),
  record("ct_c", "Paper Moon", { createdAt: 30, updatedAt: 70, description: "Soft paper, ink-blue accents" }),
  record("ct_d", "Deep Field", { createdAt: 40, updatedAt: 40 }),
  record("ct_e", "Aurora 10", { createdAt: 20, updatedAt: 20 }),
  record("ct_f", "Aurora 9", { createdAt: 60, updatedAt: 10 }),
];
const ids = (list) => list.map((entry) => entry.id);

test("Settings shows at most three tiles (one row), most recently edited first", () => {
  assert.equal(SETTINGS_TILE_LIMIT, 3);
  assert.deepEqual(ids(settingsTiles(themes, null)), ["ct_a", "ct_c", "ct_b"]);
});

test("the chosen custom theme comes first, then the two most recently edited", () => {
  assert.deepEqual(ids(settingsTiles(themes, "ct_f")), ["ct_f", "ct_a", "ct_c"]);
  // Already among the recent ones: moved to the front, not shown twice.
  assert.deepEqual(ids(settingsTiles(themes, "ct_c")), ["ct_c", "ct_a", "ct_b"]);
});

test("three themes all fit; a fourth is left for the library", () => {
  // Three or fewer: every theme is a tile (Settings offers "Manage themes").
  assert.deepEqual(ids(settingsTiles(themes.slice(0, 3), "ct_b")), ["ct_b", "ct_a", "ct_c"]);
  // Four: one stays in the library (Settings offers "See all 4 themes").
  const four = themes.slice(0, 4);
  assert.equal(settingsTiles(four, null).length, 3);
  assert.deepEqual(ids(settingsTiles(four, null)), ["ct_a", "ct_c", "ct_b"]);
  assert.deepEqual(ids(settingsTiles(four, "ct_d")), ["ct_d", "ct_a", "ct_c"]);
});

test("an unknown or missing selection is ignored, empty libraries show nothing", () => {
  assert.deepEqual(ids(settingsTiles(themes, "ct_gone")), ["ct_a", "ct_c", "ct_b"]);
  assert.deepEqual(settingsTiles([], "ct_a"), []);
  assert.deepEqual(settingsTiles(themes, "ct_a", 0), []);
});

test("search matches name and description, ignoring case and extra spaces", () => {
  assert.deepEqual(ids(filterThemes(themes, "EMBER")), ["ct_b"]);
  assert.deepEqual(ids(filterThemes(themes, "aurora")), ["ct_a", "ct_e", "ct_f"]);
  assert.deepEqual(ids(filterThemes(themes, "  ink   paper ")), ["ct_c"]);
  assert.deepEqual(ids(filterThemes(themes, "")), ids(themes));
  assert.deepEqual(filterThemes(themes, "nothing like this"), []);
});

test("sort orders: recently edited, name A–Z (natural, case-blind), newest first", () => {
  assert.deepEqual(ids(sortThemes(themes, "recent")), ["ct_a", "ct_c", "ct_b", "ct_d", "ct_e", "ct_f"]);
  assert.deepEqual(ids(sortThemes(themes, "name")), ["ct_f", "ct_e", "ct_d", "ct_b", "ct_a", "ct_c"]);
  assert.deepEqual(ids(sortThemes(themes, "newest")), ["ct_f", "ct_b", "ct_d", "ct_c", "ct_e", "ct_a"]);
});

test("sorting never mutates the library, and the view filters before sorting", () => {
  const before = ids(themes);
  sortThemes(themes, "name");
  assert.deepEqual(ids(themes), before);
  assert.deepEqual(ids(libraryView(themes, "aurora", "name")), ["ct_f", "ct_e", "ct_a"]);
});

test("only the three known sort orders are accepted", () => {
  assert.ok(isThemeLibrarySort("recent") && isThemeLibrarySort("name") && isThemeLibrarySort("newest"));
  assert.ok(!isThemeLibrarySort("oldest") && !isThemeLibrarySort(undefined));
});

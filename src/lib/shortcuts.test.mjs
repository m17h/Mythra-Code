import test from "node:test";
import assert from "node:assert/strict";
import { SHORTCUTS, shortcutSearchText } from "./shortcuts.ts";
import { matchesSearch, searchWords } from "./searchMatch.ts";

const find = (id) => SHORTCUTS.find((row) => row.id === id);
const match = (row, query) => matchesSearch(shortcutSearchText(row), searchWords(query));

test("conversation search lives with conversation shortcuts, not thread navigation", () => {
  assert.equal(find("searchConversation").group, "Conversation");
  assert.equal(find("searchNext").group, "Conversation");
  assert.equal(find("newThread").group, "Threads");
});

test("filter matches labels, notes and key names", () => {
  assert.ok(match(find("searchConversation"), "search"));
  assert.ok(match(find("stop"), "typing"));
  assert.ok(match(find("toggleSidebar"), "backslash"));
  assert.ok(match(find("palette"), "cmd k"));
  assert.ok(match(find("toggleWorkspace"), "option b"));
  assert.ok(!match(find("palette"), "workspace"));
});

test("empty query matches everything", () => {
  for (const row of SHORTCUTS) assert.ok(match(row, ""));
});

test("columns split whole groups so neither column runs far past the other", async () => {
  const { splitIntoColumns } = await import("./shortcuts.ts");
  const groups = [["General", 5], ["Conversation", 6.2], ["Threads", 10.8], ["Composer", 7.6], ["Tools", 7.6]];
  const [left, right] = splitIntoColumns(groups, (group) => group[1]);
  const sum = (column) => column.reduce((total, group) => total + group[1], 0);
  assert.equal(left[0][0], "General");
  assert.ok(Math.abs(sum(left) - sum(right)) <= 2, `${sum(left)} vs ${sum(right)}`);
  assert.equal(left.length + right.length, groups.length);
  // Each column keeps the canonical order.
  const order = groups.map((group) => group[0]);
  for (const column of [left, right]) {
    const positions = column.map((group) => order.indexOf(group[0]));
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  }
});

test("one group stays in the first column; none gives two empty columns", async () => {
  const { splitIntoColumns } = await import("./shortcuts.ts");
  assert.deepEqual(splitIntoColumns(["a"], () => 3), [["a"], []]);
  assert.deepEqual(splitIntoColumns([], () => 3), [[], []]);
});

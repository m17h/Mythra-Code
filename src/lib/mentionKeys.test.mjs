import test from "node:test";
import assert from "node:assert/strict";
import { mentionKeyAction, nextMentionIndex } from "./mentionKeys.ts";

test("Shift+Tab with suggestions open closes the list and passes focus on (never accepts)", () => {
  assert.equal(mentionKeyAction({ key: "Tab", shiftKey: true }, true, 3), "close-and-pass");
});

test("forward Tab and Return insert the highlighted suggestion", () => {
  assert.equal(mentionKeyAction({ key: "Tab" }, true, 3), "accept");
  assert.equal(mentionKeyAction({ key: "Enter" }, true, 3), "accept");
});

test("arrows move and Escape closes", () => {
  assert.equal(mentionKeyAction({ key: "ArrowDown" }, true, 2), "next");
  assert.equal(mentionKeyAction({ key: "ArrowUp" }, true, 2), "previous");
  assert.equal(mentionKeyAction({ key: "Escape" }, true, 2), "close");
});

test("a closed list or no results never claims a key (Tab moves focus normally)", () => {
  for (const key of ["Tab", "Enter", "ArrowDown", "Escape"]) {
    assert.equal(mentionKeyAction({ key }, false, 3), null);
    assert.equal(mentionKeyAction({ key }, true, 0), null);
    assert.equal(mentionKeyAction({ key, shiftKey: true }, false, 3), null);
  }
});

test("Ctrl/⌘+Tab is the window's, not the list's", () => {
  assert.equal(mentionKeyAction({ key: "Tab", ctrlKey: true }, true, 3), null);
  assert.equal(mentionKeyAction({ key: "Tab", metaKey: true, shiftKey: true }, true, 3), null);
});

test("typing keys fall through to the editor", () => {
  assert.equal(mentionKeyAction({ key: "a" }, true, 3), null);
  assert.equal(mentionKeyAction({ key: "Backspace" }, true, 3), null);
});

test("highlight wraps at both ends", () => {
  assert.equal(nextMentionIndex(0, 3, "next"), 1);
  assert.equal(nextMentionIndex(2, 3, "next"), 0);
  assert.equal(nextMentionIndex(0, 3, "previous"), 2);
  assert.equal(nextMentionIndex(-1, 3, "previous"), 2);
  assert.equal(nextMentionIndex(5, 3, "next"), 0);
  assert.equal(nextMentionIndex(0, 0, "next"), 0);
});

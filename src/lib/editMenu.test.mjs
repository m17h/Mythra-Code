import test from "node:test";
import assert from "node:assert/strict";
import { classifyClipboard, editMenuItems, fitPasteToMaxLength, normalizePastedText } from "./editMenu.ts";

const snapshot = (overrides = {}) => ({ selectionStart: 0, selectionEnd: 0, length: 10, editable: true, ...overrides });
const byCommand = (items) => Object.fromEntries(items.map((item) => [item.command, item]));

test("the edit menu lists Cut, Copy, Paste and Select all in native order", () => {
  const items = editMenuItems(snapshot(), "unknown", "MacIntel");
  assert.deepEqual(items.map((item) => item.label), ["Cut", "Copy", "Paste", "Select all"]);
  assert.deepEqual(items.map((item) => Boolean(item.separatorBefore)), [false, false, false, true]);
});

test("key hints follow the platform", () => {
  const mac = byCommand(editMenuItems(snapshot(), "unknown", "MacIntel"));
  assert.deepEqual([mac.cut.shortcut, mac.copy.shortcut, mac.paste.shortcut, mac.selectAll.shortcut], ["⌘X", "⌘C", "⌘V", "⌘A"]);
  assert.equal(mac.paste.ariaShortcut, "Meta+V");
  const windows = byCommand(editMenuItems(snapshot(), "unknown", "Win32"));
  assert.deepEqual([windows.cut.shortcut, windows.copy.shortcut, windows.paste.shortcut, windows.selectAll.shortcut], ["Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+A"]);
  assert.equal(windows.paste.ariaShortcut, "Control+V");
});

test("Cut and Copy need a selection; Cut and Paste need an editable box", () => {
  const caret = byCommand(editMenuItems(snapshot({ selectionStart: 3, selectionEnd: 3 }), "text"));
  assert.equal(caret.cut.disabled, true);
  assert.equal(caret.copy.disabled, true);
  assert.equal(caret.paste.disabled, false);
  const selected = byCommand(editMenuItems(snapshot({ selectionStart: 2, selectionEnd: 5 }), "text"));
  assert.equal(selected.cut.disabled, false);
  assert.equal(selected.copy.disabled, false);
  const readOnly = byCommand(editMenuItems(snapshot({ selectionStart: 2, selectionEnd: 5, editable: false }), "text"));
  assert.equal(readOnly.cut.disabled, true);
  assert.equal(readOnly.copy.disabled, false);
  assert.equal(readOnly.paste.disabled, true);
});

test("Paste is unavailable only when the clipboard is known to be empty or unreadable", () => {
  for (const [contents, disabled] of [["unknown", false], ["text", false], ["image", false], ["empty", true], ["unreadable", true]]) {
    assert.equal(byCommand(editMenuItems(snapshot(), contents)).paste.disabled, disabled, contents);
  }
});

test("Select all is unavailable in an empty box", () => {
  assert.equal(byCommand(editMenuItems(snapshot({ length: 0 }), "text")).selectAll.disabled, true);
  assert.equal(byCommand(editMenuItems(snapshot({ length: 1 }), "text")).selectAll.disabled, false);
});

test("pasted text keeps a textarea's line breaks and drops NULs", () => {
  assert.equal(normalizePastedText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizePastedText("x\0y"), "xy");
  assert.equal(normalizePastedText("  spaced  "), "  spaced  ");
});

test("a paste is trimmed to fit maxlength without splitting a surrogate pair", () => {
  assert.equal(fitPasteToMaxLength("hello", 3, 0, -1), "hello");
  assert.equal(fitPasteToMaxLength("hello", 3, 0, 6), "hel");
  // Replacing a 2-character selection frees two more.
  assert.equal(fitPasteToMaxLength("hello", 3, 2, 6), "hello");
  assert.equal(fitPasteToMaxLength("hello", 10, 0, 6), "");
  assert.equal(fitPasteToMaxLength("a😀b", 0, 0, 2), "a");
});

test("clipboard reads are classified with images first", () => {
  assert.equal(classifyClipboard([["text/plain"], ["image/png"]], "caption"), "image");
  assert.equal(classifyClipboard([["text/plain"]], "hello"), "text");
  assert.equal(classifyClipboard([["text/plain"]], ""), "empty");
  assert.equal(classifyClipboard([], null), "empty");
});

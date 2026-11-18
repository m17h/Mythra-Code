import test from "node:test";
import assert from "node:assert/strict";
import { isResetThemeChord } from "./useAppShortcuts.ts";
import { SHORTCUTS, formatKeys } from "../lib/shortcuts.ts";

const key = (overrides) => ({ code: "KeyT", key: "T", altKey: true, shiftKey: true, metaKey: false, ctrlKey: false, ...overrides });

test("the theme reset chord is ⌘⌥⇧T on macOS and Ctrl+Alt+Shift+T elsewhere", () => {
  assert.equal(isResetThemeChord(key({ metaKey: true, key: "ˇ" }), "MacIntel"), true);
  assert.equal(isResetThemeChord(key({ ctrlKey: true }), "Win32"), true);
  assert.equal(isResetThemeChord(key({ metaKey: true, shiftKey: false }), "MacIntel"), false);
  assert.equal(isResetThemeChord(key({ metaKey: true, altKey: false }), "MacIntel"), false);
  assert.equal(isResetThemeChord(key({ ctrlKey: true, code: "KeyR", key: "R" }), "Win32"), false);
});

test("the chord is listed once in the shortcuts sheet", () => {
  const rows = SHORTCUTS.filter((row) => row.id === "resetTheme");
  assert.equal(rows.length, 1);
  assert.equal(formatKeys(rows[0].keys, "MacIntel"), "⌥⇧⌘T");
  assert.equal(formatKeys(rows[0].keys, "Win32"), "Ctrl+Shift+Alt+T");
  // No other shortcut already uses the same keys.
  const signature = (keys) => [...keys].sort().join("+");
  assert.equal(SHORTCUTS.filter((row) => signature(row.keys) === signature(rows[0].keys)).length, 1);
});

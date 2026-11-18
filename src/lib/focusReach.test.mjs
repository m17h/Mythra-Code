import test from "node:test";
import assert from "node:assert/strict";
import { containedTabTarget, insideCollapsedDetails, isReachableFocusable } from "./focusReach.ts";

// Minimal element fakes: a tree with tagName, attributes and parent links.
function el(tagName, { attrs = {}, tabIndex = 0, rects = 1, parent = null, blockedBy = [] } = {}) {
  const node = {
    tagName,
    tabIndex,
    parentElement: parent,
    attrs,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    getClientRects: () => ({ length: rects }),
    // `closest` only needs to answer the "unreachable ancestor" query here.
    closest: () => (blockedBy.length || node.attrs.inert !== undefined ? node : null),
  };
  return node;
}
const visible = () => "visible";

test("plain reachable button counts", () => {
  assert.equal(isReachableFocusable(el("BUTTON"), null, visible), true);
});

test("negative tabindex, disabled and zero-size controls are skipped", () => {
  assert.equal(isReachableFocusable(el("BUTTON", { tabIndex: -1 }), null, visible), false);
  assert.equal(isReachableFocusable(el("BUTTON", { attrs: { disabled: "" } }), null, visible), false);
  assert.equal(isReachableFocusable(el("BUTTON", { rects: 0 }), null, visible), false);
});

test("controls under inert / hidden / aria-hidden / disabled fieldset ancestors are skipped", () => {
  assert.equal(isReachableFocusable(el("BUTTON", { blockedBy: ["inert"] }), null, visible), false);
});

test("visibility hidden is skipped", () => {
  assert.equal(isReachableFocusable(el("BUTTON"), null, () => "hidden"), false);
});

test("collapsed details hide their body but keep their own summary reachable", () => {
  const details = el("DETAILS");
  const summary = el("SUMMARY", { parent: details });
  const body = el("DIV", { parent: details });
  const inner = el("BUTTON", { parent: body });
  assert.equal(insideCollapsedDetails(summary), false);
  assert.equal(insideCollapsedDetails(inner), true);
  assert.equal(isReachableFocusable(summary, null, visible), true);
  assert.equal(isReachableFocusable(inner, null, visible), false);
});

test("open details expose their body", () => {
  const details = el("DETAILS", { attrs: { open: "" } });
  const inner = el("BUTTON", { parent: el("DIV", { parent: details }) });
  assert.equal(insideCollapsedDetails(inner), false);
});

test("a closed details above the trap root does not count", () => {
  const outer = el("DETAILS");
  const root = el("DIV", { parent: outer });
  const inner = el("BUTTON", { parent: root });
  assert.equal(insideCollapsedDetails(inner, root), false);
});

test("contained Tab: a focused static title is a position, not an exit (B04)", () => {
  // Title before all 3 stops (e.g. an approval heading): Shift+Tab wraps to the last stop.
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 0, inside: true, shift: true }), 2);
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 0, inside: true, shift: false }), 0);
  // A static element between stops 1 and 2: the neighbours on each side.
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 2, inside: true, shift: true }), 1);
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 2, inside: true, shift: false }), 2);
  // After every stop: Tab wraps to the first.
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 3, inside: true, shift: false }), 0);
});

test("contained Tab: wraps at the ends, defers to the browser in between, pulls focus back from outside", () => {
  assert.equal(containedTabTarget({ count: 3, activeIndex: 2, before: 0, inside: true, shift: false }), 0);
  assert.equal(containedTabTarget({ count: 3, activeIndex: 0, before: 0, inside: true, shift: true }), 2);
  assert.equal(containedTabTarget({ count: 3, activeIndex: 1, before: 0, inside: true, shift: false }), null);
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 0, inside: false, shift: false }), 0);
  assert.equal(containedTabTarget({ count: 3, activeIndex: -1, before: 0, inside: false, shift: true }), 2);
  assert.equal(containedTabTarget({ count: 0, activeIndex: -1, before: 0, inside: true, shift: false }), null);
});

// Run manually. No Vitest naming/discovery and no CI/merge/release integration.
import assert from "node:assert/strict";
import { planLineTargets, observeLineTargets } from "./line-targets.mjs";

const capture = { events: [
  { at: 10, text: "First valid line.\n\nRepeated line.\n\n- list item\n1. ordered item\nEntity &amp; line.\nInline <b>markup</b>.\n" },
  { at: 20, text: "Repeated line.\n\nSecond valid line.\n" },
] };
const visible = "First valid line. Repeated line. list item ordered item Entity & line. Inline markup. Repeated line. Second valid line.";
const plan = planLineTargets(capture, visible);
assert.deepEqual(plan.lines.map(({ text }) => text), ["First valid line.", "Second valid line."]);
assert.equal(plan.excluded.filter(({ reason }) => reason === "ambiguous-visible-occurrence").length, 2);
assert.equal(plan.excluded.filter(({ reason }) => reason === "markdown-syntax-or-entity").length, 4);
observeLineTargets(plan.lines, visible, 15, 10);
assert.equal(plan.lines[0].observedAtMs, 15);
assert.equal(plan.lines[1].observedAtMs, null);
observeLineTargets(plan.lines, visible, 25, 10);
assert.equal(plan.lines[1].observedAtMs, null);
observeLineTargets(plan.lines, visible, 25, 20);
assert.equal(plan.lines[1].observedAtMs, 25);
const substring = planLineTargets({ events: [{ at: 0, text: "Echo.\n\nAn Echo.\n" }] }, "Echo. An Echo.");
assert.equal(substring.lines.length, 1);
assert.equal(substring.excluded[0].reason, "ambiguous-visible-occurrence");
console.log("Line-target validation passed: duplicate/substring ambiguity, Markdown lists/entities/HTML and both arrival gates.");

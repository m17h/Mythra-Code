import test from "node:test";
import assert from "node:assert/strict";
import { TOPBAR_SHED, TOPBAR_SHED_MAX, TOPBAR_SHED_PULL_REQUESTS, TOPBAR_SHED_SHORT_STATUS, TOPBAR_SHED_USAGE, topbarShedTarget, topbarStatusLabel } from "./topbarFit.ts";

test("overflowing bar never fits", () => {
  assert.equal(topbarShedTarget({ barClient: 600, barScroll: 640, headingClient: 300, headingNatural: 120 }), false);
});

test("title needs its room (capped) before chrome can stay", () => {
  assert.equal(topbarShedTarget({ barClient: 900, barScroll: 900, headingClient: 120, headingNatural: 260 }), false);
  assert.equal(topbarShedTarget({ barClient: 900, barScroll: 900, headingClient: 200, headingNatural: 260 }), true);
  // A short title only needs its own width.
  assert.equal(topbarShedTarget({ barClient: 900, barScroll: 900, headingClient: 90, headingNatural: 90 }), true);
});

test("ladder order: overflow items leave before labels, short status last", () => {
  assert.ok(TOPBAR_SHED_PULL_REQUESTS < TOPBAR_SHED_USAGE);
  assert.equal(TOPBAR_SHED_SHORT_STATUS, TOPBAR_SHED_MAX);
  assert.equal(TOPBAR_SHED[0], "full");
});

test("status words are never dropped, and approval never looks like setup", () => {
  for (const short of [false, true]) {
    const approval = topbarStatusLabel("approval", "Needs approval", short);
    const setup = topbarStatusLabel("setup", "Setup needed", short);
    assert.ok(approval.length > 0 && setup.length > 0);
    assert.notEqual(approval, setup);
  }
  assert.equal(topbarStatusLabel("setup", "Setup needed", true), "Set up");
  assert.equal(topbarStatusLabel("ready", "Ready", true), "Ready");
});

test("M03: the quota chip never sheds its meaning word; it leaves whole right after its window name", () => {
  assert.ok(!TOPBAR_SHED.some((step) => /left/.test(step) && /suffix/.test(step)), "no step drops the “left” word");
  const windowStep = TOPBAR_SHED.findIndex((step) => step === "usage window name");
  assert.ok(windowStep > 0 && windowStep < TOPBAR_SHED_USAGE);
  assert.match(TOPBAR_SHED[TOPBAR_SHED_USAGE], /usage chip/);
});

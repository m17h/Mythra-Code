import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_TAB_META } from "./studioTabMeta.ts";
import { TOOL_ACTIONS } from "./CommandPalette.tsx";
import { STUDIO_TAB_IDS } from "../lib/studioTabs.ts";

test("every palette Tools entry uses the rail's name and icon, in rail order (Opus R6 D2)", () => {
  assert.deepEqual(TOOL_ACTIONS.map(([id]) => id), STUDIO_TAB_IDS);
  for (const [id, label, detail, icon] of TOOL_ACTIONS) {
    assert.equal(label, STUDIO_TAB_META[id].label, `${id} label`);
    assert.equal(icon, STUDIO_TAB_META[id].icon, `${id} icon`);
    assert.ok(detail.length > 0, `${id} has a description`);
  }
});

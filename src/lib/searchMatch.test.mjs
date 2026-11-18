import test from "node:test";
import assert from "node:assert/strict";
import { labelMatchRank, orderSettingsResults, searchWords } from "./searchMatch.ts";

test("label rank: exact, prefix, words, keywords only", () => {
  assert.equal(labelMatchRank("Terminal history", searchWords("terminal history")), 0);
  assert.equal(labelMatchRank("Terminal history", searchWords("term")), 1);
  assert.equal(labelMatchRank("Stop long-running commands after", searchWords("commands stop")), 2);
  assert.equal(labelMatchRank("Stop long-running commands after", searchWords("running")), 2);
  assert.equal(labelMatchRank("Advanced", searchWords("scrollback")), 3);
});

test("an exact row answer beats the pane that only contains it", () => {
  const panes = [{ label: "Advanced" }];
  const rows = [{ label: "Terminal history", paneLabel: "Advanced" }];
  const order = orderSettingsResults(panes, rows, searchWords("terminal history"));
  assert.equal(order[0].kind, "row");
  assert.equal(order[0].item.label, "Terminal history");
});

test("a pane named by the query leads, and a row repeating it is dropped", () => {
  const panes = [{ label: "Scheduled tasks" }];
  const rows = [{ label: "Scheduled tasks", paneLabel: "Scheduled tasks" }, { label: "Automatic thread titles", paneLabel: "General" }];
  const order = orderSettingsResults(panes, rows, searchWords("scheduled"));
  assert.equal(order.length, 2);
  assert.equal(order[0].kind, "pane");
});

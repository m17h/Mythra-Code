import test from "node:test";
import assert from "node:assert/strict";
import { attentionIdsFromKey, attentionThreadKey, countAttentionByWorkspace } from "./sidebarAttention.ts";

test("only threads with an unanswered approval need attention", () => {
  const key = attentionThreadKey({ b: { approvals: [1] }, a: { approvals: [1, 2] }, c: { approvals: [] }, d: undefined });
  assert.equal(key, "a|b");
  assert.deepEqual([...attentionIdsFromKey(key)], ["a", "b"]);
  assert.equal(attentionIdsFromKey("").size, 0);
});

test("counts group by binding first, then the thread's folder", () => {
  const ids = new Set(["a", "b", "c"]);
  const counts = countAttentionByWorkspace(ids, { a: { cwd: "/x/atlas/" }, b: { cwd: "/x/ledger" }, c: {} }, { b: "/x/atlas" });
  assert.deepEqual(counts, { "/x/atlas": 2 });
});

test("I5: the run time appears from 10s; the formatter is unchanged", async () => {
  const { visibleWorkingDuration, formatWorkingDuration } = await import("./sidebarAttention.ts");
  assert.equal(visibleWorkingDuration(0), null);
  assert.equal(visibleWorkingDuration(9_999), null);
  assert.equal(visibleWorkingDuration(Number.NaN), null);
  assert.equal(visibleWorkingDuration(10_000), "10s");
  assert.equal(visibleWorkingDuration(125_000), "2m");
  assert.equal(formatWorkingDuration(1_000), "1s");
  assert.equal(formatWorkingDuration(3_900_000), "1h 5m");
});

test("I5/M02: running and waiting rows put their status on its own line; idle and Done rows stay one line", async () => {
  const { statusOnOwnLine } = await import("./sidebarAttention.ts");
  for (const state of ["live", "attention", "waiting", "faulted", "unavailable"]) assert.equal(statusOnOwnLine(state), true, state);
  for (const state of ["", "settled"]) assert.equal(statusOnOwnLine(state), false, state);
});

test("I8: a project row shows one indicator; approval outranks working and the tooltip names both", async () => {
  const { projectIndicator } = await import("./sidebarAttention.ts");
  assert.equal(projectIndicator(0, 0), null);
  assert.deepEqual(projectIndicator(0, 1), { kind: "working", count: 1, title: "1 thread working" });
  assert.deepEqual(projectIndicator(0, 3), { kind: "working", count: 3, title: "3 threads working" });
  assert.deepEqual(projectIndicator(1, 0), { kind: "attention", count: 1, title: "1 thread needs approval" });
  assert.deepEqual(projectIndicator(2, 1), { kind: "attention", count: 2, title: "2 threads need approval · 1 thread working" });
});

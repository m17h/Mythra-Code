import test from "node:test";
import assert from "node:assert/strict";
import { REPLICA_SIZE, evaluateViewportMedia, replicaScope, rootToHost, serializeReplicaRules } from "./replicaCss.ts";

test("the replica is laid out at 16:10, like the cards it fills", () => {
  assert.equal(REPLICA_SIZE.width / REPLICA_SIZE.height, 1.6);
});

test("width and height media queries are decided for the replica's own size", () => {
  const v = { width: 1200, height: 750 };
  assert.equal(evaluateViewportMedia("(max-width: 700px)", v), false);
  assert.equal(evaluateViewportMedia("(max-width: 1250px)", v), true);
  assert.equal(evaluateViewportMedia("(min-width: 901px) and (max-width: 1250px)", v), true);
  assert.equal(evaluateViewportMedia("(min-width: 1400px)", v), false);
  assert.equal(evaluateViewportMedia("(max-width: 640px), (max-height: 560px)", v), false);
  assert.equal(evaluateViewportMedia("(max-height: 760px)", v), true);
  assert.equal(evaluateViewportMedia("screen and (max-width: 75em)", v), true, "em is 16px in media queries");
  assert.equal(evaluateViewportMedia("only screen and (max-width: 600px)", v), false);
  assert.equal(evaluateViewportMedia("print", v), false);
});

test("range syntax works too", () => {
  const v = { width: 1200, height: 750 };
  assert.equal(evaluateViewportMedia("(width <= 900px)", v), false);
  assert.equal(evaluateViewportMedia("(width > 900px)", v), true);
  assert.equal(evaluateViewportMedia("(600px <= width <= 1300px)", v), true);
  assert.equal(evaluateViewportMedia("(1300px < width)", v), false);
});

test("anything that isn't about the window's size is kept as written", () => {
  assert.equal(evaluateViewportMedia("(prefers-reduced-motion: no-preference)"), null);
  assert.equal(evaluateViewportMedia("(hover: none)"), null);
  assert.equal(evaluateViewportMedia("(forced-colors: active)"), null);
  assert.equal(evaluateViewportMedia("not all and (max-width: 600px)"), null);
  // A size test that fails decides it; one that passes still depends on the rest.
  assert.equal(evaluateViewportMedia("(prefers-reduced-motion: reduce) and (max-width: 600px)"), false);
  assert.equal(evaluateViewportMedia("(prefers-reduced-motion: reduce) and (max-width: 1600px)"), null);
  // A list: one sure match is enough; otherwise unknown parts keep it.
  assert.equal(evaluateViewportMedia("(hover: none), (max-width: 1600px)"), true);
  assert.equal(evaluateViewportMedia("(hover: none), (max-width: 600px)"), null);
});

test(":root becomes :host so root-keyed rules reach the shadow root", () => {
  assert.equal(rootToHost(":root { --x: 1px; }"), ":host { --x: 1px; }");
  assert.equal(rootToHost(':root[data-platform="windows"] .app-shell { color: red; }'), ':host([data-platform="windows"]) .app-shell { color: red; }');
  assert.equal(rootToHost(":root .app-shell, :root:hover .x {}"), ":host .app-shell, :host:hover .x {}");
  assert.equal(rootToHost(".rootless { }"), ".rootless { }");
});

const style = (cssText) => ({ cssText });
const media = (mediaText, rules) => ({ cssText: `@media ${mediaText} { … }`, media: { mediaText }, cssRules: rules });

test("serializing unwraps media that always apply, drops ones that never do, keeps the rest", () => {
  const rules = [
    style(".a { color: red; }"),
    media("(max-width: 700px)", [style(".narrow { display: none; }")]),
    media("(max-width: 1250px)", [style(".mid { gap: 4px; }")]),
    media("(prefers-reduced-motion: no-preference)", [
      style(".b { animation: x 1s; }"),
      media("(max-width: 600px)", [style(".c { animation: none; }")]),
    ]),
    { cssText: "@keyframes x { from { opacity: 0; } }" },
  ];
  const out = serializeReplicaRules(rules);
  assert.ok(out.includes(".a { color: red; }"));
  assert.ok(!out.includes(".narrow"), "a narrow-window rule never reaches the replica");
  assert.ok(out.includes(".mid { gap: 4px; }") && !out.includes("@media (max-width: 1250px)"), "an always-true query is unwrapped");
  assert.ok(out.includes("@media (prefers-reduced-motion: no-preference) {\n.b { animation: x 1s; }\n}"), "motion queries stay, minus their dead inner rules");
  assert.ok(!out.includes(".c {"));
  assert.ok(out.includes("@keyframes x"));
});

test("a replica scope needs the replica marker, so the real shell never matches it", () => {
  assert.equal(replicaScope("ct_abc"), '.app-shell[data-theme][data-color-scheme][data-custom-theme="ct_abc"][data-ct-replica]');
});

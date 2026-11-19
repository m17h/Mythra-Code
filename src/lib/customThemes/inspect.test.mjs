import test from "node:test";
import assert from "node:assert/strict";
import {
  REGIONS, REPORT_LIMITS, buildLayoutReport, classifyBackground, displaySelector, judgeDecoration, judgeEffect,
  queryableSelector, splitSelectorList, startsStackingContext, suggestSelectors,
} from "./inspect.ts";

const SCOPE = ':root .app-shell[data-theme][data-color-scheme][data-custom-theme="ct_aaaaaaaaaa"]';
const MOTION = `${SCOPE}[data-theme-motion="on"]`;
const KNOWN = ["app-shell", "sidebar", "main-panel", "topbar", "conversation", "timeline-shell", "composer-zone", "composer", "studio-dock", "thread-card", "rich-markdown", "thread-empty-state", "chat-font-picker"];

test("regions are the real app selectors, innermost first", () => {
  const selectors = REGIONS.map((region) => region.selector);
  for (const selector of [".sidebar", ".main-panel", ".topbar", ".conversation", ".timeline-shell", ".composer-zone", ".composer", ".studio-dock.open", ".app-shell"]) {
    assert.ok(selectors.includes(selector), selector);
  }
  assert.ok(selectors.indexOf(".composer") < selectors.indexOf(".composer-zone"));
  assert.ok(selectors.indexOf(".composer-zone") < selectors.indexOf(".conversation"));
  assert.ok(selectors.indexOf(".conversation") < selectors.indexOf(".main-panel"));
  assert.equal(selectors.at(-1), ".app-shell");
  assert.match(REGIONS.find((region) => region.selector === ".studio-dock.open").name, /^Tools panel/);
  assert.ok(!REGIONS.some((region) => /workspace/i.test(region.name)), "the right panel is called Tools");
});

test("selector lists split on top-level commas only", () => {
  assert.deepEqual(splitSelectorList(".a, .b > .c"), [".a", ".b > .c"]);
  assert.deepEqual(splitSelectorList('.a:is(.b, .c), [data-x="1,2"], .d'), [".a:is(.b, .c)", '[data-x="1,2"]', ".d"]);
});

test("queryable selectors drop the pseudo-element and interaction states", () => {
  assert.deepEqual(queryableSelector(".main-panel::before"), { base: ".main-panel", pseudo: "before", states: [] });
  assert.deepEqual(queryableSelector(".composer:focus-within::after"), { base: ".composer", pseudo: "after", states: [":focus-within"] });
  assert.deepEqual(queryableSelector(".thread-card:hover"), { base: ".thread-card", states: [":hover"] });
  assert.equal(queryableSelector(".x:not(:hover)").base, ".x:not(:hover)");
  assert.equal(queryableSelector(".composer textarea::placeholder").pseudo, "other");
  assert.equal(queryableSelector(".a > ::before").base, ".a > *");
});

test("display selectors hide the sanitizer's scope", () => {
  assert.equal(displaySelector(`${SCOPE} .main-panel::before`, [MOTION, SCOPE]), ".main-panel::before");
  assert.equal(displaySelector(`${MOTION} .sidebar`, [MOTION, SCOPE]), ".sidebar");
  assert.equal(displaySelector(SCOPE, [MOTION, SCOPE]), ".app-shell");
});

test("did you mean: region words first, then near real classes", () => {
  assert.equal(suggestSelectors(".chat-stage", KNOWN)[0], ".conversation");
  assert.equal(suggestSelectors(".main", KNOWN)[0], ".main-panel");
  assert.ok(suggestSelectors(".sidebar-x", KNOWN).includes(".sidebar"));
  assert.ok(suggestSelectors(".composr", KNOWN).includes(".composer"));
  assert.ok(suggestSelectors(".workspace-panel", KNOWN).includes(".studio-dock"));
  assert.ok(suggestSelectors(".chat-stage", KNOWN).length <= 3);
  assert.deepEqual(suggestSelectors(".zzqqx", KNOWN), []);
  // Only safe class names are ever suggested.
  assert.ok(!suggestSelectors(".topbarr", ["topbar", "has space", "<script>"]).some((name) => /[ <]/.test(name)));
});

test("backgrounds: opaque, gradient fades and see-through", () => {
  assert.equal(classifyBackground("rgb(20, 20, 24)", "none"), "opaque");
  assert.equal(classifyBackground("rgba(20, 20, 24, 0.6)", "none"), "partial");
  assert.equal(classifyBackground("rgba(0, 0, 0, 0)", "none"), "clear");
  assert.equal(classifyBackground("rgba(0, 0, 0, 0)", "linear-gradient(rgba(0, 0, 0, 0) 0%, rgb(16, 16, 20) 60%)"), "partial");
  assert.equal(classifyBackground("rgba(0, 0, 0, 0)", "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6))"), "opaque");
  assert.equal(classifyBackground("rgb(20, 20, 24)", "none", 0.3), "clear");
});

test("stacking contexts", () => {
  const base = { position: "static", zIndex: "auto", opacity: "1", transform: "none", filter: "none", isolation: "auto", mixBlendMode: "normal" };
  assert.equal(startsStackingContext(base), false);
  assert.equal(startsStackingContext({ ...base, isolation: "isolate" }), true);
  assert.equal(startsStackingContext({ ...base, position: "relative", zIndex: "0" }), true);
  assert.equal(startsStackingContext({ ...base, zIndex: "1" }), false);
  assert.equal(startsStackingContext({ ...base, zIndex: "1" }, true), true);
  assert.equal(startsStackingContext({ ...base, opacity: "0.9" }), true);
});

const DECORATION = {
  selector: ".main-panel::before", pseudo: "before", host: ".main-panel", hasContent: true, display: "block", visibility: "visible",
  opacity: 1, animatedOpacityMax: null, width: 900, height: 800, position: "absolute", zIndex: "0", hostPositioned: true, covered: 0, coveredBy: [],
};

test("decoration verdicts explain what hides them", () => {
  assert.deepEqual(judgeDecoration(DECORATION), { visible: "yes" });
  assert.match(judgeDecoration({ ...DECORATION, hasContent: false }).fix, /content: ""/);
  assert.equal(judgeDecoration({ ...DECORATION, width: 0, position: "static" }).visible, "no");
  assert.match(judgeDecoration({ ...DECORATION, width: 0, position: "static" }).fix, /position: absolute/);
  assert.equal(judgeDecoration({ ...DECORATION, opacity: 0 }).visible, "no");
  assert.equal(judgeDecoration({ ...DECORATION, opacity: 0, animatedOpacityMax: 0.8 }).visible, "sometimes");
  const behind = judgeDecoration({ ...DECORATION, zIndex: "-1", behindOwnBackground: ".main-panel" });
  assert.equal(behind.visible, "no");
  assert.match(behind.fix, /isolation: isolate/);
  const covered = judgeDecoration({ ...DECORATION, covered: 0.95, coveredBy: [".composer-zone", ".timeline-shell"] });
  assert.equal(covered.visible, "no");
  assert.match(covered.why, /\.composer-zone/);
  assert.equal(judgeDecoration({ ...DECORATION, covered: 0.4, coveredBy: [".composer-zone"] }).visible, "partly");
  assert.match(judgeDecoration({ ...DECORATION, placedAgainst: ".app-shell", hostPositioned: false }).why, /position: relative/);
  assert.equal(judgeDecoration({ ...DECORATION, offscreen: true }).visible, "no");
});

test("effect verdicts", () => {
  assert.match(judgeEffect({ effect: "aurora", kind: "backdrop", rendered: false, reason: "no-translucency" }).fix, /surfaces\.translucency/);
  assert.equal(judgeEffect({ effect: "aurora", kind: "backdrop", rendered: true, covered: 0.1, opacity: 0.4 }).visible, "yes");
  const partly = judgeEffect({ effect: "aurora", kind: "backdrop", rendered: true, covered: 0.5, coveredBy: [".composer-zone"], opacity: 0.4 });
  assert.equal(partly.visible, "partly");
  assert.match(partly.why, /composer-zone/);
  assert.equal(judgeEffect({ effect: "grain", kind: "texture", rendered: true, opacity: 0 }).visible, "no");
  assert.match(judgeEffect({ effect: "shimmer", kind: "accent", rendered: false, reason: "not-on-screen", target: ".thread-empty-state h1" }).why, /not on screen/);
});

function facts(overrides = {}) {
  return {
    window: { w: 1440.4, h: 900 },
    regions: [
      { selector: ".composer", name: "composer", box: { x: 700.2, y: 780, w: 600, h: 90 } },
      { selector: ".conversation", name: "chat stage", box: { x: 300, y: 48, w: 1140, h: 852 } },
      { selector: ".sidebar", name: "sidebar", box: { x: 0, y: 0, w: 300, h: 900 } },
    ],
    rules: [
      { selector: ".sidebar", matched: 1, visible: 1, regions: [".sidebar"] },
      { selector: ".chat-stage::before", matched: 0, visible: 0, regions: [], pseudo: "before" },
    ],
    decorations: [],
    effects: [{ effect: "aurora", kind: "backdrop", rendered: true, opacity: 0.4, covered: 0.3, coveredBy: [".composer-zone"], byRegion: { ".sidebar": 1, ".composer-zone": 0.123 } }],
    customCss: "on",
    ...overrides,
  };
}

test("report shape: rounded boxes, problems first, did-you-mean, compact JSON", () => {
  const report = buildLayoutReport(facts(), KNOWN);
  assert.deepEqual(report.window, { w: 1440, h: 900 });
  assert.deepEqual(report.regions[0], { region: ".composer", name: "composer", x: 700, y: 780, w: 600, h: 90 });
  assert.equal(report.selectors[0].selector, ".chat-stage::before");
  assert.equal(report.selectors[0].matched, 0);
  assert.equal(report.selectors[0].didYouMean[0], ".conversation");
  assert.match(report.selectors[0].note, /matches nothing/);
  assert.deepEqual(report.selectors[1], { selector: ".sidebar", matched: 1, in: [".sidebar"] });
  assert.equal(report.effects[0].visible, "partly");
  assert.deepEqual(report.effects[0].byRegion, { ".composer-zone": 0.12, ".sidebar": 1 });
  assert.equal(report.omitted, undefined);
  // Deterministic.
  assert.equal(JSON.stringify(buildLayoutReport(facts(), KNOWN)), JSON.stringify(report));
  assert.ok(JSON.stringify(report).length < 1_500);
});

test("report caps every list and truncates long selectors", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ selector: `.x${i} ${"y".repeat(300)}`, matched: i % 2, visible: i % 2, regions: [] }));
  const report = buildLayoutReport(facts({ rules: many }), KNOWN);
  assert.equal(report.selectors.length, REPORT_LIMITS.selectors);
  assert.ok(report.selectors.every((entry) => entry.selector.length <= REPORT_LIMITS.text));
  assert.equal(report.omitted, 40 - REPORT_LIMITS.selectors);
  assert.ok(JSON.stringify(report).length < 8_000);
});

test("notes: customCss off, reduced motion; no user content fields", () => {
  const report = buildLayoutReport(facts({ rules: [], customCss: "off", effects: [], motion: { reducedMotion: true } }), KNOWN);
  assert.equal(report.selectors, undefined);
  assert.match(report.notes[0], /switched off/);
  assert.match(report.notes[1], /reduce motion/);
  const keys = new Set();
  const walk = (value) => { if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { keys.add(key); walk(inner); } };
  walk(buildLayoutReport(facts(), KNOWN));
  for (const key of keys) assert.ok(!/text|title|file|content|message/i.test(key), key);
});

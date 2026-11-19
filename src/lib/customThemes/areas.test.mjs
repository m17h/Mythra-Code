// Region-scoped effects (area), weather particles (shape, angle), the
// composer band fix and the UI map in the design kit.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setBaseTokenReader } from "./baseTokens.ts";
import { tokensCssReader } from "./testing/tokensCssReader.mjs";
import { compileThemeCss, EFFECT_HOOKS, TIMELINE_FADE_PX } from "./compile.ts";
import { normalizeThemeInput, resolveTheme } from "./validate.ts";
import { EFFECTS, PARTICLE_DEFAULT_COUNT, PARTICLE_LIMITS, PARTICLE_SPEED_PX, areaCovers, clampEffectParams, effectArea, effectPaints, normalizeEffects, resolveEffectParams } from "./effects.ts";
import { buildDesignKit, UI_MAP } from "./designKit.ts";
import { THEME_DESIGN_GUIDE } from "./designGuide.ts";

setBaseTokenReader(tokensCssReader);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../..");
const ID = "ct_abcdefghij";
const SCOPE = `:root .app-shell[data-theme][data-color-scheme][data-custom-theme="${ID}"]`;
const create = (input) => normalizeThemeInput(input, { mode: "create" });
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.errors)); return result; };
const theme = (extra = {}) => ({ name: "Storm", base: "mythra", tokens: { bg: "#0f131b", text: "#e2e8f2", accent: "#8ab8ff" }, ...extra });
const compile = (spec) => compileThemeCss(spec, { id: ID, scope: "app", platform: "mac" });
const palette = { scheme: "dark", bg: { r: 0.06, g: 0.07, b: 0.1, a: 1 }, text: { r: 0.9, g: 0.9, b: 0.95, a: 1 }, accent: { r: 0.5, g: 0.7, b: 1, a: 1 }, fill: { r: 0.5, g: 0.7, b: 1, a: 1 }, onAccent: { r: 0, g: 0, b: 0, a: 1 }, info: { r: 0.4, g: 0.6, b: 1, a: 1 }, success: { r: 0.3, g: 0.8, b: 0.5, a: 1 }, danger: { r: 0.9, g: 0.3, b: 0.3, a: 1 }, warning: { r: 0.9, g: 0.6, b: 0.2, a: 1 } };

// ---- area ------------------------------------------------------------------------

test("every backdrop and texture effect takes area; accent effects do not", () => {
  for (const def of Object.values(EFFECTS)) {
    const has = Boolean(def.params.area);
    assert.equal(has, def.group !== "accent", def.type);
    if (has) {
      assert.deepEqual([...def.params.area.values], ["window", "chat", "sidebar"]);
      assert.equal(def.params.area.default, "window");
    }
  }
  const bad = normalizeEffects({ glow: { area: "chat" } });
  assert.match(bad.issues.map((i) => i.message).join("\n"), /glow has no param `area`/);
});

test("area defaults to window and rejects unknown values with a hint", () => {
  assert.equal(resolveEffectParams("mesh", {}, palette).area, "window");
  assert.equal(effectArea(undefined), "window");
  assert.equal(effectArea({ area: "chat" }), "chat");
  const wrong = clampEffectParams("mesh", { area: "chatt" });
  assert.match(wrong.issues[0].message, /Use one of window, chat, sidebar.*chat/);
});

test("areaCovers: window covers both sides, chat and sidebar only their own", () => {
  assert.equal(areaCovers("window", "chat"), true);
  assert.equal(areaCovers("window", "sidebar"), true);
  assert.equal(areaCovers("chat", "chat"), true);
  assert.equal(areaCovers("chat", "sidebar"), false);
  assert.equal(areaCovers("sidebar", "sidebar"), true);
  assert.equal(areaCovers("sidebar", "chat"), false);
});

test("effect paints carry their area", () => {
  const paints = effectPaints({ mesh: { area: "chat" }, vignette: {}, grain: { area: "sidebar" } }, palette);
  assert.ok(paints.filter((p) => p.effect === "mesh").every((p) => p.area === "chat"));
  assert.ok(paints.filter((p) => p.effect === "vignette").every((p) => p.area === "window"));
  assert.ok(paints.filter((p) => p.effect === "grain").every((p) => p.area === "sidebar" && p.layer === "front"));
});

test("the contrast check composites an effect only behind the surfaces it covers", () => {
  const effects = (area) => ({ aurora: { colors: ["#4a5f8a", "#6d7fa8"], intensity: 0.5, area } });
  const names = (list) => list.map((c) => c).length;
  const windowed = resolveTheme(ok(create(theme({ surfaces: { translucency: 0.15 }, effects: effects(undefined) }))).spec);
  const chat = resolveTheme(ok(create(theme({ surfaces: { translucency: 0.15 }, effects: effects("chat") }))).spec);
  const side = resolveTheme(ok(create(theme({ surfaces: { translucency: 0.15 }, effects: effects("sidebar") }))).spec);
  // window: plain + 2 aurora colours behind both sides.
  assert.equal(names(windowed.surfaces.bg), 3);
  assert.equal(names(windowed.surfaces.sidebar), 3);
  assert.equal(names(windowed.surfaces.topbar), 3);
  // chat: the sidebar is only checked over the plain window.
  assert.equal(names(chat.surfaces.bg), 3);
  assert.equal(names(chat.surfaces.topbar), 3);
  assert.equal(names(chat.surfaces.sidebar), 1);
  // sidebar: the chat side is only checked over the plain window.
  assert.equal(names(side.surfaces.bg), 1);
  assert.equal(names(side.surfaces.topbar), 1);
  assert.equal(names(side.surfaces.sidebar), 3);
});

test("a bright chat-only effect is reported against the chat surfaces, never the sidebar", () => {
  const bright = theme({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#8f899c" }, surfaces: { translucency: 0.2 }, effects: { aurora: { colors: ["#f8f8ff", "#fff1c0"], intensity: 1, area: "chat" } } });
  const result = create(bright);
  const text = result.ok ? result.adjustments.map((a) => a.reason).join("\n") : result.errors.map((e) => e.message).join("\n");
  assert.match(text, /seen over the aurora/);
  assert.doesNotMatch(text, /sidebar seen over the aurora/);
});

test("themes without area resolve exactly as before (window)", () => {
  const base = theme({ surfaces: { translucency: 0.12 }, effects: { mesh: { intensity: 0.4 }, particles: { count: 20 }, vignette: { strength: 0.3 } } });
  const explicit = theme({ surfaces: { translucency: 0.12 }, effects: { mesh: { intensity: 0.4, area: "window" }, particles: { count: 20, area: "window" }, vignette: { strength: 0.3, area: "window" } } });
  const a = resolveTheme(ok(create(base)).spec);
  const b = resolveTheme(ok(create(explicit)).spec);
  assert.deepEqual(a.palette, b.palette);
  for (const key of Object.keys(a.surfaces)) assert.deepEqual(a.surfaces[key], b.surfaces[key], key);
});

// ---- particles: shape, angle, counts ------------------------------------------------

test("particles: shape and angle are validated; streaks may go up to the streak cap", () => {
  const def = EFFECTS.particles.params;
  assert.deepEqual([...def.shape.values], ["dot", "streak", "flake", "petal"]);
  assert.equal(def.shape.default, "dot");
  assert.equal(def.angle.min, -30);
  assert.equal(def.angle.max, 30);
  const rain = clampEffectParams("particles", { shape: "streak", count: 150, angle: 12 });
  assert.deepEqual(rain.issues, []);
  assert.deepEqual(rain.warnings, []);
  assert.equal(rain.params.count, 150);
  const tooMany = clampEffectParams("particles", { shape: "streak", count: 400 });
  assert.equal(tooMany.params.count, PARTICLE_LIMITS.maxStreaks);
  const windy = clampEffectParams("particles", { angle: 55 });
  assert.equal(windy.params.angle, 30);
  assert.match(windy.warnings.join("\n"), /angle: 55 is outside -30–30; used 30/);
  assert.match(clampEffectParams("particles", { shape: "drop" }).issues[0].message, /Use one of dot, streak, flake, petal/);
});

test("particles: dots, flakes and petals keep the old caps", () => {
  for (const shape of ["dot", "flake", "petal"]) {
    const r = clampEffectParams("particles", { shape, count: 120 });
    assert.equal(r.params.count, PARTICLE_LIMITS.max, shape);
    assert.match(r.warnings.join("\n"), /too heavy; used 60/, shape);
  }
  assert.equal(clampEffectParams("particles", { count: 120 }).params.count, 60, "no shape = dot");
  assert.equal(clampEffectParams("particles", { links: true, count: 55 }).params.count, 40);
  // links only thin dots; a flake with links keeps the normal cap.
  assert.equal(clampEffectParams("particles", { shape: "flake", links: true, count: 55 }).params.count, 55);
});

test("particles: defaults follow the shape (rain falls, many streaks), dots stay as before", () => {
  const dot = resolveEffectParams("particles", {}, palette);
  assert.equal(dot.shape, "dot");
  assert.equal(dot.count, 24);
  assert.equal(dot.direction, "rise");
  assert.equal(dot.angle, 0);
  const rain = resolveEffectParams("particles", { shape: "streak" }, palette);
  assert.equal(rain.count, PARTICLE_DEFAULT_COUNT.streak);
  assert.equal(rain.direction, "fall");
  const snowUp = resolveEffectParams("particles", { shape: "flake", direction: "rise", count: 12 }, palette);
  assert.equal(snowUp.direction, "rise");
  assert.equal(snowUp.count, 12);
});

test("particles: streaks fall at rain speed, far faster than dots; still is still", () => {
  for (const shape of Object.keys(PARTICLE_SPEED_PX)) assert.equal(PARTICLE_SPEED_PX[shape].still, 0, shape);
  assert.ok(PARTICLE_SPEED_PX.streak.slow >= 10 * PARTICLE_SPEED_PX.dot.lively);
  assert.ok(PARTICLE_SPEED_PX.streak.lively > PARTICLE_SPEED_PX.streak.medium && PARTICLE_SPEED_PX.streak.medium > PARTICLE_SPEED_PX.streak.slow);
});

test("a storm theme made only with curated tools validates and compiles", () => {
  const storm = ok(create(theme({
    surfaces: { translucency: 0.16 },
    effects: {
      particles: { shape: "streak", area: "chat", colors: ["#9fb3cc", "#c9d6e6"], count: 110, size: [1, 2], speed: "medium", angle: 12 },
      mesh: { colors: ["#1d2536", "#2b3350", "#1a2030", "#33405e"], intensity: 0.4 },
      vignette: { strength: 0.45 },
    },
  })));
  assert.deepEqual(storm.warnings, []);
  assert.equal(storm.spec.effects.particles.area, "chat");
  const out = compile(storm.spec);
  assert.deepEqual(out.effectTypes, ["mesh", "particles", "vignette"]);
  assert.equal(out.hasMotion, true);
});

// ---- the composer band -----------------------------------------------------------------

test("see-through themes clear the composer zone and fade the list with a mask", () => {
  const out = compile(ok(create(theme({ surfaces: { translucency: 0.12 }, effects: { mesh: {} } }))).spec);
  assert.ok(out.tokenCss.includes(`${SCOPE} ${EFFECT_HOOKS.composerZone} { background: none; }`));
  assert.ok(out.tokenCss.includes(`${SCOPE} ${EFFECT_HOOKS.timelineFade} { content: none; }`));
  assert.ok(out.tokenCss.includes(`${SCOPE} ${EFFECT_HOOKS.timelineScroller} { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - ${TIMELINE_FADE_PX}px), transparent); mask-image:`));
});

test("opaque themes without customCss keep the built-in fades untouched", () => {
  const out = compile(ok(create(theme())).spec);
  assert.ok(!out.tokenCss.includes(EFFECT_HOOKS.composerZone));
  assert.ok(!out.tokenCss.includes(".timeline-shell"));
  assert.ok(!out.tokenCss.includes(".thread-empty-state"));
});

test("customCss decorations get the band fix and positioned landing screens", () => {
  const out = compile(ok(create(theme({ customCss: ".conversation::before { content: \"\"; position: absolute; inset: 0; z-index: 0; background-image: linear-gradient(var(--accent-soft), transparent); }" }))).spec);
  assert.ok(out.tokenCss.includes(`${SCOPE} ${EFFECT_HOOKS.composerZone} { background: none; }`));
  assert.ok(out.tokenCss.includes(`${SCOPE} .welcome-screen, ${SCOPE} .thread-empty-state { position: relative; }`));
});

test("the 28px fade in composer.css and compile.ts stay in step", () => {
  const css = readFileSync(path.join(src, "styles/lumen/composer.css"), "utf8");
  const rule = css.slice(css.indexOf(".timeline-shell::after {"));
  assert.match(rule.slice(0, rule.indexOf("}")), new RegExp(`height: ${TIMELINE_FADE_PX}px;`));
});

// ---- the UI map ------------------------------------------------------------------------

function filesUnder(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, ext, out);
    else if (name.endsWith(ext) && !name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

test("every class the UI map names exists in the app's markup and styles", () => {
  const tsx = filesUnder(src, ".tsx").map((file) => readFileSync(file, "utf8")).join("\n");
  const css = filesUnder(src, ".css").map((file) => readFileSync(file, "utf8")).join("\n");
  const texts = [
    ...UI_MAP.regions.flatMap((r) => [r.selector, r.contains, r.decorate, r.tokens]),
    ...UI_MAP.recipes.map((r) => r.css),
    ...UI_MAP.selectors.map((s) => s.selector),
  ];
  const classes = new Set(texts.flatMap((text) => [...text.matchAll(/(?<![\w-])\.([a-z][a-z0-9-]+)/g)].map((m) => m[1])));
  // Composed at runtime from message.role / state.
  const dynamic = new Set(["user", "assistant", "active", "open"]);
  assert.ok(classes.size > 25, `found ${classes.size}`);
  for (const name of classes) {
    if (dynamic.has(name)) continue;
    const word = new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`);
    assert.ok(word.test(tsx), `.${name} is not in any component's markup`);
    assert.ok(css.includes(`.${name}`), `.${name} has no styles`);
  }
});

test("every custom property the UI map names is a real token", () => {
  const css = filesUnder(path.join(src, "styles"), ".css").map((file) => readFileSync(file, "utf8")).join("\n") + readFileSync(path.join(src, "styles.css"), "utf8");
  const text = JSON.stringify(UI_MAP);
  const vars = new Set([...text.matchAll(/--[a-z][a-z0-9-]+/g)].map((m) => m[0]));
  for (const name of vars) assert.ok(css.includes(`${name}:`), `${name} is not defined in the styles`);
});

test("the kit serves the map, documents area and weather shapes, and the guide points at it", () => {
  const kit = buildDesignKit();
  assert.equal(kit.regions, UI_MAP);
  const names = kit.regions.regions.map((r) => r.selector);
  for (const selector of [".sidebar", ".main-panel", ".topbar", ".conversation", ".composer-zone", ".studio-dock"]) assert.ok(names.includes(selector), selector);
  assert.match(JSON.stringify(kit.regions), /Tools panel/);
  assert.doesNotMatch(JSON.stringify(kit.regions), /Workspace panel|workspace panel/);
  const particles = kit.effects.catalog.find((e) => e.type === "particles");
  assert.match(particles.params.shape, /streak/);
  assert.match(particles.params.angle, /−30…30|-30/);
  assert.match(particles.params.area, /chat/);
  assert.match(kit.customCss.summary, /regions/);
  assert.ok(kit.examples.some((e) => e.spec.effects?.particles?.shape === "streak" && e.spec.effects.particles.area === "chat" && !e.spec.customCss));
  assert.ok(kit.examples.some((e) => e.spec.effects?.particles?.shape === "petal"));
  for (const example of kit.examples) ok(create(example.spec));
  assert.ok(THEME_DESIGN_GUIDE.customCss.some((line) => /regions map/.test(line)));
  assert.ok(THEME_DESIGN_GUIDE.motion.some((line) => /area:/.test(line)));
});

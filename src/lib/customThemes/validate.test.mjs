import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setBaseTokenReader } from "./baseTokens.ts";
import { tokensCssReader } from "./testing/tokensCssReader.mjs";
import { contrastRatio, parseColor, oklchLightness, rgbToOklch } from "./color.ts";
import { applyThemePatch, diffThemeSpecs, normalizeThemeInput, resolveTheme, themeSwatches } from "./validate.ts";
import { THEME_LIMITS } from "./spec.ts";

setBaseTokenReader(tokensCssReader);
const here = path.dirname(fileURLToPath(import.meta.url));
const create = (input) => normalizeThemeInput(input, { mode: "create" });
const minimal = (extra = {}) => ({ name: "Nebula", base: "mythra", tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff" }, ...extra });
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result.errors)); return result; };
const fail = (result) => { assert.equal(result.ok, false, "expected a validation error"); return result.errors; };
const messages = (errors) => errors.map((e) => `${e.path}: ${e.message}`).join("\n");

test("the base reader sees the real tokens.css values", () => {
  const mythra = tokensCssReader("mythra");
  assert.equal(mythra["--bg"], "#212226");
  assert.equal(mythra["--accent"], "#64ddf2");
  const light = tokensCssReader("light-mythra");
  assert.equal(light["--bg"], "#ffffff");
  assert.equal(light["--lm-on-danger"], "#ffffff");
  assert.equal(tokensCssReader("synthwave")["--bg"], "#1e1630");
});

test("a minimal theme normalizes with defaults filled", () => {
  const { spec, warnings } = ok(create(minimal()));
  assert.equal(spec.schema, "mythra.theme/1");
  assert.equal(spec.shape, "standard");
  assert.equal(spec.elevation, "soft");
  assert.deepEqual(spec.surfaces, { translucency: 0 });
  assert.deepEqual(spec.motion, { enabled: true });
  assert.equal(spec.customCss, "");
  assert.equal(spec.description, "");
  assert.deepEqual(warnings, []);
});

test("normalizing a normalized spec is a no-op (stored specs revalidate cleanly)", () => {
  for (const input of [minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#6f6a80" } }), JSON.parse(readFileSync(path.join(here, "examples/neon-drive.json"), "utf8"))]) {
    const first = ok(create(input));
    const second = ok(create(first.spec));
    assert.deepEqual(second.spec, first.spec);
    assert.deepEqual(second.adjustments.filter((a) => !/derived or inherited/.test(a.reason)), []);
  }
});

test("required fields are enforced on create", () => {
  const errors = fail(create({ base: "mythra", tokens: {} }));
  const paths = errors.map((e) => e.path);
  for (const required of ["name", "tokens.bg", "tokens.text", "tokens.accent"]) assert.ok(paths.includes(required), required);
  assert.ok(fail(create({ name: "x", tokens: { bg: "#000", text: "#fff", accent: "#0ff" } })).some((e) => e.path === "base"));
});

test("unknown keys get actionable did-you-mean errors", () => {
  const top = fail(create({ ...minimal(), colours: {} }));
  assert.match(messages(top), /Unknown key `colours`/);
  const token = fail(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", mutedText: "#999999" } })));
  assert.match(messages(token), /`mutedText` is not a token\. Did you mean `muted`\?/);
  const syntax = fail(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", syntax: { keywrd: "#ff00ff" } } })));
  assert.match(messages(syntax), /Did you mean `keyword`\?/);
  const base = fail(create({ ...minimal(), base: "mythr" }));
  assert.match(messages(base), /Did you mean `mythra`\?/);
  const effect = fail(create(minimal({ effects: { auroraa: {} } })));
  assert.match(messages(effect), /Did you mean `aurora`\?/);
  const param = fail(create(minimal({ effects: { aurora: { intesity: 0.3 } } })));
  assert.match(messages(param), /Did you mean `intensity`\?/);
});

test("colours are parsed and normalized; bad colours are rejected", () => {
  const { spec } = ok(create(minimal({ tokens: { bg: "rgb(22, 19, 31)", text: "hsl(255, 40%, 94%)", accent: "#B794FF" } })));
  assert.equal(spec.tokens.bg, "#16131f");
  assert.equal(spec.tokens.accent, "#b794ff");
  assert.match(messages(fail(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "blueish" } })))), /not a colour/);
});

test("surfaces and inks must be opaque; tints and lines may be translucent", () => {
  assert.match(messages(fail(create(minimal({ tokens: { bg: "rgba(22, 19, 31, 0.5)", text: "#ece8f6", accent: "#b794ff" } })))), /must be opaque; use `surfaces.translucency`/);
  assert.match(messages(fail(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f680", accent: "#b794ff" } })))), /opaque/);
  ok(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", line: "rgba(255,255,255,.1)", hover: "rgba(255,255,255,.04)", accentSoft: "rgba(183,148,255,.15)" } })));
});

test("bg must agree with the base scheme", () => {
  const darkBase = fail(create({ name: "x", base: "mythra", tokens: { bg: "#f4f4f4", text: "#111111", accent: "#0050a0" } }));
  assert.match(messages(darkBase), /`bg` is light \(L=0\.9\d\) but base `mythra` is a dark theme\. Use base `light-mythra`, `daylight`, `atari`/);
  const lightBase = fail(create({ name: "x", base: "daylight", tokens: { bg: "#151515", text: "#eeeeee", accent: "#7ad" } }));
  assert.match(messages(lightBase), /`bg` is dark .* base `daylight` is a light theme/);
  ok(create({ name: "Paper", base: "atari", tokens: { bg: "#f7f2e8", text: "#2a231b", accent: "#a5441f" } }));
});

test("failing inks are nudged along lightness only and reported", () => {
  const result = ok(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#7d7787" } })));
  const fix = result.adjustments.find((a) => a.token === "muted");
  assert.ok(fix, "muted was adjusted");
  assert.equal(fix.from, "#7d7787");
  assert.notEqual(fix.to, "#7d7787");
  assert.match(fix.reason, /^4\.5:1 on .* \(was \d+(\.\d)?:1\)$/);
  assert.equal(result.spec.tokens.muted, fix.to, "the stored spec carries the fixed value");
  const before = rgbToOklch(parseColor(fix.from)), after = rgbToOklch(parseColor(fix.to));
  assert.ok(after.l > before.l, "moved lighter on a dark theme");
  assert.ok(Math.abs(after.h - before.h) < 4, "hue kept");
  assert.ok(Math.abs(after.l - before.l) <= 0.15 + 1e-6, "within the bound");
});

test("an ink that can't be fixed within the bound is rejected with advice", () => {
  const errors = fail(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#3a3545" } })));
  const message = messages(errors);
  assert.match(message, /tokens\.muted: muted \(#3a3545\) can't reach 4\.5:1 on /);
  assert.match(message, /An ink like #[0-9a-f]{6} would pass\./);
});

test("surfaces are never moved by the auto-fix", () => {
  const input = minimal({ tokens: { bg: "#16131f", sidebar: "#1b1726", panel: "#201b2d", text: "#ece8f6", accent: "#b794ff", muted: "#7d7787" } });
  const { spec } = ok(create(input));
  for (const key of ["bg", "sidebar", "panel"]) assert.equal(spec.tokens[key], input.tokens[key]);
});

test("every resolved text pair meets 4.5:1 after normalization", () => {
  for (const file of readdirSync(path.join(here, "examples"))) {
    const { spec } = ok(create(JSON.parse(readFileSync(path.join(here, "examples", file), "utf8"))));
    const { palette, surfaces } = resolveTheme(spec);
    for (const ink of ["text", "readingInk", "ink2"]) {
      for (const name of ["bg", "sidebar", "panel", "panel2", "menu", "field", "bubble"]) {
        for (const surface of surfaces[name]) assert.ok(contrastRatio(palette[ink], surface) >= 4.5, `${file} ${ink} on ${name}`);
      }
    }
    for (const name of ["bg", "sidebar", "panel", "menu", "field"]) {
      for (const surface of surfaces[name]) {
        assert.ok(contrastRatio(palette.muted, surface) >= 4.5, `${file} muted on ${name}`);
        assert.ok(contrastRatio(palette.muted2, surface) >= 4.5, `${file} muted2 on ${name}`);
      }
    }
    assert.ok(contrastRatio(palette.onAccent, palette.fill) >= 4.5, `${file} onAccent`);
    for (const key of Object.keys(palette).filter((k) => k.startsWith("syntax."))) assert.ok(contrastRatio(palette[key], palette.codeBg) >= 4.5, `${file} ${key}`);
  }
});

test("translucent surfaces are checked over each backdrop effect colour", () => {
  const bright = minimal({
    tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#8f899c" },
    surfaces: { translucency: 0.2 },
    effects: { aurora: { colors: ["#f8f8ff", "#fff1c0"], intensity: 1 } },
  });
  const result = create(bright);
  if (result.ok) {
    // muted had to move to stay readable over the bright aurora.
    assert.ok(result.adjustments.some((a) => a.token === "muted" && /seen over the aurora/.test(a.reason)), JSON.stringify(result.adjustments));
  } else {
    assert.match(messages(result.errors), /seen over the aurora/);
    assert.match(messages(result.errors), /Lower that effect's intensity or surfaces\.translucency/);
  }
  // Without translucency the same aurora is invisible and not checked.
  const hidden = ok(create({ ...bright, surfaces: { translucency: 0 } }));
  assert.ok(!hidden.adjustments.some((a) => /aurora/.test(a.reason)));
  assert.ok(hidden.warnings.some((w) => /only show through see-through surfaces/.test(w)));
});

test("accentFlow stops must keep onAccent readable", () => {
  const result = create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff" }, effects: { accentFlow: { colors: ["#b794ff", "#202020"] } } }));
  assert.equal(result.ok, false);
  assert.match(messages(result.errors), /onAccent .* accentFlow colour/);
});

test("derived tokens follow the given palette", () => {
  const { palette } = resolveTheme(ok(create(minimal())).spec);
  const bgL = oklchLightness(palette.bg);
  assert.ok(oklchLightness(palette.sidebar) > bgL && oklchLightness(palette.panel) > oklchLightness(palette.sidebar), "dark steps go lighter");
  assert.ok(oklchLightness(palette.panel3) > oklchLightness(palette.panel2));
  assert.ok(palette.topbar.a < 1 && palette.line.a < 0.2, "topbar and lines are translucent");
  assert.ok(contrastRatio(palette.onAccent, palette.fill) >= 4.5);
  const light = resolveTheme(ok(create({ name: "Paper", base: "atari", tokens: { bg: "#f7f2e8", text: "#2a231b", accent: "#a5441f" } })).spec).palette;
  assert.ok(oklchLightness(light.sidebar) < oklchLightness(light.bg), "light steps go darker");
  assert.equal(light.readingInk.r, light.text.r, "reading ink is text on light themes");
});

test("names and descriptions are cleaned and length-limited", () => {
  const { spec, warnings } = ok(create(minimal({ name: "  Neb" + String.fromCharCode(7) + "ula" + String.fromCharCode(0x2028) + "X ".repeat(30), description: "d".repeat(400) })));
  assert.ok(spec.name.length <= 40);
  assert.ok(!/[\x00-\x1f]/.test(spec.name));
  assert.ok(!spec.name.includes(String.fromCharCode(0x2028)));
  assert.ok(spec.description.length <= 160);
  assert.ok(warnings.some((w) => /description: shortened/.test(w)));
  assert.equal(fail(create(minimal({ name: "   " })))[0].path, "name");
});

test("enums, typography and surfaces are validated", () => {
  assert.match(messages(fail(create(minimal({ shape: "round" })))), /shape/);
  assert.match(messages(fail(create(minimal({ typography: { ui: "Comic Sans" } })))), /Only system and bundled fonts/);
  assert.match(messages(fail(create(minimal({ typography: { fontFamily: "x" } })))), /typography has ui, display, mono and chat/);
  const clamped = ok(create(minimal({ surfaces: { translucency: 0.9 } })));
  assert.equal(clamped.spec.surfaces.translucency, 0.2);
  assert.ok(clamped.warnings.some((w) => /translucency/.test(w)));
  ok(create(minimal({ typography: { ui: "rounded", display: "pixel", mono: "terminal", chat: "vt323" } })));
});

test("effect params are clamped, typed and limited per group", () => {
  const clamped = ok(create(minimal({ surfaces: { translucency: 0.1 }, effects: { aurora: { intensity: 3, colors: ["#4d5dff", "#8b5cf6", "#22c7b4", "#ffffff", "#000000"] }, shimmer: { interval: 2 } } })));
  assert.equal(clamped.spec.effects.aurora.intensity, 1);
  assert.equal(clamped.spec.effects.aurora.colors.length, 4);
  assert.equal(clamped.spec.effects.shimmer.interval, 6);
  assert.ok(clamped.warnings.some((w) => /intensity: 3 is outside 0–1/.test(w)));
  assert.match(messages(fail(create(minimal({ effects: { aurora: { speed: "warp" } } })))), /Use one of still, slow, medium, lively/);
  assert.match(messages(fail(create(minimal({ effects: { aurora: { colors: ["#ffffff"] } } })))), /needs 2–4 colours/);
  assert.match(messages(fail(create(minimal({ effects: { glow: { targets: ["everything"] } } })))), /not a target/);
  assert.match(messages(fail(create(minimal({ effects: { aurora: {}, mesh: {}, starfield: {} } })))), /At most 2 backdrop effects/);
  assert.match(messages(fail(create(minimal({ effects: { glow: {}, shimmer: {}, border: {}, accentFlow: {} } })))), /At most 3 accent effects/);
  const particles = ok(create(minimal({ effects: { particles: { count: 60, links: true } } })));
  assert.equal(particles.spec.effects.particles.count, 40);
});

test("customCss is cleaned into the spec; forbidden parts are removed, the rest saves", () => {
  const good = ok(create(minimal({ customCss: ".composer { border-color: var(--accent-line); }" })));
  assert.equal(good.spec.customCss, ".composer { border-color: var(--accent-line); }");
  const dropped = ok(create(minimal({ customCss: ".a { color: var(--text); cursor-thing: 1; }" })));
  assert.ok(dropped.warnings.some((w) => /customCss: dropped/.test(w)));
  const urlRemoved = ok(create(minimal({ customCss: ".a { background-image: url(https://evil.example/x.png); }\n.composer { border-color: var(--accent-line); }" })));
  assert.ok(urlRemoved.warnings.some((w) => /customCss: removed .*url\(\) is not allowed/.test(w)), urlRemoved.warnings.join("\n"));
  assert.doesNotMatch(urlRemoved.spec.customCss, /url\(|evil/);
  assert.match(urlRemoved.spec.customCss, /\.composer \{ border-color: var\(--accent-line\); \}/);
  const hidden = ok(create(minimal({ customCss: ".composer, .send-button { display: none; }" })));
  assert.ok(hidden.warnings.some((w) => /customCss: removed .*display/.test(w)));
  assert.doesNotMatch(hidden.spec.customCss, /display/);
  assert.match(messages(fail(create(minimal({ customCss: "x".repeat(THEME_LIMITS.maxCustomCssBytes + 1) })))), /bytes; the limit is/);
});

test("patches merge tokens and effects and reset with null", () => {
  const base = ok(create(minimal({ tokens: { bg: "#16131f", text: "#ece8f6", accent: "#b794ff", muted: "#a49cb8", syntax: { keyword: "#ff8fd1" } }, surfaces: { translucency: 0.1 }, effects: { aurora: { intensity: 0.3, speed: "slow" } }, typography: { display: "rounded" } }))).spec;
  const patched = ok(applyThemePatch(base, { tokens: { accent: "#8fd3ff", muted: null, syntax: { string: "#f5cf86" } }, effects: { aurora: { intensity: 0.5 }, glow: { targets: ["send"] } }, typography: { ui: "humanist" } })).spec;
  assert.equal(patched.tokens.accent, "#8fd3ff");
  assert.equal(patched.tokens.muted, undefined, "null resets to derived");
  assert.deepEqual(patched.tokens.syntax, { keyword: "#ff8fd1", string: "#f5cf86" });
  assert.deepEqual(patched.effects.aurora, { intensity: 0.5, speed: "slow" }, "params merge");
  assert.deepEqual(patched.effects.glow, { targets: ["send"] });
  assert.deepEqual(patched.typography, { display: "rounded", ui: "humanist" }, "typography merges key by key");
  assert.equal(patched.name, base.name);
  const removed = ok(applyThemePatch(patched, { effects: { aurora: null }, customCss: "" })).spec;
  assert.equal(removed.effects.aurora, undefined);
  assert.deepEqual(diffThemeSpecs(base, patched).sort(), ["effects.aurora.intensity", "effects.glow", "tokens.accent", "tokens.muted", "tokens.syntax.string", "typography.ui"].sort());
});

test("patch errors are prefixed with patch. and empty or unknown patches are refused", () => {
  const base = ok(create(minimal())).spec;
  assert.match(messages(fail(applyThemePatch(base, {}))), /The patch is empty/);
  assert.match(messages(fail(applyThemePatch(base, { colour: "#fff" }))), /patch\.colour: Unknown key/);
  const errors = fail(applyThemePatch(base, { tokens: { mutedText: "#fff" } }));
  assert.equal(errors[0].path, "patch.tokens.mutedText");
  assert.match(messages(fail(applyThemePatch(base, { base: "light-mythra" }))), /`bg` is dark/);
});

test("the spec size limit is enforced and swatches resolve", () => {
  const big = { ...minimal(), customCss: Array.from({ length: 150 }, (_, i) => `.c${i} { border-color: var(--line); }`).join("\n") };
  ok(create(big));
  const [canvas, panel, accent] = themeSwatches(ok(create(minimal())).spec);
  assert.equal(canvas, "#16131f");
  assert.match(panel, /^#[0-9a-f]{6}$/);
  assert.equal(accent, "#b794ff");
});

test("the example themes are valid", () => {
  const files = readdirSync(path.join(here, "examples")).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 4);
  for (const file of files) ok(create(JSON.parse(readFileSync(path.join(here, "examples", file), "utf8"))));
});

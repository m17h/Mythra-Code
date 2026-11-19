import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setBaseTokenReader } from "./baseTokens.ts";
import { tokensCssReader } from "./testing/tokensCssReader.mjs";
import { compileThemeCss, themeVariables } from "./compile.ts";
import { normalizeThemeInput, resolveTheme } from "./validate.ts";
import { EFFECTS, starLayers, STAR_TILE } from "./effects.ts";
import { buildDesignKit } from "./designKit.ts";
import { EFFECT_TYPES, KIT_TOKENS, seeThroughAlpha } from "./spec.ts";

setBaseTokenReader(tokensCssReader);
const here = path.dirname(fileURLToPath(import.meta.url));
const ID = "ct_abcdefghij";
const example = (name) => normalizeThemeInput(JSON.parse(readFileSync(path.join(here, "examples", `${name}.json`), "utf8")), { mode: "create" }).spec;
const compile = (spec, extra = {}) => compileThemeCss(spec, { id: ID, scope: "app", platform: "mac", ...extra });
const SCOPE = `:root .app-shell[data-theme][data-color-scheme][data-custom-theme="${ID}"]`;

test("the token block uses the (0,5,0) selector and sets every kit variable", () => {
  const out = compile(example("aurora-night"));
  assert.ok(out.tokenCss.startsWith(`${SCOPE} {`));
  for (const token of KIT_TOKENS) {
    if (token.key === "shadowTint") continue;
    assert.ok(out.tokenCss.includes(`  ${token.cssVar}: `), token.cssVar);
  }
  for (const name of ["--red-soft", "--success-soft", "--r-xl", "--lm-pop-shadow", "--lm-composer-shadow"]) assert.ok(out.tokenCss.includes(`  ${name}: `), name);
  assert.equal(out.scheme, "dark");
  assert.deepEqual(out.effectTypes, ["aurora", "glow"]);
  assert.equal(out.hasMotion, true);
});

test("no animation in compiled CSS escapes the motion gates", () => {
  for (const name of ["aurora-night", "neon-drive", "deep-field", "paper"]) {
    const css = compile(example(name)).css;
    const lines = css.split("\n");
    let inGate = false;
    for (const line of lines) {
      if (line.startsWith("@media (prefers-reduced-motion: no-preference)")) inGate = true;
      else if (line === "}") inGate = false;
      if (/\banimation:/.test(line)) {
        assert.ok(inGate || line.startsWith("@media (prefers-reduced-motion: no-preference)"), `${name}: ungated animation: ${line}`);
        assert.ok(line.includes('[data-theme-motion="on"]'), `${name}: animation without data-theme-motion: ${line}`);
      }
    }
    // Nothing animates custom properties on the shell itself.
    assert.ok(!/@keyframes[^{]*\{[^}]*--(?!ct-fx-angle)/.test(css), `${name}: custom property keyframes`);
  }
});

test("translucency only makes the window background and sidebar see-through", () => {
  const spec = example("aurora-night");
  const css = compile(spec).tokenCss;
  const alpha = (1 - seeThroughAlpha(spec.surfaces.translucency)).toFixed(2).replace(/0+$/, "");
  assert.match(css, new RegExp(`${SCOPE.replace(/[[\]().*"]/g, "\\$&")} \\.main-panel \\{ background-color: rgba\\([^)]*, ${alpha}\\)`));
  assert.match(css, /\.sidebar \{ background-color: rgba\(/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.ok(!/\.(composer|menu|studio-dock|settings)[^{]*\{ background-color: rgba/.test(css), "panels stay solid");
  const solid = compile(example("paper")).tokenCss;
  assert.ok(!solid.includes(".main-panel {"), "no see-through rules without translucency");
});

test("customCss is compiled separately and can be disabled", () => {
  const spec = example("paper");
  const on = compile(spec);
  assert.ok(on.customCss.includes(`${SCOPE} .thread-empty-state h1 { letter-spacing: -0.01em; }`), on.customCss);
  assert.ok(on.css.includes(on.customCss));
  const off = compile(spec, { customCssEnabled: false });
  assert.equal(off.customCss, "");
  assert.equal(off.css, off.tokenCss);
});

test("Windows dark themes ease their inks when contrast allows", () => {
  const spec = example("deep-field");
  const mac = themeVariables(spec, resolveTheme(spec));
  const win = compile(spec, { platform: "windows" }).tokenCss;
  const text = /\n {2}--text: (#[0-9a-f]{6});/g;
  const values = [...win.matchAll(text)].map((m) => m[1]);
  assert.equal(values.length, 1);
  assert.notEqual(values[0], mac["--text"], "--text is eased on Windows");
  const macCss = compile(spec).tokenCss;
  assert.equal([...macCss.matchAll(text)][0][1], mac["--text"]);
  assert.ok(!compile(example("paper"), { platform: "windows" }).tokenCss.match(text)?.[1], "light themes are not eased");
});

test("preview scope is the app stylesheet, rescoped to the replica's shell only", () => {
  const spec = { ...example("neon-drive"), customCss: ".sidebar { border-right: 1px solid var(--accent); }\n@keyframes pulse { from { opacity: .6; } to { opacity: 1; } }\n.conversation::before { content: \"\"; position: absolute; inset: 0; z-index: 0; animation: pulse 4s ease-in-out infinite alternate; }" };
  const app = compileThemeCss(spec, { id: ID, scope: "app", platform: "other" });
  const out = compileThemeCss(spec, { id: ID, scope: "preview", platform: "other" });
  const replica = `.app-shell[data-theme][data-color-scheme][data-custom-theme="${ID}"][data-ct-replica]`;
  // Nothing the real app's shell can match: every rule needs [data-ct-replica].
  assert.ok(!out.css.includes(":root"), "no rule is left on the real shell's scope");
  assert.ok(out.tokenCss.startsWith(`${replica} {`));
  for (const line of out.css.split("\n")) {
    if (/^\s*(@|\}|$|--|\/\*)/.test(line) || !line.includes("{") || line.trim().startsWith("from") || line.trim().startsWith("to")) continue;
    assert.ok(line.includes("[data-ct-replica]"), `unscoped rule: ${line.slice(0, 120)}`);
  }
  // Same rules otherwise: tokens, effects and customCss with its motion gate.
  assert.equal(out.tokenCss, app.tokenCss.split(`:root .app-shell[data-theme][data-color-scheme][data-custom-theme="${ID}"]`).join(replica));
  assert.ok(out.customCss.includes(`${replica} .sidebar`));
  assert.ok(out.customCss.includes(`${replica}[data-theme-motion="on"] .conversation::before`));
  assert.equal(out.hasMotion, app.hasMotion);
  assert.equal(compileThemeCss(spec, { id: ID, scope: "preview", platform: "other", customCssEnabled: false }).customCss, "", "customCss can be left out, as in the app");
});

test("shape and elevation map to radii and shadows", () => {
  const crisp = compile(example("neon-drive")).tokenCss;
  assert.ok(crisp.includes("--r-xl: 8px;"));
  const soft = compile(example("aurora-night")).tokenCss;
  assert.ok(soft.includes("--r-xl: 16px;"));
  assert.ok(!soft.includes("--r-pill"), "the pill radius is never themed");
});

test("typography: chat font is only a suggestion; terminal mono only on code blocks", () => {
  const paper = compile(example("paper")).tokenCss;
  assert.ok(paper.includes(`${SCOPE}[data-chat-font="system"] { --chat-font: var(--chat-font-serif); }`));
  assert.ok(paper.includes("--font-display: "));
  const spec = normalizeThemeInput({ name: "T", base: "mythra", tokens: { bg: "#101010", text: "#eeeeee", accent: "#77ddaa" }, typography: { mono: "terminal" } }, { mode: "create" }).spec;
  assert.match(compile(spec).tokenCss, /\.rich-markdown pre \{|\.rich-markdown pre, /);
});

test("every effect has a schema, a group and docs; the starfield is deterministic and tiles", () => {
  assert.deepEqual(Object.keys(EFFECTS).sort(), [...EFFECT_TYPES].sort());
  assert.equal(EFFECT_TYPES.length, 12);
  for (const def of Object.values(EFFECTS)) {
    assert.ok(["backdrop", "texture", "accent"].includes(def.group));
    assert.ok(def.doc.length > 20);
  }
  const a = starLayers("ct_abcdefghij", "normal");
  assert.deepEqual(a, starLayers("ct_abcdefghij", "normal"));
  assert.notDeepEqual(a, starLayers("ct_zzzzzzzzzz", "normal"));
  const first = a[2].split(", ").slice(0, 4).map((s) => s.split(" ").slice(0, 2).map(parseFloat));
  assert.deepEqual([first[1][0] - first[0][0], first[1][1] - first[0][1]], [0, STAR_TILE.height]);
  assert.deepEqual([first[2][0] - first[0][0], first[2][1] - first[0][1]], [STAR_TILE.width, 0]);
  assert.ok(!a.join("").includes("#"), "stars use currentColor unless an accent is given");
});

test("the design kit is JSON-serializable and documents tokens, effects and rules", () => {
  const kit = buildDesignKit();
  const json = JSON.stringify(kit);
  assert.ok(json.length > 4000);
  assert.equal(kit.tokens.length, KIT_TOKENS.length);
  assert.equal(kit.tokens.find((t) => t.key === "bg").dark, "#212226");
  assert.equal(kit.tokens.find((t) => t.key === "bg").light, "#ffffff");
  assert.equal(kit.effects.catalog.length, 12);
  assert.deepEqual(kit.required, ["name", "base", "tokens.bg", "tokens.text", "tokens.accent"]);
  assert.ok(kit.customCss.denied.some((line) => line.includes("url()")));
});

test("the shimmer sweep always covers the whole target (clipped title text never disappears)", () => {
  const spec = normalizeThemeInput({ name: "S", base: "mythra", tokens: { bg: "#101010", text: "#eeeeee", accent: "#77ddaa" }, effects: { shimmer: { targets: ["landingTitle", "primary"], interval: 8 } } }, { mode: "create" }).spec;
  const css = compile(spec).css;
  // With background-size S% (S >= 200) a position between 0% and 100% keeps the image over the box.
  for (const match of css.matchAll(/background-size: (\d+)% 100%/g)) assert.ok(Number(match[1]) >= 200);
  for (const match of css.matchAll(/background-position: (-?\d+)% 0/g)) assert.ok(Number(match[1]) >= 0 && Number(match[1]) <= 100, match[0]);
  assert.match(css, /\.thread-empty-state h1 \{ background-image: linear-gradient\(100deg, var\(--text\) 40%/);
});

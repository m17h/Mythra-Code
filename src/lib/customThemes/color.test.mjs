import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustLightnessToContrast, composite, contrastRatio, formatColor, mixColors, normalizeColor, oklchLightness, oklchToRgb, parseColor,
  pickOnColor, relativeLuminance, rgbToOklch, seededRandom, shiftLightness,
} from "./color.ts";

const hex = (value) => formatColor(parseColor(value));
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ""} expected ${expected} ± ${tolerance}, got ${actual}`);

test("parses hex, rgb, hsl and oklch forms and normalises them", () => {
  assert.equal(hex("#abc"), "#aabbcc");
  assert.equal(hex("#AABBCC"), "#aabbcc");
  assert.equal(normalizeColor("#aabbcc80"), "rgba(170, 187, 204, 0.502)");
  assert.equal(normalizeColor("#abcd"), "rgba(170, 187, 204, 0.867)");
  assert.equal(hex("rgb(255, 0, 0)"), "#ff0000");
  assert.equal(hex("rgb(100% 0% 0%)"), "#ff0000");
  assert.equal(normalizeColor("rgba(0, 0, 0, .5)"), "rgba(0, 0, 0, 0.5)");
  assert.equal(normalizeColor("rgb(0 0 0 / 25%)"), "rgba(0, 0, 0, 0.25)");
  assert.equal(hex("hsl(120, 100%, 50%)"), "#00ff00");
  assert.equal(hex("hsl(0.5turn 100% 50%)"), "#00ffff");
  assert.equal(hex("oklch(1 0 0)"), "#ffffff");
  assert.equal(hex("oklch(0% 0 0)"), "#000000");
  assert.equal(hex("white"), "#ffffff");
  assert.equal(normalizeColor("transparent"), "rgba(0, 0, 0, 0)");
});

test("rejects malformed and non-colour input", () => {
  for (const bad of ["", "#ab", "#abcde", "#ggg", "rgb(1,2)", "rgb(1,2,3,4,5)", "red", "url(x)", "rgb(a,b,c)", "hsl(1, 2%)", "oklch(1 2)", "rgb(1 2 3 / 1 / 2)", null, 42, {}, "#" + "a".repeat(100)]) {
    assert.equal(parseColor(bad), null, String(bad));
  }
});

test("WCAG relative luminance and contrast match the reference values", () => {
  near(relativeLuminance(parseColor("#ffffff")), 1, 1e-9);
  near(relativeLuminance(parseColor("#000000")), 0, 1e-9);
  near(contrastRatio(parseColor("#000"), parseColor("#fff")), 21, 1e-9);
  near(contrastRatio(parseColor("#777777"), parseColor("#ffffff")), 4.48, 0.01, "#777 on white");
  near(contrastRatio(parseColor("#767676"), parseColor("#ffffff")), 4.54, 0.01, "#767676 on white");
  // Symmetric
  near(contrastRatio(parseColor("#e4e4e7"), parseColor("#212226")), contrastRatio(parseColor("#212226"), parseColor("#e4e4e7")), 1e-9);
});

test("a translucent ink is composited on its surface before measuring", () => {
  const ink = parseColor("rgba(255, 255, 255, 0.5)");
  const bg = parseColor("#000000");
  near(contrastRatio(ink, bg), contrastRatio(parseColor("#808080"), bg), 0.05);
  const mixed = composite(parseColor("rgba(255, 0, 0, 0.5)"), parseColor("#0000ff"));
  assert.equal(formatColor(mixed), "#800080");
  assert.equal(formatColor(mixColors(parseColor("#000"), parseColor("#fff"), 0.5)), "#808080");
});

test("OKLCH round-trips sRGB", () => {
  for (const value of ["#64ddf2", "#212226", "#ff6ac1", "#f6eedd", "#8e3b32", "#123456"]) {
    assert.equal(formatColor(oklchToRgb(rgbToOklch(parseColor(value)))), value, value);
  }
  near(oklchLightness(parseColor("#ffffff")), 1, 1e-4);
  near(oklchLightness(parseColor("#000000")), 0, 1e-4);
});

test("out-of-gamut OKLCH keeps lightness and hue and loses chroma", () => {
  const vivid = oklchToRgb({ l: 0.7, c: 0.5, h: 145 });
  for (const channel of [vivid.r, vivid.g, vivid.b]) assert.ok(channel >= 0 && channel <= 1);
  near(rgbToOklch(vivid).l, 0.7, 0.01, "lightness kept");
  near(rgbToOklch(vivid).h, 145, 3, "hue kept");
});

test("shiftLightness keeps the hue", () => {
  const accent = parseColor("#b794ff");
  const lighter = shiftLightness(accent, 0.08);
  assert.ok(oklchLightness(lighter) > oklchLightness(accent));
  near(rgbToOklch(lighter).h, rgbToOklch(accent).h, 2);
});

test("adjustLightnessToContrast finds the smallest passing move", () => {
  const ink = parseColor("#7d7787");
  const surfaces = [parseColor("#2a2b30"), parseColor("#212226")];
  const before = Math.min(...surfaces.map((s) => contrastRatio(ink, s)));
  assert.ok(before < 4.5);
  const fix = adjustLightnessToContrast(ink, surfaces, 4.5, 0.15);
  assert.equal(fix.ok, true);
  assert.ok(fix.delta > 0, "moves away from dark surfaces (lighter)");
  assert.ok(Math.min(...surfaces.map((s) => contrastRatio(fix.color, s))) >= 4.5);
  // One step smaller would not pass.
  const smaller = shiftLightness(ink, fix.delta - 0.0025);
  assert.ok(Math.min(...surfaces.map((s) => contrastRatio(smaller, s))) < 4.5);
  near(rgbToOklch(fix.color).h, rgbToOklch(ink).h, 3, "hue kept");
});

test("adjustLightnessToContrast reports failure when the bound is too small", () => {
  const fix = adjustLightnessToContrast(parseColor("#606060"), [parseColor("#5a5a5a")], 4.5, 0.05);
  assert.equal(fix.ok, false);
  const passing = adjustLightnessToContrast(parseColor("#aaaaaa"), [parseColor("#202020")], 4.5);
  assert.equal(passing.ok, true);
  assert.equal(passing.delta, 0);
});

test("pickOnColor chooses the ink with more contrast", () => {
  assert.ok(oklchLightness(pickOnColor(parseColor("#64ddf2"))) < 0.3, "dark ink on a light fill");
  assert.ok(oklchLightness(pickOnColor(parseColor("#3a1f8f"))) > 0.9, "light ink on a dark fill");
  for (const fill of ["#64ddf2", "#ff6ac1", "#3a861d", "#8e3b32", "#ffff00", "#0000ff"]) {
    assert.ok(contrastRatio(pickOnColor(parseColor(fill)), parseColor(fill)) >= 4.5, fill);
  }
});

test("seededRandom is deterministic per seed", () => {
  const a = seededRandom("ct_abcdefghij"), b = seededRandom("ct_abcdefghij"), c = seededRandom("ct_other00000");
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const value of seqA) assert.ok(value >= 0 && value < 1);
});

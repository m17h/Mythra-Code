import test from "node:test";
import assert from "node:assert/strict";
import { DECORATION_LIMITS, MOTION_LIMITS, cleanCustomCss, customCssScope, sanitizeCustomCss } from "./sanitizeCss.ts";

// The WCAG 2.3.1 flash rule, the motion floors and the decoration bounds (agent brief, Nov 2026).

const ID = "ct_4w72ih65w6";
const clean = (css) => cleanCustomCss(css);
const errorsOf = (css) => clean(css).errors.join("\n");
const droppedOf = (css) => clean(css).dropped.map((d) => `${d.where}: ${d.reason}`).join("\n");
const layer = (animation, extra = "") => `.conversation::after { content: ""; position: absolute; inset: 0; opacity: 0; ${extra} animation: ${animation}; }`;

// Morgan's saved "Thunderstorm" (theme ct_4w72ih65w6, revision 6), verbatim.
const STORM_RAIN = "@keyframes ct-rain { from { transform: translateY(0); } to { transform: translateY(1120px); } }";
const STORM_STRIKE = "@keyframes ct-strike { 0%, 40% { opacity: 0; } 41.7% { opacity: 0.85; } 43.4% { opacity: 0.15; } 45.1% { opacity: 0.8; } 46.8% { opacity: 0; } 80% { opacity: 0; } 81.7% { opacity: 0.55; } 83.4% { opacity: 0; } 100% { opacity: 0; } }";
const STORM_RULES = `.chat-stage::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 1; background-image: radial-gradient(ellipse 110% 95% at 62% 0%, var(--text), transparent 85%); mix-blend-mode: screen; opacity: 0; animation-name: ct-strike; animation-duration: 21s; animation-timing-function: linear; animation-iteration-count: infinite; animation-direction: normal; animation-delay: 0; animation-fill-mode: none; }`;

test("Morgan's saved storm still passes unchanged", () => {
  const css = `${STORM_RAIN}\n${STORM_STRIKE}\n${STORM_RULES}`;
  const out = clean(css);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.dropped, []);
  assert.equal(clean(out.css).css, out.css, "idempotent");
});

test("the storm's double flash passes with sharp ~50ms edges", () => {
  // Morgan's own pattern (flash, dim, flash, out; a smaller flash later) squeezed to ~50ms edges in the same 21s cycle.
  const sharp = "@keyframes ct-strike { 0%, 40% { opacity: 0; } 40.24% { opacity: 0.85; } 40.48% { opacity: 0.15; } 40.72% { opacity: 0.8; } 41.2% { opacity: 0; } 80% { opacity: 0; } 80.24% { opacity: 0.55; } 80.72% { opacity: 0; } 100% { opacity: 0; } }";
  assert.deepEqual(errorsOf(`${sharp}\n${STORM_RULES}`), "");
  // The same idea in a short 6s loop: flash (48ms), dim (72ms), flash (48ms), fade, then about 5.7s of rest.
  const short = "@keyframes strike { 0%, 70% { opacity: 0; } 70.8% { opacity: 0.85; } 72% { opacity: 0.15; } 72.8% { opacity: 0.8; } 75% { opacity: 0; } 100% { opacity: 0; } }";
  assert.deepEqual(errorsOf(`${short}\n${layer("strike 6s linear infinite")}`), "");
  // Instant edges from step timing are fine too.
  assert.deepEqual(errorsOf(`${short}\n${layer("strike 6s step-end infinite")}`), "");
  assert.deepEqual(errorsOf(`${short}\n${layer("strike 6s steps(1, start) infinite")}`), "");
});

test("exactly 3 flashes in a second pass; a fourth is rejected with plain advice", () => {
  const three = "@keyframes burst { 0%, 80% { opacity: 0; } 83% { opacity: 1; } 86% { opacity: 0; } 89% { opacity: 1; } 92% { opacity: 0; } 95% { opacity: 1; } 100% { opacity: 0; } }";
  assert.deepEqual(errorsOf(`${three}\n${layer("burst 3s linear infinite")}`), "");
  const four = "@keyframes burst { 0%, 80% { opacity: 0; } 82% { opacity: 1; } 84% { opacity: 0; } 86% { opacity: 1; } 88% { opacity: 0; } 90% { opacity: 1; } 92% { opacity: 0; } 94% { opacity: 1; } 96% { opacity: 0; } 100% { opacity: 0; } }";
  const message = errorsOf(`${four}\n${layer("burst 3s linear infinite")}`);
  assert.match(message, /`burst` flashes 4 times in one second; at most 3 are allowed/);
  assert.match(message, /Space the flashes out/);
  assert.equal(MOTION_LIMITS.flashesPerSecond, 3);
});

test("strobes are still rejected, written any way", () => {
  const stops = (prop, a, b) => Array.from({ length: 17 }, (_, i) => `${(i * 6.25).toFixed(2)}% { ${prop}: ${i % 2 ? b : a}; }`).join(" ");
  // Flipping every 75ms (16 flips in 1.2s) is about 7 flashes a second.
  const fast = Array.from({ length: 17 }, (_, i) => `${(i * 6.25).toFixed(2)}% { opacity: ${i % 2}; }`).join(" ");
  assert.match(errorsOf(`@keyframes strobe { ${fast} }\n${layer("strobe 1.2s linear")}`), /flashes 7 times/);
  // Longhands are checked as a whole, like the shorthand (they used to skip the flash check).
  assert.match(errorsOf(`@keyframes strobe { ${stops("opacity", 0, 1)} }\n.a::after { content: ""; animation-name: strobe; animation-duration: 2s; animation-iteration-count: infinite; }`), /flashes 4 times/);
  // Colours given as tokens can't be measured, so they count as the worst case.
  assert.match(errorsOf(`@keyframes flick { ${stops("background-color", "var(--bg)", "var(--text)")} }\n${layer("flick 2s infinite")}`), /flashes 4 times/);
  // Literal colours are measured; a faint tint flicker is not a flash.
  assert.match(errorsOf(`@keyframes flick { ${stops("background-color", "#000", "#fff")} }\n${layer("flick 2s infinite")}`), /flashes 4 times/);
  assert.deepEqual(errorsOf(`@keyframes flick { ${stops("background-color", "rgba(255,255,255,.02)", "rgba(255,255,255,.06)")} }\n${layer("flick 2s infinite")}`), "");
  // Popping a layer in and out with scale() is a flash too.
  assert.match(errorsOf(`@keyframes pop { ${stops("transform", "scale(0)", "scale(1)")} }\n${layer("pop 2s infinite")}`), /flashes 4 times/);
  // Glows (box-shadow) count as the worst case as well.
  assert.match(errorsOf(`@keyframes glow { ${stops("box-shadow", "0 0 4px var(--accent)", "0 0 24px var(--accent)")} }\n${layer("glow 2s infinite")}`), /flashes 4 times/);
});

test("the gap between loops, alternate directions and iteration counts are part of the timeline", () => {
  // A burst at the start and another at the end of each loop: alone each is fine, across the restart they add up.
  const ends = "@keyframes ends { 0% { opacity: 0; } 2% { opacity: 1; } 4% { opacity: 0; } 6% { opacity: 1; } 8% { opacity: 0; } 92% { opacity: 0; } 94% { opacity: 1; } 96% { opacity: 0; } 98% { opacity: 1; } 100% { opacity: 1; } }";
  assert.match(errorsOf(`${ends}\n${layer("ends 3s linear infinite")}`), /flashes 4 times/);
  assert.deepEqual(errorsOf(`${ends}\n${layer("ends 3s linear 1")}`), "", "played once there is no restart");
  // alternate plays the next loop backwards, so a burst at the end is immediately repeated.
  const three = "@keyframes burst { 0%, 80% { opacity: 0; } 83% { opacity: 1; } 86% { opacity: 0; } 89% { opacity: 1; } 92% { opacity: 0; } 95% { opacity: 1; } 100% { opacity: 0; } }";
  assert.deepEqual(errorsOf(`${three}\n${layer("burst 3s linear infinite")}`), "");
  assert.match(errorsOf(`${three}\n${layer("burst 3s linear infinite alternate")}`), /flashes [5-9] times/);
});

test("animations on one element are combined", () => {
  const a = "@keyframes a { 0%, 50% { opacity: 0; } 51% { opacity: 1; } 52% { opacity: 0; } 53% { opacity: 1; } 54% { opacity: 0; } 100% { opacity: 0; } }";
  const b = "@keyframes b { 0%, 50% { background-color: #000; } 51% { background-color: #fff; } 52% { background-color: #000; } 53% { background-color: #fff; } 54% { background-color: #000; } 100% { background-color: #000; } }";
  assert.deepEqual(errorsOf(`${a}\n${b}\n${layer("a 5s infinite")}`), "");
  assert.deepEqual(errorsOf(`${a}\n${b}\n${layer("b 5s infinite", "background-color: #000;")}`), "");
  assert.match(errorsOf(`${a}\n${b}\n${layer("a 5s infinite, b 7s infinite", "background-color: #000;")}`), /the animations `a` and `b` on it can line up and flash 4 times/);
  // One animation changing opacity and colour at the same moment is one flash, not two.
  const both = "@keyframes both { 0%, 50% { opacity: 0; background-color: #000; } 51% { opacity: 1; background-color: #fff; } 52% { opacity: 0; background-color: #000; } 53% { opacity: 1; background-color: #fff; } 54% { opacity: 0; background-color: #000; } 100% { opacity: 0; background-color: #000; } }";
  assert.deepEqual(errorsOf(`${both}\n${layer("both 5s infinite", "background-color: #000;")}`), "");
});

test("a rule states its whole animation timing", () => {
  const drift = "@keyframes drift { from { transform: translateX(0); } to { transform: translateX(6px); } }";
  assert.match(errorsOf(`${drift}\n.a::after { content: ""; animation: drift 8s infinite; }\n.a:hover::after { animation-duration: 0.4s; }`), /set animation-duration in the same rule as animation-name/);
  assert.match(errorsOf(`${drift}\n.a::after { content: ""; animation-name: drift; }`), /add animation-duration to the same rule/);
  // Staggering with delays only shifts animations in time, so it may live in its own rule.
  const stagger = clean(`${drift}\n.a::after { content: ""; animation: drift 8s infinite; }\n.a:nth-child(2)::after { animation-delay: -2s; }`);
  assert.deepEqual(stagger.errors, []);
  assert.match(stagger.css, /\.a:nth-child\(2\)::after \{ animation-delay: -2s; \}/);
  // Missing timing longhands are written out with their initial values, so no other rule can change them.
  const longhands = clean(`${drift}\n.a::after { content: ""; animation-duration: 8s; animation-name: drift; }`);
  assert.deepEqual(longhands.errors, []);
  assert.match(longhands.css, /animation-name: drift; animation-duration: 8s; animation-timing-function: ease; animation-iteration-count: 1; animation-direction: normal;/);
  assert.equal(clean(longhands.css).css, longhands.css);
  // A bad longhand value is an error and the rule's animation is left out; the rest stays.
  const bad = clean(`${drift}\n.a::after { content: ""; position: absolute; animation-name: drift; animation-duration: fast; }`);
  assert.match(bad.errors.join("\n"), /animation-duration takes times/);
  assert.doesNotMatch(bad.css, /animation/);
  assert.match(bad.css, /position: absolute/);
});

test("decorations that only move may loop fast; brightness changes keep the calm floor", () => {
  assert.equal(MOTION_LIMITS.minMovementDuration, 0.35);
  // Morgan's rain at a quarter of its old loop time.
  for (const duration of ["0.5s", "350ms", "2s"]) {
    assert.deepEqual(errorsOf(`${STORM_RAIN}\n${layer(`ct-rain ${duration} linear infinite`)}`), "", duration);
  }
  assert.match(errorsOf(`${STORM_RAIN}\n${layer("ct-rain 0.2s linear infinite")}`), /`ct-rain` lasts 0\.2s; a decoration that only moves may loop as fast as 0\.35s/);
  // background-position and rotate count as moves; a faint shimmer is not a brightness change.
  assert.deepEqual(errorsOf(`@keyframes slide { from { background-position: 0 0; } to { background-position: 0 200px; } }\n${layer("slide 0.4s linear infinite")}`), "");
  assert.deepEqual(errorsOf(`@keyframes sheen { from { transform: translateY(0); opacity: .45; } to { transform: translateY(400px); opacity: .5; } }\n${layer("sheen 0.4s linear infinite", "opacity: .45;")}`), "");
  assert.deepEqual(errorsOf(`@keyframes breathe { from { transform: scale(.98); } to { transform: scale(1.02); } }\n${layer("breathe 0.5s ease-in-out infinite alternate")}`), "");
  // Big opacity swings keep 1.2s (2s when infinite), even when the layer also moves.
  assert.match(errorsOf(`@keyframes fall { from { transform: translateY(0); opacity: 0; } to { transform: translateY(400px); opacity: 1; } }\n${layer("fall 0.5s linear infinite")}`), /must last at least 1\.2s \(2s when infinite\)/);
  // A missing 0%/100% value comes from the element and may be anything, so it isn't treated as a pure move.
  assert.match(errorsOf(`@keyframes pop { to { transform: scale(1.5); } }\n${layer("pop 0.5s infinite")}`), /must last at least/);
  // Real elements keep the old floor whatever the keyframes do.
  assert.match(errorsOf(`${STORM_RAIN}\n.thread-card { animation: ct-rain 0.5s linear infinite; }`), /must last at least 1\.2s \(2s when infinite\)/);
  // Everything stays behind the reduced-motion and pause gate.
  const out = sanitizeCustomCss(`${STORM_RAIN}\n${layer("ct-rain 0.5s linear infinite")}`, { id: ID });
  assert.deepEqual(out.errors, []);
  assert.ok(out.css.includes(`@media (prefers-reduced-motion: no-preference) { ${customCssScope(ID, true)} .conversation::after { animation-name: ct-${ID}-ct-rain;`), out.css);
  assert.ok(!out.css.split("\n").some((line) => line.startsWith(customCssScope(ID)) && line.includes("animation")));
});

test("decoration offsets allow tall layers; real elements are unchanged", () => {
  assert.equal(DECORATION_LIMITS.offsetPercent, 300);
  const tall = clean(".conversation::before { content: \"\"; position: absolute; top: -200%; bottom: 0; left: -50%; right: -50%; } .sidebar::after { content: \"\"; position: absolute; inset: -1120px 0 0 0; }");
  assert.deepEqual(tall.errors, []);
  assert.deepEqual(tall.dropped, []);
  assert.match(droppedOf(".a::before { content: \"\"; position: absolute; top: -400%; }"), /between -300% and 300%/);
  assert.match(droppedOf(".a::before { content: \"\"; position: absolute; left: 5000px; }"), /1600px/);
  assert.match(errorsOf(".conversation { top: -200%; }"), /not allowed on real elements/);
});

test("mask-composite is allowed on decorations only", () => {
  const ok = clean(".a::before { content: \"\"; position: absolute; inset: 0; -webkit-mask-image: linear-gradient(#000, transparent), linear-gradient(90deg, #000, transparent); mask-image: linear-gradient(#000, transparent), linear-gradient(90deg, #000, transparent); mask-composite: intersect, add; -webkit-mask-composite: source-in; }");
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.dropped, []);
  assert.match(ok.css, /mask-composite: intersect, add;/);
  assert.match(ok.css, /-webkit-mask-composite: source-in;/);
  assert.match(droppedOf(".a::before { content: \"\"; mask-composite: plus-lighter; }"), /add, subtract, intersect or exclude/);
  assert.match(droppedOf(".a { mask-composite: exclude; }"), /not in the customCss allowlist/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { CSS_LIMITS, PROTECTED_CLASSES, cleanCustomCss, customCssScope, keyframeName, sanitizeCustomCss, serializeTokens, tokenize } from "./sanitizeCss.ts";

const ID = "ct_abcdefghij";
const SCOPE = customCssScope(ID);
const clean = (css) => cleanCustomCss(css);
const scoped = (css) => sanitizeCustomCss(css, { id: ID });
const errorsOf = (css) => clean(css).errors.join("\n");
const droppedOf = (css) => clean(css).dropped.map((d) => `${d.where}: ${d.reason}`).join("\n");

/** Nothing that could load, run or escape may survive, whatever happened. */
function assertInert(output) {
  const lower = output.toLowerCase();
  for (const needle of ["url(", "image-set", "expression", "javascript", "vbscript", "@import", "@font-face", "!important", "<", "behavior", "binding", "attr(", "paint(", "element(", "cross-fade"]) {
    assert.ok(!lower.includes(needle), `output contains ${needle}: ${output}`);
  }
}

test("tokenizer decodes escapes before anything is checked", () => {
  const toks = tokenize(String.raw`u\72 l(x) \75 rl(y) b\61 ckground`);
  const words = toks.filter((t) => t.t !== "ws").map((t) => `${t.t}:${t.v ?? ""}`);
  assert.deepEqual(words, ["url:x", "url:y", "ident:background"]);
  assert.equal(serializeTokens(tokenize(".a:hover > .b")), ".a:hover > .b");
  assert.equal(serializeTokens(tokenize("col/**/or")), "col or", "a removed comment can't glue two words together");
});

test("plain cosmetic CSS passes through, scoped to the theme", () => {
  const input = ".composer { border-color: var(--accent-line); }\n.thread-card:hover .thread-card-title { color: var(--text); font-weight: 600; }";
  const out = scoped(input);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.dropped, []);
  assert.ok(out.css.includes(`${SCOPE} .composer { border-color: var(--accent-line); }`), out.css);
  assert.ok(out.css.includes(`${SCOPE} .thread-card:hover .thread-card-title { color: var(--text); font-weight: 600; }`));
  for (const line of out.css.split("\n").filter(Boolean)) assert.ok(line.startsWith(SCOPE) || line.startsWith("@"), line);
});

test("the scope out-ranks the Windows ink rule (0,4,1)", () => {
  // :root (0,1,0) + .app-shell (0,1,0) + three attribute selectors (0,3,0) = (0,5,0)
  assert.equal(SCOPE, `:root .app-shell[data-theme][data-color-scheme][data-custom-theme="${ID}"]`);
});

test("a leading .app-shell is merged into the scope", () => {
  const out = scoped(".app-shell .sidebar { border-color: var(--line); } .app-shell[data-color-scheme=\"dark\"] .topbar { border-color: var(--line); }");
  assert.ok(out.css.includes(`${SCOPE} .sidebar {`), out.css);
  assert.ok(out.css.includes(`${SCOPE}[data-color-scheme="dark"] .topbar {`), out.css);
  assert.match(droppedOf(".x .app-shell { color: var(--text); } .a.app-shell { color: var(--text); }"), /app-shell` must come first/);
});

test("url() and every loading or script vector is an error, however it is written", () => {
  const vectors = [
    ".a { background-image: url(https://evil.example/p.png); }",
    ".a { background-image: url(\"https://evil.example/p.png\"); }",
    ".a { background-image: URL(x); }",
    String.raw`.a { background-image: u\72 l(x); }`,
    String.raw`.a { background-image: \75 rl(x); }`,
    String.raw`.a { b\61 ckground: url(x); }`,
    ".a { background: url(x y); }",
    ".a::after { content: \"\"; background-image: image-set(\"a.png\" 1x); }",
    ".a::after { content: \"\"; background-image: -webkit-image-set(\"a.png\" 1x); }",
    ".a::after { content: \"\"; background-image: cross-fade(red, blue); }",
    ".a::after { content: \"\"; background-image: element(x); }",
    ".a::after { content: \"\"; background-image: paint(worklet); }",
    ".a::after { content: \"\"; width: expression(alert(1)); }",
    String.raw`.a::after { content: ""; width: e\78 pression(alert(1)); }`,
    String.raw`.a { background-color: \6a avascript\:alert(1); }`,
    ".a { --ct-x: url(x); }",
    ".a { color: var(--ct-x, url(x)); }",
    ".a::after { content: attr(title); }",
    ".a { -moz-binding: url(x); }",
    ".a { behavior: url(x.htc); }",
  ];
  for (const css of vectors) {
    const out = scoped(css);
    assert.ok(out.errors.length > 0 || !out.css.includes("{ }"), css);
    assert.ok(out.errors.length > 0 || out.dropped.length > 0, `not rejected: ${css}`);
    assertInert(out.css);
  }
});

test("forbidden at-rules are dropped with a named reason", () => {
  for (const [css, reason] of [
    ["@import url(x.css);", /themes can't load other stylesheets/],
    ["@import \"x.css\";", /themes can't load other stylesheets/],
    ["@font-face { font-family: x; src: url(x.woff); }", /can't load fonts/],
    ["@namespace svg url(http://www.w3.org/2000/svg);", /@namespace/],
    ["@layer base { .a { color: var(--text); } }", /@layer/],
    ["@property --ct-x { syntax: '<color>'; inherits: false; initial-value: red; }", /@property/],
    ["@container (min-width: 1px) { .a { color: var(--text); } }", /@container/],
    ["@page { margin: 0; }", /@page/],
    ["@scope (.a) { .b { color: var(--text); } }", /@scope/],
    ["@starting-style { .a { opacity: 0; } }", /@starting-style/],
    ["@media print { .a { color: var(--text); } }", /only prefers-reduced-motion/],
    ["@media (hover: hover) { .a { color: var(--text); } }", /only prefers-reduced-motion/],
  ]) {
    const out = scoped(css);
    assert.match(out.dropped.map((d) => `${d.where} ${d.reason}`).join("\n"), reason, css);
    assertInert(out.css);
    assert.equal(out.css.trim(), "", css);
  }
});

test("allowed media and supports rules are kept and nested rules re-sanitized", () => {
  const out = scoped("@media (prefers-color-scheme: dark) and (min-width: 900px) { .a { color: var(--text); } .b { display: none; } }\n@supports (mask-composite: exclude) { .c::after { content: \"\"; position: absolute; inset: 0; } }");
  assert.match(out.errors.join("\n"), /display/);
  const ok = scoped("@media (prefers-reduced-motion: reduce) { .a { border-color: var(--line); } }\n@supports (mask-composite: exclude) { .c::after { content: \"\"; position: absolute; inset: 0; } }");
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.css.includes("@media (prefers-reduced-motion: reduce) {"));
  assert.ok(ok.css.includes(`${SCOPE} .a { border-color: var(--line); }`));
  assert.ok(ok.css.includes(`${SCOPE} .c::after { content: ""; position: absolute; inset: 0; pointer-events: none; }`), ok.css);
});

test("selectors that reach outside the app or cost too much are dropped", () => {
  for (const [css, reason] of [
    ["* { border-color: var(--line); }", /universal selector/],
    [".a > * { border-color: var(--line); }", /universal selector/],
    ["#root { border-color: var(--line); }", /ID selectors/],
    [".a:has(.b) { border-color: var(--line); }", /:has\(\)/],
    ["html .a { border-color: var(--line); }", /inside the app window/],
    ["body { border-color: var(--line); }", /inside the app window/],
    [":root { border-color: var(--line); }", /outside the app window/],
    [":host { border-color: var(--line); }", /outside the app window/],
    [".a::backdrop { border-color: var(--line); }", /outside the app window/],
    ["::view-transition-old(root) { border-color: var(--line); }", /not supported|outside/],
    ["::-webkit-scrollbar { border-color: var(--line); }", /root scrollbars/],
    ["& .a { border-color: var(--line); }", /nesting/],
    ["svg|a { border-color: var(--line); }", /namespaces/],
    [".a .b .c .d .e .f .g { border-color: var(--line); }", /more than 6 compound/],
    [`.${"a".repeat(320)} { border-color: var(--line); }`, /longer than 300/],
    [".a:nth-child(2n+1 of .b) { border-color: var(--line); }", /unsupported/],
    [".a:focus-visible::after::before { content: \"\"; }", /only one pseudo-element|must be last/],
  ]) {
    const out = scoped(css);
    assert.match(out.dropped.map((d) => d.reason).join("\n"), reason, css);
    assert.equal(out.css.trim(), "", css);
  }
  // One bad selector in a list drops only that selector.
  const mixed = scoped(".a, #b, .c { border-color: var(--line); }");
  assert.ok(mixed.css.includes(`${SCOPE} .a, ${SCOPE} .c {`), mixed.css);
});

test("braces and comments can't break out of the scope", () => {
  for (const css of [
    ".a { border-color: var(--line); } } body { display: none; } .b {",
    ".a { border-color: var(--line); /* } body { display:none } */ }",
    ".a { border-color: var(--line) } </style><script>alert(1)</script>",
    ".a{}}}}{{{.b{color:var(--text)}",
    "/* unterminated .a { color: red }",
  ]) {
    const out = scoped(css);
    for (const rule of out.css.split("\n").filter(Boolean)) assert.ok(rule.startsWith(SCOPE) || rule.startsWith("@") || rule === "}", `${css} -> ${rule}`);
    assertInert(out.css);
    assert.ok(!/display/.test(out.css), css);
  }
});

test("overlay and hiding tricks are errors, and only the offending declarations are removed", () => {
  for (const [css, reason] of [
    [".a::after { content: \"\"; position: fixed; inset: 0; }", /position: absolute/],
    [".a::after { content: \"\"; position: sticky; }", /position: absolute/],
    [".a::after { content: \"\"; z-index: 9999; }", /z-index on decorations/],
    [".a::after { content: \"\"; pointer-events: auto; }", /pointer-events: none/],
    [".a::after { content: \"Click me\"; }", /content may only be ""/],
    [".a { position: absolute; }", /not allowed on real elements/],
    [".a { content: \"x\"; }", /only allowed on ::before/],
    [".a { opacity: 0; }", /opacity/],
    [".a { transform: scale(0); }", /transforms on real elements/],
    [".a { filter: blur(10px); }", /filters on real elements/],
    [".a { display: none; }", /`display` is not allowed/],
    [".a { visibility: hidden; }", /`visibility` is not allowed/],
    [".a { width: 0; }", /layout properties/],
    [".a { margin: -9999px; }", /layout properties/],
    [".a { font-size: 0; }", /type scale/],
    [".a { font-family: Papyrus; }", /typography/],
    [".a { cursor: none; }", /pointer stays/],
    [".a { overflow: hidden; }", /clipping/],
    [".a { clip-path: inset(50%); }", /clipping/],
    [".a { backdrop-filter: blur(20px); }", /backdrop filters/],
    [".a { -webkit-text-fill-color: transparent; }", /text colour/],
    [".a { background-clip: text; }", /background-clip/],
    [".a { will-change: transform; }", /will-change/],
    [".a { color: transparent; }", /tokens/],
    [".a { color: #777; }", /tokens/],
    [".a { background-color: #ff0000; }", /tokens so contrast can be checked/],
    [".a { background-image: linear-gradient(#000, #fff); }", /tokens so contrast can be checked/],
  ]) {
    assert.match(errorsOf(css), reason, css);
    // The offending declaration is left out; whatever remains is itself clean.
    const kept = clean(css).css;
    assert.deepEqual(clean(kept).errors, [], `kept CSS must pass on its own: ${kept}`);
    assert.deepEqual(scoped(css).errors.length > 0, true);
    assertInert(kept);
  }
});

test("decorations may use their own allowlist; faint literal tints are fine", () => {
  const css = ".thread-card::after { content: \"\"; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, var(--accent-soft), transparent 60%); opacity: 0; transition: opacity 200ms ease; mix-blend-mode: screen; z-index: 0; filter: blur(8px); transform: translateX(4px); }\n.a { background-color: rgba(255, 255, 255, .08); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }";
  const out = clean(css);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.dropped, []);
  assert.ok(out.css.includes("pointer-events: none;"), "decorations never take pointer events");
});

test("!important is stripped and app tokens can't be redefined", () => {
  const out = clean(".a { border-color: var(--line) !important; }");
  assert.equal(out.css, ".a { border-color: var(--line); }");
  assert.match(out.dropped[0].reason, /!important was removed/);
  assert.match(errorsOf(".a { --muted: #000; }"), /Set `--muted` in tokens, not customCss/);
  assert.equal(clean(".a { --ct-glow: rgba(255,0,0,.3); } .a::after { content: \"\"; box-shadow: 0 0 8px var(--ct-glow); }").errors.length, 0);
  assert.match(droppedOf(".a { border-color: var(--not-a-token); }"), /not a theme token/);
});

test("protected controls only take cosmetic changes", () => {
  assert.ok(PROTECTED_CLASSES.includes("composer"));
  for (const css of [".composer { opacity: .2; }", ".send-button { transform: scale(0.1); }", ".composer textarea { opacity: 0; }", ".settings-pane::after { content: \"\"; position: absolute; }", ".approval-allow { filter: hue-rotate(90deg); }", ".app-toast { animation: x 2s; } @keyframes x { from { opacity: 1; } to { opacity: .5; } }"]) {
    assert.match(errorsOf(css), /protected control|not allowed on real elements/, css);
  }
  assert.deepEqual(clean(".composer { border-color: var(--accent-line); box-shadow: 0 0 12px var(--accent-soft); }").errors, []);
});

test("value limits: borders, radii, shadows, letter-spacing, weights, transitions", () => {
  assert.match(droppedOf(".a { border-width: 8px; }"), /at most 3px/);
  assert.match(droppedOf(".a { border: thick solid var(--line); }"), /at most 3px/);
  assert.match(droppedOf(".a { border-radius: 999px; }"), /at most 20px/);
  assert.match(droppedOf(".a { box-shadow: 0 0 2px var(--line), 0 0 2px var(--line), 0 0 2px var(--line), 0 0 2px var(--line), 0 0 2px var(--line); }"), /at most 4 layers/);
  assert.match(droppedOf(".a { box-shadow: 0 0 120px var(--accent); }"), /blur at most 48px/);
  assert.match(droppedOf(".a { box-shadow: inset 0 0 40px var(--accent); }"), /inset shadows at most 8px/);
  assert.match(droppedOf(".a { box-shadow: 0 0 4px 30px var(--accent); }"), /spread at most 10px/);
  assert.match(droppedOf(".a { text-shadow: 0 0 20px var(--accent); }"), /blur at most 6px/);
  assert.match(droppedOf(".a { letter-spacing: .3em; }"), /letter-spacing/);
  assert.match(droppedOf(".a { font-weight: 900; }"), /400–700/);
  assert.match(droppedOf(".a { outline-offset: 12px; }"), /0–4px/);
  const slow = clean(".a { transition: border-color 2s ease; }");
  assert.equal(slow.css, ".a { transition: border-color 400ms ease; }");
  assert.match(droppedOf(".a { transition: all 200ms; }"), /cosmetic/);
  assert.match(droppedOf(".a::after { content: \"\"; position: absolute; width: 5000%; }"), /300%/);
  assert.match(droppedOf(".a::after { content: \"\"; position: absolute; top: -2000px; }"), /1600px/);
  assert.match(droppedOf(".a::after { content: \"\"; position: absolute; top: -500%; }"), /-300% and 300%/);
  assert.match(droppedOf(".a::after { content: \"\"; filter: blur(80px); }"), /24px/);
  assert.match(droppedOf(".a::after { content: \"\"; filter: drop-shadow(0 0 4px red); }"), /drop-shadow\(\) is not supported/);
  assert.match(droppedOf(".a::after { content: \"\"; filter: brightness(3); }"), /brightness\(\) is not supported/);
  assert.match(droppedOf(".a { zoomy: 1; }"), /allowlist/);
});

test("animations: durations, known keyframes, flashing and the motion split", () => {
  // Decorations that only move may loop fast (rain); anything that changes brightness keeps the calm floor.
  assert.match(errorsOf(".a::after { content: \"\"; animation: spin 0.2s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }"), /only moves may loop as fast as 0\.35s/);
  assert.deepEqual(errorsOf(".a::after { content: \"\"; animation: spin 0.4s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }"), "");
  assert.match(errorsOf(".a::after { content: \"\"; animation: pulse 1.5s linear infinite; } @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }"), /2s when infinite/);
  assert.match(errorsOf(".a::after { content: \"\"; animation: nope 3s infinite; }"), /not a @keyframes rule/);
  assert.match(errorsOf(".a::after { content: \"\"; animation-name: nope; }"), /must name a @keyframes rule/);
  // Strobes: opacity flipping every 125ms (4 flashes a second, forever) and every 63ms (8 a second, once).
  const strobeStops = Array.from({ length: 17 }, (_, i) => `${(i * 6.25).toFixed(2)}% { opacity: ${i % 2}; }`).join(" ");
  assert.match(errorsOf(`.a::after { content: ""; animation: strobe 2s linear infinite; } @keyframes strobe { ${strobeStops} }`), /flashes 4 times in one second; at most 3 are allowed/);
  const fastStops = Array.from({ length: 20 }, (_, i) => `${((i * 100) / 19).toFixed(3)}% { opacity: ${i % 2}; }`).join(" ");
  assert.match(errorsOf(`.a::after { content: ""; animation: strobe 1.2s linear; } @keyframes strobe { ${fastStops} }`), /flashes (8|9) times in one second/, "8 flips a second, plus the jump back to the element's own opacity when it ends");
  // One sharp rise per 2s cycle is a single flash, which is fine now; steps() don't add flashes.
  assert.deepEqual(errorsOf(".a::after { content: \"\"; opacity: 0; animation: once 2s linear infinite; } @keyframes once { 0% { opacity: 0; } 10% { opacity: 1; } 100% { opacity: 1; } }"), "");
  assert.deepEqual(errorsOf(".a::after { content: \"\"; animation: blink 2s steps(10) infinite; } @keyframes blink { 0% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }"), "");
  // Colour strobes are caught through luminance.
  const colourStops = Array.from({ length: 17 }, (_, i) => `${(i * 6.25).toFixed(2)}% { background-color: ${i % 2 ? "#fff" : "#000"}; }`).join(" ");
  assert.match(errorsOf(`.a::after { content: ""; animation: flash 2s infinite; } @keyframes flash { ${colourStops} }`), /flashes 4 times/);
  // Colour animation on a real element.
  assert.match(errorsOf(".a { animation: tint 4s infinite; } @keyframes tint { from { color: var(--text); } to { color: var(--muted); } }"), /only allowed on ::before\/::after/);
  const many = Array.from({ length: 7 }, (_, i) => `.a${i}::after { content: ""; animation: drift 4s linear infinite; }`).join("\n") + "\n@keyframes drift { from { transform: translateX(0); } to { transform: translateX(4px); } }";
  assert.match(errorsOf(many), /at most 6 infinite animations/);
  const calm = scoped(".a::after { content: \"\"; position: absolute; inset: 0; animation: drift 8s ease-in-out infinite alternate; }\n@keyframes drift { from { transform: translateX(0); opacity: .6; } to { transform: translateX(6px); opacity: 1; } }");
  assert.deepEqual(calm.errors, []);
  const motionScope = customCssScope(ID, true);
  assert.ok(calm.css.includes(`@keyframes ${keyframeName(ID, "drift")}`), calm.css);
  assert.ok(calm.css.includes(`@media (prefers-reduced-motion: no-preference) { ${motionScope} .a::after { animation-name: ${keyframeName(ID, "drift")};`), calm.css);
  assert.ok(!calm.css.split("\n").find((line) => line.startsWith(`${SCOPE} .a::after`))?.includes("animation"), "animation never appears outside the motion gate");
  assert.match(keyframeName(ID, "drift"), /^ct-/);
});

test("keyframes may only animate compositor-friendly properties", () => {
  assert.match(droppedOf(".a::after { content: \"\"; animation: grow 3s; } @keyframes grow { from { width: 0; } to { width: 100%; } }"), /keyframes may only animate/);
  const many = Array.from({ length: 14 }, (_, i) => `@keyframes k${i} { to { opacity: .5; } }`).join("\n");
  assert.match(droppedOf(many), /more than 12 keyframes/);
});

test("size limits: rules and declarations", () => {
  const rules = Array.from({ length: CSS_LIMITS.rules + 20 }, (_, i) => `.r${i} { border-color: var(--line); }`).join("\n");
  const out = clean(rules);
  assert.equal(out.css.split("\n").length, CSS_LIMITS.rules);
  assert.match(out.dropped.map((d) => d.reason).join(" "), /more than 200 rules/);
  const decls = `.a { ${Array.from({ length: 50 }, () => "border-color: var(--line);").join(" ")} }`;
  assert.match(droppedOf(decls), /more than 40 declarations/);
});

test("nested rules (CSS nesting) are dropped, the rest of the rule stays", () => {
  const out = clean(".a { border-color: var(--line); .b { display: none; } }");
  assert.equal(out.css, ".a { border-color: var(--line); }");
  assert.match(out.dropped.map((d) => d.reason).join(" "), /nested rules/);
});

test("cleaning is idempotent and the scoped form re-sanitizes cleanly", () => {
  const css = String.raw`.app-shell .thread-card:not(.active):hover::after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 20% 50%, var(--accent-soft), transparent 70%); opacity: .8; animation: pulse 6s ease-in-out infinite alternate; }
@keyframes pulse { 0% { opacity: .6; } 100% { opacity: 1; } }
@media (max-width: 900px) { .sidebar { border-color: var(--line-strong) !important; } }
.a\:b { border-color: var(--line); }`;
  const first = clean(css);
  assert.deepEqual(first.errors, []);
  const second = clean(first.css);
  assert.equal(second.css, first.css);
  assert.deepEqual(second.dropped, []);
  assertInert(scoped(first.css).css);
});

test("an invalid theme id is refused", () => {
  assert.deepEqual(sanitizeCustomCss(".a{}", { id: "ct_BAD\"]{}*{" }).errors, ["invalid theme id"]);
});

test("a stylesheet mixing safe rules with forbidden ones keeps only the safe parts", () => {
  const css = [
    ".composer { border-color: var(--accent-line); background-image: url(https://evil.example/p.png); }",
    ".app-shell::after { content: \"\"; position: fixed; inset: 0; z-index: 99999; }",
    ".composer, .send-button { display: none; }",
    ".thread-row { border-color: var(--line-strong); }",
  ].join("\n");
  const out = clean(css);
  assert.ok(out.errors.length >= 3, out.errors.join("\n"));
  assert.match(out.css, /\.composer \{ border-color: var\(--accent-line\); \}/);
  assert.match(out.css, /\.thread-row \{ border-color: var\(--line-strong\); \}/);
  assert.doesNotMatch(out.css, /fixed|99999|display|evil/);
  assertInert(out.css);
  assert.deepEqual(clean(out.css).errors, []);
});
